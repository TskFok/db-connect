use crate::db::batch_update::{build_batch_update_statements, BatchDialect};
use crate::db::postgres_error::format_pg_error;
use crate::db::result_budget::ResultBudget;
use crate::db::sql_utils::{
    pg_id, pg_str, postgres_count_query, postgres_sql_editor_allowed_on_read_only_connection,
    validate_where_clause,
};
use crate::db::table_query::TableQueryCancellation;

/// 对外暴露 PostgreSQL 字符串字面值转义，供 `postgres_ddl` 等同模块复用。
/// 避免外部直接依赖 `sql_utils::pg_str` 路径，便于未来加上 PG 专属规则（如 E 字符串）。
pub fn esc_pg_str_external(value: &str) -> String {
    pg_str(value)
}
use crate::db::table_pagination::{
    cached_metadata_for_navigation, remember_metadata, ColumnMetadata, IntegerKind, IntegerValue,
    PageContext, PagePlan, TableMetadata,
};
use crate::models::types::{
    ColumnInfo, ConnectionConfig, QueryResult, SqlExecuteResult, TableInfo, TablePageNavigation,
    TablePageResult,
};
use bytes::BytesMut;
use deadpool_postgres::{Config as PgPoolConfig, Pool as PgPool, PoolConfig, Runtime, SslMode};
use futures_util::TryStreamExt;
use native_tls::{Certificate, Identity, TlsConnector};
use postgres_native_tls::MakeTlsConnector;
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::net::IpAddr;
use std::time::{Duration, Instant};
use tokio_postgres::types::{Format, IsNull, ToSql, Type};
use tokio_postgres::{CancelToken, NoTls, SimpleQueryMessage};

#[cfg(test)]
#[path = "postgres_query_tests.rs"]
mod query_tests;

#[cfg(test)]
#[path = "postgres_batch_tests.rs"]
mod batch_tests;

#[derive(Clone)]
pub enum PostgresCancelTls {
    NoTls,
    Native(TlsConnector),
}

#[derive(Clone)]
pub struct PostgresCancelHandle {
    token: CancelToken,
    tls: PostgresCancelTls,
    status: tokio::sync::watch::Sender<QueryStatus>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum QueryStatus {
    Running,
    CancelRequested,
    Finished,
}

impl PostgresCancelHandle {
    pub fn new(token: CancelToken, tls: PostgresCancelTls) -> Self {
        Self {
            token,
            tls,
            status: tokio::sync::watch::channel(QueryStatus::Running).0,
        }
    }

    pub async fn cancel(self) -> Result<(), String> {
        // 唤醒读取端，即使服务器尚未返回下一行也能停止。
        if !self.transition_running_to(QueryStatus::CancelRequested) {
            return Ok(());
        }
        match self.tls {
            PostgresCancelTls::NoTls => self
                .token
                .cancel_query(NoTls)
                .await
                .map_err(|e| format!("取消查询失败: {}", e)),
            PostgresCancelTls::Native(connector) => self
                .token
                .cancel_query(MakeTlsConnector::new(connector))
                .await
                .map_err(|e| format!("取消查询失败: {}", e)),
        }
    }

    fn transition_running_to(&self, next: QueryStatus) -> bool {
        self.status.send_if_modified(|status| {
            if *status == QueryStatus::Running {
                *status = next;
                true
            } else {
                false
            }
        })
    }
}

#[derive(Clone)]
pub struct PostgresPoolHandle {
    pub pool: PgPool,
    pub cancel_tls: PostgresCancelTls,
}

pub fn build_postgres_pool(
    host: &str,
    port: u16,
    config: &ConnectionConfig,
) -> Result<PostgresPoolHandle, String> {
    let mut pg = PgPoolConfig::new();
    pg.host = Some(host.to_string());
    pg.port = Some(port);
    pg.user = Some(config.username.clone());
    pg.password = config.password.clone();
    pg.dbname = Some(
        config
            .database
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(config.username.as_str())
            .to_string(),
    );
    pg.connect_timeout = Some(Duration::from_secs(10));
    pg.keepalives = Some(true);
    pg.keepalives_idle = Some(Duration::from_secs(30));
    pg.pool = Some(PoolConfig::new(5));

    let mode = config
        .ssl_mode
        .as_deref()
        .unwrap_or("disabled")
        .trim()
        .to_lowercase();

    let pool = if mode.is_empty() || matches!(mode.as_str(), "disabled" | "none" | "off") {
        pg.ssl_mode = Some(SslMode::Disable);
        let pool = pg
            .create_pool(Some(Runtime::Tokio1), NoTls)
            .map_err(|e| format!("构造 PostgreSQL 连接池失败: {}", e))?;
        PostgresPoolHandle {
            pool,
            cancel_tls: PostgresCancelTls::NoTls,
        }
    } else {
        pg.ssl_mode = Some(SslMode::Require);
        apply_tls_hostname_override(&mut pg, host, config);
        let connector = build_native_tls_connector(&mode, config)?;
        let cancel_tls = PostgresCancelTls::Native(connector.clone());
        let pool = pg
            .create_pool(Some(Runtime::Tokio1), MakeTlsConnector::new(connector))
            .map_err(|e| format!("构造 PostgreSQL TLS 连接池失败: {}", e))?;
        PostgresPoolHandle { pool, cancel_tls }
    };

    Ok(pool)
}

fn apply_tls_hostname_override(
    pg: &mut PgPoolConfig,
    connect_host: &str,
    config: &ConnectionConfig,
) {
    let Some(tls_host) = config
        .ssl_tls_hostname
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    if let Ok(addr) = connect_host.parse::<IpAddr>() {
        pg.host = Some(tls_host.to_string());
        pg.hostaddr = Some(addr);
    }
}

fn build_native_tls_connector(
    mode: &str,
    config: &ConnectionConfig,
) -> Result<TlsConnector, String> {
    let mut builder = TlsConnector::builder();
    match mode {
        "required" => {}
        "verify_ca" => {
            let ca = config
                .ssl_ca_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("VERIFY_CA 模式需要填写 CA 证书路径（PEM）")?;
            let bytes = fs::read(ca).map_err(|e| format!("读取 CA 证书失败: {}", e))?;
            let cert =
                Certificate::from_pem(&bytes).map_err(|e| format!("解析 CA 证书失败: {}", e))?;
            builder.add_root_certificate(cert);
            builder.danger_accept_invalid_hostnames(true);
        }
        "verify_identity" => {
            let ca = config
                .ssl_ca_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("VERIFY_IDENTITY 模式需要填写 CA 证书路径（PEM）")?;
            let bytes = fs::read(ca).map_err(|e| format!("读取 CA 证书失败: {}", e))?;
            let cert =
                Certificate::from_pem(&bytes).map_err(|e| format!("解析 CA 证书失败: {}", e))?;
            builder.add_root_certificate(cert);
        }
        "required_insecure" => {
            builder.danger_accept_invalid_certs(true);
            builder.danger_accept_invalid_hostnames(true);
        }
        other => {
            return Err(format!(
                "未知的 ssl_mode: {}（支持: disabled, required, verify_ca, verify_identity, required_insecure）",
                other
            ));
        }
    }

    if let Some(p12) = config
        .ssl_pkcs12_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let bytes = fs::read(p12).map_err(|e| format!("读取 PKCS#12 证书失败: {}", e))?;
        let password = config.ssl_pkcs12_password.as_deref().unwrap_or("");
        let identity = Identity::from_pkcs12(&bytes, password)
            .map_err(|e| format!("解析 PKCS#12 证书失败: {}", e))?;
        builder.identity(identity);
    }

