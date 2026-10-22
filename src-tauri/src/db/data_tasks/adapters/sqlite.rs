//! SQLite 专用原生数据通道。调用者必须在 blocking 线程使用，同一快照只建立一次结果流。
use crate::db::data_tasks::{
    metadata::{DataColumn, DataForeignKey, DataTable},
    value::{CanonicalRow, DataValue},
};
use crate::db::sql_utils::sqlite_id;
use rusqlite::{
    types::{Value, ValueRef},
    Connection, OpenFlags,
};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

#[derive(Clone, Debug)]
pub struct Projection {
    pub table: String,
    pub output_table: String,
    pub columns: Vec<String>,
    pub key_indices: Vec<usize>,
}
#[derive(Debug)]
pub struct Metadata {
    pub tables: Vec<DataTable>,
    pub signature: String,
}

fn db_error(_: rusqlite::Error) -> String {
    "SQLite 数据任务操作失败，请检查约束、权限及数据库锁".into()
}

pub fn open(
    path: &Path,
    write: bool,
    cancel: std::sync::Arc<AtomicBool>,
) -> Result<Connection, String> {
    let flags = if write {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    } else {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    };
    let conn = Connection::open_with_flags(path, flags).map_err(db_error)?;
    conn.busy_timeout(Duration::from_secs(10))
        .map_err(db_error)?;
    conn.progress_handler(1000, Some(move || cancel.load(Ordering::Acquire)))
        .map_err(db_error)?;
    // 外键不能在事务内临时关闭。
    conn.execute_batch("PRAGMA foreign_keys = ON")
        .map_err(db_error)?;
    Ok(conn)
}

