//! 全部夹具均为专用随机临时文件，不读取用户连接。
use super::executor::{execute_plan, prepare_task};
use crate::models::{data_tasks::*, types::ConnectionConfig};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
struct Fixture {
    dir: PathBuf,
    source: ConnectionConfig,
    target: ConnectionConfig,
}
impl Fixture {
    fn new(source_sql: &str, target_sql: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "db-connect-data-task-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&dir).unwrap();
        let s = dir.join("source.sqlite");
        let t = dir.join("target.sqlite");
        rusqlite::Connection::open(&s)
            .unwrap()
            .execute_batch(source_sql)
            .unwrap();
        rusqlite::Connection::open(&t)
            .unwrap()
            .execute_batch(target_sql)
            .unwrap();
        fn config(path: PathBuf, id: &str) -> ConnectionConfig {
            serde_json::from_value(serde_json::json!({"id":id,"database_type":"sqlite","name":id,"host":"","port":0,"username":"","sqlite_path":path})).unwrap()
        }
        Self {
            source: config(s, "source"),
            target: config(t, "target"),
            dir,
        }
    }
    fn request(&self, mode: DataTaskMode) -> DataTaskRequest {
        DataTaskRequest {
            protocol_version: 1,
            kind: if matches!(mode, DataTaskMode::Merge | DataTaskMode::Mirror) {
                DataTaskKind::RowSync
            } else {
                DataTaskKind::Transfer
            },
            mode,
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
        }
    }
    async fn plan(&self, mode: DataTaskMode) -> super::plan::StoredDataPlan {
        prepare_task(
            "test-task".into(),
            self.request(mode),
            self.source.clone(),
            self.target.clone(),
            self.dir.join("spool"),
            Arc::new(AtomicBool::new(false)),
            Arc::new(|_| {}),
        )
        .await
        .unwrap()
    }
    fn rows(&self) -> Vec<(i64, String)> {
        let c = rusqlite::Connection::open(self.target.sqlite_path.as_ref().unwrap()).unwrap();
        let mut s = c.prepare("SELECT id,v FROM t ORDER BY id").unwrap();
        s.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
const SCHEMA: &str = "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT NOT NULL);";
#[tokio::test]
async fn sqlite_large_primary_key_parameter_expansion_is_rejected_before_allocation() {
    let columns = (0..100)
        .map(|i| format!("c{i} INTEGER"))
        .collect::<Vec<_>>()
        .join(",");
    let zeros = vec!["0"; 100].join(",");
    let mut source_values = vec!["0"; 100];
    source_values[0] = "1";
    let schema = format!("CREATE TABLE t(id BLOB NOT NULL PRIMARY KEY,{columns});");
    let f = Fixture::new(
        &format!(
            "{schema} INSERT INTO t VALUES(zeroblob(1048576),{});",
            source_values.join(",")
        ),
        &format!("{schema} INSERT INTO t VALUES(zeroblob(1048576),{zeros});"),
    );
    let mut request = f.request(DataTaskMode::Merge);
    request.mappings[0].columns = (0..100)
        .map(|i| ColumnMapping {
            source_column: format!("c{i}"),
            target_column: format!("c{i}"),
        })
        .collect();
    request.mappings[0].columns.push(ColumnMapping {
        source_column: "id".into(),
        target_column: "id".into(),
    });
    let cancel = Arc::new(AtomicBool::new(false));
    let p = prepare_task(
        "large-key".into(),
        request,
        f.source.clone(),
        f.target.clone(),
        f.dir.join("spool"),
        cancel.clone(),
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    let r = execute_plan(
        Arc::new(p),
        f.source.clone(),
        f.target.clone(),
        cancel,
        Arc::new(|_| {}),
    )
    .await;
    assert_eq!(r.commit_state, DataCommitState::RolledBack);
    assert_eq!(r.error.unwrap().code, "resource_limit");
    let c = rusqlite::Connection::open(f.target.sqlite_path.as_ref().unwrap()).unwrap();
    assert_eq!(
        c.query_row("SELECT c0 FROM t", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
#[tokio::test]
async fn sqlite_merge_and_mirror_execute_frozen_preview() {
    for mode in [DataTaskMode::Merge, DataTaskMode::Mirror] {
        let f = Fixture::new(
            &format!("{SCHEMA} INSERT INTO t VALUES(1,'A'),(2,'B');"),
            &format!("{SCHEMA} INSERT INTO t VALUES(2,'old'),(3,'C');"),
        );
        let p = f.plan(mode).await;
        rusqlite::Connection::open(f.source.sqlite_path.as_ref().unwrap())
            .unwrap()
            .execute_batch("UPDATE t SET v='later'")
            .unwrap();
        let result = execute_plan(
            Arc::new(p),
            f.source.clone(),
            f.target.clone(),
            Arc::new(AtomicBool::new(false)),
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
        let mut expected = vec![(1, "A".into()), (2, "B".into())];
        if mode == DataTaskMode::Merge {
            expected.push((3, "C".into()));
        }
        assert_eq!(f.rows(), expected);
    }
}
#[tokio::test]
async fn sqlite_stale_target_has_zero_business_writes() {
    let f = Fixture::new(
        &format!("{SCHEMA} INSERT INTO t VALUES(1,'A');"),
        &format!("{SCHEMA} INSERT INTO t VALUES(2,'B');"),
    );
    let p = f.plan(DataTaskMode::Replace).await;
    rusqlite::Connection::open(f.target.sqlite_path.as_ref().unwrap())
        .unwrap()
        .execute_batch("INSERT INTO t VALUES(3,'changed')")
        .unwrap();
    let r = execute_plan(
        Arc::new(p),
        f.source.clone(),
        f.target.clone(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(|_| {}),
    )
    .await;
    assert_eq!(r.error.unwrap().code, "plan_stale");
    assert_eq!(f.rows(), vec![(2, "B".into()), (3, "changed".into())]);
}
#[tokio::test]
async fn sqlite_append_constraint_failure_rolls_back_all_batches() {
    let f=Fixture::new(&format!("{SCHEMA} WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1100) INSERT INTO t SELECT x,'A' FROM n;"),&format!("{SCHEMA} INSERT INTO t VALUES(1000,'existing');"));
    let p = f.plan(DataTaskMode::Append).await;
    let r = execute_plan(
        Arc::new(p),
        f.source.clone(),
        f.target.clone(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(|_| {}),
    )
    .await;
    assert_eq!(r.status, DataTaskStatus::Failed);
    assert_eq!(r.commit_state, DataCommitState::RolledBack);
    assert_eq!(f.rows(), vec![(1000, "existing".into())]);
}
#[tokio::test]
async fn sqlite_cancel_after_write_rolls_back_and_releases_file_lock() {
    let f = Fixture::new(
        &format!("{SCHEMA} INSERT INTO t VALUES(1,'A');"),
        &format!("{SCHEMA} INSERT INTO t VALUES(2,'B');"),
    );
    let p = f.plan(DataTaskMode::Replace).await;
    let cancel = Arc::new(AtomicBool::new(false));
    let signal = cancel.clone();
    let r = execute_plan(
        Arc::new(p),
        f.source.clone(),
        f.target.clone(),
        cancel,
        Arc::new(move |p| {
            if p.written_rows > 0 {
                signal.store(true, Ordering::Release);
            }
        }),
    )
    .await;
    assert_eq!(r.status, DataTaskStatus::Cancelled);
    assert_eq!(r.commit_state, DataCommitState::RolledBack);
    assert_eq!(f.rows(), vec![(2, "B".into())]);
    let c = rusqlite::Connection::open(f.target.sqlite_path.as_ref().unwrap()).unwrap();
    c.execute_batch("BEGIN IMMEDIATE; ROLLBACK;").unwrap();
}
#[tokio::test]
async fn sqlite_no_primary_key_append_preserves_duplicates() {
    let f = Fixture::new(
        "CREATE TABLE t(id INTEGER,v TEXT); INSERT INTO t VALUES(1,'A'),(1,'A');",
        "CREATE TABLE t(id INTEGER,v TEXT); INSERT INTO t VALUES(1,'A');",
    );
    let p = f.plan(DataTaskMode::Append).await;
    let r = execute_plan(
        Arc::new(p),
        f.source.clone(),
        f.target.clone(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(|_| {}),
    )
    .await;
    assert_eq!(r.status, DataTaskStatus::Succeeded, "{:?}", r.error);
    assert_eq!(f.rows().len(), 3);
}
#[tokio::test]
async fn sqlite_final_verification_mismatch_rolls_back_every_change() {
    let f = Fixture::new(
        &format!("{SCHEMA} INSERT INTO t VALUES(1,'A');"),
        &format!("{SCHEMA} INSERT INTO t VALUES(2,'B');"),
    );
    let mut p = f.plan(DataTaskMode::Replace).await;
    // 故障注入：模拟后端预期快照损坏；数据库必须拒绝提交。
    p.expected = p.target.clone();
    let r = execute_plan(
        Arc::new(p),
        f.source.clone(),
        f.target.clone(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(|_| {}),
    )
    .await;
    assert_eq!(r.error.unwrap().code, "validation_failed");
    assert_eq!(r.commit_state, DataCommitState::RolledBack);
    assert_eq!(f.rows(), vec![(2, "B".into())]);
}
#[tokio::test]
async fn sqlite_replace_obeys_foreign_key_order() {
    let schema="CREATE TABLE z_parent(id INTEGER PRIMARY KEY,v INTEGER); CREATE TABLE a_child(id INTEGER PRIMARY KEY,v INTEGER REFERENCES z_parent(id));";
    let f = Fixture::new(
        &format!("{schema} INSERT INTO z_parent VALUES(1,9); INSERT INTO a_child VALUES(2,1);"),
        &format!("{schema} INSERT INTO z_parent VALUES(3,8); INSERT INTO a_child VALUES(4,3);"),
    );
    let mut request = f.request(DataTaskMode::Replace);
    let mut parent = request.mappings[0].clone();
    parent.source_table = "z_parent".into();
    parent.target_table = "z_parent".into();
    let mut child = parent.clone();
    child.source_table = "a_child".into();
    child.target_table = "a_child".into();
    request.mappings = vec![child, parent];
    let p = prepare_task(
        "fk".into(),
        request,
        f.source.clone(),
        f.target.clone(),
        f.dir.join("spool"),
        Arc::new(AtomicBool::new(false)),
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    assert_eq!(p.mapping.insert_order, vec!["z_parent", "a_child"]);
    let r = execute_plan(
        Arc::new(p),
        f.source.clone(),
        f.target.clone(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(|_| {}),
    )
    .await;
    assert_eq!(r.status, DataTaskStatus::Succeeded, "{:?}", r.error);
    let conn = rusqlite::Connection::open(f.target.sqlite_path.as_ref().unwrap()).unwrap();
    let child: (i64, i64) = conn
        .query_row("SELECT id,v FROM a_child", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    assert_eq!(child, (2, 1));
}
#[tokio::test]
async fn sqlite_autoincrement_preserves_explicit_key_and_advances_generator() {
    let schema = "CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT,v TEXT NOT NULL);";
    let f = Fixture::new(
        &format!("{schema} INSERT INTO t VALUES(9223372036854775806,'large');"),
        schema,
    );
    let p = f.plan(DataTaskMode::Append).await;
    let r = execute_plan(
        Arc::new(p),
        f.source.clone(),
        f.target.clone(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(|_| {}),
    )
    .await;
    assert_eq!(r.status, DataTaskStatus::Succeeded, "{:?}", r.error);
    let c = rusqlite::Connection::open(f.target.sqlite_path.as_ref().unwrap()).unwrap();
    c.execute("INSERT INTO t(v) VALUES('generated')", [])
        .unwrap();
    assert_eq!(c.last_insert_rowid(), i64::MAX);
}
#[tokio::test]
async fn sqlite_binary_int64_null_and_float_bits_roundtrip() {
    let schema = "CREATE TABLE t(id INTEGER PRIMARY KEY,v BLOB);";
    let f = Fixture::new(
        &format!("{schema} INSERT INTO t VALUES(9223372036854775807,x'00ff00'),(1,NULL),(2,1.25);"),
        schema,
    );
    let p = f.plan(DataTaskMode::Append).await;
    let r = execute_plan(
        Arc::new(p),
        f.source.clone(),
        f.target.clone(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(|_| {}),
    )
    .await;
    assert_eq!(r.status, DataTaskStatus::Succeeded, "{:?}", r.error);
    let c = rusqlite::Connection::open(f.target.sqlite_path.as_ref().unwrap()).unwrap();
    let bytes: Vec<u8> = c
        .query_row("SELECT v FROM t WHERE id=9223372036854775807", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(bytes, vec![0, 255, 0]);
    let null: Option<Vec<u8>> = c
        .query_row("SELECT v FROM t WHERE id=1", [], |r| r.get(0))
        .unwrap();
    assert!(null.is_none());
}
#[tokio::test]
async fn sqlite_target_schema_drift_and_readonly_config_are_blocked() {
    let f = Fixture::new(&format!("{SCHEMA} INSERT INTO t VALUES(1,'A');"), SCHEMA);
    let p = f.plan(DataTaskMode::Append).await;
    rusqlite::Connection::open(f.target.sqlite_path.as_ref().unwrap())
        .unwrap()
        .execute_batch("CREATE UNIQUE INDEX changed ON t(v)")
        .unwrap();
    let r = execute_plan(
        Arc::new(p),
        f.source.clone(),
        f.target.clone(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(|_| {}),
    )
    .await;
    assert_eq!(r.error.unwrap().code, "plan_stale");
    assert!(f.rows().is_empty());
    let mut target = f.target.clone();
    target.read_only = Some(true);
    let e = prepare_task(
        "readonly".into(),
        f.request(DataTaskMode::Append),
        f.source.clone(),
        target,
        f.dir.join("other"),
        Arc::new(AtomicBool::new(false)),
        Arc::new(|_| {}),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, "read_only_target");
}
#[tokio::test]
#[ignore = "百万行资源验收，显式运行并记录耗时；默认快速测试不执行"]
async fn sqlite_million_rows_exceed_editor_limits_without_truncation() {
    let f=Fixture::new(&format!("{SCHEMA} WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000) INSERT INTO t SELECT x,'中文' FROM n;"),SCHEMA);
    let p = f.plan(DataTaskMode::Append).await;
    assert_eq!(p.source.spool.row_count(), 1_000_000);
    let r = execute_plan(
        Arc::new(p),
        f.source.clone(),
        f.target.clone(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(|_| {}),
    )
    .await;
    assert_eq!(r.status, DataTaskStatus::Succeeded, "{:?}", r.error);
    let c = rusqlite::Connection::open(f.target.sqlite_path.as_ref().unwrap()).unwrap();
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM t", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1_000_000
    );
}
