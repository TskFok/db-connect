//! SQL Server 专属物理会话：固定目录查询、单集合流与受保护事务。
use super::{
    batch::{Dialect, WriteBatch},
    sqlite::Projection,
    DataSession, RowSender, SessionFuture,
};
use crate::{
    db::{
        data_tasks::{
            metadata::{
                DataColumn, DataForeignKey, DataMetadataSnapshot, DataTable, EndpointIdentity,
                ValidatedTableMapping,
            },
            value::{normalize_decimal, CanonicalRow, DataValue},
            Cancellation,
        },
        sqlserver::build_tiberius_config,
        ssh_tunnel::SshTunnel,
    },
    models::{
        data_tasks::{DataDiffOperation, DataEndpoint},
        types::{ConnectionConfig, DatabaseType},
    },
};
use bb8::ManageConnection;
use bb8_tiberius::{rt::Client, ConnectionManager};
use futures_util::TryStreamExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{borrow::Cow, collections::BTreeMap, sync::atomic::Ordering, time::Duration};
use tiberius::{Query, Row};
const DB_ERROR: &str = "SQL Server 数据任务失败，请检查连接、隔离配置、权限及目标约束";
fn db_error(error: tiberius::error::Error) -> String {
    match error.code() {
        Some(2601 | 2627 | 547 | 515) => {
            "constraint_conflict: SQL Server 目标约束不允许本次写入".into()
        }
        Some(1222) => "lock_timeout: SQL Server 目标锁等待超时".into(),
        _ => DB_ERROR.into(),
    }
}
fn id(name: &str) -> String {
    Dialect::SqlServer.identifier(name)
}
fn checked(cancel: &Cancellation) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("cancelled: 数据任务已取消".into())
    } else {
        Ok(())
    }
}
fn text(row: &Row, index: usize) -> Result<String, String> {
    row.try_get::<&str, _>(index)
        .map_err(db_error)?
        .map(str::to_owned)
        .ok_or_else(|| DB_ERROR.into())
}
fn optional_text(row: &Row, index: usize) -> Result<Option<String>, String> {
    row.try_get::<&str, _>(index)
        .map_err(db_error)
        .map(|v| v.map(str::to_owned))
}
fn integer(row: &Row, index: usize) -> Result<i32, String> {
    row.try_get::<i32, _>(index)
        .map_err(db_error)?
        .ok_or_else(|| DB_ERROR.into())
}
fn wire_type(declared: &str) -> Result<&'static str, String> {
    let t = declared.to_ascii_uppercase();
    let base = t.split('(').next().unwrap_or("");
    Ok(match base {
        "TINYINT" | "SMALLINT" | "INT" | "INTEGER" | "BIGINT" => "int",
        "BIT" | "BOOLEAN" => "bool",
        "DECIMAL" | "NUMERIC" => "decimal",
        "FLOAT" | "REAL" => "float",
        "CHAR" | "NCHAR" | "VARCHAR" | "NVARCHAR" | "TEXT" | "NTEXT" => "text",
        "BINARY" | "VARBINARY" | "IMAGE" | "ROWVERSION" | "TIMESTAMP" => "binary",
        "DATE" => "date",
        "TIME" => "time",
        "DATETIME" | "SMALLDATETIME" => "datetime",
        "DATETIME2" => "datetime2",
        "DATETIMEOFFSET" => "datetimeoffset",
        "UNIQUEIDENTIFIER" | "UUID" => "uuid",
        _ => return Err("unsupported_capability: SQL Server 字段类型尚未通过无损验收".into()),
    })
}
fn snapshot_sql(
    schema: &str,
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
            .ok_or("invalid_mapping: SQL Server 快照表不是受支持物理表")?;
        if p.columns.is_empty() {
            return Err("invalid_mapping: 快照投影不能为空".into());
        }
        let mut frames = Vec::new();
        for name in &p.columns {
            let column = table
                .columns
                .iter()
                .find(|c| &c.name == name)
                .ok_or("invalid_mapping: SQL Server 快照列不存在")?;
            let kind = wire_type(&column.declared_type)?;
            let c = id(name);
            let value = match kind {
                "binary" => format!("CONVERT(varchar(max),{c},2)"),
                "float" => format!("CONVERT(varchar(max),{c},3)"),
                "datetimeoffset" => format!("CONVERT(nvarchar(max),{c},126)"),
                "date" | "time" | "datetime" | "datetime2" => {
                    format!("CONVERT(nvarchar(max),{c},126)")
                }
                _ => format!("CONVERT(nvarchar(max),{c})"),
            };
            frames.push(format!("(SELECT CASE WHEN {c} IS NULL THEN N'null' ELSE N'{kind}' END AS [t],CASE WHEN {c} IS NULL THEN NULL ELSE {value} END AS [v] FOR JSON PATH,INCLUDE_NULL_VALUES,WITHOUT_ARRAY_WRAPPER)"));
        }
        selects.push(format!("SELECT CAST({index} AS int) AS __data_table,CONVERT(nvarchar(max),N'[')+{}+N']' AS __data_payload FROM {}.{}",frames.join("+N','+"),id(schema),id(&p.table)));
    }
    let sql = selects.join(" UNION ALL ");
    if sql.len() > 1024 * 1024 {
        return Err("resource_limit: 集合 SQL 超过 1 MiB，请拆分任务".into());
    }
    Ok(sql)
}
#[derive(Deserialize)]
struct WireField<'a> {
    #[serde(borrow)]
    t: &'a str,
    #[serde(borrow)]
    v: Option<Cow<'a, str>>,
}
fn decode_payload(table: &str, keys: &[usize], payload: &str) -> Result<CanonicalRow, String> {
    if payload.len() > 32 * 1024 * 1024 {
        return Err("resource_limit: SQL Server 单行载荷超过内存预算".into());
    }
    let fields: Vec<WireField<'_>> =
        serde_json::from_str(payload).map_err(|_| "SQL Server 集合载荷编码无效")?;
    let mut values = Vec::with_capacity(fields.len());
    for field in fields {
        let v = || field.v.as_deref().ok_or("SQL Server 非空载荷缺少字符串值");
        values.push(match field.t {
            "null" => DataValue::Null,
            "int" => DataValue::Int(v()?.parse().map_err(|_| "SQL Server 整数超出无损范围")?),
            "bool" => DataValue::Bool(match v()? {
                "0" => false,
                "1" => true,
                _ => return Err("SQL Server 布尔值无效".into()),
            }),
            "decimal" => DataValue::Decimal(normalize_decimal(v()?)?),
            "float" => {
                let f: f64 = v()?.parse().map_err(|_| "SQL Server 浮点载荷无效")?;
                if !f.is_finite() {
                    return Err("unsupported_capability: SQL Server 非有限浮点数未验收".into());
                }
                DataValue::Float(f.to_bits())
            }
            "text" => DataValue::Text(v()?.into()),
            "binary" => {
                let b = v()?;
                if b.len() % 2 != 0 {
                    return Err("SQL Server 二进制载荷无效".into());
                }
                DataValue::Binary(
                    b.as_bytes()
                        .chunks_exact(2)
                        .map(|p| {
                            std::str::from_utf8(p)
                                .ok()
                                .and_then(|s| u8::from_str_radix(s, 16).ok())
                                .ok_or_else(|| "SQL Server 二进制编码无效".to_string())
                        })
                        .collect::<Result<Vec<_>, _>>()?,
                )
            }
            "uuid" => DataValue::Uuid(
                *uuid::Uuid::parse_str(v()?)
                    .map_err(|_| "SQL Server UUID 编码无效")?
                    .as_bytes(),
            ),
            "date" | "time" | "datetime" | "datetime2" | "datetimeoffset" => DataValue::Temporal {
                kind: field.t.into(),
                value: v()?.into(),
            },
            _ => return Err("unsupported_capability: SQL Server 载荷类型未经无损验收".into()),
        });
    }
    let key = keys
        .iter()
        .map(|i| {
            values
                .get(*i)
                .cloned()
                .ok_or_else(|| "invalid_mapping: SQL Server 定位键索引无效".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    CanonicalRow::new(table.into(), key, values)
}
fn protected_write_sql(schema: &str, tables: &[String]) -> Result<String, String> {
    if tables.is_empty() || tables.len() > 100 {
        return Err("invalid_mapping: SQL Server 受保护写入须选择 1 至 100 张表".into());
    }
    let mut tables = tables.to_vec();
    tables.sort();
    tables.dedup();
    let locks=tables.iter().enumerate().map(|(i,t)|format!("SELECT {i} AS __data_table,COUNT_BIG(*) AS __locked_rows FROM {}.{} WITH (TABLOCKX,HOLDLOCK)",id(schema),id(t))).collect::<Vec<_>>().join(" UNION ALL ");
    Ok(format!("SET LOCK_TIMEOUT 10000; SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; BEGIN TRANSACTION; {locks}"))
}
fn bind(query: &mut Query<'static>, value: DataValue, declared_type: &str) -> Result<(), String> {
    match value {
        DataValue::Null => match wire_type(declared_type)? {
            "binary" => query.bind(Option::<Vec<u8>>::None),
            "int" => query.bind(Option::<i64>::None),
            "bool" => query.bind(Option::<bool>::None),
            "float" => query.bind(Option::<f64>::None),
            "uuid" => query.bind(Option::<uuid::Uuid>::None),
            _ => query.bind(Option::<String>::None),
        },
        DataValue::Bool(v) => query.bind(v),
        DataValue::Int(v) => query.bind(v),
        DataValue::UInt(v) => query.bind(
            i64::try_from(v)
                .map_err(|_| "unsupported_capability: SQL Server 无符号值超过 BIGINT 范围")?,
        ),
        DataValue::Decimal(v) => query.bind(normalize_decimal(&v)?),
        DataValue::Float(v) => {
            let v = f64::from_bits(v);
            if !v.is_finite() {
                return Err("unsupported_capability: SQL Server 不能绑定非有限浮点数".into());
            }
            query.bind(v)
        }
        DataValue::Text(v) => query.bind(v),
        DataValue::Binary(v) => query.bind(v),
        DataValue::Temporal { value, .. } => query.bind(value),
        DataValue::Uuid(v) => query.bind(uuid::Uuid::from_bytes(v)),
        DataValue::Json(_) => {
            return Err("unsupported_capability: SQL Server JSON 映射尚未验收".into())
        }
    }
    Ok(())
}
struct SqlServerSession {
    client: Option<Client>,
    tunnel: Option<SshTunnel>,
    config: ConnectionConfig,
    schema: String,
    cancel: Cancellation,
    metadata: Option<DataMetadataSnapshot>,
    identity: Option<EndpointIdentity>,
    cleanup_errors: Vec<String>,
}
impl Drop for SqlServerSession {
    fn drop(&mut self) {
        drop(self.client.take());
        if let Some(tunnel) = self.tunnel.take() {
            tunnel.close();
        }
    }
}
pub async fn open(
    config: ConnectionConfig,
    endpoint: DataEndpoint,
    cancel: Cancellation,
) -> Result<Box<dyn DataSession>, String> {
    checked(&cancel)?;
    if config.database_type != DatabaseType::SqlServer
        || config.database.as_deref().unwrap_or("").is_empty()
        || endpoint.database.is_empty()
    {
        return Err("invalid_mapping: SQL Server 必须指定保存连接的 database 和端点 schema".into());
    }
    if config
        .session_init_commands
        .as_ref()
        .is_some_and(|v| !v.is_empty())
    {
        return Err(
            "unsupported_capability: SQL Server 数据任务暂不接受自定义会话初始化脚本".into(),
        );
    }
    let tunnel = if let Some(ssh) = &config.ssh {
        Some(
            SshTunnel::start(ssh, &config.host, config.port)
                .await
                .map_err(|_| DB_ERROR)?,
        )
    } else {
        None
    };
    let (host, port) = tunnel
        .as_ref()
        .map(|t| ("127.0.0.1", t.local_port()))
        .unwrap_or((&config.host, config.port));
    let tds = build_tiberius_config(host, port, &config).map_err(|_| DB_ERROR)?;
    let manager = ConnectionManager::new(tds);
    let mut client = tokio::time::timeout(Duration::from_secs(10), manager.connect())
        .await
        .map_err(|_| DB_ERROR)?
        .map_err(|_| DB_ERROR)?;
    client.simple_query("SET XACT_ABORT ON; SET ARITHABORT ON; SET NUMERIC_ROUNDABORT ON; SET LOCK_TIMEOUT 10000; SET NOCOUNT OFF;").await.map_err(db_error)?.into_results().await.map_err(db_error)?;
    Ok(Box::new(SqlServerSession {
        client: Some(client),
        tunnel,
        config,
        schema: endpoint.database,
        cancel,
        metadata: None,
        identity: None,
        cleanup_errors: vec![],
    }))
}
impl SqlServerSession {
    fn connection(&mut self) -> Result<&mut Client, String> {
        self.client
            .as_mut()
            .ok_or_else(|| "SQL Server 专属会话已关闭，事务结果需要核对".into())
    }
    async fn command(&mut self, sql: String) -> Result<(), String> {
        self.connection()?
            .simple_query(sql)
            .await
            .map_err(db_error)?
            .into_results()
            .await
            .map_err(db_error)?;
        Ok(())
    }
    async fn metadata_inner(&mut self) -> Result<DataMetadataSnapshot, String> {
        checked(&self.cancel)?;
        let schema = self.schema.clone();
        let config = self.config.clone();
        let facts=self.connection()?.query("SELECT CAST(SERVERPROPERTY(N'ServerName') AS nvarchar(256)),DB_NAME(),CAST(DATABASEPROPERTYEX(DB_NAME(),N'Updateability') AS nvarchar(32)),CAST(d.snapshot_isolation_state AS int),CAST(ISNULL(IS_SRVROLEMEMBER(N'sysadmin'),0) AS int),CAST(ISNULL(IS_MEMBER(N'db_owner'),0) AS int),CAST(ISNULL(HAS_PERMS_BY_NAME(@P1,N'SCHEMA',N'VIEW DEFINITION'),0) AS int),CAST(ISNULL(HAS_PERMS_BY_NAME(@P1,N'SCHEMA',N'SELECT'),0) AS int),CAST(ISNULL(HAS_PERMS_BY_NAME(@P1,N'SCHEMA',N'INSERT'),0) AS int),CAST(ISNULL(HAS_PERMS_BY_NAME(@P1,N'SCHEMA',N'UPDATE'),0) AS int),CAST(ISNULL(HAS_PERMS_BY_NAME(@P1,N'SCHEMA',N'DELETE'),0) AS int),CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int),CAST(ISNULL(HAS_PERMS_BY_NAME(DB_NAME(),N'DATABASE',N'VIEW DEFINITION'),0) AS int),CAST(CASE WHEN EXISTS(SELECT 1 FROM sys.database_permissions p JOIN sys.user_token u ON u.principal_id=p.grantee_principal_id WHERE p.state=N'D' AND p.class IN (0,1,3) AND p.permission_name IN (N'VIEW DEFINITION',N'VIEW SECURITY DEFINITION',N'VIEW PERFORMANCE DEFINITION',N'CONTROL')) THEN 1 ELSE 0 END AS int) FROM sys.databases d WHERE d.database_id=DB_ID()",&[&schema]).await.map_err(db_error)?.into_first_result().await.map_err(db_error)?;
        let f = facts.first().ok_or(DB_ERROR)?;
        if integer(f, 11)? != 16 {
            return Err("unsupported_capability: SQL Server 数据任务当前仅验收 2022 主版本".into());
        }
        let instance = text(f, 0)?;
        let database = text(f, 1)?;
        let read_only = text(f, 2)? != "READ_WRITE" || config.read_only.unwrap_or(false);
        let consistent = integer(f, 3)? == 1;
        let owner = integer(f, 4)? == 1 || integer(f, 5)? == 1;
        // 外部 schema 的入向 FK 和安全策略也会影响所选表，必须证明整个数据库目录可见。
        // 当前用户和适用角色的显式目录 DENY 会覆盖全库授权，必须一并拒绝。
        let metadata_visible = (owner || integer(f, 12)? == 1) && integer(f, 13)? == 0;
        if !metadata_visible {
            return Err("unsupported_capability: SQL Server 需要数据库级 VIEW DEFINITION，且当前用户及角色不能存在目录 DENY，才能验证外部外键和行级安全策略".into());
        }
        let permissions =
            metadata_visible && (owner || (integer(f, 6)? == 1 && integer(f, 7)? == 1));
        let write_permissions = metadata_visible
            && (owner || (integer(f, 8)? == 1 && integer(f, 9)? == 1 && integer(f, 10)? == 1));
        let rows=self.connection()?.query("SELECT t.name,t.type,CAST(t.is_ms_shipped AS int),c.name,ty.name,CAST(c.max_length AS int),CAST(c.precision AS int),CAST(c.scale AS int),CAST(c.is_nullable AS int),dc.definition,CAST(c.is_computed AS int),CAST(c.generated_always_type AS int),CAST(c.is_identity AS int),CAST(ISNULL(pk.key_ordinal,0) AS int),c.collation_name,CAST(ty.is_user_defined AS int),CONVERT(nvarchar(100),ic.seed_value),CONVERT(nvarchar(100),ic.increment_value),CAST(ISNULL(HAS_PERMS_BY_NAME(QUOTENAME(s.name)+N'.'+QUOTENAME(t.name),N'OBJECT',N'ALTER'),0) AS int),CAST(ISNULL(st.is_memory_optimized,0) AS int),CAST(ISNULL(st.temporal_type,0) AS int) FROM sys.objects t LEFT JOIN sys.tables st ON st.object_id=t.object_id JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.columns c ON c.object_id=t.object_id JOIN sys.types ty ON ty.user_type_id=c.user_type_id LEFT JOIN sys.default_constraints dc ON dc.object_id=c.default_object_id LEFT JOIN sys.identity_columns ic ON ic.object_id=c.object_id AND ic.column_id=c.column_id LEFT JOIN (SELECT i.object_id,ic.column_id,ic.key_ordinal FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id WHERE i.is_primary_key=1) pk ON pk.object_id=c.object_id AND pk.column_id=c.column_id WHERE s.name=@P1 AND t.type IN ('U','V') ORDER BY t.name,c.column_id",&[&schema]).await.map_err(db_error)?.into_first_result().await.map_err(db_error)?;
        if rows.len() > 100000 {
            return Err("resource_limit: SQL Server schema 元数据超过预算".into());
        }
        let mut tables: BTreeMap<String, DataTable> = BTreeMap::new();
        for row in rows {
            let name = text(&row, 0)?;
            let base = text(&row, 4)?.to_ascii_uppercase();
            let declared = if integer(&row, 15)? != 0 {
                format!("CUSTOM:{base}")
            } else {
                match base.as_str() {
                    "NVARCHAR" | "NCHAR" => format!(
                        "{base}({})",
                        if integer(&row, 5)? < 0 {
                            "MAX".into()
                        } else {
                            (integer(&row, 5)? / 2).to_string()
                        }
                    ),
                    "VARCHAR" | "CHAR" | "VARBINARY" | "BINARY" => format!(
                        "{base}({})",
                        if integer(&row, 5)? < 0 {
                            "MAX".into()
                        } else {
                            integer(&row, 5)?.to_string()
                        }
                    ),
                    "DECIMAL" | "NUMERIC" => {
                        format!("{base}({},{})", integer(&row, 6)?, integer(&row, 7)?)
                    }
                    "DATETIME2" | "DATETIMEOFFSET" | "TIME" => {
                        format!("{base}({})", integer(&row, 7)?)
                    }
                    _ => base.clone(),
                }
            };
            let physical = text(&row, 1)?.trim() == "U"
                && integer(&row, 2)? == 0
                && integer(&row, 19)? == 0
                && integer(&row, 20)? == 0;
            let table = tables.entry(name.clone()).or_insert(DataTable {
                name,
                create_sql: String::new(),
                columns: vec![],
                foreign_keys: vec![],
                enabled_user_triggers: false,
                physical,
            });
            let identity = integer(&row, 12)? == 1;
            let seed = optional_text(&row, 16)?;
            let step = optional_text(&row, 17)?;
            let safe = identity
                && (owner || integer(&row, 18)? == 1)
                && step.as_deref() == Some("1")
                && seed
                    .as_deref()
                    .is_some_and(|s| s.parse::<i128>().is_ok_and(|v| v >= 0));
            let column = DataColumn {
                name: text(&row, 3)?,
                declared_type: declared,
                nullable: integer(&row, 8)? == 1,
                default_sql: optional_text(&row, 9)?,
                generated: integer(&row, 10)? == 1
                    || integer(&row, 11)? > 0
                    || matches!(base.as_str(), "TIMESTAMP" | "ROWVERSION"),
                primary_key_ordinal: integer(&row, 13)? as u32,
                collation: optional_text(&row, 14)?,
                identity,
                generator_safe: safe,
            };
            table.create_sql.push_str(&format!(
                "{}:{}:{:?}:{:?};",
                text(&row, 1)?,
                serde_json::to_string(&column).map_err(|_| DB_ERROR)?,
                seed,
                step
            ));
            table.columns.push(column);
        }
        let rows=self.connection()?.query("SELECT s.name,t.name,fk.name,ps.name,pt.name,c.name,pc.name,fk.update_referential_action_desc,fk.delete_referential_action_desc,CAST(fk.is_disabled AS int),CAST(fk.is_not_trusted AS int) FROM sys.foreign_keys fk JOIN sys.objects t ON t.object_id=fk.parent_object_id JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.objects pt ON pt.object_id=fk.referenced_object_id JOIN sys.schemas ps ON ps.schema_id=pt.schema_id JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id=fk.object_id JOIN sys.columns c ON c.object_id=t.object_id AND c.column_id=fkc.parent_column_id JOIN sys.columns pc ON pc.object_id=pt.object_id AND pc.column_id=fkc.referenced_column_id WHERE s.name=@P1 OR ps.name=@P1 ORDER BY s.name,t.name,fk.name,fkc.constraint_column_id",&[&schema]).await.map_err(db_error)?.into_first_result().await.map_err(db_error)?;
        let mut fks: BTreeMap<(String, String), DataForeignKey> = BTreeMap::new();
        for row in rows {
            let child_schema = text(&row, 0)?;
            let child = if child_schema == schema {
                text(&row, 1)?
            } else {
                format!("{}.{}", child_schema, text(&row, 1)?)
            };
            let parent = if text(&row, 3)? == schema {
                text(&row, 4)?
            } else {
                format!("{}.{}", text(&row, 3)?, text(&row, 4)?)
            };
            let table = tables.entry(child.clone()).or_insert(DataTable {
                name: child.clone(),
                create_sql: String::new(),
                columns: vec![],
                foreign_keys: vec![],
                enabled_user_triggers: false,
                physical: false,
            });
            if integer(&row, 9)? != 0 || integer(&row, 10)? != 0 {
                table.physical = false;
            }
            let fk = fks
                .entry((child, text(&row, 2)?))
                .or_insert(DataForeignKey {
                    from_columns: vec![],
                    parent_table: parent,
                    parent_columns: vec![],
                    on_update: text(&row, 7)?.replace('_', " "),
                    on_delete: text(&row, 8)?.replace('_', " "),
                });
            fk.from_columns.push(text(&row, 5)?);
            fk.parent_columns.push(text(&row, 6)?);
        }
        for ((name, _), fk) in fks {
            tables.get_mut(&name).unwrap().foreign_keys.push(fk);
        }
        let rows=self.connection()?.query("SELECT t.name,tr.name,CAST(tr.is_disabled AS int),OBJECT_DEFINITION(tr.object_id) FROM sys.triggers tr JOIN sys.objects t ON t.object_id=tr.parent_id JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=@P1 ORDER BY t.name,tr.name",&[&schema]).await.map_err(db_error)?.into_first_result().await.map_err(db_error)?;
        for row in rows {
            if let Some(table) = tables.get_mut(&text(&row, 0)?) {
                if integer(&row, 2)? == 0 {
                    table.enabled_user_triggers = true;
                }
                table.create_sql.push_str(&format!(
                    "trigger:{}:{}:{:?};",
                    text(&row, 1)?,
                    integer(&row, 2)?,
                    optional_text(&row, 3)?
                ));
            }
        }
        let rows=self.connection()?.query("SELECT t.name,i.name,CAST(i.index_id AS int),CAST(i.is_unique AS int),CAST(i.is_disabled AS int),i.filter_definition,CAST(ic.index_column_id AS int),CAST(ic.key_ordinal AS int),CAST(ic.is_included_column AS int),c.name FROM sys.objects t JOIN sys.schemas s ON s.schema_id=t.schema_id JOIN sys.indexes i ON i.object_id=t.object_id JOIN sys.index_columns ic ON ic.object_id=i.object_id AND ic.index_id=i.index_id JOIN sys.columns c ON c.object_id=ic.object_id AND c.column_id=ic.column_id WHERE s.name=@P1 ORDER BY t.name,i.index_id,ic.index_column_id",&[&schema]).await.map_err(db_error)?.into_first_result().await.map_err(db_error)?;
        for row in rows {
            if let Some(table) = tables.get_mut(&text(&row, 0)?) {
                table.create_sql.push_str(&format!(
                    "index:{:?}:{}:{}:{}:{:?}:{}:{}:{}:{};",
                    optional_text(&row, 1)?,
                    integer(&row, 2)?,
                    integer(&row, 3)?,
                    integer(&row, 4)?,
                    optional_text(&row, 5)?,
                    integer(&row, 6)?,
                    integer(&row, 7)?,
                    integer(&row, 8)?,
                    text(&row, 9)?
                ));
            }
        }
        let rows=self.connection()?.query("SELECT t.name,c.name,c.definition,CAST(c.is_disabled AS int),CAST(c.is_not_trusted AS int) FROM sys.check_constraints c JOIN sys.objects t ON t.object_id=c.parent_object_id JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=@P1 ORDER BY t.name,c.name",&[&schema]).await.map_err(db_error)?.into_first_result().await.map_err(db_error)?;
        for row in rows {
            if let Some(table) = tables.get_mut(&text(&row, 0)?) {
                table.create_sql.push_str(&format!(
                    "check:{}:{}:{}:{};",
                    text(&row, 1)?,
                    text(&row, 2)?,
                    integer(&row, 3)?,
                    integer(&row, 4)?
                ));
            }
        }
        let policies=self.connection()?.query("SELECT COUNT_BIG(*) FROM sys.security_predicates p JOIN sys.security_policies policy ON policy.object_id=p.object_id JOIN sys.objects t ON t.object_id=p.target_object_id JOIN sys.schemas s ON s.schema_id=t.schema_id WHERE s.name=@P1 AND policy.is_enabled=1",&[&schema]).await.map_err(db_error)?.into_first_result().await.map_err(db_error)?;
        let no_rls = policies.first().and_then(|r| r.get::<i64, _>(0)) == Some(0);
        let tables = tables.into_values().collect::<Vec<_>>();
        let signature = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&tables).map_err(|_| DB_ERROR)?)
        );
        let metadata = DataMetadataSnapshot {
            database_type: DatabaseType::SqlServer,
            tables,
            read_only,
            permissions_verified: permissions && no_rls,
            consistent_snapshot: consistent,
            protected_write: write_permissions && !read_only,
            schema_fingerprint: signature,
            configuration_fingerprint: crate::db::data_tasks::executor::configuration_fingerprint(
                &config,
            ),
        };
        self.identity = Some(EndpointIdentity {
            database_type: DatabaseType::SqlServer,
            instance: Some(instance),
            database: format!("{database}.{schema}"),
            sqlite_path: None,
        });
        self.metadata = Some(metadata.clone());
        Ok(metadata)
    }
}
impl DataSession for SqlServerSession {
    fn endpoint_identity(&self) -> Option<EndpointIdentity> {
        self.identity.clone()
    }
    fn take_cleanup_errors(&mut self) -> Vec<String> {
        std::mem::take(&mut self.cleanup_errors)
    }
    fn dialect(&self) -> Dialect {
        Dialect::SqlServer
    }
    fn begin_read(&mut self) -> SessionFuture<'_, ()> {
        Box::pin(async move {
            checked(&self.cancel)?;
            self.command("SET TRANSACTION ISOLATION LEVEL SNAPSHOT; BEGIN TRANSACTION;".into())
                .await
        })
    }
    fn begin_protected_write(&mut self, tables: Vec<String>) -> SessionFuture<'_, ()> {
        Box::pin(async move {
            checked(&self.cancel)?;
            if self.config.read_only.unwrap_or(false) {
                return Err("read_only_target: SQL Server 目标连接只读".into());
            }
            self.command(protected_write_sql(&self.schema, &tables)?)
                .await
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
                &self.schema,
                &projections,
                self.metadata
                    .as_ref()
                    .ok_or("invalid_mapping: 必须先批量读取 SQL Server 元数据")?,
            )?;
            let mut client = self.client.take().ok_or(DB_ERROR)?;
            let outcome=async{let mut stream=client.simple_query(sql).await.map_err(db_error)?;let mut count=0u64;loop{let item=tokio::select!{item=stream.try_next()=>item.map_err(db_error)?,_=async{while !cancel.load(Ordering::Acquire){tokio::time::sleep(Duration::from_millis(25)).await;}}=>return Err("cancelled: SQL Server 集合流已取消，专属物理会话已关闭".into())};let Some(item)=item else{break};let Some(row)=item.into_row()else{continue};checked(&cancel)?;let index=integer(&row,0)? as usize;let projection=projections.get(index).ok_or("SQL Server 集合表序号无效")?;let payload=row.try_get::<&str,_>(1).map_err(db_error)?.ok_or(DB_ERROR)?;let lease=sender.reserve_decode(payload.len().saturating_mul(3)).await?;let row=decode_payload(&projection.output_table,&projection.key_indices,payload)?;drop(lease);sender.send(row).await?;count+=1;}Ok(count)}.await;
            if cancel.load(Ordering::Acquire) {
                drop(client);
            } else {
                self.client = Some(client);
            }
            outcome
        })
    }
    fn write_batch(&mut self, batch: WriteBatch) -> SessionFuture<'_, u64> {
        Box::pin(async move {
            checked(&self.cancel)?;
            let identity = if batch.kind == DataDiffOperation::Insert {
                self.metadata
                    .as_ref()
                    .and_then(|m| m.tables.iter().find(|t| t.name == batch.table))
                    .is_some_and(|t| {
                        t.columns
                            .iter()
                            .any(|c| c.identity && batch.columns.contains(&c.name))
                    })
            } else {
                false
            };
            let target = format!("{}.{}", id(&self.schema), id(&batch.table));
            let table = self
                .metadata
                .as_ref()
                .and_then(|metadata| {
                    metadata
                        .tables
                        .iter()
                        .find(|table| table.name == batch.table)
                })
                .ok_or("invalid_mapping: 缺少 SQL Server 绑定元数据")?;
            let declared = batch
                .parameter_columns
                .iter()
                .map(|index| {
                    batch
                        .columns
                        .get(*index)
                        .and_then(|name| table.columns.iter().find(|column| &column.name == name))
                        .map(|column| column.declared_type.clone())
                        .ok_or("invalid_mapping: SQL Server 参数没有对应目标字段")
                })
                .collect::<Result<Vec<_>, _>>()?;
            let mut query = Query::new(batch.sql);
            for (value, declared_type) in batch.params.into_iter().zip(declared) {
                bind(&mut query, value, &declared_type)?;
            }
            if identity {
                self.command(format!("SET IDENTITY_INSERT {target} ON"))
                    .await?;
            }
            let result = query
                .execute(self.connection()?)
                .await
                .map_err(db_error)
                .map(|r| r.total());
            if identity {
                if let Err(error) = self
                    .command(format!("SET IDENTITY_INSERT {target} OFF"))
                    .await
                {
                    self.cleanup_errors.push(error);
                    if result.is_ok() {
                        return Err("SQL Server identity 会话状态恢复失败，已拒绝提交".into());
                    }
                }
            }
            result
        })
    }
    fn delete_all(&mut self, table: String) -> SessionFuture<'_, u64> {
        Box::pin(async move {
            checked(&self.cancel)?;
            let sql = format!("DELETE FROM {}.{}", id(&self.schema), id(&table));
            self.connection()?
                .execute(sql, &[])
                .await
                .map_err(db_error)
                .map(|r| r.total())
        })
    }
    fn maintain_generators(
        &mut self,
        mapping: Vec<ValidatedTableMapping>,
    ) -> SessionFuture<'_, ()> {
        Box::pin(async move {
            checked(&self.cancel)?;
            let metadata = self
                .metadata
                .as_ref()
                .ok_or("SQL Server 缺少生成器元数据")?;
            for table in mapping {
                let table = metadata
                    .tables
                    .iter()
                    .find(|t| t.name == table.target_table)
                    .ok_or("SQL Server 生成器表不存在")?;
                if table
                    .columns
                    .iter()
                    .any(|c| c.identity && !c.generator_safe)
                {
                    return Err(
                        "unsupported_capability: SQL Server identity 权限或递增规则不安全".into(),
                    );
                }
            } // SQL Server 显式插入较大 identity 值会自行单调推进，不执行可能回退生成器的 DBCC RESEED。
            Ok(())
        })
    }
    fn commit(&mut self) -> SessionFuture<'_, ()> {
        Box::pin(async move { self.command("COMMIT TRANSACTION".into()).await })
    }
    fn rollback(&mut self) -> SessionFuture<'_, ()> {
        Box::pin(async move {
            self.command("IF @@TRANCOUNT>0 ROLLBACK TRANSACTION".into())
                .await
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::data_tasks::value::DataValue;
    #[test]
    fn lossless_payload_preserves_bigint_decimal_binary_and_temporal_scale() {
        let r=decode_payload("目标",&[0],r#"[{"t":"int","v":"9007199254740993"},{"t":"decimal","v":"12345678901234567890.123456789"},{"t":"binary","v":"0001FF"},{"t":"datetimeoffset","v":"2026-10-20T12:34:56.1234567+08:00"},{"t":"text","v":"中文\\\"尾空格  "},{"t":"null","v":null}]"#).unwrap();
        assert_eq!(r.values[0], DataValue::Int(9007199254740993));
        assert_eq!(
            r.values[1],
            DataValue::Decimal("12345678901234567890.123456789".into())
        );
        assert_eq!(r.values[2], DataValue::Binary(vec![0, 1, 255]));
        assert_eq!(
            r.values[3],
            DataValue::Temporal {
                kind: "datetimeoffset".into(),
                value: "2026-10-20T12:34:56.1234567+08:00".into()
            }
        );
        assert_eq!(r.values[5], DataValue::Null);
        assert_eq!(r.key, vec![DataValue::Int(9007199254740993)]);
    }
    #[test]
    fn malformed_or_potentially_lossy_values_are_blocked() {
        for payload in [
            r#"[{"t":"int","v":9007199254740993}]"#,
            r#"[{"t":"binary","v":"GG"}]"#,
            r#"[{"t":"decimal","v":"1e20"}]"#,
            r#"[{"t":"custom","v":"opaque"}]"#,
        ] {
            assert!(decode_payload("t", &[], payload).is_err());
        }
    }
    #[test]
    fn one_native_union_handles_heterogeneous_tables() {
        let mut m = crate::db::data_tasks::metadata::tests::metadata();
        m.database_type = crate::models::types::DatabaseType::SqlServer;
        let mut second = m.tables[0].clone();
        second.name = "odd]表".into();
        m.tables.push(second);
        let projections = vec![
            Projection {
                table: "t".into(),
                output_table: "t".into(),
                columns: vec!["id".into(), "v".into()],
                key_indices: vec![0],
            },
            Projection {
                table: "odd]表".into(),
                output_table: "odd]表".into(),
                columns: vec!["v".into()],
                key_indices: vec![],
            },
        ];
        let sql = snapshot_sql("dbo", &projections, &m).unwrap();
        assert_eq!(sql.matches(" UNION ALL ").count(), 1);
        assert!(sql.contains("[dbo].[odd]]表]"));
        assert!(sql.contains("FOR JSON PATH"));
        assert!(!sql.contains("OFFSET"));
    }
    #[test]
    fn lock_statement_uses_one_collection_and_explicit_transaction() {
        let sql = protected_write_sql("dbo", &["a".into(), "b".into()]).unwrap();
        assert!(sql.contains("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"));
        assert!(sql.contains("BEGIN TRANSACTION"));
        assert_eq!(sql.matches(" UNION ALL ").count(), 1);
        assert_eq!(sql.matches("TABLOCKX,HOLDLOCK").count(), 2);
        assert!(sql.contains("LOCK_TIMEOUT 10000"));
    }
}
#[cfg(test)]
mod native_tests {
    use super::*;
    use crate::db::data_tasks::{metadata::ValidatedTableMapping, spool::ResourceBudget};
    use std::sync::{atomic::AtomicBool, Arc};
    fn configuration() -> ConnectionConfig {
        let url = std::env::var("DB_CONNECT_DATA_TASK_SQLSERVER_URL")
            .expect("缺少专属 SQL Server 验收连接，禁止跳过后当作通过");
        let url = reqwest::Url::parse(&url).expect("SQL Server 夹具 URL 无效");
        assert_eq!(url.scheme(), "sqlserver");
        serde_json::from_value(serde_json::json!({"database_type":"sqlserver","name":"本任务专属夹具","host":url.host_str().unwrap(),"port":url.port().unwrap_or(1433),"username":url.username(),"password":url.password().unwrap_or(""),"database":url.path().trim_start_matches('/'),"ssl_mode":"required_insecure"})).unwrap()
    }
    async fn raw(config: &ConnectionConfig) -> Client {
        let tds = build_tiberius_config(&config.host, config.port, config).unwrap();
        ConnectionManager::new(tds).connect().await.unwrap()
    }
    fn token() -> Cancellation {
        Arc::new(AtomicBool::new(false))
    }
    async fn collect(session: &mut dyn DataSession, p: Vec<Projection>) -> Vec<CanonicalRow> {
        let (sender, mut receiver) = RowSender::channel(ResourceBudget::default());
        let (count, rows) = tokio::join!(session.stream_rows(p, token(), sender), async move {
            let mut rows = Vec::new();
            while let Some(envelope) = receiver.recv().await {
                rows.push(envelope.row);
            }
            rows
        });
        assert_eq!(count.unwrap(), rows.len() as u64);
        rows
    }
    async fn session_as_user(
        config: &ConnectionConfig,
        schema: &str,
        user: &str,
    ) -> SqlServerSession {
        let mut client = raw(config).await;
        client
            .simple_query(format!("EXECUTE AS USER = N'{user}'"))
            .await
            .unwrap()
            .into_results()
            .await
            .unwrap();
        SqlServerSession {
            client: Some(client),
            tunnel: None,
            config: config.clone(),
            schema: schema.into(),
            cancel: token(),
            metadata: None,
            identity: None,
            cleanup_errors: vec![],
        }
    }
    #[tokio::test]
    #[ignore = "需专属 SQL Server 容器及 DB_CONNECT_DATA_TASK_SQLSERVER_URL"]
    async fn real_sqlserver_rejects_invisible_external_foreign_keys() {
        let config = configuration();
        let mut admin = raw(&config).await;
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let target = format!("t_{suffix}");
        let external = format!("e_{suffix}");
        let user = format!("u_{suffix}");
        let role = format!("r_{suffix}");
        admin
            .simple_query(format!("CREATE SCHEMA {};", id(&target)))
            .await
            .unwrap()
            .into_results()
            .await
            .unwrap();
        admin
            .simple_query(format!("CREATE SCHEMA {};", id(&external)))
            .await
            .unwrap()
            .into_results()
            .await
            .unwrap();
        admin.simple_query(format!("CREATE TABLE {}.parent(id BIGINT PRIMARY KEY); CREATE TABLE {}.child(id BIGINT PRIMARY KEY,parent_id BIGINT REFERENCES {}.parent(id) ON DELETE CASCADE); CREATE USER {} WITHOUT LOGIN; GRANT VIEW DEFINITION,SELECT,INSERT,UPDATE,DELETE ON SCHEMA::{} TO {};", id(&target),id(&external),id(&target),id(&user),id(&target),id(&user))).await.unwrap().into_results().await.unwrap();
        let mut session = session_as_user(&config, &target, &user).await;
        let scoped = session.load_metadata().await;
        admin
            .simple_query(format!("GRANT VIEW DEFINITION TO {};", id(&user)))
            .await
            .unwrap()
            .into_results()
            .await
            .unwrap();
        let visible = session.load_metadata().await.unwrap();
        admin
            .simple_query(format!(
                "DENY VIEW DEFINITION ON OBJECT::{}.child TO {};",
                id(&external),
                id(&user)
            ))
            .await
            .unwrap()
            .into_results()
            .await
            .unwrap();
        let denied = session.load_metadata().await;
        drop(session);
        admin.simple_query(format!("REVOKE VIEW DEFINITION ON OBJECT::{}.child FROM {};CREATE ROLE {};ALTER ROLE {} ADD MEMBER {};DENY CONTROL ON SCHEMA::{} TO {};",id(&external),id(&user),id(&role),id(&role),id(&user),id(&external),id(&role))).await.unwrap().into_results().await.unwrap();
        let mut session = session_as_user(&config, &target, &user).await;
        let role_denied = session.load_metadata().await;
        admin.simple_query(format!("REVOKE CONTROL ON SCHEMA::{} FROM {};DENY VIEW DEFINITION ON OBJECT::{}.child TO public;",id(&external),id(&role),id(&external))).await.unwrap().into_results().await.unwrap();
        let public_denied = session.load_metadata().await;
        admin.simple_query(format!("REVOKE VIEW DEFINITION ON OBJECT::{}.child FROM public;DENY VIEW DEFINITION TO {};",id(&external),id(&role))).await.unwrap().into_results().await.unwrap();
        let database_denied = session.load_metadata().await;
        drop(session);
        admin.simple_query(format!("DROP TABLE {}.child;DROP TABLE {}.parent;DROP USER {};DROP ROLE {};DROP SCHEMA {};DROP SCHEMA {};",id(&external),id(&target),id(&user),id(&role),id(&external),id(&target))).await.unwrap().into_results().await.unwrap();
        assert!(
            scoped.unwrap_err().starts_with("unsupported_capability:"),
            "仅目标 schema 权限不能证明外部入向外键完整可见"
        );
        assert!(visible.permissions_verified && visible.protected_write);
        assert!(
            visible.tables.iter().any(|t| !t.foreign_keys.is_empty()),
            "全库定义权限应暴露跨 schema 入向外键"
        );
        assert!(
            denied.unwrap_err().starts_with("unsupported_capability:"),
            "对象级 DENY 不能被全库 VIEW DEFINITION 授权掩盖"
        );
        assert!(
            role_denied
                .unwrap_err()
                .starts_with("unsupported_capability:"),
            "角色在外部 schema 的 CONTROL DENY 必须阻塞元数据证明"
        );
        assert!(
            public_denied
                .unwrap_err()
                .starts_with("unsupported_capability:"),
            "public 的对象定义 DENY 必须阻塞元数据证明"
        );
        assert!(
            database_denied
                .unwrap_err()
                .starts_with("unsupported_capability:"),
            "角色的数据库定义 DENY 必须阻塞元数据证明"
        );
    }
    #[tokio::test]
    #[ignore = "需专属 SQL Server 容器及 DB_CONNECT_DATA_TASK_SQLSERVER_URL"]
    async fn real_sqlserver_rejects_invisible_external_row_security() {
        let config = configuration();
        let mut admin = raw(&config).await;
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let target = format!("t_{suffix}");
        let external = format!("e_{suffix}");
        let user = format!("u_{suffix}");
        admin
            .simple_query(format!("CREATE SCHEMA {};", id(&target)))
            .await
            .unwrap()
            .into_results()
            .await
            .unwrap();
        admin
            .simple_query(format!("CREATE SCHEMA {};", id(&external)))
            .await
            .unwrap()
            .into_results()
            .await
            .unwrap();
        admin.simple_query(format!("CREATE TABLE {}.items(id BIGINT PRIMARY KEY);INSERT INTO {}.items VALUES(1),(2);CREATE USER {} WITHOUT LOGIN;GRANT VIEW DEFINITION,SELECT ON SCHEMA::{} TO {};",id(&target),id(&target),id(&user),id(&target),id(&user))).await.unwrap().into_results().await.unwrap();
        admin.simple_query(format!("CREATE FUNCTION {}.visible_id(@id BIGINT) RETURNS TABLE WITH SCHEMABINDING AS RETURN SELECT 1 AS allowed WHERE @id=1;",id(&external))).await.unwrap().into_results().await.unwrap();
        admin.simple_query(format!("CREATE SECURITY POLICY {}.filter_items ADD FILTER PREDICATE {}.visible_id(id) ON {}.items WITH (STATE=ON);",id(&external),id(&external),id(&target))).await.unwrap().into_results().await.unwrap();
        let mut session = session_as_user(&config, &target, &user).await;
        let scoped = session.load_metadata().await;
        let filtered = session
            .connection()
            .unwrap()
            .simple_query(format!("SELECT COUNT_BIG(*) FROM {}.items", id(&target)))
            .await
            .unwrap()
            .into_first_result()
            .await
            .unwrap();
        admin
            .simple_query(format!("GRANT VIEW DEFINITION TO {};", id(&user)))
            .await
            .unwrap()
            .into_results()
            .await
            .unwrap();
        let policy_visible = session.load_metadata().await.unwrap();
        admin
            .simple_query(format!(
                "DROP SECURITY POLICY {}.filter_items;",
                id(&external)
            ))
            .await
            .unwrap()
            .into_results()
            .await
            .unwrap();
        let unfiltered = session.load_metadata().await.unwrap();
        drop(session);
        admin.simple_query(format!("DROP FUNCTION {}.visible_id;DROP TABLE {}.items;DROP USER {};DROP SCHEMA {};DROP SCHEMA {};",id(&external),id(&target),id(&user),id(&external),id(&target))).await.unwrap().into_results().await.unwrap();
        assert_eq!(
            filtered[0].get::<i64, _>(0),
            Some(1),
            "RLS 确实隐藏了第二行，不能视为完整源快照"
        );
        assert!(
            scoped.unwrap_err().starts_with("unsupported_capability:"),
            "仅目标 schema 的定义权限无法证明外部 RLS 不存在"
        );
        assert!(
            !policy_visible.permissions_verified,
            "可见的启用 RLS 也必须阻塞完整快照"
        );
        assert!(
            unfiltered.permissions_verified,
            "全库目录可见且无 RLS 时应接受完整读取"
        );
    }
    #[tokio::test]
    #[ignore = "需专属 SQL Server 容器及 DB_CONNECT_DATA_TASK_SQLSERVER_URL"]
    async fn real_sqlserver_native_lossless_snapshot_identity_and_protected_rollback() {
        let config = configuration();
        let mut admin = raw(&config).await;
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let source = format!("s_{suffix}");
        let target = format!("t_{suffix}");
        let ddl = format!("CREATE SCHEMA {};", id(&source));
        admin
            .simple_query(ddl)
            .await
            .unwrap()
            .into_results()
            .await
            .unwrap();
        admin
            .simple_query(format!("CREATE SCHEMA {};", id(&target)))
            .await
            .unwrap()
            .into_results()
            .await
            .unwrap();
        admin.simple_query(format!("CREATE TABLE {}.t(id BIGINT IDENTITY(1,1) PRIMARY KEY,n DECIMAL(38,9),payload VARBINARY(MAX),stamp DATETIMEOFFSET(7),v NVARCHAR(MAX));CREATE TABLE {}.t(id BIGINT IDENTITY(1,1) PRIMARY KEY,n DECIMAL(38,9),payload VARBINARY(MAX),stamp DATETIMEOFFSET(7),v NVARCHAR(MAX));SET IDENTITY_INSERT {}.t ON;INSERT INTO {}.t(id,n,payload,stamp,v) VALUES(9007199254740993,12345678901234567890.123456789,0x0001FF,'2026-10-20T12:34:56.1234567+08:00',N'中文尾空格  ');SET IDENTITY_INSERT {}.t OFF;",id(&source),id(&target),id(&source),id(&source),id(&source))).await.unwrap().into_results().await.unwrap();
        let endpoint = |schema: &str| DataEndpoint {
            saved_connection_id: "fixture".into(),
            database: schema.into(),
        };
        let columns = vec![
            "id".into(),
            "n".into(),
            "payload".into(),
            "stamp".into(),
            "v".into(),
        ];
        let projection = || {
            vec![Projection {
                table: "t".into(),
                output_table: "t".into(),
                columns: columns.clone(),
                key_indices: vec![0],
            }]
        };
        let mut reader = open(config.clone(), endpoint(&source), token())
            .await
            .unwrap();
        reader.begin_read().await.unwrap();
        let sm = reader.load_metadata().await.unwrap();
        assert!(sm.permissions_verified && sm.consistent_snapshot);
        assert!(sm.tables[0].columns[0].generator_safe);
        let rows = collect(reader.as_mut(), projection()).await;
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].values[0], DataValue::Int(9007199254740993));
        assert_eq!(
            rows[0].values[1],
            DataValue::Decimal("12345678901234567890.123456789".into())
        );
        assert_eq!(rows[0].values[2], DataValue::Binary(vec![0, 1, 255]));
        assert!(
            matches!(&rows[0].values[3],DataValue::Temporal{kind,value} if kind=="datetimeoffset"&&value.contains(".1234567+08:00"))
        );
        assert_eq!(rows[0].values[4], DataValue::Text("中文尾空格  ".into()));
        reader.rollback().await.unwrap();
        let mut writer = open(config.clone(), endpoint(&target), token())
            .await
            .unwrap();
        writer
            .begin_protected_write(vec!["t".into()])
            .await
            .unwrap();
        writer.load_metadata().await.unwrap();
        let batch = super::super::batch::build_batch(
            Dialect::SqlServer,
            &target,
            "t",
            &columns,
            &[0],
            DataDiffOperation::Insert,
            &[rows[0].values.clone()],
        )
        .unwrap();
        assert_eq!(writer.write_batch(batch).await.unwrap(), 1);
        assert_eq!(collect(writer.as_mut(), projection()).await, rows);
        writer
            .maintain_generators(vec![ValidatedTableMapping {
                source_table: "t".into(),
                target_table: "t".into(),
                source_columns: columns.clone(),
                target_columns: columns.clone(),
                key_indices: vec![0],
            }])
            .await
            .unwrap();
        writer.commit().await.unwrap();
        assert!(writer.take_cleanup_errors().is_empty());
        let next = admin
            .simple_query(format!(
                "INSERT INTO {}.t(v) OUTPUT INSERTED.id VALUES(N'下一行');",
                id(&target)
            ))
            .await
            .unwrap()
            .into_first_result()
            .await
            .unwrap();
        assert!(next[0].get::<i64, _>(0).unwrap() > 9007199254740993);
        writer
            .begin_protected_write(vec!["t".into()])
            .await
            .unwrap();
        writer.load_metadata().await.unwrap();
        let mut huge = rows[0].values.clone();
        huge[0] = DataValue::Int(9007199254741999);
        writer
            .write_batch(
                super::super::batch::build_batch(
                    Dialect::SqlServer,
                    &target,
                    "t",
                    &columns,
                    &[0],
                    DataDiffOperation::Insert,
                    &[huge],
                )
                .unwrap(),
            )
            .await
            .unwrap();
        let mut other = raw(&config).await;
        let sql = format!("INSERT INTO {}.t(v) VALUES(N'并发默认行')", id(&target));
        let blocked = tokio::spawn(async move { other.execute(sql, &[]).await.unwrap().total() });
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(!blocked.is_finished(), "外部 INSERT 必须受目标整表锁保护");
        writer.rollback().await.unwrap();
        assert_eq!(blocked.await.unwrap(), 1);
        let result = admin
            .simple_query(format!(
                "SELECT COUNT_BIG(*) FROM {}.t WHERE id=9007199254741999",
                id(&target)
            ))
            .await
            .unwrap()
            .into_first_result()
            .await
            .unwrap();
        assert_eq!(result[0].get::<i64, _>(0), Some(0));
        drop((reader, writer));
        admin
            .simple_query(format!(
                "DROP TABLE {}.t;DROP TABLE {}.t;DROP SCHEMA {};DROP SCHEMA {};",
                id(&source),
                id(&target),
                id(&source),
                id(&target)
            ))
            .await
            .unwrap()
            .into_results()
            .await
            .unwrap();
    }
}
