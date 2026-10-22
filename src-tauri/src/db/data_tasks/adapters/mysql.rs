//! MySQL/MariaDB 数据任务：专属物理会话、固定元数据查询和单 UNION 快照流。
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
                DataColumn, DataForeignKey, DataMetadataSnapshot, DataTable, ValidatedTableMapping,
            },
            value::{CanonicalRow, DataValue},
            Cancellation,
        },
    },
    models::{
        data_tasks::DataEndpoint,
        types::{ConnectionConfig, DatabaseType},
    },
};
use mysql_async::{prelude::*, Conn, Params, Row, Value};
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::atomic::Ordering, time::Duration};
const DATABASE_ERROR: &str = "MySQL/MariaDB 数据任务失败，请检查权限、事务表、约束及数据库连接";
fn db_error(_: mysql_async::Error) -> String {
    DATABASE_ERROR.into()
}
fn cell<T: FromValue>(row: &Row, index: usize) -> Result<T, String> {
    row.get_opt(index)
        .ok_or(DATABASE_ERROR)?
        .map_err(|_| DATABASE_ERROR.into())
}
fn id(name: &str) -> String {
    Dialect::MySql.identifier(name)
}
fn checked(cancel: &Cancellation) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("cancelled: 数据任务已取消".into())
    } else {
        Ok(())
    }
}
async fn wait_cancel(cancel: &Cancellation) {
    while !cancel.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}
