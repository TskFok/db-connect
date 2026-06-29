use crate::db::dialect::SQLITE_DIALECT;
use crate::db::sql_utils::{
    sqlite_count_query, sqlite_id, sqlite_paginated_select, sqlite_str, validate_column_type,
    validate_where_clause,
};
use crate::models::types::{
    AddColumnRequest, ColumnInfo, ConnectionConfig, CreateTableRequest, QueryResult, SessionInfo,
    SqlCompletionColumn, SqlCompletionMetadata, SqlCompletionTable, SqlExecuteResult, TableInfo,
};
use deadpool_sqlite::{Config as SqliteConfig, Pool, Runtime};
use rusqlite::types::Value as SqliteValue;
use rusqlite::{params_from_iter, OptionalExtension};
use serde_json::Value as JsonValue;
use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::time::Instant;

const JS_MAX_SAFE_INTEGER: i64 = 9007199254740991;
const JS_MIN_SAFE_INTEGER: i64 = -9007199254740991;
const MAX_EXECUTE_SQL_SELECT_ROWS: usize = 100_000;
const SQLITE_NO_PRIMARY_KEY_EDIT_ERROR: &str = "SQLite 表没有主键，无法安全定位要修改的行";
const SQLITE_VIEW_TABLE_OPERATION_ERROR: &str = "SQLite 视图不支持该表操作";

#[derive(Clone)]
pub struct SqlitePoolHandle {
    pub pool: Pool,
}

pub fn sqlite_path_from_config(config: &ConnectionConfig) -> Result<String, String> {
    let path = config
        .sqlite_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "SQLite 连接需要选择数据库文件".to_string())?;
    Ok(path.to_string())
}

pub fn build_sqlite_pool(config: &ConnectionConfig) -> Result<SqlitePoolHandle, String> {
    let path = sqlite_path_from_config(config)?;
    if !Path::new(&path).exists() {
        return Err("SQLite 数据库文件不存在".to_string());
    }
    let cfg = SqliteConfig::new(path);
    let pool = cfg
        .create_pool(Runtime::Tokio1)
        .map_err(|e| format!("构造 SQLite 连接池失败: {}", e))?;
    Ok(SqlitePoolHandle { pool })
}

pub async fn test_pool(pool: &Pool) -> Result<(), String> {
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(|conn| {
        conn.query_row("SELECT 1", [], |_row| Ok(()))
            .map_err(|e| format!("查询测试失败: {}", e))
    })
    .await
    .map_err(|e| format!("SQLite 连接任务失败: {}", e))?
}

pub async fn ping_pool(pool: &Pool) -> bool {
    tokio::time::timeout(std::time::Duration::from_secs(3), test_pool(pool))
        .await
        .is_ok_and(|r| r.is_ok())
}

pub async fn list_databases(pool: &Pool) -> Result<Vec<String>, String> {
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(|conn| {
        let mut stmt = conn
            .prepare("PRAGMA database_list")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("SQLite 查询任务失败: {}", e))?
}

pub async fn run_sql_on_pool(
    pool: &Pool,
    sql: &str,
    read_only: bool,
    start: Instant,
) -> Result<SqlExecuteResult, String> {
    if read_only && !SQLITE_DIALECT.sql_editor_allowed_on_read_only_connection(sql) {
        return Err("当前连接为只读模式，仅允许 SELECT/EXPLAIN/安全 PRAGMA 等读操作".to_string());
    }
    let sql = sql.to_string();
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(move |conn| run_sql_on_conn(conn, &sql, start))
        .await
        .map_err(|e| format!("SQLite SQL 执行任务失败: {}", e))?
}

fn run_sql_on_conn(
    conn: &mut rusqlite::Connection,
    sql: &str,
    start: Instant,
) -> Result<SqlExecuteResult, String> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("执行 SQL 失败: {}", e))?;
    let column_count = stmt.column_count();

    if column_count > 0 {
        let columns = stmt
            .column_names()
            .iter()
            .map(|name| (*name).to_string())
            .collect::<Vec<_>>();
        let mut query = stmt.query([]).map_err(|e| format!("执行查询失败: {}", e))?;
        let mut rows = Vec::new();

        while let Some(row) = query.next().map_err(|e| format!("执行查询失败: {}", e))? {
            if rows.len() >= MAX_EXECUTE_SQL_SELECT_ROWS {
                return Err(format!(
                    "查询结果超过最大行数 {}（与 Excel 导出行上限一致），请使用 LIMIT 或缩小范围后重试",
                    MAX_EXECUTE_SQL_SELECT_ROWS
                ));
            }

            let mut values = Vec::with_capacity(column_count);
            for idx in 0..column_count {
                let value: SqliteValue = row
                    .get(idx)
                    .map_err(|e| format!("读取查询结果失败: {}", e))?;
                values.push(sqlite_value_to_json(&value));
            }
            rows.push(values);
        }

        let elapsed = start.elapsed().as_millis() as u64;
        let row_count = rows.len();
        return Ok(SqlExecuteResult {
            result_type: "select".to_string(),
            columns: Some(columns),
            rows: Some(rows),
            affected_rows: None,
            message: format!("返回 {} 行 (耗时 {}ms)", row_count, elapsed),
            execution_time_ms: elapsed,
        });
    }

    let affected = stmt
        .execute([])
        .map_err(|e| format!("执行 SQL 失败: {}", e))? as u64;
    let elapsed = start.elapsed().as_millis() as u64;

    Ok(SqlExecuteResult {
        result_type: "modify".to_string(),
        columns: None,
        rows: None,
        affected_rows: Some(affected),
        message: format!("执行成功, 影响 {} 行 (耗时 {}ms)", affected, elapsed),
        execution_time_ms: elapsed,
    })
}

pub async fn explain_sql_on_pool(
    pool: &Pool,
    sql: &str,
    analyze: bool,
    start: Instant,
) -> Result<SqlExecuteResult, String> {
    if analyze {
        return Err("SQLite 暂不支持 EXPLAIN ANALYZE".to_string());
    }

    let trimmed = sql.trim();
    let explain_sql = if trimmed.to_uppercase().starts_with("EXPLAIN") {
        trimmed.to_string()
    } else {
        format!("EXPLAIN QUERY PLAN {}", trimmed)
    };
    run_sql_on_pool(pool, &explain_sql, false, start).await
}

