use crate::models::types::{
    ColumnInfo, ConnectionConfig, QueryResult, SessionInfo, SqlCompletionColumn,
    SqlCompletionMetadata, SqlCompletionTable, SqlExecuteResult, TableInfo,
};
use clickhouse_rs::query::Query;
use clickhouse_rs::Client;
use serde::de::{DeserializeOwned, Error as DeError};
use serde::{Deserialize, Deserializer};
use serde_json::Value as JsonValue;
use std::collections::BTreeSet;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct ClickHousePoolHandle {
    pub client: Arc<Client>,
}

pub(crate) fn clickhouse_url(
    host: &str,
    port: u16,
    config: &ConnectionConfig,
) -> Result<String, String> {
    let mode = config
        .ssl_mode
        .as_deref()
        .unwrap_or("disabled")
        .trim()
        .to_lowercase();

    let scheme = match mode.as_str() {
        "" | "disabled" | "none" | "off" => "http",
        "required" => "https",
        "verify_ca" | "verify_identity" | "required_insecure" => {
            return Err(
                "ClickHouse 暂不支持自定义 CA、证书校验覆盖或跳过证书校验的 TLS 模式".to_string(),
            );
        }
        other => {
            return Err(format!(
                "未知的 ssl_mode: {}（ClickHouse 当前支持: disabled, required）",
                other
            ));
        }
    };

    if config
        .ssl_ca_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some()
        || config
            .ssl_pkcs12_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some()
        || config
            .ssl_tls_hostname
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some()
    {
        return Err(
            "ClickHouse 暂不支持自定义 CA、PKCS#12 客户端证书或 TLS 主机名覆盖".to_string(),
        );
    }

    Ok(format!("{}://{}:{}", scheme, host, port))
}

pub fn build_clickhouse_client(
    host: &str,
    port: u16,
    config: &ConnectionConfig,
) -> Result<ClickHousePoolHandle, String> {
    let url = clickhouse_url(host, port, config)?;
    let mut client = Client::default().with_url(url);

    if !config.username.is_empty() {
        client = client.with_user(config.username.clone());
    }
    if let Some(password) = config.password.as_deref().filter(|s| !s.is_empty()) {
        client = client.with_password(password.to_string());
    }
    if let Some(database) = config
        .database
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        client = client.with_database(database.to_string());
    }

    Ok(ClickHousePoolHandle {
        client: Arc::new(client),
    })
}

pub async fn test_pool(client: &Client) -> Result<(), String> {
    client
        .query("SELECT 1")
        .execute()
        .await
        .map_err(|e| format!("查询测试失败: {}", e))
}

pub async fn ping_pool(client: &Client) -> bool {
    tokio::time::timeout(Duration::from_secs(3), test_pool(client))
        .await
        .is_ok_and(|r| r.is_ok())
}

#[derive(Debug, Deserialize)]
pub(crate) struct ClickHouseDatabaseRow {
    name: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ClickHouseTableRow {
    name: String,
    table_type: String,
    engine: String,
    #[serde(deserialize_with = "deserialize_opt_u64")]
    total_rows: Option<u64>,
    #[serde(deserialize_with = "deserialize_opt_u64")]
    total_bytes: Option<u64>,
    comment: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ClickHouseColumnRow {
    name: String,
    column_type: String,
    default_kind: String,
    default_expression: String,
    comment: String,
    is_in_primary_key: u8,
    is_in_sorting_key: u8,
    #[allow(dead_code)]
    #[serde(deserialize_with = "deserialize_u64")]
    position: u64,
}

#[derive(Debug, Deserialize)]
pub(crate) struct ClickHouseCompletionRow {
    table_name: String,
    column_name: Option<String>,
    column_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ClickHousePrimaryKeyRow {
    name: String,
}

#[derive(Debug, Deserialize)]
struct ClickHouseJsonMeta {
    name: String,
    #[allow(dead_code)]
    #[serde(rename = "type")]
    column_type: String,
}

#[derive(Debug, Deserialize)]
struct ClickHouseJsonResultBody {
    meta: Vec<ClickHouseJsonMeta>,
    #[serde(default)]
    data: Vec<serde_json::Map<String, JsonValue>>,
}

#[derive(Debug, Deserialize)]
struct ClickHouseSessionRow {
    version: String,
    hostname: String,
    database: Option<String>,
    time_zone: String,
    #[allow(dead_code)]
    current_user: String,
}

#[derive(Debug, Deserialize)]
struct ClickHouseReadOnlySettingRow {
    readonly: u8,
}

fn parse_json_result_body(body: &str) -> Result<ClickHouseJsonResultBody, String> {
    serde_json::from_str(body).map_err(|e| format!("解析 ClickHouse JSON 结果失败: {}", e))
}

fn deserialize_opt_u64<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    match value {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::Number(n)) => n
            .as_u64()
            .ok_or_else(|| D::Error::custom("expected non-negative u64"))
            .map(Some),
        Some(serde_json::Value::String(s)) => s
            .parse::<u64>()
            .map(Some)
            .map_err(|e| D::Error::custom(format!("expected u64 string: {}", e))),
        Some(other) => Err(D::Error::custom(format!("expected u64, got {}", other))),
    }
}

pub(crate) fn deserialize_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_opt_u64(deserializer)?.ok_or_else(|| D::Error::custom("expected u64"))
}

pub(crate) fn list_databases_sql() -> &'static str {
    "SELECT name \
     FROM system.databases \
     WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') \
     ORDER BY name"
}

pub(crate) fn list_tables_sql() -> &'static str {
    "SELECT name, \
            CASE WHEN engine IN ('View', 'MaterializedView', 'LiveView') \
                 THEN 'VIEW' ELSE 'TABLE' END AS table_type, \
            engine, \
            total_rows, \
            total_bytes, \
            comment \
     FROM system.tables \
     WHERE database = ? \
     ORDER BY name"
}

pub(crate) fn table_structure_sql() -> &'static str {
    "SELECT name, \
            type AS column_type, \
            default_kind, \
            default_expression, \
            comment, \
            is_in_primary_key, \
            is_in_sorting_key, \
            position \
     FROM system.columns \
     WHERE database = ? AND table = ? \
     ORDER BY position"
}

