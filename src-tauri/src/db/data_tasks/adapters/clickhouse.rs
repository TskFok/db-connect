use super::{
    batch::{Dialect, WriteBatch},
    sqlite::Projection,
    DataSession, RowSender, SessionFuture,
};
use crate::{
    db::{
        connection::{ActiveConnection, ActiveDatabaseConnection, ConnectionManager},
        data_tasks::{
            metadata::{
                DataColumn, DataMetadataSnapshot, DataTable, EndpointIdentity,
                ValidatedTableMapping,
            },
            value::{CanonicalRow, DataValue},
            Cancellation,
        },
    },
    models::{
        data_tasks::{DataDiffOperation, DataEndpoint},
        types::{ConnectionConfig, DatabaseType},
    },
};
use clickhouse_rs::{self as clickhouse, Client};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::atomic::Ordering, time::Duration};
use tokio::io::AsyncBufReadExt;
const DB_ERROR: &str = "ClickHouse 数据任务失败，请检查权限、字段、约束及连接";
fn db_error(_: clickhouse_rs::error::Error) -> String {
    DB_ERROR.into()
}
fn checked(c: &Cancellation) -> Result<(), String> {
    if c.load(Ordering::Acquire) {
        Err("cancelled: 数据任务已取消".into())
    } else {
        Ok(())
    }
}
async fn cancelled(c: &Cancellation) {
    while !c.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
fn id(name: &str) -> String {
    format!("`{}`", name.replace('\\', "\\\\").replace('`', "\\`"))
}
fn unnullable(t: &str) -> &str {
    t.strip_prefix("Nullable(")
        .and_then(|s| s.strip_suffix(')'))
        .unwrap_or(t)
}
fn wire_type(t: &str) -> Result<&'static str, String> {
    let t = unnullable(t);
    Ok(match t {
        "Int8" | "Int16" | "Int32" | "Int64" => "int",
        "UInt8" | "UInt16" | "UInt32" | "UInt64" => "uint",
        "String" => "binary",
        t if t.starts_with("Decimal(")
            || t.starts_with("Decimal32(")
            || t.starts_with("Decimal64(")
            || t.starts_with("Decimal128(")
            || t.starts_with("Decimal256(") =>
        {
            "decimal"
        }
        t if t.starts_with("DateTime64(")
            && (!t.contains(',') || t.ends_with(", 'UTC')") || t.ends_with(",'UTC')")) =>
        {
            "datetime"
        }
        _ => return Err("unsupported_capability: ClickHouse 字段类型未经无损验收".into()),
    })
}
fn hex(bytes: &[u8]) -> String {
    const H: &[u8] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(H[(b >> 4) as usize] as char);
        out.push(H[(b & 15) as usize] as char);
    }
    out
}
fn unhex(text: &str) -> Result<Vec<u8>, String> {
    if !text.len().is_multiple_of(2) {
        return Err("ClickHouse 字节编码无效".into());
    }
    text.as_bytes()
        .chunks_exact(2)
        .map(|s| {
            std::str::from_utf8(s)
                .ok()
                .and_then(|s| u8::from_str_radix(s, 16).ok())
                .ok_or_else(|| "ClickHouse 字节编码无效".into())
        })
        .collect()
}
fn decode_line(line: &[u8], projections: &[Projection]) -> Result<CanonicalRow, String> {
    let line = std::str::from_utf8(line).map_err(|_| "ClickHouse 快照编码无效")?;
    let (index, payload) = line.split_once('\t').ok_or("ClickHouse 快照形状无效")?;
    let p = projections
        .get(
            index
                .parse::<usize>()
                .map_err(|_| "ClickHouse 表索引无效")?,
        )
        .ok_or("ClickHouse 表索引无效")?;
    let values = payload
        .split(',')
        .map(|field| {
            let (kind, value) = field.split_once(':').ok_or("ClickHouse 字段编码无效")?;
            if kind == "null" {
                return Ok(DataValue::Null);
            }
            let bytes = unhex(value)?;
            if kind == "binary" {
                return Ok(DataValue::Binary(bytes));
            }
            let value = String::from_utf8(bytes).map_err(|_| "ClickHouse 字段不是 UTF-8")?;
            Ok(match kind {
                "int" => DataValue::Int(value.parse().map_err(|_| "ClickHouse 整数溢出")?),
                "uint" => DataValue::UInt(value.parse().map_err(|_| "ClickHouse 无符号整数溢出")?),
                "decimal" => {
                    DataValue::Decimal(crate::db::data_tasks::value::normalize_decimal(&value)?)
                }
                "datetime" => DataValue::Temporal {
                    kind: "datetime".into(),
                    value,
                },
                _ => return Err("ClickHouse 类型标签无效".into()),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    if values.len() != p.columns.len() {
        return Err("ClickHouse 字段数与映射不一致".into());
    }
    let key = p
        .key_indices
        .iter()
        .map(|i| {
            values
                .get(*i)
                .cloned()
                .ok_or_else(|| "ClickHouse 键索引无效".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    CanonicalRow::new(p.output_table.clone(), key, values)
}
fn snapshot_sql(
    database: &str,
    projections: &[Projection],
    metadata: &DataMetadataSnapshot,
) -> Result<String, String> {
    if projections.is_empty() || projections.len() > 100 {
        return Err("invalid_mapping: 快照表数无效".into());
    }
    let selects=projections.iter().enumerate().map(|(index,p)|{
 let t=metadata.tables.iter().find(|t|t.name==p.table&&t.physical).ok_or("unsupported_capability: ClickHouse 只支持经验证的本地普通表")?;
 if p.columns.is_empty(){return Err("invalid_mapping: 快照列为空".into());}
 let fields=p.columns.iter().map(|name|{let c=t.columns.iter().find(|c|&c.name==name).ok_or("invalid_mapping: 快照列不存在")?;let kind=wire_type(&c.declared_type)?;let col=id(name);Ok(format!("if(isNull({col}),'null:',concat('{kind}:',hex(toString(assumeNotNull({col})))) )"))}).collect::<Result<Vec<_>,String>>()?;
 Ok(format!("SELECT toString({index}),arrayStringConcat([{}],',') FROM {}.{}",fields.join(","),id(database),id(&p.table)))
 }).collect::<Result<Vec<_>,String>>()?;
    let sql = selects.join(" UNION ALL ");
    if sql.len() > 1024 * 1024 {
        return Err("resource_limit: 快照 SQL 超过预算".into());
    }
    Ok(sql)
}
#[derive(clickhouse_rs::Row, Deserialize)]
struct CatalogRow {
    table: String,
    table_uuid: String,
    engine: String,
    create_sql: String,
    dependencies: Vec<String>,
    column: String,
    column_type: String,
    default_kind: String,
    default_expression: String,
}
struct ClickHouseSession {
    client: Client,
    active: Option<ActiveConnection>,
    config: ConnectionConfig,
    database: String,
    cancel: Cancellation,
    metadata: Option<DataMetadataSnapshot>,
    identity: Option<String>,
    write_tables: Vec<String>,
}
impl Drop for ClickHouseSession {
    fn drop(&mut self) {
        if let Some(active) = self.active.take() {
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = active.database.disconnect().await;
                });
            }
        }
    }
}
async fn open_native(
    mut config: ConnectionConfig,
    endpoint: DataEndpoint,
    cancel: Cancellation,
) -> Result<ClickHouseSession, String> {
    checked(&cancel)?;
    if config.database_type != DatabaseType::ClickHouse || endpoint.database.is_empty() {
        return Err("invalid_mapping: ClickHouse 端点无效".into());
    }
    let original = config.clone();
    config.database = Some(endpoint.database.clone());
    let (_, active) = ConnectionManager::prepare_connection(config)
        .await
        .map_err(|_| DB_ERROR)?;
    let client = match &active.database {
        ActiveDatabaseConnection::ClickHouse(c) => c.adapter.pool_clone().client.as_ref().clone(),
        _ => return Err(DB_ERROR.into()),
    }
    .with_validation(false)
    .with_compression(clickhouse_rs::Compression::None)
    .with_setting("session_timezone", "UTC")
    .with_setting("max_execution_time", "60")
    .with_setting("max_block_size", "1")
    .with_setting("max_threads", "1")
    .with_setting("cancel_http_readonly_queries_on_client_close", "1");
    Ok(ClickHouseSession {
        client,
        active: Some(active),
        config: original,
        database: endpoint.database,
        cancel,
        metadata: None,
        identity: None,
        write_tables: vec![],
    })
}
pub async fn open(
    config: ConnectionConfig,
    endpoint: DataEndpoint,
    cancel: Cancellation,
) -> Result<Box<dyn DataSession>, String> {
    Ok(Box::new(open_native(config, endpoint, cancel).await?))
}
impl ClickHouseSession {
    async fn metadata_inner(&mut self) -> Result<DataMetadataSnapshot, String> {
        checked(&self.cancel)?;
        let (version,identity,database,readonly,server_timezone):(String,String,String,u64,String)=self.client.query("SELECT version(),toString(serverUUID()),currentDatabase(),toUInt64(getSetting('readonly')),serverTimezone()").fetch_one().await.map_err(db_error)?;
        if !version.starts_with("25.8.") {
            return Err("unsupported_capability: ClickHouse 仅 25.8 经真实验收".into());
        }
        self.identity = Some(format!("clickhouse:{identity}"));
        if database != self.database {
            return Err("same_physical_target: ClickHouse 实际数据库不匹配".into());
        }
        let can_read: u8 = self
            .client
            .query(&format!("CHECK GRANT SELECT ON {}.*", id(&self.database)))
            .fetch_one()
            .await
            .map_err(db_error)?;
        let can_show: u8 = self
            .client
            .query("CHECK GRANT SHOW TABLES ON *.*")
            .fetch_one()
            .await
            .map_err(db_error)?;
        let can_policy: u8 = self
            .client
            .query("CHECK GRANT SHOW ROW POLICIES ON *.*")
            .fetch_one()
            .await
            .map_err(db_error)?;
        let policies: u64 = self
            .client
            .query("SELECT count() FROM system.row_policies WHERE database=?")
            .bind(&self.database)
            .fetch_one()
            .await
            .map_err(db_error)?;
        let rows=self.client.query("SELECT t.name AS table,toString(t.uuid) AS table_uuid,t.engine,t.create_table_query AS create_sql,t.dependencies_table AS dependencies,c.name AS column,c.type AS column_type,c.default_kind,c.default_expression FROM system.tables t INNER JOIN system.columns c ON t.database=c.database AND t.name=c.table WHERE t.database=? ORDER BY t.name,c.position").bind(&self.database).fetch_all::<CatalogRow>().await.map_err(db_error)?;
        let mut tables = BTreeMap::new();
        for row in rows {
            let supported = matches!(row.engine.as_str(), "MergeTree" | "Log")
                && !row.create_sql.to_ascii_uppercase().contains(" TTL ");
            let supported = supported
                && (!unnullable(&row.column_type).starts_with("DateTime64(")
                    || unnullable(&row.column_type).contains(',')
                    || server_timezone == "UTC");
            let t = tables
                .entry(row.table.clone())
                .or_insert_with(|| DataTable {
                    name: row.table,
                    create_sql: format!("{}\nuuid:{}", row.create_sql, row.table_uuid),
                    columns: vec![],
                    foreign_keys: vec![],
                    enabled_user_triggers: !row.dependencies.is_empty(),
                    physical: supported,
                });
            t.physical &= supported;
            t.columns.push(DataColumn {
                name: row.column,
                nullable: row.column_type.starts_with("Nullable("),
                declared_type: row.column_type,
                default_sql: (!row.default_expression.is_empty()).then_some(row.default_expression),
                generated: matches!(
                    row.default_kind.as_str(),
                    "ALIAS" | "MATERIALIZED" | "EPHEMERAL"
                ),
                primary_key_ordinal: 0,
                collation: None,
                identity: false,
                generator_safe: false,
            });
        }
        let tables = tables.into_values().collect::<Vec<_>>();
        let schema_fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&tables).map_err(|_| DB_ERROR)?)
        );
        let read_only = readonly != 0 || self.config.read_only.unwrap_or(false);
        let metadata = DataMetadataSnapshot {
            database_type: DatabaseType::ClickHouse,
            tables,
            read_only,
            permissions_verified: can_read == 1
                && can_show == 1
                && can_policy == 1
                && policies == 0,
            consistent_snapshot: false,
            protected_write: false,
            schema_fingerprint,
            configuration_fingerprint: crate::db::data_tasks::executor::configuration_fingerprint(
                &self.config,
            ),
        };
        self.metadata = Some(metadata.clone());
        Ok(metadata)
    }
}
impl DataSession for ClickHouseSession {
    fn supports_transaction(&self) -> bool {
        false
    }
    fn endpoint_identity(&self) -> Option<EndpointIdentity> {
        Some(EndpointIdentity {
            database_type: DatabaseType::ClickHouse,
            instance: self.identity.clone(),
            database: self.database.clone(),
            sqlite_path: None,
        })
    }
    fn dialect(&self) -> Dialect {
        Dialect::ClickHouse
    }
    fn begin_read(&mut self) -> SessionFuture<'_, ()> {
        Box::pin(async move { checked(&self.cancel) })
    }
    fn begin_protected_write(&mut self, tables: Vec<String>) -> SessionFuture<'_, ()> {
        Box::pin(async move {
            let m = self.metadata_inner().await?;
            if m.read_only {
                return Err("read_only_target: ClickHouse 目标只读".into());
            }
            let can_write: u8 = self
                .client
                .query(&format!("CHECK GRANT INSERT ON {}.*", id(&self.database)))
                .fetch_one()
                .await
                .map_err(db_error)?;
            if !m.permissions_verified
                || can_write != 1
                || tables.is_empty()
                || tables.iter().any(|name| {
                    !m.tables
                        .iter()
                        .any(|t| &t.name == name && t.physical && !t.enabled_user_triggers)
                })
            {
                return Err(
                    "unsupported_capability: ClickHouse 目标引擎、依赖或权限未通过验证".into(),
                );
            }
            self.write_tables = tables;
            Ok(())
        })
    }
    fn load_metadata(&mut self) -> SessionFuture<'_, DataMetadataSnapshot> {
        Box::pin(self.metadata_inner())
    }
    fn stream_rows(
        &mut self,
        projections: Vec<Projection>,
        cancel: Cancellation,
        sender: RowSender,
    ) -> SessionFuture<'_, u64> {
        Box::pin(async move {
            checked(&cancel)?;
            let metadata = self.metadata.as_ref().ok_or("ClickHouse 元数据未加载")?;
            let sql = snapshot_sql(&self.database, &projections, metadata)?;
            let budget = sender.budget();
            let max_line = budget
                .max_row_bytes
                .saturating_mul(2)
                .min(budget.memory_bytes / 4)
                .saturating_sub(1024);
            let _decode = sender.reserve_decode(budget.memory_bytes / 2).await?;
            let mut cursor = self
                .client
                .query(&sql)
                .fetch_bytes("TabSeparated")
                .map_err(db_error)?;
            let mut line = Vec::new();
            let mut block = [0u8; 65536];
            let mut count = 0;
            loop {
                let chunk = tokio::select! {r=cursor.fill_buf()=>r.map_err(|_|DB_ERROR)?,_=cancelled(&cancel)=>return Err("cancelled: ClickHouse 快照已取消".into())};
                let n = chunk.len().min(block.len());
                if n == 0 {
                    break;
                }
                block[..n].copy_from_slice(&chunk[..n]);
                cursor.consume(n);
                for part in block[..n].split_inclusive(|b| *b == b'\n') {
                    let ended = part.last() == Some(&b'\n');
                    let part = if ended { &part[..part.len() - 1] } else { part };
                    if line.len().saturating_add(part.len()) > max_line {
                        return Err("resource_limit: ClickHouse 单行超过共享内存预算".into());
                    }
                    line.extend_from_slice(part);
                    if ended {
                        let row = decode_line(&line, &projections)?;
                        if row.encoded_size() > budget.max_row_bytes {
                            return Err("resource_limit: ClickHouse 单行超过8MiB".into());
                        }
                        sender.send(row).await?;
                        line.clear();
                        count += 1;
                    }
                }
            }
            if !line.is_empty() {
                return Err("ClickHouse 快照响应不完整".into());
            }
            Ok(count)
        })
    }
    fn write_batch(&mut self, batch: WriteBatch) -> SessionFuture<'_, u64> {
        Box::pin(async move {
            checked(&self.cancel)?;
            if batch.kind != DataDiffOperation::Insert || !self.write_tables.contains(&batch.table)
            {
                return Err("unsupported_capability: ClickHouse 仅允许已验证表的追加".into());
            }
            let metadata = self.metadata.as_ref().ok_or("ClickHouse 元数据未加载")?;
            let table = metadata
                .tables
                .iter()
                .find(|t| t.name == batch.table)
                .ok_or("plan_stale: ClickHouse 目标表已消失")?;
            if batch.columns.is_empty()
                || batch.params.is_empty()
                || !batch.params.len().is_multiple_of(batch.columns.len())
            {
                return Err("invalid_mapping: ClickHouse 批次形状无效".into());
            }
            let types = batch
                .columns
                .iter()
                .map(|name| {
                    table
                        .columns
                        .iter()
                        .find(|c| &c.name == name)
                        .ok_or("invalid_mapping: ClickHouse 目标列不存在")
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut values = Vec::new();
            let tuples = batch
                .params
                .chunks(batch.columns.len())
                .map(|row| {
                    let fields =
                        row.iter()
                            .zip(&types)
                            .map(|(value, column)| {
                                wire_type(&column.declared_type)?;
                                let t = &column.declared_type;
                                let text =
                                    match value {
                                        DataValue::Null => {
                                            if !column.nullable {
                                                return Err(
                                            "invalid_mapping: ClickHouse 非空列不能写入NULL".into(),
                                        );
                                            }
                                            return Ok(format!("CAST(NULL AS {t})"));
                                        }
                                        DataValue::Int(v) => v.to_string(),
                                        DataValue::UInt(v) => v.to_string(),
                                        DataValue::Decimal(v) => v.clone(),
                                        DataValue::Binary(v) => {
                                            values.push(hex(v));
                                            return Ok(format!("CAST(unhex(?) AS {t})"));
                                        }
                                        DataValue::Temporal { value, .. } => value.clone(),
                                        _ => return Err(
                                            "unsupported_capability: ClickHouse 绑定类型未经验证"
                                                .into(),
                                        ),
                                    };
                                values.push(text);
                                Ok(format!("CAST(? AS {t})"))
                            })
                            .collect::<Result<Vec<_>, String>>()?;
                    Ok(format!("({})", fields.join(",")))
                })
                .collect::<Result<Vec<_>, String>>()?;
            let sql = format!(
                "INSERT INTO {}.{} ({}) VALUES {}",
                id(&self.database),
                id(&batch.table),
                batch
                    .columns
                    .iter()
                    .map(|c| id(c))
                    .collect::<Vec<_>>()
                    .join(","),
                tuples.join(",")
            );
            let client = self
                .client
                .clone()
                .with_setting("async_insert", "0")
                .with_setting("wait_for_async_insert", "1")
                .with_setting("insert_deduplicate", "0")
                .with_setting("input_format_values_interpret_expressions", "1");
            let mut query = client.query(&sql);
            for value in values {
                query = query.bind(value);
            }
            // 只有权限拒绝和目标不存在可证明在写入前失败；其余服务端/传输异常保守视为未知。
            let result = tokio::time::timeout(Duration::from_secs(70), query.execute()).await;
            match result{Ok(Ok(()))=>Ok((batch.params.len()/batch.columns.len())as u64),Ok(Err(clickhouse_rs::error::Error::BadResponse(message))) if message.starts_with("Code: 497.")||message.starts_with("Code: 60.")=>Err("database_error: ClickHouse 在写入前拒绝此批次，已停止；此前确认批次保留".into()),_=>Err("outcome_unknown: ClickHouse 批次接收结果未确认，已停止；请核对目标，不会自动重放".into())}
        })
    }
    fn delete_all(&mut self, _: String) -> SessionFuture<'_, u64> {
        Box::pin(async { Err("unsupported_capability: ClickHouse 禁止替换或删除".into()) })
    }
    fn maintain_generators(&mut self, _: Vec<ValidatedTableMapping>) -> SessionFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    fn commit(&mut self) -> SessionFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
    fn rollback(&mut self) -> SessionFuture<'_, ()> {
        Box::pin(async { Ok(()) })
    }
}