    builder
        .build()
        .map_err(|e| format!("构造 PostgreSQL TLS 连接器失败: {}", e))
}

pub async fn get_client_with_retry(pool: &PgPool) -> Result<deadpool_postgres::Client, String> {
    pool.get()
        .await
        .map_err(|e| format!("获取 PostgreSQL 连接失败: {}", e))
}

pub async fn ping_pool(pool: &PgPool) -> bool {
    let probe = async {
        let client = get_client_with_retry(pool).await?;
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

pub async fn test_pool(pool: &PgPool) -> Result<(), String> {
    let client = get_client_with_retry(pool).await?;
    client
        .simple_query("SELECT 1")
        .await
        .map_err(|e| format!("查询测试失败: {}", e))?;
    Ok(())
}

pub async fn list_schemas(pool: &PgPool) -> Result<Vec<String>, String> {
    let client = get_client_with_retry(pool).await?;
    let rows = client
        .query(
            "SELECT nspname \
             FROM pg_catalog.pg_namespace \
             WHERE nspname <> 'information_schema' \
               AND nspname NOT LIKE 'pg_%' \
             ORDER BY nspname",
            &[],
        )
        .await
        .map_err(|e| format!("查询 schema 列表失败: {}", e))?;
    Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
}

pub async fn list_tables(pool: &PgPool, schema: &str) -> Result<Vec<TableInfo>, String> {
    let client = get_client_with_retry(pool).await?;
    let rows = client
        .query(
            "SELECT c.relname AS name, \
                    CASE WHEN c.relkind IN ('v', 'm') THEN 'VIEW' ELSE 'TABLE' END AS table_type, \
                    CASE WHEN c.relkind IN ('r', 'p') THEN 'PostgreSQL' ELSE NULL END AS engine, \
                    CASE WHEN c.relkind IN ('r', 'p') THEN GREATEST(c.reltuples::bigint, 0) ELSE NULL END AS rows_est, \
                    CASE WHEN c.relkind IN ('r', 'p') THEN pg_catalog.pg_relation_size(c.oid)::bigint ELSE NULL END AS data_length, \
                    CASE WHEN c.relkind IN ('r', 'p') THEN (pg_catalog.pg_total_relation_size(c.oid) - pg_catalog.pg_relation_size(c.oid))::bigint ELSE NULL END AS index_length, \
                    COALESCE(pg_catalog.obj_description(c.oid, 'pg_class'), '') AS comment \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE n.nspname = $1 \
               AND c.relkind IN ('r', 'p', 'v', 'm') \
             ORDER BY c.relname",
            &[&schema],
        )
        .await
        .map_err(|e| format!("查询表列表失败: {}", e))?;

    Ok(rows
        .iter()
        .map(|row| TableInfo {
            name: row.get::<_, String>("name"),
            table_type: row.get::<_, String>("table_type"),
            engine: row.get::<_, Option<String>>("engine"),
            rows: i64_to_u64(row.get::<_, Option<i64>>("rows_est")),
            data_length: i64_to_u64(row.get::<_, Option<i64>>("data_length")),
            index_length: i64_to_u64(row.get::<_, Option<i64>>("index_length")),
            comment: row.get::<_, String>("comment"),
        })
        .collect())
}

pub async fn get_table_structure(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let client = get_client_with_retry(pool).await?;
    let rows = client
        .query(
            "SELECT c.column_name, \
                    CASE \
                      WHEN c.data_type = 'USER-DEFINED' THEN c.udt_name \
                      WHEN c.character_maximum_length IS NOT NULL THEN c.data_type || '(' || c.character_maximum_length || ')' \
                      WHEN c.numeric_precision IS NOT NULL AND c.numeric_scale IS NOT NULL THEN c.data_type || '(' || c.numeric_precision || ',' || c.numeric_scale || ')' \
                      WHEN c.numeric_precision IS NOT NULL THEN c.data_type || '(' || c.numeric_precision || ')' \
                      ELSE c.data_type \
                    END AS column_type, \
                    c.is_nullable = 'YES' AS nullable, \
                    CASE WHEN pk.column_name IS NULL THEN '' ELSE 'PRI' END AS key, \
                    c.column_default, \
                    trim(concat_ws(' ', \
                      CASE WHEN c.is_identity = 'YES' THEN 'identity' END, \
                      CASE WHEN c.is_generated <> 'NEVER' THEN lower(c.is_generated) || ' generated' END \
                    )) AS extra, \
                    COALESCE(d.description, '') AS comment \
             FROM information_schema.columns c \
             LEFT JOIN ( \
               SELECT kcu.table_schema, kcu.table_name, kcu.column_name \
               FROM information_schema.table_constraints tc \
               JOIN information_schema.key_column_usage kcu \
                 ON kcu.constraint_schema = tc.constraint_schema \
                AND kcu.constraint_name = tc.constraint_name \
                AND kcu.table_schema = tc.table_schema \
                AND kcu.table_name = tc.table_name \
               WHERE tc.constraint_type = 'PRIMARY KEY' \
             ) pk ON pk.table_schema = c.table_schema \
                 AND pk.table_name = c.table_name \
                 AND pk.column_name = c.column_name \
             LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = c.table_schema \
             LEFT JOIN pg_catalog.pg_class cls ON cls.relnamespace = n.oid AND cls.relname = c.table_name \
             LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = cls.oid AND a.attname = c.column_name \
             LEFT JOIN pg_catalog.pg_description d ON d.objoid = cls.oid AND d.objsubid = a.attnum \
             WHERE c.table_schema = $1 AND c.table_name = $2 \
             ORDER BY c.ordinal_position",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format!("查询表结构失败: {}", e))?;

    Ok(rows
        .iter()
        .map(|row| ColumnInfo {
            name: row.get::<_, String>("column_name"),
            column_type: row.get::<_, String>("column_type"),
            nullable: row.get::<_, bool>("nullable"),
            key: row.get::<_, String>("key"),
            default_value: row.get::<_, Option<String>>("column_default"),
            extra: row.get::<_, String>("extra"),
            comment: row.get::<_, String>("comment"),
        })
        .collect())
}

async fn finish_table_query<T>(
    client: deadpool_postgres::Client,
    result: Result<T, String>,
    handle: &PostgresPoolHandle,
) -> Result<T, String> {
    if result.is_err() {
        let cancel = PostgresCancelHandle::new(client.cancel_token(), handle.cancel_tls.clone());
        // 在取消完成前继续持有原连接，保证取消请求不会命中下一条查询。
        let _ = tokio::time::timeout(Duration::from_secs(2), cancel.cancel()).await;
        drop(deadpool_postgres::Client::take(client));
    }
    result
}

pub async fn query_table_count(
    handle: &PostgresPoolHandle,
    schema: &str,
    table: &str,
    where_clause: Option<String>,
    cancellation: &TableQueryCancellation,
) -> Result<u64, String> {
    let where_sql = build_where_sql(&where_clause)?;
    let count_sql = postgres_count_query(schema, table, &where_sql);
    let client = cancellation
        .run(get_client_with_retry(&handle.pool))
        .await?;
    let result = cancellation
        .run(async {
            let row = client
                .query_one(&count_sql, &[])
                .await
                .map_err(|e| format!("查询总数失败: {}", e))?;
            Ok(i64_to_u64(Some(row.get::<_, i64>(0))).unwrap_or(0))
        })
        .await;
    finish_table_query(client, result, handle).await
}

/// 从系统目录读取真实约束，而不是列展示标记；普通继承父表的子表可能重复主键，禁用游标。
async fn fetch_table_page_metadata(
    client: &deadpool_postgres::Client,
    schema: &str,
    table: &str,
) -> Result<TableMetadata, String> {
    let rows = client.query(
        "SELECT a.attname, ty.typname, tn.nspname AS type_schema, \
         CASE WHEN ix.indisvalid AND ix.indisready THEN array_position(pk.conkey, a.attnum) ELSE NULL END AS primary_position, \
         c.relkind IN ('r', 'p') AND (c.relkind = 'p' OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits inh WHERE inh.inhparent = c.oid)) AS trusted \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace ns ON ns.oid = c.relnamespace \
         JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
         JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid \
         JOIN pg_catalog.pg_namespace tn ON tn.oid = ty.typnamespace \
         LEFT JOIN pg_catalog.pg_constraint pk ON pk.conrelid = c.oid AND pk.contype = 'p' AND pk.convalidated \
         LEFT JOIN pg_catalog.pg_index ix ON ix.indexrelid = pk.conindid \
         WHERE ns.nspname = $1 AND c.relname = $2 ORDER BY a.attnum",
        &[&schema, &table],
    ).await.map_err(|e| format!("查询表分页元数据失败: {}", e))?;
    let trusted = rows.first().is_some_and(|r| r.get::<_, bool>("trusted"));
    let columns = rows
        .iter()
        .map(|row| {
            let type_name: String = row.get("typname");
            let type_schema: String = row.get("type_schema");
            ColumnMetadata {
                name: row.get("attname"),
                primary_position: row.get("primary_position"),
                integer_kind: (type_schema == "pg_catalog"
                    && matches!(type_name.as_str(), "int2" | "int4" | "int8"))
                .then_some(IntegerKind::Signed),
            }
        })
        .collect();
    Ok(TableMetadata::new(columns, trusted))
}

#[allow(clippy::too_many_arguments)]
pub async fn query_table_data(
    handle: &PostgresPoolHandle,
    schema: &str,
    table: &str,
    page: u32,
    _page_size: u32,
    order_sql: String,
    where_clause: Option<String>,
    select_columns: Option<Vec<String>>,
    skip_count: Option<bool>,
    context: PageContext,
    navigation: Option<TablePageNavigation>,
    cancellation: &TableQueryCancellation,
) -> Result<TablePageResult, String> {
    let start = Instant::now();
    let client = cancellation
        .run(get_client_with_retry(&handle.pool))
        .await?;
    let result = cancellation
        .run(async {
            let where_sql = build_where_sql(&where_clause)?;
            let metadata = match cached_metadata_for_navigation(&context, page, navigation.as_ref())
            {
                Some(metadata) => metadata,
                None => remember_metadata(
                    &context,
                    fetch_table_page_metadata(&client, schema, table).await?,
                ),
            };
            let total = if skip_count == Some(true) {
                0
            } else {
                let count_sql = postgres_count_query(schema, table, &where_sql);
                let row = client
                    .query_one(&count_sql, &[])
                    .await
                    .map_err(|e| format!("查询总数失败: {}", e))?;
                i64_to_u64(Some(row.get::<_, i64>(0))).unwrap_or(0)
            };
            let selected_columns = metadata.selected_columns(&select_columns);
            let select_part = selected_columns
                .as_ref()
                .map(|cols| cols.iter().map(|c| pg_id(c)).collect::<Vec<_>>().join(", "))
                .unwrap_or_else(|| "*".into());
            let plan = PagePlan::new(context, metadata.clone(), page, navigation.as_ref());
            let quoted_key = plan.key_column.as_deref().map(pg_id).unwrap_or_default();
            let data_sql = plan.sql(
                &select_part,
                &format!("{}.{}", pg_id(schema), pg_id(table)),
                &quoted_key,
                &order_sql,
            );
            // 保留 simple_query 的任意 PostgreSQL 类型文本展示；边界只能来自严格解析后的 i64，
            // 再输出标准十进制整数，绝不将客户端游标或未经校验的文本拼入 SQL。
            let messages = client
                .simple_query(&data_sql)
                .await
                .map_err(|e| format!("查询数据失败: {}", e))?;
            let raw_rows: Vec<_> = messages
                .iter()
                .filter_map(|message| match message {
                    SimpleQueryMessage::Row(row) => Some(row),
                    _ => None,
                })
                .collect();
            let key_index = plan.key_column.as_ref().and_then(|key| {
                raw_rows
                    .first()?
                    .columns()
                    .iter()
                    .position(|column| column.name() == key)
            });
            let boundary = |row: &&tokio_postgres::SimpleQueryRow| {
                key_index
                    .and_then(|index| row.get(index))
                    .and_then(IntegerValue::from_postgres)
            };
            let (mut first, mut last) = (
                raw_rows.first().and_then(boundary),
                raw_rows.last().and_then(boundary),
            );
            if plan.reverse {
                std::mem::swap(&mut first, &mut last);
            }
            let pagination = plan.pagination(first, last, raw_rows.len());
            let (mut columns, mut rows) = simple_messages_to_columns_and_json(&messages)?;
            if plan.reverse {
                rows.reverse();
            }
            if columns.is_empty() && rows.is_empty() {
                columns = selected_columns.unwrap_or(metadata.columns);
            }
            Ok(TablePageResult {
                result: QueryResult {
                    columns,
                    rows,
                    total,
                    execution_time_ms: start.elapsed().as_millis() as u64,
                },
                pagination,
                executed_sql: Some(data_sql),
            })
        })
        .await;
    finish_table_query(client, result, handle).await
}

pub async fn set_search_path_if_set(
    client: &deadpool_postgres::Client,
    schema: &Option<String>,
) -> Result<(), String> {
    if let Some(schema) = schema.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        client
            .simple_query(&format!("SET search_path TO {}", pg_id(schema)))
            .await
            .map_err(|e| format!("切换 schema 失败: {}", e))?;
    }
    Ok(())
}

pub fn sql_editor_allowed_on_read_only_connection(sql: &str) -> bool {
    postgres_sql_editor_allowed_on_read_only_connection(sql)
}

pub fn sql_editor_returns_result_set(sql: &str) -> bool {
    sql_editor_allowed_on_read_only_connection(sql)
}

pub async fn run_sql_on_client(
    client: deadpool_postgres::Client,
    sql: &str,
    read_only: bool,
    start: Instant,
    cancel: &PostgresCancelHandle,
) -> Result<SqlExecuteResult, String> {
    if read_only && !sql_editor_allowed_on_read_only_connection(sql) {
        cancel.transition_running_to(QueryStatus::Finished);
        return Err("当前连接为只读模式，不允许执行 DML/DDL".to_string());
    }

    let mut result = read_sql_result(&client, sql, start, cancel).await;
    // 完成与取消必须互斥：过期取消句柄不得取消此连接上的下一条查询。
    if result.is_ok() && !cancel.transition_running_to(QueryStatus::Finished) {
        result = Err("查询已取消".to_string());
    }
    if result.is_err() {
        // 错误/取消时不能将仍有未读结果的连接归还连接池。取消请求有时间界限，
        // 失败时关闭连接也能终止后端会话，避免为清理而继续排空无限结果。
        let _ = tokio::time::timeout(Duration::from_secs(2), cancel.clone().cancel()).await;
        drop(deadpool_postgres::Client::take(client));
    }
    result
}

async fn read_sql_result(
    client: &deadpool_postgres::Client,
    sql: &str,
    start: Instant,
    cancel: &PostgresCancelHandle,
) -> Result<SqlExecuteResult, String> {
    let mut requested = cancel.status.subscribe();
    if *requested.borrow() != QueryStatus::Running {
        return Err("查询已取消".to_string());
    }
    let stream = client
        .simple_query_raw(sql)
        .await
        .map_err(|e| format_pg_error("执行 SQL", e))?;
    futures_util::pin_mut!(stream);
    let mut columns = Vec::new();
    let mut rows = Vec::new();
    let mut affected = 0;
    let mut budget = ResultBudget::default();
    loop {
        let msg = tokio::select! {
            biased;
            _ = requested.changed() => return Err("查询已取消".to_string()),
            msg = stream.try_next() => msg.map_err(|e| format_pg_error("执行 SQL", e))?,
        };
        match msg {
            Some(SimpleQueryMessage::RowDescription(cols)) if columns.is_empty() => {
                columns = cols.iter().map(|c| c.name().to_string()).collect();
                budget.add_columns(&columns)?;
            }
            Some(SimpleQueryMessage::Row(row)) => {
                let values = (0..row.len())
                    .map(|i| simple_value_to_json(row.get(i)))
                    .collect::<Vec<_>>();
                budget.add_row(&values)?;
                rows.push(values);
            }
            Some(SimpleQueryMessage::CommandComplete(count)) => affected = count,
            None => break,
            _ => {}
        }
        // 缓冲中持续有数据时也给取消命令调度机会。
        if !rows.is_empty() && rows.len() % 256 == 0 {
            tokio::task::yield_now().await;
        }
    }
    let elapsed = start.elapsed().as_millis() as u64;

    if sql_editor_returns_result_set(sql) || !columns.is_empty() {
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

    Ok(SqlExecuteResult {
        result_type: "modify".to_string(),
        columns: None,
        rows: None,
        affected_rows: Some(affected),
        message: format!("执行成功, 影响 {} 行 (耗时 {}ms)", affected, elapsed),
        execution_time_ms: elapsed,
    })
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
        parts.push(format!("{} {}", pg_id(col), safe_order));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", parts.join(", "))
    }
}

async fn fetch_primary_keys_on_client(
    client: &deadpool_postgres::Client,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let rows = client
        .query(
            "SELECT kcu.column_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON kcu.constraint_schema = tc.constraint_schema \
              AND kcu.constraint_name = tc.constraint_name \
              AND kcu.table_schema = tc.table_schema \
              AND kcu.table_name = tc.table_name \
             WHERE tc.constraint_type = 'PRIMARY KEY' \
               AND kcu.table_schema = $1 \
               AND kcu.table_name = $2 \
             ORDER BY kcu.ordinal_position",
            &[&schema, &table],
        )
        .await
        .map_err(|e| format!("查询主键信息失败: {}", e))?;
    Ok(rows.iter().map(|r| r.get::<_, String>(0)).collect())
}

pub async fn fetch_primary_keys(
    pool: &PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<String>, String> {
    let client = get_client_with_retry(pool).await?;
    fetch_primary_keys_on_client(&client, schema, table).await
}

pub fn postgres_grant_write_capable_sql() -> &'static str {
    "SELECT \
        EXISTS ( \
          SELECT 1 \
          FROM pg_catalog.pg_class c \
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
          WHERE c.relkind IN ('r', 'p') \
            AND n.nspname NOT IN ('pg_catalog', 'information_schema') \
            AND n.nspname NOT LIKE 'pg_toast%' \
            AND ( \
              has_table_privilege(c.oid, 'INSERT') \
              OR has_table_privilege(c.oid, 'UPDATE') \
              OR has_table_privilege(c.oid, 'DELETE') \
            ) \
        ) \
        OR EXISTS ( \
          SELECT 1 \
          FROM pg_catalog.pg_namespace n \
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') \
            AND n.nspname NOT LIKE 'pg_toast%' \
            AND has_schema_privilege(n.oid, 'CREATE') \
        )"
}

/// 粗粒度写权限探测。失败时返回 true，避免权限元数据查询异常导致误灰显。
pub async fn fetch_grant_write_capable(client: &deadpool_postgres::Client) -> bool {
    match client
        .query_one(postgres_grant_write_capable_sql(), &[])
        .await
    {
        Ok(row) => row.get::<_, bool>(0),
        Err(_) => true,
    }
}

pub use crate::db::batch_update::RowUpdate as PgRowUpdate;

/// 写操作参数：要么是 SQL NULL，要么是 UTF-8 文本。
///
/// 与服务端的绑定策略：通过 `prepare_typed(sql, &[Type::UNKNOWN; N])` 让 PostgreSQL
/// 在解析 SQL 时从上下文（赋值列、比较列）推断每个 `$i` 的真实类型，再以文本格式
/// 提交参数值。这样无需在 Rust 端为 INT/BOOL/DATE/JSONB 等列各自实现 ToSql，
/// 由数据库的赋值转换 / 输入函数完成类型转换，整型字段输入 `"42"`、布尔输入
/// `"true"`、JSONB 输入对象的字符串形式等都能正确写入；同时保持参数化，避免拼接
/// SQL 注入风险。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PgInputValue {
    Null,
    Text(String),
}