/// 四类固定查询：表/列、外键、触发器与全 schema、索引/排序规则。表数不改变查询次数。
pub fn load_metadata(conn: &Connection) -> Result<Metadata, String> {
    let mut tables: BTreeMap<String, DataTable> = BTreeMap::new();
    let mut declared_nullable = BTreeMap::new();
    let mut statement = conn.prepare("SELECT s.name, s.sql, l.type, l.wr, x.name, x.type, x.\"notnull\", x.dflt_value, x.pk, x.hidden FROM main.sqlite_schema s JOIN pragma_table_list l ON l.schema='main' AND l.name=s.name JOIN pragma_table_xinfo(s.name,'main') x WHERE s.type='table' AND s.name NOT GLOB 'sqlite_*' ORDER BY s.name,x.cid").map_err(db_error)?;
    let mut rows = statement.query([]).map_err(db_error)?;
    while let Some(row) = rows.next().map_err(db_error)? {
        let name: String = row.get(0).map_err(db_error)?;
        let sql: String = row.get(1).map_err(db_error)?;
        let kind: String = row.get(2).map_err(db_error)?;
        let without_rowid = row.get::<_, i64>(3).map_err(db_error)? != 0;
        let declared_type: String = row.get(5).map_err(db_error)?;
        let pk = row.get::<_, u32>(8).map_err(db_error)?;
        let identity = pk > 0 && declared_type.eq_ignore_ascii_case("INTEGER") && !without_rowid;
        declared_nullable.insert(
            (name.clone(), row.get::<_, String>(4).map_err(db_error)?),
            row.get::<_, i64>(6).map_err(db_error)? == 0 && !(without_rowid && pk > 0),
        );
        let table = tables.entry(name.clone()).or_insert_with(|| DataTable {
            name,
            create_sql: sql,
            columns: vec![],
            foreign_keys: vec![],
            enabled_user_triggers: false,
            physical: kind == "table",
        });
        table.columns.push(DataColumn {
            name: row.get(4).map_err(db_error)?,
            declared_type,
            nullable: row.get::<_, i64>(6).map_err(db_error)? == 0
                && !identity
                && !(without_rowid && pk > 0),
            default_sql: row.get(7).map_err(db_error)?,
            generated: row.get::<_, i64>(9).map_err(db_error)? != 0,
            primary_key_ordinal: pk,
            collation: Some("BINARY".into()),
            identity,
            generator_safe: identity,
        });
    }
    drop(rows);
    drop(statement);
    // INTEGER 复合主键并不是 rowid alias，也不能自动生成。
    for table in tables.values_mut() {
        if table
            .columns
            .iter()
            .filter(|c| c.primary_key_ordinal > 0)
            .count()
            != 1
        {
            for column in &mut table.columns {
                if column.identity {
                    column.identity = false;
                    column.generator_safe = false;
                    column.nullable = declared_nullable[&(table.name.clone(), column.name.clone())];
                }
            }
        }
    }
    let mut statement = conn.prepare("SELECT s.name,f.id,f.seq,f.\"table\",f.\"from\",f.\"to\",f.on_update,f.on_delete FROM main.sqlite_schema s JOIN pragma_foreign_key_list(s.name,'main') f WHERE s.type='table' AND s.name NOT GLOB 'sqlite_*' ORDER BY s.name,f.id,f.seq").map_err(db_error)?;
    let mut rows = statement.query([]).map_err(db_error)?;
    let mut foreign: BTreeMap<(String, i64), DataForeignKey> = BTreeMap::new();
    while let Some(row) = rows.next().map_err(db_error)? {
        let name: String = row.get(0).map_err(db_error)?;
        let id = row.get(1).map_err(db_error)?;
        let fk = foreign.entry((name, id)).or_insert(DataForeignKey {
            from_columns: vec![],
            parent_table: row.get(3).map_err(db_error)?,
            parent_columns: vec![],
            on_update: row.get(6).map_err(db_error)?,
            on_delete: row.get(7).map_err(db_error)?,
        });
        fk.from_columns.push(row.get(4).map_err(db_error)?);
        fk.parent_columns.push(
            row.get::<_, Option<String>>(5)
                .map_err(db_error)?
                .unwrap_or_default(),
        );
    }
    for ((name, _), fk) in foreign {
        if let Some(table) = tables.get_mut(&name) {
            table.foreign_keys.push(fk);
        }
    }
    drop(rows);
    drop(statement);
    let mut statement = conn.prepare("SELECT type,name,tbl_name,COALESCE(sql,'') FROM main.sqlite_schema ORDER BY type,name,tbl_name").map_err(db_error)?;
    let mut rows = statement.query([]).map_err(db_error)?;
    let mut hasher = Sha256::new();
    while let Some(row) = rows.next().map_err(db_error)? {
        let kind: String = row.get(0).map_err(db_error)?;
        let name: String = row.get(1).map_err(db_error)?;
        let table_name: String = row.get(2).map_err(db_error)?;
        let sql: String = row.get(3).map_err(db_error)?;
        for part in [&kind, &name, &table_name, &sql] {
            hasher.update((part.len() as u64).to_be_bytes());
            hasher.update(part.as_bytes());
        }
        if kind == "trigger" {
            if let Some(table) = tables.get_mut(&table_name) {
                table.enabled_user_triggers = true;
            }
        }
        // 索引声明加入结构指纹，防止预览后新增唯一索引绕过 stale 检查。
        if kind == "index" {
            if let Some(table) = tables.get_mut(&table_name) {
                table.create_sql.push_str("\n-- index: ");
                table.create_sql.push_str(&sql);
            }
        }
    }
    drop(rows);
    drop(statement);
    let mut statement = conn.prepare("SELECT s.name,i.name,i.origin,x.name,x.coll,x.key FROM main.sqlite_schema s JOIN pragma_index_list(s.name,'main') i JOIN pragma_index_xinfo(i.name,'main') x WHERE s.type='table' AND s.name NOT GLOB 'sqlite_*' ORDER BY s.name,i.name,x.seqno").map_err(db_error)?;
    let mut rows = statement.query([]).map_err(db_error)?;
    while let Some(row) = rows.next().map_err(db_error)? {
        let table_name: String = row.get(0).map_err(db_error)?;
        let origin: String = row.get(2).map_err(db_error)?;
        let column_name: Option<String> = row.get(3).map_err(db_error)?;
        let collation: Option<String> = row.get(4).map_err(db_error)?;
        if origin == "pk" && row.get::<_, i64>(5).map_err(db_error)? != 0 {
            if let Some(column) = tables.get_mut(&table_name).and_then(|t| {
                t.columns
                    .iter_mut()
                    .find(|c| Some(&c.name) == column_name.as_ref())
            }) {
                column.collation = collation;
                if column.identity {
                    column.identity = false;
                    column.generator_safe = false;
                    column.nullable = declared_nullable[&(table_name.clone(), column.name.clone())];
                }
            }
        }
    }
    Ok(Metadata {
        tables: tables.into_values().collect(),
        signature: format!("{:x}", hasher.finalize()),
    })
}

