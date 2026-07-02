use crate::db::connection::{get_conn_with_retry, DatabasePoolHandle};
use crate::db::sql_utils::{
    esc_id, esc_str, mysql_count_query, mysql_paginated_select,
    mysql_sql_editor_allowed_on_read_only_connection, validate_where_clause,
};
use crate::db::{postgres, sqlite, sqlserver};
use crate::models::types::{QueryResult, SessionInfo, SqlExecuteResult};
use crate::{AppState, RunningQuery};
use mysql_async::prelude::*;
use mysql_async::Row;
use mysql_async::Value as MyValue;
use serde::Deserialize;
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::time::Instant;
use tauri::State;

// ─── 辅助函数 ──────────────────────────────────────────────────────────

/// JavaScript Number.MAX_SAFE_INTEGER (2^53 - 1)，超出此范围的整数在 JSON 中以字符串形式保留，避免前端精度丢失
const JS_MAX_SAFE_INTEGER: i64 = 9007199254740991;
const JS_MIN_SAFE_INTEGER: i64 = -9007199254740991;

/// 单条 SQL 最大长度，防止异常输入导致内存/CPU 压力
const MAX_SQL_LENGTH: usize = 1_000_000;

/// SQL 编辑器中 SELECT 类语句单次返回的最大行数（与前端 `CSV_EXPORT_MAX_ROWS` / Excel 导出行上限一致）。
pub const MAX_EXECUTE_SQL_SELECT_ROWS: usize = 100_000;

fn is_use_statement(sql: &str) -> bool {
    let trimmed = sql.trim();
    let u = trimmed.to_uppercase();
    u.starts_with("USE ") || u == "USE"
}

/// SQL 编辑器中返回结果集、走行数上限保护的语句类型。
fn sql_editor_returns_result_set(sql: &str) -> bool {
    let u = sql.trim().to_uppercase();
    u.starts_with("SELECT")
        || u.starts_with("SHOW")
        || u.starts_with("DESCRIBE")
        || u.starts_with("DESC")
        || u.starts_with("WITH")
        || u.starts_with("EXPLAIN")
        || u.starts_with("TABLE ")
}

fn sql_editor_allowed_on_read_only_connection(sql: &str) -> bool {
    mysql_sql_editor_allowed_on_read_only_connection(sql)
}

fn mysql_scalar_display(v: Option<&MyValue>) -> String {
    match v {
        None | Some(MyValue::NULL) => String::new(),
        Some(MyValue::Bytes(b)) => String::from_utf8_lossy(b).to_string(),
        Some(MyValue::Int(i)) => i.to_string(),
        Some(MyValue::UInt(u)) => u.to_string(),
        Some(MyValue::Float(f)) => f.to_string(),
        Some(MyValue::Double(d)) => d.to_string(),
        Some(MyValue::Date(y, m, d, h, mi, s, _)) => {
            if *h == 0 && *mi == 0 && *s == 0 {
                format!("{:04}-{:02}-{:02}", y, m, d)
            } else {
                format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", y, m, d, h, mi, s)
            }
        }
        Some(MyValue::Time(neg, days, h, mi, s, _)) => {
            let sign = if *neg { "-" } else { "" };
            let total_hours = *days * 24 + (*h as u32);
            format!("{}{}:{:02}:{:02}", sign, total_hours, mi, s)
        }
    }
}

fn mysql_scalar_as_bool(v: Option<&MyValue>) -> bool {
    match v {
        Some(MyValue::Int(i)) => *i != 0,
        Some(MyValue::UInt(u)) => *u != 0,
        Some(MyValue::Bytes(b)) => {
            let s = String::from_utf8_lossy(b).trim().to_uppercase();
            s == "1" || s == "ON" || s == "YES" || s == "TRUE"
        }
        _ => false,
    }
}

fn mysql_scalar_as_u64(v: Option<&MyValue>) -> u64 {
    match v {
        Some(MyValue::UInt(u)) => *u,
        Some(MyValue::Int(i)) if *i >= 0 => *i as u64,
        Some(MyValue::Bytes(b)) => std::str::from_utf8(b)
            .ok()
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0),
        _ => 0,
    }
}

/// 从 `SHOW GRANTS` 单行中取出 `GRANT` 与 ` ON ` 之间的权限列表。
fn extract_grant_privilege_list(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    let upper = trimmed.to_uppercase();
    if !upper.starts_with("GRANT ") {
        return None;
    }
    let rest = trimmed.get(6..)?;
    let rest_upper = upper.get(6..)?;
    let on_pos = rest_upper.find(" ON ")?;
    Some(rest[..on_pos].trim())
}

/// 权限列表中是否出现 ALL PRIVILEGES 或任意非典型只读权限。
fn privilege_list_implies_write(list: &str) -> bool {
    let u = list.to_uppercase();
    if u.contains("ALL PRIVILEGES") {
        return true;
    }
    for part in list.split(',') {
        let seg = part.trim();
        if seg.is_empty() {
            continue;
        }
        let seg_u = seg.to_uppercase();
        match seg_u.as_str() {
            "USAGE" | "SELECT" | "SHOW VIEW" | "SHOW DATABASES" | "LOCK TABLES"
            | "REPLICATION SLAVE" | "REPLICATION CLIENT" | "PROCESS" => {}
            _ => {
                if seg_u.starts_with("SELECT (") {
                    continue;
                }
                return true;
            }
        }
    }
    false
}

/// 单行 `GRANT` 是否授予写类权限；含 `WITH GRANT OPTION` 视为可写。
fn grant_line_implies_write(line: &str) -> bool {
    let u = line.to_uppercase();
    if u.contains("WITH GRANT OPTION") {
        return true;
    }
    match extract_grant_privilege_list(line) {
        Some(plist) => privilege_list_implies_write(plist),
        None => true,
    }
}

/// 执行 `SHOW GRANTS FOR CURRENT_USER()`：任一行隐含写权限则返回 true。
/// 失败或空结果时返回 true，避免误伤。
async fn fetch_grant_write_capable(conn: &mut mysql_async::Conn) -> bool {
    let rows: Vec<Row> = match conn.query("SHOW GRANTS FOR CURRENT_USER()").await {
        Ok(r) => r,
        Err(_) => return true,
    };
    if rows.is_empty() {
        return true;
    }
    for row in rows {
        let line = mysql_scalar_display(row.as_ref(0));
        if line.is_empty() {
            continue;
        }
        if grant_line_implies_write(&line) {
            return true;
        }
    }
    false
}

async fn materialize_limited_select(
    conn: &mut mysql_async::Conn,
    sql: &str,
    start: Instant,
) -> Result<SqlExecuteResult, String> {
    let mut result = conn
        .query_iter(sql)
        .await
        .map_err(|e| format!("执行查询失败: {}", e))?;

    let mut rows_stored: Vec<Row> = Vec::new();
    let mut columns: Vec<String> = Vec::new();

    loop {
        let row = match result
            .next()
            .await
            .map_err(|e| format!("执行查询失败: {}", e))?
        {
            Some(r) => r,
            None => break,
        };

        if rows_stored.is_empty() {
            columns = row
                .columns_ref()
                .iter()
                .map(|c| c.name_str().to_string())
                .collect();
        }
        if rows_stored.len() >= MAX_EXECUTE_SQL_SELECT_ROWS {
            result
                .drop_result()
                .await
                .map_err(|e| format!("执行查询失败: {}", e))?;
            return Err(format!(
                "查询结果超过最大行数 {}（与 Excel 导出行上限一致），请使用 LIMIT 或缩小范围后重试",
                MAX_EXECUTE_SQL_SELECT_ROWS
            ));
        }
        rows_stored.push(row);
    }

    let elapsed = start.elapsed().as_millis() as u64;
    let json_rows = rows_to_json_with_columns(&rows_stored, columns.len());

    let row_count = json_rows.len();
    Ok(SqlExecuteResult {
        result_type: "select".to_string(),
        columns: Some(columns),
        rows: Some(json_rows),
        affected_rows: None,
        message: format!("返回 {} 行 (耗时 {}ms)", row_count, elapsed),
        execution_time_ms: elapsed,
    })
}