impl PgInputValue {
    pub fn from_json(v: &JsonValue) -> Self {
        match v {
            JsonValue::Null => PgInputValue::Null,
            // PostgreSQL 接受 't'/'f'/'true'/'false'/'1'/'0'/'yes'/'no' 等多种 bool 文本，
            // 显式选用最常见且大小写无关的 'true'/'false'，与 INSERT/UPDATE 的赋值转换一致。
            JsonValue::Bool(true) => PgInputValue::Text("true".to_string()),
            JsonValue::Bool(false) => PgInputValue::Text("false".to_string()),
            JsonValue::Number(n) => PgInputValue::Text(n.to_string()),
            JsonValue::String(s) => PgInputValue::Text(s.clone()),
            // 复合类型（数组/对象）直接序列化为 JSON 文本；写入 JSON/JSONB 列时由
            // PostgreSQL 的 jsonb_in 解析；写入 TEXT 列时按字面值保留。
            other => PgInputValue::Text(other.to_string()),
        }
    }
}

impl ToSql for PgInputValue {
    fn to_sql(
        &self,
        _ty: &Type,
        out: &mut BytesMut,
    ) -> Result<IsNull, Box<dyn std::error::Error + Sync + Send>> {
        match self {
            PgInputValue::Null => Ok(IsNull::Yes),
            PgInputValue::Text(value) => {
                out.extend_from_slice(value.as_bytes());
                Ok(IsNull::No)
            }
        }
    }

