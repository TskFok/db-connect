use std::collections::BTreeMap;

use mysql_async::{params, prelude::Queryable, Pool};

use crate::commands::database::build_column_definition;
use crate::db::connection::get_conn_with_retry;
use crate::db::schema_compare::{compare_table_columns, TableSnapshot};
use crate::db::sql_utils::{
    esc_id, esc_str, validate_column_extra, validate_column_type, validate_engine_name,
};
use crate::models::types::{
    ColumnSnapshot, DatabaseSyncOperationKind, DatabaseSyncRisk, SchemaDiffStatus,
};

use super::{
    primary_key_columns, ColumnSyncMetadata, OperationPhase, PlanFragments, TablePlanContext,
    TableSyncMetadata,
};

pub(crate) fn metadata_sql() -> &'static str {
    "SELECT tables.TABLE_NAME AS table_name, COALESCE(tables.ENGINE, '') AS engine, \
            tables.TABLE_COMMENT AS comment, columns.COLUMN_NAME AS column_name, \
            COALESCE(columns.GENERATION_EXPRESSION, '') AS generation_expression \
     FROM information_schema.TABLES tables \
     JOIN information_schema.COLUMNS columns \
       ON columns.TABLE_SCHEMA = tables.TABLE_SCHEMA \
      AND columns.TABLE_NAME = tables.TABLE_NAME \
     WHERE tables.TABLE_SCHEMA = :schema AND tables.TABLE_TYPE = 'BASE TABLE' \
     ORDER BY tables.TABLE_NAME, columns.ORDINAL_POSITION"
}

pub(crate) async fn load_metadata(
    pool: &Pool,
    schema: &str,
) -> Result<BTreeMap<String, TableSyncMetadata>, String> {
    let mut conn = get_conn_with_retry(pool).await?;
    let rows: Vec<mysql_async::Row> = conn
        .exec(metadata_sql(), params! { "schema" => schema })
        .await
        .map_err(|error| format!("查询 MySQL 同步表元数据失败: {error}"))?;
    let mut metadata = BTreeMap::new();
    for row in rows {
        let table_name = row.get::<String, _>("table_name").unwrap_or_default();
        let column_name = row.get::<String, _>("column_name").unwrap_or_default();
        let generation_expression = row
            .get::<String, _>("generation_expression")
            .unwrap_or_default();
        let entry = metadata
            .entry(table_name)
            .or_insert_with(|| TableSyncMetadata::MySql {
                engine: row.get::<String, _>("engine").unwrap_or_default(),
                comment: row.get::<String, _>("comment").unwrap_or_default(),
                columns: BTreeMap::new(),
            });
        let TableSyncMetadata::MySql { columns, .. } = entry else {
            unreachable!("MySQL 元数据映射只能创建 MySql 变体");
        };
        columns.insert(
            column_name,
            ColumnSyncMetadata::MySql {
                generation_expression,
            },
        );
    }
    Ok(metadata)
}

pub(crate) fn plan_table(context: TablePlanContext<'_>) -> PlanFragments {
    let mut plan = PlanFragments::default();
    match (context.source, context.target) {
        (Some(source), None) => plan_create_table(&mut plan, &context, source),
        (None, Some(target)) => {
            if context.include_drops {
                plan.operation(
                    OperationPhase::DropTable,
                    &target.name,
                    DatabaseSyncOperationKind::DropTable,
                    DatabaseSyncRisk::Destructive,
                    &format!("删除目标端独有表 {}", target.name),
                    vec![format!(
                        "DROP TABLE {}.{}",
                        esc_id(context.target_database),
                        esc_id(&target.name)
                    )],
                );
            } else {
                plan.skip(&target.name, "跳过删除目标端独有表", "未开启包含删除操作");
            }
        }
        (Some(source), Some(target)) => plan_changed_table(&mut plan, &context, source, target),
        (None, None) => plan.block("", "无法规划同步", "表在源端和目标端都不存在"),
    }
    plan
}

