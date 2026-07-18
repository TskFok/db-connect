use std::collections::{BTreeMap, BTreeSet};

use tiberius::Row;

use crate::db::schema_compare::{compare_table_columns, TableSnapshot};
use crate::db::sql_utils::{sqlserver_id, sqlserver_str};
use crate::db::sqlserver::{
    build_sqlserver_column_extra, normalize_sqlserver_error, SqlServerPool,
};
use crate::db::sqlserver_ddl;
use crate::models::types::{
    AddColumnRequest, AlterColumnRequest, ColumnInfo, ColumnSnapshot, CreateTableColumnDef,
    CreateTableRequest, DatabaseSyncOperationKind, DatabaseSyncRisk, SchemaDiffStatus,
};

use super::{
    add_column_risk, ColumnSyncMetadata, OperationPhase, PlanFragments, TablePlanContext,
    TableSyncMetadata,
};

pub(crate) fn metadata_sql(schema: &str) -> String {
    format!(
        "SELECT tables.name AS table_name, \
                COALESCE(CONVERT(nvarchar(4000), table_properties.value), N'') AS table_comment, \
                key_constraints.name AS primary_key_constraint, \
                CAST(tables.temporal_type AS int) AS temporal_type, \
                tables.is_memory_optimized, tables.is_node, tables.is_edge, tables.is_filetable, \
                columns.name AS column_name, columns.is_identity, columns.is_hidden, \
                CAST(columns.generated_always_type AS int) AS generated_always_type, \
                columns.is_sparse, columns.is_column_set, columns.is_filestream, \
                columns.is_rowguidcol, columns.is_masked, \
                CAST(columns.encryption_type AS int) AS encryption_type, \
                CONVERT(nvarchar(100), identity_columns.seed_value) AS identity_seed, \
                CONVERT(nvarchar(100), identity_columns.increment_value) AS identity_increment, \
                computed_columns.definition AS computed_definition, \
                default_constraints.definition AS default_expression, \
                default_constraints.name AS default_constraint_name, \
                CAST(default_constraints.is_system_named AS bit) AS default_constraint_is_system_named, \
                types.is_user_defined, TYPE_SCHEMA_NAME(types.schema_id) AS type_schema, \
                types.name AS type_name, CAST(primary_columns.key_ordinal AS int) AS primary_key_ordinal \
         FROM sys.tables tables \
         JOIN sys.schemas schemas ON schemas.schema_id = tables.schema_id \
         JOIN sys.columns columns ON columns.object_id = tables.object_id \
         JOIN sys.types types ON types.user_type_id = columns.user_type_id \
         LEFT JOIN sys.identity_columns identity_columns \
           ON identity_columns.object_id = columns.object_id \
          AND identity_columns.column_id = columns.column_id \
         LEFT JOIN sys.computed_columns computed_columns \
           ON computed_columns.object_id = columns.object_id \
          AND computed_columns.column_id = columns.column_id \
         LEFT JOIN sys.default_constraints default_constraints \
           ON default_constraints.object_id = columns.default_object_id \
         LEFT JOIN sys.key_constraints key_constraints \
           ON key_constraints.parent_object_id = tables.object_id \
          AND key_constraints.type = 'PK' \
         LEFT JOIN sys.index_columns primary_columns \
           ON primary_columns.object_id = key_constraints.parent_object_id \
          AND primary_columns.index_id = key_constraints.unique_index_id \
          AND primary_columns.column_id = columns.column_id \
         LEFT JOIN sys.extended_properties table_properties \
           ON table_properties.class = 1 \
          AND table_properties.major_id = tables.object_id \
          AND table_properties.minor_id = 0 \
          AND table_properties.name = N'MS_Description' \
         WHERE schemas.name = N{} AND tables.is_ms_shipped = 0 \
         ORDER BY tables.name, columns.column_id, columns.name",
        sqlserver_str(schema)
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MetadataRow {
    table_name: String,
    table_comment: String,
    primary_key_constraint: Option<String>,
    temporal_type: i32,
    is_memory_optimized: bool,
    is_node: bool,
    is_edge: bool,
    is_filetable: bool,
    column_name: String,
    is_identity: bool,
    identity_seed: Option<String>,
    identity_increment: Option<String>,
    computed_definition: Option<String>,
    default_expression: Option<String>,
    default_constraint_name: Option<String>,
    default_constraint_is_system_named: Option<bool>,
    is_user_defined: bool,
    type_schema: String,
    type_name: String,
    primary_key_ordinal: Option<u32>,
    is_hidden: bool,
    generated_always_type: i32,
    is_sparse: bool,
    is_column_set: bool,
    is_filestream: bool,
    is_rowguidcol: bool,
    is_masked: bool,
    encryption_type: Option<i32>,
}

fn aggregate_metadata_rows(rows: Vec<MetadataRow>) -> BTreeMap<String, TableSyncMetadata> {
    let mut metadata = BTreeMap::new();
    for row in rows {
        let entry =
            metadata
                .entry(row.table_name)
                .or_insert_with(|| TableSyncMetadata::SqlServer {
                    table_comment: row.table_comment,
                    primary_key_constraint: row.primary_key_constraint,
                    temporal_type: row.temporal_type,
                    is_memory_optimized: row.is_memory_optimized,
                    is_node: row.is_node,
                    is_edge: row.is_edge,
                    is_filetable: row.is_filetable,
                    columns: BTreeMap::new(),
                });
        let TableSyncMetadata::SqlServer { columns, .. } = entry else {
            unreachable!("SQL Server 元数据映射只能创建 SqlServer 变体");
        };
        columns.insert(
            row.column_name,
            ColumnSyncMetadata::SqlServer {
                is_identity: row.is_identity,
                identity_seed: row.identity_seed,
                identity_increment: row.identity_increment,
                computed_definition: row.computed_definition,
                default_expression: row.default_expression,
                default_constraint_name: row.default_constraint_name,
                default_constraint_is_system_named: row.default_constraint_is_system_named,
                is_user_defined: row.is_user_defined,
                type_schema: row.type_schema,
                type_name: row.type_name,
                primary_key_ordinal: row.primary_key_ordinal,
                is_hidden: row.is_hidden,
                generated_always_type: row.generated_always_type,
                is_sparse: row.is_sparse,
                is_column_set: row.is_column_set,
                is_filestream: row.is_filestream,
                is_rowguidcol: row.is_rowguidcol,
                is_masked: row.is_masked,
                encryption_type: row.encryption_type,
            },
        );
    }
    metadata
}

#[allow(dead_code, reason = "将在后续统一同步元数据分发中调用")]
pub(crate) async fn load_metadata(
    pool: &SqlServerPool,
    schema: &str,
) -> Result<BTreeMap<String, TableSyncMetadata>, String> {
    let mut client = pool
        .get()
        .await
        .map_err(|error| normalize_sqlserver_error("获取连接失败", error.to_string()))?;
    let rows = client
        .simple_query(metadata_sql(schema))
        .await
        .map_err(|error| {
            normalize_sqlserver_error("查询 SQL Server 同步表元数据失败", error.to_string())
        })?
        .into_first_result()
        .await
        .map_err(|error| {
            normalize_sqlserver_error("读取 SQL Server 同步表元数据失败", error.to_string())
        })?;
    let mapped = rows
        .iter()
        .map(|row| MetadataRow {
            table_name: row_string(row, "table_name"),
            table_comment: row_string(row, "table_comment"),
            primary_key_constraint: row_optional_string(row, "primary_key_constraint"),
            temporal_type: row.get::<i32, _>("temporal_type").unwrap_or_default(),
            is_memory_optimized: row.get::<bool, _>("is_memory_optimized").unwrap_or(false),
            is_node: row.get::<bool, _>("is_node").unwrap_or(false),
            is_edge: row.get::<bool, _>("is_edge").unwrap_or(false),
            is_filetable: row.get::<bool, _>("is_filetable").unwrap_or(false),
            column_name: row_string(row, "column_name"),
            is_identity: row.get::<bool, _>("is_identity").unwrap_or(false),
            identity_seed: row_optional_string(row, "identity_seed"),
            identity_increment: row_optional_string(row, "identity_increment"),
            computed_definition: row_optional_string(row, "computed_definition"),
            default_expression: row_optional_string(row, "default_expression"),
            default_constraint_name: row_optional_string(row, "default_constraint_name"),
            default_constraint_is_system_named: row
                .get::<bool, _>("default_constraint_is_system_named"),
            is_user_defined: row.get::<bool, _>("is_user_defined").unwrap_or(false),
            type_schema: row_string(row, "type_schema"),
            type_name: row_string(row, "type_name"),
            primary_key_ordinal: row
                .get::<i32, _>("primary_key_ordinal")
                .and_then(|value| u32::try_from(value).ok()),
            is_hidden: row.get::<bool, _>("is_hidden").unwrap_or(false),
            generated_always_type: row
                .get::<i32, _>("generated_always_type")
                .unwrap_or_default(),
            is_sparse: row.get::<bool, _>("is_sparse").unwrap_or(false),
            is_column_set: row.get::<bool, _>("is_column_set").unwrap_or(false),
            is_filestream: row.get::<bool, _>("is_filestream").unwrap_or(false),
            is_rowguidcol: row.get::<bool, _>("is_rowguidcol").unwrap_or(false),
            is_masked: row.get::<bool, _>("is_masked").unwrap_or(false),
            encryption_type: row.get::<i32, _>("encryption_type"),
        })
        .collect();
    Ok(aggregate_metadata_rows(mapped))
}

fn row_string(row: &Row, column: &str) -> String {
    row_optional_string(row, column).unwrap_or_default()
}

fn row_optional_string(row: &Row, column: &str) -> Option<String> {
    row.get::<&str, _>(column).map(str::to_string)
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

#[derive(Clone, Copy)]
struct SqlServerTableMetadataRef<'a> {
    table_comment: &'a str,
    primary_key_constraint: Option<&'a str>,
    temporal_type: i32,
    is_memory_optimized: bool,
    is_node: bool,
    is_edge: bool,
    is_filetable: bool,
    columns: &'a BTreeMap<String, ColumnSyncMetadata>,
}

#[derive(Clone, Copy)]
struct SqlServerColumnMetadataRef<'a> {
    is_identity: bool,
    identity_seed: Option<&'a str>,
    identity_increment: Option<&'a str>,
    computed_definition: Option<&'a str>,
    default_expression: Option<&'a str>,
    default_constraint_name: Option<&'a str>,
    default_constraint_is_system_named: Option<bool>,
    is_user_defined: bool,
    type_schema: &'a str,
    type_name: &'a str,
    primary_key_ordinal: Option<u32>,
    is_hidden: bool,
    generated_always_type: i32,
    is_sparse: bool,
    is_column_set: bool,
    is_filestream: bool,
    is_rowguidcol: bool,
    is_masked: bool,
    encryption_type: Option<i32>,
}

fn table_metadata<'a>(
    metadata: Option<&'a TableSyncMetadata>,
    table_name: &str,
) -> Result<SqlServerTableMetadataRef<'a>, String> {
    let Some(TableSyncMetadata::SqlServer {
        table_comment,
        primary_key_constraint,
        temporal_type,
        is_memory_optimized,
        is_node,
        is_edge,
        is_filetable,
        columns,
    }) = metadata
    else {
        return Err(format!("表 {table_name} 缺少 SQL Server 原生表元数据"));
    };
    Ok(SqlServerTableMetadataRef {
        table_comment,
        primary_key_constraint: primary_key_constraint.as_deref(),
        temporal_type: *temporal_type,
        is_memory_optimized: *is_memory_optimized,
        is_node: *is_node,
        is_edge: *is_edge,
        is_filetable: *is_filetable,
        columns,
    })
}