    fn accepts(_ty: &Type) -> bool {
        // 参数的实际类型由预编译推断，文本内容交给该类型的服务端输入函数校验。
        true
    }

    fn encode_format(&self, _ty: &Type) -> Format {
        // UNKNOWN 只负责类型推断；必须显式声明 Text，才能提交非文本列的文本表示。
        Format::Text
    }

    tokio_postgres::types::to_sql_checked!();
}

/// 以 UNKNOWN 类型预编译 SQL，再绑定显式使用文本传输格式的参数。
async fn execute_with_text_params(
    client: &deadpool_postgres::Client,
    sql: &str,
    values: &[PgInputValue],
) -> Result<u64, String> {
    let param_types: Vec<Type> = vec![Type::UNKNOWN; values.len()];
    let stmt = client
        .prepare_typed(sql, &param_types)
        .await
        .map_err(|e| format_pg_error("准备 SQL", e))?;
    let params: Vec<&(dyn ToSql + Sync)> = values
        .iter()
        .map(|value| value as &(dyn ToSql + Sync))
        .collect();
    client
        .execute(&stmt, &params)
        .await
        .map_err(|e| format_pg_error("执行写操作", e))
}

/// 在事务中执行带 UNKNOWN 参数的 SQL，复用同一份 prepare_typed 逻辑。
async fn execute_with_text_params_in_tx(
    tx: &deadpool_postgres::Transaction<'_>,
    sql: &str,
    values: &[PgInputValue],
) -> Result<u64, String> {
    let param_types: Vec<Type> = vec![Type::UNKNOWN; values.len()];
    let stmt = tx
        .prepare_typed_cached(sql, &param_types)
        .await
        .map_err(|e| format_pg_error("准备 SQL", e))?;
    let params: Vec<&(dyn ToSql + Sync)> = values
        .iter()
        .map(|value| value as &(dyn ToSql + Sync))
        .collect();
    tx.execute(&stmt, &params)
        .await
        .map_err(|e| format_pg_error("执行写操作", e))
}