pub fn snapshot_sql(projections: &[Projection]) -> Result<String, String> {
    if projections.is_empty() || projections.len() > 100 {
        return Err("集合快照必须包含 1 至 100 张物理表".into());
    }
    let width = projections
        .iter()
        .map(|p| p.columns.len())
        .max()
        .unwrap_or(0);
    if width == 0 {
        return Err("集合快照字段不能为空".into());
    }
    let sql = projections.iter().enumerate().map(|(index, p)| {
        let mut size_alias="__db_connect_bytes".to_string();while p.columns.iter().any(|c|c.eq_ignore_ascii_case(&size_alias)){size_alias.push('_');}
        let size=sqlite_id(&size_alias);let raw=p.columns.iter().map(|c|sqlite_id(c)).collect::<Vec<_>>();
        let sum=p.columns.iter().map(|c|format!("COALESCE(octet_length({}),0)",sqlite_id(c))).collect::<Vec<_>>().join(" + ");
        let mut columns = raw.iter().map(|c|format!("CASE WHEN {size} > 8388608 THEN NULL ELSE {c} END")).collect::<Vec<_>>();
        columns.resize(width, "NULL".into());
        format!("SELECT {index} AS __data_table, {},CASE WHEN {size} > 8388608 THEN 1 ELSE 0 END AS __data_oversized FROM (SELECT {},({sum}) AS {size} FROM main.{})", columns.join(","),raw.join(","),sqlite_id(&p.table))
    }).collect::<Vec<_>>().join(" UNION ALL ");
    if sql.len() > 1024 * 1024 {
        return Err("集合快照 SQL 超过 1 MiB，请拆分任务".into());
    }
    Ok(sql)
}

pub fn stream_rows(
    conn: &Connection,
    projections: &[Projection],
    cancel: &AtomicBool,
    mut push: impl FnMut(CanonicalRow) -> Result<(), String>,
) -> Result<u64, String> {
    let sql = snapshot_sql(projections)?;
    let width = projections
        .iter()
        .map(|p| p.columns.len())
        .max()
        .unwrap_or(0);
    let mut statement = conn.prepare(&sql).map_err(db_error)?;
    let mut rows = statement.query([]).map_err(db_error)?;
    let mut count = 0;
    while let Some(row) = rows.next().map_err(db_error)? {
        if cancel.load(Ordering::Acquire) {
            return Err("cancelled".into());
        }
        if row.get::<_, i64>(width + 1).map_err(db_error)? != 0 {
            return Err("resource_limit: 单行超过 8 MiB 上限".into());
        }
        let projection = projections
            .get(row.get::<_, u32>(0).map_err(db_error)? as usize)
            .ok_or("集合快照表序号无效")?;
        let mut values = Vec::with_capacity(projection.columns.len());
        let mut bytes = 0usize;
        for index in 0..projection.columns.len() {
            let value = match row.get_ref(index + 1).map_err(db_error)? {
                ValueRef::Null => DataValue::Null,
                ValueRef::Integer(v) => DataValue::Int(v),
                ValueRef::Real(v) => DataValue::Float(v.to_bits()),
                ValueRef::Text(v) => {
                    if bytes.saturating_add(v.len()).saturating_add(16) > 8 * 1024 * 1024 {
                        return Err("resource_limit: 单行超过 8 MiB 上限".into());
                    }
                    bytes += v.len();
                    DataValue::Text(
                        std::str::from_utf8(v)
                            .map_err(|_| "SQLite 文本不是有效 UTF-8，不能无损传输")?
                            .into(),
                    )
                }
                ValueRef::Blob(v) => {
                    if bytes.saturating_add(v.len()).saturating_add(16) > 8 * 1024 * 1024 {
                        return Err("resource_limit: 单行超过 8 MiB 上限".into());
                    }
                    bytes += v.len();
                    DataValue::Binary(v.to_vec())
                }
            };
            bytes += 16;
            if bytes > 8 * 1024 * 1024 {
                return Err("单行超过 8 MiB 上限".into());
            }
            values.push(value);
        }
        let key = projection
            .key_indices
            .iter()
            .map(|i| {
                values
                    .get(*i)
                    .cloned()
                    .ok_or_else(|| "定位键索引无效".into())
            })
            .collect::<Result<Vec<_>, String>>()?;
        push(CanonicalRow::new(
            projection.output_table.clone(),
            key,
            values,
        )?)?;
        count += 1;
    }
    Ok(count)
}