pub(crate) fn sql_completion_metadata_sql() -> &'static str {
    "SELECT t.name AS table_name, \
            c.name AS column_name, \
            c.type AS column_type \
     FROM system.tables AS t \
     LEFT JOIN system.columns AS c \
       ON c.database = t.database AND c.table = t.name \
     WHERE t.database = ? \
     ORDER BY t.name, c.position"
}

pub(crate) fn fetch_primary_keys_sql() -> &'static str {
    "SELECT name \
     FROM system.columns \
     WHERE database = ? AND table = ? AND is_in_primary_key = 1 \
     ORDER BY position"
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ClickHouseDialect;

#[derive(Debug, Clone, Copy)]
pub(crate) struct ClickHouseSelectPage<'a> {
    pub(crate) columns_sql: &'a str,
    pub(crate) database: &'a str,
    pub(crate) table: &'a str,
    pub(crate) where_sql: &'a str,
    pub(crate) order_sql: &'a str,
    pub(crate) limit: u64,
    pub(crate) offset: u64,
}

#[derive(Debug)]
pub(crate) struct ClickHouseTableDataQuery<'a> {
    pub(crate) database: &'a str,
    pub(crate) table: &'a str,
    pub(crate) page: u32,
    pub(crate) page_size: u32,
    pub(crate) sort_fields: Vec<(&'a str, &'a str)>,
    pub(crate) where_clause: Option<String>,
    pub(crate) select_columns: Option<Vec<String>>,
    pub(crate) skip_count: Option<bool>,
}

impl ClickHouseDialect {
    pub(crate) fn identifier(&self, name: &str) -> String {
        format!("`{}`", name.replace('`', "``"))
    }

    pub(crate) fn string_literal(&self, value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }

    pub(crate) fn table_ref(&self, database: &str, table: &str) -> String {
        format!("{}.{}", self.identifier(database), self.identifier(table))
    }

    pub(crate) fn order_by(&self, fields: &[(&str, &str)]) -> String {
        let parts = fields
            .iter()
            .filter_map(|(column, order)| {
                let column = column.trim();
                if column.is_empty() {
                    return None;
                }
                let direction = if order.eq_ignore_ascii_case("DESC") {
                    "DESC"
                } else {
                    "ASC"
                };
                Some(format!("{} {}", self.identifier(column), direction))
            })
            .collect::<Vec<_>>();
        if parts.is_empty() {
            String::new()
        } else {
            format!(" ORDER BY {}", parts.join(", "))
        }
    }

    pub(crate) fn count_query(&self, database: &str, table: &str, where_sql: &str) -> String {
        format!(
            "SELECT count() FROM {}{}",
            self.table_ref(database, table),
            where_sql
        )
    }

    pub(crate) fn paginated_select(&self, page: ClickHouseSelectPage<'_>) -> String {
        format!(
            "SELECT {} FROM {}{}{} LIMIT {} OFFSET {}",
            page.columns_sql,
            self.table_ref(page.database, page.table),
            page.where_sql,
            page.order_sql,
            page.limit,
            page.offset
        )
    }
}

pub(crate) fn clickhouse_id(name: &str) -> String {
    ClickHouseDialect.identifier(name)
}

pub(crate) fn clickhouse_str(value: &str) -> String {
    ClickHouseDialect.string_literal(value)
}

pub(crate) fn clickhouse_table_ref(database: &str, table: &str) -> String {
    ClickHouseDialect.table_ref(database, table)
}

pub(crate) fn clickhouse_order_by(fields: &[(&str, &str)]) -> String {
    ClickHouseDialect.order_by(fields)
}

pub(crate) fn clickhouse_count_query(database: &str, table: &str, where_sql: &str) -> String {
    ClickHouseDialect.count_query(database, table, where_sql)
}

pub(crate) fn clickhouse_paginated_json_sql(page: ClickHouseSelectPage<'_>) -> String {
    format!("{} FORMAT JSON", ClickHouseDialect.paginated_select(page))
}

pub(crate) fn session_info_sql() -> &'static str {
    "SELECT version() AS version, \
            hostName() AS hostname, \
            currentDatabase() AS database, \
            timezone() AS time_zone, \
            currentUser() AS current_user"
}

fn readonly_setting_sql() -> &'static str {
    "SELECT toUInt8(value != '0') AS readonly \
     FROM system.settings \
     WHERE name = 'readonly'"
}

fn strip_leading_sql_comments(mut sql: &str) -> &str {
    loop {
        let trimmed = sql.trim_start();
        if let Some(rest) = trimmed.strip_prefix("--") {
            match rest.find('\n') {
                Some(pos) => {
                    sql = &rest[pos + 1..];
                    continue;
                }
                None => return "",
            }
        }
        if let Some(rest) = trimmed.strip_prefix("/*") {
            match rest.find("*/") {
                Some(pos) => {
                    sql = &rest[pos + 2..];
                    continue;
                }
                None => return "",
            }
        }
        return trimmed;
    }
}

fn first_sql_keyword(sql: &str) -> String {
    strip_leading_sql_comments(sql)
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_uppercase()
}

fn clickhouse_sql_has_write_token(sql: &str) -> bool {
    const WRITE_TOKENS: &[&str] = &[
        "INSERT", "ALTER", "CREATE", "DROP", "TRUNCATE", "DELETE", "UPDATE", "OPTIMIZE", "ATTACH",
        "DETACH", "RENAME", "GRANT", "REVOKE", "SYSTEM", "KILL",
    ];

    let upper = strip_leading_sql_comments(sql).to_uppercase();
    upper
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .any(|token| WRITE_TOKENS.contains(&token))
}

/// SQL 编辑器中 ClickHouse 返回结果集、可在只读连接上执行的语句类型。
pub(crate) fn clickhouse_sql_editor_returns_result_set(sql: &str) -> bool {
    match first_sql_keyword(sql).as_str() {
        "SELECT" | "SHOW" | "DESCRIBE" | "DESC" | "EXPLAIN" => true,
        "WITH" => !clickhouse_sql_has_write_token(sql),
        _ => false,
    }
}

pub(crate) fn clickhouse_sql_editor_allowed_on_read_only_connection(sql: &str) -> bool {
    clickhouse_sql_editor_returns_result_set(sql)
}