async fn validate_batch_targets_in_tx(
    tx: &deadpool_postgres::Transaction<'_>,
    sql: &str,
    values: &[PgInputValue],
    seen: &mut HashSet<String>,
) -> Result<usize, String> {
    let stmt = tx
        .prepare_typed_cached(sql, &vec![Type::UNKNOWN; values.len()])
        .await
        .map_err(|e| format_pg_error("准备批量更新校验", e))?;
    let params: Vec<&(dyn ToSql + Sync)> = values
        .iter()
        .map(|value| value as &(dyn ToSql + Sync))
        .collect();
    let rows = tx
        .query(&stmt, &params)
        .await
        .map_err(|e| format_pg_error("校验批量更新目标", e))?;
    let matched_rows = rows.len();
    for row in rows {
        let identity: String = row.get(0);
        let matches: i32 = row.get(1);
        if matches > 1 || !seen.insert(identity) {
            return Err("批量更新存在重复目标行".to_string());
        }
    }
    Ok(matched_rows)
}

/// 构建 PostgreSQL 单行 INSERT 语句与参数。
///
/// `entries` 的顺序决定 SQL 列序与参数顺序，调用方负责确保两者一致。
pub fn build_insert_statement(
    schema: &str,
    table: &str,
    entries: &[(String, PgInputValue)],
) -> (String, Vec<PgInputValue>) {
    let cols_sql = entries
        .iter()
        .map(|(c, _)| pg_id(c))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = (1..=entries.len())
        .map(|i| format!("${}", i))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT INTO {}.{} ({}) VALUES ({})",
        pg_id(schema),
        pg_id(table),
        cols_sql,
        placeholders
    );
    let params = entries.iter().map(|(_, v)| v.clone()).collect();
    (sql, params)
}

/// 构建 PostgreSQL 按主键定位的 UPDATE 语句与位置参数（参数顺序：SET 值 + 主键值）。
pub fn build_update_statement(
    schema: &str,
    table: &str,
    primary_keys: &[(String, PgInputValue)],
    updates: &[(String, PgInputValue)],
) -> (String, Vec<PgInputValue>) {
    let mut idx = 1usize;
    let mut params: Vec<PgInputValue> = Vec::with_capacity(updates.len() + primary_keys.len());

    let set_parts: Vec<String> = updates
        .iter()
        .map(|(c, v)| {
            let p = format!("{} = ${}", pg_id(c), idx);
            idx += 1;
            params.push(v.clone());
            p
        })
        .collect();

    let where_parts: Vec<String> = primary_keys
        .iter()
        .map(|(c, v)| {
            let p = format!("{} = ${}", pg_id(c), idx);
            idx += 1;
            params.push(v.clone());
            p
        })
        .collect();

    let sql = format!(
        "UPDATE {}.{} SET {} WHERE {}",
        pg_id(schema),
        pg_id(table),
        set_parts.join(", "),
        where_parts.join(" AND ")
    );
    (sql, params)
}

