//! PostgreSQL DDL adapter：schema/table/column/primary key 维护语句构建与执行。
//!
//! 设计要点：
//! - 所有标识符通过 `pg_id` 双引号转义；字符串字面值通过 `pg_str` 单引号转义。
//! - PostgreSQL 不支持 MySQL 的 `ENGINE=`、`AFTER col`、`MODIFY COLUMN`，DDL 分支按
//!   PostgreSQL 等价语法生成（无引擎；新增列无 AFTER；改列通过多条
//!   `ALTER COLUMN` 子句组合）。
//! - 调整主键不在循环内逐列查询：先一次性查出当前主键列与约束名，再据此构造
//!   `DROP CONSTRAINT` / `ADD PRIMARY KEY` 语句。
//! - 错误信息走 `format_pg_error` 转中文，常见 SQLState 给出场景化提示。

use crate::db::postgres::{esc_pg_str_external, get_client_with_retry};
use crate::db::sql_utils::pg_id;
use crate::models::types::{AddColumnRequest, AlterColumnRequest, ColumnInfo, CreateTableRequest};
use deadpool_postgres::Pool as PgPool;
use tokio_postgres::error::SqlState;

/// PostgreSQL 系统 schema，禁止删除/重命名。
pub const SYSTEM_SCHEMAS: &[&str] = &[
    "pg_catalog",
    "information_schema",
    "pg_toast",
    "pg_temp_1",
    "pg_toast_temp_1",
];

/// 校验 schema 名是否允许删除/重命名。系统 schema 拒绝；空名拒绝。
pub fn validate_modifiable_schema_name(schema: &str) -> Result<(), String> {
    let s = schema.trim();
    if s.is_empty() {
        return Err("schema 名称不能为空".to_string());
    }
    let lower = s.to_lowercase();
    if SYSTEM_SCHEMAS.iter().any(|sys| *sys == lower) || lower.starts_with("pg_") {
        return Err(format!("禁止修改系统 schema `{}`", s));
    }
    Ok(())
}

/// 校验 schema 创建名：非空、长度上限、字符集合。
pub fn validate_new_schema_name(schema: &str) -> Result<(), String> {
    let s = schema.trim();
    if s.is_empty() {
        return Err("schema 名称不能为空".to_string());
    }
    if s.len() > 63 {
        return Err("schema 名称过长（PostgreSQL 标识符最长 63 字节）".to_string());
    }
    // 防御深度：避免拼接 SQL 时被嵌入分号等危险字符。
    if !s
        .chars()
        .all(|c| c.is_alphanumeric() || c == '_' || c == '-' || c == '$')
    {
        return Err(
            "schema 名称只能包含字母、数字、下划线、连字符和 $（建议使用字母开头）".to_string(),
        );
    }
    Ok(())
}

/// PostgreSQL DDL 错误格式化：把 SQLState 映射为中文场景化描述。
/// 非数据库错误（连接失败等）保留原始信息。
pub fn format_pg_error(action: &str, e: tokio_postgres::Error) -> String {
    if let Some(db_err) = e.as_db_error() {
        let code = db_err.code();
        let detail = db_err.message();
        let mapped = if *code == SqlState::DUPLICATE_TABLE
            || *code == SqlState::DUPLICATE_SCHEMA
            || *code == SqlState::DUPLICATE_OBJECT
            || *code == SqlState::DUPLICATE_COLUMN
        {
            format!("{}失败: 对象已存在: {}", action, detail)
        } else if *code == SqlState::UNDEFINED_TABLE
            || *code == SqlState::UNDEFINED_SCHEMA
            || *code == SqlState::UNDEFINED_COLUMN
            || *code == SqlState::UNDEFINED_OBJECT
        {
            format!("{}失败: 对象不存在: {}", action, detail)
        } else if *code == SqlState::INSUFFICIENT_PRIVILEGE {
            format!("{}失败: 权限不足: {}", action, detail)
        } else if *code == SqlState::DEPENDENT_OBJECTS_STILL_EXIST {
            format!(
                "{}失败: 存在依赖对象（视图、外键、序列等），请先处理依赖或使用 CASCADE: {}",
                action, detail
            )
        } else if *code == SqlState::INVALID_SCHEMA_NAME || *code == SqlState::INVALID_NAME {
            format!("{}失败: 名称非法: {}", action, detail)
        } else if *code == SqlState::READ_ONLY_SQL_TRANSACTION {
            format!("{}失败: 当前连接/事务为只读: {}", action, detail)
        } else if *code == SqlState::NOT_NULL_VIOLATION {
            format!(
                "{}失败: 存在 NULL 行，无法添加 NOT NULL 约束: {}",
                action, detail
            )
        } else {
            format!("{}失败 [{}]: {}", action, code.code(), detail)
        };
        mapped
    } else {
        format!("{}失败: {}", action, e)
    }
}