pub(crate) fn parse_json_each_rows<T>(body: &str) -> Result<Vec<T>, String>
where
    T: DeserializeOwned,
{
    let mut rows = Vec::new();
    for (idx, line) in body.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        rows.push(
            serde_json::from_str(line)
                .map_err(|e| format!("解析 ClickHouse JSONEachRow 第 {} 行失败: {}", idx + 1, e))?,
        );
    }
    Ok(rows)
}

pub(crate) fn clickhouse_json_to_sql_execute_result(
    body: &str,
    elapsed: u64,
) -> Result<SqlExecuteResult, String> {
    let parsed = parse_json_result_body(body)?;

    let columns: Vec<String> = parsed.meta.into_iter().map(|m| m.name).collect();
    let rows: Vec<Vec<JsonValue>> = parsed
        .data
        .into_iter()
        .map(|row| {
            columns
                .iter()
                .map(|name| row.get(name).cloned().unwrap_or(JsonValue::Null))
                .collect()
        })
        .collect();

    let row_count = rows.len();
    Ok(SqlExecuteResult {
        result_type: "select".to_string(),
        columns: Some(columns),
        rows: Some(rows),
        affected_rows: None,
        message: format!("返回 {} 行 (耗时 {}ms)", row_count, elapsed),
        execution_time_ms: elapsed,
    })
}

pub(crate) fn clickhouse_json_to_query_result(
    body: &str,
    total: u64,
    elapsed: u64,
) -> Result<QueryResult, String> {
    let parsed = parse_json_result_body(body)?;

    let columns: Vec<String> = parsed.meta.into_iter().map(|m| m.name).collect();
    let rows: Vec<Vec<JsonValue>> = parsed
        .data
        .into_iter()
        .map(|row| {
            columns
                .iter()
                .map(|name| row.get(name).cloned().unwrap_or(JsonValue::Null))
                .collect()
        })
        .collect();

    Ok(QueryResult {
        columns,
        rows,
        total,
        execution_time_ms: elapsed,
    })
}

fn clickhouse_json_literal(value: &JsonValue) -> Result<String, String> {
    match value {
        JsonValue::Null => Ok("NULL".to_string()),
        JsonValue::Bool(v) => Ok(if *v { "true" } else { "false" }.to_string()),
        JsonValue::Number(n) => Ok(n.to_string()),
        JsonValue::String(s) => Ok(clickhouse_str(s)),
        JsonValue::Array(_) | JsonValue::Object(_) => {
            Err("ClickHouse 行定位暂不支持 Array/Object 类型值".to_string())
        }
    }
}

pub(crate) fn build_insert_json_each_row(
    database: &str,
    table: &str,
    values: &HashMap<String, JsonValue>,
) -> Result<(String, String), String> {
    if values.is_empty() {
        return Err("没有提供要插入的数据".to_string());
    }

    let mut columns = values.keys().cloned().collect::<Vec<_>>();
    columns.sort();

    let sql = format!(
        "INSERT INTO {} ({}) FORMAT JSONEachRow",
        clickhouse_table_ref(database, table),
        columns
            .iter()
            .map(|column| clickhouse_id(column))
            .collect::<Vec<_>>()
            .join(", ")
    );

    let mut row = serde_json::Map::new();
    for column in columns {
        row.insert(
            column.clone(),
            values.get(&column).cloned().unwrap_or(JsonValue::Null),
        );
    }
    let payload = format!(
        "{}\n",
        serde_json::to_string(&row)
            .map_err(|e| format!("序列化 ClickHouse 插入数据失败: {}", e))?
    );

    Ok((sql, payload))
}