fn column_metadata<'a>(
    metadata: SqlServerTableMetadataRef<'a>,
    table_name: &str,
    column_name: &str,
) -> Result<SqlServerColumnMetadataRef<'a>, String> {
    let Some(ColumnSyncMetadata::SqlServer {
        is_identity,
        identity_seed,
        identity_increment,
        computed_definition,
        default_expression,
        default_constraint_name,
        default_constraint_is_system_named,
        is_user_defined,
        type_schema,
        type_name,
        primary_key_ordinal,
        is_hidden,
        generated_always_type,
        is_sparse,
        is_column_set,
        is_filestream,
        is_rowguidcol,
        is_masked,
        encryption_type,
    }) = metadata.columns.get(column_name)
    else {
        return Err(format!(
            "字段 {table_name}.{column_name} 缺少 SQL Server 原生字段元数据"
        ));
    };
    Ok(SqlServerColumnMetadataRef {
        is_identity: *is_identity,
        identity_seed: identity_seed.as_deref(),
        identity_increment: identity_increment.as_deref(),
        computed_definition: computed_definition.as_deref(),
        default_expression: default_expression.as_deref(),
        default_constraint_name: default_constraint_name.as_deref(),
        default_constraint_is_system_named: *default_constraint_is_system_named,
        is_user_defined: *is_user_defined,
        type_schema,
        type_name,
        primary_key_ordinal: *primary_key_ordinal,
        is_hidden: *is_hidden,
        generated_always_type: *generated_always_type,
        is_sparse: *is_sparse,
        is_column_set: *is_column_set,
        is_filestream: *is_filestream,
        is_rowguidcol: *is_rowguidcol,
        is_masked: *is_masked,
        encryption_type: *encryption_type,
    })
}

fn validate_plain_table(
    metadata: SqlServerTableMetadataRef<'_>,
    table_name: &str,
) -> Result<(), String> {
    if metadata.temporal_type != 0 {
        return Err(format!(
            "SQL Server temporal 表 {table_name} 无法由普通建表 builder 无损表达"
        ));
    }
    if metadata.is_memory_optimized {
        return Err(format!(
            "SQL Server memory-optimized 表 {table_name} 无法由普通建表 builder 无损表达"
        ));
    }
    if metadata.is_node || metadata.is_edge {
        return Err(format!(
            "SQL Server graph 表 {table_name} 不在首期普通物理表同步范围内"
        ));
    }
    if metadata.is_filetable {
        return Err(format!(
            "SQL Server FileTable {table_name} 不在首期普通物理表同步范围内"
        ));
    }
    Ok(())
}

fn validate_native_shape(
    column: &ColumnSnapshot,
    metadata: SqlServerColumnMetadataRef<'_>,
    table_name: &str,
    column_name: &str,
) -> Result<(), String> {
    if metadata.is_hidden
        || metadata.generated_always_type != 0
        || metadata.is_sparse
        || metadata.is_column_set
        || metadata.is_filestream
        || metadata.is_rowguidcol
        || metadata.is_masked
        || metadata.encryption_type.is_some()
    {
        return Err(format!(
            "字段 {table_name}.{column_name} 包含 hidden/generated-always/sparse/column-set/FILESTREAM/ROWGUIDCOL/masked/encrypted 特性，当前 builder 无法无损表达"
        ));
    }
    let has_identity_values =
        metadata.identity_seed.is_some() || metadata.identity_increment.is_some();
    if metadata.is_identity
        && (metadata.identity_seed.is_none() || metadata.identity_increment.is_none())
    {
        return Err(format!(
            "identity 字段 {table_name}.{column_name} 缺少 seed/increment 原生值"
        ));
    }
    if !metadata.is_identity && has_identity_values {
        return Err(format!(
            "普通字段 {table_name}.{column_name} 意外包含 identity seed/increment"
        ));
    }
    if metadata.is_identity && metadata.computed_definition.is_some() {
        return Err(format!(
            "字段 {table_name}.{column_name} 同时声明 identity 和 computed"
        ));
    }
    if metadata.computed_definition.is_some() && metadata.default_expression.is_some() {
        return Err(format!(
            "computed 字段 {table_name}.{column_name} 意外包含默认约束"
        ));
    }
    let default_parts_present = (
        metadata.default_expression.is_some(),
        metadata.default_constraint_name.is_some(),
        metadata.default_constraint_is_system_named.is_some(),
    );
    if !matches!(
        default_parts_present,
        (false, false, false) | (true, true, true)
    ) {
        return Err(format!(
            "字段 {table_name}.{column_name} 的默认表达式、约束名和命名标记不完整"
        ));
    }
    if metadata.is_user_defined
        && (metadata.type_schema.trim().is_empty() || metadata.type_name.trim().is_empty())
    {
        return Err(format!(
            "用户定义类型字段 {table_name}.{column_name} 缺少类型 schema 或名称"
        ));
    }
    if column.default_value.as_deref() != metadata.default_expression {
        return Err(format!(
            "字段 {table_name}.{column_name} 的默认表达式原生元数据与结构快照不一致"
        ));
    }
    let expected_extra = build_sqlserver_column_extra(
        metadata.is_identity,
        metadata.computed_definition.map(str::to_string),
    );
    if column.extra.trim() != expected_extra {
        return Err(format!(
            "字段 {table_name}.{column_name} 的 identity/computed 原生元数据与结构快照不一致"
        ));
    }
    Ok(())
}

fn native_special_equal(
    source: SqlServerColumnMetadataRef<'_>,
    target: SqlServerColumnMetadataRef<'_>,
) -> bool {
    source.is_identity == target.is_identity
        && source.identity_seed == target.identity_seed
        && source.identity_increment == target.identity_increment
        && source.computed_definition == target.computed_definition
        && source.is_user_defined == target.is_user_defined
        && (!source.is_user_defined
            || (source.type_schema == target.type_schema && source.type_name == target.type_name))
}

fn default_constraint_shape_equal(
    source: SqlServerColumnMetadataRef<'_>,
    target: SqlServerColumnMetadataRef<'_>,
) -> bool {
    if source.default_expression != target.default_expression {
        return true;
    }
    match (
        source.default_constraint_is_system_named,
        target.default_constraint_is_system_named,
    ) {
        (None, None) | (Some(true), Some(true)) => true,
        (Some(false), Some(false)) => {
            source.default_constraint_name == target.default_constraint_name
        }
        _ => false,
    }
}