pub async fn get_sql_completion_metadata(
    pool: &Pool,
    database: Option<String>,
) -> Result<SqlCompletionMetadata, String> {
    let databases = list_databases(pool).await?;
    let Some(schema) = database
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
    else {
        return Ok(SqlCompletionMetadata {
            databases,
            tables: Vec::new(),
            columns: Vec::new(),
        });
    };

    let schema_id = sqlite_id(&schema);
    let sql = format!(
        "SELECT m.name AS table_name, \
                x.name AS column_name, \
                x.type AS column_type \
         FROM {}.sqlite_schema AS m \
         LEFT JOIN pragma_table_xinfo(m.name, ?1) AS x \
         WHERE m.type IN ('table', 'view') \
           AND m.name NOT LIKE 'sqlite_%' \
         ORDER BY m.name, x.cid",
        schema_id
    );

    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    let (tables, columns) = conn
        .interact(move |conn| {
            let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([schema.as_str()], |row| {
                    Ok((
                        row.get::<_, String>("table_name")?,
                        row.get::<_, Option<String>>("column_name")?,
                        row.get::<_, Option<String>>("column_type")?,
                    ))
                })
                .map_err(|e| e.to_string())?;

            let mut seen_tables = BTreeSet::new();
            let mut tables = Vec::new();
            let mut columns = Vec::new();

            for row in rows {
                let (table_name, column_name, column_type) = row.map_err(|e| e.to_string())?;
                if seen_tables.insert(table_name.clone()) {
                    tables.push(SqlCompletionTable {
                        name: table_name.clone(),
                    });
                }
                if let Some(name) = column_name {
                    columns.push(SqlCompletionColumn {
                        table: table_name,
                        name,
                        data_type: column_type,
                    });
                }
            }

            Ok::<(Vec<SqlCompletionTable>, Vec<SqlCompletionColumn>), String>((tables, columns))
        })
        .await
        .map_err(|e| format!("SQLite 查询任务失败: {}", e))??;

    Ok(SqlCompletionMetadata {
        databases,
        tables,
        columns,
    })
}

pub async fn get_session_info(
    pool: &Pool,
    database: Option<String>,
    _path: Option<String>,
    read_only: bool,
) -> Result<SessionInfo, String> {
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("读取 SQLite 会话信息失败: {}", e))?;
    let version = conn
        .interact(|conn| {
            conn.query_row("SELECT sqlite_version()", [], |row| row.get::<_, String>(0))
                .map_err(|e| format!("读取 SQLite 版本失败: {}", e))
        })
        .await
        .map_err(|e| format!("SQLite 会话信息任务失败: {}", e))??;

    let database = database
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| Some("main".to_string()));

    Ok(SessionInfo {
        version,
        hostname: "local".to_string(),
        server_read_only: read_only,
        max_execution_time_ms: 0,
        time_zone: "local".to_string(),
        database,
        connection_id: 0,
        grant_write_capable: !read_only,
    })
}

