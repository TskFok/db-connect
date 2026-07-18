use std::collections::{BTreeMap, BTreeSet};

use deadpool_postgres::Pool as PgPool;

use crate::db::postgres::get_client_with_retry;
use crate::db::postgres_ddl;
use crate::db::schema_compare::{compare_table_columns, TableSnapshot};
use crate::models::types::{
    AddColumnRequest, AlterColumnRequest, ColumnInfo, ColumnSnapshot, CreateTableColumnDef,
    CreateTableRequest, DatabaseSyncOperationKind, DatabaseSyncRisk, SchemaDiffStatus,
};

use super::{
    add_column_risk, ColumnSyncMetadata, OperationPhase, PlanFragments, TablePlanContext,
    TableSyncMetadata,
};

#[allow(dead_code, reason = "将在后续统一同步元数据分发中调用")]
pub(crate) fn metadata_sql() -> &'static str {
    "SELECT cls.relname AS table_name, cls.relkind::text AS relkind, \
            COALESCE(pg_catalog.obj_description(cls.oid, 'pg_class'), '') AS table_comment, \
            primary_constraint.conname AS primary_key_constraint, cols.column_name, \
            COALESCE(cols.identity_generation, '') AS identity_generation, \
            cols.is_generated AS generated_kind, cols.generation_expression, \
            cols.column_default AS default_expression, \
            (cols.domain_name IS NOT NULL OR \
             cols.udt_schema NOT IN ('pg_catalog', 'information_schema')) AS is_user_defined, \
            COALESCE(cols.domain_schema, cols.udt_schema, '') AS type_schema, \
            COALESCE(cols.domain_name, cols.udt_name, '') AS type_name, \
            primary_key.ordinal_position::int AS primary_key_ordinal \
     FROM pg_catalog.pg_class cls \
     JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace \
     JOIN information_schema.columns cols \
       ON cols.table_schema = ns.nspname AND cols.table_name = cls.relname \
     JOIN pg_catalog.pg_attribute attr \
       ON attr.attrelid = cls.oid AND attr.attname = cols.column_name \
      AND attr.attnum > 0 AND NOT attr.attisdropped \
     LEFT JOIN pg_catalog.pg_constraint primary_constraint \
       ON primary_constraint.conrelid = cls.oid AND primary_constraint.contype = 'p' \
     LEFT JOIN LATERAL unnest(primary_constraint.conkey) WITH ORDINALITY \
       AS primary_key(attnum, ordinal_position) ON primary_key.attnum = attr.attnum \
     WHERE ns.nspname = $1 AND cls.relkind IN ('r', 'p') \
     ORDER BY cls.relname, cols.ordinal_position"
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MetadataRow {
    table_name: String,
    relkind: String,
    table_comment: String,
    primary_key_constraint: Option<String>,
    column_name: String,
    identity_generation: String,
    generated_kind: String,
    generation_expression: Option<String>,
    default_expression: Option<String>,
    is_user_defined: bool,
    type_schema: String,
    type_name: String,
    primary_key_ordinal: Option<u32>,
}

fn aggregate_metadata_rows(rows: Vec<MetadataRow>) -> BTreeMap<String, TableSyncMetadata> {
    let mut metadata = BTreeMap::new();
    for row in rows {
        let entry = metadata
            .entry(row.table_name)
            .or_insert_with(|| TableSyncMetadata::Postgres {
                relkind: row.relkind,
                table_comment: row.table_comment,
                primary_key_constraint: row.primary_key_constraint,
                columns: BTreeMap::new(),
            });
        let TableSyncMetadata::Postgres { columns, .. } = entry else {
            unreachable!("PostgreSQL 元数据映射只能创建 Postgres 变体");
        };
        columns.insert(
            row.column_name,
            ColumnSyncMetadata::Postgres {
                identity_generation: row.identity_generation,
                generated_kind: row.generated_kind,
                generation_expression: row.generation_expression,
                default_expression: row.default_expression,
                is_user_defined: row.is_user_defined,
                type_schema: row.type_schema,
                type_name: row.type_name,
                primary_key_ordinal: row.primary_key_ordinal,
            },
        );
    }
    metadata
}

#[allow(dead_code, reason = "将在后续统一同步元数据分发中调用")]
pub(crate) async fn load_metadata(
    pool: &PgPool,
    schema: &str,
) -> Result<BTreeMap<String, TableSyncMetadata>, String> {
    let client = get_client_with_retry(pool).await?;
    let rows = client
        .query(metadata_sql(), &[&schema])
        .await
        .map_err(|error| format!("查询 PostgreSQL 同步表元数据失败: {error}"))?;
    let mapped = rows
        .into_iter()
        .map(|row| MetadataRow {
            table_name: row.get("table_name"),
            relkind: row.get("relkind"),
            table_comment: row.get("table_comment"),
            primary_key_constraint: row.get("primary_key_constraint"),
            column_name: row.get("column_name"),
            identity_generation: row.get("identity_generation"),
            generated_kind: row.get("generated_kind"),
            generation_expression: row.get("generation_expression"),
            default_expression: row.get("default_expression"),
            is_user_defined: row.get("is_user_defined"),
            type_schema: row.get("type_schema"),
            type_name: row.get("type_name"),
            primary_key_ordinal: row
                .get::<_, Option<i32>>("primary_key_ordinal")
                .and_then(|value| u32::try_from(value).ok()),
        })
        .collect();
    Ok(aggregate_metadata_rows(mapped))
}

#[allow(dead_code, reason = "将在后续统一同步计划分发中调用")]
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
                    vec![postgres_ddl::build_drop_table_sql(
                        context.target_database,
                        &target.name,
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

#[derive(Clone, Copy)]
struct PostgresTableMetadataRef<'a> {
    relkind: &'a str,
    table_comment: &'a str,
    primary_key_constraint: Option<&'a str>,
    columns: &'a BTreeMap<String, ColumnSyncMetadata>,
}

#[derive(Clone, Copy)]
struct PostgresColumnMetadataRef<'a> {
    identity_generation: &'a str,
    generated_kind: &'a str,
    generation_expression: Option<&'a str>,
    default_expression: Option<&'a str>,
    is_user_defined: bool,
    type_schema: &'a str,
    type_name: &'a str,
    primary_key_ordinal: Option<u32>,
}

fn table_metadata<'a>(
    metadata: Option<&'a TableSyncMetadata>,
    table_name: &str,
) -> Result<PostgresTableMetadataRef<'a>, String> {
    let Some(TableSyncMetadata::Postgres {
        relkind,
        table_comment,
        primary_key_constraint,
        columns,
    }) = metadata
    else {
        return Err(format!("表 {table_name} 缺少 PostgreSQL 原生表元数据"));
    };
    Ok(PostgresTableMetadataRef {
        relkind,
        table_comment,
        primary_key_constraint: primary_key_constraint.as_deref(),
        columns,
    })
}

