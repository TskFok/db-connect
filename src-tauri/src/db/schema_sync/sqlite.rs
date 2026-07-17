use std::collections::BTreeMap;

use deadpool_sqlite::Pool;

use crate::db::schema_compare::{compare_table_columns, TableSnapshot};
use crate::db::sql_utils::{sqlite_id, sqlite_str};
use crate::db::sqlite::{build_add_column_sql, build_create_table_sql};
use crate::models::types::{
    AddColumnRequest, CreateTableColumnDef, CreateTableRequest, DatabaseSyncOperationKind,
    DatabaseSyncRisk, SchemaDiffStatus,
};

use super::{
    primary_key_columns, ColumnSyncMetadata, OperationPhase, PlanFragments, TablePlanContext,
    TableSyncMetadata,
};

pub(crate) fn metadata_sql(schema: &str) -> String {
    format!(
        "SELECT objects.name AS table_name, COALESCE(objects.sql, '') AS create_sql, \
                columns.name AS column_name, columns.hidden \
         FROM {}.sqlite_schema objects \
         JOIN pragma_table_xinfo(objects.name, {}) columns \
         WHERE objects.type = 'table' AND lower(objects.name) NOT GLOB 'sqlite_*' \
         ORDER BY objects.name, columns.cid",
        sqlite_id(schema),
        sqlite_str(schema)
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MetadataRow {
    table_name: String,
    create_sql: String,
    column_name: String,
    hidden: i64,
}

fn aggregate_metadata_rows(rows: Vec<MetadataRow>) -> BTreeMap<String, TableSyncMetadata> {
    let mut metadata = BTreeMap::new();
    for row in rows {
        let entry = metadata
            .entry(row.table_name)
            .or_insert_with(|| TableSyncMetadata::Sqlite {
                create_sql: row.create_sql,
                columns: BTreeMap::new(),
            });
        let TableSyncMetadata::Sqlite { columns, .. } = entry else {
            unreachable!("SQLite 元数据映射只能创建 Sqlite 变体");
        };
        columns.insert(
            row.column_name,
            ColumnSyncMetadata::Sqlite { hidden: row.hidden },
        );
    }
    metadata
}

#[allow(dead_code, reason = "将在后续统一同步元数据分发中调用")]
pub(crate) async fn load_metadata(
    pool: &Pool,
    schema: &str,
) -> Result<BTreeMap<String, TableSyncMetadata>, String> {
    let conn = pool
        .get()
        .await
        .map_err(|error| format!("获取 SQLite 同步元数据连接失败: {error}"))?;
    let sql = metadata_sql(schema);
    conn.interact(move |conn| {
        let mut statement = conn
            .prepare(&sql)
            .map_err(|error| format!("查询 SQLite 同步表元数据失败: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok(MetadataRow {
                    table_name: row.get("table_name")?,
                    create_sql: row.get("create_sql")?,
                    column_name: row.get("column_name")?,
                    hidden: row.get("hidden")?,
                })
            })
            .map_err(|error| format!("查询 SQLite 同步表元数据失败: {error}"))?;
        let mapped = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("查询 SQLite 同步表元数据失败: {error}"))?;
        Ok(aggregate_metadata_rows(mapped))
    })
    .await
    .map_err(|error| format!("SQLite 同步元数据查询任务失败: {error}"))?
}

#[allow(dead_code, reason = "将在后续统一同步计划分发中调用")]
pub(crate) fn plan_table(context: TablePlanContext<'_>) -> PlanFragments {
    let mut plan = PlanFragments::default();
    match (context.source, context.target) {
        (Some(source), None) => plan_create_table(&mut plan, &context, source),
        (None, Some(target)) => plan_target_only_table(&mut plan, &context, target),
        (Some(source), Some(target)) => plan_changed_table(&mut plan, &context, source, target),
        (None, None) => plan.block("", "无法规划同步", "表在源端和目标端都不存在"),
    }
    plan
}

fn plan_target_only_table(
    plan: &mut PlanFragments,
    context: &TablePlanContext<'_>,
    target: &TableSnapshot,
) {
    if context.include_drops {
        plan.operation(
            OperationPhase::DropTable,
            &target.name,
            DatabaseSyncOperationKind::DropTable,
            DatabaseSyncRisk::Destructive,
            &format!("删除目标端独有表 {}", target.name),
            vec![format!(
                "DROP TABLE {}.{}",
                sqlite_id(context.target_database),
                sqlite_id(&target.name)
            )],
        );
    } else {
        plan.skip(&target.name, "跳过删除目标端独有表", "未开启包含删除操作");
    }
}