fn build_full_rows_where_from_primary_key_maps(
    primary_keys: Vec<HashMap<String, JsonValue>>,
) -> Result<String, String> {
    if primary_keys.is_empty() {
        return Err("缺少可安全定位列，无法查询完整行数据".to_string());
    }

    let mut columns = primary_keys[0].keys().cloned().collect::<Vec<_>>();
    columns.sort();
    if columns.is_empty() {
        return Err("缺少可安全定位列，无法查询完整行数据".to_string());
    }

    for row in &primary_keys {
        if row.len() != columns.len() || columns.iter().any(|column| !row.contains_key(column)) {
            return Err("存在不完整的 ClickHouse 行定位值".to_string());
        }
    }

    let clauses = primary_keys
        .iter()
        .map(|row| {
            columns
                .iter()
                .map(|column| {
                    let value = row
                        .get(column)
                        .ok_or_else(|| "存在不完整的 ClickHouse 行定位值".to_string())?;
                    Ok(format!(
                        "{} = {}",
                        clickhouse_id(column),
                        clickhouse_json_literal(value)?
                    ))
                })
                .collect::<Result<Vec<_>, String>>()
                .map(|parts| format!("({})", parts.join(" AND ")))
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(clauses.join(" OR "))
}

pub(crate) fn build_full_rows_sql(
    database: &str,
    table: &str,
    primary_key_column: Option<&str>,
    primary_key_values: Vec<JsonValue>,
) -> Result<String, String> {
    let column = primary_key_column
        .map(str::trim)
        .filter(|column| !column.is_empty())
        .ok_or_else(|| "缺少可安全定位列，无法查询完整行数据".to_string())?;
    if primary_key_values.is_empty() {
        return Err("缺少可安全定位列，无法查询完整行数据".to_string());
    }
    let values = primary_key_values
        .iter()
        .map(clickhouse_json_literal)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(format!(
        "SELECT * FROM {} WHERE {} IN ({}) FORMAT JSON",
        clickhouse_table_ref(database, table),
        clickhouse_id(column),
        values.join(", ")
    ))
}

pub(crate) fn build_full_rows_sql_by_primary_keys(
    database: &str,
    table: &str,
    primary_keys: Vec<HashMap<String, JsonValue>>,
) -> Result<String, String> {
    let where_sql = build_full_rows_where_from_primary_key_maps(primary_keys)?;
    Ok(format!(
        "SELECT * FROM {} WHERE {} FORMAT JSON",
        clickhouse_table_ref(database, table),
        where_sql
    ))
}

async fn fetch_json_result(client: &Client, sql: &str, context: &str) -> Result<String, String> {
    let mut cursor = client
        .query(sql)
        .with_setting("wait_end_of_query", "1")
        .with_setting("max_result_rows", "100000")
        .with_setting("result_overflow_mode", "throw")
        .with_setting("output_format_json_quote_64bit_integers", "1")
        .fetch_bytes("JSON")
        .map_err(|e| format!("{}: {}", context, e))?;
    let bytes = cursor
        .collect()
        .await
        .map_err(|e| format!("{}: {}", context, e))?;
    std::str::from_utf8(bytes.as_ref())
        .map(str::to_string)
        .map_err(|e| format!("{}: ClickHouse 返回了非 UTF-8 JSON: {}", context, e))
}

pub(crate) async fn fetch_json_each_rows<T>(query: Query, context: &str) -> Result<Vec<T>, String>
where
    T: DeserializeOwned,
{
    let mut cursor = query
        .fetch_bytes("JSONEachRow")
        .map_err(|e| format!("{}: {}", context, e))?;
    let bytes = cursor
        .collect()
        .await
        .map_err(|e| format!("{}: {}", context, e))?;
    let text = std::str::from_utf8(bytes.as_ref())
        .map_err(|e| format!("{}: ClickHouse 返回了非 UTF-8 JSONEachRow: {}", context, e))?;
    parse_json_each_rows(text).map_err(|e| format!("{}: {}", context, e))
}

pub(crate) fn map_clickhouse_table_row(row: ClickHouseTableRow) -> TableInfo {
    let table_type = if row.table_type == "VIEW" {
        "VIEW".to_string()
    } else {
        "TABLE".to_string()
    };

    TableInfo {
        name: row.name,
        table_type,
        engine: if row.engine.is_empty() {
            None
        } else {
            Some(row.engine)
        },
        rows: row.total_rows,
        data_length: row.total_bytes,
        index_length: None,
        comment: row.comment,
    }
}

fn clickhouse_type_is_nullable(column_type: &str) -> bool {
    let compact: String = column_type.chars().filter(|c| !c.is_whitespace()).collect();
    compact.starts_with("Nullable(") || compact.starts_with("LowCardinality(Nullable(")
}

fn format_clickhouse_default_value(kind: &str, expression: &str) -> Option<String> {
    let kind = kind.trim();
    let expression = expression.trim();
    match (kind.is_empty(), expression.is_empty()) {
        (true, true) => None,
        (true, false) => Some(expression.to_string()),
        (false, true) => Some(kind.to_string()),
        (false, false) => Some(format!("{} {}", kind, expression)),
    }
}

pub(crate) fn map_clickhouse_column_row(row: ClickHouseColumnRow) -> ColumnInfo {
    let key = if row.is_in_primary_key == 1 {
        "PRI".to_string()
    } else {
        String::new()
    };
    let extra = if row.is_in_primary_key == 0 && row.is_in_sorting_key == 1 {
        "sorting key".to_string()
    } else {
        String::new()
    };

    ColumnInfo {
        name: row.name,
        nullable: clickhouse_type_is_nullable(&row.column_type),
        column_type: row.column_type,
        key,
        default_value: format_clickhouse_default_value(&row.default_kind, &row.default_expression),
        extra,
        comment: row.comment,
    }
}

pub(crate) fn map_clickhouse_completion_rows(
    rows: Vec<ClickHouseCompletionRow>,
) -> (Vec<SqlCompletionTable>, Vec<SqlCompletionColumn>) {
    let mut seen_tables = BTreeSet::new();
    let mut tables = Vec::new();
    let mut columns = Vec::new();

    for row in rows {
        if seen_tables.insert(row.table_name.clone()) {
            tables.push(SqlCompletionTable {
                name: row.table_name.clone(),
            });
        }
        if let Some(name) = row.column_name {
            columns.push(SqlCompletionColumn {
                table: row.table_name,
                name,
                data_type: row.column_type,
            });
        }
    }

    (tables, columns)
}

pub async fn list_databases(client: &Client) -> Result<Vec<String>, String> {
    let rows: Vec<ClickHouseDatabaseRow> =
        fetch_json_each_rows(client.query(list_databases_sql()), "查询数据库列表失败").await?;
    Ok(rows.into_iter().map(|row| row.name).collect())
}

pub async fn list_tables(client: &Client, database: &str) -> Result<Vec<TableInfo>, String> {
    let rows: Vec<ClickHouseTableRow> = fetch_json_each_rows(
        client.query(list_tables_sql()).bind(database),
        "查询表列表失败",
    )
    .await?;
    Ok(rows.into_iter().map(map_clickhouse_table_row).collect())
}

pub async fn get_table_structure(
    client: &Client,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let rows: Vec<ClickHouseColumnRow> = fetch_json_each_rows(
        client
            .query(table_structure_sql())
            .bind(database)
            .bind(table),
        "查询表结构失败",
    )
    .await?;
    Ok(rows.into_iter().map(map_clickhouse_column_row).collect())
}

pub async fn get_sql_completion_metadata(
    client: &Client,
    database: Option<String>,
) -> Result<SqlCompletionMetadata, String> {
    let databases = list_databases(client).await?;
    let Some(db) = database
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

    let rows: Vec<ClickHouseCompletionRow> = fetch_json_each_rows(
        client.query(sql_completion_metadata_sql()).bind(&db),
        "查询 SQL 补全元数据失败",
    )
    .await?;
    let (tables, columns) = map_clickhouse_completion_rows(rows);

    Ok(SqlCompletionMetadata {
        databases,
        tables,
        columns,
    })
}

pub async fn fetch_primary_keys(
    client: &Client,
    database: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let rows: Vec<ClickHousePrimaryKeyRow> = fetch_json_each_rows(
        client
            .query(fetch_primary_keys_sql())
            .bind(database)
            .bind(table),
        "查询主键信息失败",
    )
    .await?;
    Ok(rows.into_iter().map(|row| row.name).collect())
}

fn where_sql_from_clause(where_clause: Option<String>) -> Result<String, String> {
    match where_clause {
        Some(w) if !w.trim().is_empty() => {
            crate::db::sql_utils::validate_where_clause(&w)?;
            Ok(format!(" WHERE {}", w))
        }
        _ => Ok(String::new()),
    }
}

fn clickhouse_count_from_json(body: &str) -> Result<u64, String> {
    let parsed = parse_json_result_body(body)?;
    let first_name = parsed
        .meta
        .first()
        .map(|meta| meta.name.as_str())
        .ok_or_else(|| "ClickHouse count 查询未返回列信息".to_string())?;
    let value = parsed
        .data
        .first()
        .and_then(|row| row.get(first_name))
        .ok_or_else(|| "ClickHouse count 查询未返回数据".to_string())?;
    match value {
        JsonValue::Number(n) => n
            .as_u64()
            .ok_or_else(|| "ClickHouse count 返回了非法数值".to_string()),
        JsonValue::String(s) => s
            .parse::<u64>()
            .map_err(|e| format!("解析 ClickHouse count 失败: {}", e)),
        _ => Err("ClickHouse count 返回了非数字结果".to_string()),
    }
}

pub async fn query_table_count(
    client: &Client,
    database: &str,
    table: &str,
    where_clause: Option<String>,
) -> Result<u64, String> {
    let where_sql = where_sql_from_clause(where_clause)?;
    let sql = clickhouse_count_query(database, table, &where_sql);
    let body = fetch_json_result(client, &sql, "查询总数失败").await?;
    clickhouse_count_from_json(&body)
}

pub async fn query_table_data(
    client: &Client,
    request: ClickHouseTableDataQuery<'_>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let ClickHouseTableDataQuery {
        database,
        table,
        page,
        page_size,
        sort_fields,
        where_clause,
        select_columns,
        skip_count,
    } = request;
    let where_sql = where_sql_from_clause(where_clause)?;

    let total = if skip_count == Some(true) {
        0
    } else {
        let sql = clickhouse_count_query(database, table, &where_sql);
        let body = fetch_json_result(client, &sql, "查询总数失败").await?;
        clickhouse_count_from_json(&body)?
    };

    let select_part = match select_columns {
        Some(cols) if !cols.is_empty() => {
            let pk_cols = fetch_primary_keys(client, database, table).await?;
            let mut merged = cols;
            for pk in pk_cols {
                if !merged.iter().any(|column| column == &pk) {
                    merged.push(pk);
                }
            }
            merged
                .iter()
                .map(|column| clickhouse_id(column))
                .collect::<Vec<_>>()
                .join(", ")
        }
        _ => "*".to_string(),
    };

    let order_sql = clickhouse_order_by(&sort_fields);
    let offset = page.saturating_sub(1) as u64 * page_size as u64;
    let sql = clickhouse_paginated_json_sql(ClickHouseSelectPage {
        columns_sql: &select_part,
        database,
        table,
        where_sql: &where_sql,
        order_sql: &order_sql,
        limit: page_size as u64,
        offset,
    });
    let body = fetch_json_result(client, &sql, "查询数据失败").await?;
    clickhouse_json_to_query_result(&body, total, start.elapsed().as_millis() as u64)
}

pub async fn insert_row(
    client: &Client,
    database: &str,
    table: &str,
    values: HashMap<String, JsonValue>,
) -> Result<u64, String> {
    let (sql, payload) = build_insert_json_each_row(database, table, &values)?;
    let query = format!("{}\n{}", sql, payload);
    client
        .query(&query)
        .execute()
        .await
        .map_err(|e| format!("插入数据失败: {}", e))?;
    Ok(1)
}

pub async fn query_full_rows(
    client: &Client,
    database: &str,
    table: &str,
    primary_key_column: &str,
    primary_key_values: Vec<JsonValue>,
    primary_keys: Option<Vec<HashMap<String, JsonValue>>>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let sql = match primary_keys {
        Some(rows) if !rows.is_empty() => {
            build_full_rows_sql_by_primary_keys(database, table, rows)?
        }
        _ => build_full_rows_sql(
            database,
            table,
            Some(primary_key_column),
            primary_key_values,
        )?,
    };
    let body = fetch_json_result(client, &sql, "查询完整行数据失败").await?;
    let mut result = clickhouse_json_to_query_result(&body, 0, start.elapsed().as_millis() as u64)?;
    result.total = result.rows.len() as u64;
    Ok(result)
}

fn clickhouse_grant_privileges(line: &str) -> Option<&str> {
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

fn clickhouse_grant_line_implies_write(line: &str) -> bool {
    let Some(privileges) = clickhouse_grant_privileges(line) else {
        return true;
    };
    let upper = privileges.to_uppercase();
    if upper.contains("ALL") {
        return true;
    }

    for part in privileges.split(',') {
        let privilege = part.trim().to_uppercase();
        if privilege.is_empty() {
            continue;
        }
        match privilege.as_str() {
            "SELECT" | "SHOW" | "EXISTS" | "INTROSPECTION" => {}
            _ => return true,
        }
    }

    false
}

async fn fetch_readonly_setting(client: &Client) -> Result<bool, String> {
    let rows: Vec<ClickHouseReadOnlySettingRow> = fetch_json_each_rows(
        client.query(readonly_setting_sql()),
        "查询 ClickHouse readonly 设置失败",
    )
    .await?;

    Ok(rows.first().is_some_and(|row| row.readonly != 0))
}

async fn fetch_grant_write_capable(client: &Client) -> bool {
    let result = match fetch_json_result(client, "SHOW GRANTS", "查询 ClickHouse 权限失败").await
    {
        Ok(body) => clickhouse_json_to_sql_execute_result(&body, 0),
        Err(_) => return false,
    };
    let result = match result {
        Ok(result) => result,
        Err(_) => return false,
    };
    let Some(rows) = result.rows else {
        return false;
    };
    if rows.is_empty() {
        return false;
    }

    rows.iter().any(|row| {
        row.first()
            .and_then(JsonValue::as_str)
            .is_some_and(clickhouse_grant_line_implies_write)
    })
}

pub async fn run_sql_on_client(
    client: &Client,
    sql: &str,
    read_only: bool,
    start: Instant,
) -> Result<SqlExecuteResult, String> {
    if read_only && !clickhouse_sql_editor_allowed_on_read_only_connection(sql) {
        return Err(
            "当前连接为只读模式，仅允许 SELECT/SHOW/DESCRIBE/EXPLAIN/WITH 等读操作".to_string(),
        );
    }

    if clickhouse_sql_editor_returns_result_set(sql) {
        let body = fetch_json_result(client, sql, "执行 ClickHouse 查询失败").await?;
        let elapsed = start.elapsed().as_millis() as u64;
        return clickhouse_json_to_sql_execute_result(&body, elapsed);
    }

    client
        .query(sql)
        .execute()
        .await
        .map_err(|e| format!("执行 ClickHouse SQL 失败: {}", e))?;

    let elapsed = start.elapsed().as_millis() as u64;
    Ok(SqlExecuteResult {
        result_type: "modify".to_string(),
        columns: None,
        rows: None,
        affected_rows: Some(0),
        message: format!("执行成功 (耗时 {}ms)", elapsed),
        execution_time_ms: elapsed,
    })
}

pub async fn get_session_info(client: &Client, read_only: bool) -> Result<SessionInfo, String> {
    let rows: Vec<ClickHouseSessionRow> = fetch_json_each_rows(
        client.query(session_info_sql()),
        "读取 ClickHouse 会话信息失败",
    )
    .await?;
    let row = rows
        .into_iter()
        .next()
        .ok_or_else(|| "无法读取 ClickHouse 会话信息".to_string())?;

    let server_read_only = fetch_readonly_setting(client).await.unwrap_or(false);
    let grant_write_capable =
        !read_only && !server_read_only && fetch_grant_write_capable(client).await;

    Ok(SessionInfo {
        version: row.version,
        hostname: row.hostname,
        server_read_only,
        max_execution_time_ms: 0,
        time_zone: row.time_zone,
        database: row.database,
        connection_id: 0,
        grant_write_capable,
    })
}

#[cfg(test)]
mod tests {
    use crate::db::connection::ConnectionManager;
    use crate::models::types::{ConnectionConfig, DatabaseType};
    use reqwest::Url;

    fn sample_config() -> ConnectionConfig {
        ConnectionConfig {
            id: None,
            database_type: DatabaseType::ClickHouse,
            name: "ClickHouse".to_string(),
            host: "ch.example.com".to_string(),
            port: 8123,
            username: "default".to_string(),
            password: None,
            database: Some("analytics".to_string()),
            sqlite_path: None,
            ssh: None,
            ssl_mode: None,
            ssl_ca_path: None,
            ssl_pkcs12_path: None,
            ssl_pkcs12_password: None,
            ssl_tls_hostname: None,
            client_charset: None,
            session_init_commands: None,
            read_only: None,
            skip_dangerous_sql_confirm: None,
            group_id: None,
        }
    }

    #[test]
    fn clickhouse_url_defaults_to_http() {
        let config = sample_config();

        let url = super::clickhouse_url("ch.example.com", 8123, &config).unwrap();

        assert_eq!(url, "http://ch.example.com:8123");
    }

    #[test]
    fn clickhouse_url_required_ssl_uses_https() {
        let mut config = sample_config();
        config.ssl_mode = Some("required".to_string());

        let url = super::clickhouse_url("127.0.0.1", 18123, &config).unwrap();

        assert_eq!(url, "https://127.0.0.1:18123");
    }

    #[test]
    fn clickhouse_url_rejects_custom_tls_modes_for_now() {
        for mode in ["verify_ca", "verify_identity", "required_insecure"] {
            let mut config = sample_config();
            config.ssl_mode = Some(mode.to_string());

            let err = super::clickhouse_url("ch.example.com", 8123, &config).unwrap_err();

            assert!(err.contains("ClickHouse 暂不支持"));
        }
    }

    #[test]
    fn clickhouse_metadata_sql_uses_system_tables_and_bound_filters() {
        let databases_sql = super::list_databases_sql();
        assert!(databases_sql.contains("FROM system.databases"));
        assert!(databases_sql.contains("WHERE name NOT IN"));
        assert!(databases_sql.contains("'system'"));
        assert!(databases_sql.contains("'INFORMATION_SCHEMA'"));

        let tables_sql = super::list_tables_sql();
        assert!(tables_sql.contains("FROM system.tables"));
        assert!(tables_sql.contains("WHERE database = ?"));
        assert!(tables_sql.contains("engine IN ('View', 'MaterializedView', 'LiveView')"));

        let structure_sql = super::table_structure_sql();
        assert!(structure_sql.contains("FROM system.columns"));
        assert!(structure_sql.contains("WHERE database = ? AND table = ?"));
        assert!(structure_sql.contains("ORDER BY position"));

        let completion_sql = super::sql_completion_metadata_sql();
        assert!(completion_sql.contains("FROM system.tables AS t"));
        assert!(completion_sql.contains("LEFT JOIN system.columns AS c"));
        assert!(completion_sql.contains("WHERE t.database = ?"));
    }

    #[test]
    fn clickhouse_table_rows_map_views_and_nullable_sizes() {
        let json = r#"
{"name":"events","table_type":"TABLE","engine":"MergeTree","total_rows":"42","total_bytes":"4096","comment":"fact table"}
{"name":"daily_mv","table_type":"VIEW","engine":"MaterializedView","total_rows":null,"total_bytes":null,"comment":""}
"#;

        let rows: Vec<super::ClickHouseTableRow> =
            super::parse_json_each_rows(json).expect("valid JSONEachRow");
        let mapped = rows
            .into_iter()
            .map(super::map_clickhouse_table_row)
            .collect::<Vec<_>>();

        assert_eq!(mapped[0].name, "events");
        assert_eq!(mapped[0].table_type, "TABLE");
        assert_eq!(mapped[0].engine.as_deref(), Some("MergeTree"));
        assert_eq!(mapped[0].rows, Some(42));
        assert_eq!(mapped[0].data_length, Some(4096));
        assert_eq!(mapped[0].index_length, None);
        assert_eq!(mapped[0].comment, "fact table");

        assert_eq!(mapped[1].name, "daily_mv");
        assert_eq!(mapped[1].table_type, "VIEW");
        assert_eq!(mapped[1].engine.as_deref(), Some("MaterializedView"));
        assert_eq!(mapped[1].rows, None);
        assert_eq!(mapped[1].data_length, None);
    }

    #[test]
    fn clickhouse_column_rows_map_primary_sorting_and_defaults() {
        let json = r#"
{"name":"id","column_type":"UInt64","default_kind":"","default_expression":"","comment":"identifier","is_in_primary_key":1,"is_in_sorting_key":1,"position":"1"}
{"name":"name","column_type":"LowCardinality(Nullable(String))","default_kind":"DEFAULT","default_expression":"'anonymous'","comment":"","is_in_primary_key":0,"is_in_sorting_key":0,"position":"2"}
{"name":"created_at","column_type":"DateTime","default_kind":"MATERIALIZED","default_expression":"now()","comment":"created","is_in_primary_key":0,"is_in_sorting_key":1,"position":"3"}
"#;

        let rows: Vec<super::ClickHouseColumnRow> =
            super::parse_json_each_rows(json).expect("valid JSONEachRow");
        let mapped = rows
            .into_iter()
            .map(super::map_clickhouse_column_row)
            .collect::<Vec<_>>();

        assert_eq!(mapped[0].name, "id");
        assert!(!mapped[0].nullable);
        assert_eq!(mapped[0].key, "PRI");
        assert_eq!(mapped[0].default_value, None);
        assert_eq!(mapped[0].extra, "");
        assert_eq!(mapped[0].comment, "identifier");

        assert_eq!(mapped[1].name, "name");
        assert!(mapped[1].nullable);
        assert_eq!(mapped[1].key, "");
        assert_eq!(
            mapped[1].default_value.as_deref(),
            Some("DEFAULT 'anonymous'")
        );

        assert_eq!(mapped[2].name, "created_at");
        assert_eq!(mapped[2].key, "");
        assert_eq!(mapped[2].extra, "sorting key");
        assert_eq!(
            mapped[2].default_value.as_deref(),
            Some("MATERIALIZED now()")
        );
    }

    #[test]
    fn clickhouse_completion_rows_deduplicate_tables_without_per_table_queries() {
        let json = r#"
{"table_name":"events","column_name":"id","column_type":"UInt64"}
{"table_name":"events","column_name":"payload","column_type":"String"}
{"table_name":"empty_table","column_name":null,"column_type":null}
"#;

        let rows: Vec<super::ClickHouseCompletionRow> =
            super::parse_json_each_rows(json).expect("valid JSONEachRow");
        let (tables, columns) = super::map_clickhouse_completion_rows(rows);

        assert_eq!(
            tables.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            vec!["events", "empty_table"]
        );
        assert_eq!(columns.len(), 2);
        assert_eq!(columns[0].table, "events");
        assert_eq!(columns[0].name, "id");
        assert_eq!(columns[0].data_type.as_deref(), Some("UInt64"));
    }

    #[test]
    fn clickhouse_primary_key_sql_reads_system_columns_once() {
        let sql = super::fetch_primary_keys_sql();

        assert!(sql.contains("FROM system.columns"));
        assert!(sql.contains("WHERE database = ? AND table = ?"));
        assert!(sql.contains("is_in_primary_key = 1"));
        assert!(sql.contains("ORDER BY position"));
    }

    #[test]
    fn clickhouse_sql_editor_classifies_result_set_statements() {
        for sql in [
            "SELECT 1",
            " show tables",
            "DESCRIBE events",
            "desc events",
            "EXPLAIN SELECT * FROM events",
            "WITH latest AS (SELECT 1) SELECT * FROM latest",
        ] {
            assert!(
                super::clickhouse_sql_editor_returns_result_set(sql),
                "{sql} should return a result set"
            );
        }

        for sql in [
            "INSERT INTO events VALUES (1)",
            "CREATE TABLE events (id UInt64) ENGINE = MergeTree ORDER BY id",
            "DROP TABLE events",
            "WITH x AS (SELECT 1) INSERT INTO events SELECT * FROM x",
        ] {
            assert!(
                !super::clickhouse_sql_editor_returns_result_set(sql),
                "{sql} should not be treated as a read-only result set"
            );
        }
    }

    #[test]
    fn clickhouse_read_only_connections_allow_only_result_sets() {
        assert!(
            super::clickhouse_sql_editor_allowed_on_read_only_connection(
                "SELECT count() FROM events"
            )
        );
        assert!(
            super::clickhouse_sql_editor_allowed_on_read_only_connection(
                "WITH x AS (SELECT 1) SELECT * FROM x"
            )
        );
        assert!(!super::clickhouse_sql_editor_allowed_on_read_only_connection("USE analytics"));
        assert!(
            !super::clickhouse_sql_editor_allowed_on_read_only_connection(
                "ALTER TABLE events DELETE WHERE id = 1"
            )
        );
    }

    #[test]
    fn clickhouse_json_result_preserves_meta_order_and_complex_values() {
        let body = serde_json::json!({
            "meta": [
                { "name": "big_id", "type": "UInt64" },
                { "name": "maybe_name", "type": "Nullable(String)" },
                { "name": "created_at", "type": "DateTime" },
                { "name": "tags", "type": "Array(String)" },
                { "name": "props", "type": "Map(String, String)" }
            ],
            "data": [
                {
                    "props": { "source": "web" },
                    "tags": ["a", "b"],
                    "created_at": "2026-07-06 10:11:12",
                    "maybe_name": null,
                    "big_id": "3258946454736595494"
                }
            ],
            "rows": 1
        })
        .to_string();

        let result = super::clickhouse_json_to_sql_execute_result(&body, 12)
            .expect("valid ClickHouse JSON result");

        assert_eq!(result.result_type, "select");
        assert_eq!(
            result.columns.as_deref(),
            Some(
                &[
                    "big_id".to_string(),
                    "maybe_name".to_string(),
                    "created_at".to_string(),
                    "tags".to_string(),
                    "props".to_string(),
                ][..]
            )
        );
        assert_eq!(
            result.rows.as_deref(),
            Some(
                &[vec![
                    serde_json::json!("3258946454736595494"),
                    serde_json::Value::Null,
                    serde_json::json!("2026-07-06 10:11:12"),
                    serde_json::json!(["a", "b"]),
                    serde_json::json!({ "source": "web" }),
                ]][..]
            )
        );
        assert_eq!(result.message, "返回 1 行 (耗时 12ms)");
        assert_eq!(result.execution_time_ms, 12);
    }

    #[test]
    fn clickhouse_dialect_builds_table_read_sql() {
        let dialect = super::ClickHouseDialect;
        assert_eq!(dialect.identifier("we`ird"), "`we``ird`");
        assert_eq!(dialect.string_literal("Bob's"), "'Bob''s'");
        assert_eq!(
            dialect.table_ref("analytics", "events"),
            "`analytics`.`events`"
        );
        assert_eq!(
            dialect.order_by(&[("created_at", "desc"), ("id", "ASC"), ("", "DESC")]),
            " ORDER BY `created_at` DESC, `id` ASC"
        );
        assert_eq!(
            dialect.count_query("analytics", "events", " WHERE `kind` = 'login'"),
            "SELECT count() FROM `analytics`.`events` WHERE `kind` = 'login'"
        );
        assert_eq!(
            dialect.paginated_select(super::ClickHouseSelectPage {
                columns_sql: "`id`, `created_at`",
                database: "analytics",
                table: "events",
                where_sql: " WHERE `kind` = 'login'",
                order_sql: " ORDER BY `created_at` DESC",
                limit: 50,
                offset: 100,
            }),
            "SELECT `id`, `created_at` FROM `analytics`.`events` WHERE `kind` = 'login' ORDER BY `created_at` DESC LIMIT 50 OFFSET 100"
        );
    }

    #[test]
    fn clickhouse_select_sql_ends_with_json_format() {
        let sql = super::clickhouse_paginated_json_sql(super::ClickHouseSelectPage {
            columns_sql: "`id`, `name`",
            database: "analytics",
            table: "events",
            where_sql: " WHERE `id` > 10",
            order_sql: " ORDER BY `id` DESC",
            limit: 25,
            offset: 50,
        });
        assert_eq!(
            sql,
            "SELECT `id`, `name` FROM `analytics`.`events` WHERE `id` > 10 ORDER BY `id` DESC LIMIT 25 OFFSET 50 FORMAT JSON"
        );
    }

    #[test]
    fn clickhouse_json_query_result_maps_query_result() {
        let body = serde_json::json!({
            "meta": [
                { "name": "id", "type": "UInt64" },
                { "name": "name", "type": "String" }
            ],
            "data": [
                { "id": "3258946454736595494", "name": "Alice" },
                { "id": "2", "name": "Bob" }
            ],
            "rows": 2
        })
        .to_string();

        let result = super::clickhouse_json_to_query_result(&body, 42, 7)
            .expect("valid ClickHouse JSON result");

        assert_eq!(result.columns, vec!["id", "name"]);
        assert_eq!(
            result.rows,
            vec![
                vec![
                    serde_json::json!("3258946454736595494"),
                    serde_json::json!("Alice")
                ],
                vec![serde_json::json!("2"), serde_json::json!("Bob")],
            ]
        );
        assert_eq!(result.total, 42);
        assert_eq!(result.execution_time_ms, 7);
    }

    #[test]
    fn clickhouse_insert_json_each_row_sql_and_payload_are_deterministic() {
        let mut values = std::collections::HashMap::new();
        values.insert("name".to_string(), serde_json::json!("Alice"));
        values.insert("id".to_string(), serde_json::json!("3258946454736595494"));
        values.insert("active".to_string(), serde_json::json!(true));

        let (sql, payload) =
            super::build_insert_json_each_row("analytics", "events", &values).unwrap();

        assert_eq!(
            sql,
            "INSERT INTO `analytics`.`events` (`active`, `id`, `name`) FORMAT JSONEachRow"
        );
        assert_eq!(
            payload,
            "{\"active\":true,\"id\":\"3258946454736595494\",\"name\":\"Alice\"}\n"
        );
    }

    #[test]
    fn clickhouse_full_rows_requires_safe_locator() {
        let err = super::build_full_rows_sql("analytics", "events", None, vec![]).unwrap_err();
        assert!(err.contains("缺少可安全定位列"));

        let mut pk = std::collections::HashMap::new();
        pk.insert("id".to_string(), serde_json::json!(1));
        pk.insert("tenant_id".to_string(), serde_json::json!("acme"));
        let sql =
            super::build_full_rows_sql_by_primary_keys("analytics", "events", vec![pk]).unwrap();
        assert!(sql.contains("SELECT * FROM `analytics`.`events` WHERE"));
        assert!(sql.contains("(`id` = 1 AND `tenant_id` = 'acme')"));
        assert!(sql.ends_with("FORMAT JSON"));
    }

    #[tokio::test]
    #[ignore = "requires a local ClickHouse instance, e.g. CLICKHOUSE_URL=http://default:dbconnect@localhost:8123"]
    async fn clickhouse_connection_manager_connects_to_local_instance() {
        let url = std::env::var("CLICKHOUSE_URL")
            .expect("set CLICKHOUSE_URL, e.g. http://default:dbconnect@localhost:8123");
        let url = Url::parse(&url).expect("CLICKHOUSE_URL must be a valid URL");
        let scheme = url.scheme();
        let host = url
            .host_str()
            .expect("CLICKHOUSE_URL must include a host")
            .to_string();
        let port =
            url.port_or_known_default()
                .unwrap_or(if scheme == "https" { 443 } else { 8123 });
        let username = if url.username().is_empty() {
            std::env::var("CLICKHOUSE_USER").unwrap_or_else(|_| "default".to_string())
        } else {
            url.username().to_string()
        };
        let password = url
            .password()
            .map(str::to_string)
            .or_else(|| std::env::var("CLICKHOUSE_PASSWORD").ok());
        let database = url
            .path_segments()
            .and_then(|mut segments| segments.next())
            .filter(|segment| !segment.is_empty())
            .map(str::to_string);

        let config = ConnectionConfig {
            database_type: DatabaseType::ClickHouse,
            name: "Local ClickHouse".to_string(),
            host,
            port,
            username,
            password,
            database,
            sqlite_path: None,
            ssh: None,
            ssl_mode: Some(if scheme == "https" {
                "required".to_string()
            } else {
                "disabled".to_string()
            }),
            ssl_ca_path: None,
            ssl_pkcs12_path: None,
            ssl_pkcs12_password: None,
            ssl_tls_hostname: None,
            client_charset: None,
            session_init_commands: None,
            read_only: None,
            skip_dangerous_sql_confirm: None,
            group_id: None,
            id: None,
        };

        let latency = ConnectionManager::test_connection(&config)
            .await
            .expect("ClickHouse test_connection should run SELECT 1");
        assert!(latency < 30_000);

        let (conn_id, active) = ConnectionManager::prepare_connection(config)
            .await
            .expect("ClickHouse prepare_connection should build and test the client");
        let mut manager = ConnectionManager::new();
        manager.register(conn_id.clone(), active);

        assert!(manager.active_connection_ids().contains(&conn_id));
        assert!(manager.ping(&conn_id).await);
        manager
            .disconnect(&conn_id)
            .await
            .expect("ClickHouse disconnect should close active resources");
        assert!(!manager.has_connection(&conn_id));
    }
}
