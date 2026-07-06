//! SQL Server DDL adapter：schema/table/column 管理语句构建与执行。
//!
//! 设计要点：
//! - 标识符统一通过 `sqlserver_id` 方括号转义。
//! - 列类型、extra、default 等裸 SQL 片段做白名单校验。
//! - SQL Server 不支持安全的列重排；`FIRST/AFTER` 直接拒绝。
//! - schema 重命名通过 `CREATE SCHEMA` + `ALTER SCHEMA ... TRANSFER` + `DROP SCHEMA`
//!   实现；对象列表一次性查询，不在遍历中查询 SQL。

use crate::db::sql_utils::{sqlserver_id, sqlserver_str, validate_column_type};
use crate::db::sqlserver::{normalize_sqlserver_error, SqlServerPool};
use crate::models::types::{AddColumnRequest, AlterColumnRequest, ColumnInfo, CreateTableRequest};

const SYSTEM_SCHEMAS: &[&str] = &[
    "sys",
    "information_schema",
    "db_owner",
    "db_accessadmin",
    "db_securityadmin",
    "db_ddladmin",
    "db_backupoperator",
    "db_datareader",
    "db_datawriter",
    "db_denydatareader",
    "db_denydatawriter",
];

pub fn validate_modifiable_schema_name(schema: &str) -> Result<(), String> {
    let s = schema.trim();
    if s.is_empty() {
        return Err("schema 名称不能为空".to_string());
    }
    let lower = s.to_ascii_lowercase();
    if SYSTEM_SCHEMAS.iter().any(|sys| *sys == lower) {
        return Err(format!("禁止修改系统 schema `{}`", s));
    }
    Ok(())
}

pub fn validate_new_schema_name(schema: &str) -> Result<(), String> {
    let s = schema.trim();
    if s.is_empty() {
        return Err("schema 名称不能为空".to_string());
    }
    if s.len() > 128 {
        return Err("schema 名称过长（SQL Server 标识符最长 128 字符）".to_string());
    }
    if !s
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '$')
    {
        return Err(
            "schema 名称只能包含字母、数字、下划线、连字符和 $（建议使用字母开头）".to_string(),
        );
    }
    validate_modifiable_schema_name(s)
}

fn n_str(value: &str) -> String {
    format!("N{}", sqlserver_str(value))
}

fn validate_default_fragment(default: &str) -> Result<(), String> {
    let d = default.trim();
    if d.is_empty() {
        return Ok(());
    }
    if d.len() > 512 {
        return Err("默认值过长".to_string());
    }
    let upper = d.to_ascii_uppercase();
    if d.contains(';')
        || d.contains("--")
        || d.contains("/*")
        || d.contains("*/")
        || upper.contains(" EXEC")
        || upper.starts_with("EXEC")
        || upper.contains("SP_EXECUTESQL")
        || upper.contains("XP_")
        || upper.contains("OPENROWSET")
        || upper.contains("OPENQUERY")
    {
        return Err("默认值包含不安全 SQL 片段".to_string());
    }
    Ok(())
}

fn is_raw_default(default: &str) -> bool {
    let d = default.trim();
    let upper = d.to_ascii_uppercase();
    if upper == "NULL" {
        return true;
    }
    if d.parse::<i64>().is_ok() || d.parse::<f64>().is_ok() {
        return true;
    }
    matches!(
        upper.as_str(),
        "CURRENT_TIMESTAMP"
            | "GETDATE()"
            | "SYSDATETIME()"
            | "SYSUTCDATETIME()"
            | "SYSDATETIMEOFFSET()"
            | "NEWID()"
            | "NEWSEQUENTIALID()"
    )
}

fn default_sql(default_value: &Option<String>) -> Result<Option<String>, String> {
    let Some(default) = default_value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return Ok(None);
    };
    validate_default_fragment(default)?;
    let sql = if is_raw_default(default) {
        default.to_string()
    } else {
        n_str(default)
    };
    Ok(Some(sql))
}

fn no_type_args(args: Option<&str>) -> Result<(), String> {
    if args.is_some() {
        return Err("该 SQL Server 列类型不支持长度或精度参数".to_string());
    }
    Ok(())
}