/// 构建按主键批量删除的 SQL。
///
/// 单列主键保留紧凑的 `IN ($1, $2, ...)`；复合主键按行构造
/// `("a" = $1 AND "b" = $2) OR ("a" = $3 AND "b" = $4)`，确保每个删除条件
/// 都使用完整主键。
pub fn build_delete_statement(
    schema: &str,
    table: &str,
    rows: &[Vec<(String, PgInputValue)>],
) -> (String, Vec<PgInputValue>) {
    let first_row = rows.first().expect("primary key rows must not be empty");
    let mut idx = 1usize;
    let mut params = Vec::new();

    let where_sql = if first_row.len() == 1 {
        let primary_key_column = &first_row[0].0;
        let placeholders = rows
            .iter()
            .map(|row| {
                let placeholder = format!("${}", idx);
                idx += 1;
                params.push(row[0].1.clone());
                placeholder
            })
            .collect::<Vec<_>>()
            .join(", ");
        format!("{} IN ({})", pg_id(primary_key_column), placeholders)
    } else {
        rows.iter()
            .map(|row| {
                let parts = row
                    .iter()
                    .map(|(column, value)| {
                        let part = format!("{} = ${}", pg_id(column), idx);
                        idx += 1;
                        params.push(value.clone());
                        part
                    })
                    .collect::<Vec<_>>()
                    .join(" AND ");
                format!("({})", parts)
            })
            .collect::<Vec<_>>()
            .join(" OR ")
    };

    let sql = format!(
        "DELETE FROM {}.{} WHERE {}",
        pg_id(schema),
        pg_id(table),
        where_sql
    );
    (sql, params)
}

fn map_entries(values: &HashMap<String, JsonValue>) -> Vec<(String, PgInputValue)> {
    values
        .iter()
        .map(|(k, v)| (k.clone(), PgInputValue::from_json(v)))
        .collect()
}

fn map_primary_key_rows(
    rows: &[HashMap<String, JsonValue>],
) -> Result<Vec<Vec<(String, PgInputValue)>>, String> {
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
                        PgInputValue::from_json(row.get(column).expect("primary key checked")),
                    )
                })
                .collect()
        })
        .collect())
}

pub async fn insert_row(
    pool: &PgPool,
    schema: &str,
    table: &str,
    values: HashMap<String, JsonValue>,
) -> Result<u64, String> {
    if values.is_empty() {
        return Err("没有提供要插入的数据".to_string());
    }
    let entries = map_entries(&values);
    let (sql, params) = build_insert_statement(schema, table, &entries);
    let client = get_client_with_retry(pool).await?;
    execute_with_text_params(&client, &sql, &params).await
}

pub async fn update_row(
    pool: &PgPool,
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
    let pk_entries = map_entries(&primary_keys);
    let upd_entries = map_entries(&updates);
    let (sql, params) = build_update_statement(schema, table, &pk_entries, &upd_entries);
    let client = get_client_with_retry(pool).await?;
    execute_with_text_params(&client, &sql, &params).await
}

pub async fn batch_update_rows(
    pool: &PgPool,
    schema: &str,
    table: &str,
    rows: Vec<PgRowUpdate>,
) -> Result<u64, String> {
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

    let mut client = get_client_with_retry(pool).await?;
    let primary_key_columns = fetch_primary_keys_on_client(&client, schema, table).await?;
    let statements = build_batch_update_statements(
        BatchDialect::Postgres,
        schema,
        table,
        &primary_key_columns,
        &rows,
    )?;
    // 固定预校验与 UPDATE 的可见行，避免校验后插入的新行被后续块误更新。
    let tx = client
        .build_transaction()
        .isolation_level(tokio_postgres::IsolationLevel::RepeatableRead)
        .start()
        .await
        .map_err(|e| format!("开启事务失败: {}", e))?;

    let result: Result<u64, String> = async {
        let mut seen = HashSet::new();
        // 按字段组和参数上限分块校验，所有块通过后才开始写入。
        for statement in &statements {
            let values: Vec<_> = statement
                .validation_params
                .iter()
                .map(PgInputValue::from_json)
                .collect();
            let matched_rows =
                validate_batch_targets_in_tx(&tx, &statement.validation_sql, &values, &mut seen)
                    .await?;
            if statement
                .expected_matches
                .is_some_and(|expected| expected != matched_rows)
            {
                return Err("待更新行已变更，请刷新数据后重试".to_string());
            }
        }
        let mut total = 0;
        for statement in &statements {
            let values: Vec<_> = statement
                .params
                .iter()
                .map(PgInputValue::from_json)
                .collect();
            total += execute_with_text_params_in_tx(&tx, &statement.sql, &values).await?;
        }
        Ok(total)
    }
    .await;

    let total = match result {
        Ok(total) => total,
        Err(error) => {
            let _ = tx.rollback().await;
            return Err(format!("批量更新失败，已回滚（未提交任何修改）: {}", error));
        }
    };

    tx.commit()
        .await
        .map_err(|e| format!("提交事务失败: {}", e))?;

    Ok(total)
}

pub async fn delete_rows(
    pool: &PgPool,
    schema: &str,
    table: &str,
    primary_keys: Vec<HashMap<String, JsonValue>>,
) -> Result<u64, String> {
    let rows = map_primary_key_rows(&primary_keys)?;
    let (sql, params) = build_delete_statement(schema, table, &rows);
    let client = get_client_with_retry(pool).await?;
    execute_with_text_params(&client, &sql, &params).await
}

/// 按单列主键批量回查整行：`SELECT * FROM s.t WHERE pk IN ($1, ...)`，用于「复制为 INSERT」等需要全量列的场景。
pub async fn query_full_rows(
    pool: &PgPool,
    schema: &str,
    table: &str,
    primary_key_column: &str,
    primary_key_values: Vec<JsonValue>,
) -> Result<QueryResult, String> {
    if primary_key_values.is_empty() {
        return Err("没有提供主键值".to_string());
    }
    let start = Instant::now();
    let client = get_client_with_retry(pool).await?;

    let placeholders = (1..=primary_key_values.len())
        .map(|i| format!("${}", i))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT * FROM {}.{} WHERE {} IN ({})",
        pg_id(schema),
        pg_id(table),
        pg_id(primary_key_column),
        placeholders
    );

    let values: Vec<PgInputValue> = primary_key_values
        .iter()
        .map(PgInputValue::from_json)
        .collect();
    let param_types: Vec<Type> = vec![Type::UNKNOWN; values.len()];
    let stmt = client
        .prepare_typed(&sql, &param_types)
        .await
        .map_err(|e| format_pg_error("准备 SQL", e))?;
    let params: Vec<&(dyn ToSql + Sync)> = values
        .iter()
        .map(|value| value as &(dyn ToSql + Sync))
        .collect();

    let rows = client
        .query(&stmt, &params)
        .await
        .map_err(|e| format_pg_error("查询完整行数据", e))?;

    let columns: Vec<String> = stmt
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();
    let json_rows: Vec<Vec<JsonValue>> = rows
        .iter()
        .map(|row| {
            (0..columns.len())
                .map(|i| pg_row_value_to_json(row, i))
                .collect()
        })
        .collect();
    let total = json_rows.len() as u64;
    Ok(QueryResult {
        columns,
        rows: json_rows,
        total,
        execution_time_ms: start.elapsed().as_millis() as u64,
    })
}