// ClickHouse 25.8：产品只开放源端读取；原生写入仅供隔离实验，不能替代目标 DDL 保护。
#[cfg(test)]
mod tests {
    use crate::{
        db::data_tasks::{executor, Cancellation},
        models::{
            data_tasks::DataEndpoint,
            types::{ConnectionConfig, DatabaseType},
        },
    };
    fn config() -> ConnectionConfig {
        let url = std::env::var("DB_CONNECT_DATA_TASK_CLICKHOUSE_URL").unwrap_or_else(|_| {
            format!(
                "http://default:data-task-test@127.0.0.1:{}",
                std::env::var("DB_CONNECT_DATA_TASK_CLICKHOUSE_PORT")
                    .expect("专属 ClickHouse 测试端口")
            )
        });
        let url = reqwest::Url::parse(&url).unwrap();
        serde_json::from_value(serde_json::json!({"database_type":"clickhouse","name":"隔离验收","host":url.host_str().unwrap(),"port":url.port().unwrap_or(8123),"username":url.username(),"password":url.password()})).unwrap()
    }
    #[tokio::test]
    #[ignore = "需要专属 ClickHouse 25.8 容器和 DB_CONNECT_DATA_TASK_CLICKHOUSE_PORT"]
    async fn real_clickhouse_opens_independent_session() {
        let config = config();
        assert_eq!(config.database_type, DatabaseType::ClickHouse);
        let cancel: Cancellation = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut session = executor::open_session(
            config,
            DataEndpoint {
                saved_connection_id: "test-ch".into(),
                database: "default".into(),
            },
            cancel,
        )
        .await
        .expect("ClickHouse 应支持原生任务会话");
        let meta = session.load_metadata().await.unwrap();
        assert!(!meta.consistent_snapshot);
        assert!(!meta.protected_write);
        assert!(!session.supports_transaction());
    }
    fn client() -> clickhouse_rs::Client {
        let config = config();
        crate::db::clickhouse::build_clickhouse_client(&config.host, config.port, &config)
            .unwrap()
            .client
            .as_ref()
            .clone()
            .with_validation(false)
    }
    fn cancellation() -> Cancellation {
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false))
    }
    fn endpoint(db: &str) -> DataEndpoint {
        DataEndpoint {
            saved_connection_id: db.into(),
            database: db.into(),
        }
    }
    async fn collect(
        session: &mut dyn super::DataSession,
        p: Vec<super::Projection>,
    ) -> Vec<super::CanonicalRow> {
        let (sender, mut receiver) = super::RowSender::channel(Default::default());
        let consumer = tokio::spawn(async move {
            let mut out = vec![];
            while let Some(row) = receiver.recv().await {
                out.push(row.row);
            }
            out
        });
        session
            .stream_rows(p, cancellation(), sender)
            .await
            .unwrap();
        consumer.await.unwrap()
    }
    #[tokio::test]
    #[ignore = "需要专属 ClickHouse 25.8 容器和 DB_CONNECT_DATA_TASK_CLICKHOUSE_PORT"]
    async fn real_clickhouse_exact_values_and_engine_guards() {
        use super::*;
        let client = client();
        let db = format!("dt_ch_{}", uuid::Uuid::new_v4().simple());
        let dbid = id(&db);
        client
            .query(&format!("CREATE DATABASE {dbid}"))
            .execute()
            .await
            .unwrap();
        client.query(&format!("CREATE TABLE {dbid}.src(u UInt64,d Nullable(Decimal(30,10)),b String,ts DateTime64(6,'UTC')) ENGINE=MergeTree ORDER BY u")).execute().await.unwrap();
        client
            .query(&format!("CREATE TABLE {dbid}.dst AS {dbid}.src"))
            .execute()
            .await
            .unwrap();
        client
            .query(&format!(
                "CREATE TABLE {dbid}.unsafe(u UInt64) ENGINE=ReplacingMergeTree ORDER BY u"
            ))
            .execute()
            .await
            .unwrap();
        client.query(&format!("INSERT INTO {dbid}.src VALUES(18446744073709551615,12345678901234567890.1234567890,unhex('00FF61'),'2026-10-20 12:34:56.123456'),(18446744073709551615,NULL,'','2026-10-20 12:34:56.000001')")).execute().await.unwrap();
        let mut session = open_native(config(), endpoint(&db), cancellation())
            .await
            .unwrap();
        let meta = session.load_metadata().await.unwrap();
        assert!(meta.permissions_verified);
        assert!(meta
            .tables
            .iter()
            .find(|t| t.name == "unsafe")
            .is_some_and(|t| !t.physical));
        assert!(meta
            .tables
            .iter()
            .all(|t| t.columns.iter().all(|c| c.primary_key_ordinal == 0)));
        assert!(session
            .begin_protected_write(vec!["unsafe".into()])
            .await
            .is_err());
        let columns = vec!["u".into(), "d".into(), "b".into(), "ts".into()];
        let projection = |table: &str| Projection {
            table: table.into(),
            output_table: "exact".into(),
            columns: columns.clone(),
            key_indices: vec![],
        };
        let rows = collect(&mut session, vec![projection("src"), projection("dst")]).await;
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|r| r.values
            == vec![
                DataValue::UInt(u64::MAX),
                DataValue::Decimal("12345678901234567890.123456789".into()),
                DataValue::Binary(vec![0, 255, 97]),
                DataValue::Temporal {
                    kind: "datetime".into(),
                    value: "2026-10-20 12:34:56.123456".into()
                }
            ]));
        // 此处只测原生驱动的实验写入；产品能力、预览和执行入口始终拒绝 ClickHouse 目标。
        session
            .begin_protected_write(vec!["dst".into()])
            .await
            .unwrap();
        let data = rows.iter().map(|r| r.values.clone()).collect::<Vec<_>>();
        let batch = super::super::batch::build_batch(
            Dialect::ClickHouse,
            &db,
            "dst",
            &columns,
            &[],
            DataDiffOperation::Insert,
            &data,
        )
        .unwrap();
        assert_eq!(session.write_batch(batch).await.unwrap(), 2);
        let copied = collect(&mut session, vec![projection("dst")]).await;
        assert_eq!(copied.len(), 2);
        for row in rows {
            assert!(copied.iter().any(|r| r.values == row.values));
        }
        client
            .query(&format!("DROP DATABASE {dbid}"))
            .execute()
            .await
            .unwrap();
    }
    async fn cross_direction(database: DatabaseType, to_clickhouse: bool) {
        use crate::{
            db::data_tasks::{cross_type_tests::Fixture, metadata, value::DataValue},
            models::data_tasks::*,
        };
        use std::sync::Arc;
        let fixture = Fixture::new(database, to_clickhouse).await;
        let client = client();
        let db = format!("dt_ch_{}", uuid::Uuid::new_v4().simple());
        let table = format!("{}.t", super::id(&db));
        client
            .query(&format!("CREATE DATABASE {}", super::id(&db)))
            .execute()
            .await
            .unwrap();
        client
            .query(&format!(
                "CREATE TABLE {table}(id Int64,v Nullable(String),b Nullable(String)) ENGINE=Log"
            ))
            .execute()
            .await
            .unwrap();
        if !to_clickhouse {
            client.query(&format!("INSERT INTO {table} VALUES(9007199254740993,unhex('E4B8ADE69687'),unhex('00FF')),(2,NULL,NULL)")).execute().await.unwrap();
        }
        // String 为任意字节，仅开放到二进制列的无损映射。
        let columns = ["id", "b"];
        let request = DataTaskRequest {
            protocol_version: 1,
            kind: DataTaskKind::Transfer,
            mode: DataTaskMode::Append,
            source: endpoint(&db),
            target: fixture.endpoint.clone(),
            mappings: vec![TableMapping {
                source_table: "t".into(),
                target_table: "t".into(),
                columns: columns
                    .iter()
                    .map(|c| ColumnMapping {
                        source_column: (*c).into(),
                        target_column: (*c).into(),
                    })
                    .collect(),
            }],
        };
        let directory = fixture.directory.join("ch-spool");
        std::fs::create_dir(&directory).unwrap();
        let cancel = cancellation();
        if to_clickhouse {
            let capabilities = metadata::get_config_capabilities(&fixture.config, &config());
            assert!(
                !capabilities.transfer
                    && !capabilities.row_sync
                    && capabilities.supported_modes.is_empty()
            );
            assert_eq!(
                capabilities.blockers[0].message,
                metadata::CLICKHOUSE_TARGET_BLOCKER
            );
            let mut rejected_request = request.clone();
            rejected_request.source = fixture.endpoint.clone();
            rejected_request.target = endpoint(&db);
            let error = executor::prepare_task(
                "ch-blocked".into(),
                rejected_request,
                fixture.config.clone(),
                config(),
                directory.clone(),
                cancel.clone(),
                Arc::new(|_| {}),
            )
            .await
            .unwrap_err();
            assert_eq!(error.code, "unsupported_capability");
            assert!(error.message.contains(metadata::CLICKHOUSE_TARGET_BLOCKER));
            // 绕过公开能力和预览层，直接给执行器一个后端计划，仍须在任何 DML 前拒绝。
            let plan = executor::prepare_task(
                "ch-execution-guard".into(),
                request,
                config(),
                fixture.config.clone(),
                directory,
                cancel.clone(),
                Arc::new(|_| {}),
            )
            .await
            .unwrap();
            let result = executor::execute_plan(
                Arc::new(plan),
                fixture.config.clone(),
                config(),
                cancel,
                Arc::new(|_| {}),
            )
            .await;
            assert_eq!(result.status, DataTaskStatus::Failed);
            assert_eq!(result.commit_state, DataCommitState::None);
            assert_eq!(
                result.error.as_ref().unwrap().code,
                "unsupported_capability"
            );
            assert!(result
                .error
                .as_ref()
                .unwrap()
                .message
                .contains(metadata::CLICKHOUSE_TARGET_BLOCKER));
            let count: u64 = client
                .query(&format!("SELECT count() FROM {table}"))
                .fetch_one()
                .await
                .unwrap();
            assert_eq!(count, 0, "预览与执行拒绝均不得写入目标 ClickHouse");
        } else {
            let capabilities = metadata::get_config_capabilities(&config(), &fixture.config);
            assert!(capabilities.transfer && !capabilities.row_sync);
            assert_eq!(capabilities.supported_modes, vec![DataTaskMode::Append]);
            let plan = executor::prepare_task(
                "ch-cross".into(),
                request.clone(),
                config(),
                fixture.config.clone(),
                directory.clone(),
                cancel.clone(),
                Arc::new(|_| {}),
            )
            .await
            .unwrap();
            assert!(plan
                .preview
                .risks
                .iter()
                .any(|r| r.id == "source_without_transaction_snapshot" && r.required));
            let result = executor::execute_plan(
                Arc::new(plan),
                config(),
                fixture.config.clone(),
                cancel.clone(),
                Arc::new(|_| {}),
            )
            .await;
            assert_eq!(
                result.status,
                DataTaskStatus::Succeeded,
                "{:?}",
                result.error
            );
            assert_eq!(result.commit_state, DataCommitState::Committed);
            let rows = fixture.rows().await;
            assert_eq!(
                rows,
                vec![
                    vec![DataValue::Int(2), DataValue::Null, DataValue::Null],
                    vec![
                        DataValue::Int(3),
                        DataValue::Text("retained".into()),
                        DataValue::Null
                    ],
                    vec![
                        DataValue::Int(9007199254740993),
                        DataValue::Null,
                        DataValue::Binary(vec![0, 255])
                    ]
                ]
            );
            // 第二次追加触发唯一约束，事务目标必须真正回滚且保留既有行。
            let plan = executor::prepare_task(
                "ch-conflict".into(),
                request,
                config(),
                fixture.config.clone(),
                directory,
                cancel.clone(),
                Arc::new(|_| {}),
            )
            .await
            .unwrap();
            let result = executor::execute_plan(
                Arc::new(plan),
                config(),
                fixture.config.clone(),
                cancel,
                Arc::new(|_| {}),
            )
            .await;
            assert_eq!(result.commit_state, DataCommitState::RolledBack);
            assert_eq!(fixture.rows().await, rows);
        }
        client
            .query(&format!("DROP DATABASE {}", super::id(&db)))
            .execute()
            .await
            .unwrap();
        fixture.cleanup().await;
    }
    macro_rules! ch_direction {
        ($name:ident,$db:ident,$to:literal) => {
            #[tokio::test]
            #[ignore = "需要专属ClickHouse和事务库容器"]
            async fn $name() {
                cross_direction(DatabaseType::$db, $to).await;
            }
        };
    }
    ch_direction!(real_sqlite_to_clickhouse_is_blocked, Sqlite, true);
    ch_direction!(real_clickhouse_to_sqlite, Sqlite, false);
    ch_direction!(real_postgres_to_clickhouse_is_blocked, Postgres, true);
    ch_direction!(real_clickhouse_to_postgres, Postgres, false);
    ch_direction!(real_mysql_to_clickhouse_is_blocked, MySql, true);
    ch_direction!(real_clickhouse_to_mysql, MySql, false);
    ch_direction!(real_sqlserver_to_clickhouse_is_blocked, SqlServer, true);
    ch_direction!(real_clickhouse_to_sqlserver, SqlServer, false);
    /// 测试代理仅服务当前用例：第二次INSERT可明确拒绝，或先交给真实数据库执行后丢弃响应。
    async fn failure_proxy(
        drop_response: bool,
    ) -> (
        u16,
        std::sync::Arc<std::sync::atomic::AtomicUsize>,
        tokio::task::JoinHandle<()>,
    ) {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let inserts = Arc::new(AtomicUsize::new(0));
        let count = inserts.clone();
        let real_port = config().port;
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let count = count.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 4096];
                    let header_end = loop {
                        let n = socket.read(&mut buffer).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        request.extend_from_slice(&buffer[..n]);
                        if let Some(i) = request.windows(4).position(|v| v == b"\r\n\r\n") {
                            break i + 4;
                        }
                        assert!(request.len() < 64 * 1024);
                    };
                    let headers = String::from_utf8(request[..header_end].to_vec()).unwrap();
                    let length = headers
                        .lines()
                        .find_map(|s| {
                            s.split_once(':')
                                .filter(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                                .map(|(_, v)| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    while request.len() < header_end + length {
                        let n = socket.read(&mut buffer).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        request.extend_from_slice(&buffer[..n]);
                    }
                    let body = &request[header_end..header_end + length];
                    let insert = body.starts_with(b"INSERT INTO");
                    let nth = if insert {
                        count.fetch_add(1, Ordering::SeqCst) + 1
                    } else {
                        0
                    };
                    if nth == 1 {
                        tokio::time::sleep(std::time::Duration::from_millis(220)).await;
                    }
                    if nth == 2 && !drop_response {
                        let body =
                            "Code: 497. DB::Exception: Not enough privileges. (ACCESS_DENIED)";
                        let response=format!("HTTP/1.1 403 Forbidden\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                        socket.write_all(response.as_bytes()).await.unwrap();
                        return;
                    }
                    let path = headers
                        .lines()
                        .next()
                        .unwrap()
                        .split_whitespace()
                        .nth(1)
                        .unwrap();
                    let mut upstream = reqwest::Client::new()
                        .post(format!("http://127.0.0.1:{real_port}{path}"))
                        .body(body.to_vec());
                    for header in headers.lines().skip(1) {
                        if let Some((name, value)) = header.split_once(':') {
                            if name.eq_ignore_ascii_case("authorization")
                                || name.to_ascii_lowercase().starts_with("x-clickhouse-")
                            {
                                upstream = upstream.header(name, value.trim());
                            }
                        }
                    }
                    let upstream = upstream.send().await.unwrap();
                    let status = upstream.status().as_u16();
                    let response = upstream.bytes().await.unwrap();
                    if nth == 2 && drop_response {
                        return;
                    }
                    let headers=format!("HTTP/1.1 {status} Response\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",response.len());
                    socket.write_all(headers.as_bytes()).await.unwrap();
                    socket.write_all(&response).await.unwrap();
                });
            }
        });
        (port, inserts, task)
    }
    #[tokio::test]
    #[ignore = "需要专属ClickHouse容器"]
    async fn real_clickhouse_definite_rejection_is_not_unknown() {
        use super::*;
        let client = client();
        let db = format!("dt_ch_{}", uuid::Uuid::new_v4().simple());
        let dbid = id(&db);
        client
            .query(&format!("CREATE DATABASE {dbid}"))
            .execute()
            .await
            .unwrap();
        client
            .query(&format!("CREATE TABLE {dbid}.dst(id Int64) ENGINE=Log"))
            .execute()
            .await
            .unwrap();
        let (port, inserts, proxy) = failure_proxy(false).await;
        let mut target = config();
        target.port = port;
        let mut session = open_native(target, endpoint(&db), cancellation())
            .await
            .unwrap();
        session
            .begin_protected_write(vec!["dst".into()])
            .await
            .unwrap();
        let batch = || {
            super::super::batch::build_batch(
                Dialect::ClickHouse,
                &db,
                "dst",
                &["id".into()],
                &[],
                DataDiffOperation::Insert,
                &[vec![DataValue::Int(1)]],
            )
            .unwrap()
        };
        assert_eq!(session.write_batch(batch()).await.unwrap(), 1);
        let error = session.write_batch(batch()).await.unwrap_err();
        assert!(
            !error.starts_with("outcome_unknown:"),
            "明确的写前权限拒绝应保留此前确认批次：{error}"
        );
        assert_eq!(inserts.load(std::sync::atomic::Ordering::SeqCst), 2);
        proxy.abort();
        client
            .query(&format!("DROP DATABASE {dbid}"))
            .execute()
            .await
            .unwrap();
    }
    #[test]
    fn typed_wire_decoder_preserves_null_empty_and_arbitrary_bytes() {
        use super::*;
        let projection = Projection {
            table: "t".into(),
            output_table: "t".into(),
            columns: vec!["a".into(), "b".into(), "c".into(), "d".into()],
            key_indices: vec![],
        };
        let row = decode_line(
            b"0\tnull:,binary:,binary:00FF,uint:3138343436373434303733373039353531363135",
            &[projection],
        )
        .unwrap();
        assert_eq!(
            row.values,
            vec![
                DataValue::Null,
                DataValue::Binary(vec![]),
                DataValue::Binary(vec![0, 255]),
                DataValue::UInt(u64::MAX)
            ]
        );
        assert!(wire_type("Array(UInt64)").is_err());
        assert!(wire_type("DateTime64(6, 'Asia/Shanghai')").is_err());
        assert!(wire_type("LowCardinality(String)").is_err());
    }
    #[tokio::test]
    #[ignore = "需要专属ClickHouse容器"]
    async fn real_clickhouse_large_row_and_cancellation_respect_budget() {
        use super::*;
        let client = client();
        let db = format!("dt_ch_{}", uuid::Uuid::new_v4().simple());
        let dbid = id(&db);
        client
            .query(&format!("CREATE DATABASE {dbid}"))
            .execute()
            .await
            .unwrap();
        client
            .query(&format!("CREATE TABLE {dbid}.large(v String) ENGINE=Log"))
            .execute()
            .await
            .unwrap();
        client
            .query(&format!(
                "INSERT INTO {dbid}.large SELECT repeat('xxxxxxxxxxxxxxxx',589824)"
            ))
            .execute()
            .await
            .unwrap();
        let cancel = cancellation();
        let mut session = open_native(config(), endpoint(&db), cancel.clone())
            .await
            .unwrap();
        session.load_metadata().await.unwrap();
        let budget = crate::db::data_tasks::spool::ResourceBudget::default();
        let (sender, mut receiver) = RowSender::channel(budget.clone());
        let consumer = tokio::spawn(async move { while receiver.recv().await.is_some() {} });
        let p = Projection {
            table: "large".into(),
            output_table: "large".into(),
            columns: vec!["v".into()],
            key_indices: vec![],
        };
        let error = tokio::time::timeout(
            Duration::from_secs(10),
            session.stream_rows(vec![p.clone()], cancel.clone(), sender),
        )
        .await
        .unwrap()
        .unwrap_err();
        assert!(error.starts_with("resource_limit:"), "{error}");
        consumer.await.unwrap();
        assert!(budget.memory_peak() <= budget.memory_bytes as u64);
        assert_eq!(budget.memory_used(), 0);
        cancel.store(true, Ordering::Release);
        let (sender, _receiver) = RowSender::channel(Default::default());
        assert!(session
            .stream_rows(vec![p], cancel, sender)
            .await
            .unwrap_err()
            .starts_with("cancelled:"));
        client
            .query(&format!("DROP DATABASE {dbid}"))
            .execute()
            .await
            .unwrap();
    }
    #[tokio::test]
    #[ignore = "需要专属ClickHouse容器"]
    async fn real_clickhouse_recreated_table_invalidates_identity() {
        use super::*;
        let client = client();
        let db = format!("dt_ch_{}", uuid::Uuid::new_v4().simple());
        let dbid = id(&db);
        client
            .query(&format!("CREATE DATABASE {dbid}"))
            .execute()
            .await
            .unwrap();
        let create = format!("CREATE TABLE {dbid}.t(id Int64) ENGINE=Log");
        client.query(&create).execute().await.unwrap();
        let mut session = open_native(config(), endpoint(&db), cancellation())
            .await
            .unwrap();
        let before = session.load_metadata().await.unwrap().schema_fingerprint;
        client
            .query(&format!("DROP TABLE {dbid}.t"))
            .execute()
            .await
            .unwrap();
        client.query(&create).execute().await.unwrap();
        let after = session.load_metadata().await.unwrap().schema_fingerprint;
        assert_ne!(before, after, "名称结构一致但物理表重建必须使计划失效");
        client
            .query(&format!("DROP DATABASE {dbid}"))
            .execute()
            .await
            .unwrap();
    }
}