/// MySQL：`@@SESSION.max_execution_time`（毫秒）。MariaDB 无此变量，改用 `@@SESSION.max_statement_time`（秒）并换算为近似毫秒。
async fn fetch_session_query_timeout_ms(conn: &mut mysql_async::Conn) -> u64 {
    if let Ok(Some(ms)) = conn
        .query_first::<u64, _>("SELECT @@SESSION.max_execution_time")
        .await
    {
        return ms;
    }
    if let Ok(Some(secs)) = conn
        .query_first::<f64, _>("SELECT @@SESSION.max_statement_time")
        .await
    {
        if secs <= 0.0 {
            return 0;
        }
        return (secs * 1000.0).round().max(0.0) as u64;
    }
    0
}

/// 将 mysql_async::Value 转换为 serde_json::Value
/// 对超出 JS 安全整数范围的数值以字符串形式输出，防止 3258946454736595494 显示为 3258946454736595500 等精度问题
pub fn mysql_value_to_json(v: &MyValue) -> JsonValue {
    match v {
        MyValue::NULL => JsonValue::Null,
        MyValue::Bytes(b) => {
            // 借用方式判断 UTF-8，避免对每个字节串都 clone 一份（热路径：N 行 × M 列）；
            // 仅在确实需要以字符串形式返回时才用 to_string() 分配一次。
            match std::str::from_utf8(b) {
                Ok(s) => {
                    // 前导 0 规则：如 "0200..."、"-01" 这类非规范数字文本必须保留字符串，
                    // 否则会在转数字后丢失原始字符信息，影响脏数据排查与主键精确对比。
                    let has_non_canonical_leading_zero = {
                        let unsigned_non_canonical = s.len() > 1
                            && s.starts_with('0')
                            && s.chars().all(|c| c.is_ascii_digit());
                        let signed_non_canonical = s.len() > 2
                            && s.starts_with("-0")
                            && s[2..].chars().all(|c| c.is_ascii_digit());
                        unsigned_non_canonical || signed_non_canonical
                    };
                    if has_non_canonical_leading_zero {
                        return JsonValue::String(s.to_string());
                    }

                    // 尝试解析为数字 (MySQL 有时以字节返回数字)
                    if let Ok(n) = s.parse::<i64>() {
                        if (JS_MIN_SAFE_INTEGER..=JS_MAX_SAFE_INTEGER).contains(&n) {
                            serde_json::json!(n)
                        } else {
                            // 超出 JS 安全范围，保留字符串避免精度丢失
                            JsonValue::String(s.to_string())
                        }
                    } else if let Ok(n) = s.parse::<u64>() {
                        if n <= JS_MAX_SAFE_INTEGER as u64 {
                            serde_json::json!(n)
                        } else {
                            JsonValue::String(s.to_string())
                        }
                    } else if let Ok(n) = s.parse::<f64>() {
                        // 只有看起来像浮点数才转
                        if s.contains('.') || s.contains('e') || s.contains('E') {
                            serde_json::json!(n)
                        } else {
                            JsonValue::String(s.to_string())
                        }
                    } else {
                        JsonValue::String(s.to_string())
                    }
                }
                Err(_) => JsonValue::String(format!("[binary {} bytes]", b.len())),
            }
        }
        MyValue::Int(i) => {
            if *i >= JS_MIN_SAFE_INTEGER && *i <= JS_MAX_SAFE_INTEGER {
                serde_json::json!(*i)
            } else {
                JsonValue::String(i.to_string())
            }
        }
        MyValue::UInt(u) => {
            if *u <= JS_MAX_SAFE_INTEGER as u64 {
                serde_json::json!(*u)
            } else {
                JsonValue::String(u.to_string())
            }
        }
        MyValue::Float(f) => serde_json::json!(*f),
        MyValue::Double(d) => serde_json::json!(*d),
        MyValue::Date(y, m, d, h, mi, s, _us) => {
            if *h == 0 && *mi == 0 && *s == 0 {
                JsonValue::String(format!("{:04}-{:02}-{:02}", y, m, d))
            } else {
                JsonValue::String(format!(
                    "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
                    y, m, d, h, mi, s
                ))
            }
        }
        MyValue::Time(neg, days, h, mi, s, _us) => {
            let sign = if *neg { "-" } else { "" };
            let total_hours = *days * 24 + (*h as u32);
            JsonValue::String(format!("{}{}:{:02}:{:02}", sign, total_hours, mi, s))
        }
    }
}

/// 在已知列类型时转换单个值：
/// 对文本/二进制等「非数值」列，即使其字节内容全为数字也保留为字符串，
/// 避免 VARCHAR 电话号码、邮编等被错误地转成数字（丢失前导 0 / 改变主键比较语义）。
/// 列类型未知（`None`）或为数值列时，退回到 `mysql_value_to_json` 的启发式判断。
pub fn mysql_value_to_json_typed(
    v: &MyValue,
    col_type: Option<mysql_async::consts::ColumnType>,
) -> JsonValue {
    if let MyValue::Bytes(b) = v {
        if let Some(ct) = col_type {
            if !ct.is_numeric_type() {
                return match std::str::from_utf8(b) {
                    Ok(s) => JsonValue::String(s.to_string()),
                    Err(_) => JsonValue::String(format!("[binary {} bytes]", b.len())),
                };
            }
        }
    }
    mysql_value_to_json(v)
}

/// 将结果行转换为 JSON 行矩阵；`col_count` 为列数，缺失值以 `null` 填充。
/// 优先按列元数据（`ColumnType`）判断数值/文本，文本列保留字符串。
/// 被 `query_table_data` / `query_full_rows` / `materialize_limited_select` 复用，避免逻辑漂移。
fn rows_to_json_with_columns(rows: &[Row], col_count: usize) -> Vec<Vec<JsonValue>> {
    rows.iter()
        .map(|row| {
            let cols = row.columns_ref();
            (0..col_count)
                .map(|i| {
                    let col_type = cols.get(i).map(|c| c.column_type());
                    row.as_ref(i)
                        .map(|val| mysql_value_to_json_typed(val, col_type))
                        .unwrap_or(JsonValue::Null)
                })
                .collect()
        })
        .collect()
}

/// 从结果行集中提取列名（取首行的列元数据）并一并转换为 JSON 行矩阵。
/// 行集为空时返回空列名与空行集，调用方可自行回退到其它方式获取列名。
fn rows_to_columns_and_json(rows: &[Row]) -> (Vec<String>, Vec<Vec<JsonValue>>) {
    let columns: Vec<String> = match rows.first() {
        Some(first) => first
            .columns_ref()
            .iter()
            .map(|c| c.name_str().to_string())
            .collect(),
        None => Vec::new(),
    };
    let json_rows = rows_to_json_with_columns(rows, columns.len());
    (columns, json_rows)
}

/// 若指定了非空数据库名，则在该连接上执行 `USE <db>` 切库（标识符已转义）。
async fn use_database_if_set(
    conn: &mut mysql_async::Conn,
    database: &Option<String>,
) -> Result<(), String> {
    if let Some(db) = database {
        if !db.is_empty() {
            conn.query_drop(format!("USE {}", esc_id(db)))
                .await
                .map_err(|e| format!("切换数据库失败: {}", e))?;
        }
    }
    Ok(())
}

/// 校验 execute_sql 入口处的 SQL 文本，避免空语句或异常超长输入。
fn validate_sql_input(sql: &str) -> Result<(), String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("SQL 语句不能为空".to_string());
    }
    if trimmed.len() > MAX_SQL_LENGTH {
        return Err(format!(
            "SQL 语句过长，超过最大限制 {} 字节",
            MAX_SQL_LENGTH
        ));
    }
    Ok(())
}

/// 将 serde_json::Value 转换为 mysql_async::Value (用于参数化查询)
/// 支持前端传来的大整数字符串 (如 "3258946454736595494")
pub fn json_to_mysql_value(v: &JsonValue) -> MyValue {
    match v {
        JsonValue::Null => MyValue::NULL,
        JsonValue::Bool(b) => MyValue::Int(if *b { 1 } else { 0 }),
        JsonValue::Number(n) => {
            if let Some(i) = n.as_i64() {
                MyValue::Int(i)
            } else if let Some(u) = n.as_u64() {
                MyValue::UInt(u)
            } else if let Some(f) = n.as_f64() {
                MyValue::Double(f)
            } else {
                MyValue::NULL
            }
        }
        JsonValue::String(s) => {
            // 始终以字符串字节绑定参数：整段走 VAR_STRING，避免大整数字符串被解析为 UInt 后在驱动/服务器侧与 DOUBLE 互转时丢掉尾位，也避免与 JSON number 精度问题叠加
            MyValue::Bytes(s.as_bytes().to_vec())
        }
        _ => MyValue::NULL,
    }
}