/// 把 binary 协议返回的列值统一转换为 JSON：尽量保留可读字面，未支持类型回退为 `null`。
fn pg_row_value_to_json(row: &tokio_postgres::Row, idx: usize) -> JsonValue {
    use tokio_postgres::types::Type;
    let col_type = row.columns()[idx].type_().clone();
    macro_rules! try_get {
        ($t:ty) => {
            row.try_get::<_, Option<$t>>(idx).ok().flatten()
        };
    }
    match col_type {
        Type::BOOL => try_get!(bool)
            .map(JsonValue::Bool)
            .unwrap_or(JsonValue::Null),
        Type::INT2 => try_get!(i16)
            .map(|v| serde_json::json!(v))
            .unwrap_or(JsonValue::Null),
        Type::INT4 => try_get!(i32)
            .map(|v| serde_json::json!(v))
            .unwrap_or(JsonValue::Null),
        Type::INT8 => try_get!(i64)
            .map(|v| {
                if (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&v) {
                    serde_json::json!(v)
                } else {
                    JsonValue::String(v.to_string())
                }
            })
            .unwrap_or(JsonValue::Null),
        Type::FLOAT4 => try_get!(f32)
            .map(|v| serde_json::json!(v))
            .unwrap_or(JsonValue::Null),
        Type::FLOAT8 => try_get!(f64)
            .map(|v| serde_json::json!(v))
            .unwrap_or(JsonValue::Null),
        Type::JSON | Type::JSONB => try_get!(String)
            .and_then(|s| serde_json::from_str(&s).ok().or(Some(JsonValue::String(s))))
            .unwrap_or(JsonValue::Null),
        _ => try_get!(String)
            .map(JsonValue::String)
            .unwrap_or(JsonValue::Null),
    }
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

fn simple_messages_to_columns_and_json(
    messages: &[SimpleQueryMessage],
) -> Result<(Vec<String>, Vec<Vec<JsonValue>>), String> {
    let mut columns = Vec::new();
    let mut rows = Vec::new();

    for msg in messages {
        match msg {
            SimpleQueryMessage::RowDescription(cols) if columns.is_empty() => {
                columns = cols.iter().map(|c| c.name().to_string()).collect();
            }
            SimpleQueryMessage::Row(row) => {
                if columns.is_empty() {
                    columns = row.columns().iter().map(|c| c.name().to_string()).collect();
                }
                rows.push(
                    (0..row.len())
                        .map(|i| simple_value_to_json(row.get(i)))
                        .collect(),
                );
            }
            _ => {}
        }
    }

    Ok((columns, rows))
}

fn simple_value_to_json(value: Option<&str>) -> JsonValue {
    let Some(s) = value else {
        return JsonValue::Null;
    };
    let has_non_canonical_leading_zero = {
        let unsigned_non_canonical =
            s.len() > 1 && s.starts_with('0') && s.chars().all(|c| c.is_ascii_digit());
        let signed_non_canonical =
            s.len() > 2 && s.starts_with("-0") && s[2..].chars().all(|c| c.is_ascii_digit());
        unsigned_non_canonical || signed_non_canonical
    };
    if has_non_canonical_leading_zero {
        return JsonValue::String(s.to_string());
    }
    if let Ok(n) = s.parse::<i64>() {
        if (-9_007_199_254_740_991..=9_007_199_254_740_991).contains(&n) {
            return serde_json::json!(n);
        }
        return JsonValue::String(s.to_string());
    }
    if let Ok(n) = s.parse::<u64>() {
        if n <= 9_007_199_254_740_991 {
            return serde_json::json!(n);
        }
        return JsonValue::String(s.to_string());
    }
    if s.contains('.') || s.contains('e') || s.contains('E') {
        if let Ok(n) = s.parse::<f64>() {
            return serde_json::json!(n);
        }
    }
    JsonValue::String(s.to_string())
}

fn i64_to_u64(value: Option<i64>) -> Option<u64> {
    value.and_then(|v| if v >= 0 { Some(v as u64) } else { None })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postgres_order_by_quotes_identifiers() {
        assert_eq!(
            build_order_by_sql(&[("created_at", "desc"), ("id", "ASC")]),
            " ORDER BY \"created_at\" DESC, \"id\" ASC"
        );
    }

    #[test]
    fn postgres_simple_value_keeps_big_integer_as_string() {
        assert_eq!(
            simple_value_to_json(Some("3258946454736595494")),
            serde_json::json!("3258946454736595494")
        );
    }

    #[test]
    fn postgres_simple_value_preserves_leading_zero() {
        assert_eq!(simple_value_to_json(Some("007")), serde_json::json!("007"));
    }

    #[test]
    fn pg_input_value_maps_json_kinds() {
        assert_eq!(
            PgInputValue::from_json(&JsonValue::Null),
            PgInputValue::Null
        );
        assert_eq!(
            PgInputValue::from_json(&serde_json::json!(true)),
            PgInputValue::Text("true".into())
        );
        assert_eq!(
            PgInputValue::from_json(&serde_json::json!(false)),
            PgInputValue::Text("false".into())
        );
        assert_eq!(
            PgInputValue::from_json(&serde_json::json!(42)),
            PgInputValue::Text("42".into())
        );
        assert_eq!(
            PgInputValue::from_json(&serde_json::json!(1.5)),
            PgInputValue::Text("1.5".into())
        );
        assert_eq!(
            PgInputValue::from_json(&serde_json::json!("hi")),
            PgInputValue::Text("hi".into())
        );
        // 数字字符串保留原始字符（避免大整数与前导 0 损失精度）
        assert_eq!(
            PgInputValue::from_json(&serde_json::json!("3258946454736595494")),
            PgInputValue::Text("3258946454736595494".into())
        );
        // 复合类型按 JSON 文本序列化，便于写入 JSON/JSONB
        assert_eq!(
            PgInputValue::from_json(&serde_json::json!({"k":"v"})),
            PgInputValue::Text("{\"k\":\"v\"}".into())
        );
    }

    #[test]
    fn pg_input_value_serializes_inferred_types_as_text() {
        let cases = [
            (Type::INT2, serde_json::json!(42), "42"),
            (Type::INT4, serde_json::json!(42), "42"),
            (
                Type::INT8,
                serde_json::json!("3258946454736595494"),
                "3258946454736595494",
            ),
            (Type::BOOL, serde_json::json!(true), "true"),
            (Type::BOOL, serde_json::json!(false), "false"),
            (
                Type::NUMERIC,
                serde_json::json!("1234567890.123456789"),
                "1234567890.123456789",
            ),
            (Type::FLOAT8, serde_json::json!(1.5), "1.5"),
            (Type::DATE, serde_json::json!("2026-09-14"), "2026-09-14"),
            (
                Type::TIMESTAMP,
                serde_json::json!("2026-09-14 10:20:30"),
                "2026-09-14 10:20:30",
            ),
            (
                Type::TIMESTAMPTZ,
                serde_json::json!("2026-09-14 10:20:30+08"),
                "2026-09-14 10:20:30+08",
            ),
            (
                Type::UUID,
                serde_json::json!("00000000-0000-0000-0000-000000000001"),
                "00000000-0000-0000-0000-000000000001",
            ),
            (Type::JSON, serde_json::json!({"k": 1}), "{\"k\":1}"),
            (Type::JSONB, serde_json::json!({"k": 1}), "{\"k\":1}"),
            (Type::INT4_ARRAY, serde_json::json!("{1,2,3}"), "{1,2,3}"),
            (Type::BYTEA, serde_json::json!("\\x00ff"), "\\x00ff"),
            (
                Type::TEXT,
                serde_json::json!("中文 ' $1 \\"),
                "中文 ' $1 \\",
            ),
            (Type::VARCHAR, serde_json::json!(""), ""),
        ];

        for (ty, value, expected) in cases {
            let param = PgInputValue::from_json(&value);
            let mut bytes = BytesMut::new();
            let result = param
                .to_sql_checked(&ty, &mut bytes)
                .unwrap_or_else(|error| panic!("{ty}: {error}"));
            assert!(matches!(result, IsNull::No), "{ty}");
            assert!(matches!(param.encode_format(&ty), Format::Text), "{ty}");
            assert_eq!(&bytes[..], expected.as_bytes(), "{ty}");
        }
    }

    #[test]
    fn pg_input_value_serializes_typed_null_without_writing_bytes() {
        for ty in [
            Type::INT4,
            Type::BOOL,
            Type::TIMESTAMP,
            Type::JSONB,
            Type::UUID,
            Type::TEXT,
        ] {
            let param = PgInputValue::Null;
            let mut bytes = BytesMut::from(&b"prefix"[..]);
            let result = param
                .to_sql_checked(&ty, &mut bytes)
                .unwrap_or_else(|error| panic!("{ty}: {error}"));
            assert!(matches!(result, IsNull::Yes), "{ty}");
            assert!(matches!(param.encode_format(&ty), Format::Text), "{ty}");
            assert_eq!(&bytes[..], b"prefix");
        }
    }

    #[test]
    fn build_insert_statement_uses_dollar_placeholders() {
        let entries = vec![
            ("name".to_string(), PgInputValue::Text("alice".into())),
            ("age".to_string(), PgInputValue::Text("30".into())),
        ];
        let (sql, params) = build_insert_statement("public", "users", &entries);
        assert_eq!(
            sql,
            "INSERT INTO \"public\".\"users\" (\"name\", \"age\") VALUES ($1, $2)"
        );
        assert_eq!(params.len(), 2);
        assert_eq!(params[0], PgInputValue::Text("alice".into()));
        assert_eq!(params[1], PgInputValue::Text("30".into()));
    }

    #[test]
    fn build_insert_statement_escapes_identifiers() {
        let entries = vec![("we\"ird".to_string(), PgInputValue::Text("v".into()))];
        let (sql, _) = build_insert_statement("sch\"e", "tb\"l", &entries);
        // 内嵌双引号需被加倍
        assert!(sql.starts_with("INSERT INTO \"sch\"\"e\".\"tb\"\"l\" (\"we\"\"ird\") VALUES ($1)"));
    }

    #[test]
    fn build_update_statement_orders_set_then_where_params() {
        let pk = vec![("id".to_string(), PgInputValue::Text("7".into()))];
        let upd = vec![
            ("name".to_string(), PgInputValue::Text("alice".into())),
            ("age".to_string(), PgInputValue::Text("30".into())),
        ];
        let (sql, params) = build_update_statement("public", "users", &pk, &upd);
        assert_eq!(
            sql,
            "UPDATE \"public\".\"users\" SET \"name\" = $1, \"age\" = $2 WHERE \"id\" = $3"
        );
        assert_eq!(params.len(), 3);
        assert_eq!(params[0], PgInputValue::Text("alice".into()));
        assert_eq!(params[1], PgInputValue::Text("30".into()));
        assert_eq!(params[2], PgInputValue::Text("7".into()));
    }

    #[test]
    fn build_update_statement_supports_composite_primary_key() {
        let pk = vec![
            ("a".to_string(), PgInputValue::Text("1".into())),
            ("b".to_string(), PgInputValue::Text("2".into())),
        ];
        let upd = vec![("v".to_string(), PgInputValue::Text("x".into()))];
        let (sql, _) = build_update_statement("s", "t", &pk, &upd);
        assert_eq!(
            sql,
            "UPDATE \"s\".\"t\" SET \"v\" = $1 WHERE \"a\" = $2 AND \"b\" = $3"
        );
    }

    #[test]
    fn build_delete_statement_uses_in_with_dollar_placeholders_for_single_primary_key() {
        let rows = vec![
            vec![("id".to_string(), PgInputValue::Text("1".into()))],
            vec![("id".to_string(), PgInputValue::Text("2".into()))],
            vec![("id".to_string(), PgInputValue::Null)],
        ];
        let (sql, params) = build_delete_statement("public", "items", &rows);
        assert_eq!(
            sql,
            "DELETE FROM \"public\".\"items\" WHERE \"id\" IN ($1, $2, $3)"
        );
        assert_eq!(params.len(), 3);
        assert_eq!(params[2], PgInputValue::Null);
    }

    #[test]
    fn build_delete_statement_uses_all_columns_for_composite_primary_key() {
        let rows = vec![
            vec![
                ("order_id".to_string(), PgInputValue::Text("1".into())),
                ("product_id".to_string(), PgInputValue::Text("10".into())),
            ],
            vec![
                ("order_id".to_string(), PgInputValue::Text("1".into())),
                ("product_id".to_string(), PgInputValue::Text("11".into())),
            ],
        ];
        let (sql, params) = build_delete_statement("public", "order_items", &rows);
        assert_eq!(
            sql,
            "DELETE FROM \"public\".\"order_items\" WHERE (\"order_id\" = $1 AND \"product_id\" = $2) OR (\"order_id\" = $3 AND \"product_id\" = $4)"
        );
        assert_eq!(
            params,
            vec![
                PgInputValue::Text("1".into()),
                PgInputValue::Text("10".into()),
                PgInputValue::Text("1".into()),
                PgInputValue::Text("11".into()),
            ]
        );
    }

    #[test]
    fn postgres_grant_write_capable_sql_checks_dml_privileges() {
        let sql = postgres_grant_write_capable_sql();
        assert!(sql.contains("has_table_privilege"));
        assert!(sql.contains("'INSERT'"));
        assert!(sql.contains("'UPDATE'"));
        assert!(sql.contains("'DELETE'"));
    }
}
