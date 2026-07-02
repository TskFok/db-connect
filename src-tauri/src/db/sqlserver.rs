use crate::db::dialect::SQLSERVER_DIALECT;
use crate::db::sql_utils::{
    sqlserver_count_query, sqlserver_id, sqlserver_paginated_select,
    sqlserver_sql_editor_allowed_on_read_only_connection, sqlserver_str, validate_where_clause,
};
use crate::models::types::{
    ColumnInfo, ConnectionConfig, QueryResult, SessionInfo, SqlCompletionColumn,
    SqlCompletionMetadata, SqlCompletionTable, SqlExecuteResult, TableInfo,
};
use bb8::{Pool, PooledConnection};
use bb8_tiberius::ConnectionManager as SqlServerConnectionManager;
use futures_util::TryStreamExt;
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::time::{Duration, Instant};
use tiberius::{AuthMethod, ColumnData, Config as TiberiusConfig, EncryptionLevel, Row};

pub type SqlServerPool = Pool<SqlServerConnectionManager>;
type SqlServerPooledConnection<'a> = PooledConnection<'a, SqlServerConnectionManager>;

const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const JS_MIN_SAFE_INTEGER: i64 = -9_007_199_254_740_991;
const DAYS_0001_TO_1970: i64 = 719_162;
const MAX_EXECUTE_SQL_SELECT_ROWS: usize = 100_000;

#[derive(Clone)]
pub struct SqlServerPoolHandle {
    pub pool: SqlServerPool,
}

pub(crate) fn normalize_sqlserver_error(context: &str, err: impl AsRef<str>) -> String {
    format!("SQL Server {}: {}", context, err.as_ref())
}

pub(crate) fn build_tiberius_config(
    host: &str,
    port: u16,
    config: &ConnectionConfig,
) -> Result<TiberiusConfig, String> {
    let mut tds = TiberiusConfig::new();
    tds.host(host);
    tds.port(port);
    tds.application_name("db-connect");
    tds.authentication(AuthMethod::sql_server(
        config.username.as_str(),
        config.password.as_deref().unwrap_or(""),
    ));
    if let Some(database) = config
        .database
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        tds.database(database);
    }
    if config.read_only.unwrap_or(false) {
        tds.readonly(true);
    }

    let mode = config
        .ssl_mode
        .as_deref()
        .unwrap_or("disabled")
        .trim()
        .to_lowercase();

    match mode.as_str() {
        "" | "disabled" | "none" | "off" => {
            tds.encryption(EncryptionLevel::Off);
        }
        "required" => {
            tds.encryption(EncryptionLevel::Required);
        }
        "verify_ca" | "verify_identity" => {
            let ca = config
                .ssl_ca_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("VERIFY_CA 模式需要填写 CA 证书路径（PEM）")?;
            tds.encryption(EncryptionLevel::Required);
            tds.trust_cert_ca(ca);
        }
        "required_insecure" => {
            tds.encryption(EncryptionLevel::Required);
            tds.trust_cert();
        }
        other => {
            return Err(format!(
                "未知的 ssl_mode: {}（支持: disabled, required, verify_ca, verify_identity, required_insecure）",
                other
            ));
        }
    }

    if config
        .ssl_pkcs12_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some()
    {
        return Err("SQL Server 暂不支持 PKCS#12 客户端证书".to_string());
    }

    Ok(tds)
}

pub fn build_sqlserver_pool(
    host: &str,
    port: u16,
    config: &ConnectionConfig,
) -> Result<SqlServerPoolHandle, String> {
    let tds = build_tiberius_config(host, port, config)?;
    let manager = SqlServerConnectionManager::new(tds);
    let pool = Pool::builder()
        .max_size(5)
        .connection_timeout(Duration::from_secs(10))
        .build_unchecked(manager);
    Ok(SqlServerPoolHandle { pool })
}

pub async fn test_pool(pool: &SqlServerPool) -> Result<(), String> {
    let mut client = pool
        .get()
        .await
        .map_err(|e| normalize_sqlserver_error("获取连接失败", e.to_string()))?;
    client
        .simple_query("SELECT 1")
        .await
        .map_err(|e| normalize_sqlserver_error("查询测试失败", e.to_string()))?;
    Ok(())
}

pub async fn ping_pool(pool: &SqlServerPool) -> bool {
    let probe = async {
        let mut client = pool.get().await.map_err(|e| e.to_string())?;
        client
            .simple_query("SELECT 1")
            .await
            .map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    };

    matches!(
        tokio::time::timeout(Duration::from_secs(3), probe).await,
        Ok(Ok(()))
    )
}

async fn get_client_with_retry(
    pool: &SqlServerPool,
) -> Result<SqlServerPooledConnection<'_>, String> {
    pool.get()
        .await
        .map_err(|e| normalize_sqlserver_error("获取连接失败", e.to_string()))
}

pub(crate) fn list_schemas_sql() -> &'static str {
    "SELECT name \
     FROM sys.schemas \
     WHERE name NOT IN ('sys', 'INFORMATION_SCHEMA') \
     ORDER BY name"
}