// ─── Tauri 命令 ─────────────────────────────────────────────────────────

/// 查询主键列名 (内部辅助函数，不需要 State)
async fn fetch_primary_keys(
    conn: &mut mysql_async::Conn,
    database: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let query = format!(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS \
         WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} AND COLUMN_KEY = 'PRI' \
         ORDER BY ORDINAL_POSITION",
        esc_str(database),
        esc_str(table)
    );
    let pk_columns: Vec<String> = conn
        .query(&query)
        .await
        .map_err(|e| format!("查询主键信息失败: {}", e))?;
    Ok(pk_columns)
}

/// 查询表总行数 (用于分页，可与 query_table_data skip_count 配合实现数据与数量分离请求)
#[tauri::command]
pub async fn query_table_count(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    where_clause: Option<String>,
) -> Result<u64, String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_and_touch(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return postgres::query_table_count(&handle.pool, &database, &table, where_clause)
                .await;
        }
        DatabasePoolHandle::Sqlite(handle) => {
            return sqlite::query_table_count(&handle.pool, &database, &table, where_clause).await;
        }
        DatabasePoolHandle::SqlServer(handle) => {
            return sqlserver::query_table_count(&handle.pool, &database, &table, where_clause)
                .await;
        }
    };

    let where_sql = match &where_clause {
        Some(w) if !w.trim().is_empty() => {
            validate_where_clause(w)?;
            format!(" WHERE {}", w)
        }
        _ => String::new(),
    };

    let count_sql = mysql_count_query(&database, &table, &where_sql);

    let mut conn = get_conn_with_retry(&pool).await?;
    Ok(conn
        .query_first(&count_sql)
        .await
        .map_err(|e| format!("查询总数失败: {}", e))?
        .unwrap_or(0))
}

/// 表数据排序字段（与前端 `TableSortField` 对应，顺序为 ORDER BY 优先级）
#[derive(Debug, Clone, Deserialize)]
pub struct TableSortField {
    pub column: String,
    pub order: String,
}

fn build_order_by_sql(sort_fields: &Option<Vec<TableSortField>>) -> String {
    let Some(fields) = sort_fields else {
        return String::new();
    };
    if fields.is_empty() {
        return String::new();
    }
    let mut parts: Vec<String> = Vec::new();
    for f in fields {
        let col = f.column.trim();
        if col.is_empty() {
            continue;
        }
        let safe_order = if f.order.to_uppercase() == "DESC" {
            "DESC"
        } else {
            "ASC"
        };
        parts.push(format!("{} {}", esc_id(col), safe_order));
    }
    if parts.is_empty() {
        return String::new();
    }
    format!(" ORDER BY {}", parts.join(", "))
}

fn build_postgres_order_by_sql(sort_fields: &Option<Vec<TableSortField>>) -> String {
    let Some(fields) = sort_fields else {
        return String::new();
    };
    let borrowed: Vec<(&str, &str)> = fields
        .iter()
        .map(|f| (f.column.as_str(), f.order.as_str()))
        .collect();
    postgres::build_order_by_sql(&borrowed)
}

fn build_sqlite_order_by_sql(sort_fields: &Option<Vec<TableSortField>>) -> String {
    let Some(fields) = sort_fields else {
        return String::new();
    };
    let borrowed: Vec<(&str, &str)> = fields
        .iter()
        .map(|f| (f.column.as_str(), f.order.as_str()))
        .collect();
    sqlite::build_order_by_sql(&borrowed)
}

fn build_sqlserver_order_by_sql(sort_fields: &Option<Vec<TableSortField>>) -> String {
    let Some(fields) = sort_fields else {
        return String::new();
    };
    let borrowed: Vec<(&str, &str)> = fields
        .iter()
        .map(|f| (f.column.as_str(), f.order.as_str()))
        .collect();
    sqlserver::build_order_by_sql(&borrowed)
}

/// 查询表数据 (分页)
///
/// `select_columns`: 可选的列列表。传入时仅查询指定列（自动合并主键列以保证删除/修改功能正常）；
/// 为 None 或空时使用 SELECT *。
/// `skip_count`: 为 true 时跳过 COUNT 查询以加快首屏显示，total 返回 0，可配合 query_table_count 单独获取数量。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn query_table_data(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    page: u32,
    page_size: u32,
    sort_fields: Option<Vec<TableSortField>>,
    where_clause: Option<String>,
    select_columns: Option<Vec<String>>,
    skip_count: Option<bool>,
) -> Result<QueryResult, String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_and_touch(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            let order_sql = build_postgres_order_by_sql(&sort_fields);
            return postgres::query_table_data(
                &handle.pool,
                &database,
                &table,
                page,
                page_size,
                order_sql,
                where_clause,
                select_columns,
                skip_count,
            )
            .await;
        }
        DatabasePoolHandle::Sqlite(handle) => {
            let order_sql = build_sqlite_order_by_sql(&sort_fields);
            return sqlite::query_table_data(
                &handle.pool,
                &database,
                &table,
                page,
                page_size,
                order_sql,
                where_clause,
                select_columns,
                skip_count,
            )
            .await;
        }
        DatabasePoolHandle::SqlServer(handle) => {
            let order_sql = build_sqlserver_order_by_sql(&sort_fields);
            return sqlserver::query_table_data(
                &handle.pool,
                &database,
                &table,
                page,
                page_size,
                order_sql,
                where_clause,
                select_columns,
                skip_count,
            )
            .await;
        }
    };

    let start = Instant::now();

    // 构建 WHERE 子句（校验以防御 SQL 注入）
    let where_sql = match &where_clause {
        Some(w) if !w.trim().is_empty() => {
            validate_where_clause(w)?;
            format!(" WHERE {}", w)
        }
        _ => String::new(),
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    // 1) 查询总数（skip_count 为 true 时跳过，用于大数据量表加快首屏显示）
    let total: u64 = if skip_count == Some(true) {
        0
    } else {
        let count_sql = mysql_count_query(&database, &table, &where_sql);
        conn.query_first(&count_sql)
            .await
            .map_err(|e| format!("查询总数失败: {}", e))?
            .unwrap_or(0)
    };

    // 2) 构建 SELECT 列部分：若指定了 select_columns，自动合并主键列
    let select_part = match &select_columns {
        Some(cols) if !cols.is_empty() => {
            let pk_cols = fetch_primary_keys(&mut conn, &database, &table).await?;
            let mut merged: Vec<String> = cols.clone();
            for pk in &pk_cols {
                if !merged.iter().any(|c| c == pk) {
                    merged.push(pk.clone());
                }
            }
            merged
                .iter()
                .map(|c| esc_id(c))
                .collect::<Vec<_>>()
                .join(", ")
        }
        _ => "*".to_string(),
    };

    // 3) 构建 ORDER BY（支持多列）
    let order_sql = build_order_by_sql(&sort_fields);

    let offset = (page.saturating_sub(1)) * page_size;
    let data_sql = mysql_paginated_select(
        &select_part,
        &database,
        &table,
        &where_sql,
        &order_sql,
        page_size as u64,
        offset as u64,
    );

    let rows: Vec<mysql_async::Row> = conn
        .query(&data_sql)
        .await
        .map_err(|e| format!("查询数据失败: {}", e))?;

    // 4) 提取列名
    let columns: Vec<String> = if let Some(first_row) = rows.first() {
        first_row
            .columns_ref()
            .iter()
            .map(|c| c.name_str().to_string())
            .collect()
    } else {
        // 没有数据时，返回请求的列列表（或通过 SHOW COLUMNS 获取全部列名）
        match &select_columns {
            Some(cols) if !cols.is_empty() => {
                let pk_cols = fetch_primary_keys(&mut conn, &database, &table).await?;
                let mut merged: Vec<String> = cols.clone();
                for pk in &pk_cols {
                    if !merged.iter().any(|c| c == pk) {
                        merged.push(pk.clone());
                    }
                }
                merged
            }
            _ => {
                let col_sql = format!("SHOW COLUMNS FROM {}.{}", esc_id(&database), esc_id(&table));
                let col_rows: Vec<mysql_async::Row> = conn
                    .query(&col_sql)
                    .await
                    .map_err(|e| format!("获取列信息失败: {}", e))?;
                col_rows
                    .iter()
                    .map(|r| {
                        r.get::<Option<String>, _>("Field")
                            .flatten()
                            .unwrap_or_default()
                    })
                    .collect()
            }
        }
    };

    // 5) 转换行数据
    let json_rows = rows_to_json_with_columns(&rows, columns.len());

    let elapsed = start.elapsed().as_millis() as u64;

    Ok(QueryResult {
        columns,
        rows: json_rows,
        total,
        execution_time_ms: elapsed,
    })
}