fn column_metadata<'a>(
    metadata: PostgresTableMetadataRef<'a>,
    table_name: &str,
    column_name: &str,
) -> Result<PostgresColumnMetadataRef<'a>, String> {
    let Some(ColumnSyncMetadata::Postgres {
        identity_generation,
        generated_kind,
        generation_expression,
        default_expression,
        is_user_defined,
        type_schema,
        type_name,
        primary_key_ordinal,
    }) = metadata.columns.get(column_name)
    else {
        return Err(format!(
            "字段 {table_name}.{column_name} 缺少 PostgreSQL 原生字段元数据"
        ));
    };
    Ok(PostgresColumnMetadataRef {
        identity_generation,
        generated_kind,
        generation_expression: generation_expression.as_deref(),
        default_expression: default_expression.as_deref(),
        is_user_defined: *is_user_defined,
        type_schema,
        type_name,
        primary_key_ordinal: *primary_key_ordinal,
    })
}

fn validate_native_shape(
    metadata: PostgresColumnMetadataRef<'_>,
    table_name: &str,
    column_name: &str,
) -> Result<(), String> {
    let identity = metadata.identity_generation.trim();
    if !identity.is_empty()
        && !identity.eq_ignore_ascii_case("ALWAYS")
        && !identity.eq_ignore_ascii_case("BY DEFAULT")
    {
        return Err(format!(
            "字段 {table_name}.{column_name} 包含未知 identity_generation `{identity}`"
        ));
    }
    let generated = metadata.generated_kind.trim();
    if !generated.eq_ignore_ascii_case("NEVER") && !generated.eq_ignore_ascii_case("ALWAYS") {
        return Err(format!(
            "字段 {table_name}.{column_name} 包含未知 generated_kind `{generated}`"
        ));
    }
    let generation_expression = metadata
        .generation_expression
        .filter(|expression| !expression.trim().is_empty());
    if generated.eq_ignore_ascii_case("ALWAYS") && generation_expression.is_none() {
        return Err(format!(
            "generated 字段 {table_name}.{column_name} 缺少生成表达式"
        ));
    }
    if generated.eq_ignore_ascii_case("NEVER") && generation_expression.is_some() {
        return Err(format!(
            "普通字段 {table_name}.{column_name} 意外包含 generation_expression"
        ));
    }
    if !identity.is_empty() && generated.eq_ignore_ascii_case("ALWAYS") {
        return Err(format!(
            "字段 {table_name}.{column_name} 同时声明 identity 和 generated"
        ));
    }
    if metadata.is_user_defined
        && (metadata.type_schema.trim().is_empty() || metadata.type_name.trim().is_empty())
    {
        return Err(format!(
            "用户定义类型字段 {table_name}.{column_name} 缺少原生类型限定名"
        ));
    }
    Ok(())
}

fn native_special_equal(
    source: PostgresColumnMetadataRef<'_>,
    target: PostgresColumnMetadataRef<'_>,
) -> bool {
    source
        .identity_generation
        .eq_ignore_ascii_case(target.identity_generation)
        && source
            .generated_kind
            .eq_ignore_ascii_case(target.generated_kind)
        && source.generation_expression == target.generation_expression
}

fn metadata_matches_snapshot(
    column: &ColumnSnapshot,
    metadata: PostgresColumnMetadataRef<'_>,
) -> bool {
    column.default_value.as_deref() == metadata.default_expression
}

fn safe_default_for_builder(default_expression: Option<&str>) -> bool {
    let Some(default) = default_expression else {
        return true;
    };
    let trimmed = default.trim();
    if trimmed.is_empty() {
        return false;
    }
    let upper = trimmed.to_uppercase();
    upper == "NULL"
        || upper.starts_with("CURRENT_TIMESTAMP")
        || upper.starts_with("CURRENT_DATE")
        || upper.starts_with("CURRENT_TIME")
        || upper.starts_with("NOW(")
        || upper == "TRUE"
        || upper == "FALSE"
        || trimmed.parse::<f64>().is_ok()
}

fn validate_column_for_builder(
    column: &ColumnSnapshot,
    metadata: PostgresColumnMetadataRef<'_>,
    table_name: &str,
    column_name: &str,
    full_definition: bool,
    changed_fields: &[String],
) -> Result<(), String> {
    validate_native_shape(metadata, table_name, column_name)?;
    if !metadata_matches_snapshot(column, metadata) {
        return Err(format!(
            "字段 {table_name}.{column_name} 的默认表达式原生元数据与结构快照不一致"
        ));
    }
    let changes_definition = full_definition
        || changed_fields.iter().any(|field| {
            matches!(
                field.as_str(),
                "column_type" | "nullable" | "default_value" | "extra"
            )
        });
    if changes_definition && !metadata.identity_generation.trim().is_empty() {
        return Err(format!(
            "identity 字段 {table_name}.{column_name} 无法由当前 PostgreSQL builder 无损表达"
        ));
    }
    if changes_definition && metadata.generated_kind.eq_ignore_ascii_case("ALWAYS") {
        return Err(format!(
            "generated 字段 {table_name}.{column_name} 无法由当前 PostgreSQL builder 无损表达"
        ));
    }
    if (full_definition || changed_fields.iter().any(|field| field == "column_type"))
        && metadata.is_user_defined
    {
        return Err(format!(
            "用户定义类型字段 {table_name}.{column_name} 使用 {}.{}，无法证明目标端类型存在",
            metadata.type_schema, metadata.type_name
        ));
    }
    if (full_definition || changed_fields.iter().any(|field| field == "default_value"))
        && !safe_default_for_builder(metadata.default_expression)
    {
        return Err(format!(
            "字段 {table_name}.{column_name} 的默认表达式无法由当前 PostgreSQL builder 无损表达"
        ));
    }
    if (full_definition || changed_fields.iter().any(|field| field == "extra"))
        && metadata.identity_generation.trim().is_empty()
        && metadata.generated_kind.eq_ignore_ascii_case("NEVER")
        && !column.extra.trim().is_empty()
    {
        return Err(format!(
            "字段 {table_name}.{column_name} 包含无法识别的 PostgreSQL extra 属性"
        ));
    }
    Ok(())
}