#[derive(Clone, Copy)]
struct SqliteTableMetadataRef<'a> {
    create_sql: &'a str,
    columns: &'a BTreeMap<String, ColumnSyncMetadata>,
}

fn table_metadata<'a>(
    metadata: Option<&'a TableSyncMetadata>,
    table_name: &str,
) -> Result<SqliteTableMetadataRef<'a>, String> {
    let Some(TableSyncMetadata::Sqlite {
        create_sql,
        columns,
    }) = metadata
    else {
        return Err(format!("表 {table_name} 缺少 SQLite 原生表元数据"));
    };
    Ok(SqliteTableMetadataRef {
        create_sql,
        columns,
    })
}

fn column_hidden(
    metadata: SqliteTableMetadataRef<'_>,
    table_name: &str,
    column_name: &str,
) -> Result<i64, String> {
    let Some(ColumnSyncMetadata::Sqlite { hidden }) = metadata.columns.get(column_name) else {
        return Err(format!(
            "字段 {table_name}.{column_name} 缺少 SQLite 原生 hidden 元数据"
        ));
    };
    Ok(*hidden)
}

fn validate_plain_table(metadata: SqliteTableMetadataRef<'_>) -> Result<(), String> {
    let create_sql = metadata.create_sql.trim().trim_end_matches(';').trim();
    if create_sql.is_empty() {
        return Err("SQLite 原始建表声明为空，无法确认表形态".to_string());
    }
    let upper = create_sql.to_ascii_uppercase();
    if upper.starts_with("CREATE VIRTUAL TABLE") {
        return Err("SQLite 虚拟表无法由普通建表 builder 无损表达".to_string());
    }
    if !upper.starts_with("CREATE TABLE") {
        return Err("SQLite 原始建表声明不是普通 CREATE TABLE".to_string());
    }
    let Some((_, suffix)) = create_sql.rsplit_once(')') else {
        return Err("SQLite 原始建表声明缺少完整字段列表".to_string());
    };
    if !suffix.trim().is_empty() {
        return Err(format!(
            "SQLite 表选项 `{}` 无法由普通建表 builder 无损表达",
            suffix.trim()
        ));
    }
    Ok(())
}

fn plan_create_table(
    plan: &mut PlanFragments,
    context: &TablePlanContext<'_>,
    source: &TableSnapshot,
) {
    let metadata = match table_metadata(context.source_metadata, &source.name) {
        Ok(metadata) => metadata,
        Err(reason) => {
            plan.block(
                &source.name,
                &format!("无法创建表 {}", source.name),
                &reason,
            );
            return;
        }
    };
    if let Err(reason) = validate_plain_table(metadata) {
        plan.block(
            &source.name,
            &format!("无法创建表 {}", source.name),
            &reason,
        );
        return;
    }
    if source.columns.is_empty() {
        plan.block(
            &source.name,
            &format!("无法创建表 {}", source.name),
            "源表没有字段",
        );
        return;
    }

    let mut columns = source.columns.iter().collect::<Vec<_>>();
    columns.sort_by(|left, right| {
        left.1
            .ordinal_position
            .cmp(&right.1.ordinal_position)
            .then_with(|| left.0.cmp(&right.0))
    });
    let mut definitions = Vec::with_capacity(columns.len());
    for (name, column) in columns {
        let hidden = match column_hidden(metadata, &source.name, name) {
            Ok(hidden) => hidden,
            Err(reason) => {
                plan.block(
                    &source.name,
                    &format!("无法创建字段 {}.{}", source.name, name),
                    &reason,
                );
                continue;
            }
        };
        if hidden != 0 || !column.extra.trim().is_empty() {
            plan.block(
                &source.name,
                &format!("无法创建字段 {}.{}", source.name, name),
                "SQLite generated/auto_increment 字段无法由结构化 builder 无损重建",
            );
            continue;
        }
        let default_value = match normalize_default_for_builder(column.default_value.as_deref()) {
            Ok(default_value) => default_value.value,
            Err(reason) => {
                plan.block(
                    &source.name,
                    &format!("无法创建字段 {}.{}", source.name, name),
                    &reason,
                );
                continue;
            }
        };
        definitions.push(CreateTableColumnDef {
            name: name.clone(),
            column_type: column.column_type.clone(),
            nullable: column.nullable,
            default_value,
            extra: String::new(),
            comment: String::new(),
        });
    }
    if !plan.blockers.is_empty() {
        return;
    }

    let mut primary_keys = primary_key_columns(source);
    primary_keys.sort_by_key(|name| column_sort_key(source, name));
    let request = CreateTableRequest {
        table_name: source.name.clone(),
        columns: definitions,
        primary_keys,
        engine: String::new(),
        order_by: None,
        comment: String::new(),
    };
    match build_create_table_sql(context.target_database, &request) {
        Ok(sql) => plan.operation(
            OperationPhase::CreateTable,
            &source.name,
            DatabaseSyncOperationKind::CreateTable,
            DatabaseSyncRisk::Normal,
            &format!("创建目标端表 {}", source.name),
            vec![sql],
        ),
        Err(reason) => plan.block(
            &source.name,
            &format!("无法创建表 {}", source.name),
            &reason,
        ),
    }
}