fn plan_create_table(
    plan: &mut PlanFragments,
    context: &TablePlanContext<'_>,
    source: &TableSnapshot,
) {
    let (engine, comment) = match context.source_metadata {
        Some(TableSyncMetadata::MySql {
            engine, comment, ..
        }) => (engine.as_str(), comment.as_str()),
        _ => {
            plan.block(
                &source.name,
                &format!("无法创建表 {}", source.name),
                "缺少 MySQL 原生表元数据",
            );
            return;
        }
    };
    if source.columns.is_empty() {
        plan.block(
            &source.name,
            &format!("无法创建表 {}", source.name),
            "源表没有字段",
        );
        return;
    }
    if !engine.is_empty() {
        if let Err(reason) = validate_engine_name(engine) {
            plan.block(
                &source.name,
                &format!("无法创建表 {}", source.name),
                &reason,
            );
            return;
        }
    }

    let mut columns = source.columns.iter().collect::<Vec<_>>();
    columns.sort_by(|left, right| {
        left.1
            .ordinal_position
            .cmp(&right.1.ordinal_position)
            .then_with(|| left.0.as_str().cmp(right.0.as_str()))
    });
    let mut definitions = Vec::with_capacity(columns.len() + 1);
    for (name, column) in columns {
        match source_column_definition(context, &source.name, name, column) {
            Ok(definition) => definitions.push(format!("  {} {}", esc_id(name), definition)),
            Err(reason) => plan.block(
                &source.name,
                &format!("无法生成字段 {}.{} 的定义", source.name, name),
                &reason,
            ),
        }
    }
    if !plan.blockers.is_empty() {
        return;
    }

    let primary_keys = primary_key_columns(source);
    if !primary_keys.is_empty() {
        definitions.push(format!(
            "  PRIMARY KEY ({})",
            primary_keys
                .iter()
                .map(|name| esc_id(name))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let engine_clause = if engine.is_empty() {
        String::new()
    } else {
        format!(" ENGINE={engine}")
    };
    let comment_clause = if comment.is_empty() {
        String::new()
    } else {
        format!(" COMMENT={}", esc_str(comment))
    };
    plan.operation(
        OperationPhase::CreateTable,
        &source.name,
        DatabaseSyncOperationKind::CreateTable,
        DatabaseSyncRisk::Normal,
        &format!("创建目标端表 {}", source.name),
        vec![format!(
            "CREATE TABLE {}.{} (\n{}\n){}{}",
            esc_id(context.target_database),
            esc_id(&source.name),
            definitions.join(",\n"),
            engine_clause,
            comment_clause
        )],
    );
}

fn plan_changed_table(
    plan: &mut PlanFragments,
    context: &TablePlanContext<'_>,
    source: &TableSnapshot,
    target: &TableSnapshot,
) {
    let mut add_column_sql = Vec::new();
    for difference in compare_table_columns(source, target) {
        match difference.status {
            SchemaDiffStatus::SourceOnly => {
                let Some(column) = difference.source.as_ref() else {
                    unreachable!("源端独有字段必须包含源端定义");
                };
                match source_column_definition(context, &source.name, &difference.name, column) {
                    Ok(definition) => {
                        add_column_sql.push(format!(
                            "ALTER TABLE {}.{} ADD COLUMN {} {}{}",
                            esc_id(context.target_database),
                            esc_id(&source.name),
                            esc_id(&difference.name),
                            definition,
                            source_position_clause(source, &difference.name)
                        ));
                    }
                    Err(reason) => plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        &reason,
                    ),
                }
            }
            SchemaDiffStatus::Changed => {
                let Some(column) = difference.source.as_ref() else {
                    unreachable!("变化字段必须包含源端定义");
                };
                match source_column_definition(context, &source.name, &difference.name, column) {
                    Ok(definition) => {
                        let position = if difference
                            .changed_fields
                            .iter()
                            .any(|field| field == "ordinal_position")
                        {
                            source_position_clause(source, &difference.name)
                        } else {
                            String::new()
                        };
                        plan.operation(
                            OperationPhase::AlterColumn,
                            &source.name,
                            DatabaseSyncOperationKind::AlterColumn,
                            DatabaseSyncRisk::High,
                            &format!("修改字段 {}.{}", source.name, difference.name),
                            vec![format!(
                                "ALTER TABLE {}.{} MODIFY COLUMN {} {}{}",
                                esc_id(context.target_database),
                                esc_id(&source.name),
                                esc_id(&difference.name),
                                definition,
                                position
                            )],
                        );
                    }
                    Err(reason) => plan.block(
                        &source.name,
                        &format!("无法修改字段 {}.{}", source.name, difference.name),
                        &reason,
                    ),
                }
            }
            SchemaDiffStatus::TargetOnly => {
                if context.include_drops {
                    plan.operation(
                        OperationPhase::DropColumn,
                        &source.name,
                        DatabaseSyncOperationKind::DropColumn,
                        DatabaseSyncRisk::Destructive,
                        &format!("删除目标端独有字段 {}.{}", source.name, difference.name),
                        vec![format!(
                            "ALTER TABLE {}.{} DROP COLUMN {}",
                            esc_id(context.target_database),
                            esc_id(&source.name),
                            esc_id(&difference.name)
                        )],
                    );
                } else {
                    plan.skip(
                        &source.name,
                        &format!("跳过删除目标端独有字段 {}.{}", source.name, difference.name),
                        "未开启包含删除操作",
                    );
                }
            }
        }
    }

    if !add_column_sql.is_empty() {
        plan.operation(
            OperationPhase::AddColumn,
            &source.name,
            DatabaseSyncOperationKind::AddColumn,
            DatabaseSyncRisk::Normal,
            &format!("新增表 {} 的 {} 个字段", source.name, add_column_sql.len()),
            add_column_sql,
        );
    }

    let source_primary_keys = primary_key_columns(source);
    let target_primary_keys = primary_key_columns(target);
    if source_primary_keys != target_primary_keys {
        let mut sql = Vec::with_capacity(2);
        if !target_primary_keys.is_empty() {
            sql.push(format!(
                "ALTER TABLE {}.{} DROP PRIMARY KEY",
                esc_id(context.target_database),
                esc_id(&source.name)
            ));
        }
        if !source_primary_keys.is_empty() {
            sql.push(format!(
                "ALTER TABLE {}.{} ADD PRIMARY KEY ({})",
                esc_id(context.target_database),
                esc_id(&source.name),
                source_primary_keys
                    .iter()
                    .map(|name| esc_id(name))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        plan.operation(
            OperationPhase::AlterColumn,
            &source.name,
            DatabaseSyncOperationKind::ReplacePrimaryKey,
            DatabaseSyncRisk::High,
            &format!("同步表 {} 的主键", source.name),
            sql,
        );
    }
}

fn source_column_definition(
    context: &TablePlanContext<'_>,
    table_name: &str,
    column_name: &str,
    column: &ColumnSnapshot,
) -> Result<String, String> {
    validate_column_type(&column.column_type)?;
    validate_column_extra(&column.extra)?;

    let generated_storage = generated_storage(&column.extra)?;
    if let Some(storage) = generated_storage {
        if column.default_value.is_some() {
            return Err(format!(
                "生成列 {table_name}.{column_name} 同时包含默认值，无法无损生成定义"
            ));
        }
        let expression = match context.source_metadata {
            Some(TableSyncMetadata::MySql { columns, .. }) => match columns.get(column_name) {
                Some(ColumnSyncMetadata::MySql {
                    generation_expression,
                }) if !generation_expression.trim().is_empty() => generation_expression,
                _ => {
                    return Err(format!(
                        "生成列 {table_name}.{column_name} 缺少生成表达式，无法无损生成定义"
                    ));
                }
            },
            _ => {
                return Err(format!(
                    "生成列 {table_name}.{column_name} 缺少 MySQL 原生元数据，无法无损生成定义"
                ));
            }
        };
        let nullability = if column.nullable { "" } else { " NOT NULL" };
        let comment = if column.comment.is_empty() {
            String::new()
        } else {
            format!(" COMMENT {}", esc_str(&column.comment))
        };
        return Ok(format!(
            "{} GENERATED ALWAYS AS ({expression}) {storage}{nullability}{comment}",
            column.column_type
        ));
    }

    Ok(build_column_definition(
        &column.column_type,
        column.nullable,
        &column.default_value,
        &column.extra,
        &column.comment,
    ))
}

fn generated_storage(extra: &str) -> Result<Option<&'static str>, String> {
    let tokens = extra
        .split_whitespace()
        .map(|token| token.to_ascii_uppercase())
        .collect::<Vec<_>>();
    match tokens.as_slice() {
        [storage] if storage == "VIRTUAL" => Ok(Some("VIRTUAL")),
        [storage] if storage == "STORED" || storage == "PERSISTENT" => Ok(Some("STORED")),
        [storage, generated] if storage == "VIRTUAL" && generated == "GENERATED" => {
            Ok(Some("VIRTUAL"))
        }
        [storage, generated]
            if (storage == "STORED" || storage == "PERSISTENT") && generated == "GENERATED" =>
        {
            Ok(Some("STORED"))
        }
        _ if tokens.iter().any(|token| {
            matches!(
                token.as_str(),
                "GENERATED" | "VIRTUAL" | "STORED" | "PERSISTENT"
            )
        }) =>
        {
            Err(format!("无法无损解析 MySQL 生成列 extra 片段: {extra}"))
        }
        _ => Ok(None),
    }
}

fn source_position_clause(source: &TableSnapshot, column_name: &str) -> String {
    let mut columns = source.columns.iter().collect::<Vec<_>>();
    columns.sort_by(|left, right| {
        left.1
            .ordinal_position
            .cmp(&right.1.ordinal_position)
            .then_with(|| left.0.as_str().cmp(right.0.as_str()))
    });
    let Some(index) = columns.iter().position(|(name, _)| name == column_name) else {
        return String::new();
    };
    if index == 0 {
        " FIRST".to_string()
    } else {
        format!(" AFTER {}", esc_id(columns[index - 1].0.as_str()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    use crate::db::schema_compare::TableSnapshot;
    use crate::db::schema_sync::{
        finalize_preview, SyncSchemaSnapshot, TablePlanContext, TableSyncMetadata,
    };
    use crate::models::types::{
        ColumnSnapshot, DatabaseCompareEndpointRequest, DatabaseSyncOperationKind,
        DatabaseSyncRequest,
    };

    fn table(name: &str, columns: Vec<(&str, u32, &str, bool)>) -> TableSnapshot {
        TableSnapshot {
            name: name.to_string(),
            columns: columns
                .into_iter()
                .map(|(name, position, column_type, primary_key)| {
                    (
                        name.to_string(),
                        ColumnSnapshot {
                            ordinal_position: position,
                            column_type: column_type.to_string(),
                            nullable: false,
                            default_value: None,
                            primary_key,
                            extra: String::new(),
                            comment: String::new(),
                        },
                    )
                })
                .collect(),
        }
    }

    fn all_sql(plan: &crate::db::schema_sync::PlanFragments) -> Vec<&str> {
        plan.operations
            .iter()
            .flat_map(|operation| operation.sql.iter().map(String::as_str))
            .collect()
    }

    #[test]
    fn metadata_query_loads_all_base_tables_once() {
        let sql = metadata_sql();
        assert!(sql.contains("information_schema.TABLES"));
        assert!(sql.contains("information_schema.COLUMNS"));
        assert!(sql.contains("GENERATION_EXPRESSION"));
        assert!(sql.contains("TABLE_SCHEMA = :schema"));
        assert!(sql.contains("TABLE_TYPE = 'BASE TABLE'"));
        assert!(!sql.contains(":table"));
    }

    #[test]
    fn plans_create_modify_primary_key_and_protected_drop() {
        let source = table(
            "users",
            vec![
                ("id", 1, "bigint", true),
                ("email", 2, "varchar(255)", false),
            ],
        );
        let target = table(
            "users",
            vec![("id", 1, "int", false), ("legacy", 2, "text", false)],
        );
        let metadata = TableSyncMetadata::MySql {
            engine: "InnoDB".to_string(),
            comment: "用户".to_string(),
            columns: BTreeMap::new(),
        };
        let protected = plan_table(TablePlanContext {
            target_database: "app_copy",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&metadata),
            target_metadata: None,
            include_drops: false,
        });
        assert!(protected.operations.iter().any(|item| item
            .sql
            .iter()
            .any(|sql| sql.contains("MODIFY COLUMN `id` bigint"))));
        assert!(protected.operations.iter().any(|item| item
            .sql
            .iter()
            .any(|sql| sql.contains("ADD COLUMN `email` varchar(255)"))));
        assert!(protected.operations.iter().any(|item| item
            .sql
            .iter()
            .any(|sql| sql.contains("ADD PRIMARY KEY (`id`)"))));
        assert!(!protected
            .operations
            .iter()
            .flat_map(|item| &item.sql)
            .any(|sql| sql.contains("DROP COLUMN `legacy`")));
        assert_eq!(protected.skipped_items.len(), 1);
    }

    #[test]
    fn creates_qualified_table_with_columns_primary_key_engine_and_comment() {
        let source = table(
            "users",
            vec![
                ("id", 1, "bigint unsigned", true),
                ("name", 2, "varchar(100)", false),
            ],
        );
        let metadata = TableSyncMetadata::MySql {
            engine: "InnoDB".to_string(),
            comment: "用户表".to_string(),
            columns: BTreeMap::new(),
        };

        let plan = plan_table(TablePlanContext {
            target_database: "app`copy",
            source: Some(&source),
            target: None,
            source_metadata: Some(&metadata),
            target_metadata: None,
            include_drops: false,
        });

        assert_eq!(all_sql(&plan).len(), 1);
        assert_eq!(
            all_sql(&plan)[0],
            "CREATE TABLE `app``copy`.`users` (\n  `id` bigint unsigned NOT NULL,\n  `name` varchar(100) NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB COMMENT='用户表'"
        );
        assert!(plan.blockers.is_empty());
    }

    #[test]
    fn places_added_and_reordered_columns_from_source_ordinals() {
        let source = table(
            "users",
            vec![
                ("first_name", 1, "varchar(50)", false),
                ("id", 2, "bigint", false),
                ("email", 3, "varchar(255)", false),
            ],
        );
        let target = table(
            "users",
            vec![
                ("email", 1, "varchar(255)", false),
                ("id", 2, "bigint", false),
            ],
        );

        let plan = plan_table(TablePlanContext {
            target_database: "copy",
            source: Some(&source),
            target: Some(&target),
            source_metadata: None,
            target_metadata: None,
            include_drops: false,
        });
        let sql = all_sql(&plan);

        assert!(sql.iter().any(|sql| sql.contains(
            "ALTER TABLE `copy`.`users` ADD COLUMN `first_name` varchar(50) NOT NULL FIRST"
        )));
        assert!(sql.iter().any(|sql| sql.contains(
            "ALTER TABLE `copy`.`users` MODIFY COLUMN `email` varchar(255) NOT NULL AFTER `id`"
        )));
    }

    #[test]
    fn includes_column_and_table_drops_only_when_enabled() {
        let source = table("users", vec![("id", 1, "bigint", false)]);
        let target = table(
            "users",
            vec![("id", 1, "bigint", false), ("legacy", 2, "text", false)],
        );
        let changed = plan_table(TablePlanContext {
            target_database: "copy",
            source: Some(&source),
            target: Some(&target),
            source_metadata: None,
            target_metadata: None,
            include_drops: true,
        });
        assert!(all_sql(&changed)
            .iter()
            .any(|sql| sql.contains("DROP COLUMN `legacy`")));

        let target_only = table("audit", vec![("id", 1, "bigint", false)]);
        let protected = plan_table(TablePlanContext {
            target_database: "copy",
            source: None,
            target: Some(&target_only),
            source_metadata: None,
            target_metadata: None,
            include_drops: false,
        });
        assert!(all_sql(&protected).is_empty());
        assert_eq!(protected.skipped_items.len(), 1);

        let enabled = plan_table(TablePlanContext {
            target_database: "copy",
            source: None,
            target: Some(&target_only),
            source_metadata: None,
            target_metadata: None,
            include_drops: true,
        });
        assert_eq!(all_sql(&enabled), vec!["DROP TABLE `copy`.`audit`"]);
    }

    #[test]
    fn preserves_generated_expression_and_blocks_missing_expression() {
        let mut source = table("totals", vec![("total", 1, "decimal(10,2)", false)]);
        source.columns[0].1.extra = "STORED GENERATED".to_string();
        let with_expression = TableSyncMetadata::MySql {
            engine: "InnoDB".to_string(),
            comment: String::new(),
            columns: BTreeMap::from([(
                "total".to_string(),
                crate::db::schema_sync::ColumnSyncMetadata::MySql {
                    generation_expression: "(`price` * `quantity`)".to_string(),
                },
            )]),
        };
        let generated = plan_table(TablePlanContext {
            target_database: "copy",
            source: Some(&source),
            target: None,
            source_metadata: Some(&with_expression),
            target_metadata: None,
            include_drops: false,
        });
        assert!(all_sql(&generated)[0].contains(
            "decimal(10,2) GENERATED ALWAYS AS ((`price` * `quantity`)) STORED NOT NULL"
        ));

        let missing_expression = TableSyncMetadata::MySql {
            engine: "InnoDB".to_string(),
            comment: String::new(),
            columns: BTreeMap::new(),
        };
        let blocked = plan_table(TablePlanContext {
            target_database: "copy",
            source: Some(&source),
            target: None,
            source_metadata: Some(&missing_expression),
            target_metadata: None,
            include_drops: false,
        });
        assert!(all_sql(&blocked).is_empty());
        assert_eq!(blocked.blockers.len(), 1);
    }

    #[test]
    fn reconstructs_mariadb_persistent_generated_columns() {
        let mut source = table("totals", vec![("total", 1, "decimal(10,2)", false)]);
        source.columns[0].1.nullable = true;
        source.columns[0].1.extra = "PERSISTENT".to_string();
        let metadata = TableSyncMetadata::MySql {
            engine: "InnoDB".to_string(),
            comment: String::new(),
            columns: BTreeMap::from([(
                "total".to_string(),
                crate::db::schema_sync::ColumnSyncMetadata::MySql {
                    generation_expression: "price * quantity".to_string(),
                },
            )]),
        };
        let plan = plan_table(TablePlanContext {
            target_database: "copy",
            source: Some(&source),
            target: None,
            source_metadata: Some(&metadata),
            target_metadata: None,
            include_drops: false,
        });

        assert!(all_sql(&plan)[0]
            .contains("decimal(10,2) GENERATED ALWAYS AS (price * quantity) STORED"));
        assert!(!all_sql(&plan)[0].contains(" PERSISTENT"));
    }

    #[test]
    fn blocks_unsafe_column_fragments_without_emitting_ddl() {
        let source = table("users", vec![("id", 1, "bigint; DROP TABLE users", false)]);
        let metadata = TableSyncMetadata::MySql {
            engine: "InnoDB".to_string(),
            comment: String::new(),
            columns: BTreeMap::new(),
        };
        let plan = plan_table(TablePlanContext {
            target_database: "copy",
            source: Some(&source),
            target: None,
            source_metadata: Some(&metadata),
            target_metadata: None,
            include_drops: false,
        });

        assert!(all_sql(&plan).is_empty());
        assert_eq!(plan.blockers.len(), 1);
    }

    #[test]
    fn final_preview_keeps_dependent_add_columns_in_source_order() {
        let source = table(
            "users",
            vec![
                ("z_parent", 1, "bigint", false),
                ("a_child", 2, "bigint", false),
                ("id", 3, "bigint", false),
            ],
        );
        let target = table("users", vec![("id", 3, "bigint", false)]);
        let fragments = plan_table(TablePlanContext {
            target_database: "copy",
            source: Some(&source),
            target: Some(&target),
            source_metadata: None,
            target_metadata: None,
            include_drops: false,
        });
        let request = DatabaseSyncRequest {
            source: DatabaseCompareEndpointRequest {
                saved_connection_id: "source".to_string(),
                database: "app".to_string(),
            },
            target: DatabaseCompareEndpointRequest {
                saved_connection_id: "target".to_string(),
                database: "copy".to_string(),
            },
            selected_tables: vec!["users".to_string()],
            include_drops: false,
        };
        let preview = finalize_preview(
            &request,
            &SyncSchemaSnapshot {
                tables: vec![source],
                metadata: BTreeMap::new(),
            },
            &SyncSchemaSnapshot {
                tables: vec![target],
                metadata: BTreeMap::new(),
            },
            fragments,
        )
        .unwrap();
        let add_sql = preview
            .operations
            .iter()
            .filter(|operation| operation.kind == DatabaseSyncOperationKind::AddColumn)
            .flat_map(|operation| operation.sql.iter().map(String::as_str))
            .collect::<Vec<_>>();

        assert_eq!(add_sql.len(), 2);
        assert!(add_sql[0].contains("ADD COLUMN `z_parent`"));
        assert!(
            add_sql[1].contains("ADD COLUMN `a_child`") && add_sql[1].contains("AFTER `z_parent`")
        );
    }
}