fn parse_type_parts(column_type: &str) -> Result<(&str, Option<&str>), String> {
    let t = column_type.trim();
    if let Some(open) = t.find('(') {
        if !t.ends_with(')') || t[open + 1..t.len() - 1].contains('(') {
            return Err("SQL Server 列类型格式不正确".to_string());
        }
        let base = t[..open].trim();
        let args = t[open + 1..t.len() - 1].trim();
        if base.is_empty() || args.is_empty() {
            return Err("SQL Server 列类型格式不正确".to_string());
        }
        return Ok((base, Some(args)));
    }
    if t.contains(')') {
        return Err("SQL Server 列类型格式不正确".to_string());
    }
    Ok((t, None))
}

fn parse_u16(value: &str, label: &str) -> Result<u16, String> {
    value
        .trim()
        .parse::<u16>()
        .map_err(|_| format!("SQL Server 列类型{}必须是数字", label))
}

fn validate_integer_arg(args: Option<&str>, min: u16, max: u16, label: &str) -> Result<(), String> {
    let Some(args) = args else {
        return Ok(());
    };
    let n = parse_u16(args, label)?;
    if n < min || n > max {
        return Err(format!(
            "SQL Server 列类型{}必须在 {} 到 {} 之间",
            label, min, max
        ));
    }
    Ok(())
}

fn validate_length_arg(args: Option<&str>, max: u16, allow_max: bool) -> Result<(), String> {
    let Some(args) = args else {
        return Ok(());
    };
    if allow_max && args.eq_ignore_ascii_case("max") {
        return Ok(());
    }
    let len = parse_u16(args, "长度")?;
    if len == 0 || len > max {
        return Err(format!("SQL Server 列类型长度必须在 1 到 {} 之间", max));
    }
    Ok(())
}

fn validate_decimal_args(args: Option<&str>) -> Result<(), String> {
    let Some(args) = args else {
        return Ok(());
    };
    let parts = args.split(',').map(str::trim).collect::<Vec<_>>();
    if parts.is_empty() || parts.len() > 2 || parts.iter().any(|part| part.is_empty()) {
        return Err("SQL Server decimal/numeric 精度格式不正确".to_string());
    }
    let precision = parse_u16(parts[0], "精度")?;
    if precision == 0 || precision > 38 {
        return Err("SQL Server decimal/numeric 精度必须在 1 到 38 之间".to_string());
    }
    if parts.len() == 2 {
        let scale = parse_u16(parts[1], "小数位")?;
        if scale > precision {
            return Err("SQL Server decimal/numeric 小数位不能大于精度".to_string());
        }
    }
    Ok(())
}

fn validate_sqlserver_column_type(column_type: &str) -> Result<(), String> {
    validate_column_type(column_type)?;
    let (base, args) = parse_type_parts(column_type)?;
    let base = base.to_ascii_lowercase();
    match base.as_str() {
        "bigint" | "int" | "smallint" | "tinyint" | "bit" | "money" | "smallmoney" | "real"
        | "date" | "datetime" | "smalldatetime" | "uniqueidentifier" | "rowversion"
        | "timestamp" | "xml" => no_type_args(args),
        "decimal" | "numeric" => validate_decimal_args(args),
        "float" => validate_integer_arg(args, 1, 53, "精度"),
        "char" | "binary" => validate_length_arg(args, 8000, false),
        "varchar" | "varbinary" => validate_length_arg(args, 8000, true),
        "nchar" => validate_length_arg(args, 4000, false),
        "nvarchar" => validate_length_arg(args, 4000, true),
        "time" | "datetime2" | "datetimeoffset" => validate_integer_arg(args, 0, 7, "精度"),
        _ => Err("SQL Server 列类型不在允许的白名单中".to_string()),
    }
}

fn normalize_default(default: Option<&str>) -> String {
    let mut s = default.unwrap_or("").trim().to_string();
    loop {
        let trimmed = s.trim();
        if trimmed.len() >= 2 && trimmed.starts_with('(') && trimmed.ends_with(')') {
            s = trimmed[1..trimmed.len() - 1].trim().to_string();
        } else {
            return trimmed.to_ascii_lowercase();
        }
    }
}

