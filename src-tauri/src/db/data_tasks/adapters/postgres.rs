//! PostgreSQL 独占物理会话。数值通过文本 wire format 绑定，不经过显示值或 f64。
use super::RowSender;
use super::{
    batch::{Dialect, WriteBatch},
    sqlite::Projection,
    DataSession, SessionFuture,
};
use crate::{
    db::{
        connection::{ActiveConnection, ActiveDatabaseConnection, ConnectionManager},
        data_tasks::{
            metadata::{
                DataColumn, DataForeignKey, DataMetadataSnapshot, DataTable, EndpointIdentity,
                ValidatedTableMapping,
            },
            value::{normalize_decimal, CanonicalRow, DataValue},
            Cancellation,
        },
    },
    models::{
        data_tasks::{DataDiffOperation, DataEndpoint},
        types::{ConnectionConfig, DatabaseType},
    },
};
use bytes::BytesMut;
use futures_util::{pin_mut, TryStreamExt};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::atomic::Ordering, time::Duration};
use tokio_postgres::{
    types::{Format, IsNull, ToSql, Type},
    Row,
};
const DB_ERROR: &str = "PostgreSQL 数据任务失败，请检查权限、约束、事务锁及数据库连接";
fn db_error(_: tokio_postgres::Error) -> String {
    DB_ERROR.into()
}
fn checked(cancel: &Cancellation) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("cancelled: 数据任务已取消".into())
    } else {
        Ok(())
    }
}
fn id(name: &str) -> String {
    Dialect::Postgres.identifier(name)
}
fn string(row: &Row, index: usize) -> Result<String, String> {
    row.try_get(index).map_err(db_error)
}
fn hex(value: &[u8]) -> String {
    const DIGITS: &[u8] = b"0123456789abcdef";
    let mut out = String::with_capacity(value.len() * 2);
    for byte in value {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 15) as usize] as char);
    }
    out
}
fn unhex(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) {
        return Err("PostgreSQL 二进制编码无效".into());
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            std::str::from_utf8(pair)
                .ok()
                .and_then(|s| u8::from_str_radix(s, 16).ok())
                .ok_or_else(|| "PostgreSQL 二进制编码无效".into())
        })
        .collect()
}
fn wire_type(declared: &str) -> Result<&'static str, String> {
    let upper = declared.to_ascii_uppercase();
    let base = upper.split('(').next().unwrap_or("");
    Ok(match base {
        "SMALLINT" | "INTEGER" | "BIGINT" => "int",
        "NUMERIC" | "DECIMAL" => "decimal",
        "REAL" | "DOUBLE PRECISION" => "float",
        "BOOLEAN" => "bool",
        "TEXT" | "CHARACTER VARYING" | "CHARACTER" => "text",
        "BYTEA" => "binary",
        "DATE" => "date",
        "TIMESTAMP WITHOUT TIME ZONE" => "timestamp",
        "TIMESTAMP WITH TIME ZONE" => "timestamptz",
        "TIME WITHOUT TIME ZONE" => "time",
        "UUID" => "uuid",
        _ if upper.starts_with("TIMESTAMP(") && upper.ends_with("WITH TIME ZONE") => "timestamptz",
        _ if upper.starts_with("TIMESTAMP(") => "timestamp",
        _ if upper.starts_with("TIME(") => "time",
        _ => return Err("unsupported_capability: PostgreSQL 字段类型尚未通过无损验收".into()),
    })
}
fn decode_payload(projection: &Projection, payload: &str) -> Result<CanonicalRow, String> {
    if payload.len() > 32 * 1024 * 1024 {
        return Err("resource_limit: PostgreSQL 载荷超过内存预算".into());
    }
    if payload.starts_with("{\"resource_limit\":") {
        return Err("resource_limit: PostgreSQL 单行超过8MiB上限".into());
    }
    let json: serde_json::Value =
        serde_json::from_str(payload).map_err(|_| "PostgreSQL 集合载荷编码无效")?;
    let fields = json.as_array().ok_or("PostgreSQL 集合载荷形状无效")?;
    if fields.len() != projection.columns.len() {
        return Err("PostgreSQL 集合字段数量变化".into());
    }
    let mut values = Vec::with_capacity(fields.len());
    for field in fields {
        let kind = field["t"].as_str().ok_or("PostgreSQL 值类型缺失")?;
        let text = || {
            field["v"]
                .as_str()
                .ok_or_else(|| "PostgreSQL 值必须通过无损字符串编码".to_string())
        };
        values.push(match kind {
            "null" => DataValue::Null,
            "int" => DataValue::Int(text()?.parse().map_err(|_| "PostgreSQL 整数溢出")?),
            "decimal" => DataValue::Decimal(normalize_decimal(text()?)?),
            "float" => {
                let value = text()?
                    .parse::<f64>()
                    .map_err(|_| "PostgreSQL 浮点编码无效")?;
                if !value.is_finite() {
                    return Err("unsupported_capability: 非有限浮点数尚未验收".into());
                }
                DataValue::Float(value.to_bits())
            }
            "bool" => DataValue::Bool(match text()? {
                "true" | "t" => true,
                "false" | "f" => false,
                _ => return Err("PostgreSQL 布尔编码无效".into()),
            }),
            "text" => DataValue::Text(text()?.into()),
            "text_hex" => DataValue::Text(
                String::from_utf8(unhex(text()?)?).map_err(|_| "PostgreSQL 文本不是有效UTF-8")?,
            ),
            "binary" => DataValue::Binary(unhex(text()?)?),
            "date" | "timestamp" | "timestamptz" | "time" => DataValue::Temporal {
                kind: kind.into(),
                value: text()?.into(),
            },
            "uuid" => {
                let value = text()?.replace('-', "");
                let bytes = unhex(&value)?;
                DataValue::Uuid(bytes.try_into().map_err(|_| "PostgreSQL UUID 长度无效")?)
            }
            _ => return Err("unsupported_capability: PostgreSQL 值类型未验证".into()),
        });
    }
    let key = projection
        .key_indices
        .iter()
        .map(|i| {
            values
                .get(*i)
                .cloned()
                .ok_or_else(|| "PostgreSQL 定位键索引无效".into())
        })
        .collect::<Result<Vec<_>, String>>()?;
    CanonicalRow::new(projection.output_table.clone(), key, values)
}
fn snapshot_sql(
    schema: &str,
    projections: &[Projection],
    metadata: &DataMetadataSnapshot,
) -> Result<String, String> {
    if projections.is_empty() || projections.len() > 100 {
        return Err("resource_limit: 集合快照须包含 1 至 100 张表".into());
    }
    let mut parts = Vec::new();
    for (index, p) in projections.iter().enumerate() {
        let table = metadata
            .tables
            .iter()
            .find(|t| t.name == p.table && t.physical)
            .ok_or("invalid_mapping: PostgreSQL 快照表不是普通物理表")?;
        let mut cells = Vec::new();
        let mut lengths = Vec::new();
        for name in &p.columns {
            let column = table
                .columns
                .iter()
                .find(|c| &c.name == name)
                .ok_or("invalid_mapping: PostgreSQL 快照字段不存在")?;
            let kind = wire_type(&column.declared_type)?;
            let column = id(name);
            lengths.push(if kind == "binary" {
                format!("COALESCE(octet_length({column}),0)")
            } else {
                format!("COALESCE(octet_length({column}::text),0)")
            });
            let value = if kind == "binary" {
                format!("encode({column},'hex')")
            } else if kind == "text" {
                format!("encode(convert_to({column},'UTF8'),'hex')")
            } else {
                format!("{column}::text")
            };
            let kind = if kind == "text" { "text_hex" } else { kind };
            cells.push(format!("CASE WHEN {column} IS NULL THEN json_build_object('t','null','v',NULL) ELSE json_build_object('t','{kind}','v',{value}) END"));
        }
        if cells.is_empty() {
            return Err("invalid_mapping: PostgreSQL 快照字段不能为空".into());
        }
        let payload = cells
            .chunks(64)
            .map(|chunk| format!("jsonb_build_array({})", chunk.join(",")))
            .collect::<Vec<_>>()
            .join(" || ");
        parts.push(format!("SELECT {index}::bigint AS __data_table,CASE WHEN {} > 8388608 THEN '{{\"resource_limit\":true}}' ELSE ({payload})::text END AS __data_payload FROM {}.{}",lengths.join(" + "),id(schema),id(&p.table)));
    }
    let sql = parts.join(" UNION ALL ");
    if sql.len() > 1024 * 1024 {
        return Err("resource_limit: 集合快照 SQL 超过 1 MiB".into());
    }
    Ok(sql)
}
#[derive(Debug)]
struct PgValue(DataValue);
impl ToSql for PgValue {
    fn to_sql(
        &self,
        ty: &Type,
        out: &mut BytesMut,
    ) -> Result<IsNull, Box<dyn std::error::Error + Send + Sync>> {
        let text = match &self.0 {
            DataValue::Null => return Ok(IsNull::Yes),
            DataValue::Bool(v) if *ty == Type::BOOL => {
                if *v {
                    "true".into()
                } else {
                    "false".into()
                }
            }
            DataValue::Int(v)
                if matches!(*ty, Type::INT2 | Type::INT4 | Type::INT8 | Type::NUMERIC) =>
            {
                v.to_string()
            }
            DataValue::UInt(v)
                if matches!(*ty, Type::INT2 | Type::INT4 | Type::INT8 | Type::NUMERIC) =>
            {
                v.to_string()
            }
            DataValue::Decimal(v) if *ty == Type::NUMERIC => normalize_decimal(v)?,
            DataValue::Float(bits) if matches!(*ty, Type::FLOAT4 | Type::FLOAT8) => {
                let v = f64::from_bits(*bits);
                if !v.is_finite() {
                    return Err("非有限浮点数未经验证".into());
                }
                v.to_string()
            }
            DataValue::Text(v) if matches!(*ty, Type::TEXT | Type::VARCHAR | Type::BPCHAR) => {
                v.clone()
            }
            DataValue::Binary(v) if *ty == Type::BYTEA => format!("\\x{}", hex(v)),
            DataValue::Temporal { value, .. }
                if matches!(
                    *ty,
                    Type::DATE | Type::TIME | Type::TIMESTAMP | Type::TIMESTAMPTZ
                ) =>
            {
                value.clone()
            }
            DataValue::Uuid(v) if *ty == Type::UUID => hex(v),
            _ => return Err("PostgreSQL 参数值与目标原生类型不兼容".into()),
        };
        out.extend_from_slice(text.as_bytes());
        Ok(IsNull::No)
    }
    fn accepts(ty: &Type) -> bool {
        matches!(
            *ty,
            Type::BOOL
                | Type::INT2
                | Type::INT4
                | Type::INT8
                | Type::NUMERIC
                | Type::FLOAT4
                | Type::FLOAT8
                | Type::TEXT
                | Type::VARCHAR
                | Type::BPCHAR
                | Type::BYTEA
                | Type::DATE
                | Type::TIME
                | Type::TIMESTAMP
                | Type::TIMESTAMPTZ
                | Type::UUID
        )
    }
    fn encode_format(&self, _ty: &Type) -> Format {
        Format::Text
    }
    tokio_postgres::types::to_sql_checked!();
}
#[derive(Clone)]
struct Sequence {
    table: String,
    column: String,
    schema: String,
    name: String,
    safe: bool,
    owner: String,
}
struct PgSession {
    client: Option<deadpool_postgres::Client>,
    active: Option<ActiveConnection>,
    config: ConnectionConfig,
    schema: String,
    cancel: Cancellation,
    metadata: Option<DataMetadataSnapshot>,
    identity: Option<EndpointIdentity>,
    sequences: Vec<Sequence>,
    locked_tables: Vec<String>,
}
impl Drop for PgSession {
    fn drop(&mut self) {
        if let Some(client) = self.client.take() {
            drop(deadpool_postgres::Object::take(client));
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
pub async fn open(
    config: ConnectionConfig,
    endpoint: DataEndpoint,
    cancel: Cancellation,
) -> Result<Box<dyn DataSession>, String> {
    checked(&cancel)?;
    if config.database_type != DatabaseType::Postgres || endpoint.database.is_empty() {
        return Err("invalid_mapping: PostgreSQL 端点无效".into());
    }
    let (_, active) = ConnectionManager::prepare_connection(config.clone())
        .await
        .map_err(|_| DB_ERROR)?;
    let client = match &active.database {
        ActiveDatabaseConnection::Postgres(pg) => {
            pg.adapter.pool_clone().get().await.map_err(|_| DB_ERROR)?
        }
        _ => return Err(DB_ERROR.into()),
    };
    client.batch_execute("SET TIME ZONE 'UTC'; SET datestyle='ISO, YMD'; SET extra_float_digits=3; SET lock_timeout='10s'; SET statement_timeout='0'").await.map_err(db_error)?;
    Ok(Box::new(PgSession {
        client: Some(client),
        active: Some(active),
        config,
        schema: endpoint.database,
        cancel,
        metadata: None,
        identity: None,
        sequences: vec![],
        locked_tables: vec![],
    }))
}
impl PgSession {
    fn client(&self) -> Result<&deadpool_postgres::Client, String> {
        self.client
            .as_ref()
            .ok_or_else(|| "PostgreSQL 专属会话已关闭".into())
    }
    async fn metadata_inner(&mut self) -> Result<DataMetadataSnapshot, String> {
        checked(&self.cancel)?;
        // 5 类固定 SQL：实例/权限、表列/继承、全部入出向约束及索引、触发器/写规则、列专属序列。
        let facts=self.client()?.query_one("SELECT system_identifier::text,current_database(),pg_is_in_recovery(),current_setting('default_transaction_read_only')='on',current_setting('server_version_num'),has_schema_privilege($1,'USAGE') FROM pg_control_system()",&[&self.schema]).await.map_err(|_|"unsupported_capability: 需要读取 PostgreSQL 实例身份以防止网络别名指向同一物理目标")?;
        let version = string(&facts, 4)?
            .parse::<u32>()
            .map_err(|_| "PostgreSQL 版本无效")?;
        if !(170000..180000).contains(&version) {
            return Err("unsupported_capability: PostgreSQL 数据任务当前仅验证17版本系列".into());
        }
        let read_only = facts.try_get::<_, bool>(2).map_err(db_error)?
            || facts.try_get::<_, bool>(3).map_err(db_error)?
            || self.config.read_only.unwrap_or(false);
        self.identity = Some(EndpointIdentity {
            database_type: DatabaseType::Postgres,
            instance: Some(string(&facts, 0)?),
            database: format!("{}.{}", string(&facts, 1)?, self.schema),
            sqlite_path: None,
        });
        let rows=self.client()?.query("SELECT c.relname,c.relkind::text,c.relrowsecurity OR c.relforcerowsecurity,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid),a.attgenerated<>'',a.attidentity<>'',COALESCE((SELECT k.ordinality::int FROM pg_index i CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality) WHERE i.indrelid=c.oid AND i.indisprimary AND k.attnum=a.attnum),0),COALESCE(coll.collname,''),has_table_privilege(c.oid,'SELECT'),has_table_privilege(c.oid,'INSERT') AND has_table_privilege(c.oid,'UPDATE') AND has_table_privilege(c.oid,'DELETE'),a.atttypid::regtype::text,EXISTS(SELECT 1 FROM pg_inherits inh WHERE inh.inhrelid=c.oid OR inh.inhparent=c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation coll ON coll.oid=a.attcollation WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','f') ORDER BY c.relname,a.attnum",&[&self.schema]).await.map_err(db_error)?;
        let mut tables: BTreeMap<String, DataTable> = BTreeMap::new();
        let schema_usage = facts.try_get::<_, bool>(5).map_err(db_error)?;
        let mut permissions = schema_usage;
        let mut writable = schema_usage;
        for row in rows {
            let name = string(&row, 0)?;
            let kind = string(&row, 1)?;
            let rls = row.try_get::<_, bool>(2).map_err(db_error)?;
            permissions &= row.try_get::<_, bool>(11).map_err(db_error)? && !rls;
            writable &= row.try_get::<_, bool>(12).map_err(db_error)? && !rls;
            let default: Option<String> = row.try_get(6).map_err(db_error)?;
            let identity = row.try_get::<_, bool>(8).map_err(db_error)?
                || default.as_ref().is_some_and(|d| d.contains("nextval("));
            let collation = string(&row, 10)?;
            let raw_type = string(&row, 13)?;
            let inherited = row.try_get::<_, bool>(14).map_err(db_error)?;
            let table = tables.entry(name.clone()).or_insert(DataTable {
                name,
                create_sql: format!("relkind:{kind};rls:{rls};inherited:{inherited}"),
                columns: vec![],
                foreign_keys: vec![],
                enabled_user_triggers: false,
                physical: kind == "r" && !inherited,
            });
            table.columns.push(DataColumn {
                name: string(&row, 3)?,
                declared_type: string(&row, 4)?.to_ascii_uppercase(),
                nullable: !row.try_get::<_, bool>(5).map_err(db_error)?,
                default_sql: default,
                generated: row.try_get(7).map_err(db_error)?,
                primary_key_ordinal: row.try_get::<_, i32>(9).map_err(db_error)? as u32,
                collation: if raw_type != "character" && matches!(collation.as_str(), "C" | "POSIX")
                {
                    Some("BINARY".into())
                } else {
                    Some(collation.clone())
                },
                identity,
                generator_safe: false,
            });
            table.create_sql.push_str(&format!(
                "\ncollation:{collation};{}",
                serde_json::to_string(table.columns.last().unwrap()).map_err(|_| DB_ERROR)?
            ));
        }
        let rows=self.client()?.query("SELECT c.relname,con.contype::text,con.conname,pg_get_constraintdef(con.oid,true),con.convalidated,COALESCE(pn.nspname,''),COALESCE(pc.relname,''),COALESCE((SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.num),ARRAY[]::text[]),COALESCE((SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.num),ARRAY[]::text[]),con.confupdtype::text,con.confdeltype::text,n.nspname FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_class pc ON pc.oid=con.confrelid LEFT JOIN pg_namespace pn ON pn.oid=pc.relnamespace WHERE n.nspname=$1 OR (con.contype='f' AND pn.nspname=$1) UNION ALL SELECT c.relname,'index',i.relname,pg_get_indexdef(ix.indexrelid),ix.indisvalid,'','',ARRAY[]::text[],ARRAY[]::text[],'','',n.nspname FROM pg_index ix JOIN pg_class c ON c.oid=ix.indrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_class i ON i.oid=ix.indexrelid WHERE n.nspname=$1 ORDER BY 1,2,3",&[&self.schema]).await.map_err(db_error)?;
        // catalog 查询不会按当前用户的业务表权限过滤；读取失败直接拒绝，不静默省略约束。
        // 外部依赖只作为图节点保存。NUL 前缀不能出现在真实 PostgreSQL 标识符中，避免名称冲突。
        for row in rows {
            let name = string(&row, 0)?;
            let namespace = string(&row, 11)?;
            let name = if namespace == self.schema {
                name
            } else {
                let external = format!("\0external:{namespace}.{name}");
                tables.entry(external.clone()).or_insert_with(|| DataTable {
                    name: external.clone(),
                    create_sql: String::new(),
                    columns: vec![],
                    foreign_keys: vec![],
                    enabled_user_triggers: false,
                    physical: false,
                });
                external
            };
            if let Some(table) = tables.get_mut(&name) {
                table.create_sql.push_str(&format!(
                    "\n{}:{}:{}:{}",
                    string(&row, 1)?,
                    string(&row, 2)?,
                    string(&row, 3)?,
                    row.try_get::<_, bool>(4).map_err(db_error)?
                ));
                if string(&row, 1)? == "f" {
                    let parent_schema = string(&row, 5)?;
                    let parent = string(&row, 6)?;
                    let action = |s: String| {
                        match s.as_str() {
                            "a" => "NO ACTION",
                            "r" => "RESTRICT",
                            "c" => "CASCADE",
                            "n" => "SET NULL",
                            "d" => "SET DEFAULT",
                            _ => "UNKNOWN",
                        }
                        .to_string()
                    };
                    table.foreign_keys.push(DataForeignKey {
                        from_columns: row.try_get(7).map_err(db_error)?,
                        parent_table: if parent_schema == self.schema {
                            parent
                        } else {
                            format!("\0external:{parent_schema}.{parent}")
                        },
                        parent_columns: row.try_get(8).map_err(db_error)?,
                        on_update: action(string(&row, 9)?),
                        on_delete: action(string(&row, 10)?),
                    });
                }
            }
        }
        let rows=self.client()?.query("SELECT c.relname,t.tgname,t.tgenabled::text,pg_get_triggerdef(t.oid,true) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal UNION ALL SELECT c.relname,r.rulename,r.ev_enabled::text,pg_get_ruledef(r.oid,true) FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND r.ev_type<>'1' ORDER BY 1,2,4",&[&self.schema]).await.map_err(db_error)?;
        for row in rows {
            if let Some(table) = tables.get_mut(&string(&row, 0)?) {
                table.enabled_user_triggers |= string(&row, 2)? != "D";
                table.create_sql.push_str(&format!(
                    "\nwrite_effect:{}:{}:{}",
                    string(&row, 1)?,
                    string(&row, 2)?,
                    string(&row, 3)?
                ));
            }
        }
        let rows=self.client()?.query("SELECT c.relname,a.attname,sn.nspname,s.relname,p.seqincrement,p.seqcache,p.seqcycle,pg_has_role(s.relowner,'MEMBER'),has_sequence_privilege(s.oid,'USAGE,SELECT,UPDATE'),(SELECT count(*) FROM pg_depend x WHERE x.refobjid=s.oid AND x.classid='pg_attrdef'::regclass),p.seqstart,p.seqmin,p.seqmax,pg_get_userbyid(s.relowner) FROM pg_class s JOIN pg_namespace sn ON sn.oid=s.relnamespace JOIN pg_sequence p ON p.seqrelid=s.oid JOIN pg_depend dep ON dep.objid=s.oid AND dep.classid='pg_class'::regclass AND dep.deptype IN ('a','i') JOIN pg_class c ON c.oid=dep.refobjid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=dep.refobjsubid WHERE n.nspname=$1 ORDER BY c.relname,a.attnum",&[&self.schema]).await.map_err(db_error)?;
        self.sequences.clear();
        for row in rows {
            let table = string(&row, 0)?;
            let column = string(&row, 1)?;
            let safe = row.try_get::<_, i64>(4).map_err(db_error)? == 1
                && row.try_get::<_, i64>(5).map_err(db_error)? == 1
                && !row.try_get::<_, bool>(6).map_err(db_error)?
                && row.try_get::<_, bool>(7).map_err(db_error)?
                && row.try_get::<_, bool>(8).map_err(db_error)?
                && row.try_get::<_, i64>(9).map_err(db_error)? <= 1;
            self.sequences.push(Sequence {
                table: table.clone(),
                column: column.clone(),
                schema: string(&row, 2)?,
                name: string(&row, 3)?,
                safe,
                owner: string(&row, 13)?,
            });
            if let Some(table) = tables.get_mut(&table) {
                if let Some(c) = table.columns.iter_mut().find(|c| c.name == column) {
                    c.generator_safe = safe;
                }
                table.create_sql.push_str(&format!(
                    "\nsequence:{}:{}:{}:{}:{}:{}:{}:{}",
                    string(&row, 2)?,
                    string(&row, 3)?,
                    row.try_get::<_, i64>(4).map_err(db_error)?,
                    row.try_get::<_, i64>(5).map_err(db_error)?,
                    row.try_get::<_, bool>(6).map_err(db_error)?,
                    row.try_get::<_, i64>(10).map_err(db_error)?,
                    row.try_get::<_, i64>(11).map_err(db_error)?,
                    row.try_get::<_, i64>(12).map_err(db_error)?
                ));
            }
        }
        // 在任何业务DML之前锁定序列；与表锁同事务持有，阻止独立会话nextval/结构变更。
        let mut sequence_locks = Vec::new();
        for sequence in &self.sequences {
            if self.locked_tables.contains(&sequence.table) {
                if !sequence.safe {
                    return Err("unsupported_capability: PostgreSQL 序列不满足专属、递增、CACHE 1及权限条件".into());
                }
                sequence_locks.push(format!(
                    "ALTER SEQUENCE {}.{} OWNER TO {}",
                    id(&sequence.schema),
                    id(&sequence.name),
                    id(&sequence.owner)
                ));
            }
        }
        if !sequence_locks.is_empty() {
            self.client()?
                .batch_execute(&sequence_locks.join("; "))
                .await
                .map_err(db_error)?;
        }
        let tables = tables.into_values().collect::<Vec<_>>();
        let schema_fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&tables).map_err(|_| DB_ERROR)?)
        );
        let metadata = DataMetadataSnapshot {
            database_type: DatabaseType::Postgres,
            tables,
            read_only,
            permissions_verified: permissions,
            consistent_snapshot: true,
            protected_write: writable,
            schema_fingerprint,
            configuration_fingerprint: crate::db::data_tasks::executor::configuration_fingerprint(
                &self.config,
            ),
        };
        self.metadata = Some(metadata.clone());
        Ok(metadata)
    }
}
impl DataSession for PgSession {
    fn endpoint_identity(&self) -> Option<EndpointIdentity> {
        self.identity.clone()
    }
    fn dialect(&self) -> Dialect {
        Dialect::Postgres
    }
    fn begin_read(&mut self) -> SessionFuture<'_, ()> {
        Box::pin(async move {
            checked(&self.cancel)?;
            self.client()?
                .batch_execute("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
                .await
                .map_err(db_error)
        })
    }
    fn begin_protected_write(&mut self, mut tables: Vec<String>) -> SessionFuture<'_, ()> {
        Box::pin(async move {
            checked(&self.cancel)?;
            if self.config.read_only.unwrap_or(false) {
                return Err("read_only_target: 目标保存连接为只读".into());
            }
            if tables.is_empty() || tables.len() > 100 {
                return Err("invalid_mapping: 目标表范围无效".into());
            }
            tables.sort();
            tables.dedup();
            let list = tables
                .iter()
                .map(|t| format!("{}.{}", id(&self.schema), id(t)))
                .collect::<Vec<_>>()
                .join(",");
            self.client()?.batch_execute(&format!("BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL lock_timeout='10s'; LOCK TABLE {list} IN ACCESS EXCLUSIVE MODE")).await.map_err(db_error)?;
            self.locked_tables = tables;
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
                &self.schema,
                &projections,
                self.metadata
                    .as_ref()
                    .ok_or("必须先批量加载 PostgreSQL 元数据")?,
            )?;
            let client = self.client()?;
            let stream = client
                .query_raw(&sql, std::iter::empty::<&(dyn ToSql + Sync)>())
                .await
                .map_err(db_error)?;
            pin_mut!(stream);
            let mut count = 0;
            loop {
                let row = tokio::select! {row=stream.try_next()=>row.map_err(db_error)?,_=async{while !cancel.load(Ordering::Acquire){tokio::time::sleep(Duration::from_millis(50)).await;}}=>return Err("cancelled: PostgreSQL 集合读取已取消，专属会话将关闭".into())};
                let Some(row) = row else {
                    break;
                };
                checked(&cancel)?;
                let projection = projections
                    .get(row.try_get::<_, i64>(0).map_err(db_error)? as usize)
                    .ok_or("PostgreSQL 集合表序号无效")?;
                let payload: &str = row.try_get(1).map_err(db_error)?;
                let lease = sender
                    .reserve_decode(payload.len().saturating_mul(3))
                    .await?;
                let decoded = decode_payload(projection, payload)?;
                drop(row);
                drop(lease);
                sender
                    .send(decoded)
                    .await
                    .map_err(|_| "数据快照通道已关闭")?;
                count += 1;
            }
            Ok(count)
        })
    }
    fn write_batch(&mut self, mut batch: WriteBatch) -> SessionFuture<'_, u64> {
        Box::pin(async move {
            checked(&self.cancel)?;
            if batch.kind == DataDiffOperation::Insert
                && self
                    .metadata
                    .as_ref()
                    .and_then(|m| m.tables.iter().find(|t| t.name == batch.table))
                    .is_some_and(|t| {
                        t.columns
                            .iter()
                            .any(|c| c.identity && batch.columns.contains(&c.name))
                    })
            {
                batch.sql = batch
                    .sql
                    .replacen(" VALUES ", " OVERRIDING SYSTEM VALUE VALUES ", 1);
            }
            let values = batch.params.into_iter().map(PgValue).collect::<Vec<_>>();
            let params = values
                .iter()
                .map(|v| v as &(dyn ToSql + Sync))
                .collect::<Vec<_>>();
            self.client()?
                .execute(&batch.sql, &params)
                .await
                .map_err(db_error)
        })
    }
    fn delete_all(&mut self, table: String) -> SessionFuture<'_, u64> {
        Box::pin(async move {
            checked(&self.cancel)?;
            self.client()?
                .execute(
                    &format!("DELETE FROM {}.{}", id(&self.schema), id(&table)),
                    &[],
                )
                .await
                .map_err(db_error)
        })
    }
    fn maintain_generators(
        &mut self,
        mapping: Vec<ValidatedTableMapping>,
    ) -> SessionFuture<'_, ()> {
        Box::pin(async move {
            checked(&self.cancel)?;
            let mut parts = Vec::new();
            for sequence in &self.sequences {
                if mapping.iter().any(|m| {
                    m.target_table == sequence.table && m.target_columns.contains(&sequence.column)
                }) {
                    if !sequence.safe {
                        return Err("unsupported_capability: PostgreSQL 序列不能安全推进".into());
                    }
                    let name = format!("{}.{}", id(&sequence.schema), id(&sequence.name));
                    let table = format!("{}.{}", id(&self.schema), id(&sequence.table));
                    let literal = crate::db::sql_utils::pg_str(&name);
                    parts.push(format!("SELECT CASE WHEN max({column}) IS NULL THEN NULL ELSE setval({literal}::regclass,GREATEST(max({column})::bigint,(SELECT last_value FROM {name})),true) END FROM {table}",column=id(&sequence.column)));
                }
            }
            if !parts.is_empty() {
                self.client()?
                    .query(&parts.join(" UNION ALL "), &[])
                    .await
                    .map_err(db_error)?;
            }
            Ok(())
        })
    }
    fn commit(&mut self) -> SessionFuture<'_, ()> {
        Box::pin(async move {
            self.client()?
                .batch_execute("COMMIT")
                .await
                .map_err(db_error)?;
            self.locked_tables.clear();
            Ok(())
        })
    }
    fn rollback(&mut self) -> SessionFuture<'_, ()> {
        Box::pin(async move {
            self.client()?
                .batch_execute("ROLLBACK")
                .await
                .map_err(db_error)?;
            self.locked_tables.clear();
            Ok(())
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn postgres_lossless_payload_does_not_parse_decimal_or_int_through_float() {
        let p = Projection {
            table: "t".into(),
            output_table: "t".into(),
            columns: vec!["n".into(), "d".into(), "b".into(), "z".into()],
            key_indices: vec![0],
        };
        let row=decode_payload(&p,r#"[{"t":"int","v":"9223372036854775807"},{"t":"decimal","v":"12345678901234567890.1234567890"},{"t":"binary","v":"00ff"},{"t":"null","v":null}]"#).unwrap();
        assert_eq!(row.values[0], DataValue::Int(i64::MAX));
        assert_eq!(
            row.values[1],
            DataValue::Decimal("12345678901234567890.123456789".into())
        );
        assert_eq!(row.values[2], DataValue::Binary(vec![0, 255]));
        assert_eq!(row.values[3], DataValue::Null);
    }
    #[tokio::test]
    #[ignore = "需专属隔离PostgreSQL，必须设置 DB_CONNECT_DATA_TASK_PG_URL"]
    async fn real_postgres_native_snapshot_and_lock_contract() {
        let url = std::env::var("DB_CONNECT_DATA_TASK_PG_URL")
            .expect("缺少专属PostgreSQL夹具URL，不得将跳过计为通过");
        let pg: tokio_postgres::Config = url.parse().unwrap();
        let (client, connection) = pg.connect(tokio_postgres::NoTls).await.unwrap();
        let driver = tokio::spawn(async move {
            connection.await.unwrap();
        });
        let schema = format!("dbconnect_task_{}", uuid::Uuid::new_v4().simple());
        client.batch_execute(&format!("CREATE SCHEMA {schema}; CREATE TABLE {schema}.t(id BIGINT PRIMARY KEY,v NUMERIC(40,10),b BYTEA); CREATE TABLE {schema}.other(label TEXT); INSERT INTO {schema}.t VALUES(9223372036854775807,12345678901234567890.1234567890,decode('00ff','hex')); INSERT INTO {schema}.other VALUES('中文');")).await.unwrap();
        let host = match &pg.get_hosts()[0] {
            tokio_postgres::config::Host::Tcp(h) => h.clone(),
            _ => panic!("夹具必须TCP"),
        };
        let config:ConnectionConfig=serde_json::from_value(serde_json::json!({"database_type":"postgres","name":"isolated","host":host,"port":pg.get_ports().first().copied().unwrap_or(5432),"username":pg.get_user().unwrap_or("postgres"),"password":String::from_utf8_lossy(pg.get_password().unwrap_or_default()),"database":pg.get_dbname().unwrap_or("postgres")})).unwrap();
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let mut session = open(
            config,
            DataEndpoint {
                saved_connection_id: "fixture".into(),
                database: schema.clone(),
            },
            cancel.clone(),
        )
        .await
        .unwrap();
        session.begin_read().await.unwrap();
        let metadata = session.load_metadata().await.unwrap();
        assert_eq!(metadata.tables.len(), 2);
        let projections = vec![
            Projection {
                table: "t".into(),
                output_table: "t".into(),
                columns: vec!["id".into(), "v".into(), "b".into()],
                key_indices: vec![0],
            },
            Projection {
                table: "other".into(),
                output_table: "other".into(),
                columns: vec!["label".into()],
                key_indices: vec![],
            },
        ];
        let (tx, mut rx) =
            RowSender::channel(crate::db::data_tasks::spool::ResourceBudget::default());
        let read = tokio::spawn(async move {
            let mut rows = Vec::new();
            while let Some(row) = rx.recv().await {
                rows.push(row.row);
            }
            rows
        });
        assert_eq!(
            session.stream_rows(projections, cancel, tx).await.unwrap(),
            2
        );
        let rows = read.await.unwrap();
        assert_eq!(rows[0].values[0], DataValue::Int(i64::MAX));
        assert_eq!(
            rows[0].values[1],
            DataValue::Decimal("12345678901234567890.123456789".into())
        );
        session.rollback().await.unwrap();
        session
            .begin_protected_write(vec!["t".into()])
            .await
            .unwrap();
        session.load_metadata().await.unwrap();
        client
            .batch_execute("SET lock_timeout='150ms'")
            .await
            .unwrap();
        assert!(client
            .batch_execute(&format!("INSERT INTO {schema}.t(id) VALUES(2)"))
            .await
            .is_err());
        session.rollback().await.unwrap();
        client
            .batch_execute(&format!("DROP SCHEMA {schema} CASCADE"))
            .await
            .unwrap();
        drop(session);
        drop(client);
        let _ = driver.await;
    }
}

#[cfg(test)]
mod end_to_end_tests {
    use super::*;
    use crate::{
        db::data_tasks::{
            executor::{execute_plan, prepare_task},
            Cancellation,
        },
        models::data_tasks::*,
    };
    use std::sync::{atomic::AtomicBool, Arc};
    #[tokio::test]
    #[ignore = "需专属隔离PostgreSQL，DB_CONNECT_DATA_TASK_PG_URL"]
    async fn real_postgres_end_to_end_merge_stale_and_rollback() {
        let url = std::env::var("DB_CONNECT_DATA_TASK_PG_URL").expect("缺少专属PostgreSQL夹具");
        let pg: tokio_postgres::Config = url.parse().unwrap();
        let (client, driver) = pg.connect(tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = driver.await;
        });
        let name = format!("dbconnect_e2e_{}", uuid::Uuid::new_v4().simple());
        let source = format!("{name}_s");
        let target = format!("{name}_t");
        client.batch_execute(&format!("CREATE SCHEMA {source};CREATE SCHEMA {target};CREATE TABLE {source}.t(id BIGINT PRIMARY KEY,v NUMERIC(40,10));CREATE TABLE {target}.t(LIKE {source}.t INCLUDING ALL);INSERT INTO {source}.t VALUES(1,12345678901234567890.1234567890),(2,2);INSERT INTO {target}.t VALUES(2,9),(3,3);")).await.unwrap();
        let host = match &pg.get_hosts()[0] {
            tokio_postgres::config::Host::Tcp(h) => h.clone(),
            _ => panic!("需要TCP夹具"),
        };
        let config:ConnectionConfig=serde_json::from_value(serde_json::json!({"database_type":"postgres","name":"isolated","host":host,"port":pg.get_ports().first().copied().unwrap_or(5432),"username":pg.get_user().unwrap_or("postgres"),"password":String::from_utf8_lossy(pg.get_password().unwrap_or_default()),"database":pg.get_dbname().unwrap_or("postgres")})).unwrap();
        let endpoint = |id: &str, database: String| DataEndpoint {
            saved_connection_id: id.into(),
            database,
        };
        let request = DataTaskRequest {
            protocol_version: 1,
            kind: DataTaskKind::RowSync,
            source: endpoint("s", source.clone()),
            target: endpoint("t", target.clone()),
            mappings: vec![TableMapping {
                source_table: "t".into(),
                target_table: "t".into(),
                columns: vec![
                    ColumnMapping {
                        source_column: "id".into(),
                        target_column: "id".into(),
                    },
                    ColumnMapping {
                        source_column: "v".into(),
                        target_column: "v".into(),
                    },
                ],
            }],
            mode: DataTaskMode::Merge,
        };
        let cancel = || -> Cancellation { Arc::new(AtomicBool::new(false)) };
        let dir = std::env::temp_dir().join(&name);
        let plan = prepare_task(
            "pg-e2e".into(),
            request.clone(),
            config.clone(),
            config.clone(),
            dir.clone(),
            cancel(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        client
            .batch_execute(&format!("UPDATE {source}.t SET v=999 WHERE id=1"))
            .await
            .unwrap();
        let result = execute_plan(
            Arc::new(plan),
            config.clone(),
            config.clone(),
            cancel(),
            Arc::new(|_| {}),
        )
        .await;
        assert_eq!(
            result.status,
            DataTaskStatus::Succeeded,
            "{:?}",
            result.error
        );
        let value: String = client
            .query_one(&format!("SELECT v::text FROM {target}.t WHERE id=1"), &[])
            .await
            .unwrap()
            .get(0);
        assert_eq!(value, "12345678901234567890.1234567890");
        let plan = prepare_task(
            "pg-stale".into(),
            request,
            config.clone(),
            config.clone(),
            dir.clone(),
            cancel(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        client
            .batch_execute(&format!("INSERT INTO {target}.t VALUES(4,4)"))
            .await
            .unwrap();
        let result = execute_plan(
            Arc::new(plan),
            config.clone(),
            config,
            cancel(),
            Arc::new(|_| {}),
        )
        .await;
        assert_eq!(result.error.unwrap().code, "plan_stale");
        assert_eq!(
            client
                .query_one(&format!("SELECT count(*) FROM {target}.t"), &[])
                .await
                .unwrap()
                .get::<_, i64>(0),
            4
        );
        client
            .batch_execute(&format!(
                "DROP SCHEMA {source} CASCADE;DROP SCHEMA {target} CASCADE"
            ))
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(dir);
    }
}
#[cfg(test)]
mod atomicity_tests {
    use super::*;
    use crate::{
        db::data_tasks::{
            executor::{execute_plan, prepare_task},
            Cancellation,
        },
        models::data_tasks::*,
    };
    use std::sync::{atomic::AtomicBool, Arc};
    async fn fixture() -> (tokio_postgres::Client, ConnectionConfig, String, String) {
        let url = std::env::var("DB_CONNECT_DATA_TASK_PG_URL").expect("需要专属PostgreSQL夹具URL");
        let pg: tokio_postgres::Config = url.parse().unwrap();
        let (client, connection) = pg.connect(tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let name = format!("dbconnect_atomic_{}", uuid::Uuid::new_v4().simple());
        let source = format!("{name}_s");
        let target = format!("{name}_t");
        let host = match &pg.get_hosts()[0] {
            tokio_postgres::config::Host::Tcp(h) => h.clone(),
            _ => panic!("需要TCP夹具"),
        };
        let config=serde_json::from_value(serde_json::json!({"database_type":"postgres","name":"isolated","host":host,"port":pg.get_ports().first().copied().unwrap_or(5432),"username":pg.get_user().unwrap_or("postgres"),"password":String::from_utf8_lossy(pg.get_password().unwrap_or_default()),"database":pg.get_dbname().unwrap_or("postgres")})).unwrap();
        (client, config, source, target)
    }
    fn request(source: &str, target: &str, mode: DataTaskMode) -> DataTaskRequest {
        DataTaskRequest {
            protocol_version: 1,
            kind: if matches!(mode, DataTaskMode::Merge | DataTaskMode::Mirror) {
                DataTaskKind::RowSync
            } else {
                DataTaskKind::Transfer
            },
            source: DataEndpoint {
                saved_connection_id: "s".into(),
                database: source.into(),
            },
            target: DataEndpoint {
                saved_connection_id: "t".into(),
                database: target.into(),
            },
            mappings: vec![TableMapping {
                source_table: "t".into(),
                target_table: "t".into(),
                columns: vec![
                    ColumnMapping {
                        source_column: "id".into(),
                        target_column: "id".into(),
                    },
                    ColumnMapping {
                        source_column: "v".into(),
                        target_column: "v".into(),
                    },
                ],
            }],
            mode,
        }
    }
    fn cancel() -> Cancellation {
        Arc::new(AtomicBool::new(false))
    }
    #[tokio::test]
    #[ignore = "需专属隔离PostgreSQL，DB_CONNECT_DATA_TASK_PG_URL"]
    async fn real_postgres_identity_sequence_lock_cancel_and_default_insert() {
        let (client, config, source, target) = fixture().await;
        let schema = "t(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,v TEXT NOT NULL)";
        client.batch_execute(&format!("CREATE SCHEMA {source};CREATE SCHEMA {target};CREATE TABLE {source}.{schema};CREATE TABLE {target}.{schema};INSERT INTO {source}.t OVERRIDING SYSTEM VALUE VALUES(1,'new'),(5000,'high');INSERT INTO {target}.t OVERRIDING SYSTEM VALUE VALUES(1,'old');")).await.unwrap();
        let directory = std::env::temp_dir().join(&source);
        let token = cancel();
        let plan = prepare_task(
            "identity-cancel".into(),
            request(&source, &target, DataTaskMode::Merge),
            config.clone(),
            config.clone(),
            directory.clone(),
            token.clone(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        let signal = token.clone();
        let result = execute_plan(
            Arc::new(plan),
            config.clone(),
            config.clone(),
            token,
            Arc::new(move |p| {
                if p.status == DataTaskStatus::Verifying {
                    signal.store(true, Ordering::Release);
                }
            }),
        )
        .await;
        assert_eq!(
            result.status,
            DataTaskStatus::Cancelled,
            "{:?}",
            result.error
        );
        assert_eq!(result.commit_state, DataCommitState::RolledBack);
        assert_eq!(
            client
                .query_one(&format!("SELECT v FROM {target}.t WHERE id=1"), &[])
                .await
                .unwrap()
                .get::<_, String>(0),
            "old"
        );
        assert_eq!(
            client
                .query_one(&format!("SELECT count(*) FROM {target}.t"), &[])
                .await
                .unwrap()
                .get::<_, i64>(0),
            1
        );
        let allocated = client
            .query_one(
                &format!("INSERT INTO {target}.t(v) VALUES('independent') RETURNING id"),
                &[],
            )
            .await
            .unwrap()
            .get::<_, i64>(0);
        assert!(allocated > 5000, "回滚后的序列不得回退至显式插入键以下");
        let token = cancel();
        let plan = prepare_task(
            "identity-success".into(),
            request(&source, &target, DataTaskMode::Merge),
            config.clone(),
            config.clone(),
            directory.clone(),
            token.clone(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        let result = execute_plan(
            Arc::new(plan),
            config.clone(),
            config.clone(),
            token,
            Arc::new(|_| {}),
        )
        .await;
        assert_eq!(
            result.status,
            DataTaskStatus::Succeeded,
            "{:?}",
            result.error
        );
        let next = client
            .query_one(
                &format!("INSERT INTO {target}.t(v) VALUES('after') RETURNING id"),
                &[],
            )
            .await
            .unwrap()
            .get::<_, i64>(0);
        assert!(next > allocated);
        let mut session = open(
            config,
            DataEndpoint {
                saved_connection_id: "target".into(),
                database: target.clone(),
            },
            cancel(),
        )
        .await
        .unwrap();
        session
            .begin_protected_write(vec!["t".into()])
            .await
            .unwrap();
        session.load_metadata().await.unwrap();
        client
            .batch_execute("SET lock_timeout='150ms'")
            .await
            .unwrap();
        assert!(client
            .query_one(
                &format!("SELECT nextval(pg_get_serial_sequence('{target}.t','id'))"),
                &[]
            )
            .await
            .is_err());
        session.rollback().await.unwrap();
        client
            .batch_execute(&format!(
                "DROP SCHEMA {source} CASCADE;DROP SCHEMA {target} CASCADE"
            ))
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(directory);
    }
    #[tokio::test]
    #[ignore = "需专属隔离PostgreSQL，DB_CONNECT_DATA_TASK_PG_URL"]
    async fn real_postgres_append_late_conflict_and_verification_failure_roll_back() {
        let (client, config, source, target) = fixture().await;
        client.batch_execute(&format!("CREATE SCHEMA {source};CREATE SCHEMA {target};CREATE TABLE {source}.t(id BIGINT PRIMARY KEY,v TEXT NOT NULL);CREATE TABLE {target}.t(LIKE {source}.t INCLUDING ALL);INSERT INTO {source}.t SELECT n,'source' FROM generate_series(1,1200)n;INSERT INTO {target}.t VALUES(1100,'existing');")).await.unwrap();
        let directory = std::env::temp_dir().join(&source);
        let token = cancel();
        let plan = prepare_task(
            "late-conflict".into(),
            request(&source, &target, DataTaskMode::Append),
            config.clone(),
            config.clone(),
            directory.clone(),
            token.clone(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        let result = execute_plan(
            Arc::new(plan),
            config.clone(),
            config.clone(),
            token,
            Arc::new(|_| {}),
        )
        .await;
        assert_eq!(result.status, DataTaskStatus::Failed);
        assert_eq!(result.commit_state, DataCommitState::RolledBack);
        assert_eq!(
            client
                .query_one(&format!("SELECT count(*) FROM {target}.t"), &[])
                .await
                .unwrap()
                .get::<_, i64>(0),
            1
        );
        let token = cancel();
        let mut plan = prepare_task(
            "verify-failure".into(),
            request(&source, &target, DataTaskMode::Replace),
            config.clone(),
            config.clone(),
            directory.clone(),
            token.clone(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        plan.expected = plan.target.clone();
        let result = execute_plan(
            Arc::new(plan),
            config.clone(),
            config,
            token,
            Arc::new(|_| {}),
        )
        .await;
        assert_eq!(result.error.unwrap().code, "validation_failed");
        assert_eq!(result.commit_state, DataCommitState::RolledBack);
        assert_eq!(
            client
                .query_one(&format!("SELECT v FROM {target}.t"), &[])
                .await
                .unwrap()
                .get::<_, String>(0),
            "existing"
        );
        client
            .batch_execute(&format!(
                "DROP SCHEMA {source} CASCADE;DROP SCHEMA {target} CASCADE"
            ))
            .await
            .unwrap();
        let _ = std::fs::remove_dir_all(directory);
    }
    #[tokio::test]
    #[ignore = "需专属隔离PostgreSQL，DB_CONNECT_DATA_TASK_PG_URL"]
    async fn real_postgres_external_fk_and_inheritance_are_preflight_blocked() {
        let (client, config, source, target) = fixture().await;
        let outside = format!("{target}_external");
        client.batch_execute(&format!("CREATE SCHEMA {source};CREATE SCHEMA {target};CREATE SCHEMA {outside};CREATE TABLE {source}.t(id BIGINT PRIMARY KEY,v TEXT);CREATE TABLE {target}.t(LIKE {source}.t INCLUDING ALL);CREATE TABLE {outside}.ref(id BIGINT REFERENCES {target}.t(id));CREATE TABLE {target}.inherit_parent(id BIGINT);CREATE TABLE {target}.inherit_child(extra TEXT) INHERITS({target}.inherit_parent);")).await.unwrap();
        let directory = std::env::temp_dir().join(&source);
        let result = prepare_task(
            "external-fk".into(),
            request(&source, &target, DataTaskMode::Replace),
            config.clone(),
            config.clone(),
            directory.clone(),
            cancel(),
            Arc::new(|_| {}),
        )
        .await;
        assert!(result.is_err(), "外部schema入向外键必须阻塞整任务");
        let mut session = open(
            config,
            DataEndpoint {
                saved_connection_id: "t".into(),
                database: target.clone(),
            },
            cancel(),
        )
        .await
        .unwrap();
        session.begin_read().await.unwrap();
        let metadata = session.load_metadata().await.unwrap();
        assert!(
            !metadata
                .tables
                .iter()
                .find(|t| t.name == "inherit_parent")
                .unwrap()
                .physical
        );
        assert!(
            !metadata
                .tables
                .iter()
                .find(|t| t.name == "inherit_child")
                .unwrap()
                .physical
        );
        session.rollback().await.unwrap();
        client.batch_execute(&format!("DROP SCHEMA {outside} CASCADE;DROP SCHEMA {source} CASCADE;DROP SCHEMA {target} CASCADE")).await.unwrap();
        let _ = std::fs::remove_dir_all(directory);
    }

    #[tokio::test]
    #[ignore = "需专属隔离PostgreSQL，DB_CONNECT_DATA_TASK_PG_URL"]
    async fn real_postgres_inherited_rows_are_never_written_through_parent() {
        let (client, config, source, target) = fixture().await;
        let outside = format!("{target}_external");
        client.batch_execute(&format!("CREATE SCHEMA {source};CREATE SCHEMA {target};CREATE SCHEMA {outside};CREATE TABLE {source}.t(id BIGINT,v TEXT);CREATE TABLE {target}.t(id BIGINT,v TEXT);CREATE TABLE {outside}.child(extra TEXT) INHERITS({target}.t);INSERT INTO {outside}.child VALUES(1,'keep','child');")).await.unwrap();
        let directory = std::env::temp_dir().join(&source);
        let result = prepare_task(
            "inheritance".into(),
            request(&source, &target, DataTaskMode::Replace),
            config.clone(),
            config,
            directory.clone(),
            cancel(),
            Arc::new(|_| {}),
        )
        .await;
        let rejected = result.is_err();
        drop(result);
        let remaining = client
            .query_one(&format!("SELECT count(*) FROM {outside}.child"), &[])
            .await
            .unwrap()
            .get::<_, i64>(0);
        client.batch_execute(&format!("DROP SCHEMA {outside} CASCADE;DROP SCHEMA {source} CASCADE;DROP SCHEMA {target} CASCADE")).await.unwrap();
        let _ = std::fs::remove_dir_all(directory);
        assert!(
            rejected,
            "继承父表必须在预览阶段拒绝，不能把未选择的子表行纳入替换"
        );
        assert_eq!(remaining, 1);
    }
    #[tokio::test]
    #[ignore = "需专属隔离PostgreSQL，DB_CONNECT_DATA_TASK_PG_URL"]
    async fn real_postgres_write_rule_is_rejected_before_preview() {
        let (client, config, source, target) = fixture().await;
        let outside = format!("{target}_external");
        client.batch_execute(&format!("CREATE SCHEMA {source};CREATE SCHEMA {target};CREATE SCHEMA {outside};CREATE TABLE {source}.t(id BIGINT PRIMARY KEY,v TEXT);CREATE TABLE {target}.t(LIKE {source}.t INCLUDING ALL);CREATE TABLE {outside}.audit(id BIGINT);INSERT INTO {source}.t VALUES(1,'new');CREATE RULE audit_copy AS ON INSERT TO {target}.t DO ALSO INSERT INTO {outside}.audit VALUES(NEW.id);")).await.unwrap();
        let directory = std::env::temp_dir().join(&source);
        let result = prepare_task(
            "write-rule".into(),
            request(&source, &target, DataTaskMode::Append),
            config.clone(),
            config,
            directory.clone(),
            cancel(),
            Arc::new(|_| {}),
        )
        .await;
        let rejected = result.is_err();
        drop(result);
        let counts=client.query_one(&format!("SELECT (SELECT count(*) FROM {target}.t),(SELECT count(*) FROM {outside}.audit)"),&[]).await.unwrap();
        client.batch_execute(&format!("DROP SCHEMA {source} CASCADE;DROP SCHEMA {target} CASCADE;DROP SCHEMA {outside} CASCADE")).await.unwrap();
        let _ = std::fs::remove_dir_all(directory);
        assert!(rejected, "启用的写规则必须在预览阶段阻塞");
        assert_eq!(counts.get::<_, i64>(0), 0);
        assert_eq!(counts.get::<_, i64>(1), 0);
    }
    #[tokio::test]
    #[ignore = "需专属隔离PostgreSQL，DB_CONNECT_DATA_TASK_PG_URL"]
    async fn real_postgres_rule_added_after_preview_causes_zero_write_stale_failure() {
        let (client, config, source, target) = fixture().await;
        let outside = format!("{target}_external");
        client.batch_execute(&format!("CREATE SCHEMA {source};CREATE SCHEMA {target};CREATE SCHEMA {outside};CREATE TABLE {source}.t(id BIGINT PRIMARY KEY,v TEXT);CREATE TABLE {target}.t(LIKE {source}.t INCLUDING ALL);CREATE TABLE {outside}.audit(id BIGINT);INSERT INTO {source}.t VALUES(1,'new');")).await.unwrap();
        let directory = std::env::temp_dir().join(&source);
        let token = cancel();
        let plan = prepare_task(
            "rule-drift".into(),
            request(&source, &target, DataTaskMode::Append),
            config.clone(),
            config.clone(),
            directory.clone(),
            token.clone(),
            Arc::new(|_| {}),
        )
        .await
        .unwrap();
        client.batch_execute(&format!("CREATE RULE audit_copy AS ON INSERT TO {target}.t DO ALSO INSERT INTO {outside}.audit VALUES(NEW.id)")).await.unwrap();
        let result = execute_plan(
            Arc::new(plan),
            config.clone(),
            config,
            token,
            Arc::new(|_| {}),
        )
        .await;
        let counts=client.query_one(&format!("SELECT (SELECT count(*) FROM {target}.t),(SELECT count(*) FROM {outside}.audit)"),&[]).await.unwrap();
        client.batch_execute(&format!("DROP SCHEMA {source} CASCADE;DROP SCHEMA {target} CASCADE;DROP SCHEMA {outside} CASCADE")).await.unwrap();
        let _ = std::fs::remove_dir_all(directory);
        assert_eq!(
            result.error.as_ref().map(|e| e.code.as_str()),
            Some("plan_stale"),
            "{result:?}"
        );
        assert_eq!(result.commit_state, DataCommitState::RolledBack);
        assert_eq!(counts.get::<_, i64>(0), 0);
        assert_eq!(counts.get::<_, i64>(1), 0);
    }
    #[tokio::test]
    #[ignore = "需专属隔离PostgreSQL，DB_CONNECT_DATA_TASK_PG_URL"]
    async fn real_postgres_schema_usage_and_all_write_permissions_are_required() {
        let (client, mut config, _, target) = fixture().await;
        let role = format!("data_task_role_{}", uuid::Uuid::new_v4().simple());
        let password = uuid::Uuid::new_v4().simple().to_string();
        client.batch_execute(&format!("CREATE SCHEMA {target};CREATE TABLE {target}.t(id BIGINT PRIMARY KEY,v TEXT);CREATE ROLE {role} LOGIN PASSWORD '{password}';GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO {role};GRANT SELECT,INSERT,UPDATE,DELETE ON {target}.t TO {role};")).await.unwrap();
        config.username = role.clone();
        config.password = Some(password);
        let endpoint = DataEndpoint {
            saved_connection_id: "restricted".into(),
            database: target.clone(),
        };
        let mut session = open(config.clone(), endpoint.clone(), cancel())
            .await
            .unwrap();
        session.begin_read().await.unwrap();
        let no_schema_usage = session.load_metadata().await.unwrap();
        session.rollback().await.unwrap();
        drop(session);
        client.batch_execute(&format!("GRANT USAGE ON SCHEMA {target} TO {role};REVOKE UPDATE,DELETE ON {target}.t FROM {role}")).await.unwrap();
        let mut session = open(config, endpoint, cancel()).await.unwrap();
        session.begin_read().await.unwrap();
        let partial_write = session.load_metadata().await.unwrap();
        session.rollback().await.unwrap();
        drop(session);
        client
            .batch_execute(&format!(
                "DROP SCHEMA {target} CASCADE;DROP OWNED BY {role};DROP ROLE {role}"
            ))
            .await
            .unwrap();
        assert!(
            !no_schema_usage.permissions_verified,
            "表权限不能代替目标schema的USAGE权限"
        );
        assert!(partial_write.permissions_verified);
        assert!(
            !partial_write.protected_write,
            "只有INSERT权限不能证明UPDATE/DELETE也可用"
        );
    }
}