fn identity_uses_builder_defaults(metadata: SqlServerColumnMetadataRef<'_>) -> bool {
    !metadata.is_identity
        || (metadata.identity_seed.is_some_and(is_numeric_one)
            && metadata.identity_increment.is_some_and(is_numeric_one))
}

fn is_numeric_one(value: &str) -> bool {
    value.trim().parse::<f64>() == Ok(1.0)
}

#[derive(Clone, Copy)]
enum DefaultRebuildKind {
    CreateOrAdd,
    Alter,
}

fn source_default_for_builder(
    metadata: SqlServerColumnMetadataRef<'_>,
    table_name: &str,
    column_name: &str,
    kind: DefaultRebuildKind,
) -> Result<Option<String>, String> {
    let Some(expression) = metadata.default_expression else {
        return Ok(None);
    };
    if metadata.default_constraint_is_system_named == Some(false) {
        if metadata.default_constraint_name.is_none() {
            return Err(format!(
                "字段 {table_name}.{column_name} 的命名默认约束缺少约束名"
            ));
        }
        if matches!(kind, DefaultRebuildKind::CreateOrAdd) {
            return Err(format!(
                "字段 {table_name}.{column_name} 使用命名默认约束 `{}`，当前 builder 无法无损保留该名称",
                metadata.default_constraint_name.unwrap_or_default()
            ));
        }
    }
    convert_default_expression(expression)
        .map(Some)
        .map_err(|reason| {
            format!("字段 {table_name}.{column_name} 的默认表达式无法无损重建: {reason}")
        })
}

fn convert_default_expression(expression: &str) -> Result<String, String> {
    let normalized = strip_outer_parentheses(expression);
    if normalized.is_empty() {
        return Err("表达式为空".to_string());
    }
    if builder_treats_as_raw_default(normalized) {
        return Ok(normalized.to_string());
    }
    let parsed = parse_unicode_string_literal(normalized)
        .ok_or_else(|| format!("不支持表达式 `{normalized}`"))?;
    if parsed.is_empty() || parsed.trim() != parsed || builder_treats_as_raw_default(&parsed) {
        return Err("字符串值会被当前 builder 去空白或解释成裸表达式".to_string());
    }
    Ok(parsed)
}

fn builder_treats_as_raw_default(value: &str) -> bool {
    let upper = value.to_ascii_uppercase();
    matches!(
        upper.as_str(),
        "NULL"
            | "CURRENT_TIMESTAMP"
            | "GETDATE()"
            | "SYSDATETIME()"
            | "SYSUTCDATETIME()"
            | "SYSDATETIMEOFFSET()"
            | "NEWID()"
            | "NEWSEQUENTIALID()"
    ) || value.parse::<i64>().is_ok()
        || value.parse::<f64>().is_ok()
}

fn strip_outer_parentheses(mut value: &str) -> &str {
    value = value.trim();
    while wrapping_parentheses_end(value) == Some(value.len() - 1) {
        value = value[1..value.len() - 1].trim();
    }
    value
}

fn wrapping_parentheses_end(value: &str) -> Option<usize> {
    let bytes = value.as_bytes();
    if bytes.first() != Some(&b'(') || bytes.last() != Some(&b')') {
        return None;
    }
    let mut depth = 0_u32;
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'\'' => {
                index += 1;
                while index < bytes.len() {
                    if bytes[index] == b'\'' {
                        if bytes.get(index + 1) == Some(&b'\'') {
                            index += 2;
                            continue;
                        }
                        break;
                    }
                    index += 1;
                }
            }
            b'(' => depth += 1,
            b')' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(index);
                }
            }
            _ => {}
        }
        index += 1;
    }
    None
}

fn parse_unicode_string_literal(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() < 3
        || !matches!(bytes[0], b'N' | b'n')
        || bytes[1] != b'\''
        || bytes.last() != Some(&b'\'')
    {
        return None;
    }
    let inner = &value[2..value.len() - 1];
    let mut parsed = String::with_capacity(inner.len());
    let mut chars = inner.chars().peekable();
    while let Some(character) = chars.next() {
        if character == '\'' {
            chars.next_if_eq(&'\'')?;
        }
        parsed.push(character);
    }
    Some(parsed)
}

fn validate_definition_rebuild(
    column: &ColumnSnapshot,
    metadata: SqlServerColumnMetadataRef<'_>,
    table_name: &str,
    column_name: &str,
) -> Result<Option<String>, String> {
    validate_native_shape(column, metadata, table_name, column_name)?;
    if metadata.computed_definition.is_some() {
        return Err(format!(
            "computed 字段 {table_name}.{column_name} 无法由当前 SQL Server builder 无损重建"
        ));
    }
    if metadata.is_user_defined {
        return Err(format!(
            "用户定义类型字段 {table_name}.{column_name} 使用 {}.{}，无法证明目标端类型存在",
            metadata.type_schema, metadata.type_name
        ));
    }
    if !identity_uses_builder_defaults(metadata) {
        return Err(format!(
            "identity 字段 {table_name}.{column_name} 不是 builder 可表达的 IDENTITY(1,1)"
        ));
    }
    source_default_for_builder(
        metadata,
        table_name,
        column_name,
        DefaultRebuildKind::CreateOrAdd,
    )
}

fn sqlserver_primary_key_columns(
    table: &TableSnapshot,
    metadata: SqlServerTableMetadataRef<'_>,
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
                "主键字段 {}.{} 缺少 SQL Server 原生主键序号",
                table.name, name
            ));
        };
        if ordinal == 0 || !ordinals.insert(ordinal) {
            return Err(format!(
                "表 {} 包含无效或重复的 SQL Server 原生主键序号 {}",
                table.name, ordinal
            ));
        }
        ordered.push((ordinal, name.clone()));
    }
    ordered.sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    Ok(ordered.into_iter().map(|(_, name)| name).collect())
}