/// 插入一行数据
#[tauri::command]
pub async fn insert_row(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    values: HashMap<String, JsonValue>,
) -> Result<u64, String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return postgres::insert_row(&handle.pool, &database, &table, values).await;
        }
        DatabasePoolHandle::Sqlite(handle) => {
            return sqlite::insert_row(&handle.pool, &database, &table, values).await;
        }
        DatabasePoolHandle::SqlServer(handle) => {
            return sqlserver::insert_row(&handle.pool, &database, &table, values).await;
        }
    };

    if values.is_empty() {
        return Err("没有提供要插入的数据".to_string());
    }

    let col_names: Vec<String> = values.keys().cloned().collect();
    let placeholders: Vec<&str> = vec!["?"; col_names.len()];
    let params: Vec<MyValue> = col_names
        .iter()
        .map(|k| json_to_mysql_value(&values[k]))
        .collect();

    let sql = format!(
        "INSERT INTO {}.{} ({}) VALUES ({})",
        esc_id(&database),
        esc_id(&table),
        col_names
            .iter()
            .map(|c| esc_id(c))
            .collect::<Vec<_>>()
            .join(", "),
        placeholders.join(", ")
    );

    let mut conn = get_conn_with_retry(&pool).await?;

    conn.exec_drop(&sql, mysql_async::Params::Positional(params))
        .await
        .map_err(|e| format!("插入数据失败: {}", e))?;

    Ok(conn.affected_rows())
}

/// 构建按主键定位的单行 UPDATE 语句与位置参数（`update_row` 与 `batch_update_rows` 共用）。
/// 调用方需自行保证 `updates` 与 `primary_keys` 均非空。
fn build_update_statement(
    database: &str,
    table: &str,
    primary_keys: &HashMap<String, JsonValue>,
    updates: &HashMap<String, JsonValue>,
) -> (String, Vec<MyValue>) {
    // SET 子句（HashMap 的 keys()/values() 迭代顺序一致，故下标对应）
    let set_parts: Vec<String> = updates
        .keys()
        .map(|k| format!("{} = ?", esc_id(k)))
        .collect();
    let mut params: Vec<MyValue> = updates.values().map(json_to_mysql_value).collect();

    // WHERE 子句
    let where_parts: Vec<String> = primary_keys
        .keys()
        .map(|k| format!("{} = ?", esc_id(k)))
        .collect();
    let pk_params: Vec<MyValue> = primary_keys.values().map(json_to_mysql_value).collect();
    params.extend(pk_params);

    let sql = format!(
        "UPDATE {}.{} SET {} WHERE {}",
        esc_id(database),
        esc_id(table),
        set_parts.join(", "),
        where_parts.join(" AND ")
    );
    (sql, params)
}

fn map_primary_key_rows(
    rows: &[HashMap<String, JsonValue>],
) -> Result<Vec<Vec<(String, MyValue)>>, String> {
    if rows.is_empty() {
        return Err("没有提供要删除的行".to_string());
    }
    let mut columns: Vec<String> = rows[0].keys().cloned().collect();
    columns.sort();
    if columns.is_empty() {
        return Err("存在缺少主键信息的行".to_string());
    }
    for row in rows {
        if row.len() != columns.len() || columns.iter().any(|c| !row.contains_key(c)) {
            return Err("存在主键信息不完整的行".to_string());
        }
    }
    Ok(rows
        .iter()
        .map(|row| {
            columns
                .iter()
                .map(|column| {
                    (
                        column.clone(),
                        json_to_mysql_value(row.get(column).expect("primary key checked")),
                    )
                })
                .collect()
        })
        .collect())
}

fn build_delete_statement(
    database: &str,
    table: &str,
    rows: &[Vec<(String, MyValue)>],
) -> (String, Vec<MyValue>) {
    let first_row = rows.first().expect("primary key rows must not be empty");
    let mut params: Vec<MyValue> = Vec::new();

    let where_sql = if first_row.len() == 1 {
        let primary_key_column = &first_row[0].0;
        let placeholders = vec!["?"; rows.len()].join(", ");
        params.extend(rows.iter().map(|row| row[0].1.clone()));
        format!("{} IN ({})", esc_id(primary_key_column), placeholders)
    } else {
        rows.iter()
            .map(|row| {
                let parts = row
                    .iter()
                    .map(|(column, value)| {
                        params.push(value.clone());
                        format!("{} = ?", esc_id(column))
                    })
                    .collect::<Vec<_>>()
                    .join(" AND ");
                format!("({})", parts)
            })
            .collect::<Vec<_>>()
            .join(" OR ")
    };

    (
        format!(
            "DELETE FROM {}.{} WHERE {}",
            esc_id(database),
            esc_id(table),
            where_sql
        ),
        params,
    )
}

/// 更新一行数据 (根据主键定位)
#[tauri::command]
pub async fn update_row(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    primary_keys: HashMap<String, JsonValue>,
    updates: HashMap<String, JsonValue>,
) -> Result<u64, String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return postgres::update_row(&handle.pool, &database, &table, primary_keys, updates)
                .await;
        }
        DatabasePoolHandle::Sqlite(handle) => {
            return sqlite::update_row(&handle.pool, &database, &table, primary_keys, updates)
                .await;
        }
        DatabasePoolHandle::SqlServer(handle) => {
            return sqlserver::update_row(&handle.pool, &database, &table, primary_keys, updates)
                .await;
        }
    };

    if updates.is_empty() {
        return Err("没有提供要更新的数据".to_string());
    }
    if primary_keys.is_empty() {
        return Err("没有提供主键信息".to_string());
    }

    let (sql, params) = build_update_statement(&database, &table, &primary_keys, &updates);

    let mut conn = get_conn_with_retry(&pool).await?;

    conn.exec_drop(&sql, mysql_async::Params::Positional(params))
        .await
        .map_err(|e| format!("更新数据失败: {}", e))?;

    Ok(conn.affected_rows())
}

/// 批量提交的单行更新：主键定位 + 待更新列。
#[derive(Debug, Clone, Deserialize)]
pub struct RowUpdate {
    pub primary_keys: HashMap<String, JsonValue>,
    pub updates: HashMap<String, JsonValue>,
}

/// 在单个事务中批量更新多行：任一行失败立即回滚整批，全部成功才提交。
///
/// 取代前端逐行 `update_row` 的做法，消除「成功 N 行 / 失败 M 行」的部分提交不一致状态。
/// 返回受影响的总行数。
#[tauri::command]
pub async fn batch_update_rows(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    rows: Vec<RowUpdate>,
) -> Result<u64, String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            let pg_rows: Vec<postgres::PgRowUpdate> = rows
                .into_iter()
                .map(|r| postgres::PgRowUpdate {
                    primary_keys: r.primary_keys,
                    updates: r.updates,
                })
                .collect();
            return postgres::batch_update_rows(&handle.pool, &database, &table, pg_rows).await;
        }
        DatabasePoolHandle::Sqlite(handle) => {
            let sqlite_rows: Vec<sqlite::SqliteRowUpdate> = rows
                .into_iter()
                .map(|r| sqlite::SqliteRowUpdate {
                    primary_keys: r.primary_keys,
                    updates: r.updates,
                })
                .collect();
            return sqlite::batch_update_rows(&handle.pool, &database, &table, sqlite_rows).await;
        }
        DatabasePoolHandle::SqlServer(handle) => {
            let sqlserver_rows: Vec<sqlserver::SqlServerRowUpdate> = rows
                .into_iter()
                .map(|r| sqlserver::SqlServerRowUpdate {
                    primary_keys: r.primary_keys,
                    updates: r.updates,
                })
                .collect();
            return sqlserver::batch_update_rows(&handle.pool, &database, &table, sqlserver_rows)
                .await;
        }
    };

    if rows.is_empty() {
        return Err("没有提供要更新的数据".to_string());
    }
    for r in &rows {
        if r.updates.is_empty() {
            return Err("存在没有更新内容的行".to_string());
        }
        if r.primary_keys.is_empty() {
            return Err("存在缺少主键信息的行".to_string());
        }
    }

    let mut conn = get_conn_with_retry(&pool).await?;
    let mut tx = conn
        .start_transaction(mysql_async::TxOpts::default())
        .await
        .map_err(|e| format!("开启事务失败: {}", e))?;

    let mut total: u64 = 0;
    for r in &rows {
        let (sql, params) = build_update_statement(&database, &table, &r.primary_keys, &r.updates);
        if let Err(e) = tx
            .exec_drop(&sql, mysql_async::Params::Positional(params))
            .await
        {
            // 显式回滚；即使回滚自身出错，事务也会在 Transaction drop 时隐式回滚
            let _ = tx.rollback().await;
            return Err(format!("批量更新失败，已回滚（未提交任何修改）: {}", e));
        }
        total += tx.affected_rows();
    }

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {}", e))?;

    Ok(total)
}