fn validate_extra(extra: &str) -> Result<bool, String> {
    let e = extra.trim();
    if e.is_empty() {
        return Ok(false);
    }
    let compact = e.replace(' ', "").to_ascii_lowercase();
    if compact == "identity" || compact == "identity(1,1)" {
        return Ok(true);
    }
    Err("SQL Server 仅支持 identity 作为列额外属性".to_string())
}

fn build_column_definition(
    column_type: &str,
    nullable: bool,
    default_value: &Option<String>,
    extra: &str,
) -> Result<String, String> {
    validate_sqlserver_column_type(column_type)?;
    let identity = validate_extra(extra)?;
    let mut parts = vec![column_type.trim().to_string()];
    if identity {
        parts.push("IDENTITY(1,1)".to_string());
    }
    parts.push(if nullable { "NULL" } else { "NOT NULL" }.to_string());
    if let Some(default) = default_sql(default_value)? {
        parts.push(format!("DEFAULT {}", default));
    }
    Ok(parts.join(" "))
}

pub fn build_create_schema_sql(schema: &str) -> String {
    format!("CREATE SCHEMA {}", sqlserver_id(schema))
}

pub fn build_drop_schema_sql(schema: &str) -> String {
    format!("DROP SCHEMA {}", sqlserver_id(schema))
}

pub fn build_rename_schema_sqls(
    old: &str,
    new: &str,
    object_names: &[String],
) -> Result<Vec<String>, String> {
    validate_modifiable_schema_name(old)?;
    validate_new_schema_name(new)?;
    let mut sqls = vec![build_create_schema_sql(new)];
    sqls.extend(object_names.iter().map(|object| {
        format!(
            "ALTER SCHEMA {} TRANSFER {}.{}",
            sqlserver_id(new),
            sqlserver_id(old),
            sqlserver_id(object)
        )
    }));
    sqls.push(build_drop_schema_sql(old));
    Ok(sqls)
}

fn primary_key_constraint_name(table: &str) -> String {
    let safe = table
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    format!("PK_{}", safe)
}

fn default_constraint_name(table: &str, column: &str) -> String {
    let raw = format!("DF_{}_{}", table, column);
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .take(120)
        .collect()
}

pub fn build_create_table_sqls(
    schema: &str,
    request: &CreateTableRequest,
) -> Result<(String, Vec<String>), String> {
    if request.columns.is_empty() {
        return Err("至少需要定义一个列".to_string());
    }

    let mut parts = Vec::with_capacity(request.columns.len() + 1);
    let mut after_sqls = Vec::new();
    for col in &request.columns {
        let def = build_column_definition(
            &col.column_type,
            col.nullable,
            &col.default_value,
            &col.extra,
        )?;
        parts.push(format!("  {} {}", sqlserver_id(&col.name), def));
        if !col.comment.trim().is_empty() {
            after_sqls.push(build_upsert_column_comment_sql(
                schema,
                &request.table_name,
                &col.name,
                &col.comment,
            ));
        }
    }

    if !request.primary_keys.is_empty() {
        let pk_cols = request
            .primary_keys
            .iter()
            .map(|c| sqlserver_id(c))
            .collect::<Vec<_>>()
            .join(", ");
        parts.push(format!(
            "  CONSTRAINT {} PRIMARY KEY ({})",
            sqlserver_id(&primary_key_constraint_name(&request.table_name)),
            pk_cols
        ));
    }

    if !request.comment.trim().is_empty() {
        after_sqls.push(build_upsert_table_comment_sql(
            schema,
            &request.table_name,
            &request.comment,
        ));
    }

    Ok((
        format!(
            "CREATE TABLE {}.{} (\n{}\n)",
            sqlserver_id(schema),
            sqlserver_id(&request.table_name),
            parts.join(",\n")
        ),
        after_sqls,
    ))
}

pub fn build_drop_table_sql(schema: &str, table: &str) -> String {
    format!(
        "DROP TABLE {}.{}",
        sqlserver_id(schema),
        sqlserver_id(table)
    )
}

pub fn build_truncate_table_sql(schema: &str, table: &str) -> String {
    format!(
        "TRUNCATE TABLE {}.{}",
        sqlserver_id(schema),
        sqlserver_id(table)
    )
}

pub fn build_delete_all_rows_sql(schema: &str, table: &str) -> String {
    format!(
        "DELETE FROM {}.{}",
        sqlserver_id(schema),
        sqlserver_id(table)
    )
}