/// 构建 `CREATE SCHEMA "name"`。
pub fn build_create_schema_sql(schema: &str) -> String {
    format!("CREATE SCHEMA {}", pg_id(schema))
}

/// 构建 `DROP SCHEMA "name" RESTRICT`。RESTRICT 是 PG 默认行为，但显式标记意图，
/// 避免误删带依赖对象的 schema；调用方可在错误中提示用户排查依赖。
pub fn build_drop_schema_sql(schema: &str) -> String {
    format!("DROP SCHEMA {} RESTRICT", pg_id(schema))
}

/// 构建 `ALTER SCHEMA "old" RENAME TO "new"`。
pub fn build_rename_schema_sql(old: &str, new: &str) -> String {
    format!("ALTER SCHEMA {} RENAME TO {}", pg_id(old), pg_id(new))
}

/// 构造单列定义 SQL 片段（不含列名）。
/// 例：`varchar(255) NOT NULL DEFAULT 'guest'`。
/// PostgreSQL 不支持 MySQL 的 `auto_increment`/`COMMENT '...'`：注释通过单独
/// `COMMENT ON COLUMN` 语句维护，因此这里只处理 type/nullable/default。
pub fn build_column_definition(
    column_type: &str,
    nullable: bool,
    default_value: &Option<String>,
) -> String {
    let mut parts: Vec<String> = vec![column_type.trim().to_string()];

    if !nullable {
        parts.push("NOT NULL".to_string());
    }

    if let Some(default) = default_value {
        let trimmed = default.trim();
        if !trimmed.is_empty() {
            let upper = trimmed.to_uppercase();
            // 这些是函数/关键字字面值，不能加引号；保留原样让 PostgreSQL 解析。
            let raw = upper == "NULL"
                || upper.starts_with("CURRENT_TIMESTAMP")
                || upper.starts_with("CURRENT_DATE")
                || upper.starts_with("CURRENT_TIME")
                || upper.starts_with("NOW(")
                || upper == "TRUE"
                || upper == "FALSE";
            if raw || trimmed.parse::<f64>().is_ok() {
                parts.push(format!("DEFAULT {}", trimmed));
            } else {
                parts.push(format!("DEFAULT {}", esc_pg_str_external(trimmed)));
            }
        }
    }

    parts.join(" ")
}

/// 构建 `CREATE TABLE` 完整 SQL（含主键 + 列注释为单独语句列表）。
///
/// 返回 (create_sql, after_sqls)：
/// - `create_sql`: 单条 CREATE TABLE 语句
/// - `after_sqls`: 在 CREATE 之后逐条执行的 `COMMENT ON ...`、`ALTER TABLE ... ADD PRIMARY KEY`、
///   以及表注释；调用方按顺序在同一事务内执行。
pub fn build_create_table_sqls(
    schema: &str,
    request: &CreateTableRequest,
) -> Result<(String, Vec<String>), String> {
    if request.columns.is_empty() {
        return Err("至少需要定义一个列".to_string());
    }

    let mut col_defs: Vec<String> = Vec::with_capacity(request.columns.len());
    let mut after_sqls: Vec<String> = Vec::new();

    for col in &request.columns {
        let def = build_column_definition(&col.column_type, col.nullable, &col.default_value);
        col_defs.push(format!("  {} {}", pg_id(&col.name), def));
        // 列注释（COMMENT 字段）单独通过 COMMENT ON 维护
        if !col.comment.is_empty() {
            after_sqls.push(format!(
                "COMMENT ON COLUMN {}.{}.{} IS {}",
                pg_id(schema),
                pg_id(&request.table_name),
                pg_id(&col.name),
                esc_pg_str_external(&col.comment),
            ));
        }
    }

    let mut create_sql = format!(
        "CREATE TABLE {}.{} (\n{}\n)",
        pg_id(schema),
        pg_id(&request.table_name),
        col_defs.join(",\n")
    );

    if !request.primary_keys.is_empty() {
        // 把主键放进 CREATE TABLE 的 inline 约束，少一次往返
        let pk_cols = request
            .primary_keys
            .iter()
            .map(|k| pg_id(k))
            .collect::<Vec<_>>()
            .join(", ");
        // 重新构造，把 PRIMARY KEY 嵌进列定义末尾
        create_sql = format!(
            "CREATE TABLE {}.{} (\n{},\n  PRIMARY KEY ({})\n)",
            pg_id(schema),
            pg_id(&request.table_name),
            col_defs.join(",\n"),
            pk_cols
        );
    }

    if !request.comment.is_empty() {
        after_sqls.push(format!(
            "COMMENT ON TABLE {}.{} IS {}",
            pg_id(schema),
            pg_id(&request.table_name),
            esc_pg_str_external(&request.comment),
        ));
    }

    Ok((create_sql, after_sqls))
}