pub async fn list_schemas(pool: &SqlServerPool) -> Result<Vec<String>, String> {
    let mut client = get_client_with_retry(pool).await?;
    let rows = client
        .simple_query(list_schemas_sql())
        .await
        .map_err(|e| normalize_sqlserver_error("查询 schema 列表失败", e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| normalize_sqlserver_error("读取 schema 列表失败", e.to_string()))?;

    Ok(rows
        .iter()
        .filter_map(|row| row.get::<&str, _>("name").map(str::to_string))
        .collect())
}

fn list_tables_sql(schema: &str) -> String {
    let schema = sqlserver_str(schema);
    format!(
        "WITH objects AS ( \
           SELECT t.object_id, t.name, CAST('TABLE' AS varchar(5)) AS table_type \
           FROM sys.tables t \
           JOIN sys.schemas s ON s.schema_id = t.schema_id \
           WHERE s.name = N{} AND t.is_ms_shipped = 0 \
           UNION ALL \
           SELECT v.object_id, v.name, CAST('VIEW' AS varchar(5)) AS table_type \
           FROM sys.views v \
           JOIN sys.schemas s ON s.schema_id = v.schema_id \
           WHERE s.name = N{} AND v.is_ms_shipped = 0 \
         ), stats AS ( \
           SELECT object_id, \
                  SUM(CASE WHEN index_id IN (0, 1) THEN row_count ELSE 0 END) AS rows_est, \
                  SUM(in_row_data_page_count + lob_used_page_count + row_overflow_used_page_count) * 8192 AS data_length, \
                  SUM(CASE WHEN used_page_count > in_row_data_page_count + lob_used_page_count + row_overflow_used_page_count \
                           THEN used_page_count - in_row_data_page_count - lob_used_page_count - row_overflow_used_page_count \
                           ELSE 0 END) * 8192 AS index_length \
           FROM sys.dm_db_partition_stats \
           GROUP BY object_id \
         ) \
         SELECT o.name, o.table_type, \
                CASE WHEN o.table_type = 'TABLE' THEN 'SQL Server' ELSE NULL END AS engine, \
                CASE WHEN o.table_type = 'TABLE' THEN CAST(COALESCE(st.rows_est, 0) AS bigint) ELSE NULL END AS rows_est, \
                CASE WHEN o.table_type = 'TABLE' THEN CAST(COALESCE(st.data_length, 0) AS bigint) ELSE NULL END AS data_length, \
                CASE WHEN o.table_type = 'TABLE' THEN CAST(COALESCE(st.index_length, 0) AS bigint) ELSE NULL END AS index_length, \
                COALESCE(CONVERT(nvarchar(4000), ep.value), N'') AS comment \
         FROM objects o \
         LEFT JOIN stats st ON st.object_id = o.object_id \
         LEFT JOIN sys.extended_properties ep \
           ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description' \
         ORDER BY o.name",
        schema, schema
    )
}

pub async fn list_tables(pool: &SqlServerPool, schema: &str) -> Result<Vec<TableInfo>, String> {
    let mut client = get_client_with_retry(pool).await?;
    let rows = client
        .simple_query(list_tables_sql(schema))
        .await
        .map_err(|e| normalize_sqlserver_error("查询表列表失败", e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| normalize_sqlserver_error("读取表列表失败", e.to_string()))?;

    Ok(rows
        .iter()
        .map(|row| TableInfo {
            name: row_string(row, "name"),
            table_type: row_string(row, "table_type"),
            engine: row.get::<&str, _>("engine").map(str::to_string),
            rows: i64_to_u64(row.get::<i64, _>("rows_est")),
            data_length: i64_to_u64(row.get::<i64, _>("data_length")),
            index_length: i64_to_u64(row.get::<i64, _>("index_length")),
            comment: row_string(row, "comment"),
        })
        .collect())
}

fn table_structure_sql(schema: &str, table: &str) -> String {
    format!(
        "WITH pk AS ( \
           SELECT ic.object_id, ic.column_id \
           FROM sys.indexes i \
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
           WHERE i.is_primary_key = 1 \
         ), pk_exists AS ( \
           SELECT DISTINCT object_id FROM pk \
         ), uq_candidate_keys AS ( \
           SELECT i.object_id, i.index_id, c.name AS first_key_name \
           FROM sys.indexes i \
           JOIN sys.index_columns first_ic \
             ON first_ic.object_id = i.object_id AND first_ic.index_id = i.index_id \
            AND first_ic.key_ordinal = 1 AND first_ic.is_included_column = 0 \
           JOIN sys.columns c ON c.object_id = first_ic.object_id AND c.column_id = first_ic.column_id \
           WHERE i.is_unique = 1 AND i.is_primary_key = 0 AND i.has_filter = 0 \
             AND i.is_disabled = 0 AND i.is_hypothetical = 0 \
             AND NOT EXISTS ( \
               SELECT 1 \
               FROM sys.index_columns ic2 \
               JOIN sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id \
               WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id \
                 AND ic2.is_included_column = 0 AND c2.is_computed = 1 \
             ) \
         ), uq_candidates AS ( \
           SELECT object_id, index_id, \
                  ROW_NUMBER() OVER (PARTITION BY object_id ORDER BY first_key_name, index_id) AS rank_no \
           FROM uq_candidate_keys \
         ), uq AS ( \
           SELECT ic.object_id, ic.column_id \
           FROM uq_candidates uq \
           JOIN sys.index_columns ic ON ic.object_id = uq.object_id AND ic.index_id = uq.index_id \
           WHERE uq.rank_no = 1 AND ic.is_included_column = 0 \
         ) \
         SELECT c.name AS column_name, \
                ty.name AS type_name, \
                CAST(c.max_length AS int) AS max_length, \
                CAST(c.precision AS int) AS precision_value, \
                CAST(c.scale AS int) AS scale_value, \
                c.is_nullable, \
                CASE WHEN pk.column_id IS NOT NULL THEN 'PRI' WHEN pk_exists.object_id IS NULL AND uq.column_id IS NOT NULL THEN 'UNI' ELSE '' END AS key_name, \
                dc.definition AS default_value, \
                CASE WHEN ident.column_id IS NULL THEN CAST(0 AS bit) ELSE CAST(1 AS bit) END AS is_identity, \
                comp.definition AS computed_definition, \
                CAST(ty.is_user_defined AS bit) AS is_user_defined, \
                COALESCE(CONVERT(nvarchar(4000), ep.value), N'') AS comment \
         FROM sys.columns c \
         JOIN sys.objects o ON o.object_id = c.object_id \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         JOIN sys.types ty ON ty.user_type_id = c.user_type_id \
         LEFT JOIN sys.default_constraints dc \
           ON dc.parent_object_id = c.object_id AND dc.parent_column_id = c.column_id \
         LEFT JOIN sys.identity_columns ident \
           ON ident.object_id = c.object_id AND ident.column_id = c.column_id \
         LEFT JOIN sys.computed_columns comp \
           ON comp.object_id = c.object_id AND comp.column_id = c.column_id \
         LEFT JOIN pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id \
         LEFT JOIN pk_exists ON pk_exists.object_id = c.object_id \
         LEFT JOIN uq ON uq.object_id = c.object_id AND uq.column_id = c.column_id \
         LEFT JOIN sys.extended_properties ep \
           ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = N'MS_Description' \
         WHERE s.name = N{} AND o.name = N{} AND o.type IN ('U', 'V') \
         ORDER BY c.column_id",
        sqlserver_str(schema),
        sqlserver_str(table)
    )
}

pub async fn get_table_structure(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let mut client = get_client_with_retry(pool).await?;
    let rows = client
        .simple_query(table_structure_sql(schema, table))
        .await
        .map_err(|e| normalize_sqlserver_error("查询表结构失败", e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| normalize_sqlserver_error("读取表结构失败", e.to_string()))?;

    Ok(rows
        .iter()
        .map(|row| {
            let type_name = row_string(row, "type_name");
            ColumnInfo {
                name: row_string(row, "column_name"),
                column_type: format_sqlserver_column_type(
                    &type_name,
                    row.get::<i32, _>("max_length"),
                    row.get::<i32, _>("precision_value"),
                    row.get::<i32, _>("scale_value"),
                    row.get::<bool, _>("is_user_defined").unwrap_or(false),
                ),
                nullable: row.get::<bool, _>("is_nullable").unwrap_or(false),
                key: row_string(row, "key_name"),
                default_value: row.get::<&str, _>("default_value").map(str::to_string),
                extra: build_sqlserver_column_extra(
                    row.get::<bool, _>("is_identity").unwrap_or(false),
                    row.get::<&str, _>("computed_definition")
                        .map(str::to_string),
                ),
                comment: row_string(row, "comment"),
            }
        })
        .collect())
}

pub(crate) fn format_sqlserver_column_type(
    type_name: &str,
    max_length: Option<i32>,
    precision: Option<i32>,
    scale: Option<i32>,
    _is_user_defined: bool,
) -> String {
    let lower = type_name.to_ascii_lowercase();
    match lower.as_str() {
        "nchar" | "nvarchar" => match max_length {
            Some(-1) => format!("{}(max)", type_name),
            Some(n) if n >= 0 => format!("{}({})", type_name, n / 2),
            _ => type_name.to_string(),
        },
        "char" | "varchar" | "binary" | "varbinary" => match max_length {
            Some(-1) => format!("{}(max)", type_name),
            Some(n) if n >= 0 => format!("{}({})", type_name, n),
            _ => type_name.to_string(),
        },
        "decimal" | "numeric" => match (precision, scale) {
            (Some(p), Some(s)) => format!("{}({},{})", type_name, p, s),
            _ => type_name.to_string(),
        },
        "datetime2" | "datetimeoffset" | "time" => match scale {
            Some(s) => format!("{}({})", type_name, s),
            _ => type_name.to_string(),
        },
        _ => type_name.to_string(),
    }
}

pub(crate) fn build_sqlserver_column_extra(
    is_identity: bool,
    computed_definition: Option<String>,
) -> String {
    let mut parts = Vec::new();
    if is_identity {
        parts.push("identity".to_string());
    }
    if let Some(definition) = computed_definition
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        parts.push(format!("computed AS {}", definition));
    }
    parts.join(" ")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SqlServerInputValue {
    Null,
    Text(String),
}

impl SqlServerInputValue {
    pub fn from_json(v: &JsonValue) -> Self {
        match v {
            JsonValue::Null => SqlServerInputValue::Null,
            JsonValue::Bool(true) => SqlServerInputValue::Text("1".to_string()),
            JsonValue::Bool(false) => SqlServerInputValue::Text("0".to_string()),
            JsonValue::Number(n) => SqlServerInputValue::Text(n.to_string()),
            JsonValue::String(s) => SqlServerInputValue::Text(s.clone()),
            other => SqlServerInputValue::Text(other.to_string()),
        }
    }

    fn as_owned_text(&self) -> Option<String> {
        match self {
            SqlServerInputValue::Null => None,
            SqlServerInputValue::Text(value) => Some(value.clone()),
        }
    }

    fn is_null(&self) -> bool {
        matches!(self, SqlServerInputValue::Null)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlServerRowUpdate {
    pub primary_keys: HashMap<String, JsonValue>,
    pub updates: HashMap<String, JsonValue>,
}

#[derive(Debug, Clone)]
struct SqlServerRowLocator {
    columns: Vec<String>,
}

const SQLSERVER_NO_ROW_LOCATOR_EDIT_ERROR: &str =
    "SQL Server 表没有主键或非过滤唯一索引，无法安全定位要修改的行";
const SQLSERVER_VIEW_EDIT_ERROR: &str = "SQL Server 视图暂不支持通过当前入口编辑";

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
        parts.push(format!("{} {}", sqlserver_id(col), safe_order));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", parts.join(", "))
    }
}

pub async fn query_table_count(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
    where_clause: Option<String>,
) -> Result<u64, String> {
    let where_sql = build_where_sql(&where_clause)?;
    let count_sql = sqlserver_count_query(schema, table, &where_sql);
    let mut client = get_client_with_retry(pool).await?;
    let row = client
        .simple_query(count_sql)
        .await
        .map_err(|e| normalize_sqlserver_error("查询总数失败", e.to_string()))?
        .into_row()
        .await
        .map_err(|e| normalize_sqlserver_error("读取总数失败", e.to_string()))?;

    Ok(row
        .and_then(|row| i64_to_u64(row.get::<i64, _>("cnt")))
        .unwrap_or(0))
}

#[allow(clippy::too_many_arguments)]
pub async fn query_table_data(
    pool: &SqlServerPool,
    schema: &str,
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
    let mut client = get_client_with_retry(pool).await?;

    let total = if skip_count == Some(true) {
        0
    } else {
        let count_sql = sqlserver_count_query(schema, table, &where_sql);
        let row = client
            .simple_query(count_sql)
            .await
            .map_err(|e| normalize_sqlserver_error("查询总数失败", e.to_string()))?
            .into_row()
            .await
            .map_err(|e| normalize_sqlserver_error("读取总数失败", e.to_string()))?;
        row.and_then(|row| i64_to_u64(row.get::<i64, _>("cnt")))
            .unwrap_or(0)
    };

    let mut pk_cols: Option<Vec<String>> = None;
    let mut selected_columns_for_empty_result: Option<Vec<String>> = None;
    let select_part = match &select_columns {
        Some(cols) if !cols.is_empty() => {
            let fetched_pk =
                fetch_row_locator_columns_on_client(&mut client, schema, table).await?;
            let mut merged = cols.clone();
            for pk in &fetched_pk {
                if !merged.iter().any(|c| c == pk) {
                    merged.push(pk.clone());
                }
            }
            pk_cols = Some(fetched_pk);
            selected_columns_for_empty_result = Some(merged.clone());
            merged
                .iter()
                .map(|c| sqlserver_id(c))
                .collect::<Vec<_>>()
                .join(", ")
        }
        _ => "*".to_string(),
    };

    let order_sql = if order_sql.trim().is_empty() {
        let pk = match &pk_cols {
            Some(cols) => cols.clone(),
            None => {
                let fetched =
                    fetch_row_locator_columns_on_client(&mut client, schema, table).await?;
                fetched
            }
        };
        if !pk.is_empty() {
            format!(
                " ORDER BY {}",
                pk.iter()
                    .map(|c| format!("{} ASC", sqlserver_id(c)))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        } else {
            let columns = fetch_column_names_on_client(&mut client, schema, table).await?;
            if columns.is_empty() {
                String::new()
            } else {
                format!(
                    " ORDER BY {}",
                    columns
                        .iter()
                        .map(|c| format!("{} ASC", sqlserver_id(c)))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            }
        }
    } else {
        order_sql
    };

    let offset = page.saturating_sub(1) as u64 * page_size as u64;
    let data_sql = sqlserver_paginated_select(
        &select_part,
        schema,
        table,
        &where_sql,
        &order_sql,
        page_size as u64,
        offset,
    );

    let rows = client
        .simple_query(data_sql)
        .await
        .map_err(|e| normalize_sqlserver_error("查询数据失败", e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| normalize_sqlserver_error("读取数据失败", e.to_string()))?;
    let (mut columns, rows) = rows_to_columns_and_json(&rows);

    if columns.is_empty() && rows.is_empty() {
        columns = match selected_columns_for_empty_result {
            Some(cols) => cols,
            None => fetch_column_names_on_client(&mut client, schema, table).await?,
        };
    }

    Ok(QueryResult {
        columns,
        rows,
        total,
        execution_time_ms: start.elapsed().as_millis() as u64,
    })
}

pub async fn run_sql_on_pool(
    pool: &SqlServerPool,
    sql: &str,
    read_only: bool,
    start: Instant,
) -> Result<SqlExecuteResult, String> {
    if read_only && !sqlserver_sql_editor_allowed_on_read_only_connection(sql) {
        return Err(
            "当前连接为只读模式，仅允许 SELECT/WITH SELECT/EXPLAIN/SHOWPLAN 等读操作".to_string(),
        );
    }

    let mut client = get_client_with_retry(pool).await?;
    if SQLSERVER_DIALECT.sql_editor_returns_result_set(sql) {
        return materialize_limited_sql(&mut client, sql, start).await;
    }

    if read_only {
        return Err("当前连接为只读模式，不允许执行 DML/DDL".to_string());
    }

    let params: [&dyn tiberius::ToSql; 0] = [];
    let affected = client
        .execute(sql, &params)
        .await
        .map_err(|e| normalize_sqlserver_error("执行 SQL 失败", e.to_string()))?
        .total();
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

async fn materialize_limited_sql(
    client: &mut SqlServerPooledConnection<'_>,
    sql: &str,
    start: Instant,
) -> Result<SqlExecuteResult, String> {
    let mut stream = client
        .simple_query(sql)
        .await
        .map_err(|e| normalize_sqlserver_error("执行查询失败", e.to_string()))?;

    let columns = stream
        .columns()
        .await
        .map_err(|e| normalize_sqlserver_error("读取查询列失败", e.to_string()))?
        .map(|columns| {
            columns
                .iter()
                .map(|column| column.name().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut rows = Vec::new();
    let mut row_stream = stream.into_row_stream();
    while let Some(row) = row_stream
        .try_next()
        .await
        .map_err(|e| normalize_sqlserver_error("读取查询结果失败", e.to_string()))?
    {
        if rows.len() >= MAX_EXECUTE_SQL_SELECT_ROWS {
            return Err(format!(
                "查询结果超过最大行数 {}（与 Excel 导出行上限一致），请使用 TOP、OFFSET/FETCH 或缩小范围后重试",
                MAX_EXECUTE_SQL_SELECT_ROWS
            ));
        }
        rows.push(row_to_json(&row));
    }

    let elapsed = start.elapsed().as_millis() as u64;
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

fn row_to_json(row: &Row) -> Vec<JsonValue> {
    row.cells()
        .map(|(_, value)| sqlserver_column_data_to_json(value))
        .collect()
}

pub(crate) fn sql_completion_metadata_sql(schema: &str) -> String {
    format!(
        "SELECT o.name AS table_name, \
                c.name AS column_name, \
                ty.name AS type_name, \
                CAST(c.max_length AS int) AS max_length, \
                CAST(c.precision AS int) AS precision_value, \
                CAST(c.scale AS int) AS scale_value, \
                CAST(COALESCE(ty.is_user_defined, 0) AS bit) AS is_user_defined \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         LEFT JOIN sys.columns c ON c.object_id = o.object_id \
         LEFT JOIN sys.types ty ON ty.user_type_id = c.user_type_id \
         WHERE s.name = N{} \
           AND o.type IN ('U', 'V') \
           AND o.is_ms_shipped = 0 \
         ORDER BY o.name, c.column_id",
        sqlserver_str(schema)
    )
}

pub async fn get_sql_completion_metadata(
    pool: &SqlServerPool,
    database: Option<String>,
) -> Result<SqlCompletionMetadata, String> {
    let databases = list_schemas(pool).await?;
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

    let mut client = get_client_with_retry(pool).await?;
    let rows = client
        .simple_query(sql_completion_metadata_sql(&schema))
        .await
        .map_err(|e| normalize_sqlserver_error("查询 SQL 补全元数据失败", e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| normalize_sqlserver_error("读取 SQL 补全元数据失败", e.to_string()))?;

    let mut seen_tables = BTreeSet::new();
    let mut tables = Vec::new();
    let mut columns = Vec::new();

    for row in rows {
        let table_name = row_string(&row, "table_name");
        if table_name.is_empty() {
            continue;
        }
        if seen_tables.insert(table_name.clone()) {
            tables.push(SqlCompletionTable {
                name: table_name.clone(),
            });
        }
        let Some(column_name) = row.get::<&str, _>("column_name").map(str::to_string) else {
            continue;
        };
        let data_type = row.get::<&str, _>("type_name").map(|type_name| {
            format_sqlserver_column_type(
                type_name,
                row.get::<i32, _>("max_length"),
                row.get::<i32, _>("precision_value"),
                row.get::<i32, _>("scale_value"),
                row.get::<bool, _>("is_user_defined").unwrap_or(false),
            )
        });
        columns.push(SqlCompletionColumn {
            table: table_name,
            name: column_name,
            data_type,
        });
    }

    Ok(SqlCompletionMetadata {
        databases,
        tables,
        columns,
    })
}

pub(crate) fn session_info_sql() -> &'static str {
    "SELECT CONVERT(nvarchar(max), @@VERSION) AS version, \
            CONVERT(nvarchar(256), @@SERVERNAME) AS hostname, \
            DB_NAME() AS database_name, \
            CAST(@@SPID AS bigint) AS connection_id, \
            CAST(CASE WHEN DATABASEPROPERTYEX(DB_NAME(), 'Updateability') = 'READ_ONLY' THEN 1 ELSE 0 END AS bit) AS server_read_only, \
            CONVERT(nvarchar(16), DATENAME(TzOffset, SYSDATETIMEOFFSET())) AS time_zone"
}

pub(crate) fn grant_write_capable_sql() -> &'static str {
    "SELECT CAST(CASE WHEN EXISTS ( \
                SELECT 1 \
                FROM fn_my_permissions(NULL, 'DATABASE') \
                WHERE permission_name IN ( \
                    'ALTER', 'CONTROL', 'CREATE TABLE', 'CREATE VIEW', 'CREATE PROCEDURE', \
                    'DELETE', 'EXECUTE', 'INSERT', 'REFERENCES', 'TAKE OWNERSHIP', 'UPDATE' \
                ) \
            ) THEN 1 ELSE 0 END AS bit) AS grant_write_capable"
}

pub async fn get_session_info(
    pool: &SqlServerPool,
    _database: Option<String>,
    read_only: bool,
) -> Result<SessionInfo, String> {
    let mut client = get_client_with_retry(pool).await?;
    let row = client
        .simple_query(session_info_sql())
        .await
        .map_err(|e| normalize_sqlserver_error("读取会话信息失败", e.to_string()))?
        .into_row()
        .await
        .map_err(|e| normalize_sqlserver_error("解析会话信息失败", e.to_string()))?
        .ok_or_else(|| "无法读取 SQL Server 会话信息".to_string())?;

    let server_read_only = read_only || row.get::<bool, _>("server_read_only").unwrap_or(false);
    let grant_write_capable = if server_read_only {
        false
    } else {
        fetch_grant_write_capable(&mut client).await
    };

    Ok(SessionInfo {
        version: row_string(&row, "version"),
        hostname: row_string(&row, "hostname"),
        server_read_only,
        max_execution_time_ms: 0,
        time_zone: row_string(&row, "time_zone"),
        database: row
            .get::<&str, _>("database_name")
            .map(str::to_string)
            .filter(|s| !s.is_empty()),
        connection_id: row
            .get::<i64, _>("connection_id")
            .and_then(|v| u64::try_from(v).ok())
            .unwrap_or(0),
        grant_write_capable,
    })
}

async fn fetch_grant_write_capable(client: &mut SqlServerPooledConnection<'_>) -> bool {
    let row = match client.simple_query(grant_write_capable_sql()).await {
        Ok(stream) => match stream.into_row().await {
            Ok(row) => row,
            Err(_) => return true,
        },
        Err(_) => return true,
    };
    row.and_then(|row| row.get::<bool, _>("grant_write_capable"))
        .unwrap_or(true)
}

#[cfg(test)]
pub(crate) fn build_showplan_text_sql(sql: &str) -> String {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    format!(
        "SET SHOWPLAN_TEXT ON;\n{};\nSET SHOWPLAN_TEXT OFF;",
        trimmed
    )
}

pub async fn explain_sql_on_pool(
    pool: &SqlServerPool,
    sql: &str,
    analyze: bool,
    start: Instant,
) -> Result<SqlExecuteResult, String> {
    if analyze {
        return Err("SQL Server 暂不支持 EXPLAIN ANALYZE".to_string());
    }

    let trimmed = sql.trim().trim_end_matches(';').trim();
    if trimmed.is_empty() {
        return Err("SQL 语句不能为空".to_string());
    }

    let mut client = get_client_with_retry(pool).await?;
    drain_simple_query(&mut client, "SET SHOWPLAN_TEXT ON", "开启执行计划失败").await?;
    let result = materialize_limited_sql(&mut client, trimmed, start).await;
    let close_result =
        drain_simple_query(&mut client, "SET SHOWPLAN_TEXT OFF", "关闭执行计划失败").await;

    match (result, close_result) {
        (Ok(result), Ok(())) => Ok(result),
        (Err(err), _) => Err(err),
        (Ok(_), Err(err)) => Err(err),
    }
}

async fn drain_simple_query(
    client: &mut SqlServerPooledConnection<'_>,
    sql: &str,
    context: &str,
) -> Result<(), String> {
    client
        .simple_query(sql)
        .await
        .map_err(|e| normalize_sqlserver_error(context, e.to_string()))?
        .into_results()
        .await
        .map_err(|e| normalize_sqlserver_error(context, e.to_string()))?;
    Ok(())
}

pub async fn cancel_query() -> Result<bool, String> {
    Err("SQL Server 暂不支持取消当前查询".to_string())
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

async fn fetch_column_names_on_client(
    client: &mut SqlServerPooledConnection<'_>,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let sql = format!(
        "SELECT c.name \
         FROM sys.columns c \
         JOIN sys.objects o ON o.object_id = c.object_id \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = N{} AND o.name = N{} AND o.type IN ('U', 'V') \
         ORDER BY c.column_id",
        sqlserver_str(schema),
        sqlserver_str(table)
    );
    let rows = client
        .simple_query(sql)
        .await
        .map_err(|e| normalize_sqlserver_error("获取列信息失败", e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| normalize_sqlserver_error("读取列信息失败", e.to_string()))?;
    Ok(rows
        .iter()
        .filter_map(|row| row.get::<&str, _>("name").map(str::to_string))
        .collect())
}

async fn ensure_editable_table_on_client(
    client: &mut SqlServerPooledConnection<'_>,
    schema: &str,
    table: &str,
) -> Result<SqlServerRowLocator, String> {
    let object_sql = format!(
        "SELECT o.type \
         FROM sys.objects o \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = N{} AND o.name = N{} AND o.type IN ('U', 'V')",
        sqlserver_str(schema),
        sqlserver_str(table)
    );
    let object_row = client
        .simple_query(object_sql)
        .await
        .map_err(|e| normalize_sqlserver_error("查询表类型失败", e.to_string()))?
        .into_row()
        .await
        .map_err(|e| normalize_sqlserver_error("读取表类型失败", e.to_string()))?;
    let object_type = object_row
        .as_ref()
        .and_then(|row| row.get::<&str, _>("type"))
        .unwrap_or("");
    if object_type == "V" {
        return Err(SQLSERVER_VIEW_EDIT_ERROR.to_string());
    }
    if object_type != "U" {
        return Err(format!("SQL Server 表 `{}`.`{}` 不存在", schema, table));
    }

    let rows = client
        .simple_query(row_locator_sql(schema, table))
        .await
        .map_err(|e| normalize_sqlserver_error("查询行定位键信息失败", e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| normalize_sqlserver_error("读取行定位键信息失败", e.to_string()))?;

    let mut grouped: BTreeMap<i32, (bool, Vec<(i32, String)>)> = BTreeMap::new();
    for row in rows {
        let Some(index_id) = row.get::<i32, _>("index_id") else {
            continue;
        };
        let is_primary = row.get::<bool, _>("is_primary_key").unwrap_or(false);
        let key_ordinal = row.get::<i32, _>("key_ordinal").unwrap_or(0);
        let column = row_string(&row, "name");
        if column.is_empty() || key_ordinal <= 0 {
            continue;
        }
        let entry = grouped.entry(index_id).or_insert((is_primary, Vec::new()));
        entry.0 = entry.0 || is_primary;
        entry.1.push((key_ordinal, column));
    }

    let mut candidates = grouped
        .into_values()
        .map(|(is_primary, mut cols)| {
            cols.sort_by_key(|(ordinal, _)| *ordinal);
            (
                is_primary,
                cols.into_iter()
                    .map(|(_, column)| column)
                    .collect::<Vec<_>>(),
            )
        })
        .filter(|(_, cols)| !cols.is_empty())
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(is_primary, cols)| {
        (
            if *is_primary { 0 } else { 1 },
            cols.first().cloned().unwrap_or_default(),
        )
    });

    let Some((_, columns)) = candidates.into_iter().next() else {
        return Err(SQLSERVER_NO_ROW_LOCATOR_EDIT_ERROR.to_string());
    };

    Ok(SqlServerRowLocator { columns })
}

async fn fetch_row_locator_columns_on_client(
    client: &mut SqlServerPooledConnection<'_>,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let rows = client
        .simple_query(row_locator_sql(schema, table))
        .await
        .map_err(|e| normalize_sqlserver_error("查询行定位键信息失败", e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| normalize_sqlserver_error("读取行定位键信息失败", e.to_string()))?;

    let mut grouped: BTreeMap<i32, (bool, Vec<(i32, String)>)> = BTreeMap::new();
    for row in rows {
        let Some(index_id) = row.get::<i32, _>("index_id") else {
            continue;
        };
        let is_primary = row.get::<bool, _>("is_primary_key").unwrap_or(false);
        let key_ordinal = row.get::<i32, _>("key_ordinal").unwrap_or(0);
        let column = row_string(&row, "name");
        if column.is_empty() || key_ordinal <= 0 {
            continue;
        }
        let entry = grouped.entry(index_id).or_insert((is_primary, Vec::new()));
        entry.0 = entry.0 || is_primary;
        entry.1.push((key_ordinal, column));
    }
    let mut candidates = grouped
        .into_values()
        .map(|(is_primary, mut cols)| {
            cols.sort_by_key(|(ordinal, _)| *ordinal);
            (
                is_primary,
                cols.into_iter()
                    .map(|(_, column)| column)
                    .collect::<Vec<_>>(),
            )
        })
        .filter(|(_, cols)| !cols.is_empty())
        .collect::<Vec<_>>();
    candidates.sort_by_key(|(is_primary, cols)| {
        (
            if *is_primary { 0 } else { 1 },
            cols.first().cloned().unwrap_or_default(),
        )
    });
    Ok(candidates
        .into_iter()
        .next()
        .map(|(_, cols)| cols)
        .unwrap_or_default())
}

fn row_locator_sql(schema: &str, table: &str) -> String {
    format!(
        "SELECT CAST(i.index_id AS int) AS index_id, \
                CAST(i.is_primary_key AS bit) AS is_primary_key, \
                CAST(ic.key_ordinal AS int) AS key_ordinal, \
                c.name \
         FROM sys.indexes i \
         JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id \
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id \
         JOIN sys.objects o ON o.object_id = i.object_id \
         JOIN sys.schemas s ON s.schema_id = o.schema_id \
         WHERE s.name = N{} AND o.name = N{} AND o.type = 'U' \
           AND ic.is_included_column = 0 \
           AND NOT EXISTS ( \
             SELECT 1 \
             FROM sys.index_columns ic2 \
             JOIN sys.columns c2 ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id \
             WHERE ic2.object_id = i.object_id AND ic2.index_id = i.index_id \
               AND ic2.is_included_column = 0 AND c2.is_computed = 1 \
           ) \
           AND (i.is_primary_key = 1 OR (i.is_unique = 1 AND i.has_filter = 0 AND i.is_disabled = 0 AND i.is_hypothetical = 0)) \
         ORDER BY CASE WHEN i.is_primary_key = 1 THEN 0 ELSE 1 END, i.index_id, ic.key_ordinal",
        sqlserver_str(schema),
        sqlserver_str(table)
    )
}

pub async fn fetch_edit_locator(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let mut client = get_client_with_retry(pool).await?;
    Ok(ensure_editable_table_on_client(&mut client, schema, table)
        .await?
        .columns)
}

fn map_entries(values: &HashMap<String, JsonValue>) -> Vec<(String, SqlServerInputValue)> {
    values
        .iter()
        .map(|(k, v)| (k.clone(), SqlServerInputValue::from_json(v)))
        .collect()
}

fn ordered_locator_entries(
    locator_columns: &[String],
    values: &HashMap<String, JsonValue>,
    missing_message: &str,
) -> Result<Vec<(String, SqlServerInputValue)>, String> {
    if locator_columns.is_empty() {
        return Err(SQLSERVER_NO_ROW_LOCATOR_EDIT_ERROR.to_string());
    }
    if locator_columns
        .iter()
        .any(|column| !values.contains_key(column))
    {
        return Err(missing_message.to_string());
    }
    Ok(locator_columns
        .iter()
        .map(|column| {
            (
                column.clone(),
                SqlServerInputValue::from_json(values.get(column).expect("locator checked")),
            )
        })
        .collect())
}

fn map_locator_rows(
    locator_columns: &[String],
    rows: &[HashMap<String, JsonValue>],
) -> Result<Vec<Vec<(String, SqlServerInputValue)>>, String> {
    if rows.is_empty() {
        return Err("没有提供要删除的行".to_string());
    }
    rows.iter()
        .map(|row| ordered_locator_entries(locator_columns, row, "存在主键信息不完整的行"))
        .collect()
}

pub fn build_insert_statement(
    schema: &str,
    table: &str,
    entries: &[(String, SqlServerInputValue)],
) -> (String, Vec<SqlServerInputValue>) {
    let cols_sql = entries
        .iter()
        .map(|(column, _)| sqlserver_id(column))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = (1..=entries.len())
        .map(|idx| format!("@P{}", idx))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO {}.{} ({}) VALUES ({})",
        sqlserver_id(schema),
        sqlserver_id(table),
        cols_sql,
        placeholders
    );
    let params = entries.iter().map(|(_, v)| v.clone()).collect();
    (sql, params)
}

pub fn build_update_statement(
    schema: &str,
    table: &str,
    primary_keys: &[(String, SqlServerInputValue)],
    updates: &[(String, SqlServerInputValue)],
) -> (String, Vec<SqlServerInputValue>) {
    let mut idx = 1usize;
    let mut params = Vec::with_capacity(updates.len() + primary_keys.len());

    let set_parts = updates
        .iter()
        .map(|(column, value)| {
            let part = format!("{} = @P{}", sqlserver_id(column), idx);
            idx += 1;
            params.push(value.clone());
            part
        })
        .collect::<Vec<_>>();
    let where_parts = primary_keys
        .iter()
        .map(|(column, value)| {
            if value.is_null() {
                format!("{} IS NULL", sqlserver_id(column))
            } else {
                let part = format!("{} = @P{}", sqlserver_id(column), idx);
                idx += 1;
                params.push(value.clone());
                part
            }
        })
        .collect::<Vec<_>>();

    (
        format!(
            "UPDATE {}.{} SET {} WHERE {}",
            sqlserver_id(schema),
            sqlserver_id(table),
            set_parts.join(", "),
            where_parts.join(" AND ")
        ),
        params,
    )
}

pub fn build_delete_statement(
    schema: &str,
    table: &str,
    rows: &[Vec<(String, SqlServerInputValue)>],
) -> (String, Vec<SqlServerInputValue>) {
    let first_row = rows.first().expect("primary key rows must not be empty");
    let mut idx = 1usize;
    let mut params = Vec::new();

    let where_sql = if first_row.len() == 1 && rows.iter().all(|row| !row[0].1.is_null()) {
        let primary_key_column = &first_row[0].0;
        let placeholders = rows
            .iter()
            .map(|row| {
                let placeholder = format!("@P{}", idx);
                idx += 1;
                params.push(row[0].1.clone());
                placeholder
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("{} IN ({})", sqlserver_id(primary_key_column), placeholders)
    } else {
        build_or_locator_predicate(rows, &mut idx, &mut params)
    };

    (
        format!(
            "DELETE FROM {}.{} WHERE {}",
            sqlserver_id(schema),
            sqlserver_id(table),
            where_sql
        ),
        params,
    )
}

fn build_or_locator_predicate(
    rows: &[Vec<(String, SqlServerInputValue)>],
    idx: &mut usize,
    params: &mut Vec<SqlServerInputValue>,
) -> String {
    rows.iter()
        .map(|row| {
            let parts = row
                .iter()
                .map(|(column, value)| {
                    if value.is_null() {
                        format!("{} IS NULL", sqlserver_id(column))
                    } else {
                        let part = format!("{} = @P{}", sqlserver_id(column), *idx);
                        *idx += 1;
                        params.push(value.clone());
                        part
                    }
                })
                .collect::<Vec<_>>()
                .join(" AND ");
            format!("({})", parts)
        })
        .collect::<Vec<_>>()
        .join(" OR ")
}

async fn execute_with_text_params(
    client: &mut SqlServerPooledConnection<'_>,
    sql: &str,
    values: &[SqlServerInputValue],
) -> Result<u64, String> {
    let owned: Vec<Option<String>> = values.iter().map(|v| v.as_owned_text()).collect();
    let params: Vec<&dyn tiberius::ToSql> = owned
        .iter()
        .map(|opt| opt as &dyn tiberius::ToSql)
        .collect();
    client
        .execute(sql, &params)
        .await
        .map(|result| result.total())
        .map_err(|e| normalize_sqlserver_error("执行写操作失败", e.to_string()))
}

pub async fn insert_row(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
    values: HashMap<String, JsonValue>,
) -> Result<u64, String> {
    if values.is_empty() {
        return Err("没有提供要插入的数据".to_string());
    }
    let mut client = get_client_with_retry(pool).await?;
    ensure_editable_table_on_client(&mut client, schema, table).await?;
    let entries = map_entries(&values);
    let (sql, params) = build_insert_statement(schema, table, &entries);
    execute_with_text_params(&mut client, &sql, &params).await
}

pub async fn update_row(
    pool: &SqlServerPool,
    schema: &str,
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
    let mut client = get_client_with_retry(pool).await?;
    let locator = ensure_editable_table_on_client(&mut client, schema, table).await?;
    let pk_entries =
        ordered_locator_entries(&locator.columns, &primary_keys, "存在缺少主键信息的行")?;
    let upd_entries = map_entries(&updates);
    let (sql, params) = build_update_statement(schema, table, &pk_entries, &upd_entries);
    execute_with_text_params(&mut client, &sql, &params).await
}

fn prepare_batch_update_statements(
    schema: &str,
    table: &str,
    locator_columns: &[String],
    rows: &[SqlServerRowUpdate],
) -> Result<Vec<(String, Vec<SqlServerInputValue>)>, String> {
    rows.iter()
        .map(|row| {
            let pk_entries = ordered_locator_entries(
                locator_columns,
                &row.primary_keys,
                "存在缺少主键信息的行",
            )?;
            let upd_entries = map_entries(&row.updates);
            Ok(build_update_statement(
                schema,
                table,
                &pk_entries,
                &upd_entries,
            ))
        })
        .collect()
}

pub async fn batch_update_rows(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
    rows: Vec<SqlServerRowUpdate>,
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

    let mut client = get_client_with_retry(pool).await?;
    let locator = ensure_editable_table_on_client(&mut client, schema, table).await?;
    let statements = prepare_batch_update_statements(schema, table, &locator.columns, &rows)?;
    drain_simple_query(&mut client, "BEGIN TRANSACTION", "开启事务失败").await?;

    let mut total = 0u64;
    for (sql, params) in &statements {
        match execute_with_text_params(&mut client, &sql, &params).await {
            Ok(affected) => total += affected,
            Err(err) => {
                let _ =
                    drain_simple_query(&mut client, "ROLLBACK TRANSACTION", "回滚事务失败").await;
                return Err(format!("批量更新失败，已回滚（未提交任何修改）: {}", err));
            }
        }
    }

    drain_simple_query(&mut client, "COMMIT TRANSACTION", "提交事务失败").await?;
    Ok(total)
}

pub async fn delete_rows(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
    primary_keys: Vec<HashMap<String, JsonValue>>,
) -> Result<u64, String> {
    let mut client = get_client_with_retry(pool).await?;
    let locator = ensure_editable_table_on_client(&mut client, schema, table).await?;
    let rows = map_locator_rows(&locator.columns, &primary_keys)?;
    let (sql, params) = build_delete_statement(schema, table, &rows);
    execute_with_text_params(&mut client, &sql, &params).await
}

pub async fn query_full_rows(
    pool: &SqlServerPool,
    schema: &str,
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
        .collect();
    query_full_rows_by_primary_keys(pool, schema, table, primary_keys).await
}

pub async fn query_full_rows_by_primary_keys(
    pool: &SqlServerPool,
    schema: &str,
    table: &str,
    primary_keys: Vec<HashMap<String, JsonValue>>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let mut client = get_client_with_retry(pool).await?;
    let locator = ensure_editable_table_on_client(&mut client, schema, table).await?;
    let rows = map_locator_rows(&locator.columns, &primary_keys)?;

    let mut idx = 1usize;
    let mut params = Vec::new();
    let where_sql = build_or_locator_predicate(&rows, &mut idx, &mut params);
    let sql = format!(
        "SELECT * FROM {}.{} WHERE {}",
        sqlserver_id(schema),
        sqlserver_id(table),
        where_sql
    );
    let owned: Vec<Option<String>> = params.iter().map(|v| v.as_owned_text()).collect();
    let bound: Vec<&dyn tiberius::ToSql> = owned
        .iter()
        .map(|opt| opt as &dyn tiberius::ToSql)
        .collect();
    let result_rows = client
        .query(sql, &bound)
        .await
        .map_err(|e| normalize_sqlserver_error("查询完整行数据失败", e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| normalize_sqlserver_error("读取完整行数据失败", e.to_string()))?;
    let (columns, json_rows) = rows_to_columns_and_json(&result_rows);
    Ok(QueryResult {
        columns,
        total: json_rows.len() as u64,
        rows: json_rows,
        execution_time_ms: start.elapsed().as_millis() as u64,
    })
}

fn rows_to_columns_and_json(rows: &[Row]) -> (Vec<String>, Vec<Vec<JsonValue>>) {
    let columns = rows
        .first()
        .map(|row| {
            row.columns()
                .iter()
                .map(|column| column.name().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let json_rows = rows
        .iter()
        .map(|row| {
            row.cells()
                .map(|(_, value)| sqlserver_column_data_to_json(value))
                .collect::<Vec<_>>()
        })
        .collect();
    (columns, json_rows)
}

pub(crate) fn sqlserver_column_data_to_json(value: &ColumnData<'static>) -> JsonValue {
    match value {
        ColumnData::U8(Some(v)) => serde_json::json!(*v),
        ColumnData::U8(None)
        | ColumnData::I16(None)
        | ColumnData::I32(None)
        | ColumnData::I64(None)
        | ColumnData::F32(None)
        | ColumnData::F64(None)
        | ColumnData::Bit(None)
        | ColumnData::String(None)
        | ColumnData::Guid(None)
        | ColumnData::Binary(None)
        | ColumnData::Numeric(None)
        | ColumnData::Xml(None)
        | ColumnData::DateTime(None)
        | ColumnData::SmallDateTime(None)
        | ColumnData::Time(None)
        | ColumnData::Date(None)
        | ColumnData::DateTime2(None)
        | ColumnData::DateTimeOffset(None) => JsonValue::Null,
        ColumnData::I16(Some(v)) => serde_json::json!(*v),
        ColumnData::I32(Some(v)) => serde_json::json!(*v),
        ColumnData::I64(Some(v)) => i64_to_json(*v),
        ColumnData::F32(Some(v)) => serde_json::json!(*v),
        ColumnData::F64(Some(v)) => serde_json::json!(*v),
        ColumnData::Bit(Some(v)) => serde_json::json!(*v),
        ColumnData::String(Some(v)) => JsonValue::String(v.to_string()),
        ColumnData::Guid(Some(v)) => JsonValue::String(v.to_string()),
        ColumnData::Binary(Some(v)) => JsonValue::String(format!("[binary {} bytes]", v.len())),
        ColumnData::Numeric(Some(v)) => JsonValue::String(sqlserver_numeric_to_string(*v)),
        ColumnData::Xml(Some(v)) => JsonValue::String(v.as_ref().as_ref().to_string()),
        ColumnData::DateTime(Some(v)) => JsonValue::String(format_sqlserver_datetime(*v)),
        ColumnData::SmallDateTime(Some(v)) => {
            JsonValue::String(format_sqlserver_small_datetime(*v))
        }
        ColumnData::Time(Some(v)) => JsonValue::String(format_sqlserver_time(*v)),
        ColumnData::Date(Some(v)) => JsonValue::String(format_sqlserver_date(*v)),
        ColumnData::DateTime2(Some(v)) => JsonValue::String(format_sqlserver_datetime2(*v)),
        ColumnData::DateTimeOffset(Some(v)) => {
            JsonValue::String(format_sqlserver_datetimeoffset(*v))
        }
    }
}

fn row_string(row: &Row, column: &str) -> String {
    row.get::<&str, _>(column)
        .map(str::to_string)
        .unwrap_or_default()
}

fn i64_to_u64(value: Option<i64>) -> Option<u64> {
    value.and_then(|v| u64::try_from(v).ok())
}

fn i64_to_json(value: i64) -> JsonValue {
    if (JS_MIN_SAFE_INTEGER..=JS_MAX_SAFE_INTEGER).contains(&value) {
        serde_json::json!(value)
    } else {
        JsonValue::String(value.to_string())
    }
}

fn sqlserver_numeric_to_string(value: tiberius::numeric::Numeric) -> String {
    let scale = value.scale() as u32;
    let raw = value.value();
    if scale == 0 {
        return raw.to_string();
    }
    let sign = if raw < 0 { "-" } else { "" };
    let abs = if raw < 0 { -raw } else { raw };
    let pow = 10i128.pow(scale);
    let int_part = abs / pow;
    let dec_part = abs % pow;
    format!(
        "{}{}.{:0width$}",
        sign,
        int_part,
        dec_part,
        width = scale as usize
    )
}

fn format_sqlserver_date(value: tiberius::time::Date) -> String {
    let (year, month, day) = civil_from_days(value.days() as i64 - DAYS_0001_TO_1970);
    format!("{:04}-{:02}-{:02}", year, month, day)
}

fn format_sqlserver_time(value: tiberius::time::Time) -> String {
    let scale = value.scale();
    let pow = 10u64.pow(scale as u32);
    let increments = value.increments();
    let total_seconds = increments / pow;
    let frac = increments % pow;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    if scale == 0 {
        format!("{:02}:{:02}:{:02}", hours, minutes, seconds)
    } else {
        format!(
            "{:02}:{:02}:{:02}.{:0width$}",
            hours,
            minutes,
            seconds,
            frac,
            width = scale as usize
        )
    }
}

fn format_sqlserver_datetime2(value: tiberius::time::DateTime2) -> String {
    format!(
        "{} {}",
        format_sqlserver_date(value.date()),
        format_sqlserver_time(value.time())
    )
}

fn format_sqlserver_datetimeoffset(value: tiberius::time::DateTimeOffset) -> String {
    let offset = value.offset();
    let sign = if offset < 0 { '-' } else { '+' };
    let abs = offset.abs();
    format!(
        "{} {}{:02}:{:02}",
        format_sqlserver_datetime2(value.datetime2()),
        sign,
        abs / 60,
        abs % 60
    )
}

fn format_sqlserver_datetime(value: tiberius::time::DateTime) -> String {
    let base_days = days_since_year1(1900, 1, 1);
    let (year, month, day) = civil_from_days(base_days + value.days() as i64 - DAYS_0001_TO_1970);
    let total_millis = value.seconds_fragments() as u64 * 1000 / 300;
    let total_seconds = total_millis / 1000;
    let millis = total_millis % 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    if millis == 0 {
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            year, month, day, hours, minutes, seconds
        )
    } else {
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}.{:03}",
            year, month, day, hours, minutes, seconds, millis
        )
    }
}

fn format_sqlserver_small_datetime(value: tiberius::time::SmallDateTime) -> String {
    let base_days = days_since_year1(1900, 1, 1);
    let (year, month, day) = civil_from_days(base_days + value.days() as i64 - DAYS_0001_TO_1970);
    let total_seconds = value.seconds_fragments() as u64 * 60;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:00",
        year, month, day, hours, minutes
    )
}

fn days_since_year1(year: i32, month: u32, day: u32) -> i64 {
    days_from_civil(year, month, day) + DAYS_0001_TO_1970
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = year as i64 - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let mp = month as i64 + if month > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days_since_1970: i64) -> (i32, u32, u32) {
    let z = days_since_1970 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = y + i64::from(month <= 2);
    (year as i32, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{ConnectionConfig, DatabaseType};

    fn sample_config() -> ConnectionConfig {
        ConnectionConfig {
            id: None,
            database_type: DatabaseType::SqlServer,
            name: "SQL Server".to_string(),
            host: "sql.example.com".to_string(),
            port: 1433,
            username: "sa".to_string(),
            password: Some("secret".to_string()),
            database: Some("appdb".to_string()),
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
    fn build_tiberius_config_sets_addr_database_and_auth_without_leaking_password() {
        let config = sample_config();

        let tds = build_tiberius_config("127.0.0.1", 14330, &config).unwrap();
        let debug = format!("{:?}", tds);

        assert_eq!(tds.get_addr(), "127.0.0.1:14330");
        assert!(debug.contains("database: Some(\"appdb\")"));
        assert!(debug.contains("SqlServerAuth"));
        assert!(!debug.contains("secret"));
    }

    #[test]
    fn build_tiberius_config_rejects_verify_ca_without_ca_path() {
        let mut config = sample_config();
        config.ssl_mode = Some("verify_ca".to_string());

        let err = build_tiberius_config("127.0.0.1", 1433, &config)
            .expect_err("verify_ca should require a CA path");

        assert!(err.contains("VERIFY_CA 模式需要填写 CA 证书路径"));
    }

    #[test]
    fn normalize_error_adds_sqlserver_context() {
        let msg = normalize_sqlserver_error("连接测试失败", "Login failed");

        assert_eq!(msg, "SQL Server 连接测试失败: Login failed");
    }

    #[test]
    fn list_schemas_sql_filters_system_schemas_and_orders_by_name() {
        let sql = list_schemas_sql();

        assert!(sql.contains("FROM sys.schemas"));
        assert!(sql.contains("name NOT IN ('sys', 'INFORMATION_SCHEMA')"));
        assert!(sql.contains("ORDER BY name"));
    }

    #[test]
    fn format_sqlserver_column_type_includes_lengths_precision_and_max() {
        assert_eq!(
            format_sqlserver_column_type("nvarchar", Some(200), None, None, false),
            "nvarchar(100)"
        );
        assert_eq!(
            format_sqlserver_column_type("varchar", Some(-1), None, None, false),
            "varchar(max)"
        );
        assert_eq!(
            format_sqlserver_column_type("decimal", Some(9), Some(18), Some(4), false),
            "decimal(18,4)"
        );
    }

    #[test]
    fn build_sqlserver_column_extra_combines_identity_and_computed() {
        assert_eq!(
            build_sqlserver_column_extra(true, Some("[price] * [qty]".to_string())),
            "identity computed AS [price] * [qty]"
        );
    }

    #[test]
    fn sqlserver_value_to_json_preserves_large_int_decimal_and_binary() {
        assert_eq!(
            sqlserver_column_data_to_json(&tiberius::ColumnData::I64(Some(42))),
            serde_json::json!(42)
        );
        assert_eq!(
            sqlserver_column_data_to_json(&tiberius::ColumnData::I64(Some(9_007_199_254_740_992))),
            serde_json::json!("9007199254740992")
        );
        assert_eq!(
            sqlserver_column_data_to_json(&tiberius::ColumnData::Numeric(Some(
                tiberius::numeric::Numeric::new_with_scale(12345, 2),
            ))),
            serde_json::json!("123.45")
        );
        assert_eq!(
            sqlserver_column_data_to_json(&tiberius::ColumnData::Binary(Some(
                std::borrow::Cow::Borrowed(&[1, 2, 3]),
            ))),
            serde_json::json!("[binary 3 bytes]")
        );
    }

    #[test]
    fn completion_metadata_sql_uses_single_catalog_query() {
        let sql = sql_completion_metadata_sql("dbo");

        assert!(sql.contains("FROM sys.objects o"));
        assert!(sql.contains("JOIN sys.schemas s"));
        assert!(sql.contains("LEFT JOIN sys.columns c"));
        assert!(sql.contains("LEFT JOIN sys.types ty"));
        assert!(sql.contains("WHERE s.name = N'dbo'"));
        assert!(sql.contains("o.type IN ('U', 'V')"));
        assert!(sql.contains("ORDER BY o.name, c.column_id"));
    }

    #[test]
    fn session_info_sql_reads_sqlserver_metadata() {
        let sql = session_info_sql();

        assert!(sql.contains("@@VERSION"));
        assert!(sql.contains("@@SERVERNAME"));
        assert!(sql.contains("DB_NAME()"));
        assert!(sql.contains("@@SPID"));
        assert!(sql.contains("DATABASEPROPERTYEX(DB_NAME(), 'Updateability')"));
    }

    #[test]
    fn grant_write_capable_sql_uses_fn_my_permissions_once() {
        let sql = grant_write_capable_sql();

        assert!(sql.contains("fn_my_permissions"));
        assert!(sql.contains("INSERT"));
        assert!(sql.contains("UPDATE"));
        assert!(sql.contains("DELETE"));
    }

    #[test]
    fn explain_sql_wraps_statement_with_showplan_text_without_analyze() {
        let sql = build_showplan_text_sql("SELECT * FROM dbo.users");

        assert!(sql.starts_with("SET SHOWPLAN_TEXT ON;"));
        assert!(sql.contains("SELECT * FROM dbo.users"));
        assert!(sql.ends_with("SET SHOWPLAN_TEXT OFF;"));
        assert!(!sql.contains("ANALYZE"));
    }

    #[test]
    fn sqlserver_dml_builders_use_at_params_and_bracket_identifiers() {
        let entries = vec![
            (
                "name".to_string(),
                SqlServerInputValue::from_json(&serde_json::json!("Ada")),
            ),
            (
                "age".to_string(),
                SqlServerInputValue::from_json(&serde_json::json!(42)),
            ),
        ];
        let (insert_sql, insert_params) = build_insert_statement("dbo", "users", &entries);
        assert_eq!(
            insert_sql,
            "INSERT INTO [dbo].[users] ([name], [age]) VALUES (@P1, @P2)"
        );
        assert_eq!(insert_params.len(), 2);

        let primary_keys = vec![(
            "id".to_string(),
            SqlServerInputValue::from_json(&serde_json::json!(1)),
        )];
        let updates = vec![(
            "name".to_string(),
            SqlServerInputValue::from_json(&serde_json::json!("Grace")),
        )];
        let (update_sql, update_params) =
            build_update_statement("dbo", "users", &primary_keys, &updates);
        assert_eq!(
            update_sql,
            "UPDATE [dbo].[users] SET [name] = @P1 WHERE [id] = @P2"
        );
        assert_eq!(update_params.len(), 2);
    }

    #[test]
    fn sqlserver_delete_builder_supports_composite_row_locators() {
        let rows = vec![
            vec![
                (
                    "tenant_id".to_string(),
                    SqlServerInputValue::from_json(&serde_json::json!(1)),
                ),
                (
                    "code".to_string(),
                    SqlServerInputValue::from_json(&serde_json::json!("A")),
                ),
            ],
            vec![
                (
                    "tenant_id".to_string(),
                    SqlServerInputValue::from_json(&serde_json::json!(1)),
                ),
                (
                    "code".to_string(),
                    SqlServerInputValue::from_json(&serde_json::json!("B")),
                ),
            ],
        ];

        let (sql, params) = build_delete_statement("dbo", "items", &rows);

        assert_eq!(
            sql,
            "DELETE FROM [dbo].[items] WHERE ([tenant_id] = @P1 AND [code] = @P2) OR ([tenant_id] = @P3 AND [code] = @P4)"
        );
        assert_eq!(params.len(), 4);
    }

    #[test]
    fn sqlserver_row_locator_excludes_indexes_with_computed_key_columns() {
        let sql = row_locator_sql("dbo", "items");

        assert!(sql.contains("NOT EXISTS"));
        assert!(sql.contains("c2.is_computed = 1"));
    }

    #[test]
    fn sqlserver_table_structure_excludes_computed_unique_key_markers() {
        let sql = table_structure_sql("dbo", "items");

        assert!(sql.contains("c2.is_computed = 1"));
    }

    #[test]
    fn sqlserver_table_structure_marks_only_backend_chosen_unique_locator() {
        let sql = table_structure_sql("dbo", "items");

        assert!(sql.contains("uq_candidates"));
        assert!(sql.contains("ROW_NUMBER() OVER"));
        assert!(sql.contains("uq.rank_no = 1"));
        assert!(sql.contains("pk_exists"));
        assert!(sql.contains("pk_exists.object_id IS NULL"));
    }

    #[test]
    fn sqlserver_batch_update_statements_validate_all_locators_before_transaction() {
        let rows = vec![
            SqlServerRowUpdate {
                primary_keys: HashMap::from([("id".to_string(), serde_json::json!(1))]),
                updates: HashMap::from([("name".to_string(), serde_json::json!("ok"))]),
            },
            SqlServerRowUpdate {
                primary_keys: HashMap::new(),
                updates: HashMap::from([("name".to_string(), serde_json::json!("bad"))]),
            },
        ];

        let err = prepare_batch_update_statements("dbo", "items", &["id".to_string()], &rows)
            .expect_err("missing locator should be rejected before BEGIN TRANSACTION");

        assert_eq!(err, "存在缺少主键信息的行");
    }
}