pub fn build_clear_table_sql(schema: &str, table: &str, can_truncate: bool) -> String {
    if can_truncate {
        build_truncate_table_sql(schema, table)
    } else {
        build_delete_all_rows_sql(schema, table)
    }
}

pub fn build_rename_table_sql(schema: &str, old: &str, new: &str) -> String {
    format!(
        "EXEC sp_rename N'{}.{}', {}",
        sqlserver_id(schema),
        sqlserver_id(old),
        n_str(new)
    )
}

pub fn build_add_column_sqls(
    schema: &str,
    table: &str,
    request: &AddColumnRequest,
) -> Result<Vec<String>, String> {
    if request.after_column.is_some() {
        return Err("SQL Server 不支持指定新增列位置".to_string());
    }
    let def = build_column_definition(
        &request.column_type,
        request.nullable,
        &request.default_value,
        &request.extra,
    )?;
    let mut sqls = vec![format!(
        "ALTER TABLE {}.{} ADD {} {}",
        sqlserver_id(schema),
        sqlserver_id(table),
        sqlserver_id(&request.name),
        def
    )];
    if !request.comment.trim().is_empty() {
        sqls.push(build_upsert_column_comment_sql(
            schema,
            table,
            &request.name,
            &request.comment,
        ));
    }
    Ok(sqls)
}

pub fn build_drop_column_sql(schema: &str, table: &str, column: &str) -> String {
    format!(
        "{}\nALTER TABLE {}.{} DROP COLUMN {}",
        build_drop_default_constraint_sql(schema, table, column),
        sqlserver_id(schema),
        sqlserver_id(table),
        sqlserver_id(column)
    )
}

pub fn build_drop_default_constraint_sql(schema: &str, table: &str, column: &str) -> String {
    format!(
        "DECLARE @constraintName sysname;\n\
         SELECT @constraintName = dc.name\n\
         FROM sys.default_constraints dc\n\
         JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id\n\
         JOIN sys.objects o ON o.object_id = dc.parent_object_id\n\
         JOIN sys.schemas s ON s.schema_id = o.schema_id\n\
         WHERE s.name = {} AND o.name = {} AND c.name = {};\n\
         IF @constraintName IS NOT NULL EXEC(N'ALTER TABLE {}.{} DROP CONSTRAINT ' + QUOTENAME(@constraintName));",
        n_str(schema),
        n_str(table),
        n_str(column),
        sqlserver_id(schema),
        sqlserver_id(table)
    )
}

fn build_add_default_constraint_sql(
    schema: &str,
    table: &str,
    column: &str,
    default_value: &Option<String>,
) -> Result<Option<String>, String> {
    let Some(default) = default_sql(default_value)? else {
        return Ok(None);
    };
    Ok(Some(format!(
        "ALTER TABLE {}.{} ADD CONSTRAINT {} DEFAULT {} FOR {}",
        sqlserver_id(schema),
        sqlserver_id(table),
        sqlserver_id(&default_constraint_name(table, column)),
        default,
        sqlserver_id(column)
    )))
}

pub fn build_alter_column_sqls(
    schema: &str,
    table: &str,
    current: &ColumnInfo,
    request: &AlterColumnRequest,
) -> Result<Vec<String>, String> {
    if request.is_primary.is_some() {
        return Err(
            "SQL Server 暂不支持通过修改列入口调整主键，请使用专门的索引/约束管理功能".to_string(),
        );
    }
    if request.column_placement.is_some() {
        return Err("SQL Server 不支持调整列顺序".to_string());
    }
    if (validate_extra(&request.extra)? || current.extra.to_ascii_lowercase().contains("identity"))
        && !current.extra.eq_ignore_ascii_case(request.extra.trim())
    {
        return Err("SQL Server 不支持通过 ALTER COLUMN 修改 identity 属性".to_string());
    }

    let mut sqls = Vec::new();
    let target_name = if request.new_name.trim().is_empty() {
        request.old_name.clone()
    } else {
        request.new_name.clone()
    };

    if request.old_name != target_name {
        sqls.push(format!(
            "EXEC sp_rename N'{}.{}.{}', {}, N'COLUMN'",
            sqlserver_id(schema),
            sqlserver_id(table),
            sqlserver_id(&request.old_name),
            n_str(&target_name)
        ));
    }

    if request.column_type.trim() != current.column_type || request.nullable != current.nullable {
        validate_sqlserver_column_type(&request.column_type)?;
        sqls.push(format!(
            "ALTER TABLE {}.{} ALTER COLUMN {} {} {}",
            sqlserver_id(schema),
            sqlserver_id(table),
            sqlserver_id(&target_name),
            request.column_type.trim(),
            if request.nullable { "NULL" } else { "NOT NULL" }
        ));
    }

    let new_default = normalize_default(request.default_value.as_deref());
    let cur_default = normalize_default(current.default_value.as_deref());
    if new_default != cur_default {
        sqls.push(build_drop_default_constraint_sql(
            schema,
            table,
            &target_name,
        ));
        if let Some(add_default) =
            build_add_default_constraint_sql(schema, table, &target_name, &request.default_value)?
        {
            sqls.push(add_default);
        }
    }

    if request.comment != current.comment {
        sqls.push(build_upsert_column_comment_sql(
            schema,
            table,
            &target_name,
            &request.comment,
        ));
    }

    Ok(sqls)
}