/// 批量删除行 (根据主键)
#[tauri::command]
pub async fn delete_rows(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    primary_keys: Vec<HashMap<String, JsonValue>>,
) -> Result<u64, String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return postgres::delete_rows(&handle.pool, &database, &table, primary_keys).await;
        }
        DatabasePoolHandle::Sqlite(handle) => {
            return sqlite::delete_rows(&handle.pool, &database, &table, primary_keys).await;
        }
        DatabasePoolHandle::SqlServer(handle) => {
            return sqlserver::delete_rows(&handle.pool, &database, &table, primary_keys).await;
        }
    };

    let rows = map_primary_key_rows(&primary_keys)?;
    let (sql, params) = build_delete_statement(&database, &table, &rows);

    let mut conn = get_conn_with_retry(&pool).await?;

    conn.exec_drop(&sql, mysql_async::Params::Positional(params))
        .await
        .map_err(|e| format!("删除数据失败: {}", e))?;

    Ok(conn.affected_rows())
}

/// 按主键查询完整行数据 (SELECT *)，用于"复制为 INSERT"等需要全量列的场景
#[tauri::command]
pub async fn query_full_rows(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    primary_key_column: String,
    primary_key_values: Vec<JsonValue>,
    primary_keys: Option<Vec<HashMap<String, JsonValue>>>,
) -> Result<QueryResult, String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_and_touch(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return postgres::query_full_rows(
                &handle.pool,
                &database,
                &table,
                &primary_key_column,
                primary_key_values,
            )
            .await;
        }
        DatabasePoolHandle::Sqlite(handle) => {
            if let Some(primary_keys) = primary_keys {
                return sqlite::query_full_rows_by_primary_keys(
                    &handle.pool,
                    &database,
                    &table,
                    primary_keys,
                )
                .await;
            }
            return sqlite::query_full_rows(
                &handle.pool,
                &database,
                &table,
                &primary_key_column,
                primary_key_values,
            )
            .await;
        }
        DatabasePoolHandle::SqlServer(handle) => {
            if let Some(primary_keys) = primary_keys {
                return sqlserver::query_full_rows_by_primary_keys(
                    &handle.pool,
                    &database,
                    &table,
                    primary_keys,
                )
                .await;
            }
            return sqlserver::query_full_rows(
                &handle.pool,
                &database,
                &table,
                &primary_key_column,
                primary_key_values,
            )
            .await;
        }
    };

    if primary_key_values.is_empty() {
        return Err("没有提供主键值".to_string());
    }

    let start = Instant::now();

    let placeholders: Vec<&str> = vec!["?"; primary_key_values.len()];
    let params: Vec<MyValue> = primary_key_values.iter().map(json_to_mysql_value).collect();

    let sql = format!(
        "SELECT * FROM {}.{} WHERE {} IN ({})",
        esc_id(&database),
        esc_id(&table),
        esc_id(&primary_key_column),
        placeholders.join(", ")
    );

    let mut conn = get_conn_with_retry(&pool).await?;

    let rows: Vec<mysql_async::Row> = conn
        .exec(&sql, mysql_async::Params::Positional(params))
        .await
        .map_err(|e| format!("查询完整行数据失败: {}", e))?;

    let (columns, json_rows) = rows_to_columns_and_json(&rows);

    let total = json_rows.len() as u64;
    let elapsed = start.elapsed().as_millis() as u64;

    Ok(QueryResult {
        columns,
        rows: json_rows,
        total,
        execution_time_ms: elapsed,
    })
}

/// 在给定连接上执行单条 SQL（结果集 / USE / DML-DDL 三类），不涉及连接获取与取消登记。
async fn run_sql_on_conn(
    conn: &mut mysql_async::Conn,
    sql: &str,
    read_only: bool,
    start: Instant,
) -> Result<SqlExecuteResult, String> {
    if sql_editor_returns_result_set(sql) {
        materialize_limited_select(conn, sql, start).await
    } else if is_use_statement(sql) {
        conn.query_drop(sql)
            .await
            .map_err(|e| format!("执行 SQL 失败: {}", e))?;

        let elapsed = start.elapsed().as_millis() as u64;
        let affected = conn.affected_rows();

        Ok(SqlExecuteResult {
            result_type: "modify".to_string(),
            columns: None,
            rows: None,
            affected_rows: Some(affected),
            message: format!("执行成功, 影响 {} 行 (耗时 {}ms)", affected, elapsed),
            execution_time_ms: elapsed,
        })
    } else {
        if read_only {
            return Err("当前连接为只读模式，不允许执行 DML/DDL".to_string());
        }
        conn.query_drop(sql)
            .await
            .map_err(|e| format!("执行 SQL 失败: {}", e))?;

        let elapsed = start.elapsed().as_millis() as u64;
        let affected = conn.affected_rows();

        Ok(SqlExecuteResult {
            result_type: "modify".to_string(),
            columns: None,
            rows: None,
            affected_rows: Some(affected),
            message: format!("执行成功, 影响 {} 行 (耗时 {}ms)", affected, elapsed),
            execution_time_ms: elapsed,
        })
    }
}

/// 执行任意 SQL 语句。
///
/// 传入 `execution_id` 时，会在执行前登记该连接的 MySQL 线程 ID，使前端可通过
/// `cancel_query(conn_id, execution_id)` 取消运行中的查询；执行结束（成功或失败）后自动注销。
#[tauri::command]
pub async fn execute_sql(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
    sql: String,
    execution_id: Option<String>,
) -> Result<SqlExecuteResult, String> {
    validate_sql_input(&sql)?;

    let (pool_handle, read_only) = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_touch_and_read_only(&conn_id)?
    };

    match pool_handle {
        DatabasePoolHandle::MySql(pool) => {
            if read_only && !sql_editor_allowed_on_read_only_connection(&sql) {
                return Err(
                    "当前连接为只读模式，仅允许 SELECT/SHOW/DESCRIBE/EXPLAIN/WITH/TABLE 及 USE 等读操作"
                        .to_string(),
                );
            }

            let mut conn = get_conn_with_retry(&pool).await?;

            use_database_if_set(&mut conn, &database).await?;

            // 登记当前连接的线程 ID，供取消使用；失败不影响正常执行
            let registered_id: Option<String> = match &execution_id {
                Some(eid) => match conn.query_first::<u64, _>("SELECT CONNECTION_ID()").await {
                    Ok(Some(thread_id)) => {
                        state
                            .running_queries
                            .lock()
                            .await
                            .insert(eid.clone(), RunningQuery::MySqlThread(thread_id));
                        Some(eid.clone())
                    }
                    _ => None,
                },
                None => None,
            };

            let start = Instant::now();
            let result = run_sql_on_conn(&mut conn, &sql, read_only, start).await;

            // 无论成功失败都注销登记
            if let Some(eid) = registered_id {
                state.running_queries.lock().await.remove(&eid);
            }

            result
        }
        DatabasePoolHandle::Postgres(handle) => {
            if read_only && !postgres::sql_editor_allowed_on_read_only_connection(&sql) {
                return Err(
                    "当前连接为只读模式，仅允许 SELECT/SHOW/EXPLAIN/WITH/TABLE/VALUES 等读操作"
                        .to_string(),
                );
            }

            let client = postgres::get_client_with_retry(&handle.pool).await?;
            postgres::set_search_path_if_set(&client, &database).await?;

            let registered_id = execution_id.map(|eid| {
                let cancel = postgres::PostgresCancelHandle::new(
                    client.cancel_token(),
                    handle.cancel_tls.clone(),
                );
                (eid, cancel)
            });
            if let Some((eid, cancel)) = &registered_id {
                state.running_queries.lock().await.insert(
                    eid.clone(),
                    RunningQuery::Postgres(Box::new(cancel.clone())),
                );
            }

            let start = Instant::now();
            let result = postgres::run_sql_on_client(&client, &sql, read_only, start).await;

            if let Some((eid, _)) = registered_id {
                state.running_queries.lock().await.remove(&eid);
            }

            result
        }
        DatabasePoolHandle::Sqlite(handle) => {
            let start = Instant::now();
            sqlite::run_sql_on_pool(&handle.pool, &sql, read_only, start).await
        }
        DatabasePoolHandle::SqlServer(handle) => {
            let registered_id = execution_id.clone();
            if let Some(eid) = &registered_id {
                state
                    .running_queries
                    .lock()
                    .await
                    .insert(eid.clone(), RunningQuery::SqlServerUnsupported);
            }

            let start = Instant::now();
            let result = sqlserver::run_sql_on_pool(&handle.pool, &sql, read_only, start).await;

            if let Some(eid) = registered_id {
                state.running_queries.lock().await.remove(&eid);
            }

            result
        }
    }
}