/// 构建 `DROP TABLE "schema"."table"`。
pub fn build_drop_table_sql(schema: &str, table: &str) -> String {
    format!("DROP TABLE {}.{}", pg_id(schema), pg_id(table))
}

/// 构建 `TRUNCATE TABLE "schema"."table"`。
pub fn build_truncate_table_sql(schema: &str, table: &str) -> String {
    format!("TRUNCATE TABLE {}.{}", pg_id(schema), pg_id(table))
}

/// 构建 `ALTER TABLE "schema"."old" RENAME TO "new"`。
pub fn build_rename_table_sql(schema: &str, old: &str, new: &str) -> String {
    format!(
        "ALTER TABLE {}.{} RENAME TO {}",
        pg_id(schema),
        pg_id(old),
        pg_id(new)
    )
}

/// 构建 `ALTER TABLE ... ADD COLUMN`。注释通过 COMMENT ON 单独维护。
pub fn build_add_column_sqls(schema: &str, table: &str, request: &AddColumnRequest) -> Vec<String> {
    let def = build_column_definition(
        &request.column_type,
        request.nullable,
        &request.default_value,
    );
    let mut sqls = vec![format!(
        "ALTER TABLE {}.{} ADD COLUMN {} {}",
        pg_id(schema),
        pg_id(table),
        pg_id(&request.name),
        def
    )];
    if !request.comment.is_empty() {
        sqls.push(format!(
            "COMMENT ON COLUMN {}.{}.{} IS {}",
            pg_id(schema),
            pg_id(table),
            pg_id(&request.name),
            esc_pg_str_external(&request.comment)
        ));
    }
    sqls
}

/// 计算修改列时需要执行的 SQL 列表。
///
/// 包含：
/// - 改名（如 `old_name != new_name`）：`RENAME COLUMN`
/// - 改类型：`ALTER COLUMN ... TYPE ... USING ...`
/// - 改 NULL：`SET/DROP NOT NULL`
/// - 改默认值：`SET/DROP DEFAULT`
/// - 改注释：`COMMENT ON COLUMN ... IS ...`
///
/// 主键变化由调用方根据 `current_pk_columns` 单独处理（保持与 MySQL 调用路径一致）。
pub fn build_alter_column_sqls(
    schema: &str,
    table: &str,
    current: &ColumnInfo,
    request: &AlterColumnRequest,
) -> Vec<String> {
    let mut sqls: Vec<String> = Vec::new();
    let target_name = if request.new_name.trim().is_empty() {
        request.old_name.clone()
    } else {
        request.new_name.clone()
    };

    if request.old_name != target_name {
        sqls.push(format!(
            "ALTER TABLE {}.{} RENAME COLUMN {} TO {}",
            pg_id(schema),
            pg_id(table),
            pg_id(&request.old_name),
            pg_id(&target_name)
        ));
    }

    let new_type = request.column_type.trim();
    if !new_type.is_empty() && new_type != current.column_type {
        // USING 子句让 PostgreSQL 在改类型时自动转换；常用类型间一般能直接 cast。
        // 这里不提供 USING 表达式，调用方在数据无法转换时收到错误后可改用原生 SQL 处理。
        sqls.push(format!(
            "ALTER TABLE {}.{} ALTER COLUMN {} TYPE {}",
            pg_id(schema),
            pg_id(table),
            pg_id(&target_name),
            new_type
        ));
    }

    if request.nullable != current.nullable {
        let action = if request.nullable {
            "DROP NOT NULL"
        } else {
            "SET NOT NULL"
        };
        sqls.push(format!(
            "ALTER TABLE {}.{} ALTER COLUMN {} {}",
            pg_id(schema),
            pg_id(table),
            pg_id(&target_name),
            action
        ));
    }

    let new_default = request
        .default_value
        .as_deref()
        .map(str::trim)
        .unwrap_or("");
    let cur_default = current.default_value.as_deref().unwrap_or("");
    if new_default != cur_default {
        if new_default.is_empty() {
            sqls.push(format!(
                "ALTER TABLE {}.{} ALTER COLUMN {} DROP DEFAULT",
                pg_id(schema),
                pg_id(table),
                pg_id(&target_name)
            ));
        } else {
            let upper = new_default.to_uppercase();
            let raw = upper == "NULL"
                || upper.starts_with("CURRENT_TIMESTAMP")
                || upper.starts_with("CURRENT_DATE")
                || upper.starts_with("CURRENT_TIME")
                || upper.starts_with("NOW(")
                || upper == "TRUE"
                || upper == "FALSE"
                || new_default.parse::<f64>().is_ok();
            let value_sql = if raw {
                new_default.to_string()
            } else {
                esc_pg_str_external(new_default)
            };
            sqls.push(format!(
                "ALTER TABLE {}.{} ALTER COLUMN {} SET DEFAULT {}",
                pg_id(schema),
                pg_id(table),
                pg_id(&target_name),
                value_sql
            ));
        }
    }

    if request.comment != current.comment {
        sqls.push(format!(
            "COMMENT ON COLUMN {}.{}.{} IS {}",
            pg_id(schema),
            pg_id(table),
            pg_id(&target_name),
            esc_pg_str_external(&request.comment)
        ));
    }

    sqls
}