fn postgres_primary_key_columns(
    table: &TableSnapshot,
    metadata: PostgresTableMetadataRef<'_>,
) -> Result<Vec<String>, String> {
    let primary_columns = table
        .columns
        .iter()
        .filter(|(_, column)| column.primary_key)
        .map(|(name, _)| name)
        .collect::<Vec<_>>();
    if primary_columns.is_empty() {
        return Ok(Vec::new());
    }

    let mut ordered = Vec::with_capacity(primary_columns.len());
    let mut ordinals = BTreeSet::new();
    for name in primary_columns {
        let native = column_metadata(metadata, &table.name, name)?;
        let Some(ordinal) = native.primary_key_ordinal else {
            return Err(format!(
                "主键字段 {}.{} 缺少 PostgreSQL 原生主键序号",
                table.name, name
            ));
        };
        if ordinal == 0 || !ordinals.insert(ordinal) {
            return Err(format!(
                "表 {} 包含无效或重复的 PostgreSQL 原生主键序号 {}",
                table.name, ordinal
            ));
        }
        ordered.push((ordinal, name.clone()));
    }
    ordered.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    Ok(ordered.into_iter().map(|(_, name)| name).collect())
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
    if metadata.relkind == "p" {
        plan.block(
            &source.name,
            &format!("无法创建分区表 {}", source.name),
            "PostgreSQL 分区表创建需要完整分区定义",
        );
        return;
    }
    if metadata.relkind != "r" {
        plan.block(
            &source.name,
            &format!("无法创建表 {}", source.name),
            &format!("不支持 PostgreSQL relkind `{}`", metadata.relkind),
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
        let native = match column_metadata(metadata, &source.name, name) {
            Ok(native) => native,
            Err(reason) => {
                plan.block(
                    &source.name,
                    &format!("无法创建字段 {}.{}", source.name, name),
                    &reason,
                );
                continue;
            }
        };
        if let Err(reason) =
            validate_column_for_builder(column, native, &source.name, name, true, &[])
        {
            plan.block(
                &source.name,
                &format!("无法创建字段 {}.{}", source.name, name),
                &reason,
            );
            continue;
        }
        definitions.push(CreateTableColumnDef {
            name: name.clone(),
            column_type: column.column_type.clone(),
            nullable: column.nullable,
            default_value: column.default_value.clone(),
            extra: column.extra.clone(),
            comment: column.comment.clone(),
        });
    }
    if !plan.blockers.is_empty() {
        return;
    }

    let primary_keys = match postgres_primary_key_columns(source, metadata) {
        Ok(primary_keys) => primary_keys,
        Err(reason) => {
            plan.block(
                &source.name,
                &format!("无法创建表 {}", source.name),
                &reason,
            );
            return;
        }
    };
    let request = CreateTableRequest {
        table_name: source.name.clone(),
        columns: definitions,
        primary_keys,
        engine: String::new(),
        order_by: None,
        comment: metadata.table_comment.to_string(),
    };
    let (create_sql, after_sqls) =
        match postgres_ddl::build_create_table_sqls(context.target_database, &request) {
            Ok(sqls) => sqls,
            Err(reason) => {
                plan.block(
                    &source.name,
                    &format!("无法创建表 {}", source.name),
                    &reason,
                );
                return;
            }
        };
    let mut sql = vec![create_sql];
    sql.extend(after_sqls);
    plan.operation(
        OperationPhase::CreateTable,
        &source.name,
        DatabaseSyncOperationKind::CreateTable,
        DatabaseSyncRisk::Normal,
        &format!("创建目标端表 {}", source.name),
        sql,
    );
}

fn plan_changed_table(
    plan: &mut PlanFragments,
    context: &TablePlanContext<'_>,
    source: &TableSnapshot,
    target: &TableSnapshot,
) {
    let source_table_metadata = match table_metadata(context.source_metadata, &source.name) {
        Ok(metadata) => metadata,
        Err(reason) => {
            plan.block(&source.name, "无法规划 PostgreSQL 表同步", &reason);
            return;
        }
    };
    let target_table_metadata = match table_metadata(context.target_metadata, &target.name) {
        Ok(metadata) => metadata,
        Err(reason) => {
            plan.block(&source.name, "无法规划 PostgreSQL 表同步", &reason);
            return;
        }
    };
    if source_table_metadata.relkind != target_table_metadata.relkind {
        plan.block(
            &source.name,
            "无法转换 PostgreSQL 表类型",
            "源端与目标端的 PostgreSQL relkind 不一致",
        );
        return;
    }

    let differences = compare_table_columns(source, target);
    let mut blocked_columns = BTreeSet::new();
    for (name, source_column) in &source.columns {
        let Some((_, target_column)) = target
            .columns
            .iter()
            .find(|(target_name, _)| target_name == name)
        else {
            continue;
        };
        if source_column.ordinal_position != target_column.ordinal_position {
            plan.block(
                &source.name,
                &format!("无法调整字段 {}.{} 的物理顺序", source.name, name),
                "PostgreSQL 不支持安全调整字段物理顺序",
            );
            blocked_columns.insert(name.clone());
        }
        let source_native = match column_metadata(source_table_metadata, &source.name, name) {
            Ok(native) => native,
            Err(reason) => {
                plan.block(
                    &source.name,
                    &format!("无法比较字段 {}.{}", source.name, name),
                    &reason,
                );
                blocked_columns.insert(name.clone());
                continue;
            }
        };
        let target_native = match column_metadata(target_table_metadata, &target.name, name) {
            Ok(native) => native,
            Err(reason) => {
                plan.block(
                    &source.name,
                    &format!("无法比较字段 {}.{}", source.name, name),
                    &reason,
                );
                blocked_columns.insert(name.clone());
                continue;
            }
        };
        if let Err(reason) = validate_native_shape(source_native, &source.name, name) {
            plan.block(
                &source.name,
                &format!("无法比较字段 {}.{}", source.name, name),
                &reason,
            );
            blocked_columns.insert(name.clone());
            continue;
        }
        if let Err(reason) = validate_native_shape(target_native, &target.name, name) {
            plan.block(
                &source.name,
                &format!("无法比较字段 {}.{}", target.name, name),
                &reason,
            );
            blocked_columns.insert(name.clone());
            continue;
        }
        if !metadata_matches_snapshot(source_column, source_native)
            || !metadata_matches_snapshot(target_column, target_native)
        {
            plan.block(
                &source.name,
                &format!("无法比较字段 {}.{}", source.name, name),
                "PostgreSQL 默认表达式原生元数据与结构快照不一致",
            );
            blocked_columns.insert(name.clone());
            continue;
        }
        if !native_special_equal(source_native, target_native) {
            plan.block(
                &source.name,
                &format!("无法转换字段 {}.{}", source.name, name),
                "PostgreSQL identity/generated 原生元数据不一致，无法安全转换",
            );
            blocked_columns.insert(name.clone());
        }
    }

    let max_target_position = target
        .columns
        .iter()
        .map(|(_, column)| column.ordinal_position)
        .max()
        .unwrap_or_default();
    let mut add_columns = Vec::new();
    let mut add_risk = DatabaseSyncRisk::Normal;
    let mut alter_columns = Vec::new();
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
                        "PostgreSQL 只能安全追加到目标端现有字段之后",
                    );
                    continue;
                }
                let native =
                    match column_metadata(source_table_metadata, &source.name, &difference.name) {
                        Ok(native) => native,
                        Err(reason) => {
                            plan.block(
                                &source.name,
                                &format!("无法新增字段 {}.{}", source.name, difference.name),
                                &reason,
                            );
                            continue;
                        }
                    };
                if let Err(reason) = validate_column_for_builder(
                    column,
                    native,
                    &source.name,
                    &difference.name,
                    true,
                    &[],
                ) {
                    plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        &reason,
                    );
                    continue;
                }
                let request = AddColumnRequest {
                    name: difference.name.clone(),
                    column_type: column.column_type.clone(),
                    nullable: column.nullable,
                    default_value: column.default_value.clone(),
                    extra: column.extra.clone(),
                    comment: column.comment.clone(),
                    after_column: None,
                };
                add_columns.push((
                    column.ordinal_position,
                    difference.name.clone(),
                    postgres_ddl::build_add_column_sqls(
                        context.target_database,
                        &source.name,
                        &request,
                    ),
                ));
                if add_column_risk(column, source_table_metadata.columns.get(&difference.name))
                    == DatabaseSyncRisk::High
                {
                    add_risk = DatabaseSyncRisk::High;
                }
            }
            SchemaDiffStatus::Changed => {
                if blocked_columns.contains(&difference.name) {
                    continue;
                }
                if difference
                    .changed_fields
                    .iter()
                    .any(|field| field == "extra")
                {
                    plan.block(
                        &source.name,
                        &format!("无法修改字段 {}.{}", source.name, difference.name),
                        "PostgreSQL extra 展示值变化无法脱离原生 identity/generated 元数据安全规划",
                    );
                    continue;
                }
                let requires_alter = difference.changed_fields.iter().any(|field| {
                    field != "ordinal_position" && field != "primary_key" && field != "extra"
                });
                if !requires_alter {
                    continue;
                }
                let Some(source_column) = difference.source.as_ref() else {
                    unreachable!("变化字段必须包含源端定义");
                };
                let Some(target_column) = difference.target.as_ref() else {
                    unreachable!("变化字段必须包含目标端定义");
                };
                if !context.include_drops && !target_column.nullable && source_column.nullable {
                    plan.block(
                        &source.name,
                        &format!("无法修改字段 {}.{}", source.name, difference.name),
                        "字段改为可空需要执行 DROP NOT NULL，但未开启包含删除操作",
                    );
                    continue;
                }
                let source_has_default = source_column
                    .default_value
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty());
                let target_has_default = target_column
                    .default_value
                    .as_deref()
                    .is_some_and(|value| !value.trim().is_empty());
                if !context.include_drops && target_has_default && !source_has_default {
                    plan.block(
                        &source.name,
                        &format!("无法修改字段 {}.{}", source.name, difference.name),
                        "删除字段默认值需要执行 DROP DEFAULT，但未开启包含删除操作",
                    );
                    continue;
                }
                let source_native =
                    match column_metadata(source_table_metadata, &source.name, &difference.name) {
                        Ok(native) => native,
                        Err(reason) => {
                            plan.block(
                                &source.name,
                                &format!("无法修改字段 {}.{}", source.name, difference.name),
                                &reason,
                            );
                            continue;
                        }
                    };
                if let Err(reason) = validate_column_for_builder(
                    source_column,
                    source_native,
                    &source.name,
                    &difference.name,
                    false,
                    &difference.changed_fields,
                ) {
                    plan.block(
                        &source.name,
                        &format!("无法修改字段 {}.{}", source.name, difference.name),
                        &reason,
                    );
                    continue;
                }
                let current = ColumnInfo {
                    name: difference.name.clone(),
                    column_type: target_column.column_type.clone(),
                    nullable: target_column.nullable,
                    key: if target_column.primary_key {
                        "PRI".to_string()
                    } else {
                        String::new()
                    },
                    default_value: target_column.default_value.clone(),
                    extra: target_column.extra.clone(),
                    comment: target_column.comment.clone(),
                };
                let request = AlterColumnRequest {
                    old_name: difference.name.clone(),
                    new_name: difference.name.clone(),
                    column_type: source_column.column_type.clone(),
                    nullable: source_column.nullable,
                    default_value: source_column.default_value.clone(),
                    extra: source_column.extra.clone(),
                    comment: source_column.comment.clone(),
                    is_primary: None,
                    column_placement: None,
                };
                let sql = postgres_ddl::build_alter_column_sqls(
                    context.target_database,
                    &source.name,
                    &current,
                    &request,
                );
                if !sql.is_empty() {
                    alter_columns.push((source_column.ordinal_position, difference.name, sql));
                }
            }
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
    alter_columns.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    drop_columns.sort();
    let add_count = add_columns.len();
    let add_sql = add_columns
        .into_iter()
        .flat_map(|(_, _, sql)| sql)
        .collect::<Vec<_>>();
    let alter_count = alter_columns.len();
    let mut alter_sql = alter_columns
        .into_iter()
        .flat_map(|(_, _, sql)| sql)
        .collect::<Vec<_>>();

    let source_primary_keys = match postgres_primary_key_columns(source, source_table_metadata) {
        Ok(columns) => columns,
        Err(reason) => {
            plan.block(&source.name, "无法规划源端主键", &reason);
            return;
        }
    };
    let target_primary_keys = match postgres_primary_key_columns(target, target_table_metadata) {
        Ok(columns) => columns,
        Err(reason) => {
            plan.block(&source.name, "无法规划目标端主键", &reason);
            return;
        }
    };
    if target_primary_keys.is_empty() != target_table_metadata.primary_key_constraint.is_none() {
        plan.block(
            &source.name,
            "无法规划目标端主键",
            "目标端主键约束名与字段快照不一致",
        );
        return;
    }

    let primary_key_changed = source_primary_keys != target_primary_keys;
    if primary_key_changed && !target_primary_keys.is_empty() && !context.include_drops {
        plan.block(
            &source.name,
            &format!("无法替换表 {} 的主键", source.name),
            "目标端已有主键，替换主键需要先删除旧约束，但未开启包含删除操作",
        );
        return;
    }

    if !add_sql.is_empty() {
        plan.operation(
            OperationPhase::AddColumn,
            &source.name,
            DatabaseSyncOperationKind::AddColumn,
            add_risk,
            &format!("新增表 {} 的 {} 个字段", source.name, add_count),
            add_sql,
        );
    }
    if primary_key_changed {
        let mut primary_key_sql = postgres_ddl::build_primary_key_change_sqls(
            context.target_database,
            &source.name,
            &target_primary_keys,
            target_table_metadata.primary_key_constraint,
            &source_primary_keys,
        );
        let mut sql = Vec::new();
        if !target_primary_keys.is_empty() {
            sql.push(primary_key_sql.remove(0));
        }
        sql.append(&mut alter_sql);
        sql.append(&mut primary_key_sql);
        plan.operation(
            OperationPhase::AlterColumn,
            &source.name,
            DatabaseSyncOperationKind::ReplacePrimaryKey,
            DatabaseSyncRisk::High,
            &format!("替换表 {} 的主键并同步相关字段", source.name),
            sql,
        );
    } else if !alter_sql.is_empty() {
        plan.operation(
            OperationPhase::AlterColumn,
            &source.name,
            DatabaseSyncOperationKind::AlterColumn,
            DatabaseSyncRisk::High,
            &format!("修改表 {} 的 {} 个字段", source.name, alter_count),
            alter_sql,
        );
    }

    for column_name in drop_columns {
        plan.operation(
            OperationPhase::DropColumn,
            &source.name,
            DatabaseSyncOperationKind::DropColumn,
            DatabaseSyncRisk::Destructive,
            &format!("删除目标端独有字段 {}.{}", source.name, column_name),
            vec![postgres_ddl::build_drop_column_sql(
                context.target_database,
                &source.name,
                &column_name,
            )],
        );
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::db::schema_compare::TableSnapshot;
    use crate::models::types::{ColumnSnapshot, DatabaseSyncOperationKind};

    use super::*;
    use crate::db::schema_sync::{ColumnSyncMetadata, TablePlanContext, TableSyncMetadata};

    fn test_table(
        name: &str,
        ordinal_position: u32,
        column_type: &str,
        extra: &str,
    ) -> TableSnapshot {
        TableSnapshot {
            name: name.to_string(),
            columns: vec![(
                "value".to_string(),
                ColumnSnapshot {
                    ordinal_position,
                    column_type: column_type.to_string(),
                    nullable: false,
                    default_value: None,
                    primary_key: false,
                    extra: extra.to_string(),
                    comment: String::new(),
                },
            )],
        }
    }

    fn column(
        ordinal_position: u32,
        column_type: &str,
        nullable: bool,
        default_value: Option<&str>,
        primary_key: bool,
        extra: &str,
        comment: &str,
    ) -> ColumnSnapshot {
        ColumnSnapshot {
            ordinal_position,
            column_type: column_type.to_string(),
            nullable,
            default_value: default_value.map(str::to_string),
            primary_key,
            extra: extra.to_string(),
            comment: comment.to_string(),
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

    fn native_column(
        identity_generation: &str,
        generated_kind: &str,
        generation_expression: Option<&str>,
        default_expression: Option<&str>,
        is_user_defined: bool,
        primary_key_ordinal: Option<u32>,
    ) -> ColumnSyncMetadata {
        ColumnSyncMetadata::Postgres {
            identity_generation: identity_generation.to_string(),
            generated_kind: generated_kind.to_string(),
            generation_expression: generation_expression.map(str::to_string),
            default_expression: default_expression.map(str::to_string),
            is_user_defined,
            type_schema: if is_user_defined {
                "app_types".to_string()
            } else {
                "pg_catalog".to_string()
            },
            type_name: if is_user_defined {
                "email_address".to_string()
            } else {
                String::new()
            },
            primary_key_ordinal,
        }
    }

    fn metadata(
        relkind: &str,
        table_comment: &str,
        primary_key_constraint: Option<&str>,
        columns: Vec<(&str, ColumnSyncMetadata)>,
    ) -> TableSyncMetadata {
        TableSyncMetadata::Postgres {
            relkind: relkind.to_string(),
            table_comment: table_comment.to_string(),
            primary_key_constraint: primary_key_constraint.map(str::to_string),
            columns: columns
                .into_iter()
                .map(|(name, metadata)| (name.to_string(), metadata))
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
    fn metadata_query_loads_table_kind_comment_and_primary_constraint_once() {
        let sql = metadata_sql();
        assert!(sql.contains("pg_catalog.pg_class"));
        assert!(sql.contains("pg_catalog.pg_constraint"));
        assert!(sql.contains("information_schema.columns"));
        assert!(sql.contains("generation_expression"));
        assert!(sql.contains("column_default"));
        assert!(sql.contains("is_user_defined"));
        assert!(sql.contains("WITH ORDINALITY"));
        assert!(sql.contains("ns.nspname = $1"));
        assert!(sql.contains("cls.relkind IN ('r', 'p')"));
        assert!(!sql.contains("cls.relname = $2"));
    }

    #[test]
    fn ordinal_change_is_blocked_without_rebuilding_table() {
        let source = test_table("users", 2, "text", "");
        let target = test_table("users", 1, "text", "");
        let metadata = TableSyncMetadata::Postgres {
            relkind: "r".to_string(),
            table_comment: String::new(),
            primary_key_constraint: None,
            columns: BTreeMap::new(),
        };
        let plan = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&metadata),
            target_metadata: Some(&metadata),
            include_drops: false,
        });
        assert!(plan.operations.is_empty());
        assert_eq!(
            plan.blockers[0].reason,
            "PostgreSQL 不支持安全调整字段物理顺序"
        );
    }

    #[test]
    fn aggregates_native_metadata_by_table_without_follow_up_queries() {
        let metadata = aggregate_metadata_rows(vec![
            MetadataRow {
                table_name: "users".to_string(),
                relkind: "r".to_string(),
                table_comment: "用户".to_string(),
                primary_key_constraint: Some("users_pkey".to_string()),
                column_name: "tenant_id".to_string(),
                identity_generation: String::new(),
                generated_kind: "NEVER".to_string(),
                generation_expression: None,
                default_expression: Some("42".to_string()),
                is_user_defined: false,
                type_schema: "pg_catalog".to_string(),
                type_name: "int8".to_string(),
                primary_key_ordinal: Some(1),
            },
            MetadataRow {
                table_name: "users".to_string(),
                relkind: "r".to_string(),
                table_comment: "用户".to_string(),
                primary_key_constraint: Some("users_pkey".to_string()),
                column_name: "id".to_string(),
                identity_generation: "ALWAYS".to_string(),
                generated_kind: "NEVER".to_string(),
                generation_expression: None,
                default_expression: None,
                is_user_defined: false,
                type_schema: "pg_catalog".to_string(),
                type_name: "int8".to_string(),
                primary_key_ordinal: Some(2),
            },
        ]);

        let TableSyncMetadata::Postgres {
            relkind,
            table_comment,
            primary_key_constraint,
            columns,
        } = &metadata["users"]
        else {
            panic!("应聚合为 PostgreSQL 元数据");
        };
        assert_eq!(relkind, "r");
        assert_eq!(table_comment, "用户");
        assert_eq!(primary_key_constraint.as_deref(), Some("users_pkey"));
        assert!(matches!(
            columns.get("tenant_id"),
            Some(ColumnSyncMetadata::Postgres {
                default_expression: Some(value),
                primary_key_ordinal: Some(1),
                ..
            }) if value == "42"
        ));
        assert!(matches!(
            columns.get("id"),
            Some(ColumnSyncMetadata::Postgres {
                identity_generation,
                primary_key_ordinal: Some(2),
                ..
            }) if identity_generation == "ALWAYS"
        ));
    }

    #[test]
    fn creates_qualified_table_with_native_primary_key_order_and_comments() {
        let source = table(
            "us\"ers",
            vec![
                ("id", column(1, "bigint", false, None, true, "", "主键")),
                (
                    "tenant_id",
                    column(2, "bigint", false, Some("42"), true, "", ""),
                ),
            ],
        );
        let source_metadata = metadata(
            "r",
            "用户's",
            Some("users_pkey"),
            vec![
                ("id", native_column("", "NEVER", None, None, false, Some(2))),
                (
                    "tenant_id",
                    native_column("", "NEVER", None, Some("42"), false, Some(1)),
                ),
            ],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "pub\"lic",
            source: Some(&source),
            target: None,
            source_metadata: Some(&source_metadata),
            target_metadata: None,
            include_drops: false,
        });

        assert!(plan.blockers.is_empty());
        assert_eq!(plan.operations.len(), 1);
        assert_eq!(
            plan.operations[0].kind,
            DatabaseSyncOperationKind::CreateTable
        );
        assert_eq!(
            plan.operations[0].sql[0],
            "CREATE TABLE \"pub\"\"lic\".\"us\"\"ers\" (\n  \"id\" bigint NOT NULL,\n  \"tenant_id\" bigint NOT NULL DEFAULT 42,\n  PRIMARY KEY (\"tenant_id\", \"id\")\n)"
        );
        assert_eq!(
            plan.operations[0].sql[1],
            "COMMENT ON COLUMN \"pub\"\"lic\".\"us\"\"ers\".\"id\" IS '主键'"
        );
        assert_eq!(
            plan.operations[0].sql[2],
            "COMMENT ON TABLE \"pub\"\"lic\".\"us\"\"ers\" IS '用户''s'"
        );
    }

    #[test]
    fn partitioned_table_creation_is_blocked() {
        let source = test_table("events", 1, "bigint", "");
        let source_metadata = metadata("p", "", None, Vec::new());
        let plan = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&source),
            target: None,
            source_metadata: Some(&source_metadata),
            target_metadata: None,
            include_drops: false,
        });

        assert!(plan.operations.is_empty());
        assert_eq!(
            plan.blockers[0].reason,
            "PostgreSQL 分区表创建需要完整分区定义"
        );
    }

    #[test]
    fn appends_source_only_columns_in_source_ordinal_order() {
        let source = table(
            "users",
            vec![
                ("id", column(1, "bigint", false, None, false, "", "")),
                ("z_first", column(2, "text", false, None, false, "", "")),
                ("a_second", column(3, "text", true, None, false, "", "")),
            ],
        );
        let target = table(
            "users",
            vec![("id", column(1, "bigint", false, None, false, "", ""))],
        );
        let source_metadata = metadata(
            "r",
            "",
            None,
            vec![
                ("id", native_column("", "NEVER", None, None, false, None)),
                (
                    "z_first",
                    native_column("", "NEVER", None, None, false, None),
                ),
                (
                    "a_second",
                    native_column("", "NEVER", None, None, false, None),
                ),
            ],
        );
        let target_metadata = metadata(
            "r",
            "",
            None,
            vec![("id", native_column("", "NEVER", None, None, false, None))],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });

        assert!(plan.blockers.is_empty());
        assert_eq!(plan.operations.len(), 1);
        assert!(plan.operations[0].sql[0].contains("ADD COLUMN \"z_first\""));
        assert!(plan.operations[0].sql[1].contains("ADD COLUMN \"a_second\""));
        assert_eq!(plan.operations[0].risk, DatabaseSyncRisk::High);
    }

    #[test]
    fn inserting_source_only_column_before_existing_target_column_is_blocked() {
        let source = table(
            "users",
            vec![
                ("id", column(1, "bigint", false, None, false, "", "")),
                ("middle", column(2, "text", true, None, false, "", "")),
                ("name", column(3, "text", true, None, false, "", "")),
            ],
        );
        let target = table(
            "users",
            vec![
                ("id", column(1, "bigint", false, None, false, "", "")),
                ("name", column(2, "text", true, None, false, "", "")),
            ],
        );
        let source_metadata = metadata(
            "r",
            "",
            None,
            source
                .columns
                .iter()
                .map(|(name, _)| {
                    (
                        name.as_str(),
                        native_column("", "NEVER", None, None, false, None),
                    )
                })
                .collect(),
        );
        let target_metadata = metadata(
            "r",
            "",
            None,
            target
                .columns
                .iter()
                .map(|(name, _)| {
                    (
                        name.as_str(),
                        native_column("", "NEVER", None, None, false, None),
                    )
                })
                .collect(),
        );
        let plan = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });

        assert!(plan.operations.is_empty());
        assert!(plan
            .blockers
            .iter()
            .any(|blocker| blocker.reason.contains("只能安全追加到目标端现有字段之后")));
    }

    #[test]
    fn alters_ordinary_column_with_qualified_builder_sql() {
        let source = table(
            "users",
            vec![(
                "age",
                column(1, "bigint", false, Some("42"), false, "", "年龄"),
            )],
        );
        let target = table(
            "users",
            vec![("age", column(1, "integer", true, None, false, "", "旧"))],
        );
        let source_metadata = metadata(
            "r",
            "",
            None,
            vec![(
                "age",
                native_column("", "NEVER", None, Some("42"), false, None),
            )],
        );
        let target_metadata = metadata(
            "r",
            "",
            None,
            vec![("age", native_column("", "NEVER", None, None, false, None))],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "pub\"lic",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });

        let sql = all_sql(&plan);
        assert!(plan.blockers.is_empty());
        assert!(
            sql.contains(&"ALTER TABLE \"pub\"\"lic\".\"users\" ALTER COLUMN \"age\" TYPE bigint")
        );
        assert!(
            sql.contains(&"ALTER TABLE \"pub\"\"lic\".\"users\" ALTER COLUMN \"age\" SET NOT NULL")
        );
        assert!(sql
            .contains(&"ALTER TABLE \"pub\"\"lic\".\"users\" ALTER COLUMN \"age\" SET DEFAULT 42"));
        assert!(sql.contains(&"COMMENT ON COLUMN \"pub\"\"lic\".\"users\".\"age\" IS '年龄'"));
    }

    #[test]
    fn replaces_primary_key_in_native_order_and_honors_drop_guard() {
        let source = table(
            "users",
            vec![
                ("id", column(1, "bigint", false, None, true, "", "")),
                ("tenant_id", column(2, "bigint", false, None, true, "", "")),
            ],
        );
        let target = table(
            "users",
            vec![
                ("id", column(1, "bigint", false, None, true, "", "")),
                ("tenant_id", column(2, "bigint", false, None, false, "", "")),
            ],
        );
        let source_metadata = metadata(
            "r",
            "",
            Some("source_pkey"),
            vec![
                ("id", native_column("", "NEVER", None, None, false, Some(2))),
                (
                    "tenant_id",
                    native_column("", "NEVER", None, None, false, Some(1)),
                ),
            ],
        );
        let target_metadata = metadata(
            "r",
            "",
            Some("PK \"odd\""),
            vec![
                ("id", native_column("", "NEVER", None, None, false, Some(1))),
                (
                    "tenant_id",
                    native_column("", "NEVER", None, None, false, None),
                ),
            ],
        );

        let guarded = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });
        assert!(all_sql(&guarded)
            .iter()
            .all(|sql| !sql.to_uppercase().contains("DROP")));
        assert!(guarded
            .blockers
            .iter()
            .any(|blocker| blocker.reason.contains("未开启包含删除操作")));

        let allowed = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: true,
        });
        assert_eq!(allowed.operations.len(), 1);
        assert_eq!(
            allowed.operations[0].kind,
            DatabaseSyncOperationKind::ReplacePrimaryKey
        );
        assert_eq!(
            allowed.operations[0].sql,
            vec![
                "ALTER TABLE \"public\".\"users\" DROP CONSTRAINT \"PK \"\"odd\"\"\"".to_string(),
                "ALTER TABLE \"public\".\"users\" ADD PRIMARY KEY (\"tenant_id\", \"id\")"
                    .to_string(),
            ]
        );
    }

    #[test]
    fn target_only_tables_and_columns_obey_drop_guard_and_escape_identifiers() {
        let target_only = test_table("old\"table", 1, "text", "");
        let guarded_table = plan_table(TablePlanContext {
            target_database: "pub\"lic",
            source: None,
            target: Some(&target_only),
            source_metadata: None,
            target_metadata: None,
            include_drops: false,
        });
        assert!(guarded_table.operations.is_empty());
        assert_eq!(guarded_table.skipped_items.len(), 1);
        let allowed_table = plan_table(TablePlanContext {
            target_database: "pub\"lic",
            source: None,
            target: Some(&target_only),
            source_metadata: None,
            target_metadata: None,
            include_drops: true,
        });
        assert_eq!(
            all_sql(&allowed_table),
            vec!["DROP TABLE \"pub\"\"lic\".\"old\"\"table\""]
        );

        let source = table(
            "users",
            vec![("id", column(1, "bigint", false, None, false, "", ""))],
        );
        let target = table(
            "users",
            vec![
                ("id", column(1, "bigint", false, None, false, "", "")),
                ("old\"col", column(2, "text", true, None, false, "", "")),
            ],
        );
        let ordinary = native_column("", "NEVER", None, None, false, None);
        let source_metadata = metadata("r", "", None, vec![("id", ordinary.clone())]);
        let target_metadata = metadata(
            "r",
            "",
            None,
            vec![("id", ordinary.clone()), ("old\"col", ordinary)],
        );
        let guarded_column = plan_table(TablePlanContext {
            target_database: "pub\"lic",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });
        assert!(all_sql(&guarded_column)
            .iter()
            .all(|sql| !sql.to_uppercase().contains("DROP")));
        assert_eq!(guarded_column.skipped_items.len(), 1);
        let allowed_column = plan_table(TablePlanContext {
            target_database: "pub\"lic",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: true,
        });
        assert_eq!(
            all_sql(&allowed_column),
            vec!["ALTER TABLE \"pub\"\"lic\".\"users\" DROP COLUMN \"old\"\"col\""]
        );
    }

    #[test]
    fn identity_or_generated_native_metadata_change_is_blocked() {
        let identity = test_table("users", 1, "bigint", "identity");
        let source_identity = metadata(
            "r",
            "",
            None,
            vec![(
                "value",
                native_column("ALWAYS", "NEVER", None, None, false, None),
            )],
        );
        let target_identity = metadata(
            "r",
            "",
            None,
            vec![(
                "value",
                native_column("BY DEFAULT", "NEVER", None, None, false, None),
            )],
        );
        let identity_plan = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&identity),
            target: Some(&identity),
            source_metadata: Some(&source_identity),
            target_metadata: Some(&target_identity),
            include_drops: false,
        });
        assert!(identity_plan.operations.is_empty());
        assert!(identity_plan.blockers.iter().any(|blocker| blocker
            .reason
            .contains("identity/generated 原生元数据不一致")));

        let generated = test_table("totals", 1, "bigint", "always generated");
        let source_generated = metadata(
            "r",
            "",
            None,
            vec![(
                "value",
                native_column("", "ALWAYS", Some("price * qty"), None, false, None),
            )],
        );
        let target_generated = metadata(
            "r",
            "",
            None,
            vec![(
                "value",
                native_column("", "ALWAYS", Some("price + qty"), None, false, None),
            )],
        );
        let generated_plan = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&generated),
            target: Some(&generated),
            source_metadata: Some(&source_generated),
            target_metadata: Some(&target_generated),
            include_drops: false,
        });
        assert!(generated_plan.operations.is_empty());
        assert!(generated_plan.blockers.iter().any(|blocker| blocker
            .reason
            .contains("identity/generated 原生元数据不一致")));
    }

    #[test]
    fn creation_blocks_identity_generated_user_defined_and_unsafe_defaults() {
        let cases = [
            (
                "identity_table",
                column(1, "bigint", false, None, false, "identity", ""),
                native_column("ALWAYS", "NEVER", None, None, false, None),
                "identity",
            ),
            (
                "generated_table",
                column(1, "bigint", false, None, false, "always generated", ""),
                native_column("", "ALWAYS", Some("price * qty"), None, false, None),
                "generated",
            ),
            (
                "custom_table",
                column(1, "app_types.email_address", false, None, false, "", ""),
                native_column("", "NEVER", None, None, true, None),
                "用户定义类型",
            ),
            (
                "default_table",
                column(
                    1,
                    "bigint",
                    false,
                    Some("nextval('seq'::regclass)"),
                    false,
                    "",
                    "",
                ),
                native_column(
                    "",
                    "NEVER",
                    None,
                    Some("nextval('seq'::regclass)"),
                    false,
                    None,
                ),
                "默认表达式",
            ),
        ];

        for (table_name, details, native, expected_reason) in cases {
            let source = table(table_name, vec![("value", details)]);
            let source_metadata = metadata("r", "", None, vec![("value", native)]);
            let plan = plan_table(TablePlanContext {
                target_database: "public",
                source: Some(&source),
                target: None,
                source_metadata: Some(&source_metadata),
                target_metadata: None,
                include_drops: false,
            });
            assert!(plan.operations.is_empty(), "{table_name} 不应产生 DDL");
            assert!(
                plan.blockers
                    .iter()
                    .any(|blocker| blocker.reason.contains(expected_reason)),
                "{table_name} 应产生包含 {expected_reason} 的阻塞项"
            );
        }
    }

    #[test]
    fn adding_or_altering_special_columns_is_blocked() {
        let target = table(
            "users",
            vec![("id", column(1, "bigint", false, None, false, "", ""))],
        );
        let source = table(
            "users",
            vec![
                ("id", column(1, "bigint", false, None, false, "", "")),
                (
                    "email",
                    column(2, "app_types.email_address", false, None, false, "", ""),
                ),
            ],
        );
        let source_metadata = metadata(
            "r",
            "",
            None,
            vec![
                ("id", native_column("", "NEVER", None, None, false, None)),
                ("email", native_column("", "NEVER", None, None, true, None)),
            ],
        );
        let target_metadata = metadata(
            "r",
            "",
            None,
            vec![("id", native_column("", "NEVER", None, None, false, None))],
        );
        let add_plan = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });
        assert!(add_plan.operations.is_empty());
        assert!(add_plan
            .blockers
            .iter()
            .any(|blocker| blocker.reason.contains("用户定义类型")));

        let source_default = table(
            "settings",
            vec![(
                "value",
                column(1, "text", false, Some("lower('X')"), false, "", ""),
            )],
        );
        let target_default = table(
            "settings",
            vec![("value", column(1, "text", false, None, false, "", ""))],
        );
        let source_default_metadata = metadata(
            "r",
            "",
            None,
            vec![(
                "value",
                native_column("", "NEVER", None, Some("lower('X')"), false, None),
            )],
        );
        let target_default_metadata = metadata(
            "r",
            "",
            None,
            vec![("value", native_column("", "NEVER", None, None, false, None))],
        );
        let alter_plan = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&source_default),
            target: Some(&target_default),
            source_metadata: Some(&source_default_metadata),
            target_metadata: Some(&target_default_metadata),
            include_drops: false,
        });
        assert!(alter_plan.operations.is_empty());
        assert!(alter_plan
            .blockers
            .iter()
            .any(|blocker| blocker.reason.contains("默认表达式")));
    }

    #[test]
    fn dropping_not_null_requires_drop_opt_in() {
        let source = table(
            "users",
            vec![("nickname", column(1, "text", true, None, false, "", ""))],
        );
        let target = table(
            "users",
            vec![("nickname", column(1, "text", false, None, false, "", ""))],
        );
        let native = native_column("", "NEVER", None, None, false, None);
        let source_metadata = metadata("r", "", None, vec![("nickname", native.clone())]);
        let target_metadata = metadata("r", "", None, vec![("nickname", native)]);

        let guarded = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });
        assert!(all_sql(&guarded)
            .iter()
            .all(|sql| !sql.to_uppercase().contains("DROP")));
        assert!(guarded
            .blockers
            .iter()
            .any(|blocker| blocker.reason.contains("DROP NOT NULL")));

        let allowed = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: true,
        });
        assert!(all_sql(&allowed)
            .iter()
            .any(|sql| sql.contains("DROP NOT NULL")));
    }

    #[test]
    fn dropping_default_requires_drop_opt_in() {
        let source = table(
            "settings",
            vec![("retries", column(1, "integer", false, None, false, "", ""))],
        );
        let target = table(
            "settings",
            vec![(
                "retries",
                column(1, "integer", false, Some("3"), false, "", ""),
            )],
        );
        let source_metadata = metadata(
            "r",
            "",
            None,
            vec![(
                "retries",
                native_column("", "NEVER", None, None, false, None),
            )],
        );
        let target_metadata = metadata(
            "r",
            "",
            None,
            vec![(
                "retries",
                native_column("", "NEVER", None, Some("3"), false, None),
            )],
        );

        let guarded = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });
        assert!(all_sql(&guarded)
            .iter()
            .all(|sql| !sql.to_uppercase().contains("DROP")));
        assert!(guarded
            .blockers
            .iter()
            .any(|blocker| blocker.reason.contains("DROP DEFAULT")));

        let allowed = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: true,
        });
        assert!(all_sql(&allowed)
            .iter()
            .any(|sql| sql.contains("DROP DEFAULT")));
    }

    #[test]
    fn stale_primary_constraint_metadata_never_leaks_drop_sql() {
        let source = table(
            "users",
            vec![("id", column(1, "bigint", false, None, true, "", ""))],
        );
        let target = table(
            "users",
            vec![("id", column(1, "bigint", false, None, false, "", ""))],
        );
        let source_metadata = metadata(
            "r",
            "",
            Some("source_pkey"),
            vec![("id", native_column("", "NEVER", None, None, false, Some(1)))],
        );
        let stale_target_metadata = metadata(
            "r",
            "",
            Some("stale_pkey"),
            vec![("id", native_column("", "NEVER", None, None, false, None))],
        );

        let plan = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&stale_target_metadata),
            include_drops: false,
        });

        assert!(all_sql(&plan)
            .iter()
            .all(|sql| !sql.to_uppercase().contains("DROP")));
        assert!(plan
            .blockers
            .iter()
            .any(|blocker| blocker.reason.contains("主键约束名与字段快照不一致")));
    }
}