pub async fn list_tables(pool: &Pool, database: &str) -> Result<Vec<TableInfo>, String> {
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    let internal_table_pattern = sqlite_str("sqlite_%");
    let sql = format!(
        "SELECT name, \
                CASE WHEN type = 'view' THEN 'VIEW' ELSE 'TABLE' END AS table_type, \
                type, \
                sql \
         FROM {}.sqlite_schema \
         WHERE type IN ('table', 'view') \
           AND name NOT LIKE {} \
         ORDER BY name",
        sqlite_id(database),
        internal_table_pattern
    );

    conn.interact(move |conn| {
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let table_type: String = row.get("table_type")?;
                let object_type: String = row.get("type")?;
                Ok(TableInfo {
                    name: row.get("name")?,
                    table_type,
                    engine: if object_type == "table" {
                        Some("SQLite".to_string())
                    } else {
                        None
                    },
                    rows: None,
                    data_length: None,
                    index_length: None,
                    comment: String::new(),
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("SQLite 查询任务失败: {}", e))?
}

pub async fn get_table_structure(
    pool: &Pool,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    let database = database.to_string();
    let table = table.to_string();

    conn.interact(move |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT name, \
                        type, \
                        \"notnull\", \
                        dflt_value, \
                        pk, \
                        hidden \
                 FROM pragma_table_xinfo(?1, ?2) \
                 ORDER BY cid",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([table.as_str(), database.as_str()], |row| {
                let notnull: i64 = row.get("notnull")?;
                let pk: i64 = row.get("pk")?;
                let hidden: i64 = row.get("hidden")?;
                Ok(ColumnInfo {
                    name: row.get("name")?,
                    column_type: row.get("type")?,
                    nullable: notnull == 0 && pk == 0,
                    key: if pk > 0 {
                        "PRI".to_string()
                    } else {
                        String::new()
                    },
                    default_value: row.get("dflt_value")?,
                    extra: if hidden != 0 {
                        "generated".to_string()
                    } else {
                        String::new()
                    },
                    comment: String::new(),
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("SQLite 查询任务失败: {}", e))?
}

pub fn sqlite_value_to_json(value: &SqliteValue) -> JsonValue {
    match value {
        SqliteValue::Null => JsonValue::Null,
        SqliteValue::Integer(i) => {
            if (JS_MIN_SAFE_INTEGER..=JS_MAX_SAFE_INTEGER).contains(i) {
                serde_json::json!(*i)
            } else {
                JsonValue::String(i.to_string())
            }
        }
        SqliteValue::Real(n) => serde_json::json!(*n),
        SqliteValue::Text(s) => JsonValue::String(s.clone()),
        SqliteValue::Blob(bytes) => JsonValue::String(format!("[binary {} bytes]", bytes.len())),
    }
}

pub fn build_order_by_sql(fields: &[(&str, &str)]) -> String {
    if fields.is_empty() {
        return String::new();
    }
    let mut parts = Vec::new();
    for (column, order) in fields {
        let col = column.trim();
        if col.is_empty() {
            continue;
        }
        let safe_order = if order.to_uppercase() == "DESC" {
            "DESC"
        } else {
            "ASC"
        };
        parts.push(format!("{} {}", sqlite_id(col), safe_order));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", parts.join(", "))
    }
}

pub async fn query_table_count(
    pool: &Pool,
    database: &str,
    table: &str,
    where_clause: Option<String>,
) -> Result<u64, String> {
    let where_sql = build_where_sql(&where_clause)?;
    let count_sql = sqlite_count_query(database, table, &where_sql);
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(move |conn| {
        let count = conn
            .query_row(&count_sql, [], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        Ok(i64_to_u64(count))
    })
    .await
    .map_err(|e| format!("SQLite 查询任务失败: {}", e))?
}

#[allow(clippy::too_many_arguments)]
pub async fn query_table_data(
    pool: &Pool,
    database: &str,
    table: &str,
    page: u32,
    page_size: u32,
    order_sql: String,
    where_clause: Option<String>,
    select_columns: Option<Vec<String>>,
    skip_count: Option<bool>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let where_sql = build_where_sql(&where_clause)?;
    let select_part = build_select_part(&select_columns);
    let offset = (page.saturating_sub(1) as u64) * page_size as u64;
    let count_sql = sqlite_count_query(database, table, &where_sql);
    let data_sql = sqlite_paginated_select(
        &select_part,
        database,
        table,
        &where_sql,
        &order_sql,
        page_size as u64,
        offset,
    );

    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    let (columns, rows, total) = conn
        .interact(move |conn| {
            let total = if skip_count == Some(true) {
                0
            } else {
                let count = conn
                    .query_row(&count_sql, [], |row| row.get::<_, i64>(0))
                    .map_err(|e| e.to_string())?;
                i64_to_u64(count)
            };

            let mut stmt = conn.prepare(&data_sql).map_err(|e| e.to_string())?;
            let columns = stmt
                .column_names()
                .iter()
                .map(|name| (*name).to_string())
                .collect::<Vec<_>>();
            let col_count = stmt.column_count();
            let row_iter = stmt
                .query_map([], |row| {
                    let mut values = Vec::with_capacity(col_count);
                    for idx in 0..col_count {
                        let value: SqliteValue = row.get(idx)?;
                        values.push(sqlite_value_to_json(&value));
                    }
                    Ok(values)
                })
                .map_err(|e| e.to_string())?;
            let mut rows = Vec::new();
            for row in row_iter {
                rows.push(row.map_err(|e| e.to_string())?);
            }
            Ok::<(Vec<String>, Vec<Vec<JsonValue>>, u64), String>((columns, rows, total))
        })
        .await
        .map_err(|e| format!("SQLite 查询任务失败: {}", e))??;

    Ok(QueryResult {
        columns,
        rows,
        total,
        execution_time_ms: start.elapsed().as_millis() as u64,
    })
}

pub async fn get_primary_keys(
    pool: &Pool,
    database: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let database = database.to_string();
    let table = table.to_string();
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(move |conn| get_primary_keys_on_conn(conn, &database, &table))
        .await
        .map_err(|e| format!("SQLite 查询任务失败: {}", e))?
}

fn get_primary_keys_on_conn(
    conn: &rusqlite::Connection,
    database: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT name FROM pragma_table_xinfo(?1, ?2) WHERE pk > 0 ORDER BY pk")
        .map_err(|e| format!("查询主键信息失败: {}", e))?;
    let rows = stmt
        .query_map([table, database], |row| row.get::<_, String>(0))
        .map_err(|e| format!("查询主键信息失败: {}", e))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| format!("读取主键信息失败: {}", e))?);
    }
    Ok(out)
}

pub fn json_to_sqlite_value(value: &JsonValue) -> SqliteValue {
    match value {
        JsonValue::Null => SqliteValue::Null,
        JsonValue::Bool(b) => SqliteValue::Integer(if *b { 1 } else { 0 }),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqliteValue::Integer(i)
            } else if let Some(u) = n.as_u64() {
                if let Ok(i) = i64::try_from(u) {
                    SqliteValue::Integer(i)
                } else {
                    SqliteValue::Real(n.as_f64().unwrap_or(0.0))
                }
            } else {
                SqliteValue::Real(n.as_f64().unwrap_or(0.0))
            }
        }
        JsonValue::String(s) => SqliteValue::Text(s.clone()),
        other => SqliteValue::Text(other.to_string()),
    }
}

fn map_entries(values: &HashMap<String, JsonValue>) -> Vec<(String, SqliteValue)> {
    let mut entries = values
        .iter()
        .map(|(k, v)| (k.clone(), json_to_sqlite_value(v)))
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    entries
}

fn ensure_primary_key_table(primary_key_columns: &[String]) -> Result<(), String> {
    if primary_key_columns.is_empty() {
        Err(SQLITE_NO_PRIMARY_KEY_EDIT_ERROR.to_string())
    } else {
        Ok(())
    }
}

fn ordered_primary_key_entries(
    primary_key_columns: &[String],
    values: &HashMap<String, JsonValue>,
    missing_message: &str,
) -> Result<Vec<(String, SqliteValue)>, String> {
    ensure_primary_key_table(primary_key_columns)?;
    primary_key_columns
        .iter()
        .map(|column| {
            values
                .get(column)
                .map(|value| (column.clone(), json_to_sqlite_value(value)))
                .ok_or_else(|| missing_message.to_string())
        })
        .collect()
}

pub fn build_insert_statement(
    database: &str,
    table: &str,
    entries: &[(String, SqliteValue)],
) -> (String, Vec<SqliteValue>) {
    let columns = entries
        .iter()
        .map(|(column, _)| sqlite_id(column))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = (1..=entries.len())
        .map(|idx| format!("?{}", idx))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO {}.{} ({}) VALUES ({})",
        sqlite_id(database),
        sqlite_id(table),
        columns,
        placeholders
    );
    let params = entries.iter().map(|(_, value)| value.clone()).collect();
    (sql, params)
}

pub fn build_update_statement(
    database: &str,
    table: &str,
    primary_keys: &[(String, SqliteValue)],
    updates: &[(String, SqliteValue)],
) -> (String, Vec<SqliteValue>) {
    let mut idx = 1usize;
    let mut params = Vec::with_capacity(primary_keys.len() + updates.len());

    let set_parts = updates
        .iter()
        .map(|(column, value)| {
            let part = format!("{} = ?{}", sqlite_id(column), idx);
            idx += 1;
            params.push(value.clone());
            part
        })
        .collect::<Vec<_>>();
    let where_parts = primary_keys
        .iter()
        .map(|(column, value)| {
            let part = format!("{} = ?{}", sqlite_id(column), idx);
            idx += 1;
            params.push(value.clone());
            part
        })
        .collect::<Vec<_>>();

    let sql = format!(
        "UPDATE {}.{} SET {} WHERE {}",
        sqlite_id(database),
        sqlite_id(table),
        set_parts.join(", "),
        where_parts.join(" AND ")
    );
    (sql, params)
}

fn build_delete_statement(
    database: &str,
    table: &str,
    primary_keys: &[(String, SqliteValue)],
) -> (String, Vec<SqliteValue>) {
    let where_parts = primary_keys
        .iter()
        .enumerate()
        .map(|(idx, (column, _))| format!("{} = ?{}", sqlite_id(column), idx + 1))
        .collect::<Vec<_>>();
    let sql = format!(
        "DELETE FROM {}.{} WHERE {}",
        sqlite_id(database),
        sqlite_id(table),
        where_parts.join(" AND ")
    );
    let params = primary_keys
        .iter()
        .map(|(_, value)| value.clone())
        .collect::<Vec<_>>();
    (sql, params)
}

pub async fn insert_row(
    pool: &Pool,
    database: &str,
    table: &str,
    values: HashMap<String, JsonValue>,
) -> Result<u64, String> {
    if values.is_empty() {
        return Err("没有提供要插入的数据".to_string());
    }
    let primary_key_columns = get_primary_keys(pool, database, table).await?;
    ensure_primary_key_table(&primary_key_columns)?;

    let entries = map_entries(&values);
    let (sql, params) = build_insert_statement(database, table, &entries);
    execute_write(pool, "插入数据", sql, params).await
}

pub async fn update_row(
    pool: &Pool,
    database: &str,
    table: &str,
    primary_keys: HashMap<String, JsonValue>,
    updates: HashMap<String, JsonValue>,
) -> Result<u64, String> {
    if updates.is_empty() {
        return Err("没有提供要更新的数据".to_string());
    }
    if primary_keys.is_empty() {
        return Err("没有提供主键信息".to_string());
    }

    let primary_key_columns = get_primary_keys(pool, database, table).await?;
    let pk_entries =
        ordered_primary_key_entries(&primary_key_columns, &primary_keys, "存在缺少主键信息的行")?;
    let update_entries = map_entries(&updates);
    let (sql, params) = build_update_statement(database, table, &pk_entries, &update_entries);
    execute_write(pool, "更新数据", sql, params).await
}

#[derive(Debug, Clone)]
pub struct SqliteRowUpdate {
    pub primary_keys: HashMap<String, JsonValue>,
    pub updates: HashMap<String, JsonValue>,
}

pub async fn batch_update_rows(
    pool: &Pool,
    database: &str,
    table: &str,
    rows: Vec<SqliteRowUpdate>,
) -> Result<u64, String> {
    if rows.is_empty() {
        return Err("没有提供要更新的数据".to_string());
    }
    for row in &rows {
        if row.updates.is_empty() {
            return Err("存在没有更新内容的行".to_string());
        }
        if row.primary_keys.is_empty() {
            return Err("存在缺少主键信息的行".to_string());
        }
    }

    let primary_key_columns = get_primary_keys(pool, database, table).await?;
    ensure_primary_key_table(&primary_key_columns)?;
    let statements = rows
        .iter()
        .map(|row| {
            let pk_entries = ordered_primary_key_entries(
                &primary_key_columns,
                &row.primary_keys,
                "存在缺少主键信息的行",
            )?;
            let update_entries = map_entries(&row.updates);
            Ok(build_update_statement(
                database,
                table,
                &pk_entries,
                &update_entries,
            ))
        })
        .collect::<Result<Vec<_>, String>>()?;
    execute_writes_in_transaction(pool, "批量更新", statements).await
}

pub async fn delete_rows(
    pool: &Pool,
    database: &str,
    table: &str,
    primary_keys: Vec<HashMap<String, JsonValue>>,
) -> Result<u64, String> {
    if primary_keys.is_empty() {
        return Err("没有提供要删除的行".to_string());
    }

    let primary_key_columns = get_primary_keys(pool, database, table).await?;
    ensure_primary_key_table(&primary_key_columns)?;
    let statements = primary_keys
        .iter()
        .map(|row| {
            let pk_entries =
                ordered_primary_key_entries(&primary_key_columns, row, "存在主键信息不完整的行")?;
            Ok(build_delete_statement(database, table, &pk_entries))
        })
        .collect::<Result<Vec<_>, String>>()?;
    execute_writes_in_transaction(pool, "删除数据", statements).await
}

pub async fn query_full_rows(
    pool: &Pool,
    database: &str,
    table: &str,
    primary_key_column: &str,
    primary_key_values: Vec<JsonValue>,
) -> Result<QueryResult, String> {
    if primary_key_values.is_empty() {
        return Err("没有提供主键值".to_string());
    }
    let primary_keys = primary_key_values
        .into_iter()
        .map(|value| HashMap::from([(primary_key_column.to_string(), value)]))
        .collect::<Vec<_>>();

    query_full_rows_by_primary_keys(pool, database, table, primary_keys).await
}

pub async fn query_full_rows_by_primary_keys(
    pool: &Pool,
    database: &str,
    table: &str,
    primary_keys: Vec<HashMap<String, JsonValue>>,
) -> Result<QueryResult, String> {
    if primary_keys.is_empty() {
        return Err("没有提供主键信息".to_string());
    }
    let primary_key_columns = get_primary_keys(pool, database, table).await?;
    ensure_primary_key_table(&primary_key_columns)?;

    let start = Instant::now();
    let (sql, params) =
        build_query_full_rows_statement(database, table, &primary_key_columns, &primary_keys)?;

    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    let (columns, rows) = conn
        .interact(move |conn| select_json_rows(conn, &sql, &params))
        .await
        .map_err(|e| format!("SQLite 查询任务失败: {}", e))??;

    Ok(QueryResult {
        total: rows.len() as u64,
        columns,
        rows,
        execution_time_ms: start.elapsed().as_millis() as u64,
    })
}

fn build_query_full_rows_statement(
    database: &str,
    table: &str,
    primary_key_columns: &[String],
    rows: &[HashMap<String, JsonValue>],
) -> Result<(String, Vec<SqliteValue>), String> {
    let mut params = Vec::with_capacity(primary_key_columns.len() * rows.len());
    let mut param_idx = 1usize;
    let where_groups = rows
        .iter()
        .map(|row| {
            let pk_entries =
                ordered_primary_key_entries(primary_key_columns, row, "存在主键信息不完整的行")?;
            let parts = pk_entries
                .into_iter()
                .map(|(column, value)| {
                    let part = format!("{} = ?{}", sqlite_id(&column), param_idx);
                    param_idx += 1;
                    params.push(value);
                    part
                })
                .collect::<Vec<_>>();
            Ok(format!("({})", parts.join(" AND ")))
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok((
        format!(
            "SELECT * FROM {}.{} WHERE {}",
            sqlite_id(database),
            sqlite_id(table),
            where_groups.join(" OR ")
        ),
        params,
    ))
}

fn select_json_rows(
    conn: &rusqlite::Connection,
    sql: &str,
    params: &[SqliteValue],
) -> Result<(Vec<String>, Vec<Vec<JsonValue>>), String> {
    let mut stmt = conn
        .prepare(sql)
        .map_err(|e| format!("查询完整行数据失败: {}", e))?;
    let columns = stmt
        .column_names()
        .iter()
        .map(|name| (*name).to_string())
        .collect::<Vec<_>>();
    let col_count = stmt.column_count();
    let mut query = stmt
        .query(params_from_iter(params.iter()))
        .map_err(|e| format!("查询完整行数据失败: {}", e))?;
    let mut rows = Vec::new();
    while let Some(row) = query
        .next()
        .map_err(|e| format!("查询完整行数据失败: {}", e))?
    {
        let mut values = Vec::with_capacity(col_count);
        for idx in 0..col_count {
            let value: SqliteValue = row
                .get(idx)
                .map_err(|e| format!("读取完整行数据失败: {}", e))?;
            values.push(sqlite_value_to_json(&value));
        }
        rows.push(values);
    }
    Ok((columns, rows))
}

async fn execute_write(
    pool: &Pool,
    action: &str,
    sql: String,
    params: Vec<SqliteValue>,
) -> Result<u64, String> {
    let action = action.to_string();
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(move |conn| {
        conn.execute(&sql, params_from_iter(params.iter()))
            .map(|affected| affected as u64)
            .map_err(|e| format!("{}失败: {}", action, e))
    })
    .await
    .map_err(|e| format!("SQLite 写入任务失败: {}", e))?
}

async fn execute_writes_in_transaction(
    pool: &Pool,
    action: &str,
    statements: Vec<(String, Vec<SqliteValue>)>,
) -> Result<u64, String> {
    let action = action.to_string();
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(move |conn| {
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启事务失败: {}", e))?;
        let mut total = 0u64;
        for (sql, params) in &statements {
            match tx.execute(sql, params_from_iter(params.iter())) {
                Ok(affected) => total += affected as u64,
                Err(e) => {
                    let _ = tx.rollback();
                    return Err(format!("{}失败，已回滚（未提交任何修改）: {}", action, e));
                }
            }
        }
        tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
        Ok(total)
    })
    .await
    .map_err(|e| format!("SQLite 写入任务失败: {}", e))?
}

pub fn build_sqlite_column_definition(
    column_type: &str,
    nullable: bool,
    default_value: &Option<String>,
) -> Result<String, String> {
    validate_column_type(column_type)?;
    let mut parts = vec![column_type.trim().to_string()];
    if !nullable {
        parts.push("NOT NULL".to_string());
    }
    if let Some(default) = default_value.as_deref().map(str::trim) {
        if !default.is_empty() {
            parts.push(format!("DEFAULT {}", sqlite_default_sql(default)?));
        }
    }
    Ok(parts.join(" "))
}

fn sqlite_default_sql(default: &str) -> Result<String, String> {
    if default.contains(';')
        || default.contains("--")
        || default.contains("/*")
        || default.contains("*/")
    {
        return Err("SQLite 默认值包含非法字符".to_string());
    }
    let upper = default.to_uppercase();
    let raw = upper == "NULL"
        || upper == "TRUE"
        || upper == "FALSE"
        || upper.starts_with("CURRENT_TIMESTAMP")
        || upper.starts_with("CURRENT_DATE")
        || upper.starts_with("CURRENT_TIME")
        || default.parse::<f64>().is_ok();
    if raw {
        Ok(default.to_string())
    } else {
        Ok(sqlite_str(default))
    }
}

pub fn build_create_table_sql(
    database: &str,
    request: &CreateTableRequest,
) -> Result<String, String> {
    if request.columns.is_empty() {
        return Err("至少需要定义一个列".to_string());
    }
    let mut parts = request
        .columns
        .iter()
        .map(|column| {
            let def = build_sqlite_column_definition(
                &column.column_type,
                column.nullable,
                &column.default_value,
            )?;
            Ok(format!("  {} {}", sqlite_id(&column.name), def))
        })
        .collect::<Result<Vec<_>, String>>()?;
    if !request.primary_keys.is_empty() {
        let pk_cols = request
            .primary_keys
            .iter()
            .map(|column| sqlite_id(column))
            .collect::<Vec<_>>()
            .join(", ");
        parts.push(format!("  PRIMARY KEY ({})", pk_cols));
    }
    Ok(format!(
        "CREATE TABLE {}.{} (\n{}\n)",
        sqlite_id(database),
        sqlite_id(&request.table_name),
        parts.join(",\n")
    ))
}

pub async fn create_table(
    pool: &Pool,
    database: &str,
    request: &CreateTableRequest,
) -> Result<(), String> {
    let sql = build_create_table_sql(database, request)?;
    execute_ddl(pool, "新建表", sql).await
}

pub fn build_add_column_sql(
    database: &str,
    table: &str,
    request: &AddColumnRequest,
) -> Result<String, String> {
    let def = build_sqlite_column_definition(
        &request.column_type,
        request.nullable,
        &request.default_value,
    )?;
    Ok(format!(
        "ALTER TABLE {}.{} ADD COLUMN {} {}",
        sqlite_id(database),
        sqlite_id(table),
        sqlite_id(&request.name),
        def
    ))
}

pub async fn add_column(
    pool: &Pool,
    database: &str,
    table: &str,
    request: &AddColumnRequest,
) -> Result<(), String> {
    let sql = build_add_column_sql(database, table, request)?;
    execute_table_ddl(pool, "新增列", database, table, sql).await
}

pub async fn drop_column(
    pool: &Pool,
    database: &str,
    table: &str,
    column_name: &str,
) -> Result<(), String> {
    let sql = format!(
        "ALTER TABLE {}.{} DROP COLUMN {}",
        sqlite_id(database),
        sqlite_id(table),
        sqlite_id(column_name)
    );
    execute_table_ddl(pool, "删除列", database, table, sql).await
}

pub async fn drop_table(pool: &Pool, database: &str, table: &str) -> Result<(), String> {
    let sql = format!("DROP TABLE {}.{}", sqlite_id(database), sqlite_id(table));
    execute_table_ddl(pool, "删除表", database, table, sql).await
}

pub async fn rename_table(
    pool: &Pool,
    database: &str,
    old_name: &str,
    new_name: &str,
) -> Result<(), String> {
    let sql = format!(
        "ALTER TABLE {}.{} RENAME TO {}",
        sqlite_id(database),
        sqlite_id(old_name),
        sqlite_id(new_name)
    );
    execute_table_ddl(pool, "重命名表", database, old_name, sql).await
}

pub async fn truncate_table(pool: &Pool, database: &str, table: &str) -> Result<(), String> {
    let sql = format!("DELETE FROM {}.{}", sqlite_id(database), sqlite_id(table));
    execute_table_ddl(pool, "清空表", database, table, sql).await
}

async fn execute_ddl(pool: &Pool, action: &str, sql: String) -> Result<(), String> {
    let action = action.to_string();
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(move |conn| {
        conn.execute(&sql, [])
            .map(|_| ())
            .map_err(|e| format!("{}失败: {}", action, e))
    })
    .await
    .map_err(|e| format!("SQLite DDL 任务失败: {}", e))?
}

async fn execute_table_ddl(
    pool: &Pool,
    action: &str,
    database: &str,
    table: &str,
    sql: String,
) -> Result<(), String> {
    let action = action.to_string();
    let database = database.to_string();
    let table = table.to_string();
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(move |conn| {
        ensure_not_view(conn, &database, &table)?;
        conn.execute(&sql, [])
            .map(|_| ())
            .map_err(|e| format!("{}失败: {}", action, e))
    })
    .await
    .map_err(|e| format!("SQLite DDL 任务失败: {}", e))?
}

fn ensure_not_view(conn: &rusqlite::Connection, database: &str, table: &str) -> Result<(), String> {
    if sqlite_object_type(conn, database, table)?.as_deref() == Some("view") {
        return Err(SQLITE_VIEW_TABLE_OPERATION_ERROR.to_string());
    }
    Ok(())
}

fn sqlite_object_type(
    conn: &rusqlite::Connection,
    database: &str,
    table: &str,
) -> Result<Option<String>, String> {
    let sql = format!(
        "SELECT type FROM {}.sqlite_schema WHERE name = ?1 AND type IN ('table', 'view')",
        sqlite_id(database)
    );
    conn.query_row(&sql, [table], |row| row.get::<_, String>(0))
        .optional()
        .map_err(|e| format!("查询 SQLite 对象类型失败: {}", e))
}

fn build_where_sql(where_clause: &Option<String>) -> Result<String, String> {
    match where_clause {
        Some(w) if !w.trim().is_empty() => {
            validate_where_clause(w)?;
            Ok(format!(" WHERE {}", w))
        }
        _ => Ok(String::new()),
    }
}

fn build_select_part(select_columns: &Option<Vec<String>>) -> String {
    match select_columns {
        Some(cols) if !cols.is_empty() => {
            let columns = cols
                .iter()
                .map(|c| c.trim())
                .filter(|c| !c.is_empty())
                .map(sqlite_id)
                .collect::<Vec<_>>();
            if columns.is_empty() {
                "*".to_string()
            } else {
                columns.join(", ")
            }
        }
        _ => "*".to_string(),
    }
}

fn i64_to_u64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{AddColumnRequest, CreateTableColumnDef, CreateTableRequest};
    use rusqlite::types::Value as SqliteValue;
    use serde_json::Value as JsonValue;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    async fn test_pool_with_schema() -> (Pool, PathBuf) {
        let path = std::env::temp_dir().join(format!("db-connect-{}.sqlite", Uuid::new_v4()));
        fs::File::create(&path).expect("create sqlite test file");
        let cfg = SqliteConfig::new(path.to_str().expect("utf8 sqlite path"));
        let pool = cfg
            .create_pool(Runtime::Tokio1)
            .expect("create sqlite pool");
        let conn = pool.get().await.expect("get sqlite connection");
        conn.interact(|conn| {
            conn.execute_batch(
                "CREATE TABLE users (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL DEFAULT 'anon',
                    age INTEGER,
                    big INTEGER,
                    active INTEGER,
                    profile TEXT,
                    payload BLOB,
                    upper_name TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL
                );
                CREATE TABLE order_items (
                    order_id INTEGER NOT NULL,
                    item_id INTEGER NOT NULL,
                    qty INTEGER NOT NULL,
                    PRIMARY KEY (order_id, item_id)
                );
                CREATE TABLE no_pk (
                    name TEXT
                );
                INSERT INTO users (id, name, age, big, payload)
                VALUES
                    (1, 'Alice', 30, 9007199254740992, X'000102'),
                    (2, 'Bob', 20, 42, X'FF');
                CREATE VIEW adult_users AS
                    SELECT id, name FROM users WHERE age >= 18;",
            )
            .map_err(|e| e.to_string())
        })
        .await
        .expect("sqlite interact")
        .expect("seed sqlite schema");
        drop(conn);
        (pool, path)
    }

    #[tokio::test]
    async fn sqlite_metadata_lists_databases_tables_and_columns() {
        let (pool, path) = test_pool_with_schema().await;

        let databases = list_databases(&pool).await.expect("list databases");
        assert_eq!(databases, vec!["main"]);

        let tables = list_tables(&pool, "main").await.expect("list tables");
        let users = tables
            .iter()
            .find(|t| t.name == "users")
            .expect("users table");
        assert_eq!(users.table_type, "TABLE");
        assert_eq!(users.engine.as_deref(), Some("SQLite"));
        assert_eq!(users.rows, None);
        assert_eq!(users.data_length, None);
        assert_eq!(users.index_length, None);
        assert_eq!(users.comment, "");

        let view = tables
            .iter()
            .find(|t| t.name == "adult_users")
            .expect("adult_users view");
        assert_eq!(view.table_type, "VIEW");
        assert_eq!(view.engine, None);

        let columns = get_table_structure(&pool, "main", "users")
            .await
            .expect("get table structure");
        let id = columns.iter().find(|c| c.name == "id").expect("id column");
        assert_eq!(id.column_type, "INTEGER");
        assert!(!id.nullable);
        assert_eq!(id.key, "PRI");

        let name = columns
            .iter()
            .find(|c| c.name == "name")
            .expect("name column");
        assert_eq!(name.column_type, "TEXT");
        assert!(!name.nullable);
        assert_eq!(name.default_value.as_deref(), Some("'anon'"));

        let generated = columns
            .iter()
            .find(|c| c.name == "upper_name")
            .expect("generated column");
        assert_eq!(generated.extra, "generated");

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_data_queries_count_page_sort_and_convert_values() {
        let (pool, path) = test_pool_with_schema().await;

        let count = query_table_count(&pool, "main", "users", Some("\"age\" >= 20".to_string()))
            .await
            .expect("query count");
        assert_eq!(count, 2);

        let order_sql = build_order_by_sql(&[("age", "DESC"), ("name", "invalid")]);
        assert_eq!(order_sql, " ORDER BY \"age\" DESC, \"name\" ASC");

        let result = query_table_data(
            &pool,
            "main",
            "users",
            1,
            1,
            order_sql,
            Some("\"age\" >= 20".to_string()),
            Some(vec![
                "name".to_string(),
                "big".to_string(),
                "payload".to_string(),
            ]),
            Some(false),
        )
        .await
        .expect("query data");

        assert_eq!(result.columns, vec!["name", "big", "payload"]);
        assert_eq!(result.total, 2);
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], JsonValue::String("Alice".to_string()));
        assert_eq!(
            result.rows[0][1],
            JsonValue::String("9007199254740992".to_string())
        );
        assert_eq!(
            result.rows[0][2],
            JsonValue::String("[binary 3 bytes]".to_string())
        );

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_get_primary_keys_preserves_pk_order_and_blocks_no_pk_writes() {
        let (pool, path) = test_pool_with_schema().await;

        assert_eq!(
            get_primary_keys(&pool, "main", "users")
                .await
                .expect("users primary key"),
            vec!["id".to_string()]
        );
        assert_eq!(
            get_primary_keys(&pool, "main", "order_items")
                .await
                .expect("composite primary key"),
            vec!["order_id".to_string(), "item_id".to_string()]
        );
        assert!(get_primary_keys(&pool, "main", "no_pk")
            .await
            .expect("no pk table")
            .is_empty());

        let mut values = HashMap::new();
        values.insert("name".to_string(), JsonValue::String("orphan".to_string()));
        let err = insert_row(&pool, "main", "no_pk", values)
            .await
            .expect_err("no primary key tables cannot be edited");
        assert_eq!(err, "SQLite 表没有主键，无法安全定位要修改的行");

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_query_full_rows_supports_composite_primary_keys() {
        let (pool, path) = test_pool_with_schema().await;

        insert_row(
            &pool,
            "main",
            "order_items",
            HashMap::from([
                ("order_id".to_string(), serde_json::json!(10)),
                ("item_id".to_string(), serde_json::json!(1)),
                ("qty".to_string(), serde_json::json!(2)),
            ]),
        )
        .await
        .expect("insert first order item");
        insert_row(
            &pool,
            "main",
            "order_items",
            HashMap::from([
                ("order_id".to_string(), serde_json::json!(10)),
                ("item_id".to_string(), serde_json::json!(2)),
                ("qty".to_string(), serde_json::json!(5)),
            ]),
        )
        .await
        .expect("insert second order item");

        let result = query_full_rows_by_primary_keys(
            &pool,
            "main",
            "order_items",
            vec![
                HashMap::from([
                    ("order_id".to_string(), serde_json::json!(10)),
                    ("item_id".to_string(), serde_json::json!(1)),
                ]),
                HashMap::from([
                    ("order_id".to_string(), serde_json::json!(10)),
                    ("item_id".to_string(), serde_json::json!(2)),
                ]),
            ],
        )
        .await
        .expect("query composite primary key rows");

        assert_eq!(result.total, 2);
        let order_id_idx = result
            .columns
            .iter()
            .position(|column| column == "order_id")
            .expect("order_id column");
        let item_id_idx = result
            .columns
            .iter()
            .position(|column| column == "item_id")
            .expect("item_id column");
        let qty_idx = result
            .columns
            .iter()
            .position(|column| column == "qty")
            .expect("qty column");
        assert!(result.rows.iter().any(|row| {
            row[order_id_idx] == serde_json::json!(10)
                && row[item_id_idx] == serde_json::json!(1)
                && row[qty_idx] == serde_json::json!(2)
        }));
        assert!(result.rows.iter().any(|row| {
            row[order_id_idx] == serde_json::json!(10)
                && row[item_id_idx] == serde_json::json!(2)
                && row[qty_idx] == serde_json::json!(5)
        }));

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_crud_binds_params_and_uses_table_primary_keys() {
        let (pool, path) = test_pool_with_schema().await;

        let mut values = HashMap::new();
        values.insert("id".to_string(), serde_json::json!(3));
        values.insert("name".to_string(), JsonValue::String("Cara".to_string()));
        values.insert("age".to_string(), serde_json::json!(25));
        values.insert("active".to_string(), JsonValue::Bool(true));
        values.insert("profile".to_string(), serde_json::json!({"role": "admin"}));
        assert_eq!(
            insert_row(&pool, "main", "users", values)
                .await
                .expect("insert row"),
            1
        );

        let mut pk = HashMap::new();
        pk.insert("id".to_string(), serde_json::json!(3));
        let mut updates = HashMap::new();
        updates.insert("name".to_string(), JsonValue::String("Cora".to_string()));
        updates.insert("age".to_string(), JsonValue::Null);
        assert_eq!(
            update_row(&pool, "main", "users", pk, updates)
                .await
                .expect("update row"),
            1
        );

        let batch_rows = vec![
            SqliteRowUpdate {
                primary_keys: HashMap::from([("id".to_string(), serde_json::json!(1))]),
                updates: HashMap::from([(
                    "name".to_string(),
                    JsonValue::String("Alicia".to_string()),
                )]),
            },
            SqliteRowUpdate {
                primary_keys: HashMap::from([("id".to_string(), serde_json::json!(2))]),
                updates: HashMap::from([(
                    "name".to_string(),
                    JsonValue::String("Bobby".to_string()),
                )]),
            },
        ];
        assert_eq!(
            batch_update_rows(&pool, "main", "users", batch_rows)
                .await
                .expect("batch update rows"),
            2
        );

        let result = query_full_rows(
            &pool,
            "main",
            "users",
            "id",
            vec![serde_json::json!(1), serde_json::json!(3)],
        )
        .await
        .expect("query full rows");
        assert!(result.columns.iter().any(|column| column == "profile"));
        assert_eq!(result.total, 2);
        let id_idx = result
            .columns
            .iter()
            .position(|column| column == "id")
            .expect("id column");
        let name_idx = result
            .columns
            .iter()
            .position(|column| column == "name")
            .expect("name column");
        let profile_idx = result
            .columns
            .iter()
            .position(|column| column == "profile")
            .expect("profile column");
        assert!(result.rows.iter().any(|row| {
            row[id_idx] == serde_json::json!(1)
                && row[name_idx] == JsonValue::String("Alicia".to_string())
        }));
        assert!(result.rows.iter().any(|row| {
            row[id_idx] == serde_json::json!(3)
                && row[name_idx] == JsonValue::String("Cora".to_string())
                && row[profile_idx] == JsonValue::String("{\"role\":\"admin\"}".to_string())
        }));

        assert_eq!(
            delete_rows(
                &pool,
                "main",
                "users",
                vec![HashMap::from([("id".to_string(), serde_json::json!(2))])],
            )
            .await
            .expect("delete rows"),
            1
        );
        let remaining = query_table_count(&pool, "main", "users", None)
            .await
            .expect("remaining count");
        assert_eq!(remaining, 2);

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_table_and_column_ddl_supports_safe_subset() {
        let (pool, path) = test_pool_with_schema().await;

        let request = CreateTableRequest {
            table_name: "ddl_users".to_string(),
            columns: vec![
                CreateTableColumnDef {
                    name: "id".to_string(),
                    column_type: "INTEGER".to_string(),
                    nullable: false,
                    default_value: None,
                    extra: "auto_increment".to_string(),
                    comment: "ignored".to_string(),
                },
                CreateTableColumnDef {
                    name: "name".to_string(),
                    column_type: "TEXT".to_string(),
                    nullable: false,
                    default_value: Some("anon".to_string()),
                    extra: "".to_string(),
                    comment: "".to_string(),
                },
                CreateTableColumnDef {
                    name: "age".to_string(),
                    column_type: "INTEGER".to_string(),
                    nullable: true,
                    default_value: None,
                    extra: "".to_string(),
                    comment: "".to_string(),
                },
            ],
            primary_keys: vec!["id".to_string()],
            engine: "InnoDB".to_string(),
            comment: "ignored".to_string(),
        };
        create_table(&pool, "main", &request)
            .await
            .expect("create table");
        assert_eq!(
            get_primary_keys(&pool, "main", "ddl_users")
                .await
                .expect("created table pk"),
            vec!["id".to_string()]
        );

        add_column(
            &pool,
            "main",
            "ddl_users",
            &AddColumnRequest {
                name: "email".to_string(),
                column_type: "TEXT".to_string(),
                nullable: true,
                default_value: None,
                extra: "ON UPDATE CURRENT_TIMESTAMP".to_string(),
                comment: "ignored".to_string(),
                after_column: Some("name".to_string()),
            },
        )
        .await
        .expect("add column");
        let cols = get_table_structure(&pool, "main", "ddl_users")
            .await
            .expect("columns after add");
        assert!(cols.iter().any(|column| column.name == "email"));

        drop_column(&pool, "main", "ddl_users", "age")
            .await
            .expect("drop column");
        let cols = get_table_structure(&pool, "main", "ddl_users")
            .await
            .expect("columns after drop");
        assert!(!cols.iter().any(|column| column.name == "age"));

        rename_table(&pool, "main", "ddl_users", "ddl_people")
            .await
            .expect("rename table");
        truncate_table(&pool, "main", "ddl_people")
            .await
            .expect("truncate table");
        drop_table(&pool, "main", "ddl_people")
            .await
            .expect("drop table");

        let mut bad_request = request.clone();
        bad_request.table_name = "bad_defaults".to_string();
        bad_request.columns[1].default_value = Some("1; DROP TABLE users".to_string());
        let err = create_table(&pool, "main", &bad_request)
            .await
            .expect_err("unsafe default rejected");
        assert_eq!(err, "SQLite 默认值包含非法字符");

        let err = drop_table(&pool, "main", "adult_users")
            .await
            .expect_err("table operation on view rejected");
        assert_eq!(err, "SQLite 视图不支持该表操作");

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_run_sql_returns_select_rows_and_columns() {
        let (pool, path) = test_pool_with_schema().await;

        let result = run_sql_on_pool(
            &pool,
            "SELECT id, name FROM users ORDER BY id",
            false,
            Instant::now(),
        )
        .await
        .expect("run select");

        assert_eq!(result.result_type, "select");
        assert_eq!(
            result.columns.as_deref(),
            Some(&["id".to_string(), "name".to_string()][..])
        );
        assert_eq!(result.rows.as_ref().expect("rows").len(), 2);
        assert_eq!(result.affected_rows, None);

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_run_sql_returns_affected_rows_for_modify_statement() {
        let (pool, path) = test_pool_with_schema().await;

        let result = run_sql_on_pool(
            &pool,
            "INSERT INTO users (id, name) VALUES (3, 'Cara')",
            false,
            Instant::now(),
        )
        .await
        .expect("run insert");

        assert_eq!(result.result_type, "modify");
        assert_eq!(result.columns, None);
        assert_eq!(result.rows, None);
        assert_eq!(result.affected_rows, Some(1));

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_run_sql_enforces_read_only_sql_allowlist() {
        let (pool, path) = test_pool_with_schema().await;

        let pragma = run_sql_on_pool(&pool, "PRAGMA table_info(users)", true, Instant::now())
            .await
            .expect("readonly pragma");
        assert_eq!(pragma.result_type, "select");

        let err = run_sql_on_pool(
            &pool,
            "INSERT INTO users (id, name) VALUES (4, 'Dora')",
            true,
            Instant::now(),
        )
        .await
        .expect_err("readonly insert rejected");
        assert!(err.contains("只读模式"));

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_run_sql_rejects_select_results_over_row_limit() {
        let (pool, path) = test_pool_with_schema().await;

        let err = run_sql_on_pool(
            &pool,
            "WITH RECURSIVE cnt(x) AS (
                SELECT 1
                UNION ALL
                SELECT x + 1 FROM cnt WHERE x < 100001
            )
            SELECT x FROM cnt",
            false,
            Instant::now(),
        )
        .await
        .expect_err("row limit exceeded");

        assert_eq!(
            err,
            "查询结果超过最大行数 100000（与 Excel 导出行上限一致），请使用 LIMIT 或缩小范围后重试"
        );

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_completion_metadata_lists_databases_only_without_selection() {
        let (pool, path) = test_pool_with_schema().await;

        let metadata = get_sql_completion_metadata(&pool, None)
            .await
            .expect("completion metadata");

        assert_eq!(metadata.databases, vec!["main"]);
        assert!(metadata.tables.is_empty());
        assert!(metadata.columns.is_empty());

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_completion_metadata_uses_batch_schema_query_for_tables_and_columns() {
        let (pool, path) = test_pool_with_schema().await;

        let metadata = get_sql_completion_metadata(&pool, Some("main".to_string()))
            .await
            .expect("completion metadata");

        assert_eq!(metadata.databases, vec!["main"]);
        assert!(metadata.tables.iter().any(|table| table.name == "users"));
        assert!(metadata
            .tables
            .iter()
            .any(|table| table.name == "adult_users"));
        assert!(metadata.columns.iter().any(|column| {
            column.table == "users"
                && column.name == "name"
                && column.data_type.as_deref() == Some("TEXT")
        }));

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_session_info_maps_local_connection_fields() {
        let (pool, path) = test_pool_with_schema().await;

        let info = get_session_info(&pool, None, None, true)
            .await
            .expect("session info");

        assert!(!info.version.is_empty());
        assert_eq!(info.hostname, "local");
        assert!(info.server_read_only);
        assert_eq!(info.max_execution_time_ms, 0);
        assert_eq!(info.time_zone, "local");
        assert_eq!(info.database.as_deref(), Some("main"));
        assert_eq!(info.connection_id, 0);
        assert!(!info.grant_write_capable);

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_explain_uses_query_plan_and_rejects_analyze() {
        let (pool, path) = test_pool_with_schema().await;

        let result = explain_sql_on_pool(
            &pool,
            "SELECT * FROM users WHERE id = 1",
            false,
            Instant::now(),
        )
        .await
        .expect("explain query plan");

        assert_eq!(result.result_type, "select");
        assert_eq!(
            result.columns.as_deref(),
            Some(
                &[
                    "id".to_string(),
                    "parent".to_string(),
                    "notused".to_string(),
                    "detail".to_string(),
                ][..]
            )
        );
        assert!(result.rows.as_ref().is_some_and(|rows| !rows.is_empty()));

        let err = explain_sql_on_pool(
            &pool,
            "SELECT * FROM users WHERE id = 1",
            true,
            Instant::now(),
        )
        .await
        .expect_err("analyze rejected");
        assert_eq!(err, "SQLite 暂不支持 EXPLAIN ANALYZE");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn sqlite_value_to_json_preserves_large_integers_and_binary_display() {
        assert_eq!(
            sqlite_value_to_json(&SqliteValue::Integer(9_007_199_254_740_992)),
            JsonValue::String("9007199254740992".to_string())
        );
        assert_eq!(
            sqlite_value_to_json(&SqliteValue::Blob(vec![1, 2, 3, 4])),
            JsonValue::String("[binary 4 bytes]".to_string())
        );
    }
}
