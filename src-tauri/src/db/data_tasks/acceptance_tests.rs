//! 只使用自有临时文件；trace 统计真实执行的 SELECT，不以适配器自报数字作为证据。
use super::{
    adapters::sqlite::{self, Projection},
    executor::{execute_plan, prepare_task},
    spool::{ResourceBudget, SpoolWriter},
};
use crate::models::{data_tasks::*, types::ConnectionConfig};
use rusqlite::{
    trace::{TraceEvent, TraceEventCodes},
    Connection,
};
use std::{
    cell::RefCell,
    path::PathBuf,
    sync::{atomic::AtomicBool, Arc},
};

thread_local! {static SELECTS:RefCell<Vec<String>>=const {RefCell::new(Vec::new())};}
fn trace(event: TraceEvent<'_>) {
    if let TraceEvent::Stmt(statement, _) = event {
        let sql = statement.sql();
        if sql.trim_start().to_uppercase().starts_with("SELECT") {
            SELECTS.with(|s| s.borrow_mut().push(sql.into_owned()));
        }
    }
}
struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "db-connect-data-acceptance-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn actual_query_budget(tables: usize) {
    let conn = Connection::open_in_memory().unwrap();
    let ddl=(0..tables).map(|i|format!("CREATE TABLE t{i}(id INTEGER PRIMARY KEY,v TEXT);INSERT INTO t{i} VALUES(1,'数据');")).collect::<String>();
    conn.execute_batch(&ddl).unwrap();
    SELECTS.with(|s| s.borrow_mut().clear());
    conn.trace_v2(TraceEventCodes::SQLITE_TRACE_STMT, Some(trace));
    let metadata = sqlite::load_metadata(&conn).unwrap();
    assert_eq!(metadata.tables.len(), tables);
    assert_eq!(
        SELECTS.with(|s| s.borrow().len()),
        4,
        "metadata SELECT budget"
    );
    SELECTS.with(|s| s.borrow_mut().clear());
    let projections = (0..tables)
        .map(|i| Projection {
            table: format!("t{i}"),
            output_table: format!("t{i}"),
            columns: vec!["id".into(), "v".into()],
            key_indices: vec![0],
        })
        .collect::<Vec<_>>();
    let mut count = 0;
    sqlite::stream_rows(&conn, &projections, &AtomicBool::new(false), |_| {
        count += 1;
        Ok(())
    })
    .unwrap();
    assert_eq!(count, tables);
    assert_eq!(
        SELECTS.with(|s| s.borrow().len()),
        1,
        "snapshot SELECT budget"
    );
}
#[test]
fn one_table_uses_fixed_metadata_and_one_data_select() {
    actual_query_budget(1);
}
#[test]
fn ten_tables_use_fixed_metadata_and_one_data_select() {
    actual_query_budget(10);
}
#[test]
fn hundred_tables_use_fixed_metadata_and_one_data_select() {
    actual_query_budget(100);
}

#[test]
fn streaming_has_no_editor_result_limit_and_retains_large_integer() {
    let dir = Directory::new();
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY,v BLOB);WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100001) INSERT INTO t SELECT x,X'00FF' FROM n;INSERT INTO t VALUES(9007199254740993,X'00');").unwrap();
    let projection = Projection {
        table: "t".into(),
        output_table: "t".into(),
        columns: vec!["id".into(), "v".into()],
        key_indices: vec![0],
    };
    let mut writer = SpoolWriter::new(&dir.0, ResourceBudget::default()).unwrap();
    let rows = sqlite::stream_rows(&conn, &[projection], &AtomicBool::new(false), |row| {
        writer.push_batch(&[row])
    })
    .unwrap();
    let spool = writer.finish().unwrap();
    assert_eq!(rows, 100002);
    assert_eq!(spool.row_count(), 100002);
    let last = spool.read_page(100001, 1).unwrap();
    assert_eq!(
        last[0].values[0],
        super::value::DataValue::Int(9007199254740993)
    );
}

fn config(path: PathBuf, id: &str) -> ConnectionConfig {
    serde_json::from_value(serde_json::json!({"id":id,"database_type":"sqlite","name":id,"host":"","port":0,"username":"","sqlite_path":path})).unwrap()
}
#[tokio::test]
#[ignore = "百万行真实传输性能验收，由 scripts/data-tasks/validate.py 显式运行"]
async fn sqlite_million_rows_transfer_is_complete() {
    let row_count = std::env::var("DB_CONNECT_DATA_TASK_PERF_ROWS")
        .unwrap_or_else(|_| "1000000".into())
        .parse::<u64>()
        .unwrap();
    assert!(matches!(row_count, 100000 | 1000000));
    let dir = Directory::new();
    let source = dir.0.join("source.sqlite");
    let target = dir.0.join("target.sqlite");
    let schema = "CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT,v BLOB);";
    let conn = Connection::open(&source).unwrap();
    conn.execute_batch(schema).unwrap();
    conn.execute_batch(&format!("WITH RECURSIVE n(x) AS(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<{row_count}) INSERT INTO t SELECT x,X'000102FF' FROM n;")).unwrap();
    drop(conn);
    Connection::open(&target)
        .unwrap()
        .execute_batch(schema)
        .unwrap();
    let s = config(source, "source");
    let t = config(target.clone(), "target");
    let request = DataTaskRequest {
        protocol_version: 1,
        kind: DataTaskKind::Transfer,
        mode: DataTaskMode::Append,
        source: DataEndpoint {
            saved_connection_id: "source".into(),
            database: "main".into(),
        },
        target: DataEndpoint {
            saved_connection_id: "target".into(),
            database: "main".into(),
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
    };
    let start = std::time::Instant::now();
    let cancel = Arc::new(AtomicBool::new(false));
    let plan = prepare_task(
        "million-rows".into(),
        request,
        s.clone(),
        t.clone(),
        dir.0.join("spool"),
        cancel.clone(),
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    assert_eq!(
        plan.preview.tables[0].counts.source_rows,
        row_count.to_string()
    );
    let budget = plan.source.spool.budget();
    let result = execute_plan(Arc::new(plan), s, t, cancel, Arc::new(|_| {})).await;
    assert_eq!(
        result.commit_state,
        DataCommitState::Committed,
        "{:?}",
        result.error
    );
    let conn = Connection::open(&target).unwrap();
    let counts: (i64, i64) = conn
        .query_row("SELECT COUNT(*),MAX(id) FROM t", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(counts, (row_count as i64, row_count as i64));
    conn.execute("INSERT INTO t(v) VALUES(X'01')", []).unwrap();
    assert_eq!(conn.last_insert_rowid(), row_count as i64 + 1);
    println!("DATA_TASK_METRICS rows={row_count} elapsed_ms={} retained_spool_bytes={} peak_spool_bytes={} peak_buffer_bytes={}",start.elapsed().as_millis(),budget.disk_used(),budget.disk_peak(),budget.memory_peak());
}