fn column_sort_key(table: &TableSnapshot, column_name: &str) -> (u32, String) {
    table
        .columns
        .iter()
        .find(|(name, _)| name == column_name)
        .map(|(name, column)| (column.ordinal_position, name.clone()))
        .unwrap_or((u32::MAX, column_name.to_string()))
}

fn plan_changed_table(
    plan: &mut PlanFragments,
    context: &TablePlanContext<'_>,
    source: &TableSnapshot,
    target: &TableSnapshot,
) {
    let differences = compare_table_columns(source, target);
    let max_target_position = target
        .columns
        .iter()
        .map(|(_, column)| column.ordinal_position)
        .max()
        .unwrap_or_default();
    let source_metadata = context.source_metadata.and_then(|metadata| match metadata {
        TableSyncMetadata::Sqlite {
            create_sql,
            columns,
        } => Some(SqliteTableMetadataRef {
            create_sql,
            columns,
        }),
        _ => None,
    });
    let mut add_columns = Vec::new();
    let mut drop_columns = Vec::new();

    for difference in differences {
        match difference.status {
            SchemaDiffStatus::SourceOnly => {
                let Some(column) = difference.source.as_ref() else {
                    unreachable!("源端独有字段必须包含源端定义");
                };
                if column.ordinal_position <= max_target_position {
                    plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        "SQLite 只能安全追加字段到目标端现有字段末尾",
                    );
                    continue;
                }
                if column.primary_key {
                    plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        "SQLite 不能通过 ADD COLUMN 安全新增主键字段",
                    );
                    continue;
                }
                let Some(metadata) = source_metadata else {
                    plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        "缺少 SQLite 原生表元数据",
                    );
                    continue;
                };
                let hidden = match column_hidden(metadata, &source.name, &difference.name) {
                    Ok(hidden) => hidden,
                    Err(reason) => {
                        plan.block(
                            &source.name,
                            &format!("无法新增字段 {}.{}", source.name, difference.name),
                            &reason,
                        );
                        continue;
                    }
                };
                if hidden != 0 || !column.extra.trim().is_empty() {
                    plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        "SQLite generated/auto_increment 字段不能通过 ADD COLUMN 无损新增",
                    );
                    continue;
                }
                let default_value =
                    match normalize_default_for_builder(column.default_value.as_deref()) {
                        Ok(default_value) => default_value,
                        Err(reason) => {
                            plan.block(
                                &source.name,
                                &format!("无法新增字段 {}.{}", source.name, difference.name),
                                &reason,
                            );
                            continue;
                        }
                    };
                if !column.nullable
                    && matches!(
                        default_value.kind,
                        SqliteDefaultKind::None | SqliteDefaultKind::Null
                    )
                {
                    plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        "SQLite ADD COLUMN 新增非空字段时需要非 NULL 常量默认值",
                    );
                    continue;
                }
                if default_value.kind == SqliteDefaultKind::CurrentTime {
                    plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        "SQLite ADD COLUMN 不支持 CURRENT_TIME/DATE/TIMESTAMP 默认值",
                    );
                    continue;
                }
                let request = AddColumnRequest {
                    name: difference.name.clone(),
                    column_type: column.column_type.clone(),
                    nullable: column.nullable,
                    default_value: default_value.value,
                    extra: String::new(),
                    comment: String::new(),
                    after_column: None,
                };
                match build_add_column_sql(context.target_database, &source.name, &request) {
                    Ok(sql) => add_columns.push((column.ordinal_position, difference.name, sql)),
                    Err(reason) => plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        &reason,
                    ),
                }
            }
            SchemaDiffStatus::Changed => plan.block(
                &source.name,
                &format!("无法修改字段 {}.{}", source.name, difference.name),
                "SQLite 首期不重建表修改已有字段",
            ),
            SchemaDiffStatus::TargetOnly => {
                if context.include_drops {
                    drop_columns.push(difference.name);
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
    if !plan.blockers.is_empty() {
        return;
    }

    add_columns.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let add_count = add_columns.len();
    let add_sql = add_columns
        .into_iter()
        .map(|(_, _, sql)| sql)
        .collect::<Vec<_>>();
    if !add_sql.is_empty() {
        plan.operation(
            OperationPhase::AddColumn,
            &source.name,
            DatabaseSyncOperationKind::AddColumn,
            DatabaseSyncRisk::Normal,
            &format!("新增表 {} 的 {} 个字段", source.name, add_count),
            add_sql,
        );
    }

    drop_columns.sort();
    for column_name in drop_columns {
        plan.operation(
            OperationPhase::DropColumn,
            &source.name,
            DatabaseSyncOperationKind::DropColumn,
            DatabaseSyncRisk::Destructive,
            &format!("删除目标端独有字段 {}.{}", source.name, column_name),
            vec![format!(
                "ALTER TABLE {}.{} DROP COLUMN {}",
                sqlite_id(context.target_database),
                sqlite_id(&source.name),
                sqlite_id(&column_name)
            )],
        );
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SqliteDefaultKind {
    None,
    Null,
    Constant,
    CurrentTime,
}

struct NormalizedSqliteDefault {
    value: Option<String>,
    kind: SqliteDefaultKind,
}

fn normalize_default_for_builder(
    default_value: Option<&str>,
) -> Result<NormalizedSqliteDefault, String> {
    let Some(default_value) = default_value else {
        return Ok(NormalizedSqliteDefault {
            value: None,
            kind: SqliteDefaultKind::None,
        });
    };
    let default_value = default_value.trim();
    if default_value.is_empty() {
        return Err("SQLite 默认表达式为空，无法无损表达".to_string());
    }

    if let Some(literal) = parse_single_quoted_literal(default_value)? {
        if literal.trim() != literal
            || literal.is_empty()
            || builder_treats_as_raw_default(&literal)
            || contains_rejected_default_text(&literal)
        {
            return Err(format!(
                "SQLite 文本默认值 `{default_value}` 无法由当前 builder 无损表达"
            ));
        }
        return Ok(NormalizedSqliteDefault {
            value: Some(literal),
            kind: SqliteDefaultKind::Constant,
        });
    }

    let upper = default_value.to_ascii_uppercase();
    let kind = if upper == "NULL" {
        SqliteDefaultKind::Null
    } else if matches!(upper.as_str(), "TRUE" | "FALSE") || is_sqlite_numeric_literal(default_value)
    {
        SqliteDefaultKind::Constant
    } else if matches!(
        upper.as_str(),
        "CURRENT_TIME" | "CURRENT_DATE" | "CURRENT_TIMESTAMP"
    ) {
        SqliteDefaultKind::CurrentTime
    } else {
        return Err(format!(
            "SQLite 默认表达式 `{default_value}` 无法由当前 builder 无损表达"
        ));
    };
    Ok(NormalizedSqliteDefault {
        value: Some(default_value.to_string()),
        kind,
    })
}

fn parse_single_quoted_literal(value: &str) -> Result<Option<String>, String> {
    if !value.starts_with('\'') && !value.ends_with('\'') {
        return Ok(None);
    }
    let Some(body) = value
        .strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
    else {
        return Err(format!("SQLite 文本默认值 `{value}` 引号不完整"));
    };
    let mut decoded = String::with_capacity(body.len());
    let mut chars = body.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\'' {
            if chars.next_if_eq(&'\'').is_none() {
                return Err(format!("SQLite 文本默认值 `{value}` 包含未转义单引号"));
            }
            decoded.push('\'');
        } else {
            decoded.push(character);
        }
    }
    Ok(Some(decoded))
}

fn contains_rejected_default_text(value: &str) -> bool {
    value.contains(';') || value.contains("--") || value.contains("/*") || value.contains("*/")
}

fn builder_treats_as_raw_default(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    upper == "NULL"
        || upper == "TRUE"
        || upper == "FALSE"
        || upper.starts_with("CURRENT_TIMESTAMP")
        || upper.starts_with("CURRENT_DATE")
        || upper.starts_with("CURRENT_TIME")
        || value.parse::<f64>().is_ok()
}

fn is_sqlite_numeric_literal(value: &str) -> bool {
    let bytes = value.as_bytes();
    let mut index = usize::from(matches!(bytes.first(), Some(b'+') | Some(b'-')));
    let mut integer_digits = 0;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        integer_digits += 1;
        index += 1;
    }
    let mut fraction_digits = 0;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            fraction_digits += 1;
            index += 1;
        }
    }
    if integer_digits + fraction_digits == 0 {
        return false;
    }
    if matches!(bytes.get(index), Some(b'e') | Some(b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+') | Some(b'-')) {
            index += 1;
        }
        let exponent_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if exponent_start == index {
            return false;
        }
    }
    index == bytes.len()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use deadpool_sqlite::{Config as SqliteConfig, Runtime};
    use uuid::Uuid;

    use crate::db::schema_compare::TableSnapshot;
    use crate::models::types::{ColumnSnapshot, DatabaseSyncOperationKind};

    use super::*;
    use crate::db::schema_sync::{
        ColumnSyncMetadata, PlanFragments, TablePlanContext, TableSyncMetadata,
    };

    fn column(
        ordinal_position: u32,
        column_type: &str,
        nullable: bool,
        default_value: Option<&str>,
        primary_key: bool,
        extra: &str,
    ) -> ColumnSnapshot {
        ColumnSnapshot {
            ordinal_position,
            column_type: column_type.to_string(),
            nullable,
            default_value: default_value.map(str::to_string),
            primary_key,
            extra: extra.to_string(),
            comment: String::new(),
        }
    }

    fn table(name: &str, columns: Vec<(&str, ColumnSnapshot)>) -> TableSnapshot {
        TableSnapshot {
            name: name.to_string(),
            columns: columns
                .into_iter()
                .map(|(name, details)| (name.to_string(), details))
                .collect(),
        }
    }

    fn test_table(name: &str, column_type: &str, generated: bool) -> TableSnapshot {
        table(
            name,
            vec![(
                "name",
                column(
                    1,
                    column_type,
                    false,
                    None,
                    false,
                    if generated { "generated" } else { "" },
                ),
            )],
        )
    }

    fn metadata(create_sql: &str, columns: Vec<(&str, i64)>) -> TableSyncMetadata {
        TableSyncMetadata::Sqlite {
            create_sql: create_sql.to_string(),
            columns: columns
                .into_iter()
                .map(|(name, hidden)| (name.to_string(), ColumnSyncMetadata::Sqlite { hidden }))
                .collect(),
        }
    }

    fn all_sql(plan: &PlanFragments) -> Vec<&str> {
        plan.operations
            .iter()
            .flat_map(|operation| operation.sql.iter().map(String::as_str))
            .collect()
    }

    #[test]
    fn metadata_query_reads_sqlite_schema_once() {
        let sql = metadata_sql("ma\"in");
        assert!(sql.contains("\"ma\"\"in\".sqlite_schema"));
        assert!(sql.contains("objects.type = 'table'"));
        assert!(sql.contains("lower(objects.name) NOT GLOB 'sqlite_*'"));
        assert!(sql.contains("pragma_table_xinfo(objects.name"));
        assert!(sql.contains("'ma\"in'"));
        assert!(!sql.contains(';'));
    }

    #[test]
    fn aggregates_native_metadata_by_table_in_memory() {
        let result = aggregate_metadata_rows(vec![
            MetadataRow {
                table_name: "users".to_string(),
                create_sql: "CREATE TABLE users (name TEXT, upper_name TEXT GENERATED ALWAYS AS (upper(name)))".to_string(),
                column_name: "name".to_string(),
                hidden: 0,
            },
            MetadataRow {
                table_name: "users".to_string(),
                create_sql: "CREATE TABLE users (name TEXT, upper_name TEXT GENERATED ALWAYS AS (upper(name)))".to_string(),
                column_name: "upper_name".to_string(),
                hidden: 2,
            },
        ]);

        let TableSyncMetadata::Sqlite {
            create_sql,
            columns,
        } = &result["users"]
        else {
            panic!("应聚合为 SQLite 元数据");
        };
        assert!(create_sql.contains("GENERATED ALWAYS"));
        assert!(matches!(
            columns.get("upper_name"),
            Some(ColumnSyncMetadata::Sqlite { hidden: 2 })
        ));
    }

    #[tokio::test]
    async fn loads_all_sqlite_native_metadata_with_one_schema_query() {
        let path = std::env::temp_dir().join(format!(
            "db-connect-schema-sync-sqlite-metadata-{}.sqlite",
            Uuid::new_v4()
        ));
        std::fs::File::create(&path).expect("create sqlite file");
        let pool = SqliteConfig::new(path.to_str().expect("utf8 path"))
            .create_pool(Runtime::Tokio1)
            .expect("create pool");
        let conn = pool.get().await.expect("get connection");
        conn.interact(|conn| {
            conn.execute_batch(
                "CREATE TABLE users (\
                   name TEXT NOT NULL DEFAULT 'anon',\
                   upper_name TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL\
                 );\
                 CREATE TABLE audit (id INTEGER);\
                 CREATE VIEW user_names AS SELECT name FROM users;",
            )
        })
        .await
        .expect("interact")
        .expect("create schema");
        drop(conn);

        let result = load_metadata(&pool, "main").await.expect("load metadata");
        assert_eq!(
            result.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["audit", "users"]
        );
        let TableSyncMetadata::Sqlite {
            create_sql,
            columns,
        } = &result["users"]
        else {
            panic!("应加载 SQLite 元数据");
        };
        assert!(create_sql.contains("GENERATED ALWAYS"));
        assert!(matches!(
            columns.get("upper_name"),
            Some(ColumnSyncMetadata::Sqlite { hidden: 2 })
        ));

        pool.close();
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn creates_plain_table_from_structured_snapshot_without_copying_excluded_objects() {
        let source = table(
            "us\"ers",
            vec![
                ("id", column(1, "INTEGER", false, None, true, "")),
                (
                    "display_name",
                    column(2, "TEXT", true, Some("'anon'"), false, ""),
                ),
            ],
        );
        let native = metadata(
            "CREATE TABLE users (id INTEGER PRIMARY KEY, display_name TEXT DEFAULT 'anon', FOREIGN KEY (id) REFERENCES tenants(id))",
            vec![("id", 0), ("display_name", 0)],
        );

        let plan = plan_table(TablePlanContext {
            target_database: "ma\"in",
            source: Some(&source),
            target: None,
            source_metadata: Some(&native),
            target_metadata: None,
            include_drops: false,
        });

        assert!(plan.blockers.is_empty());
        assert_eq!(plan.operations.len(), 1);
        assert_eq!(
            plan.operations[0].kind,
            DatabaseSyncOperationKind::CreateTable
        );
        assert_eq!(plan.operations[0].sql.len(), 1);
        let sql = &plan.operations[0].sql[0];
        assert!(sql.contains("CREATE TABLE \"ma\"\"in\".\"us\"\"ers\""));
        assert!(sql.contains("DEFAULT 'anon'"));
        assert!(!sql.contains("DEFAULT '''anon'''"));
        assert!(!sql.contains("FOREIGN KEY"));
    }

    #[test]
    fn blocks_generated_autoincrement_and_special_table_recreation() {
        let cases = [
            (
                test_table("generated_users", "TEXT", true),
                metadata(
                    "CREATE TABLE generated_users (name TEXT GENERATED ALWAYS AS ('x'))",
                    vec![("name", 2)],
                ),
            ),
            (
                table(
                    "sequence_users",
                    vec![(
                        "id",
                        column(1, "INTEGER", false, None, true, "auto_increment"),
                    )],
                ),
                metadata(
                    "CREATE TABLE sequence_users (id INTEGER PRIMARY KEY AUTOINCREMENT)",
                    vec![("id", 0)],
                ),
            ),
            (
                table(
                    "strict_users",
                    vec![("id", column(1, "INTEGER", false, None, true, ""))],
                ),
                metadata(
                    "CREATE TABLE strict_users (id INTEGER PRIMARY KEY) STRICT",
                    vec![("id", 0)],
                ),
            ),
        ];

        for (source, native) in cases {
            let plan = plan_table(TablePlanContext {
                target_database: "main",
                source: Some(&source),
                target: None,
                source_metadata: Some(&native),
                target_metadata: None,
                include_drops: false,
            });
            assert!(plan.operations.is_empty());
            assert_eq!(plan.blockers.len(), 1);
        }
    }

    #[test]
    fn blocks_defaults_that_builder_cannot_recreate_losslessly() {
        for default_value in ["lower('x')", "'42'", "(42)", "X'CAFE'"] {
            let source = table(
                "users",
                vec![(
                    "value",
                    column(1, "TEXT", true, Some(default_value), false, ""),
                )],
            );
            let native = metadata("CREATE TABLE users (value TEXT)", vec![("value", 0)]);
            let plan = plan_table(TablePlanContext {
                target_database: "main",
                source: Some(&source),
                target: None,
                source_metadata: Some(&native),
                target_metadata: None,
                include_drops: false,
            });
            assert!(plan.operations.is_empty(), "default={default_value}");
            assert_eq!(plan.blockers.len(), 1, "default={default_value}");
        }
    }

    #[test]
    fn appends_plain_column_with_qualified_escaped_identifiers() {
        let source = table(
            "us\"ers",
            vec![
                ("id", column(1, "INTEGER", false, None, false, "")),
                ("na\"me", column(2, "TEXT", true, Some("'anon'"), false, "")),
            ],
        );
        let target = table(
            "us\"ers",
            vec![("id", column(1, "INTEGER", false, None, false, ""))],
        );
        let source_native = metadata(
            "CREATE TABLE users (id INTEGER, name TEXT)",
            vec![("id", 0), ("na\"me", 0)],
        );
        let target_native = metadata("CREATE TABLE users (id INTEGER)", vec![("id", 0)]);

        let plan = plan_table(TablePlanContext {
            target_database: "ma\"in",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_native),
            target_metadata: Some(&target_native),
            include_drops: false,
        });

        assert!(plan.blockers.is_empty());
        assert_eq!(plan.operations.len(), 1);
        assert_eq!(
            plan.operations[0].kind,
            DatabaseSyncOperationKind::AddColumn
        );
        assert_eq!(
            plan.operations[0].sql,
            vec!["ALTER TABLE \"ma\"\"in\".\"us\"\"ers\" ADD COLUMN \"na\"\"me\" TEXT DEFAULT 'anon'"]
        );
    }

    #[test]
    fn unsafe_add_column_shapes_are_blocked() {
        let target = table(
            "users",
            vec![("id", column(1, "INTEGER", false, None, false, ""))],
        );
        let cases = [
            (
                table(
                    "users",
                    vec![
                        ("id", column(1, "INTEGER", false, None, false, "")),
                        ("value", column(2, "TEXT", true, None, true, "")),
                    ],
                ),
                0,
            ),
            (
                table(
                    "users",
                    vec![
                        ("id", column(1, "INTEGER", false, None, false, "")),
                        ("value", column(2, "TEXT", true, None, false, "generated")),
                    ],
                ),
                2,
            ),
            (
                table(
                    "users",
                    vec![
                        ("id", column(1, "INTEGER", false, None, false, "")),
                        ("value", column(2, "TEXT", false, None, false, "")),
                    ],
                ),
                0,
            ),
            (
                table(
                    "users",
                    vec![
                        ("id", column(1, "INTEGER", false, None, false, "")),
                        (
                            "value",
                            column(2, "TEXT", true, Some("CURRENT_TIMESTAMP"), false, ""),
                        ),
                    ],
                ),
                0,
            ),
        ];

        for (source, hidden) in cases {
            let source_native = metadata(
                "CREATE TABLE users (id INTEGER, value TEXT)",
                vec![("id", 0), ("value", hidden)],
            );
            let target_native = metadata("CREATE TABLE users (id INTEGER)", vec![("id", 0)]);
            let plan = plan_table(TablePlanContext {
                target_database: "main",
                source: Some(&source),
                target: Some(&target),
                source_metadata: Some(&source_native),
                target_metadata: Some(&target_native),
                include_drops: false,
            });
            assert!(plan.operations.is_empty());
            assert!(!plan.blockers.is_empty());
        }
    }

    #[test]
    fn inserting_column_before_existing_tail_is_blocked() {
        let source = table(
            "users",
            vec![
                ("id", column(1, "INTEGER", false, None, false, "")),
                ("middle", column(2, "TEXT", true, None, false, "")),
                ("tail", column(3, "TEXT", true, None, false, "")),
            ],
        );
        let target = table(
            "users",
            vec![
                ("id", column(1, "INTEGER", false, None, false, "")),
                ("tail", column(3, "TEXT", true, None, false, "")),
            ],
        );
        let source_native = metadata(
            "CREATE TABLE users (id INTEGER, middle TEXT, tail TEXT)",
            vec![("id", 0), ("middle", 0), ("tail", 0)],
        );
        let target_native = metadata(
            "CREATE TABLE users (id INTEGER, tail TEXT)",
            vec![("id", 0), ("tail", 0)],
        );

        let plan = plan_table(TablePlanContext {
            target_database: "main",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_native),
            target_metadata: Some(&target_native),
            include_drops: false,
        });
        assert!(plan.operations.is_empty());
        assert!(plan.blockers[0].reason.contains("末尾"));
    }

    #[test]
    fn modifying_existing_column_is_blocked_instead_of_rebuilding() {
        let source = test_table("users", "text", false);
        let target = test_table("users", "integer", false);
        let native = TableSyncMetadata::Sqlite {
            create_sql: "CREATE TABLE users (name TEXT NOT NULL)".to_string(),
            columns: BTreeMap::new(),
        };
        let plan = plan_table(TablePlanContext {
            target_database: "main",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&native),
            target_metadata: Some(&native),
            include_drops: true,
        });
        assert!(plan.operations.is_empty());
        assert!(plan.blockers[0].reason.contains("不重建表"));
    }

    #[test]
    fn drop_planning_respects_include_drops_and_escapes_identifiers() {
        let source = table(
            "us\"ers",
            vec![("id", column(1, "INTEGER", false, None, false, ""))],
        );
        let target = table(
            "us\"ers",
            vec![
                ("id", column(1, "INTEGER", false, None, false, "")),
                ("old\"value", column(2, "TEXT", true, None, false, "")),
            ],
        );

        let protected = plan_table(TablePlanContext {
            target_database: "ma\"in",
            source: Some(&source),
            target: Some(&target),
            source_metadata: None,
            target_metadata: None,
            include_drops: false,
        });
        assert!(all_sql(&protected).iter().all(|sql| !sql.contains("DROP")));
        assert_eq!(protected.skipped_items.len(), 1);

        let allowed = plan_table(TablePlanContext {
            target_database: "ma\"in",
            source: Some(&source),
            target: Some(&target),
            source_metadata: None,
            target_metadata: None,
            include_drops: true,
        });
        assert_eq!(
            all_sql(&allowed),
            vec!["ALTER TABLE \"ma\"\"in\".\"us\"\"ers\" DROP COLUMN \"old\"\"value\""]
        );
    }

    #[test]
    fn target_only_table_drop_is_protected_by_include_drops() {
        let target = table(
            "old\"table",
            vec![("id", column(1, "INTEGER", false, None, false, ""))],
        );
        let protected = plan_table(TablePlanContext {
            target_database: "ma\"in",
            source: None,
            target: Some(&target),
            source_metadata: None,
            target_metadata: None,
            include_drops: false,
        });
        assert!(all_sql(&protected).iter().all(|sql| !sql.contains("DROP")));
        assert_eq!(protected.skipped_items.len(), 1);

        let allowed = plan_table(TablePlanContext {
            target_database: "ma\"in",
            source: None,
            target: Some(&target),
            source_metadata: None,
            target_metadata: None,
            include_drops: true,
        });
        assert_eq!(
            all_sql(&allowed),
            vec!["DROP TABLE \"ma\"\"in\".\"old\"\"table\""]
        );
    }
}