pub fn bind_value(value: &DataValue) -> Result<Value, String> {
    Ok(match value {
        DataValue::Null => Value::Null,
        DataValue::Bool(v) => Value::Integer(i64::from(*v)),
        DataValue::Int(v) => Value::Integer(*v),
        DataValue::UInt(v) => {
            Value::Integer(i64::try_from(*v).map_err(|_| "SQLite 不支持超出 i64 范围的整数")?)
        }
        DataValue::Float(bits) => {
            let v = f64::from_bits(*bits);
            if !v.is_finite() {
                return Err("SQLite 不支持无损写入 NaN/Infinity".into());
            }
            Value::Real(v)
        }
        DataValue::Text(v) => Value::Text(v.clone()),
        DataValue::Binary(v) => Value::Blob(v.clone()),
        _ => return Err("SQLite 值绑定类型未经无损验证".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heterogeneous_tables_are_read_by_one_native_union_query() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE a(id INTEGER PRIMARY KEY, payload BLOB); CREATE TABLE b(label TEXT); INSERT INTO a VALUES(9223372036854775807,x'00ff'); INSERT INTO b VALUES('中文');").unwrap();
        let metadata = load_metadata(&conn).unwrap();
        assert_eq!(metadata.tables.len(), 2);
        let projections = vec![
            Projection {
                table: "a".into(),
                output_table: "a".into(),
                columns: vec!["id".into(), "payload".into()],
                key_indices: vec![0],
            },
            Projection {
                table: "b".into(),
                output_table: "b".into(),
                columns: vec!["label".into()],
                key_indices: vec![],
            },
        ];
        let sql = snapshot_sql(&projections).unwrap();
        assert_eq!(sql.matches("UNION ALL").count(), 1);
        let mut collected = Vec::new();
        stream_rows(
            &conn,
            &projections,
            &std::sync::atomic::AtomicBool::new(false),
            |row| {
                collected.push(row);
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(collected.len(), 2);
        assert_eq!(
            collected[0].values[0],
            crate::db::data_tasks::value::DataValue::Int(i64::MAX)
        );
        assert_eq!(
            collected[0].values[1],
            crate::db::data_tasks::value::DataValue::Binary(vec![0, 255])
        );
    }
    #[test]
    fn composite_and_descending_integer_keys_preserve_real_nullability() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE composite(a INTEGER,b INTEGER NOT NULL,v TEXT,PRIMARY KEY(a,b)); CREATE TABLE descending(id INTEGER PRIMARY KEY DESC,v TEXT);").unwrap();
        let meta = load_metadata(&conn).unwrap();
        let composite = meta.tables.iter().find(|t| t.name == "composite").unwrap();
        assert!(composite.columns[0].nullable);
        assert!(!composite.columns[1].nullable);
        assert!(!composite.columns[0].identity);
        let desc = meta.tables.iter().find(|t| t.name == "descending").unwrap();
        assert!(desc.columns[0].nullable);
        assert!(!desc.columns[0].identity);
    }

    #[test]
    fn oversized_blob_is_rejected_before_copying_into_result_payload() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE huge(id INTEGER PRIMARY KEY,payload BLOB);INSERT INTO huge VALUES(1,zeroblob(9000000));").unwrap();
        let projection = Projection {
            table: "huge".into(),
            output_table: "huge".into(),
            columns: vec!["id".into(), "payload".into()],
            key_indices: vec![0],
        };
        let sql = snapshot_sql(std::slice::from_ref(&projection)).unwrap();
        let withheld = conn
            .query_row(&sql, [], |row| {
                Ok(matches!(row.get_ref(2)?, ValueRef::Null))
            })
            .unwrap();
        assert!(withheld, "超限原始blob不得进入驱动结果行载荷");
        let mut delivered = false;
        let result = stream_rows(&conn, &[projection], &AtomicBool::new(false), |_| {
            delivered = true;
            Ok(())
        });
        assert!(result.unwrap_err().contains("8 MiB"));
        assert!(!delivered);
    }
}