fn validate_primary_key_consistency(
    table: &TableSnapshot,
    metadata: SqlServerTableMetadataRef<'_>,
    columns: &[String],
) -> Result<(), String> {
    if columns.is_empty() != metadata.primary_key_constraint.is_none() {
        return Err(format!("表 {} 的主键约束名与字段快照不一致", table.name));
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
    if let Err(reason) = validate_plain_table(metadata, &source.name) {
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
        let default_value = match validate_definition_rebuild(column, native, &source.name, name) {
            Ok(default_value) => default_value,
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
            extra: column.extra.clone(),
            comment: column.comment.clone(),
        });
    }
    if !plan.blockers.is_empty() {
        return;
    }
    let primary_keys = match sqlserver_primary_key_columns(source, metadata) {
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
    if let Err(reason) = validate_primary_key_consistency(source, metadata, &primary_keys) {
        plan.block(
            &source.name,
            &format!("无法创建表 {}", source.name),
            &reason,
        );
        return;
    }
    let request = CreateTableRequest {
        table_name: source.name.clone(),
        columns: definitions,
        primary_keys,
        engine: String::new(),
        order_by: None,
        comment: metadata.table_comment.to_string(),
    };
    let (create_sql, after_sqls) =
        match sqlserver_ddl::build_create_table_sqls(context.target_database, &request) {
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

fn plan_target_only_table(
    plan: &mut PlanFragments,
    context: &TablePlanContext<'_>,
    target: &TableSnapshot,
) {
    let metadata = match table_metadata(context.target_metadata, &target.name) {
        Ok(metadata) => metadata,
        Err(reason) => {
            plan.block(
                &target.name,
                &format!("无法删除表 {}", target.name),
                &reason,
            );
            return;
        }
    };
    if let Err(reason) = validate_plain_table(metadata, &target.name) {
        plan.block(
            &target.name,
            &format!("无法删除表 {}", target.name),
            &reason,
        );
        return;
    }
    if context.include_drops {
        plan.operation(
            OperationPhase::DropTable,
            &target.name,
            DatabaseSyncOperationKind::DropTable,
            DatabaseSyncRisk::Destructive,
            &format!("删除目标端独有表 {}", target.name),
            vec![sqlserver_ddl::build_drop_table_sql(
                context.target_database,
                &target.name,
            )],
        );
    } else {
        plan.skip(&target.name, "跳过删除目标端独有表", "未开启包含删除操作");
    }
}

fn plan_changed_table(
    plan: &mut PlanFragments,
    context: &TablePlanContext<'_>,
    source: &TableSnapshot,
    target: &TableSnapshot,
) {
    let source_metadata = match table_metadata(context.source_metadata, &source.name) {
        Ok(metadata) => metadata,
        Err(reason) => {
            plan.block(&source.name, "无法规划 SQL Server 表同步", &reason);
            return;
        }
    };
    let target_metadata = match table_metadata(context.target_metadata, &target.name) {
        Ok(metadata) => metadata,
        Err(reason) => {
            plan.block(&source.name, "无法规划 SQL Server 表同步", &reason);
            return;
        }
    };
    for (metadata, table_name) in [
        (source_metadata, source.name.as_str()),
        (target_metadata, target.name.as_str()),
    ] {
        if let Err(reason) = validate_plain_table(metadata, table_name) {
            plan.block(&source.name, "无法规划 SQL Server 表同步", &reason);
        }
    }
    if !plan.blockers.is_empty() {
        return;
    }
    let differences = compare_table_columns(source, target);
    let primary_key_definition_changed = differences.iter().any(|difference| {
        difference.status == SchemaDiffStatus::Changed
            && difference
                .source
                .as_ref()
                .is_some_and(|column| column.primary_key)
            && difference
                .target
                .as_ref()
                .is_some_and(|column| column.primary_key)
            && difference
                .changed_fields
                .iter()
                .any(|field| field == "column_type" || field == "nullable")
    });
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
                "SQL Server 不支持安全调整字段物理顺序",
            );
            blocked_columns.insert(name.clone());
        }
        let source_native = match column_metadata(source_metadata, &source.name, name) {
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
        let target_native = match column_metadata(target_metadata, &target.name, name) {
            Ok(native) => native,
            Err(reason) => {
                plan.block(
                    &source.name,
                    &format!("无法比较字段 {}.{}", target.name, name),
                    &reason,
                );
                blocked_columns.insert(name.clone());
                continue;
            }
        };
        for (column, native, table_name) in [
            (source_column, source_native, source.name.as_str()),
            (target_column, target_native, target.name.as_str()),
        ] {
            if let Err(reason) = validate_native_shape(column, native, table_name, name) {
                plan.block(
                    &source.name,
                    &format!("无法比较字段 {}.{}", table_name, name),
                    &reason,
                );
                blocked_columns.insert(name.clone());
            }
        }
        if !native_special_equal(source_native, target_native) {
            plan.block(
                &source.name,
                &format!("无法转换字段 {}.{}", source.name, name),
                "SQL Server identity/computed/用户定义类型原生元数据不一致，无法安全转换",
            );
            blocked_columns.insert(name.clone());
        }
        if !default_constraint_shape_equal(source_native, target_native) {
            plan.block(
                &source.name,
                &format!("无法转换字段 {}.{}", source.name, name),
                "SQL Server 默认约束名或命名方式不一致，当前 builder 无法无损转换",
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
                        "SQL Server 只能安全追加到目标端现有字段之后",
                    );
                    continue;
                }
                let native = match column_metadata(source_metadata, &source.name, &difference.name)
                {
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
                let default_value = match validate_definition_rebuild(
                    column,
                    native,
                    &source.name,
                    &difference.name,
                ) {
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
                let request = AddColumnRequest {
                    name: difference.name.clone(),
                    column_type: column.column_type.clone(),
                    nullable: column.nullable,
                    default_value,
                    extra: column.extra.clone(),
                    comment: column.comment.clone(),
                    after_column: None,
                };
                match sqlserver_ddl::build_add_column_sqls(
                    context.target_database,
                    &source.name,
                    &request,
                ) {
                    Ok(sql) => {
                        if add_column_risk(column, source_metadata.columns.get(&difference.name))
                            == DatabaseSyncRisk::High
                        {
                            add_risk = DatabaseSyncRisk::High;
                        }
                        add_columns.push((column.ordinal_position, difference.name, sql));
                    }
                    Err(reason) => plan.block(
                        &source.name,
                        &format!("无法新增字段 {}.{}", source.name, difference.name),
                        &reason,
                    ),
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
                        "SQL Server extra 展示值变化无法脱离原生 identity/computed 元数据安全规划",
                    );
                    continue;
                }
                let requires_alter = difference.changed_fields.iter().any(|field| {
                    field != "ordinal_position" && field != "primary_key" && field != "extra"
                });
                if !requires_alter {
                    continue;
                }
                let source_column = difference
                    .source
                    .as_ref()
                    .expect("变化字段必须包含源端定义");
                let target_column = difference
                    .target
                    .as_ref()
                    .expect("变化字段必须包含目标端定义");
                let source_native =
                    match column_metadata(source_metadata, &source.name, &difference.name) {
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
                let definition_changed = difference.changed_fields.iter().any(|field| {
                    matches!(field.as_str(), "column_type" | "nullable" | "default_value")
                });
                if definition_changed && source_native.is_identity {
                    plan.block(
                        &source.name,
                        &format!("无法修改字段 {}.{}", source.name, difference.name),
                        "SQL Server identity 字段定义无法通过 ALTER COLUMN 无损修改",
                    );
                    continue;
                }
                if definition_changed && source_native.computed_definition.is_some() {
                    plan.block(
                        &source.name,
                        &format!("无法修改字段 {}.{}", source.name, difference.name),
                        "SQL Server computed 字段定义无法通过 ALTER COLUMN 无损修改",
                    );
                    continue;
                }
                if difference
                    .changed_fields
                    .iter()
                    .any(|field| field == "column_type" || field == "nullable")
                    && source_native.is_user_defined
                {
                    plan.block(
                        &source.name,
                        &format!("无法修改字段 {}.{}", source.name, difference.name),
                        "SQL Server 用户定义类型无法由当前 builder 无损修改",
                    );
                    continue;
                }
                let default_changed = difference
                    .changed_fields
                    .iter()
                    .any(|field| field == "default_value");
                if !context.include_drops
                    && ((!target_column.nullable && source_column.nullable) || default_changed)
                {
                    plan.block(
                        &source.name,
                        &format!("无法修改字段 {}.{}", source.name, difference.name),
                        "修改会删除目标端 NOT NULL 或默认约束，但未开启包含删除操作",
                    );
                    continue;
                }
                let (current_default, requested_default) = if default_changed {
                    let requested = match source_default_for_builder(
                        source_native,
                        &source.name,
                        &difference.name,
                        DefaultRebuildKind::Alter,
                    ) {
                        Ok(default) => default,
                        Err(reason) => {
                            plan.block(
                                &source.name,
                                &format!("无法修改字段 {}.{}", source.name, difference.name),
                                &reason,
                            );
                            continue;
                        }
                    };
                    (target_column.default_value.clone(), requested)
                } else {
                    (
                        target_column.default_value.clone(),
                        target_column.default_value.clone(),
                    )
                };
                if source_native.computed_definition.is_some() {
                    if difference.changed_fields.as_slice() == ["comment"] {
                        alter_columns.push((
                            source_column.ordinal_position,
                            difference.name.clone(),
                            vec![sqlserver_ddl::build_upsert_column_comment_sql(
                                context.target_database,
                                &source.name,
                                &difference.name,
                                &source_column.comment,
                            )],
                        ));
                    } else {
                        plan.block(
                            &source.name,
                            &format!("无法修改字段 {}.{}", source.name, difference.name),
                            "SQL Server computed 字段仅支持独立同步注释",
                        );
                    }
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
                    default_value: current_default,
                    extra: target_column.extra.clone(),
                    comment: target_column.comment.clone(),
                };
                let request = AlterColumnRequest {
                    old_name: difference.name.clone(),
                    new_name: difference.name.clone(),
                    column_type: source_column.column_type.clone(),
                    nullable: source_column.nullable,
                    default_value: requested_default,
                    extra: source_column.extra.clone(),
                    comment: source_column.comment.clone(),
                    is_primary: None,
                    column_placement: None,
                };
                let explicit_default_constraint = source_native
                    .default_constraint_is_system_named
                    .is_some_and(|is_system_named| !is_system_named)
                    .then_some(source_native.default_constraint_name)
                    .flatten();
                match sqlserver_ddl::build_alter_column_sqls_with_default_constraint_name(
                    context.target_database,
                    &source.name,
                    &current,
                    &request,
                    explicit_default_constraint,
                ) {
                    Ok(sql) if !sql.is_empty() => {
                        alter_columns.push((source_column.ordinal_position, difference.name, sql));
                    }
                    Ok(_) => {}
                    Err(reason) => plan.block(
                        &source.name,
                        &format!("无法修改字段 {}.{}", source.name, difference.name),
                        &reason,
                    ),
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

    let source_primary_keys = match sqlserver_primary_key_columns(source, source_metadata) {
        Ok(columns) => columns,
        Err(reason) => {
            plan.block(&source.name, "无法规划源端主键", &reason);
            return;
        }
    };
    let target_primary_keys = match sqlserver_primary_key_columns(target, target_metadata) {
        Ok(columns) => columns,
        Err(reason) => {
            plan.block(&source.name, "无法规划目标端主键", &reason);
            return;
        }
    };
    for (table, metadata, keys, summary) in [
        (
            source,
            source_metadata,
            source_primary_keys.as_slice(),
            "无法规划源端主键",
        ),
        (
            target,
            target_metadata,
            target_primary_keys.as_slice(),
            "无法规划目标端主键",
        ),
    ] {
        if let Err(reason) = validate_primary_key_consistency(table, metadata, keys) {
            plan.block(&source.name, summary, &reason);
        }
    }
    let replace_primary_key =
        source_primary_keys != target_primary_keys || primary_key_definition_changed;
    if replace_primary_key && !target_primary_keys.is_empty() && !context.include_drops {
        plan.block(
            &source.name,
            &format!("无法替换表 {} 的主键", source.name),
            "目标端已有主键，替换主键需要删除旧约束，但未开启包含删除操作",
        );
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
    if replace_primary_key {
        let mut statements = Vec::new();
        if let Some(constraint) = target_metadata.primary_key_constraint {
            statements.push(format!(
                "ALTER TABLE {}.{} DROP CONSTRAINT {}",
                sqlserver_id(context.target_database),
                sqlserver_id(&source.name),
                sqlserver_id(constraint)
            ));
        }
        statements.append(&mut alter_sql);
        if !source_primary_keys.is_empty() {
            statements.push(build_add_primary_key_sql(
                context.target_database,
                &source.name,
                &source_primary_keys,
            ));
        }
        plan.operation(
            OperationPhase::AlterColumn,
            &source.name,
            DatabaseSyncOperationKind::ReplacePrimaryKey,
            DatabaseSyncRisk::High,
            &format!("替换表 {} 的主键并同步相关字段", source.name),
            vec![build_atomic_sqlserver_batch(&statements)],
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
    if source_metadata.table_comment != target_metadata.table_comment {
        plan.operation(
            OperationPhase::AlterColumn,
            &source.name,
            DatabaseSyncOperationKind::UpdateComment,
            DatabaseSyncRisk::Normal,
            &format!("更新表 {} 的注释", source.name),
            vec![sqlserver_ddl::build_upsert_table_comment_sql(
                context.target_database,
                &source.name,
                source_metadata.table_comment,
            )],
        );
    }
    for column_name in drop_columns {
        plan.operation(
            OperationPhase::DropColumn,
            &source.name,
            DatabaseSyncOperationKind::DropColumn,
            DatabaseSyncRisk::Destructive,
            &format!("删除目标端独有字段 {}.{}", source.name, column_name),
            vec![sqlserver_ddl::build_drop_column_sql(
                context.target_database,
                &source.name,
                &column_name,
            )],
        );
    }
}

fn build_atomic_sqlserver_batch(statements: &[String]) -> String {
    let body = statements
        .iter()
        .map(|statement| {
            let statement = statement.trim().trim_end_matches(';');
            statement
                .lines()
                .map(|line| format!("    {line}"))
                .collect::<Vec<_>>()
                .join("\n")
                + ";"
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "SET XACT_ABORT ON;\nBEGIN TRY\n    BEGIN TRANSACTION;\n{body}\n    COMMIT TRANSACTION;\nEND TRY\nBEGIN CATCH\n    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;\n    THROW;\nEND CATCH"
    )
}

fn build_add_primary_key_sql(schema: &str, table: &str, columns: &[String]) -> String {
    let columns = columns
        .iter()
        .map(|column| sqlserver_id(column))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "ALTER TABLE {}.{} ADD CONSTRAINT {} PRIMARY KEY ({})",
        sqlserver_id(schema),
        sqlserver_id(table),
        sqlserver_id(&sqlserver_ddl::primary_key_constraint_name(table)),
        columns
    )
}

#[cfg(test)]
mod tests {
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

    #[allow(clippy::too_many_arguments)]
    fn native_column(
        is_identity: bool,
        identity_seed: Option<&str>,
        identity_increment: Option<&str>,
        computed_definition: Option<&str>,
        default_expression: Option<&str>,
        default_constraint_name: Option<&str>,
        default_constraint_is_system_named: Option<bool>,
        is_user_defined: bool,
        primary_key_ordinal: Option<u32>,
    ) -> ColumnSyncMetadata {
        ColumnSyncMetadata::SqlServer {
            is_identity,
            identity_seed: identity_seed.map(str::to_string),
            identity_increment: identity_increment.map(str::to_string),
            computed_definition: computed_definition.map(str::to_string),
            default_expression: default_expression.map(str::to_string),
            default_constraint_name: default_constraint_name.map(str::to_string),
            default_constraint_is_system_named,
            is_user_defined,
            type_schema: if is_user_defined {
                "app_types".to_string()
            } else {
                "sys".to_string()
            },
            type_name: if is_user_defined {
                "phone".to_string()
            } else {
                "bigint".to_string()
            },
            primary_key_ordinal,
            is_hidden: false,
            generated_always_type: 0,
            is_sparse: false,
            is_column_set: false,
            is_filestream: false,
            is_rowguidcol: false,
            is_masked: false,
            encryption_type: None,
        }
    }

    fn metadata(
        table_comment: &str,
        primary_key_constraint: Option<&str>,
        columns: Vec<(&str, ColumnSyncMetadata)>,
    ) -> TableSyncMetadata {
        TableSyncMetadata::SqlServer {
            table_comment: table_comment.to_string(),
            primary_key_constraint: primary_key_constraint.map(str::to_string),
            temporal_type: 0,
            is_memory_optimized: false,
            is_node: false,
            is_edge: false,
            is_filetable: false,
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
    fn metadata_query_reads_native_shapes_once_and_escapes_schema_literal() {
        let sql = metadata_sql("d'bo");
        assert!(sql.contains("FROM sys.tables tables"));
        assert!(sql.contains("JOIN sys.columns columns"));
        assert!(sql.contains("LEFT JOIN sys.identity_columns"));
        assert!(sql.contains("LEFT JOIN sys.computed_columns"));
        assert!(sql.contains("LEFT JOIN sys.default_constraints"));
        assert!(sql.contains("LEFT JOIN sys.key_constraints"));
        assert!(sql.contains("tables.temporal_type"));
        assert!(sql.contains("tables.is_memory_optimized"));
        assert!(sql.contains("columns.generated_always_type"));
        assert!(sql.contains("columns.is_sparse"));
        assert!(sql.contains("columns.encryption_type"));
        assert!(sql.contains("key_ordinal"));
        assert!(sql.contains("default_constraint_is_system_named"));
        assert!(sql.contains("schemas.name = N'd''bo'"));
        assert!(sql.contains("tables.is_ms_shipped = 0"));
        assert!(!sql.contains("tables.name ="));
    }

    #[test]
    fn aggregates_all_native_column_metadata_in_memory() {
        let metadata = aggregate_metadata_rows(vec![MetadataRow {
            table_name: "users".to_string(),
            table_comment: "用户".to_string(),
            primary_key_constraint: Some("PK_users_native".to_string()),
            temporal_type: 0,
            is_memory_optimized: false,
            is_node: false,
            is_edge: false,
            is_filetable: false,
            column_name: "id".to_string(),
            is_identity: true,
            identity_seed: Some("1".to_string()),
            identity_increment: Some("1".to_string()),
            computed_definition: None,
            default_expression: Some("((0))".to_string()),
            default_constraint_name: Some("DF_users_id".to_string()),
            default_constraint_is_system_named: Some(false),
            is_user_defined: false,
            type_schema: "sys".to_string(),
            type_name: "bigint".to_string(),
            primary_key_ordinal: Some(2),
            is_hidden: false,
            generated_always_type: 0,
            is_sparse: false,
            is_column_set: false,
            is_filestream: false,
            is_rowguidcol: false,
            is_masked: false,
            encryption_type: None,
        }]);

        let TableSyncMetadata::SqlServer {
            table_comment,
            primary_key_constraint,
            columns,
            ..
        } = &metadata["users"]
        else {
            panic!("应聚合为 SQL Server 元数据");
        };
        assert_eq!(table_comment, "用户");
        assert_eq!(primary_key_constraint.as_deref(), Some("PK_users_native"));
        assert!(matches!(
            columns.get("id"),
            Some(ColumnSyncMetadata::SqlServer {
                is_identity: true,
                identity_seed: Some(seed),
                default_expression: Some(default_expression),
                default_constraint_name: Some(default_name),
                default_constraint_is_system_named: Some(false),
                primary_key_ordinal: Some(2),
                ..
            }) if seed == "1" && default_expression == "((0))" && default_name == "DF_users_id"
        ));
    }

    #[test]
    fn creates_qualified_table_with_bracket_escaping_and_native_primary_key_order() {
        let source = table(
            "us]ers",
            vec![
                ("id", column(1, "bigint", false, None, true, "", "主键")),
                (
                    "tenant]id",
                    column(2, "bigint", false, Some("((42))"), true, "", ""),
                ),
            ],
        );
        let source_metadata = metadata(
            "用户's",
            Some("source_pk"),
            vec![
                (
                    "id",
                    native_column(false, None, None, None, None, None, None, false, Some(2)),
                ),
                (
                    "tenant]id",
                    native_column(
                        false,
                        None,
                        None,
                        None,
                        Some("((42))"),
                        Some("DF__system"),
                        Some(true),
                        false,
                        Some(1),
                    ),
                ),
            ],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "d]bo",
            source: Some(&source),
            target: None,
            source_metadata: Some(&source_metadata),
            target_metadata: None,
            include_drops: false,
        });

        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        assert_eq!(plan.operations.len(), 1);
        assert_eq!(
            plan.operations[0].kind,
            DatabaseSyncOperationKind::CreateTable
        );
        let primary_constraint = sqlserver_ddl::primary_key_constraint_name("us]ers");
        assert_eq!(
            plan.operations[0].sql[0],
            format!(
                "CREATE TABLE [d]]bo].[us]]ers] (\n  [id] bigint NOT NULL,\n  [tenant]]id] bigint NOT NULL DEFAULT 42,\n  CONSTRAINT [{}] PRIMARY KEY ([tenant]]id], [id])\n)",
                primary_constraint
            )
        );
        assert!(plan.operations[0].sql[1].contains("@level0name=N'd]bo'"));
        assert!(plan.operations[0].sql[1].contains("@level1name=N'us]ers'"));
    }

    #[test]
    fn identity_or_ordinal_change_is_blocked() {
        let source = table(
            "users",
            vec![(
                "id",
                column(2, "bigint", false, None, false, "identity", ""),
            )],
        );
        let target = table(
            "users",
            vec![("id", column(1, "bigint", false, None, false, "", ""))],
        );
        let source_metadata = metadata(
            "",
            None,
            vec![(
                "id",
                native_column(
                    true,
                    Some("1"),
                    Some("1"),
                    None,
                    None,
                    None,
                    None,
                    false,
                    None,
                ),
            )],
        );
        let target_metadata = metadata(
            "",
            None,
            vec![(
                "id",
                native_column(false, None, None, None, None, None, None, false, None),
            )],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "dbo",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });
        assert!(plan.operations.is_empty());
        assert!(plan.blockers.len() >= 2);
    }

    #[test]
    fn non_default_identity_and_computed_or_udt_creation_are_blocked() {
        let cases = [
            (
                column(1, "bigint", false, None, false, "identity", ""),
                native_column(
                    true,
                    Some("100"),
                    Some("5"),
                    None,
                    None,
                    None,
                    None,
                    false,
                    None,
                ),
            ),
            (
                column(1, "int", true, None, false, "computed AS ([a]+[b])", ""),
                native_column(
                    false,
                    None,
                    None,
                    Some("([a]+[b])"),
                    None,
                    None,
                    None,
                    false,
                    None,
                ),
            ),
            (
                column(1, "[app_types].[phone]", true, None, false, "", ""),
                native_column(false, None, None, None, None, None, None, true, None),
            ),
        ];
        for (index, (source_column, source_native)) in cases.into_iter().enumerate() {
            let source = table(&format!("blocked_{index}"), vec![("value", source_column)]);
            let source_metadata = metadata("", None, vec![("value", source_native)]);
            let plan = plan_table(TablePlanContext {
                target_database: "dbo",
                source: Some(&source),
                target: None,
                source_metadata: Some(&source_metadata),
                target_metadata: None,
                include_drops: false,
            });
            assert!(plan.operations.is_empty());
            assert!(!plan.blockers.is_empty());
        }
    }

    #[test]
    fn named_or_unsupported_default_expression_is_blocked_when_rebuilding_default() {
        let cases = [
            (Some("((42))"), Some("source_named_default"), Some(false)),
            (
                Some("(NEXT VALUE FOR [dbo].[sequence])"),
                Some("DF__system"),
                Some(true),
            ),
        ];
        for (index, (expression, name, system_named)) in cases.into_iter().enumerate() {
            let source = table(
                &format!("defaults_{index}"),
                vec![(
                    "value",
                    column(1, "bigint", false, expression, false, "", ""),
                )],
            );
            let source_metadata = metadata(
                "",
                None,
                vec![(
                    "value",
                    native_column(
                        false,
                        None,
                        None,
                        None,
                        expression,
                        name,
                        system_named,
                        false,
                        None,
                    ),
                )],
            );
            let plan = plan_table(TablePlanContext {
                target_database: "dbo",
                source: Some(&source),
                target: None,
                source_metadata: Some(&source_metadata),
                target_metadata: None,
                include_drops: true,
            });
            assert!(plan.operations.is_empty());
            assert!(!plan.blockers.is_empty());
        }
    }

    #[test]
    fn defaults_trimmed_by_builder_are_blocked_instead_of_silently_changed() {
        for (index, expression) in ["(N'')", "(N' padded ')", "(N'42')", "(N'GETDATE()')"]
            .into_iter()
            .enumerate()
        {
            let source = table(
                &format!("trimmed_default_{index}"),
                vec![(
                    "value",
                    column(1, "nvarchar(20)", false, Some(expression), false, "", ""),
                )],
            );
            let source_metadata = metadata(
                "",
                None,
                vec![(
                    "value",
                    native_column(
                        false,
                        None,
                        None,
                        None,
                        Some(expression),
                        Some("DF__system"),
                        Some(true),
                        false,
                        None,
                    ),
                )],
            );
            let plan = plan_table(TablePlanContext {
                target_database: "dbo",
                source: Some(&source),
                target: None,
                source_metadata: Some(&source_metadata),
                target_metadata: None,
                include_drops: true,
            });

            assert!(plan.operations.is_empty());
            assert_eq!(plan.blockers.len(), 1);
            assert!(plan.blockers[0].reason.contains("默认表达式"));
        }
    }

    #[test]
    fn include_drops_false_never_emits_drop_from_nested_alter_paths() {
        let source = table(
            "users",
            vec![
                (
                    "id",
                    column(1, "bigint", true, Some("((2))"), false, "", ""),
                ),
                ("new_pk", column(2, "bigint", false, None, true, "", "")),
            ],
        );
        let target = table(
            "users",
            vec![
                (
                    "id",
                    column(1, "bigint", false, Some("((1))"), true, "", ""),
                ),
                ("old", column(2, "bigint", true, None, false, "", "")),
            ],
        );
        let source_metadata = metadata(
            "",
            Some("source_pk"),
            vec![
                (
                    "id",
                    native_column(
                        false,
                        None,
                        None,
                        None,
                        Some("((2))"),
                        Some("DF__source"),
                        Some(true),
                        false,
                        None,
                    ),
                ),
                (
                    "new_pk",
                    native_column(false, None, None, None, None, None, None, false, Some(1)),
                ),
            ],
        );
        let target_metadata = metadata(
            "",
            Some("PK_target]users"),
            vec![
                (
                    "id",
                    native_column(
                        false,
                        None,
                        None,
                        None,
                        Some("((1))"),
                        Some("DF_target_id"),
                        Some(false),
                        false,
                        Some(1),
                    ),
                ),
                (
                    "old",
                    native_column(false, None, None, None, None, None, None, false, None),
                ),
            ],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "d]bo",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });

        assert!(plan.operations.is_empty());
        assert!(!plan.blockers.is_empty());
        assert!(all_sql(&plan)
            .iter()
            .all(|sql| !sql.to_ascii_uppercase().contains("DROP")));
    }

    #[test]
    fn replaces_primary_key_with_one_atomic_batch_and_escaped_qualifiers() {
        let source = table(
            "us]ers",
            vec![
                ("id", column(1, "bigint", false, None, true, "", "")),
                ("tenant", column(2, "bigint", false, None, true, "", "")),
            ],
        );
        let target = table(
            "us]ers",
            vec![
                ("id", column(1, "bigint", false, None, true, "", "")),
                ("tenant", column(2, "bigint", false, None, false, "", "")),
            ],
        );
        let source_metadata = metadata(
            "",
            Some("source_pk"),
            vec![
                (
                    "id",
                    native_column(false, None, None, None, None, None, None, false, Some(2)),
                ),
                (
                    "tenant",
                    native_column(false, None, None, None, None, None, None, false, Some(1)),
                ),
            ],
        );
        let target_metadata = metadata(
            "",
            Some("target]pk"),
            vec![
                (
                    "id",
                    native_column(false, None, None, None, None, None, None, false, Some(1)),
                ),
                (
                    "tenant",
                    native_column(false, None, None, None, None, None, None, false, None),
                ),
            ],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "d]bo",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: true,
        });

        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        assert_eq!(plan.operations.len(), 1);
        assert_eq!(
            plan.operations[0].kind,
            DatabaseSyncOperationKind::ReplacePrimaryKey
        );
        assert_eq!(plan.operations[0].sql.len(), 1);
        let batch = &plan.operations[0].sql[0];
        assert!(batch.starts_with("SET XACT_ABORT ON;\nBEGIN TRY\n    BEGIN TRANSACTION;"));
        let drop_position = batch
            .find("ALTER TABLE [d]]bo].[us]]ers] DROP CONSTRAINT [target]]pk]")
            .unwrap();
        let add_position = batch
            .find(&format!(
                "ALTER TABLE [d]]bo].[us]]ers] ADD CONSTRAINT [{}] PRIMARY KEY ([tenant], [id])",
                sqlserver_ddl::primary_key_constraint_name("us]ers")
            ))
            .unwrap();
        assert!(drop_position < add_position);
        assert!(batch.contains("    COMMIT TRANSACTION;\nEND TRY"));
        assert!(batch.contains(
            "BEGIN CATCH\n    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;\n    THROW;\nEND CATCH"
        ));
    }

    #[test]
    fn native_only_primary_key_order_change_is_planned() {
        let snapshot = table(
            "users",
            vec![
                ("a", column(1, "bigint", false, None, true, "", "")),
                ("b", column(2, "bigint", false, None, true, "", "")),
            ],
        );
        let source_metadata = metadata(
            "",
            Some("source_pk"),
            vec![
                (
                    "a",
                    native_column(false, None, None, None, None, None, None, false, Some(2)),
                ),
                (
                    "b",
                    native_column(false, None, None, None, None, None, None, false, Some(1)),
                ),
            ],
        );
        let target_metadata = metadata(
            "",
            Some("target_pk"),
            vec![
                (
                    "a",
                    native_column(false, None, None, None, None, None, None, false, Some(1)),
                ),
                (
                    "b",
                    native_column(false, None, None, None, None, None, None, false, Some(2)),
                ),
            ],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "dbo",
            source: Some(&snapshot),
            target: Some(&snapshot),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: true,
        });

        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        assert_eq!(plan.operations.len(), 1);
        assert_eq!(plan.operations[0].sql.len(), 1);
        assert!(plan.operations[0].sql[0].contains("PRIMARY KEY ([b], [a])"));
    }

    #[test]
    fn primary_key_column_type_change_rebuilds_constraint_and_obeys_drop_guard() {
        let source = table(
            "users",
            vec![("id", column(1, "bigint", false, None, true, "", ""))],
        );
        let target = table(
            "users",
            vec![("id", column(1, "int", false, None, true, "", ""))],
        );
        let source_metadata = metadata(
            "",
            Some("source_pk"),
            vec![(
                "id",
                native_column(false, None, None, None, None, None, None, false, Some(1)),
            )],
        );
        let target_metadata = metadata(
            "",
            Some("target_pk"),
            vec![(
                "id",
                native_column(false, None, None, None, None, None, None, false, Some(1)),
            )],
        );

        let protected = plan_table(TablePlanContext {
            target_database: "dbo",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });
        assert!(protected.operations.is_empty());
        assert_eq!(protected.blockers.len(), 1);

        let allowed = plan_table(TablePlanContext {
            target_database: "dbo",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: true,
        });
        assert!(allowed.blockers.is_empty(), "{:?}", allowed.blockers);
        assert_eq!(allowed.operations.len(), 1);
        let sql = &allowed.operations[0].sql;
        assert_eq!(sql.len(), 1);
        let batch = &sql[0];
        let drop_position = batch.find("DROP CONSTRAINT [target_pk]").unwrap();
        let alter_position = batch.find("ALTER COLUMN [id] bigint NOT NULL").unwrap();
        let add_position = batch.find("ADD CONSTRAINT").unwrap();
        assert!(drop_position < alter_position && alter_position < add_position);
        assert!(batch.contains("PRIMARY KEY ([id])"));
        assert!(batch.contains("IF XACT_STATE() <> 0 ROLLBACK TRANSACTION"));
    }

    #[test]
    fn native_only_identity_seed_change_is_blocked() {
        let snapshot = table(
            "users",
            vec![(
                "id",
                column(1, "bigint", false, None, false, "identity", ""),
            )],
        );
        let source_metadata = metadata(
            "",
            None,
            vec![(
                "id",
                native_column(
                    true,
                    Some("100"),
                    Some("1"),
                    None,
                    None,
                    None,
                    None,
                    false,
                    None,
                ),
            )],
        );
        let target_metadata = metadata(
            "",
            None,
            vec![(
                "id",
                native_column(
                    true,
                    Some("1"),
                    Some("1"),
                    None,
                    None,
                    None,
                    None,
                    false,
                    None,
                ),
            )],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "dbo",
            source: Some(&snapshot),
            target: Some(&snapshot),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: true,
        });

        assert!(plan.operations.is_empty());
        assert_eq!(plan.blockers.len(), 1);
        assert!(plan.blockers[0].reason.contains("identity"));
    }

    #[test]
    fn target_only_objects_are_skipped_without_drop_sql() {
        let target = table(
            "old]table",
            vec![("id", column(1, "bigint", false, None, false, "", ""))],
        );
        let target_metadata = metadata(
            "",
            None,
            vec![(
                "id",
                native_column(false, None, None, None, None, None, None, false, None),
            )],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "d]bo",
            source: None,
            target: Some(&target),
            source_metadata: None,
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });
        assert!(plan.operations.is_empty());
        assert_eq!(plan.skipped_items.len(), 1);
    }

    fn native_builtin(type_name: &str) -> ColumnSyncMetadata {
        ColumnSyncMetadata::SqlServer {
            is_identity: false,
            identity_seed: None,
            identity_increment: None,
            computed_definition: None,
            default_expression: None,
            default_constraint_name: None,
            default_constraint_is_system_named: None,
            is_user_defined: false,
            type_schema: "sys".to_string(),
            type_name: type_name.to_string(),
            primary_key_ordinal: None,
            is_hidden: false,
            generated_always_type: 0,
            is_sparse: false,
            is_column_set: false,
            is_filestream: false,
            is_rowguidcol: false,
            is_masked: false,
            encryption_type: None,
        }
    }

    #[test]
    fn special_tables_and_columns_are_blocked_instead_of_recreated_as_plain_shapes() {
        let source = table(
            "events",
            vec![("value", column(1, "bigint", false, None, false, "", ""))],
        );
        let special_table_metadata = TableSyncMetadata::SqlServer {
            table_comment: String::new(),
            primary_key_constraint: None,
            temporal_type: 2,
            is_memory_optimized: false,
            is_node: false,
            is_edge: false,
            is_filetable: false,
            columns: BTreeMap::from([(
                "value".to_string(),
                native_column(false, None, None, None, None, None, None, false, None),
            )]),
        };
        let special_column_metadata = TableSyncMetadata::SqlServer {
            table_comment: String::new(),
            primary_key_constraint: None,
            temporal_type: 0,
            is_memory_optimized: false,
            is_node: false,
            is_edge: false,
            is_filetable: false,
            columns: BTreeMap::from([(
                "value".to_string(),
                ColumnSyncMetadata::SqlServer {
                    is_identity: false,
                    identity_seed: None,
                    identity_increment: None,
                    computed_definition: None,
                    default_expression: None,
                    default_constraint_name: None,
                    default_constraint_is_system_named: None,
                    is_user_defined: false,
                    type_schema: "sys".to_string(),
                    type_name: "bigint".to_string(),
                    primary_key_ordinal: None,
                    is_hidden: true,
                    generated_always_type: 2,
                    is_sparse: false,
                    is_column_set: false,
                    is_filestream: false,
                    is_rowguidcol: false,
                    is_masked: false,
                    encryption_type: None,
                },
            )]),
        };

        for source_metadata in [&special_table_metadata, &special_column_metadata] {
            let plan = plan_table(TablePlanContext {
                target_database: "dbo",
                source: Some(&source),
                target: None,
                source_metadata: Some(source_metadata),
                target_metadata: None,
                include_drops: true,
            });
            assert!(plan.operations.is_empty());
            assert_eq!(plan.blockers.len(), 1);
        }
    }

    #[test]
    fn alters_between_builtin_types_instead_of_treating_them_as_udt_change() {
        let source = table(
            "users",
            vec![("value", column(1, "bigint", false, None, false, "", ""))],
        );
        let target = table(
            "users",
            vec![("value", column(1, "int", false, None, false, "", ""))],
        );
        let source_metadata = metadata("", None, vec![("value", native_builtin("bigint"))]);
        let target_metadata = metadata("", None, vec![("value", native_builtin("int"))]);
        let plan = plan_table(TablePlanContext {
            target_database: "dbo",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });

        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        assert_eq!(
            plan.operations[0].sql,
            vec!["ALTER TABLE [dbo].[users] ALTER COLUMN [value] bigint NOT NULL"]
        );
    }

    #[test]
    fn string_default_case_and_parentheses_changes_are_not_normalized_away() {
        for (source_expression, target_expression, expected) in [
            ("(N'Admin')", "(N'admin')", "DEFAULT N'Admin'"),
            ("(N'(x)')", "(N'x')", "DEFAULT N'(x)'"),
        ] {
            let source = table(
                "users",
                vec![(
                    "value",
                    column(
                        1,
                        "nvarchar(20)",
                        false,
                        Some(source_expression),
                        false,
                        "",
                        "",
                    ),
                )],
            );
            let target = table(
                "users",
                vec![(
                    "value",
                    column(
                        1,
                        "nvarchar(20)",
                        false,
                        Some(target_expression),
                        false,
                        "",
                        "",
                    ),
                )],
            );
            let source_metadata = metadata(
                "",
                None,
                vec![(
                    "value",
                    native_column(
                        false,
                        None,
                        None,
                        None,
                        Some(source_expression),
                        Some("DF__source"),
                        Some(true),
                        false,
                        None,
                    ),
                )],
            );
            let target_metadata = metadata(
                "",
                None,
                vec![(
                    "value",
                    native_column(
                        false,
                        None,
                        None,
                        None,
                        Some(target_expression),
                        Some("DF__target"),
                        Some(true),
                        false,
                        None,
                    ),
                )],
            );
            let plan = plan_table(TablePlanContext {
                target_database: "dbo",
                source: Some(&source),
                target: Some(&target),
                source_metadata: Some(&source_metadata),
                target_metadata: Some(&target_metadata),
                include_drops: true,
            });

            assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
            assert!(plan
                .operations
                .iter()
                .flat_map(|operation| &operation.sql)
                .any(|sql| sql.contains(expected)));
        }
    }

    #[test]
    fn equal_default_expression_with_different_explicit_names_is_blocked() {
        let source = table(
            "users",
            vec![(
                "value",
                column(1, "nvarchar(20)", false, Some("(N'value')"), false, "", ""),
            )],
        );
        let target = source.clone();
        let source_metadata = metadata(
            "",
            None,
            vec![(
                "value",
                native_column(
                    false,
                    None,
                    None,
                    None,
                    Some("(N'value')"),
                    Some("DF_source_value"),
                    Some(false),
                    false,
                    None,
                ),
            )],
        );
        let target_metadata = metadata(
            "",
            None,
            vec![(
                "value",
                native_column(
                    false,
                    None,
                    None,
                    None,
                    Some("(N'value')"),
                    Some("DF_target_value"),
                    Some(false),
                    false,
                    None,
                ),
            )],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "dbo",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: true,
        });

        assert!(plan.operations.is_empty());
        assert_eq!(plan.blockers.len(), 1);
        assert!(plan.blockers[0].reason.contains("默认约束名"));
    }

    #[test]
    fn create_with_long_primary_key_uses_bounded_builder_constraint_name() {
        let table_name = "a".repeat(126);
        let source = table(
            &table_name,
            vec![("id", column(1, "bigint", false, None, true, "", ""))],
        );
        let source_metadata = metadata(
            "",
            Some("source_pk"),
            vec![(
                "id",
                native_column(false, None, None, None, None, None, None, false, Some(1)),
            )],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "dbo",
            source: Some(&source),
            target: None,
            source_metadata: Some(&source_metadata),
            target_metadata: None,
            include_drops: true,
        });

        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        let create_sql = &plan.operations[0].sql[0];
        let constraint = create_sql
            .split("CONSTRAINT [")
            .nth(1)
            .and_then(|suffix| suffix.split(']').next())
            .expect("建表 SQL 应包含主键约束名");
        assert!(constraint.chars().count() <= 128);
        assert!(constraint.starts_with("PK_"));
    }

    #[test]
    fn appends_columns_in_source_ordinal_order_and_updates_table_comment() {
        let source = table(
            "users",
            vec![
                ("id", column(1, "bigint", false, None, false, "", "")),
                ("z_first", column(2, "int", false, None, false, "", "")),
                ("a_second", column(3, "int", true, None, false, "", "")),
            ],
        );
        let target = table(
            "users",
            vec![("id", column(1, "bigint", false, None, false, "", ""))],
        );
        let source_metadata = metadata(
            "新注释",
            None,
            source
                .columns
                .iter()
                .map(|(name, _)| {
                    (
                        name.as_str(),
                        native_column(false, None, None, None, None, None, None, false, None),
                    )
                })
                .collect(),
        );
        let target_metadata = metadata(
            "旧注释",
            None,
            vec![(
                "id",
                native_column(false, None, None, None, None, None, None, false, None),
            )],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "dbo",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });

        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        assert_eq!(plan.operations.len(), 2);
        assert_eq!(
            plan.operations[0].sql,
            vec![
                "ALTER TABLE [dbo].[users] ADD [z_first] int NOT NULL".to_string(),
                "ALTER TABLE [dbo].[users] ADD [a_second] int NULL".to_string(),
            ]
        );
        assert_eq!(plan.operations[0].risk, DatabaseSyncRisk::High);
        assert_eq!(
            plan.operations[1].kind,
            DatabaseSyncOperationKind::UpdateComment
        );
    }

    #[test]
    fn default_replacement_limits_lookup_and_ddl_to_escaped_target_names() {
        let source = table(
            "us]ers",
            vec![(
                "val]ue",
                column(1, "bigint", false, Some("((2))"), false, "", ""),
            )],
        );
        let target = table(
            "us]ers",
            vec![(
                "val]ue",
                column(1, "bigint", false, Some("((1))"), false, "", ""),
            )],
        );
        let source_metadata = metadata(
            "",
            None,
            vec![(
                "val]ue",
                native_column(
                    false,
                    None,
                    None,
                    None,
                    Some("((2))"),
                    Some("DF__source"),
                    Some(true),
                    false,
                    None,
                ),
            )],
        );
        let target_metadata = metadata(
            "",
            None,
            vec![(
                "val]ue",
                native_column(
                    false,
                    None,
                    None,
                    None,
                    Some("((1))"),
                    Some("DF_target]value"),
                    Some(false),
                    false,
                    None,
                ),
            )],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "d]bo",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: true,
        });

        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        let sql = &plan.operations[0].sql;
        assert!(
            sql[0].contains("WHERE s.name = N'd]bo' AND o.name = N'us]ers' AND c.name = N'val]ue'")
        );
        assert!(sql[0].contains("ALTER TABLE [d]]bo].[us]]ers] DROP CONSTRAINT"));
        assert!(sql[0].contains(&format!(
            "ALTER TABLE [d]]bo].[us]]ers] ADD CONSTRAINT [{}] DEFAULT 2 FOR [val]]ue]",
            sqlserver_ddl::default_constraint_name("us]ers", "val]ue")
        )));
        assert!(sql[0].contains("ROLLBACK TRANSACTION"));
    }

    #[test]
    fn default_replacement_preserves_legacy_explicit_constraint_name() {
        let source = table(
            "users",
            vec![(
                "value",
                column(1, "bigint", false, Some("((2))"), false, "", ""),
            )],
        );
        let target = table(
            "users",
            vec![(
                "value",
                column(1, "bigint", false, Some("((1))"), false, "", ""),
            )],
        );
        let source_metadata = metadata(
            "",
            None,
            vec![(
                "value",
                native_column(
                    false,
                    None,
                    None,
                    None,
                    Some("((2))"),
                    Some("DF_users_value"),
                    Some(false),
                    false,
                    None,
                ),
            )],
        );
        let target_metadata = metadata(
            "",
            None,
            vec![(
                "value",
                native_column(
                    false,
                    None,
                    None,
                    None,
                    Some("((1))"),
                    Some("DF__users__value"),
                    Some(true),
                    false,
                    None,
                ),
            )],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "dbo",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: true,
        });

        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        assert!(plan.operations[0].sql[0].contains(
            "ALTER TABLE [dbo].[users] ADD CONSTRAINT [DF_users_value] DEFAULT 2 FOR [value]"
        ));
        assert!(plan.operations[0].sql[0].contains("ROLLBACK TRANSACTION"));
    }

    #[test]
    fn isolated_default_replacement_is_blocked_without_drop_permission() {
        let source = table(
            "users",
            vec![(
                "value",
                column(1, "bigint", false, Some("((2))"), false, "", ""),
            )],
        );
        let target = table(
            "users",
            vec![(
                "value",
                column(1, "bigint", false, Some("((1))"), false, "", ""),
            )],
        );
        let source_metadata = metadata(
            "",
            None,
            vec![(
                "value",
                native_column(
                    false,
                    None,
                    None,
                    None,
                    Some("((2))"),
                    Some("DF__source"),
                    Some(true),
                    false,
                    None,
                ),
            )],
        );
        let target_metadata = metadata(
            "",
            None,
            vec![(
                "value",
                native_column(
                    false,
                    None,
                    None,
                    None,
                    Some("((1))"),
                    Some("DF_target_value"),
                    Some(false),
                    false,
                    None,
                ),
            )],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "dbo",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });

        assert!(plan.operations.is_empty());
        assert_eq!(plan.blockers.len(), 1);
        assert!(plan.blockers[0].reason.contains("默认约束"));
    }

    #[test]
    fn adding_default_is_blocked_when_builder_would_emit_conditional_drop() {
        let source = table(
            "users",
            vec![(
                "value",
                column(1, "bigint", false, Some("((2))"), false, "", ""),
            )],
        );
        let target = table(
            "users",
            vec![("value", column(1, "bigint", false, None, false, "", ""))],
        );
        let source_metadata = metadata(
            "",
            None,
            vec![(
                "value",
                native_column(
                    false,
                    None,
                    None,
                    None,
                    Some("((2))"),
                    Some("DF__source"),
                    Some(true),
                    false,
                    None,
                ),
            )],
        );
        let target_metadata = metadata(
            "",
            None,
            vec![(
                "value",
                native_column(false, None, None, None, None, None, None, false, None),
            )],
        );
        let plan = plan_table(TablePlanContext {
            target_database: "dbo",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&source_metadata),
            target_metadata: Some(&target_metadata),
            include_drops: false,
        });

        assert!(plan.operations.is_empty());
        assert_eq!(plan.blockers.len(), 1);
        assert!(plan.blockers[0].reason.contains("默认约束"));
    }
}