/// 取消（KILL QUERY）由 `execute_sql` 以相同 `execution_id` 登记的运行中查询。
///
/// 用另一条连接执行 `KILL QUERY <thread_id>`。若该执行已结束或未登记，返回 `false`。
#[tauri::command]
pub async fn cancel_query(
    state: State<'_, AppState>,
    conn_id: String,
    execution_id: String,
) -> Result<bool, String> {
    let running = {
        let map = state.running_queries.lock().await;
        map.get(&execution_id).cloned()
    };

    let Some(running) = running else {
        let is_sqlserver = {
            let manager = state.connection_manager.lock().await;
            matches!(
                manager.pool_for_ping(&conn_id),
                Some(DatabasePoolHandle::SqlServer(_))
            )
        };
        if is_sqlserver {
            return sqlserver::cancel_query().await;
        }
        // 查询可能已经执行完毕
        return Ok(false);
    };

    match running {
        RunningQuery::MySqlThread(thread_id) => {
            let pool = {
                let mut manager = state.connection_manager.lock().await;
                match manager.get_database_pool_and_touch(&conn_id)? {
                    DatabasePoolHandle::MySql(pool) => pool,
                    DatabasePoolHandle::Postgres(_)
                    | DatabasePoolHandle::Sqlite(_)
                    | DatabasePoolHandle::SqlServer(_) => {
                        return Err("当前运行中查询不是 MySQL 查询".to_string());
                    }
                }
            };

            let mut conn = get_conn_with_retry(&pool).await?;
            // thread_id 为 u64，可安全内联
            conn.query_drop(format!("KILL QUERY {}", thread_id))
                .await
                .map_err(|e| format!("取消查询失败: {}", e))?;
        }
        RunningQuery::Postgres(handle) => {
            (*handle).cancel().await?;
        }
        RunningQuery::SqlServerUnsupported => {
            return sqlserver::cancel_query().await;
        }
    }

    Ok(true)
}

/// 当前连接的会话与服务器元信息（排障用）
#[tauri::command]
pub async fn get_session_info(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
) -> Result<SessionInfo, String> {
    let (pool_handle, read_only) = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_touch_and_read_only(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            let client = postgres::get_client_with_retry(&handle.pool).await?;
            postgres::set_search_path_if_set(&client, &database).await?;
            let row = client
                .query_one(
                    "SELECT version(), \
                            COALESCE(inet_server_addr()::text, '') AS host, \
                            current_setting('transaction_read_only') = 'on' AS ro, \
                            current_setting('TimeZone') AS tz, \
                            current_schema() AS schema_name, \
                            pg_backend_pid() AS pid",
                    &[],
                )
                .await
                .map_err(|e| format!("读取会话信息失败: {}", e))?;
            let server_read_only: bool = row.get(2);
            let pid: i32 = row.get(5);
            let grant_write_capable = if server_read_only {
                false
            } else {
                postgres::fetch_grant_write_capable(&client).await
            };
            return Ok(SessionInfo {
                version: row.get::<_, String>(0),
                hostname: row.get::<_, String>(1),
                server_read_only,
                max_execution_time_ms: 0,
                time_zone: row.get::<_, String>(3),
                database: row.get::<_, Option<String>>(4),
                connection_id: if pid >= 0 { pid as u64 } else { 0 },
                grant_write_capable,
            });
        }
        DatabasePoolHandle::Sqlite(handle) => {
            return sqlite::get_session_info(&handle.pool, database, None, read_only).await;
        }
        DatabasePoolHandle::SqlServer(handle) => {
            return sqlserver::get_session_info(&handle.pool, database, read_only).await;
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    use_database_if_set(&mut conn, &database).await?;

    let q = "SELECT @@version AS v, @@hostname AS h, @@read_only AS ro, \
             @@time_zone AS tz, DATABASE() AS db, CONNECTION_ID() AS cid";
    let rows: Vec<Row> = conn
        .query(q)
        .await
        .map_err(|e| format!("读取会话信息失败: {}", e))?;

    let row = rows.first().ok_or_else(|| "无法读取会话信息".to_string())?;

    let timeout_ms = fetch_session_query_timeout_ms(&mut conn).await;
    let grant_write_capable = fetch_grant_write_capable(&mut conn).await;

    Ok(SessionInfo {
        version: mysql_scalar_display(row.as_ref(0)),
        hostname: mysql_scalar_display(row.as_ref(1)),
        server_read_only: mysql_scalar_as_bool(row.as_ref(2)),
        max_execution_time_ms: timeout_ms,
        time_zone: mysql_scalar_display(row.as_ref(3)),
        database: match row.as_ref(4) {
            None | Some(MyValue::NULL) => None,
            Some(other) => {
                let s = mysql_scalar_display(Some(other));
                if s.is_empty() {
                    None
                } else {
                    Some(s)
                }
            }
        },
        connection_id: mysql_scalar_as_u64(row.as_ref(5)),
        grant_write_capable,
    })
}

/// 对当前 SQL 执行 `EXPLAIN` 或 `EXPLAIN ANALYZE`（已由 `analyze` 参数控制），结果集适用与 `execute_sql` 相同的行数上限。
#[tauri::command]
pub async fn explain_sql(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
    sql: String,
    analyze: bool,
) -> Result<SqlExecuteResult, String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("SQL 语句不能为空".to_string());
    }

    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_and_touch(&conn_id)?
    };

    match pool_handle {
        DatabasePoolHandle::MySql(pool) => {
            let explain_stmt = if trimmed.to_uppercase().starts_with("EXPLAIN") {
                trimmed.to_string()
            } else if analyze {
                format!("EXPLAIN ANALYZE {}", trimmed)
            } else {
                format!("EXPLAIN {}", trimmed)
            };
            validate_sql_input(&explain_stmt)?;

            let mut conn = get_conn_with_retry(&pool).await?;

            use_database_if_set(&mut conn, &database).await?;

            let start = Instant::now();
            materialize_limited_select(&mut conn, &explain_stmt, start).await
        }
        DatabasePoolHandle::Postgres(handle) => {
            let explain_stmt = if trimmed.to_uppercase().starts_with("EXPLAIN") {
                trimmed.to_string()
            } else if analyze {
                format!("EXPLAIN ANALYZE {}", trimmed)
            } else {
                format!("EXPLAIN {}", trimmed)
            };
            validate_sql_input(&explain_stmt)?;

            let client = postgres::get_client_with_retry(&handle.pool).await?;
            postgres::set_search_path_if_set(&client, &database).await?;
            let start = Instant::now();
            postgres::run_sql_on_client(&client, &explain_stmt, false, start).await
        }
        DatabasePoolHandle::Sqlite(handle) => {
            validate_sql_input(trimmed)?;
            let start = Instant::now();
            sqlite::explain_sql_on_pool(&handle.pool, trimmed, analyze, start).await
        }
        DatabasePoolHandle::SqlServer(handle) => {
            validate_sql_input(trimmed)?;
            let start = Instant::now();
            sqlserver::explain_sql_on_pool(&handle.pool, trimmed, analyze, start).await
        }
    }
}