/// 构建 `ALTER TABLE ... DROP COLUMN`。
pub fn build_drop_column_sql(schema: &str, table: &str, column: &str) -> String {
    format!(
        "ALTER TABLE {}.{} DROP COLUMN {}",
        pg_id(schema),
        pg_id(table),
        pg_id(column)
    )
}

/// 计算主键调整需要的 SQL 列表（不在循环里逐列查）。
///
/// - `current_pk_columns`：当前主键列（来自一次性查询）
/// - `current_pk_constraint`：当前主键约束名（来自一次性查询，可能为 None）
/// - `target_pk_columns`：目标主键列（顺序敏感）
pub fn build_primary_key_change_sqls(
    schema: &str,
    table: &str,
    current_pk_columns: &[String],
    current_pk_constraint: Option<&str>,
    target_pk_columns: &[String],
) -> Vec<String> {
    let same = current_pk_columns.len() == target_pk_columns.len()
        && current_pk_columns
            .iter()
            .zip(target_pk_columns.iter())
            .all(|(a, b)| a == b);
    if same {
        return Vec::new();
    }

    let mut sqls = Vec::new();
    if let Some(name) = current_pk_constraint {
        sqls.push(format!(
            "ALTER TABLE {}.{} DROP CONSTRAINT {}",
            pg_id(schema),
            pg_id(table),
            pg_id(name)
        ));
    }
    if !target_pk_columns.is_empty() {
        let cols = target_pk_columns
            .iter()
            .map(|c| pg_id(c))
            .collect::<Vec<_>>()
            .join(", ");
        sqls.push(format!(
            "ALTER TABLE {}.{} ADD PRIMARY KEY ({})",
            pg_id(schema),
            pg_id(table),
            cols
        ));
    }
    sqls
}

// ============================
// 异步执行入口（pool -> client）
// ============================

async fn run_sqls(pool: &PgPool, action: &str, sqls: &[String]) -> Result<(), String> {
    let client = get_client_with_retry(pool).await?;
    for sql in sqls {
        client
            .simple_query(sql)
            .await
            .map_err(|e| format_pg_error(action, e))?;
    }
    Ok(())
}

pub async fn create_schema(pool: &PgPool, schema: &str) -> Result<(), String> {
    validate_new_schema_name(schema)?;
    run_sqls(pool, "创建 schema", &[build_create_schema_sql(schema)]).await
}

pub async fn drop_schema(pool: &PgPool, schema: &str) -> Result<(), String> {
    validate_modifiable_schema_name(schema)?;
    run_sqls(pool, "删除 schema", &[build_drop_schema_sql(schema)]).await
}

pub async fn rename_schema(pool: &PgPool, old: &str, new: &str) -> Result<(), String> {
    validate_modifiable_schema_name(old)?;
    validate_new_schema_name(new)?;
    run_sqls(pool, "重命名 schema", &[build_rename_schema_sql(old, new)]).await
}

pub async fn create_table(
    pool: &PgPool,
    schema: &str,
    request: &CreateTableRequest,
) -> Result<(), String> {
    let (create_sql, after_sqls) = build_create_table_sqls(schema, request)?;
    let mut sqls = vec![create_sql];
    sqls.extend(after_sqls);
    run_sqls(pool, "新建表", &sqls).await
}

pub async fn drop_table(pool: &PgPool, schema: &str, table: &str) -> Result<(), String> {
    run_sqls(pool, "删除表", &[build_drop_table_sql(schema, table)]).await
}

pub async fn truncate_table(pool: &PgPool, schema: &str, table: &str) -> Result<(), String> {
    run_sqls(pool, "清空表", &[build_truncate_table_sql(schema, table)]).await
}

pub async fn rename_table(pool: &PgPool, schema: &str, old: &str, new: &str) -> Result<(), String> {
    run_sqls(
        pool,
        "重命名表",
        &[build_rename_table_sql(schema, old, new)],
    )
    .await
}

pub async fn add_column(
    pool: &PgPool,
    schema: &str,
    table: &str,
    request: &AddColumnRequest,
) -> Result<(), String> {
    let sqls = build_add_column_sqls(schema, table, request);
    run_sqls(pool, "新增列", &sqls).await
}

pub async fn drop_column(
    pool: &PgPool,
    schema: &str,
    table: &str,
    column: &str,
) -> Result<(), String> {
    run_sqls(
        pool,
        "删除列",
        &[build_drop_column_sql(schema, table, column)],
    )
    .await
}