fn protected_write_sql(database: &str, tables: &[String]) -> Result<String, String> {
    if tables.is_empty() || tables.len() > 100 {
        return Err("invalid_mapping: 受保护写入必须包含 1 至 100 张表".into());
    }
    let mut names = tables.to_vec();
    names.sort();
    names.dedup();
    Ok(format!("SET SESSION innodb_lock_wait_timeout=10; SET SESSION lock_wait_timeout=10; SET autocommit=0; LOCK TABLES {}",names.iter().map(|t|format!("{}.{} WRITE",id(database),id(t))).collect::<Vec<_>>().join(",")))
}
fn decode_payload(
    table: &str,
    key_indices: &[usize],
    payload: &str,
) -> Result<CanonicalRow, String> {
    if payload.len() > 32 * 1024 * 1024 {
        return Err("resource_limit: 单行超过 8 MiB 上限".into());
    }
    let json: Json = serde_json::from_str(payload).map_err(|_| "MySQL 集合快照编码无效")?;
    let mut values = Vec::new();
    for field in json.as_array().ok_or("MySQL 集合快照形状无效")? {
        let kind = field["t"].as_str().ok_or("MySQL 集合快照类型缺失")?;
        let text = || {
            field["v"]
                .as_str()
                .ok_or_else(|| "MySQL 集合快照值必须采用无损字符串".to_string())
        };
        values.push(match kind {
            "null" => DataValue::Null,
            "int" => DataValue::Int(text()?.parse().map_err(|_| "MySQL 有符号整数溢出")?),
            "uint" => DataValue::UInt(text()?.parse().map_err(|_| "MySQL 无符号整数溢出")?),
            "decimal" => {
                DataValue::Decimal(crate::db::data_tasks::value::normalize_decimal(text()?)?)
            }
            "text" => DataValue::Text(text()?.into()),
            "binary" => {
                let value = text()?;
                if value.len() % 2 != 0 {
                    return Err("MySQL 二进制十六进制长度无效".into());
                }
                DataValue::Binary(
                    value
                        .as_bytes()
                        .chunks_exact(2)
                        .map(|pair| {
                            std::str::from_utf8(pair)
                                .ok()
                                .and_then(|s| u8::from_str_radix(s, 16).ok())
                                .ok_or_else(|| "MySQL 二进制十六进制编码无效".to_string())
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                )
            }
            "date" | "datetime" | "timestamp" | "time" => DataValue::Temporal {
                kind: kind.into(),
                value: text()?.into(),
            },
            _ => return Err("unsupported_capability: MySQL 值类型未经无损验收".into()),
        });
    }
    let key = key_indices
        .iter()
        .map(|i| {
            values
                .get(*i)
                .cloned()
                .ok_or_else(|| "MySQL 定位键索引无效".into())
        })
        .collect::<Result<Vec<_>, String>>()?;
    let row = CanonicalRow::new(table.into(), key, values)?;
    if row.encoded_size() > 8 * 1024 * 1024 {
        return Err("resource_limit: 单行超过 8 MiB 上限".into());
    }
    Ok(row)
}
fn server_version_verified(version: &str) -> bool {
    if let Some(patch) = version.strip_prefix("8.4.") {
        return !patch.is_empty() && patch.bytes().all(|byte| byte.is_ascii_digit());
    }
    version
        .strip_prefix("11.4.")
        .and_then(|tail| tail.split_once("-MariaDB"))
        .is_some_and(|(patch, _)| {
            !patch.is_empty() && patch.bytes().all(|byte| byte.is_ascii_digit())
        })
}
fn verify_grants(grants: &[String], database: &str, read_only: bool) -> bool {
    let mut permissions = std::collections::BTreeSet::new();
    let mut global_select = false;
    for grant in grants {
        let Some((privileges, destination)) = grant
            .strip_prefix("GRANT ")
            .and_then(|s| s.split_once(" ON "))
        else {
            continue;
        };
        let Some((scope, _)) = destination.split_once(" TO ") else {
            continue;
        };
        if scope != "*.*" && scope != format!("{}.*", id(database)) {
            continue;
        }
        if privileges == "ALL PRIVILEGES" {
            if scope == "*.*" {
                return true;
            }
            permissions.extend(
                [
                    "SELECT",
                    "INSERT",
                    "UPDATE",
                    "DELETE",
                    "LOCK TABLES",
                    "TRIGGER",
                    "REFERENCES",
                ]
                .map(str::to_string),
            );
        } else {
            let privileges = privileges
                .split(',')
                .map(|p| p.trim().to_ascii_uppercase())
                .collect::<Vec<_>>();
            if scope == "*.*" && privileges.iter().any(|p| p == "SELECT") {
                global_select = true;
            }
            permissions.extend(privileges);
        }
    }
    let required: &[&str] = if read_only {
        &["SELECT"]
    } else {
        &[
            "SELECT",
            "INSERT",
            "UPDATE",
            "DELETE",
            "LOCK TABLES",
            "TRIGGER",
            "REFERENCES",
        ]
    };
    // 目标目录必须能发现跨 database 入向 FK；仅当前 schema 的授权不足以证明其不存在。
    (read_only || global_select)
        && required
            .iter()
            .all(|permission| permissions.contains(*permission))
}
fn wire_type(declared: &str) -> Result<&'static str, String> {
    let upper = declared.to_ascii_uppercase();
    let base = upper.split(['(', ' ']).next().unwrap_or("");
    Ok(match base {
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" => {
            if upper.contains("UNSIGNED") {
                "uint"
            } else {
                "int"
            }
        }
        "DECIMAL" | "NUMERIC" => "decimal",
        "CHAR" | "VARCHAR" | "TINYTEXT" | "TEXT" | "MEDIUMTEXT" | "LONGTEXT" => "text",
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" => "binary",
        "DATE" => "date",
        "DATETIME" => "datetime",
        "TIMESTAMP" => "timestamp",
        "TIME" => "time",
        _ => return Err("unsupported_capability: MySQL 字段类型尚未通过无损验收".into()),
    })
}
fn snapshot_sql(
    database: &str,
    projections: &[Projection],
    metadata: &DataMetadataSnapshot,
) -> Result<String, String> {
    if projections.is_empty() || projections.len() > 100 {
        return Err("resource_limit: 集合快照须包含 1 至 100 张表".into());
    }
    let mut selects = Vec::new();
    for (index, p) in projections.iter().enumerate() {
        let table = metadata
            .tables
            .iter()
            .find(|t| t.name == p.table && t.physical)
            .ok_or("invalid_mapping: 快照表不存在或不是 InnoDB 物理表")?;
        if p.columns.is_empty() {
            return Err("invalid_mapping: 快照列不能为空".into());
        }
        let mut fields = Vec::new();
        for name in &p.columns {
            let column = table
                .columns
                .iter()
                .find(|c| &c.name == name)
                .ok_or("invalid_mapping: 快照列不存在")?;
            let kind = wire_type(&column.declared_type)?;
            let column = id(name);
            let value = if kind == "binary" {
                format!("HEX({column})")
            } else {
                format!("CAST({column} AS CHAR CHARACTER SET utf8mb4)")
            };
            fields.push(format!("CASE WHEN {column} IS NULL THEN JSON_OBJECT('t','null','v',NULL) ELSE JSON_OBJECT('t','{kind}','v',{value}) END"));
        }
        selects.push(format!(
            "SELECT {index} AS __data_table,JSON_ARRAY({}) AS __data_payload FROM {}.{}",
            fields.join(","),
            id(database),
            id(&p.table)
        ));
    }
    let sql = selects.join(" UNION ALL ");
    if sql.len() > 1024 * 1024 {
        return Err("resource_limit: 集合快照 SQL 超过 1 MiB，请拆分任务".into());
    }
    Ok(sql)
}
fn bind_value(value: DataValue) -> Result<Value, String> {
    Ok(match value {
        DataValue::Null => Value::NULL,
        DataValue::Bool(v) => Value::Int(i64::from(v)),
        DataValue::Int(v) => Value::Int(v),
        DataValue::UInt(v) => Value::UInt(v),
        DataValue::Decimal(v) => Value::Bytes(v.into_bytes()),
        DataValue::Text(v) => Value::Bytes(v.into_bytes()),
        DataValue::Binary(v) => Value::Bytes(v),
        DataValue::Temporal { value, .. } => Value::Bytes(value.into_bytes()),
        _ => return Err("unsupported_capability: MySQL 绑定类型尚未通过无损验收".into()),
    })
}
struct MySqlSession {
    conn: Option<Conn>,
    active: Option<ActiveConnection>,
    config: ConnectionConfig,
    database: String,
    cancel: Cancellation,
    metadata: Option<DataMetadataSnapshot>,
    locked: bool,
    instance: Option<String>,
    actual_database: String,
    cleanup_errors: Vec<String>,
}
impl Drop for MySqlSession {
    fn drop(&mut self) {
        if let Some(conn) = self.conn.take() {
            conn.disconnect_immediately();
        }
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
) -> Result<MySqlSession, String> {
    if config.database_type != DatabaseType::MySql || endpoint.database.is_empty() {
        return Err("unsupported_capability: MySQL 端点无效".into());
    }
    checked(&cancel)?;
    // 独立连接管理器只用于复用现有 SSH/TLS 构造，不注册为用户活动连接。
    let original_config = config.clone();
    config.database = Some(endpoint.database.clone());
    let (_, active) = ConnectionManager::prepare_connection(config.clone())
        .await
        .map_err(|_| DATABASE_ERROR)?;
    let mut conn = match &active.database {
        ActiveDatabaseConnection::MySql(mysql) => mysql
            .adapter
            .pool_clone()
            .get_conn()
            .await
            .map_err(db_error)?,
        _ => return Err(DATABASE_ERROR.into()),
    };
    conn.query_drop("SET NAMES utf8mb4; SET SESSION time_zone='+00:00'; SET SESSION sql_mode='STRICT_ALL_TABLES,NO_AUTO_VALUE_ON_ZERO'; SET SESSION innodb_lock_wait_timeout=10; SET SESSION lock_wait_timeout=10").await.map_err(db_error)?;
    Ok(MySqlSession {
        conn: Some(conn),
        active: Some(active),
        config: original_config,
        actual_database: endpoint.database.clone(),
        database: endpoint.database,
        cancel,
        metadata: None,
        locked: false,
        instance: None,
        cleanup_errors: Vec::new(),
    })
}
pub async fn open(
    config: ConnectionConfig,
    endpoint: DataEndpoint,
    cancel: Cancellation,
) -> Result<Box<dyn DataSession>, String> {
    Ok(Box::new(open_native(config, endpoint, cancel).await?))
}
impl MySqlSession {
    fn connection(&mut self) -> Result<&mut Conn, String> {
        self.conn
            .as_mut()
            .ok_or_else(|| "MySQL 任务会话已关闭，事务结果需核对".into())
    }
    async fn release_locks_after_confirmed_outcome(&mut self) {
        if !self.locked {
            return;
        }
        self.locked = false;
        let released = match self.conn.as_mut() {
            Some(conn) => conn
                .query_drop("UNLOCK TABLES; SET autocommit=1")
                .await
                .is_ok(),
            None => false,
        };
        if !released {
            if let Some(conn) = self.conn.take() {
                conn.disconnect_immediately();
            }
            self.cleanup_errors
                .push("事务结果已确认，但释放 MySQL 会话锁失败；已关闭专属连接".into());
        }
    }
    async fn metadata_inner(&mut self) -> Result<DataMetadataSnapshot, String> {
        checked(&self.cancel)?;
        let database = self.database.clone();
        let config = self.config.clone();
        let conn = self.connection()?;
        // 每类一次集合目录读取。主键、FK、触发器、索引与权限查询次数不随表数变化。
        let facts:Row=conn.query_first("SELECT @@version,@@global.read_only,@@innodb_table_locks,@@lower_case_table_names,@@hostname,@@port,@@server_id,DATABASE()").await.map_err(db_error)?.ok_or(DATABASE_ERROR)?;
        if !server_version_verified(&cell::<String>(&facts, 0)?) {
            return Err(
                "unsupported_capability: 当前仅 MySQL 8.4 与 MariaDB 11.4 原生会话经过真实验收"
                    .into(),
            );
        }
        let instance = format!(
            "mysql:{}:{}:{}",
            cell::<String>(&facts, 4)?,
            cell::<u64>(&facts, 5)?,
            cell::<u64>(&facts, 6)?
        );
        let mut actual_database = cell::<String>(&facts, 7)?;
        if cell::<u8>(&facts, 3)? != 0 {
            actual_database = actual_database.to_lowercase();
        }
        let read_only = cell::<u8>(&facts, 1)? != 0 || config.read_only.unwrap_or(false);
        let locking = cell::<u8>(&facts, 2)? == 1;
        let rows:Vec<Row>=conn.exec("SELECT t.TABLE_NAME,t.TABLE_TYPE,COALESCE(t.ENGINE,''),c.COLUMN_NAME,c.COLUMN_TYPE,c.IS_NULLABLE,c.COLUMN_DEFAULT,c.EXTRA,c.COLLATION_NAME,COALESCE(k.ORDINAL_POSITION,0) FROM information_schema.TABLES t JOIN information_schema.COLUMNS c ON c.TABLE_SCHEMA=t.TABLE_SCHEMA AND c.TABLE_NAME=t.TABLE_NAME LEFT JOIN information_schema.KEY_COLUMN_USAGE k ON k.TABLE_SCHEMA=c.TABLE_SCHEMA AND k.TABLE_NAME=c.TABLE_NAME AND k.COLUMN_NAME=c.COLUMN_NAME AND k.CONSTRAINT_NAME='PRIMARY' WHERE t.TABLE_SCHEMA=? ORDER BY t.TABLE_NAME,c.ORDINAL_POSITION",(database.clone(),)).await.map_err(db_error)?;
        let mut tables: BTreeMap<String, DataTable> = BTreeMap::new();
        for row in rows {
            let name = cell::<String>(&row, 0)?;
            let physical = cell::<String>(&row, 1)? == "BASE TABLE"
                && cell::<String>(&row, 2)?.eq_ignore_ascii_case("InnoDB");
            let table = tables.entry(name.clone()).or_insert(DataTable {
                name,
                create_sql: format!("{}:{}", cell::<String>(&row, 1)?, cell::<String>(&row, 2)?),
                columns: vec![],
                foreign_keys: vec![],
                enabled_user_triggers: false,
                physical,
            });
            let extra = cell::<String>(&row, 7)?;
            let identity = extra.contains("auto_increment");
            let original_type = cell::<String>(&row, 4)?;
            // 整数显示宽度不是数值精度，统一去除，UNSIGNED 保留。
            let base = original_type.split(['(', ' ']).next().unwrap_or("");
            let declared_type = if [
                "tinyint",
                "smallint",
                "mediumint",
                "int",
                "integer",
                "bigint",
            ]
            .contains(&base)
            {
                format!(
                    "{}{}",
                    base.to_ascii_uppercase(),
                    if original_type.contains("unsigned") {
                        " UNSIGNED"
                    } else {
                        ""
                    }
                )
            } else {
                original_type.to_ascii_uppercase()
            };
            table.columns.push(DataColumn {
                name: cell(&row, 3)?,
                declared_type,
                nullable: cell::<String>(&row, 5)? == "YES",
                default_sql: cell(&row, 6)?,
                generated: extra.to_ascii_uppercase().contains("VIRTUAL GENERATED")
                    || extra.to_ascii_uppercase().contains("STORED GENERATED"),
                primary_key_ordinal: cell(&row, 9)?,
                collation: cell(&row, 8)?,
                identity,
                generator_safe: identity && physical,
            });
            table.create_sql.push_str(&format!(
                "\n{}",
                serde_json::to_string(&table.columns.last()).map_err(|_| DATABASE_ERROR)?
            ));
        }
        let rows:Vec<Row>=conn.exec("SELECT k.TABLE_NAME,k.CONSTRAINT_NAME,k.COLUMN_NAME,k.REFERENCED_TABLE_SCHEMA,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME,r.UPDATE_RULE,r.DELETE_RULE,k.TABLE_SCHEMA FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE (k.TABLE_SCHEMA=? OR k.REFERENCED_TABLE_SCHEMA=?) AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_SCHEMA,k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION",(database.clone(),database.clone())).await.map_err(db_error)?;
        let mut foreign: BTreeMap<(String, String), DataForeignKey> = BTreeMap::new();
        for row in rows {
            let child_schema = cell::<String>(&row, 8)?;
            let child_name = cell::<String>(&row, 0)?;
            let name = if child_schema == database {
                child_name
            } else {
                format!("{child_schema}.{child_name}")
            };
            let parent_schema = cell::<String>(&row, 3)?;
            let parent = cell::<String>(&row, 4)?;
            let fk = foreign
                .entry((name, cell(&row, 1)?))
                .or_insert(DataForeignKey {
                    from_columns: vec![],
                    parent_table: if parent_schema == database {
                        parent
                    } else {
                        format!("{parent_schema}.{parent}")
                    },
                    parent_columns: vec![],
                    on_update: cell(&row, 6)?,
                    on_delete: cell(&row, 7)?,
                });
            fk.from_columns.push(cell(&row, 2)?);
            fk.parent_columns.push(cell(&row, 5)?);
        }
        for ((table, _), fk) in foreign {
            tables
                .entry(table.clone())
                .or_insert(DataTable {
                    name: table,
                    create_sql: "external foreign key dependent".into(),
                    columns: vec![],
                    foreign_keys: vec![],
                    enabled_user_triggers: false,
                    physical: false,
                })
                .foreign_keys
                .push(fk);
        }
        let rows:Vec<Row>=conn.exec("SELECT EVENT_OBJECT_TABLE,TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION,ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=? ORDER BY EVENT_OBJECT_TABLE,TRIGGER_NAME",(database.clone(),)).await.map_err(db_error)?;
        for row in rows {
            if let Some(table) = tables.get_mut(&cell::<String>(&row, 0)?) {
                table.enabled_user_triggers = true;
                for index in 1..5 {
                    table
                        .create_sql
                        .push_str(&format!("\ntrigger:{}", cell::<String>(&row, index)?));
                }
            }
        }
        let rows:Vec<Row>=conn.exec("SELECT TABLE_NAME,INDEX_NAME,NON_UNIQUE,SEQ_IN_INDEX,COLUMN_NAME,INDEX_TYPE,SUB_PART,COLLATION FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX",(database.clone(),)).await.map_err(db_error)?;
        for row in rows {
            if let Some(table) = tables.get_mut(&cell::<String>(&row, 0)?) {
                table.create_sql.push_str(&format!(
                    "\nindex:{}:{}:{}:{:?}:{}:{:?}:{:?}",
                    cell::<String>(&row, 1)?,
                    cell::<u64>(&row, 2)?,
                    cell::<u64>(&row, 3)?,
                    cell::<Option<String>>(&row, 4)?,
                    cell::<String>(&row, 5)?,
                    cell::<Option<u64>>(&row, 6)?,
                    cell::<Option<String>>(&row, 7)?
                ));
            }
        }
        let grants: Vec<Row> = conn
            .query("SHOW GRANTS FOR CURRENT_USER()")
            .await
            .map_err(db_error)?;
        let permissions = verify_grants(
            &grants
                .iter()
                .filter_map(|row| row.get::<String, _>(0))
                .collect::<Vec<_>>(),
            &database,
            config.read_only.unwrap_or(false),
        );
        let tables = tables.into_values().collect::<Vec<_>>();
        let schema_fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&tables).map_err(|_| DATABASE_ERROR)?)
        );
        let metadata = DataMetadataSnapshot {
            database_type: DatabaseType::MySql,
            tables,
            read_only,
            permissions_verified: permissions,
            consistent_snapshot: true,
            protected_write: locking,
            schema_fingerprint,
            configuration_fingerprint: crate::db::data_tasks::executor::configuration_fingerprint(
                &config,
            ),
        };
        self.instance = Some(instance);
        self.actual_database = actual_database;
        self.metadata = Some(metadata.clone());
        Ok(metadata)
    }
}
impl DataSession for MySqlSession {
    fn take_cleanup_errors(&mut self) -> Vec<String> {
        std::mem::take(&mut self.cleanup_errors)
    }
    fn endpoint_identity(&self) -> Option<crate::db::data_tasks::metadata::EndpointIdentity> {
        Some(crate::db::data_tasks::metadata::EndpointIdentity {
            database_type: DatabaseType::MySql,
            instance: self.instance.clone(),
            database: self.actual_database.clone(),
            sqlite_path: None,
        })
    }
    fn dialect(&self) -> Dialect {
        Dialect::MySql
    }
    fn begin_read(&mut self) -> SessionFuture<'_, ()> {
        Box::pin(async move {
            checked(&self.cancel)?;
            self.connection()?.query_drop("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY").await.map_err(db_error)
        })
    }
    fn begin_protected_write(&mut self, tables: Vec<String>) -> SessionFuture<'_, ()> {
        Box::pin(async move {
            checked(&self.cancel)?;
            if self.config.read_only.unwrap_or(false) {
                return Err("read_only_target: 目标保存连接为只读".into());
            }
            let sql = protected_write_sql(&self.database, &tables)?;
            self.connection()?.query_drop(sql).await.map_err(db_error)?;
            self.locked = true;
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
            let sql = snapshot_sql(
                &self.database,
                &projections,
                self.metadata.as_ref().ok_or("必须先批量读取元数据")?,
            )?;
            let mut conn = self.conn.take().ok_or(DATABASE_ERROR)?;
            let outcome=async {
                let mut stream=tokio::select! {
                    result=conn.query_iter(sql)=>result.map_err(db_error)?,
                    _=wait_cancel(&cancel)=>return Err("cancelled: 数据任务已取消，正在关闭专属会话".to_string()),
                };
                let mut count=0u64;
                loop {
                    let row=tokio::select! { result=stream.next()=>result.map_err(db_error)?, _=wait_cancel(&cancel)=>return Err("cancelled: 数据任务已取消，正在关闭专属会话".to_string()) };
                    let Some(row)=row else { break; };
                    checked(&cancel)?;
                    let index=cell::<u64>(&row,0)? as usize;
                    let projection=projections.get(index).ok_or("MySQL 集合表序号无效")?;
                    let payload=cell::<String>(&row,1)?;
                    drop(row);
                    if payload.len()>32*1024*1024 { return Err("resource_limit: MySQL 行载荷超过上限".into()); }
                    let decode_lease=sender.reserve_decode(payload.len().saturating_mul(3)).await?;
                    let row=decode_payload(&projection.output_table,&projection.key_indices,&payload)?;
                    drop(payload);
                    drop(decode_lease);
                    tokio::select! { result=sender.send(row)=>result?, _=wait_cancel(&cancel)=>return Err("cancelled: 数据任务已取消".into()) };
                    count+=1;
                }
                stream.drop_result().await.map_err(db_error)?;
                Ok(count)
            }.await;
            if cancel.load(Ordering::Acquire) {
                conn.disconnect_immediately();
            } else {
                self.conn = Some(conn);
            }
            outcome
        })
    }
    fn write_batch(&mut self, batch: WriteBatch) -> SessionFuture<'_, u64> {
        Box::pin(async move {
            checked(&self.cancel)?;
            let params = batch
                .params
                .into_iter()
                .map(bind_value)
                .collect::<Result<Vec<_>, _>>()?;
            let conn = self.connection()?;
            conn.exec_drop(batch.sql, Params::Positional(params))
                .await
                .map_err(db_error)?;
            Ok(conn.affected_rows())
        })
    }
    fn delete_all(&mut self, table: String) -> SessionFuture<'_, u64> {
        Box::pin(async move {
            checked(&self.cancel)?;
            let sql = format!("DELETE FROM {}.{}", id(&self.database), id(&table));
            let conn = self.connection()?;
            conn.query_drop(sql).await.map_err(db_error)?;
            Ok(conn.affected_rows())
        })
    }
    fn maintain_generators(
        &mut self,
        mapping: Vec<ValidatedTableMapping>,
    ) -> SessionFuture<'_, ()> {
        Box::pin(async move {
            checked(&self.cancel)?;
            let metadata = self.metadata.as_ref().ok_or("缺少 MySQL 元数据")?;
            for table in mapping {
                let table = metadata
                    .tables
                    .iter()
                    .find(|t| t.name == table.target_table)
                    .ok_or("目标表不存在")?;
                if table
                    .columns
                    .iter()
                    .any(|c| c.identity && !c.generator_safe)
                {
                    return Err("unsupported_capability: 自增生成器不安全".into());
                }
            } // InnoDB 显式插入自动单调推进自身 AUTO_INCREMENT，不能 ALTER TABLE（会隐式提交）。
            Ok(())
        })
    }
    fn commit(&mut self) -> SessionFuture<'_, ()> {
        Box::pin(async move {
            self.connection()?
                .query_drop("COMMIT")
                .await
                .map_err(db_error)?;
            self.release_locks_after_confirmed_outcome().await;
            Ok(())
        })
    }
    fn rollback(&mut self) -> SessionFuture<'_, ()> {
        Box::pin(async move {
            self.connection()?
                .query_drop("ROLLBACK")
                .await
                .map_err(db_error)?;
            self.release_locks_after_confirmed_outcome().await;
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshot_preserves_native_unsigned_decimal_binary_and_temporal_values() {
        let row = decode_payload("t", &[0], r#"[{"t":"uint","v":"18446744073709551615"},{"t":"decimal","v":"12345678901234567890.123456789"},{"t":"binary","v":"00FF"},{"t":"datetime","v":"2026-10-19 12:34:56.123456"},{"t":"null","v":null}]"#).unwrap();
        assert_eq!(row.values[0], DataValue::UInt(u64::MAX));
        assert_eq!(
            row.values[1],
            DataValue::Decimal("12345678901234567890.123456789".into())
        );
        assert_eq!(row.values[2], DataValue::Binary(vec![0, 255]));
        assert_eq!(
            row.values[3],
            DataValue::Temporal {
                kind: "datetime".into(),
                value: "2026-10-19 12:34:56.123456".into()
            }
        );
        assert_eq!(row.values[4], DataValue::Null);
    }
    #[test]
    fn malformed_or_lossy_payloads_are_rejected() {
        assert!(decode_payload("t", &[], r#"[{"t":"uint","v":9007199254740993}]"#).is_err());
        assert!(decode_payload("t", &[], r#"[{"t":"binary","v":"GG"}]"#).is_err());
        assert!(decode_payload("t", &[], r#"[{"t":"float","v":"NaN"}]"#).is_err());
    }
    #[test]
    fn protected_write_never_starts_transaction_after_table_locks() {
        let sql = protected_write_sql("odd`db", &["one".into(), "two".into()]).unwrap();
        assert!(sql.contains("SET autocommit=0"));
        assert!(sql.contains("LOCK TABLES `odd``db`.`one` WRITE,`odd``db`.`two` WRITE"));
        assert!(!sql.contains("START TRANSACTION"));
        assert!(!sql.contains("SELECT"));
    }
    #[test]
    fn only_verified_server_versions_are_accepted() {
        assert!(server_version_verified("8.4.8"));
        assert!(server_version_verified("11.4.10-MariaDB-ubu2404"));
        assert!(!server_version_verified("8.0.42"));
        assert!(!server_version_verified("11.8.1-MariaDB"));
        assert!(!server_version_verified("8.4.0-unverified-fork"));
    }
    #[test]
    fn schema_grants_are_verified_without_accepting_table_only_or_wrong_scope() {
        assert!(verify_grants(&["GRANT SELECT, INSERT, UPDATE, DELETE, LOCK TABLES, TRIGGER, REFERENCES ON *.* TO `root`@`localhost`".into()], "db", false));
        assert!(verify_grants(
            &["GRANT SELECT ON `db`.* TO `reader`@`%`".into()],
            "db",
            true
        ));
        assert!(!verify_grants(
            &["GRANT SELECT ON `db`.* TO `reader`@`%`".into()],
            "db",
            false
        ));
        assert!(!verify_grants(
            &["GRANT ALL PRIVILEGES ON `other`.* TO `writer`@`%`".into()],
            "db",
            false
        ));
        assert!(!verify_grants(
            &["GRANT ALL PRIVILEGES ON `db`.`table` TO `writer`@`%`".into()],
            "db",
            false
        ));
    }
    async fn fixture(env: &str) -> (Conn, ConnectionConfig, DataEndpoint) {
        let url = std::env::var(env).expect("必须显式配置本任务专属 MySQL/MariaDB 测试容器 URL");
        let opts = mysql_async::Opts::from_url(&url).expect("隔离测试 URL 无效");
        assert!(matches!(opts.ip_or_hostname(), "127.0.0.1" | "localhost"));
        assert_ne!(opts.tcp_port(), 3306, "只允许独占容器随机端口");
        let database = format!("data_task_fixture_{}", uuid::Uuid::new_v4().simple());
        let mut observer = Conn::new(opts.clone()).await.expect("无法连接专属夹具");
        observer
            .query_drop(format!(
                "CREATE DATABASE {} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
                id(&database)
            ))
            .await
            .unwrap();
        let config:ConnectionConfig=serde_json::from_value(serde_json::json!({"id":"fixture","database_type":"mysql","name":"数据任务隔离测试","host":opts.ip_or_hostname(),"port":opts.tcp_port(),"username":opts.user().unwrap_or("root"),"password":opts.pass(),"ssh":null,"database":null})).unwrap();
        let endpoint = DataEndpoint {
            saved_connection_id: "fixture".into(),
            database,
        };
        (observer, config, endpoint)
    }
    async fn collect(
        session: &mut dyn DataSession,
        projections: Vec<Projection>,
        cancel: Cancellation,
    ) -> Result<Vec<CanonicalRow>, String> {
        let (tx, mut rx) =
            RowSender::channel(crate::db::data_tasks::spool::ResourceBudget::default());
        let reader = tokio::spawn(async move {
            let mut rows = Vec::new();
            while let Some(row) = rx.recv().await {
                rows.push(row.row);
            }
            rows
        });
        session.stream_rows(projections, cancel, tx).await?;
        Ok(reader.await.unwrap())
    }
    fn projection(table: &str, columns: &[&str], key: Vec<usize>) -> Projection {
        Projection {
            table: table.into(),
            output_table: table.into(),
            columns: columns.iter().map(|s| (*s).into()).collect(),
            key_indices: key,
        }
    }
    async fn real_contract(env: &str) {
        use std::sync::{atomic::AtomicBool, Arc};
        let (mut observer, config, endpoint) = fixture(env).await;
        let db = id(&endpoint.database);
        observer.query_drop(format!("CREATE TABLE {db}.exact_values(id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT,n DECIMAL(65,20) NULL,b VARBINARY(100),ts DATETIME(6),s VARCHAR(100)) ENGINE=InnoDB; CREATE TABLE {db}.heterogeneous(v TEXT) ENGINE=InnoDB; CREATE TABLE {db}.unsafe_engine(id INT) ENGINE=MyISAM; INSERT INTO {db}.exact_values VALUES(9007199254740993,123456789012345678901234567890.12345678901234567890,x'00ff','2026-10-20 12:34:56.123456','中文'); INSERT INTO {db}.heterogeneous VALUES(''),(NULL)" )).await.unwrap();
        observer.query_drop(format!("CREATE TABLE {db}.defaults(id INT PRIMARY KEY,n INT DEFAULT 1,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,g INT GENERATED ALWAYS AS(n+1) STORED) ENGINE=InnoDB; CREATE TRIGGER {db}.default_trigger BEFORE UPDATE ON {db}.defaults FOR EACH ROW SET NEW.n=NEW.n")).await.unwrap();
        observer.query_drop(format!("CREATE TABLE {db}.limit_values(id BIGINT UNSIGNED PRIMARY KEY,v BIGINT UNSIGNED) ENGINE=InnoDB; CREATE TABLE {db}.limit_values_copy LIKE {db}.limit_values; INSERT INTO {db}.limit_values VALUES(18446744073709551615,18446744073709551615)")).await.unwrap();
        let catalog_sql=(0..100).map(|i|format!("CREATE TABLE {db}.catalog_{i}(id INT PRIMARY KEY,v VARCHAR(40)) ENGINE=InnoDB;")).collect::<String>();
        observer.query_drop(catalog_sql).await.unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let mut source = open_native(config.clone(), endpoint.clone(), cancel.clone())
            .await
            .unwrap();
        source.begin_read().await.unwrap();
        let before_meta: Row = source
            .connection()
            .unwrap()
            .query_first("SHOW SESSION STATUS LIKE 'Com_select'")
            .await
            .unwrap()
            .unwrap();
        let before_meta: u64 = cell::<String>(&before_meta, 1).unwrap().parse().unwrap();
        let meta = source.load_metadata().await.unwrap();
        let after_meta: Row = source
            .connection()
            .unwrap()
            .query_first("SHOW SESSION STATUS LIKE 'Com_select'")
            .await
            .unwrap()
            .unwrap();
        let after_meta: u64 = cell::<String>(&after_meta, 1).unwrap().parse().unwrap();
        assert_eq!(
            after_meta - before_meta,
            5,
            "100 表元数据必须保持固定 5 次 SELECT 加一次 SHOW GRANTS"
        );
        let defaults = meta.tables.iter().find(|t| t.name == "defaults").unwrap();
        assert!(
            !defaults
                .columns
                .iter()
                .find(|c| c.name == "created_at")
                .unwrap()
                .generated,
            "DEFAULT_GENERATED 是普通默认值，不能误判为计算列"
        );
        assert!(
            defaults
                .columns
                .iter()
                .find(|c| c.name == "g")
                .unwrap()
                .generated
        );
        assert!(defaults.enabled_user_triggers);

        assert!(meta.permissions_verified && meta.consistent_snapshot && meta.protected_write);
        assert!(
            !meta
                .tables
                .iter()
                .find(|t| t.name == "unsafe_engine")
                .unwrap()
                .physical
        );
        assert!(source.endpoint_identity().unwrap().instance.is_some());
        let baseline = source
            .connection()
            .unwrap()
            .query_first::<Row, _>("SHOW SESSION STATUS LIKE 'Com_select'")
            .await
            .unwrap()
            .unwrap();
        let before: u64 = cell::<String>(&baseline, 1).unwrap().parse().unwrap();
        let rows = collect(
            &mut source,
            vec![
                projection("exact_values", &["id", "n", "b", "ts", "s"], vec![0]),
                projection("heterogeneous", &["v"], vec![]),
                projection("limit_values", &["id", "v"], vec![0]),
            ],
            cancel.clone(),
        )
        .await
        .unwrap();
        let after = source
            .connection()
            .unwrap()
            .query_first::<Row, _>("SHOW SESSION STATUS LIKE 'Com_select'")
            .await
            .unwrap()
            .unwrap();
        let after: u64 = cell::<String>(&after, 1).unwrap().parse().unwrap();
        assert_eq!(after - before, 1, "异形多表必须只发起一次 SELECT");
        assert_eq!(rows.len(), 4);
        let maximum = rows.iter().find(|row| row.table == "limit_values").unwrap();
        assert_eq!(
            maximum.values,
            vec![DataValue::UInt(u64::MAX), DataValue::UInt(u64::MAX)]
        );
        let value = rows.iter().find(|row| row.table == "exact_values").unwrap();
        assert_eq!(value.values[0], DataValue::UInt(9007199254740993));
        assert_eq!(
            value.values[1],
            DataValue::Decimal("123456789012345678901234567890.1234567890123456789".into())
        );
        assert_eq!(value.values[2], DataValue::Binary(vec![0, 255]));
        assert_eq!(
            value.values[3],
            DataValue::Temporal {
                kind: "datetime".into(),
                value: "2026-10-20 12:34:56.123456".into()
            }
        );
        assert!(rows.iter().any(|row| row.values == vec![DataValue::Null]));
        assert!(rows
            .iter()
            .any(|row| row.values == vec![DataValue::Text("".into())]));
        observer
            .query_drop(format!("INSERT INTO {db}.heterogeneous VALUES('快照之后')"))
            .await
            .unwrap();
        let again = collect(
            &mut source,
            vec![
                projection("exact_values", &["id", "n", "b", "ts", "s"], vec![0]),
                projection("heterogeneous", &["v"], vec![]),
                projection("limit_values", &["id", "v"], vec![0]),
            ],
            cancel.clone(),
        )
        .await
        .unwrap();
        assert_eq!(rows, again, "同一读取事务不应看到快照之后的并发写入");
        source.rollback().await.unwrap();
        let mut target = open_native(config.clone(), endpoint.clone(), cancel.clone())
            .await
            .unwrap();
        target
            .begin_protected_write(vec![
                "exact_values".into(),
                "heterogeneous".into(),
                "limit_values_copy".into(),
            ])
            .await
            .unwrap();
        target.load_metadata().await.unwrap();
        let columns = vec!["id".into(), "n".into(), "b".into(), "ts".into(), "s".into()];
        let mut added = value.values.clone();
        added[0] = DataValue::UInt(9007199254741000);
        let batch = super::super::batch::build_batch(
            Dialect::MySql,
            &endpoint.database,
            "exact_values",
            &columns,
            &[0],
            crate::models::data_tasks::DataDiffOperation::Insert,
            &[added],
        )
        .unwrap();
        assert_eq!(target.write_batch(batch).await.unwrap(), 1);
        let maximum_batch = super::super::batch::build_batch(
            Dialect::MySql,
            &endpoint.database,
            "limit_values_copy",
            &["id".into(), "v".into()],
            &[0],
            crate::models::data_tasks::DataDiffOperation::Insert,
            std::slice::from_ref(&maximum.values),
        )
        .unwrap();
        assert_eq!(target.write_batch(maximum_batch).await.unwrap(), 1);
        let mut zero = value.values.clone();
        zero[0] = DataValue::UInt(0);
        let zero_batch = super::super::batch::build_batch(
            Dialect::MySql,
            &endpoint.database,
            "exact_values",
            &columns,
            &[0],
            crate::models::data_tasks::DataDiffOperation::Insert,
            &[zero],
        )
        .unwrap();
        assert_eq!(target.write_batch(zero_batch).await.unwrap(), 1);
        let roundtrip = collect(
            &mut target,
            vec![
                projection("exact_values", &["id", "n", "b", "ts", "s"], vec![0]),
                projection("limit_values_copy", &["id", "v"], vec![0]),
            ],
            cancel.clone(),
        )
        .await
        .unwrap();
        assert!(roundtrip
            .iter()
            .any(|row| row.table == "limit_values_copy" && row.values == maximum.values));
        assert!(
            roundtrip
                .iter()
                .any(|row| row.table == "exact_values" && row.values[0] == DataValue::UInt(0)),
            "显式零自增键不可被重新编号"
        );
        let duplicate = super::super::batch::build_batch(
            Dialect::MySql,
            &endpoint.database,
            "exact_values",
            &columns,
            &[0],
            crate::models::data_tasks::DataDiffOperation::Insert,
            std::slice::from_ref(&value.values),
        )
        .unwrap();
        assert!(
            target.write_batch(duplicate).await.is_err(),
            "唯一约束冲突应失败，不能隐式覆盖"
        );
        target.rollback().await.unwrap();
        let count: u64 = observer
            .query_first(format!("SELECT COUNT(*) FROM {db}.exact_values"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(count, 1, "ROLLBACK 不得被 LOCK TABLES 隐式提交破坏");
        target
            .begin_protected_write(vec!["exact_values".into()])
            .await
            .unwrap();
        let mut waiter = open_native(config.clone(), endpoint.clone(), cancel.clone())
            .await
            .unwrap();
        let wait_start = std::time::Instant::now();
        let timed = tokio::time::timeout(
            Duration::from_secs(12),
            waiter.begin_protected_write(vec!["exact_values".into()]),
        )
        .await
        .expect("MySQL 目标锁必须在预算内超时");
        assert!(timed.is_err());
        assert!(wait_start.elapsed() < Duration::from_secs(12));
        drop(waiter);
        let mut alteration_connection = Conn::new(
            mysql_async::OptsBuilder::default()
                .ip_or_hostname(config.host.clone())
                .tcp_port(config.port)
                .user(Some(config.username.clone()))
                .pass(config.password.clone()),
        )
        .await
        .unwrap();
        let alter_sql =
            format!("ALTER TABLE {db}.exact_values ADD COLUMN added_after_lock INT NULL");
        let alteration = tokio::spawn(async move {
            alteration_connection.query_drop(alter_sql).await.unwrap();
            alteration_connection.disconnect().await.unwrap();
        });
        let attempted = mysql_async::Conn::new(
            mysql_async::OptsBuilder::default()
                .ip_or_hostname(config.host.clone())
                .tcp_port(config.port)
                .user(Some(config.username.clone()))
                .pass(config.password.clone()),
        )
        .await
        .unwrap();
        let sql = format!("INSERT INTO {db}.exact_values(n) VALUES(2)");
        let blocked = tokio::spawn(async move {
            let mut connection = attempted;
            connection.query_drop(sql).await.unwrap();
            connection.last_insert_id().unwrap()
        });
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!blocked.is_finished(), "目标范围内并发插入必须被阻塞");
        assert!(
            !alteration.is_finished(),
            "目标结构变化必须等受保护事务结束"
        );
        target.commit().await.unwrap();
        tokio::time::timeout(Duration::from_secs(5), alteration)
            .await
            .unwrap()
            .unwrap();
        let generated = tokio::time::timeout(Duration::from_secs(5), blocked)
            .await
            .unwrap()
            .unwrap();
        assert!(
            generated > 9007199254741000,
            "回滚后生成器不能回退到已消费高水位之前"
        );
        let mut readonly = config.clone();
        readonly.read_only = Some(true);
        let mut readonly = open_native(readonly, endpoint.clone(), cancel.clone())
            .await
            .unwrap();
        assert!(readonly
            .begin_protected_write(vec!["exact_values".into()])
            .await
            .unwrap_err()
            .contains("read_only_target"));
        let user = format!("dt_{}", &uuid::Uuid::new_v4().simple().to_string()[..16]);
        observer
            .query_drop(format!(
                "CREATE USER '{user}'@'%' IDENTIFIED BY ''; GRANT SELECT ON {db}.* TO '{user}'@'%'"
            ))
            .await
            .unwrap();
        let mut reader_config = config.clone();
        reader_config.username = user.clone();
        reader_config.password = None;
        reader_config.read_only = Some(true);
        let mut reader = open_native(reader_config.clone(), endpoint.clone(), cancel.clone())
            .await
            .unwrap();
        reader.begin_read().await.unwrap();
        assert!(reader.load_metadata().await.unwrap().permissions_verified);
        reader.rollback().await.unwrap();
        drop(reader);
        reader_config.read_only = Some(false);
        let mut unsafe_writer = open_native(reader_config, endpoint.clone(), cancel.clone())
            .await
            .unwrap();
        assert!(
            !unsafe_writer
                .load_metadata()
                .await
                .unwrap()
                .permissions_verified,
            "SELECT-only 账号不得通过目标完整权限预检"
        );
        drop(unsafe_writer);
        observer
            .query_drop(format!("DROP USER '{user}'@'%'"))
            .await
            .unwrap();
        observer
            .query_drop("SET GLOBAL read_only=ON")
            .await
            .unwrap();
        let instance_readonly = target.load_metadata().await;
        observer
            .query_drop("SET GLOBAL read_only=OFF")
            .await
            .unwrap();
        assert!(
            instance_readonly.unwrap().read_only,
            "实例只读状态必须参与预检"
        );
        let external_database = format!("{}_external", endpoint.database);
        observer.query_drop(format!("CREATE DATABASE {}; CREATE TABLE {}.child(id INT PRIMARY KEY,parent BIGINT UNSIGNED,FOREIGN KEY(parent) REFERENCES {db}.exact_values(id)) ENGINE=InnoDB",id(&external_database),id(&external_database))).await.unwrap();
        let external_meta = target.load_metadata().await.unwrap();
        assert!(
            external_meta.tables.iter().any(|table| table.name
                == format!("{external_database}.child")
                && table
                    .foreign_keys
                    .iter()
                    .any(|fk| fk.parent_table == "exact_values")),
            "其它数据库的入向外键不能从预检中消失"
        );
        observer
            .query_drop(format!("DROP DATABASE {}", id(&external_database)))
            .await
            .unwrap();
        cancel.store(true, Ordering::Release);
        assert!(target.begin_read().await.is_err());
        drop(readonly);
        drop(target);
        drop(source);
        observer
            .query_drop(format!("DROP DATABASE {db}"))
            .await
            .unwrap();
        observer.disconnect().await.unwrap();
    }
    async fn real_engine_contract(env: &str) {
        use crate::db::data_tasks::{executor, ProgressCallback};
        use crate::models::data_tasks::{
            ColumnMapping, DataCommitState, DataTaskKind, DataTaskMode, DataTaskRequest,
            DataTaskStatus, TableMapping,
        };
        use std::sync::{atomic::AtomicBool, Arc};
        let (mut observer, source_config, source_endpoint) = fixture(env).await;
        let (target_observer, target_config, target_endpoint) = fixture(env).await;
        let source = id(&source_endpoint.database);
        let target = id(&target_endpoint.database);
        observer.query_drop(format!("CREATE TABLE {source}.sync_rows(id BIGINT PRIMARY KEY AUTO_INCREMENT,v VARCHAR(80),amount DECIMAL(30,10),b VARBINARY(8),ts TIMESTAMP(6)) ENGINE=InnoDB; CREATE TABLE {target}.sync_rows LIKE {source}.sync_rows; CREATE TABLE {source}.no_key(v TEXT) ENGINE=InnoDB; CREATE TABLE {target}.no_key(v TEXT) ENGINE=InnoDB; INSERT INTO {source}.sync_rows VALUES(1,'A',12345678901234567890.1234567890,x'00ff','2026-10-20 12:34:56.123456'),(2,'B',NULL,NULL,NULL); INSERT INTO {target}.sync_rows VALUES(2,'old',NULL,NULL,NULL),(3,'C',NULL,NULL,NULL); INSERT INTO {source}.no_key VALUES(NULL),(''),('中文')")).await.unwrap();
        let request = DataTaskRequest {
            protocol_version: 1,
            kind: DataTaskKind::RowSync,
            source: source_endpoint.clone(),
            target: target_endpoint.clone(),
            mappings: vec![TableMapping {
                source_table: "sync_rows".into(),
                target_table: "sync_rows".into(),
                columns: ["id", "v", "amount", "b", "ts"]
                    .iter()
                    .map(|column| ColumnMapping {
                        source_column: (*column).into(),
                        target_column: (*column).into(),
                    })
                    .collect(),
            }],
            mode: DataTaskMode::Merge,
        };
        let directory = std::env::temp_dir().join(format!(
            "db-connect-data-task-mysql-e2e-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir(&directory).unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        let callback: ProgressCallback = Arc::new(|_| {});
        let merged = executor::prepare_task(
            "mysql-merge".into(),
            request.clone(),
            source_config.clone(),
            target_config.clone(),
            directory.clone(),
            cancel.clone(),
            callback.clone(),
        )
        .await
        .expect("MySQL 合并预览失败");
        assert_eq!(merged.preview.tables[0].counts.inserted, "1");
        assert_eq!(merged.preview.tables[0].counts.updated, "1");
        assert_eq!(merged.preview.tables[0].counts.retained, "1");
        assert_eq!(merged.preview.tables[0].counts.deleted, "0");
        observer
            .query_drop(format!(
                "UPDATE {source}.sync_rows SET v='source-after-preview' WHERE id=1"
            ))
            .await
            .unwrap();
        let result = executor::execute_plan(
            Arc::new(merged),
            source_config.clone(),
            target_config.clone(),
            cancel.clone(),
            callback.clone(),
        )
        .await;
        assert_eq!(
            result.status,
            DataTaskStatus::Succeeded,
            "合并执行失败：{:?}",
            result.error
        );
        assert_eq!(result.commit_state, DataCommitState::Committed);
        let merged: Vec<(u64, String)> = observer
            .query(format!("SELECT id,v FROM {target}.sync_rows ORDER BY id"))
            .await
            .unwrap();
        assert_eq!(
            merged,
            vec![(1, "A".into()), (2, "B".into()), (3, "C".into())],
            "必须应用预览冻结源数据并保留目标独有行"
        );
        let stale = executor::prepare_task(
            "mysql-stale".into(),
            request.clone(),
            source_config.clone(),
            target_config.clone(),
            directory.clone(),
            cancel.clone(),
            callback.clone(),
        )
        .await
        .unwrap();
        observer
            .query_drop(format!(
                "UPDATE {target}.sync_rows SET v='external-change' WHERE id=2"
            ))
            .await
            .unwrap();
        let result = executor::execute_plan(
            Arc::new(stale),
            source_config.clone(),
            target_config.clone(),
            cancel.clone(),
            callback.clone(),
        )
        .await;
        assert_eq!(result.status, DataTaskStatus::Failed);
        assert_eq!(result.error.unwrap().code, "plan_stale");
        let still_external: String = observer
            .query_first(format!("SELECT v FROM {target}.sync_rows WHERE id=2"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(still_external, "external-change");
        let mut mirror_request = request.clone();
        mirror_request.mode = DataTaskMode::Mirror;
        let mirrored = executor::prepare_task(
            "mysql-mirror".into(),
            mirror_request,
            source_config.clone(),
            target_config.clone(),
            directory.clone(),
            cancel.clone(),
            callback.clone(),
        )
        .await
        .unwrap();
        assert_eq!(mirrored.preview.tables[0].counts.deleted, "1");
        let result = executor::execute_plan(
            Arc::new(mirrored),
            source_config.clone(),
            target_config.clone(),
            cancel.clone(),
            callback.clone(),
        )
        .await;
        assert_eq!(
            result.status,
            DataTaskStatus::Succeeded,
            "镜像执行失败：{:?}",
            result.error
        );
        let mirrored: Vec<(u64, String)> = observer
            .query(format!("SELECT id,v FROM {target}.sync_rows ORDER BY id"))
            .await
            .unwrap();
        assert_eq!(
            mirrored,
            vec![(1, "source-after-preview".into()), (2, "B".into())]
        );
        let mut append_request = request.clone();
        append_request.kind = DataTaskKind::Transfer;
        append_request.mode = DataTaskMode::Append;
        append_request.mappings = vec![TableMapping {
            source_table: "no_key".into(),
            target_table: "no_key".into(),
            columns: vec![ColumnMapping {
                source_column: "v".into(),
                target_column: "v".into(),
            }],
        }];
        let appended = executor::prepare_task(
            "mysql-append".into(),
            append_request.clone(),
            source_config.clone(),
            target_config.clone(),
            directory.clone(),
            cancel.clone(),
            callback.clone(),
        )
        .await
        .unwrap();
        assert_eq!(appended.preview.tables[0].counts.source_rows, "3");
        let result = executor::execute_plan(
            Arc::new(appended),
            source_config.clone(),
            target_config.clone(),
            cancel.clone(),
            callback.clone(),
        )
        .await;
        assert_eq!(
            result.status,
            DataTaskStatus::Succeeded,
            "无主键追加失败：{:?}",
            result.error
        );
        let append_count: u64 = observer
            .query_first(format!("SELECT COUNT(*) FROM {target}.no_key"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(append_count, 3);
        observer
            .query_drop(format!("INSERT INTO {target}.no_key VALUES('old-target')"))
            .await
            .unwrap();
        let mut replace_request = append_request.clone();
        replace_request.mode = DataTaskMode::Replace;
        let replaced = executor::prepare_task(
            "mysql-replace".into(),
            replace_request.clone(),
            source_config.clone(),
            target_config.clone(),
            directory.clone(),
            cancel.clone(),
            callback.clone(),
        )
        .await
        .unwrap();
        let result = executor::execute_plan(
            Arc::new(replaced),
            source_config.clone(),
            target_config.clone(),
            cancel.clone(),
            callback.clone(),
        )
        .await;
        assert_eq!(
            result.status,
            DataTaskStatus::Succeeded,
            "替换失败：{:?}",
            result.error
        );
        let replacement: Vec<Option<String>> = observer
            .query(format!("SELECT v FROM {target}.no_key ORDER BY v"))
            .await
            .unwrap();
        assert_eq!(
            replacement,
            vec![None, Some("".into()), Some("中文".into())]
        );
        let cancelled = executor::prepare_task(
            "mysql-cancel".into(),
            replace_request,
            source_config.clone(),
            target_config.clone(),
            directory.clone(),
            cancel.clone(),
            callback.clone(),
        )
        .await
        .unwrap();
        let cancellation = cancel.clone();
        let on_verify: ProgressCallback = Arc::new(move |progress| {
            if progress.status == DataTaskStatus::Verifying {
                cancellation.store(true, Ordering::Release);
            }
        });
        let result = executor::execute_plan(
            Arc::new(cancelled),
            source_config.clone(),
            target_config.clone(),
            cancel.clone(),
            on_verify,
        )
        .await;
        assert_eq!(result.status, DataTaskStatus::Cancelled);
        assert_eq!(
            result.commit_state,
            DataCommitState::RolledBack,
            "取消必须等待真实回滚"
        );
        let after_cancel: Vec<Option<String>> = observer
            .query(format!("SELECT v FROM {target}.no_key ORDER BY v"))
            .await
            .unwrap();
        assert_eq!(after_cancel, replacement);
        cancel.store(false, Ordering::Release);
        let mut conflict_request = request;
        conflict_request.kind = DataTaskKind::Transfer;
        conflict_request.mode = DataTaskMode::Append;
        let conflicted = executor::prepare_task(
            "mysql-conflict".into(),
            conflict_request,
            source_config.clone(),
            target_config.clone(),
            directory.clone(),
            cancel.clone(),
            callback.clone(),
        )
        .await
        .unwrap();
        let result = executor::execute_plan(
            Arc::new(conflicted),
            source_config,
            target_config,
            cancel,
            callback,
        )
        .await;
        assert_eq!(result.status, DataTaskStatus::Failed);
        assert_eq!(
            result.commit_state,
            DataCommitState::RolledBack,
            "唯一冲突必须回滚整个任务"
        );
        let unchanged: Vec<(u64, String)> = observer
            .query(format!("SELECT id,v FROM {target}.sync_rows ORDER BY id"))
            .await
            .unwrap();
        assert_eq!(unchanged, mirrored);
        observer
            .query_drop(format!("DROP DATABASE {target}; DROP DATABASE {source}"))
            .await
            .unwrap();
        observer.disconnect().await.unwrap();
        target_observer.disconnect().await.unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[tokio::test]
    #[ignore = "需要显式配置 DB_CONNECT_DATA_TASK_MYSQL_URL 的专属 MySQL 8.4 容器"]
    async fn real_mysql_session_contract() {
        real_contract("DB_CONNECT_DATA_TASK_MYSQL_URL").await;
        real_engine_contract("DB_CONNECT_DATA_TASK_MYSQL_URL").await;
    }
    #[tokio::test]
    #[ignore = "需要显式配置 DB_CONNECT_DATA_TASK_MARIADB_URL 的专属 MariaDB 11.4 容器"]
    async fn real_mariadb_session_contract() {
        real_contract("DB_CONNECT_DATA_TASK_MARIADB_URL").await;
        real_engine_contract("DB_CONNECT_DATA_TASK_MARIADB_URL").await;
    }
}