// ─── 单元测试 ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mysql_value_to_json_null() {
        let result = mysql_value_to_json(&MyValue::NULL);
        assert!(result.is_null());
    }

    #[test]
    fn test_mysql_value_to_json_int() {
        let result = mysql_value_to_json(&MyValue::Int(42));
        assert_eq!(result, serde_json::json!(42));

        let result = mysql_value_to_json(&MyValue::Int(-100));
        assert_eq!(result, serde_json::json!(-100));
    }

    #[test]
    fn test_mysql_value_to_json_uint() {
        let result = mysql_value_to_json(&MyValue::UInt(999));
        assert_eq!(result, serde_json::json!(999u64));
    }

    #[test]
    fn test_mysql_value_to_json_float() {
        let result = mysql_value_to_json(&MyValue::Float(1.25));
        assert_eq!(result, serde_json::json!(1.25f32));
    }

    #[test]
    fn test_mysql_value_to_json_double() {
        let result = mysql_value_to_json(&MyValue::Double(6.5));
        assert_eq!(result, serde_json::json!(6.5f64));
    }

    #[test]
    fn test_mysql_value_to_json_bytes_string() {
        let result = mysql_value_to_json(&MyValue::Bytes(b"hello world".to_vec()));
        assert_eq!(result, serde_json::json!("hello world"));
    }

    #[test]
    fn test_mysql_value_to_json_bytes_numeric_string() {
        // MySQL 有时以字节返回数字
        let result = mysql_value_to_json(&MyValue::Bytes(b"12345".to_vec()));
        assert_eq!(result, serde_json::json!(12345));
    }

    #[test]
    fn test_mysql_value_to_json_bytes_numeric_string_with_leading_zero_keeps_string() {
        let result = mysql_value_to_json(&MyValue::Bytes(b"0200046921690429".to_vec()));
        assert_eq!(result, serde_json::json!("0200046921690429"));
    }

    #[test]
    fn test_mysql_value_to_json_bytes_negative_numeric_string_with_leading_zero_keeps_string() {
        let result = mysql_value_to_json(&MyValue::Bytes(b"-0123".to_vec()));
        assert_eq!(result, serde_json::json!("-0123"));
    }

    #[test]
    fn test_mysql_value_to_json_date() {
        let result = mysql_value_to_json(&MyValue::Date(2024, 1, 15, 0, 0, 0, 0));
        assert_eq!(result, serde_json::json!("2024-01-15"));
    }

    #[test]
    fn test_mysql_value_to_json_datetime() {
        let result = mysql_value_to_json(&MyValue::Date(2024, 1, 15, 10, 30, 45, 0));
        assert_eq!(result, serde_json::json!("2024-01-15 10:30:45"));
    }

    #[test]
    fn test_mysql_value_to_json_time() {
        let result = mysql_value_to_json(&MyValue::Time(false, 0, 10, 30, 45, 0));
        assert_eq!(result, serde_json::json!("10:30:45"));
    }

    #[test]
    fn test_mysql_value_to_json_time_negative() {
        let result = mysql_value_to_json(&MyValue::Time(true, 1, 2, 30, 0, 0));
        // 1 day + 2 hours = 26 hours
        assert_eq!(result, serde_json::json!("-26:30:00"));
    }

    #[test]
    fn test_json_to_mysql_value_null() {
        let result = json_to_mysql_value(&JsonValue::Null);
        assert_eq!(result, MyValue::NULL);
    }

    #[test]
    fn test_json_to_mysql_value_bool() {
        assert_eq!(
            json_to_mysql_value(&serde_json::json!(true)),
            MyValue::Int(1)
        );
        assert_eq!(
            json_to_mysql_value(&serde_json::json!(false)),
            MyValue::Int(0)
        );
    }

    #[test]
    fn test_json_to_mysql_value_int() {
        let result = json_to_mysql_value(&serde_json::json!(42));
        assert_eq!(result, MyValue::Int(42));
    }

    #[test]
    fn test_json_to_mysql_value_float() {
        let result = json_to_mysql_value(&serde_json::json!(1.25));
        assert_eq!(result, MyValue::Double(1.25));
    }

    #[test]
    fn test_json_to_mysql_value_string() {
        let result = json_to_mysql_value(&serde_json::json!("hello"));
        assert_eq!(result, MyValue::Bytes(b"hello".to_vec()));
    }

    #[test]
    fn test_json_to_mysql_value_big_int_string() {
        let result = json_to_mysql_value(&serde_json::json!("3258946454736595494"));
        assert_eq!(result, MyValue::Bytes(b"3258946454736595494".to_vec()));
    }

    #[test]
    fn test_json_to_mysql_value_varchar_digit_string_as_bytes() {
        let s = "98860078801500001234";
        assert_eq!(
            json_to_mysql_value(&serde_json::json!(s)),
            MyValue::Bytes(s.as_bytes().to_vec())
        );
    }

    #[test]
    fn test_mysql_value_to_json_uint_beyond_js_safe() {
        // 超出 JS Number.MAX_SAFE_INTEGER，应以字符串形式输出避免精度丢失
        let result = mysql_value_to_json(&MyValue::UInt(3258946454736595494));
        assert_eq!(result, serde_json::json!("3258946454736595494"));
    }

    #[test]
    fn test_mysql_value_to_json_bytes_big_int_string() {
        let result = mysql_value_to_json(&MyValue::Bytes(b"3258946454736595494".to_vec()));
        assert_eq!(result, serde_json::json!("3258946454736595494"));
    }

    #[test]
    fn test_json_to_mysql_value_array_returns_null() {
        let result = json_to_mysql_value(&serde_json::json!([1, 2, 3]));
        assert_eq!(result, MyValue::NULL);
    }

    #[test]
    fn test_roundtrip_int() {
        let original = MyValue::Int(42);
        let json = mysql_value_to_json(&original);
        let back = json_to_mysql_value(&json);
        assert_eq!(back, MyValue::Int(42));
    }

    #[test]
    fn test_roundtrip_string() {
        let original = MyValue::Bytes(b"hello world".to_vec());
        let json = mysql_value_to_json(&original);
        let back = json_to_mysql_value(&json);
        assert_eq!(back, MyValue::Bytes(b"hello world".to_vec()));
    }

    #[test]
    fn test_roundtrip_null() {
        let original = MyValue::NULL;
        let json = mysql_value_to_json(&original);
        let back = json_to_mysql_value(&json);
        assert_eq!(back, MyValue::NULL);
    }

    #[test]
    fn test_validate_sql_input_empty() {
        assert!(validate_sql_input("").is_err());
        assert!(validate_sql_input("   ").is_err());
    }

    #[test]
    fn test_validate_sql_input_length_limit() {
        // 恰好等于上限时应允许
        let ok_sql = "A".repeat(MAX_SQL_LENGTH);
        assert!(validate_sql_input(&ok_sql).is_ok());

        // 超过上限时应拒绝
        let long_sql = "A".repeat(MAX_SQL_LENGTH + 1);
        assert!(validate_sql_input(&long_sql).is_err());
    }

    #[test]
    fn test_max_execute_sql_select_rows_matches_csv_export_cap() {
        assert_eq!(MAX_EXECUTE_SQL_SELECT_ROWS, 100_000);
    }

    #[test]
    fn test_sql_editor_classifies_with_and_table() {
        assert!(sql_editor_returns_result_set(
            "WITH a AS (SELECT 1) SELECT * FROM a"
        ));
        assert!(sql_editor_returns_result_set("TABLE mytbl"));
    }

    #[test]
    fn test_use_statement_detection() {
        assert!(is_use_statement("USE mydb"));
        assert!(is_use_statement("use `x`"));
        assert!(!is_use_statement("SELECT 1"));
    }

    #[test]
    fn test_grant_line_usage_only_not_write() {
        assert!(!super::grant_line_implies_write(
            "GRANT USAGE ON *.* TO `readonly`@`%`"
        ));
    }

    #[test]
    fn test_grant_line_select_only_not_write() {
        assert!(!super::grant_line_implies_write(
            "GRANT SELECT ON `db`.* TO `readonly`@`%`"
        ));
    }

    #[test]
    fn test_grant_line_select_show_view_not_write() {
        assert!(!super::grant_line_implies_write(
            "GRANT SELECT, SHOW VIEW ON `db`.* TO `u`@`%`"
        ));
    }

    #[test]
    fn test_grant_line_insert_implies_write() {
        assert!(super::grant_line_implies_write(
            "GRANT INSERT ON `db`.* TO `u`@`%`"
        ));
    }

    #[test]
    fn test_grant_line_grant_option_implies_write() {
        assert!(super::grant_line_implies_write(
            "GRANT SELECT ON *.* TO `u`@`%` WITH GRANT OPTION"
        ));
    }

    #[test]
    fn test_grant_line_all_privileges() {
        assert!(super::grant_line_implies_write(
            "GRANT ALL PRIVILEGES ON `db`.* TO `u`@`%`"
        ));
    }

    #[test]
    fn test_build_order_by_sql_none_empty() {
        assert_eq!(super::build_order_by_sql(&None), "");
        assert_eq!(super::build_order_by_sql(&Some(vec![])), "");
    }

    #[test]
    fn test_build_order_by_sql_single_column() {
        assert_eq!(
            super::build_order_by_sql(&Some(vec![super::TableSortField {
                column: "name".into(),
                order: "DESC".into(),
            }])),
            " ORDER BY `name` DESC"
        );
    }

    #[test]
    fn test_build_order_by_sql_multiple_columns_order_normalization() {
        assert_eq!(
            super::build_order_by_sql(&Some(vec![
                super::TableSortField {
                    column: "created_at".into(),
                    order: "desc".into(),
                },
                super::TableSortField {
                    column: "id".into(),
                    order: "ASC".into(),
                },
            ])),
            " ORDER BY `created_at` DESC, `id` ASC"
        );
    }

    #[test]
    fn test_build_order_by_sql_non_desc_defaults_to_asc() {
        assert_eq!(
            super::build_order_by_sql(&Some(vec![super::TableSortField {
                column: "x".into(),
                order: "ANY".into(),
            }])),
            " ORDER BY `x` ASC"
        );
    }

    #[test]
    fn test_value_to_json_typed_varchar_keeps_numeric_string() {
        use mysql_async::consts::ColumnType;
        // VARCHAR 列内全为数字时也应保留字符串（如电话号码、邮编）
        let v = MyValue::Bytes(b"13800001111".to_vec());
        let out = super::mysql_value_to_json_typed(&v, Some(ColumnType::MYSQL_TYPE_VAR_STRING));
        assert_eq!(out, serde_json::json!("13800001111"));
    }

    #[test]
    fn test_value_to_json_typed_numeric_column_parses_number() {
        use mysql_async::consts::ColumnType;
        // 数值列（如 BIGINT 以字节返回）应解析为数字
        let v = MyValue::Bytes(b"12345".to_vec());
        let out = super::mysql_value_to_json_typed(&v, Some(ColumnType::MYSQL_TYPE_LONGLONG));
        assert_eq!(out, serde_json::json!(12345));
    }

    #[test]
    fn test_value_to_json_typed_decimal_column_parses_float() {
        use mysql_async::consts::ColumnType;
        let v = MyValue::Bytes(b"123.45".to_vec());
        let out = super::mysql_value_to_json_typed(&v, Some(ColumnType::MYSQL_TYPE_NEWDECIMAL));
        assert_eq!(out, serde_json::json!(123.45));
    }

    #[test]
    fn test_value_to_json_typed_unknown_column_falls_back_to_heuristic() {
        // 列类型未知时退回启发式：纯数字字节串被解析为数字
        let v = MyValue::Bytes(b"42".to_vec());
        let out = super::mysql_value_to_json_typed(&v, None);
        assert_eq!(out, serde_json::json!(42));
    }

    #[test]
    fn test_value_to_json_typed_text_column_keeps_string() {
        use mysql_async::consts::ColumnType;
        // TEXT（以 BLOB 类型返回）为非数值列，应保留字符串
        let v = MyValue::Bytes(b"007".to_vec());
        let out = super::mysql_value_to_json_typed(&v, Some(ColumnType::MYSQL_TYPE_BLOB));
        assert_eq!(out, serde_json::json!("007"));
    }

    #[test]
    fn test_rows_to_json_with_columns_empty() {
        let rows: Vec<Row> = Vec::new();
        assert!(super::rows_to_json_with_columns(&rows, 3).is_empty());
    }

    #[test]
    fn test_rows_to_columns_and_json_empty() {
        let rows: Vec<Row> = Vec::new();
        let (columns, json_rows) = super::rows_to_columns_and_json(&rows);
        assert!(columns.is_empty());
        assert!(json_rows.is_empty());
    }

    #[test]
    fn test_build_update_statement_single_pk_single_update() {
        let mut pk = HashMap::new();
        pk.insert("id".to_string(), serde_json::json!(7));
        let mut updates = HashMap::new();
        updates.insert("name".to_string(), serde_json::json!("alice"));

        let (sql, params) = super::build_update_statement("db", "users", &pk, &updates);
        assert_eq!(sql, "UPDATE `db`.`users` SET `name` = ? WHERE `id` = ?");
        // 参数顺序：先 SET 值，后 WHERE 主键值
        assert_eq!(params.len(), 2);
        assert_eq!(params[0], MyValue::Bytes(b"alice".to_vec()));
        assert_eq!(params[1], MyValue::Int(7));
    }

    #[test]
    fn test_build_update_statement_escapes_identifiers() {
        let mut pk = HashMap::new();
        pk.insert("we`ird".to_string(), serde_json::json!(1));
        let mut updates = HashMap::new();
        updates.insert("col`x".to_string(), serde_json::json!("v"));

        let (sql, _params) = super::build_update_statement("d`b", "t`bl", &pk, &updates);
        assert!(sql.starts_with("UPDATE `d``b`.`t``bl` SET `col``x` = ? WHERE `we``ird` = ?"));
    }

    #[test]
    fn test_build_update_statement_multi_update_placeholder_count() {
        let mut pk = HashMap::new();
        pk.insert("id".to_string(), serde_json::json!(1));
        let mut updates = HashMap::new();
        updates.insert("a".to_string(), serde_json::json!(1));
        updates.insert("b".to_string(), serde_json::json!(2));

        let (sql, params) = super::build_update_statement("db", "t", &pk, &updates);
        // 2 个 SET 值 + 1 个主键值
        assert_eq!(params.len(), 3);
        assert_eq!(sql.matches('?').count(), 3);
        assert!(sql.contains(" WHERE `id` = ?"));
    }

    #[test]
    fn test_build_delete_statement_single_primary_key_keeps_in_clause() {
        let rows = vec![
            vec![("id".to_string(), MyValue::Int(1))],
            vec![("id".to_string(), MyValue::Int(2))],
        ];

        let (sql, params) = super::build_delete_statement("db", "users", &rows);
        assert_eq!(sql, "DELETE FROM `db`.`users` WHERE `id` IN (?, ?)");
        assert_eq!(params, vec![MyValue::Int(1), MyValue::Int(2)]);
    }

    #[test]
    fn test_build_delete_statement_composite_primary_key_uses_all_columns() {
        let rows = vec![
            vec![
                ("order_id".to_string(), MyValue::Int(1)),
                ("product_id".to_string(), MyValue::Int(10)),
            ],
            vec![
                ("order_id".to_string(), MyValue::Int(1)),
                ("product_id".to_string(), MyValue::Int(11)),
            ],
        ];

        let (sql, params) = super::build_delete_statement("db", "order_items", &rows);
        assert_eq!(
            sql,
            "DELETE FROM `db`.`order_items` WHERE (`order_id` = ? AND `product_id` = ?) OR (`order_id` = ? AND `product_id` = ?)"
        );
        assert_eq!(
            params,
            vec![
                MyValue::Int(1),
                MyValue::Int(10),
                MyValue::Int(1),
                MyValue::Int(11),
            ]
        );
    }

    #[test]
    fn test_build_order_by_sql_skips_blank_column_parts() {
        assert_eq!(
            super::build_order_by_sql(&Some(vec![
                super::TableSortField {
                    column: "   ".into(),
                    order: "DESC".into(),
                },
                super::TableSortField {
                    column: "ok".into(),
                    order: "ASC".into(),
                },
            ])),
            " ORDER BY `ok` ASC"
        );
    }
}