pub fn build_upsert_table_comment_sql(schema: &str, table: &str, comment: &str) -> String {
    format!(
        "IF EXISTS (SELECT 1 FROM sys.extended_properties ep \
          JOIN sys.objects o ON o.object_id = ep.major_id \
          JOIN sys.schemas s ON s.schema_id = o.schema_id \
          WHERE ep.class = 1 AND ep.minor_id = 0 AND ep.name = N'MS_Description' \
            AND s.name = {} AND o.name = {}) \
         EXEC sys.sp_updateextendedproperty @name=N'MS_Description', @value = {}, \
           @level0type=N'SCHEMA', @level0name={}, @level1type=N'TABLE', @level1name={}; \
         ELSE \
         EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value = {}, \
           @level0type=N'SCHEMA', @level0name={}, @level1type=N'TABLE', @level1name={};",
        n_str(schema),
        n_str(table),
        n_str(comment),
        n_str(schema),
        n_str(table),
        n_str(comment),
        n_str(schema),
        n_str(table)
    )
}

pub fn build_upsert_column_comment_sql(
    schema: &str,
    table: &str,
    column: &str,
    comment: &str,
) -> String {
    format!(
        "IF EXISTS (SELECT 1 FROM sys.extended_properties ep \
          JOIN sys.objects o ON o.object_id = ep.major_id \
          JOIN sys.schemas s ON s.schema_id = o.schema_id \
          JOIN sys.columns c ON c.object_id = o.object_id AND c.column_id = ep.minor_id \
          WHERE ep.class = 1 AND ep.name = N'MS_Description' \
            AND s.name = {} AND o.name = {} AND c.name = {}) \
         EXEC sys.sp_updateextendedproperty @name=N'MS_Description', @value = {}, \
           @level0type=N'SCHEMA', @level0name={}, @level1type=N'TABLE', @level1name={}, \
           @level2type=N'COLUMN', @level2name={}; \
         ELSE \
         EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value = {}, \
           @level0type=N'SCHEMA', @level0name={}, @level1type=N'TABLE', @level1name={}, \
           @level2type=N'COLUMN', @level2name={};",
        n_str(schema),
        n_str(table),
        n_str(column),
        n_str(comment),
        n_str(schema),
        n_str(table),
        n_str(column),
        n_str(comment),
        n_str(schema),
        n_str(table),
        n_str(column)
    )
}

async fn run_sqls(pool: &SqlServerPool, action: &str, sqls: &[String]) -> Result<(), String> {
    let mut client = pool
        .get()
        .await
        .map_err(|e| normalize_sqlserver_error("获取连接失败", e.to_string()))?;
    for sql in sqls {
        client
            .simple_query(sql)
            .await
            .map_err(|e| normalize_sqlserver_error(action, e.to_string()))?
            .into_results()
            .await
            .map_err(|e| normalize_sqlserver_error(action, e.to_string()))?;
    }
    Ok(())
}

pub async fn create_schema(pool: &SqlServerPool, schema: &str) -> Result<(), String> {
    validate_new_schema_name(schema)?;
    run_sqls(pool, "创建 schema 失败", &[build_create_schema_sql(schema)]).await
}