/// 修改列：先按一次查询拿到当前列元数据 + 主键约束，再生成最小 SQL 集执行。
pub async fn alter_column(
    pool: &PgPool,
    schema: &str,
    table: &str,
    request: &AlterColumnRequest,
) -> Result<(), String> {
    let client = get_client_with_retry(pool).await?;

    // 1) 当前列定义
    let cols = crate::db::postgres::get_table_structure(pool, schema, table).await?;
    let current = cols
        .into_iter()
        .find(|c| c.name == request.old_name)
        .ok_or_else(|| format!("列 `{}` 不存在", request.old_name))?;

    // 2) 一次性查当前主键列与约束名
    let pk_row = client
        .query_opt(
            "SELECT tc.constraint_name, \
                    COALESCE(string_agg(kcu.column_name, ',' ORDER BY kcu.ordinal_position), '') AS cols \
             FROM information_schema.table_constraints tc \
             LEFT JOIN information_schema.key_column_usage kcu \
                    ON kcu.constraint_schema = tc.constraint_schema \
                   AND kcu.constraint_name = tc.constraint_name \
                   AND kcu.table_schema = tc.table_schema \
                   AND kcu.table_name = tc.table_name \
             WHERE tc.constraint_type = 'PRIMARY KEY' \
               AND tc.table_schema = $1 AND tc.table_name = $2 \
             GROUP BY tc.constraint_name",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format_pg_error("查询主键信息", e))?;

    let (pk_constraint, current_pk_columns): (Option<String>, Vec<String>) = match pk_row {
        Some(row) => {
            let name: String = row.get::<_, String>(0);
            let cols_str: String = row.get::<_, String>(1);
            let cols: Vec<String> = if cols_str.is_empty() {
                Vec::new()
            } else {
                cols_str.split(',').map(|s| s.to_string()).collect()
            };
            (Some(name), cols)
        }
        None => (None, Vec::new()),
    };

    // 3) 计算改列 SQL
    let mut sqls = build_alter_column_sqls(schema, table, &current, request);

    // 4) 处理主键调整
    if let Some(is_primary) = request.is_primary {
        let target_name = if request.new_name.trim().is_empty() {
            request.old_name.clone()
        } else {
            request.new_name.clone()
        };
        let mut target_pk: Vec<String> = current_pk_columns
            .iter()
            .map(|c| {
                if c == &request.old_name {
                    target_name.clone()
                } else {
                    c.clone()
                }
            })
            .collect();
        if is_primary {
            if !target_pk.iter().any(|c| c == &target_name) {
                target_pk.push(target_name.clone());
            }
        } else {
            target_pk.retain(|c| c != &target_name && c != &request.old_name);
        }
        let pk_sqls = build_primary_key_change_sqls(
            schema,
            table,
            &current_pk_columns,
            pk_constraint.as_deref(),
            &target_pk,
        );
        sqls.extend(pk_sqls);
    }

    // 5) 顺序执行（合并到一个事务，确保部分失败时回滚）
    if sqls.is_empty() {
        return Ok(());
    }
    let mut client = get_client_with_retry(pool).await?;
    let tx = client
        .transaction()
        .await
        .map_err(|e| format_pg_error("修改列", e))?;
    for sql in &sqls {
        if let Err(e) = tx.simple_query(sql).await {
            let _ = tx.rollback().await;
            return Err(format_pg_error("修改列", e));
        }
    }
    tx.commit()
        .await
        .map_err(|e| format_pg_error("修改列", e))?;
    Ok(())
}