pub async fn drop_schema(pool: &SqlServerPool, schema: &str) -> Result<(), String> {
    validate_modifiable_schema_name(schema)?;
    run_sqls(pool, "删除 schema 失败", &[build_drop_schema_sql(schema)]).await
}

async fn list_schema_objects(pool: &SqlServerPool, schema: &str) -> Result<Vec<String>, String> {
    let mut client = pool
        .get()
        .await
        .map_err(|e| normalize_sqlserver_error("获取连接失败", e.to_string()))?;
    let sql = format!(
        "SELECT o.name \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = {} \
           AND o.is_ms_shipped = 0 \
           AND o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'TR', 'SQ') \
         ORDER BY CASE WHEN o.type = 'TR' THEN 1 ELSE 0 END, o.name",
        n_str(schema)
    );
    let rows = client
        .simple_query(sql)
        .await
        .map_err(|e| normalize_sqlserver_error("查询 schema 对象失败", e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| normalize_sqlserver_error("读取 schema 对象失败", e.to_string()))?;
    Ok(rows
        .iter()
        .filter_map(|row| row.get::<&str, _>("name").map(str::to_string))
        .collect())
}

pub async fn rename_schema(pool: &SqlServerPool, old: &str, new: &str) -> Result<(), String> {
    let objects = list_schema_objects(pool, old).await?;
    let sqls = build_rename_schema_sqls(old, new, &objects)?;
    run_sqls(pool, "重命名 schema 失败", &sqls).await
}

pub async fn create_table(
    pool: &SqlServerPool,
    schema: &str,
    request: &CreateTableRequest,
) -> Result<(), String> {
    let (create_sql, after_sqls) = build_create_table_sqls(schema, request)?;
    let mut sqls = vec![create_sql];
    sqls.extend(after_sqls);
    run_sqls(pool, "新建表失败", &sqls).await
}

pub async fn drop_table(pool: &SqlServerPool, schema: &str, table: &str) -> Result<(), String> {
    run_sqls(pool, "删除表失败", &[build_drop_table_sql(schema, table)]).await
}

async fn table_can_truncate(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
) -> Result<bool, String> {
    let mut client = pool
        .get()
        .await
        .map_err(|e| normalize_sqlserver_error("获取连接失败", e.to_string()))?;
    let sql = format!(
        "SELECT o.type AS object_type, \
                CAST(CASE WHEN EXISTS ( \
                  SELECT 1 FROM sys.foreign_keys fk \
                  WHERE fk.referenced_object_id = o.object_id \
                ) THEN 1 ELSE 0 END AS bit) AS has_foreign_key_references \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = {} AND o.name = {} AND o.type IN ('U', 'V')",
        n_str(schema),
        n_str(table)
    );
    let row = client
        .simple_query(sql)
        .await
        .map_err(|e| normalize_sqlserver_error("查询表清空条件失败", e.to_string()))?
        .into_row()
        .await
        .map_err(|e| normalize_sqlserver_error("读取表清空条件失败", e.to_string()))?;
    let Some(row) = row else {
        return Err(format!("SQL Server 表 `{}`.`{}` 不存在", schema, table));
    };
    let object_type = row.get::<&str, _>("object_type").unwrap_or("");
    if object_type == "V" {
        return Err("SQL Server 视图不支持清空表操作".to_string());
    }
    if object_type != "U" {
        return Err(format!("SQL Server 表 `{}`.`{}` 不存在", schema, table));
    }
    Ok(!row
        .get::<bool, _>("has_foreign_key_references")
        .unwrap_or(false))
}

pub async fn truncate_table(pool: &SqlServerPool, schema: &str, table: &str) -> Result<(), String> {
    let can_truncate = table_can_truncate(pool, schema, table).await?;
    run_sqls(
        pool,
        "清空表失败",
        &[build_clear_table_sql(schema, table, can_truncate)],
    )
    .await
}

pub async fn rename_table(
    pool: &SqlServerPool,
    schema: &str,
    old: &str,
    new: &str,
) -> Result<(), String> {
    run_sqls(
        pool,
        "重命名表失败",
        &[build_rename_table_sql(schema, old, new)],
    )
    .await
}

pub async fn add_column(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
    request: &AddColumnRequest,
) -> Result<(), String> {
    let sqls = build_add_column_sqls(schema, table, request)?;
    run_sqls(pool, "新增列失败", &sqls).await
}

pub async fn drop_column(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
    column: &str,
) -> Result<(), String> {
    run_sqls(
        pool,
        "删除列失败",
        &[build_drop_column_sql(schema, table, column)],
    )
    .await
}

pub async fn alter_column(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
    request: &AlterColumnRequest,
) -> Result<(), String> {
    let columns = crate::db::sqlserver::get_table_structure(pool, schema, table).await?;
    let current = columns
        .into_iter()
        .find(|c| c.name == request.old_name)
        .ok_or_else(|| format!("列 `{}` 不存在", request.old_name))?;
    let sqls = build_alter_column_sqls(schema, table, &current, request)?;
    if sqls.is_empty() {
        return Ok(());
    }
    run_sqls(pool, "修改列失败", &sqls).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{
        AddColumnRequest, AlterColumnRequest, ColumnInfo, CreateTableColumnDef, CreateTableRequest,
    };

    fn col(
        name: &str,
        ty: &str,
        nullable: bool,
        default: Option<&str>,
        extra: &str,
        comment: &str,
    ) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            column_type: ty.to_string(),
            nullable,
            key: String::new(),
            default_value: default.map(str::to_string),
            extra: extra.to_string(),
            comment: comment.to_string(),
        }
    }

    #[test]
    fn schema_sql_uses_bracket_identifiers_and_system_schema_guard() {
        assert_eq!(build_create_schema_sql("app"), "CREATE SCHEMA [app]");
        assert_eq!(
            build_rename_schema_sqls("old]name", "new", &["users".to_string()]).unwrap(),
            vec![
                "CREATE SCHEMA [new]".to_string(),
                "ALTER SCHEMA [new] TRANSFER [old]]name].[users]".to_string(),
                "DROP SCHEMA [old]]name]".to_string(),
            ]
        );
        assert!(validate_modifiable_schema_name("sys").is_err());
        assert!(validate_modifiable_schema_name("INFORMATION_SCHEMA").is_err());
        assert!(validate_new_schema_name("app_schema").is_ok());
        assert!(validate_new_schema_name("a;b").is_err());
    }

    #[test]
    fn create_table_supports_identity_defaults_primary_key_and_comments() {
        let request = CreateTableRequest {
            table_name: "users".to_string(),
            columns: vec![
                CreateTableColumnDef {
                    name: "id".to_string(),
                    column_type: "bigint".to_string(),
                    nullable: false,
                    default_value: None,
                    extra: "identity".to_string(),
                    comment: "主键".to_string(),
                },
                CreateTableColumnDef {
                    name: "name".to_string(),
                    column_type: "nvarchar(255)".to_string(),
                    nullable: false,
                    default_value: Some("guest".to_string()),
                    extra: "".to_string(),
                    comment: "用户名".to_string(),
                },
            ],
            primary_keys: vec!["id".to_string()],
            engine: "".to_string(),
            order_by: None,
            comment: "用户表".to_string(),
        };

        let (create_sql, after_sqls) = build_create_table_sqls("dbo", &request).unwrap();

        assert_eq!(
            create_sql,
            "CREATE TABLE [dbo].[users] (\n  [id] bigint IDENTITY(1,1) NOT NULL,\n  [name] nvarchar(255) NOT NULL DEFAULT N'guest',\n  CONSTRAINT [PK_users] PRIMARY KEY ([id])\n)"
        );
        assert_eq!(after_sqls.len(), 3);
        assert!(after_sqls[0].contains("@value = N'主键'"));
        assert!(after_sqls[1].contains("@value = N'用户名'"));
        assert!(after_sqls[2].contains("@value = N'用户表'"));
    }

    #[test]
    fn create_table_rejects_dangerous_default_fragments() {
        let request = CreateTableRequest {
            table_name: "users".to_string(),
            columns: vec![CreateTableColumnDef {
                name: "name".to_string(),
                column_type: "nvarchar(255)".to_string(),
                nullable: true,
                default_value: Some("x'; DROP TABLE dbo.users;--".to_string()),
                extra: "".to_string(),
                comment: "".to_string(),
            }],
            primary_keys: vec![],
            engine: "".to_string(),
            order_by: None,
            comment: "".to_string(),
        };

        assert!(build_create_table_sqls("dbo", &request).is_err());
    }

    #[test]
    fn create_table_rejects_non_whitelisted_sqlserver_column_types() {
        assert!(validate_sqlserver_column_type("nvarchar(255)").is_ok());
        assert!(validate_sqlserver_column_type("datetime2(7)").is_ok());
        assert!(validate_sqlserver_column_type("varbinary(max)").is_ok());
        assert!(
            validate_sqlserver_column_type("nvarchar(255) COLLATE Latin1_General_CI_AS").is_err()
        );
        assert!(validate_sqlserver_column_type("enum('a','b')").is_err());
        assert!(validate_sqlserver_column_type("decimal(39,2)").is_err());
    }

    #[test]
    fn table_sqls_use_sqlserver_syntax() {
        assert_eq!(
            build_drop_table_sql("dbo", "users"),
            "DROP TABLE [dbo].[users]"
        );
        assert_eq!(
            build_rename_table_sql("dbo", "old", "new"),
            "EXEC sp_rename N'[dbo].[old]', N'new'"
        );
        assert_eq!(
            build_truncate_table_sql("dbo", "logs"),
            "TRUNCATE TABLE [dbo].[logs]"
        );
        assert_eq!(
            build_clear_table_sql("dbo", "logs", true),
            "TRUNCATE TABLE [dbo].[logs]"
        );
        assert_eq!(
            build_clear_table_sql("dbo", "logs", false),
            "DELETE FROM [dbo].[logs]"
        );
    }

    #[test]
    fn column_sqls_support_add_alter_drop_and_reject_reordering() {
        let add = AddColumnRequest {
            name: "email".to_string(),
            column_type: "varchar(255)".to_string(),
            nullable: true,
            default_value: None,
            extra: "".to_string(),
            comment: "邮箱".to_string(),
            after_column: None,
        };
        let add_sqls = build_add_column_sqls("dbo", "users", &add).unwrap();
        assert_eq!(
            add_sqls[0],
            "ALTER TABLE [dbo].[users] ADD [email] varchar(255) NULL"
        );
        assert!(add_sqls[1].contains("@value = N'邮箱'"));

        let current = col("name", "nvarchar(100)", false, Some("guest"), "", "");
        let req = AlterColumnRequest {
            old_name: "name".to_string(),
            new_name: "display_name".to_string(),
            column_type: "nvarchar(200)".to_string(),
            nullable: true,
            default_value: None,
            extra: "".to_string(),
            comment: "显示名".to_string(),
            is_primary: None,
            column_placement: None,
        };
        let alter_sqls = build_alter_column_sqls("dbo", "users", &current, &req).unwrap();
        assert_eq!(
            alter_sqls[0],
            "EXEC sp_rename N'[dbo].[users].[name]', N'display_name', N'COLUMN'"
        );
        assert!(alter_sqls.contains(
            &"ALTER TABLE [dbo].[users] ALTER COLUMN [display_name] nvarchar(200) NULL".to_string()
        ));
        assert!(alter_sqls.iter().any(|sql| sql.contains("DROP CONSTRAINT")));
        assert!(alter_sqls
            .iter()
            .any(|sql| sql.contains("@value = N'显示名'")));

        let drop_column_sql = build_drop_column_sql("dbo", "users", "email");
        assert!(drop_column_sql.contains("DROP CONSTRAINT"));
        assert!(drop_column_sql.contains("ALTER TABLE [dbo].[users] DROP COLUMN [email]"));

        let mut reorder_req = req.clone();
        reorder_req.column_placement = Some(crate::models::types::AlterColumnPlacement::First);
        assert!(build_alter_column_sqls("dbo", "users", &current, &reorder_req).is_err());

        let mut positioned_add = add;
        positioned_add.after_column = Some("name".to_string());
        assert!(build_add_column_sqls("dbo", "users", &positioned_add).is_err());

        let mut primary_req = req;
        primary_req.is_primary = Some(true);
        assert_eq!(
            build_alter_column_sqls("dbo", "users", &current, &primary_req)
                .expect_err("SQL Server should reject primary key changes in alter column"),
            "SQL Server 暂不支持通过修改列入口调整主键，请使用专门的索引/约束管理功能"
        );
    }
}