/// 获取表/视图的可读 DDL（不一定与服务器生成的完全一致，但足以查看与复制）。
/// - 视图：返回 `CREATE OR REPLACE VIEW ... AS <pg_get_viewdef>`
/// - 表：基于 information_schema 重组 CREATE TABLE 文本
pub async fn get_table_definition(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<String, String> {
    let client = get_client_with_retry(pool).await?;
    let kind_row = client
        .query_opt(
            "SELECT c.relkind::text \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 AND c.relname = $2",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format_pg_error("查询表类型", e))?;

    let relkind: String = kind_row
        .ok_or_else(|| format!("表 `{}.{}` 不存在", schema, table))?
        .get(0);

    if relkind == "v" || relkind == "m" {
        let row = client
            .query_one(
                "SELECT pg_get_viewdef(format('%I.%I', $1::text, $2::text)::regclass, true)",
                &[&schema, &table],
            )
            .await
            .map_err(|e| format_pg_error("查询视图定义", e))?;
        let body: String = row.get(0);
        let kw = if relkind == "m" {
            "CREATE MATERIALIZED VIEW"
        } else {
            "CREATE OR REPLACE VIEW"
        };
        return Ok(format!(
            "{} {}.{} AS\n{}",
            kw,
            pg_id(schema),
            pg_id(table),
            body.trim_end()
        ));
    }

    // 普通/分区表：基于现有 ColumnInfo + 主键查询拼装 CREATE TABLE。
    let columns = crate::db::postgres::get_table_structure(pool, schema, table).await?;
    let pks = crate::db::postgres::fetch_primary_keys(pool, schema, table).await?;
    let mut col_defs: Vec<String> = columns
        .iter()
        .map(|c| {
            let def = build_column_definition(&c.column_type, c.nullable, &c.default_value);
            format!("  {} {}", pg_id(&c.name), def)
        })
        .collect();
    if !pks.is_empty() {
        let pk_cols = pks.iter().map(|c| pg_id(c)).collect::<Vec<_>>().join(", ");
        col_defs.push(format!("  PRIMARY KEY ({})", pk_cols));
    }
    let mut sql = format!(
        "CREATE TABLE {}.{} (\n{}\n);",
        pg_id(schema),
        pg_id(table),
        col_defs.join(",\n")
    );

    let comment_row = client
        .query_opt(
            "SELECT pg_catalog.obj_description(format('%I.%I', $1::text, $2::text)::regclass, 'pg_class')",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format_pg_error("查询表注释", e))?;
    if let Some(row) = comment_row {
        if let Some(comment) = row.get::<_, Option<String>>(0) {
            if !comment.is_empty() {
                sql.push_str(&format!(
                    "\nCOMMENT ON TABLE {}.{} IS {};",
                    pg_id(schema),
                    pg_id(table),
                    esc_pg_str_external(&comment)
                ));
            }
        }
    }
    for c in &columns {
        if !c.comment.is_empty() {
            sql.push_str(&format!(
                "\nCOMMENT ON COLUMN {}.{}.{} IS {};",
                pg_id(schema),
                pg_id(table),
                pg_id(&c.name),
                esc_pg_str_external(&c.comment)
            ));
        }
    }

    Ok(sql)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::CreateTableColumnDef;

    fn col(
        name: &str,
        ty: &str,
        nullable: bool,
        default: Option<&str>,
        comment: &str,
    ) -> ColumnInfo {
        ColumnInfo {
            name: name.to_string(),
            column_type: ty.to_string(),
            nullable,
            key: String::new(),
            default_value: default.map(|s| s.to_string()),
            extra: String::new(),
            comment: comment.to_string(),
        }
    }

    #[test]
    fn validate_modifiable_schema_rejects_system() {
        assert!(validate_modifiable_schema_name("pg_catalog").is_err());
        assert!(validate_modifiable_schema_name("information_schema").is_err());
        assert!(validate_modifiable_schema_name("PG_TOAST").is_err());
        assert!(validate_modifiable_schema_name("pg_temp_42").is_err());
        assert!(validate_modifiable_schema_name("").is_err());
        assert!(validate_modifiable_schema_name("public").is_ok());
        assert!(validate_modifiable_schema_name("my_app").is_ok());
    }

    #[test]
    fn validate_new_schema_name_rules() {
        assert!(validate_new_schema_name("app").is_ok());
        assert!(validate_new_schema_name("app_1").is_ok());
        assert!(validate_new_schema_name("中文_schema").is_ok());
        assert!(validate_new_schema_name("").is_err());
        assert!(validate_new_schema_name("a;b").is_err());
        assert!(validate_new_schema_name("\"x\"").is_err());
        let too_long = "a".repeat(64);
        assert!(validate_new_schema_name(&too_long).is_err());
    }

    #[test]
    fn create_schema_sql_uses_pg_identifier() {
        assert_eq!(build_create_schema_sql("app"), "CREATE SCHEMA \"app\"");
        assert_eq!(
            build_create_schema_sql("we\"ird"),
            "CREATE SCHEMA \"we\"\"ird\""
        );
    }

    #[test]
    fn drop_schema_sql_uses_restrict_to_avoid_cascade_loss() {
        assert_eq!(build_drop_schema_sql("app"), "DROP SCHEMA \"app\" RESTRICT");
    }

    #[test]
    fn rename_schema_sql_uses_alter_schema_syntax() {
        assert_eq!(
            build_rename_schema_sql("old", "new"),
            "ALTER SCHEMA \"old\" RENAME TO \"new\""
        );
    }

    #[test]
    fn column_definition_basic() {
        assert_eq!(
            build_column_definition("varchar(255)", true, &None),
            "varchar(255)"
        );
        assert_eq!(
            build_column_definition("integer", false, &None),
            "integer NOT NULL"
        );
        assert_eq!(
            build_column_definition("integer", false, &Some("0".to_string())),
            "integer NOT NULL DEFAULT 0"
        );
        assert_eq!(
            build_column_definition("varchar(10)", true, &Some("guest".to_string())),
            "varchar(10) DEFAULT 'guest'"
        );
        assert_eq!(
            build_column_definition("timestamp", false, &Some("CURRENT_TIMESTAMP".to_string())),
            "timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP"
        );
        assert_eq!(
            build_column_definition("boolean", true, &Some("true".to_string())),
            "boolean DEFAULT true"
        );
    }

    #[test]
    fn column_definition_escapes_quote_in_default() {
        assert_eq!(
            build_column_definition("varchar(50)", true, &Some("it's".to_string())),
            "varchar(50) DEFAULT 'it''s'"
        );
    }

    #[test]
    fn create_table_inlines_primary_key_and_extracts_comments() {
        let req = CreateTableRequest {
            table_name: "users".to_string(),
            columns: vec![
                CreateTableColumnDef {
                    name: "id".to_string(),
                    column_type: "bigint".to_string(),
                    nullable: false,
                    default_value: None,
                    extra: "".to_string(),
                    comment: "主键".to_string(),
                },
                CreateTableColumnDef {
                    name: "name".to_string(),
                    column_type: "varchar(100)".to_string(),
                    nullable: false,
                    default_value: Some("guest".to_string()),
                    extra: "".to_string(),
                    comment: "".to_string(),
                },
            ],
            primary_keys: vec!["id".to_string()],
            engine: "".to_string(),
            comment: "用户表".to_string(),
        };
        let (sql, after) = build_create_table_sqls("public", &req).unwrap();
        assert_eq!(
            sql,
            "CREATE TABLE \"public\".\"users\" (\n  \"id\" bigint NOT NULL,\n  \"name\" varchar(100) NOT NULL DEFAULT 'guest',\n  PRIMARY KEY (\"id\")\n)"
        );
        assert_eq!(after.len(), 2);
        assert_eq!(
            after[0],
            "COMMENT ON COLUMN \"public\".\"users\".\"id\" IS '主键'"
        );
        assert_eq!(
            after[1],
            "COMMENT ON TABLE \"public\".\"users\" IS '用户表'"
        );
    }

    #[test]
    fn create_table_without_primary_keys_skips_constraint() {
        let req = CreateTableRequest {
            table_name: "logs".to_string(),
            columns: vec![CreateTableColumnDef {
                name: "msg".to_string(),
                column_type: "text".to_string(),
                nullable: true,
                default_value: None,
                extra: "".to_string(),
                comment: "".to_string(),
            }],
            primary_keys: vec![],
            engine: "".to_string(),
            comment: "".to_string(),
        };
        let (sql, after) = build_create_table_sqls("public", &req).unwrap();
        assert_eq!(sql, "CREATE TABLE \"public\".\"logs\" (\n  \"msg\" text\n)");
        assert!(after.is_empty());
    }

    #[test]
    fn create_table_rejects_empty_columns() {
        let req = CreateTableRequest {
            table_name: "x".to_string(),
            columns: vec![],
            primary_keys: vec![],
            engine: "".to_string(),
            comment: "".to_string(),
        };
        assert!(build_create_table_sqls("public", &req).is_err());
    }

    #[test]
    fn drop_table_sql_basic() {
        assert_eq!(
            build_drop_table_sql("app", "users"),
            "DROP TABLE \"app\".\"users\""
        );
    }

    #[test]
    fn truncate_table_sql_basic() {
        assert_eq!(
            build_truncate_table_sql("app", "logs"),
            "TRUNCATE TABLE \"app\".\"logs\""
        );
    }

    #[test]
    fn rename_table_sql_basic() {
        assert_eq!(
            build_rename_table_sql("app", "u", "users"),
            "ALTER TABLE \"app\".\"u\" RENAME TO \"users\""
        );
    }

    #[test]
    fn add_column_sql_basic_and_with_comment() {
        let req = AddColumnRequest {
            name: "email".to_string(),
            column_type: "varchar(255)".to_string(),
            nullable: true,
            default_value: None,
            extra: "".to_string(),
            comment: "".to_string(),
            after_column: Some("name".to_string()), // PG 忽略 AFTER 位置
        };
        let sqls = build_add_column_sqls("public", "users", &req);
        assert_eq!(
            sqls,
            vec!["ALTER TABLE \"public\".\"users\" ADD COLUMN \"email\" varchar(255)"]
        );

        let req2 = AddColumnRequest {
            name: "email".to_string(),
            column_type: "varchar(255)".to_string(),
            nullable: false,
            default_value: Some("''".to_string()),
            extra: "".to_string(),
            comment: "邮箱".to_string(),
            after_column: None,
        };
        let sqls2 = build_add_column_sqls("public", "users", &req2);
        assert_eq!(sqls2.len(), 2);
        assert!(sqls2[0].contains("ADD COLUMN \"email\" varchar(255) NOT NULL DEFAULT"));
        assert_eq!(
            sqls2[1],
            "COMMENT ON COLUMN \"public\".\"users\".\"email\" IS '邮箱'"
        );
    }

    #[test]
    fn alter_column_rename_then_type_then_nullable_then_default_then_comment() {
        let current = col("name", "varchar(50)", false, Some("guest"), "");
        let req = AlterColumnRequest {
            old_name: "name".to_string(),
            new_name: "user_name".to_string(),
            column_type: "varchar(100)".to_string(),
            nullable: true,
            default_value: Some("anon".to_string()),
            extra: "".to_string(),
            comment: "用户名".to_string(),
            is_primary: None,
            column_placement: None,
        };
        let sqls = build_alter_column_sqls("public", "users", &current, &req);
        assert_eq!(sqls.len(), 5);
        assert_eq!(
            sqls[0],
            "ALTER TABLE \"public\".\"users\" RENAME COLUMN \"name\" TO \"user_name\""
        );
        assert_eq!(
            sqls[1],
            "ALTER TABLE \"public\".\"users\" ALTER COLUMN \"user_name\" TYPE varchar(100)"
        );
        assert_eq!(
            sqls[2],
            "ALTER TABLE \"public\".\"users\" ALTER COLUMN \"user_name\" DROP NOT NULL"
        );
        assert_eq!(
            sqls[3],
            "ALTER TABLE \"public\".\"users\" ALTER COLUMN \"user_name\" SET DEFAULT 'anon'"
        );
        assert_eq!(
            sqls[4],
            "COMMENT ON COLUMN \"public\".\"users\".\"user_name\" IS '用户名'"
        );
    }

    #[test]
    fn alter_column_no_changes_returns_empty() {
        let current = col("name", "varchar(100)", true, Some("guest"), "用户名");
        let req = AlterColumnRequest {
            old_name: "name".to_string(),
            new_name: "name".to_string(),
            column_type: "varchar(100)".to_string(),
            nullable: true,
            default_value: Some("guest".to_string()),
            extra: "".to_string(),
            comment: "用户名".to_string(),
            is_primary: None,
            column_placement: None,
        };
        assert!(build_alter_column_sqls("public", "users", &current, &req).is_empty());
    }

    #[test]
    fn alter_column_clears_default_when_target_is_empty() {
        let current = col("age", "integer", false, Some("0"), "");
        let req = AlterColumnRequest {
            old_name: "age".to_string(),
            new_name: "age".to_string(),
            column_type: "integer".to_string(),
            nullable: false,
            default_value: None,
            extra: "".to_string(),
            comment: "".to_string(),
            is_primary: None,
            column_placement: None,
        };
        let sqls = build_alter_column_sqls("public", "users", &current, &req);
        assert_eq!(sqls.len(), 1);
        assert_eq!(
            sqls[0],
            "ALTER TABLE \"public\".\"users\" ALTER COLUMN \"age\" DROP DEFAULT"
        );
    }

    #[test]
    fn drop_column_sql_basic() {
        assert_eq!(
            build_drop_column_sql("public", "users", "old"),
            "ALTER TABLE \"public\".\"users\" DROP COLUMN \"old\""
        );
    }

    #[test]
    fn primary_key_change_drops_and_re_adds_when_columns_differ() {
        let sqls = build_primary_key_change_sqls(
            "public",
            "users",
            &["id".to_string()],
            Some("users_pkey"),
            &["id".to_string(), "tenant_id".to_string()],
        );
        assert_eq!(sqls.len(), 2);
        assert_eq!(
            sqls[0],
            "ALTER TABLE \"public\".\"users\" DROP CONSTRAINT \"users_pkey\""
        );
        assert_eq!(
            sqls[1],
            "ALTER TABLE \"public\".\"users\" ADD PRIMARY KEY (\"id\", \"tenant_id\")"
        );
    }

    #[test]
    fn primary_key_change_drops_only_when_target_empty() {
        let sqls = build_primary_key_change_sqls(
            "public",
            "users",
            &["id".to_string()],
            Some("users_pkey"),
            &[],
        );
        assert_eq!(sqls.len(), 1);
        assert!(sqls[0].contains("DROP CONSTRAINT \"users_pkey\""));
    }

    #[test]
    fn primary_key_change_adds_only_when_table_has_none() {
        let sqls = build_primary_key_change_sqls("public", "users", &[], None, &["id".to_string()]);
        assert_eq!(sqls.len(), 1);
        assert_eq!(
            sqls[0],
            "ALTER TABLE \"public\".\"users\" ADD PRIMARY KEY (\"id\")"
        );
    }

    #[test]
    fn primary_key_change_returns_empty_when_no_diff() {
        let sqls = build_primary_key_change_sqls(
            "public",
            "users",
            &["id".to_string()],
            Some("users_pkey"),
            &["id".to_string()],
        );
        assert!(sqls.is_empty());
    }
}
