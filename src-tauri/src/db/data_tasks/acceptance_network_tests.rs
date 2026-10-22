//! 专属 PostgreSQL 的真实协议故障注入；不替换 DataSession，不读取应用保存连接。
use super::{
    adapters::{sqlite::Projection, RowSender},
    executor, Cancellation,
};
use crate::models::{data_tasks::*, types::ConnectionConfig};
use std::{
    collections::HashMap,
    io,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::JoinHandle,
};

#[derive(Default)]
struct WireStats {
    selects: AtomicUsize,
    inserts: AtomicUsize,
    commits: AtomicUsize,
    locks: AtomicUsize,
    dropped_commit_acks: AtomicUsize,
    // 仅记录参数化语句类型计数；不保存认证消息、参数值或连接信息。
    errors: Mutex<Vec<String>>,
}
impl WireStats {
    fn executed(&self, kind: StatementKind) {
        if kind == StatementKind::Select {
            self.selects.fetch_add(1, Ordering::SeqCst);
        }
        if kind == StatementKind::Insert {
            self.inserts.fetch_add(1, Ordering::SeqCst);
        }
        if kind == StatementKind::Lock {
            self.locks.fetch_add(1, Ordering::SeqCst);
        }
        if kind == StatementKind::Commit {
            self.commits.fetch_add(1, Ordering::SeqCst);
        }
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum StatementKind {
    Select,
    Insert,
    Commit,
    Lock,
    Other,
}
fn statement_kind(sql: &[u8]) -> StatementKind {
    let sql = String::from_utf8_lossy(sql).trim().to_ascii_uppercase();
    if sql.contains("LOCK TABLE ") {
        StatementKind::Lock
    } else if sql.starts_with("SELECT ") {
        StatementKind::Select
    } else if sql.starts_with("INSERT INTO ") {
        StatementKind::Insert
    } else if sql.trim_end_matches(';') == "COMMIT" {
        StatementKind::Commit
    } else {
        StatementKind::Other
    }
}
#[derive(Default)]
struct ProtocolCounter {
    statements: HashMap<Vec<u8>, StatementKind>,
    portals: HashMap<Vec<u8>, StatementKind>,
}
impl ProtocolCounter {
    fn observe(&mut self, stats: &WireStats, tag: u8, body: &[u8]) {
        let mut parts = body.split(|b| *b == 0);
        let first = parts.next().unwrap_or_default();
        match tag {
            b'Q' => stats.executed(statement_kind(first)),
            b'P' => {
                self.statements.insert(
                    first.to_vec(),
                    statement_kind(parts.next().unwrap_or_default()),
                );
            }
            b'B' => {
                let statement = parts.next().unwrap_or_default();
                self.portals.insert(
                    first.to_vec(),
                    *self
                        .statements
                        .get(statement)
                        .unwrap_or(&StatementKind::Other),
                );
            }
            // 计数实际 Execute，重复 Bind/Execute 已预编译语句不能绕过重放检查。
            b'E' => stats.executed(*self.portals.get(first).unwrap_or(&StatementKind::Other)),
            b'C' if body.first() == Some(&b'S') => {
                self.statements
                    .remove(&body[1..body.len().saturating_sub(1)]);
            }
            b'C' if body.first() == Some(&b'P') => {
                self.portals.remove(&body[1..body.len().saturating_sub(1)]);
            }
            _ => {}
        }
    }
}

#[test]
fn protocol_counter_counts_execution_instead_of_preparation() {
    let stats = WireStats::default();
    let mut counter = ProtocolCounter::default();
    counter.observe(&stats, b'P', b"s0\0INSERT INTO dst VALUES($1)\0\0\0");
    counter.observe(&stats, b'B', b"\0s0\0");
    assert_eq!(stats.inserts.load(Ordering::SeqCst), 0);
    counter.observe(&stats, b'E', b"\0\0\0\0\0");
    counter.observe(&stats, b'B', b"\0s0\0");
    counter.observe(&stats, b'E', b"\0\0\0\0\0");
    assert_eq!(stats.inserts.load(Ordering::SeqCst), 2);
}
struct PgProxy {
    port: u16,
    stats: Arc<WireStats>,
    acceptor: JoinHandle<()>,
}
impl Drop for PgProxy {
    fn drop(&mut self) {
        self.acceptor.abort();
    }
}
impl PgProxy {
    async fn start(host: String, port: u16, drop_commit_ack: bool) -> Self {
        Self::start_with_fault(host, port, drop_commit_ack, false).await
    }
    async fn start_with_fault(
        host: String,
        port: u16,
        drop_commit_ack: bool,
        stall_commit_ack: bool,
    ) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let local_port = listener.local_addr().unwrap().port();
        let stats = Arc::new(WireStats::default());
        let accept_stats = stats.clone();
        let acceptor = tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                let host = host.clone();
                let stats = accept_stats.clone();
                tokio::spawn(async move {
                    if let Err(error) = proxy_connection(
                        client,
                        &host,
                        port,
                        drop_commit_ack,
                        stall_commit_ack,
                        stats.clone(),
                    )
                    .await
                    {
                        if !matches!(
                            error.kind(),
                            io::ErrorKind::UnexpectedEof
                                | io::ErrorKind::ConnectionReset
                                | io::ErrorKind::BrokenPipe
                        ) {
                            stats
                                .errors
                                .lock()
                                .unwrap()
                                .push(format!("{:?}", error.kind()));
                        }
                    }
                });
            }
        });
        Self {
            port: local_port,
            stats,
            acceptor,
        }
    }
}
async fn body<R: AsyncReadExt + Unpin>(reader: &mut R) -> io::Result<Vec<u8>> {
    let size = reader.read_u32().await?;
    if !(4..=16 * 1024 * 1024).contains(&size) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "夹具协议帧超限"));
    }
    let mut payload = vec![0; size as usize - 4];
    reader.read_exact(&mut payload).await?;
    Ok(payload)
}
async fn proxy_connection(
    mut client: TcpStream,
    host: &str,
    port: u16,
    drop_commit_ack: bool,
    stall_commit_ack: bool,
    stats: Arc<WireStats>,
) -> io::Result<()> {
    let mut server = TcpStream::connect((host, port)).await?;
    // 验收使用明文的回环专属实例；若客户端探测 SSL，仅回答不支持。
    let startup = body(&mut client).await?;
    let startup = if startup == 80877103u32.to_be_bytes() {
        client.write_all(b"N").await?;
        body(&mut client).await?
    } else {
        startup
    };
    server.write_u32((startup.len() + 4) as u32).await?;
    server.write_all(&startup).await?;
    let (mut cr, mut cw) = client.into_split();
    let (mut sr, mut sw) = server.into_split();
    let requests = async {
        let mut counter = ProtocolCounter::default();
        loop {
            let tag = cr.read_u8().await?;
            let payload = body(&mut cr).await?;
            counter.observe(&stats, tag, &payload);
            sw.write_u8(tag).await?;
            sw.write_u32((payload.len() + 4) as u32).await?;
            sw.write_all(&payload).await?;
        }
        #[allow(unreachable_code)]
        Ok::<(), io::Error>(())
    };
    let responses = async {
        loop {
            let tag = sr.read_u8().await?;
            let payload = body(&mut sr).await?;
            if (drop_commit_ack || stall_commit_ack) && tag == b'C' && payload == b"COMMIT\0" {
                // 服务器已真实提交；在发送 CommandComplete/ReadyForQuery 之前关闭两端。
                stats.dropped_commit_acks.fetch_add(1, Ordering::SeqCst);
                if stall_commit_ack {
                    std::future::pending::<()>().await;
                }
                return Ok::<(), io::Error>(());
            }
            cw.write_u8(tag).await?;
            cw.write_u32((payload.len() + 4) as u32).await?;
            cw.write_all(&payload).await?;
        }
    };
    tokio::select! { result = requests => result, result = responses => result }
}
struct Fixture {
    client: tokio_postgres::Client,
    config: ConnectionConfig,
    schema: String,
    directory: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
impl Fixture {
    async fn new() -> Self {
        let url =
            std::env::var("DB_CONNECT_DATA_TASK_PG_URL").expect("需要显式专属 PostgreSQL 夹具 URL");
        let pg: tokio_postgres::Config = url.parse().unwrap();
        let (client, connection) = pg.connect(tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let host = match &pg.get_hosts()[0] {
            tokio_postgres::config::Host::Tcp(host) => host,
            _ => panic!("需要 TCP 夹具"),
        };
        assert!(
            matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1"),
            "故障代理只连接本机显式专属实例"
        );
        let config = serde_json::from_value(serde_json::json!({"database_type":"postgres","name":"专属协议验收","host":host,"port":pg.get_ports().first().copied().unwrap_or(5432),"username":pg.get_user().unwrap_or("postgres"),"password":String::from_utf8_lossy(pg.get_password().unwrap_or_default()),"database":pg.get_dbname().unwrap_or("postgres"),"ssl_mode":"disabled"})).unwrap();
        let schema = format!("dbconnect_wire_{}", uuid::Uuid::new_v4().simple());
        let directory = std::env::temp_dir().join(&schema);
        std::fs::create_dir(&directory).unwrap();
        client
            .batch_execute(&format!("CREATE SCHEMA {schema}"))
            .await
            .unwrap();
        Self {
            client,
            config,
            schema,
            directory,
        }
    }
    async fn cleanup(&self) {
        self.client
            .batch_execute(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await
            .unwrap();
    }
}
fn cancel() -> Cancellation {
    Arc::new(AtomicBool::new(false))
}

#[tokio::test]
#[ignore = "需要专属 PostgreSQL；真实 TCP 代理丢弃数据库 COMMIT 确认"]
async fn real_postgres_lost_commit_ack_is_unknown_and_never_replayed() {
    postgres_unconfirmed_commit(false).await;
}

#[tokio::test]
#[ignore = "需要专属 PostgreSQL；真实提交完成后保持TCP打开但扣留响应"]
async fn real_postgres_stalled_commit_ack_is_bounded_and_never_replayed() {
    postgres_unconfirmed_commit(true).await;
}

async fn postgres_unconfirmed_commit(stall: bool) {
    let fixture = Fixture::new().await;
    let schema = &fixture.schema;
    fixture.client.batch_execute(&format!("CREATE TABLE {schema}.src(id BIGINT PRIMARY KEY,v TEXT); CREATE TABLE {schema}.dst(LIKE {schema}.src INCLUDING ALL); INSERT INTO {schema}.src VALUES(1,'已提交'),(2,'exact');")).await.unwrap();
    let proxy = PgProxy::start_with_fault(
        fixture.config.host.clone(),
        fixture.config.port,
        !stall,
        stall,
    )
    .await;
    let mut target = fixture.config.clone();
    target.host = "127.0.0.1".into();
    target.port = proxy.port;
    let request = DataTaskRequest {
        protocol_version: 1,
        kind: DataTaskKind::Transfer,
        mode: DataTaskMode::Append,
        source: DataEndpoint {
            saved_connection_id: "source".into(),
            database: schema.clone(),
        },
        target: DataEndpoint {
            saved_connection_id: "target".into(),
            database: schema.clone(),
        },
        mappings: vec![TableMapping {
            source_table: "src".into(),
            target_table: "dst".into(),
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
    let token = cancel();
    let plan = executor::prepare_task(
        "lost-commit".into(),
        request,
        fixture.config.clone(),
        target.clone(),
        fixture.directory.join("spool"),
        token.clone(),
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        executor::execute_plan(
            Arc::new(plan),
            fixture.config.clone(),
            target,
            token,
            Arc::new(|_| {}),
        ),
    )
    .await
    .expect("断开的 COMMIT 响应不能无限等待");
    let rows = fixture
        .client
        .query(&format!("SELECT id,v FROM {schema}.dst ORDER BY id"), &[])
        .await
        .unwrap();
    fixture.cleanup().await;
    assert_eq!(result.status, DataTaskStatus::OutcomeUnknown);
    assert_eq!(result.commit_state, DataCommitState::Unknown);
    assert_eq!(result.error.unwrap().code, "outcome_unknown");
    assert!(result.requires_target_refresh);
    assert_eq!(
        rows.iter()
            .map(|r| (r.get::<_, i64>(0), r.get::<_, String>(1)))
            .collect::<Vec<_>>(),
        vec![(1, "已提交".into()), (2, "exact".into())]
    );
    assert_eq!(
        proxy.stats.commits.load(Ordering::SeqCst),
        1,
        "未知 COMMIT 不得重放"
    );
    assert_eq!(
        proxy.stats.inserts.load(Ordering::SeqCst),
        1,
        "已提交 INSERT 不得自动重放"
    );
    assert_eq!(
        proxy.stats.dropped_commit_acks.load(Ordering::SeqCst),
        1,
        "必须证明故障注入发生在服务器提交之后"
    );
    assert!(proxy.stats.errors.lock().unwrap().is_empty());
}

async fn postgres_query_budget(table_count: usize) {
    let fixture = Fixture::new().await;
    let schema = &fixture.schema;
    let ddl = (0..table_count).map(|i| format!("CREATE TABLE {schema}.t{i}(id BIGINT PRIMARY KEY,v TEXT); INSERT INTO {schema}.t{i} VALUES(1,'数据');")).collect::<String>();
    fixture.client.batch_execute(&ddl).await.unwrap();
    let proxy = PgProxy::start(fixture.config.host.clone(), fixture.config.port, false).await;
    let mut config = fixture.config.clone();
    config.host = "127.0.0.1".into();
    config.port = proxy.port;
    let token = cancel();
    let mut session = executor::open_session(
        config,
        DataEndpoint {
            saved_connection_id: "budget".into(),
            database: schema.clone(),
        },
        token.clone(),
    )
    .await
    .unwrap();
    proxy.stats.selects.store(0, Ordering::SeqCst);
    session.begin_read().await.unwrap();
    let metadata = session.load_metadata().await.unwrap();
    let metadata_selects = proxy.stats.selects.swap(0, Ordering::SeqCst);
    let projections = (0..table_count)
        .map(|i| Projection {
            table: format!("t{i}"),
            output_table: format!("t{i}"),
            columns: vec!["id".into(), "v".into()],
            key_indices: vec![0],
        })
        .collect();
    let (sender, mut receiver) = RowSender::channel(Default::default());
    let consumer = tokio::spawn(async move {
        let mut n = 0;
        while receiver.recv().await.is_some() {
            n += 1;
        }
        n
    });
    let rows = session
        .stream_rows(projections, token, sender)
        .await
        .unwrap();
    let received = consumer.await.unwrap();
    let data_selects = proxy.stats.selects.load(Ordering::SeqCst);
    session.rollback().await.unwrap();
    drop(session);
    fixture.cleanup().await;
    assert_eq!(metadata.tables.len(), table_count);
    assert_eq!(rows, table_count as u64);
    assert_eq!(received, table_count);
    assert_eq!(
        metadata_selects, 5,
        "{table_count} 表的真实 PostgreSQL 元数据 SELECT 预算"
    );
    assert_eq!(
        data_selects, 1,
        "{table_count} 表必须建立一个集合数据 SELECT"
    );
    assert!(proxy.stats.errors.lock().unwrap().is_empty());
}
#[tokio::test]
#[ignore = "需要专属 PostgreSQL；代理统计真实协议中的 SELECT"]
async fn real_postgres_one_table_has_fixed_query_budget() {
    postgres_query_budget(1).await;
}
#[tokio::test]
#[ignore = "需要专属 PostgreSQL；代理统计真实协议中的 SELECT"]
async fn real_postgres_ten_tables_have_fixed_query_budget() {
    postgres_query_budget(10).await;
}
#[tokio::test]
#[ignore = "需要专属 PostgreSQL；代理统计真实协议中的 SELECT"]
async fn real_postgres_hundred_tables_have_fixed_query_budget() {
    postgres_query_budget(100).await;
}

#[tokio::test]
#[ignore = "需要专属 PostgreSQL；取消等待真实表锁的集合快照"]
async fn real_postgres_cancel_pending_snapshot_is_bounded() {
    let fixture = Fixture::new().await;
    let schema = &fixture.schema;
    fixture
        .client
        .batch_execute(&format!(
            "CREATE TABLE {schema}.src(id BIGINT PRIMARY KEY); INSERT INTO {schema}.src VALUES(1)"
        ))
        .await
        .unwrap();
    let token = cancel();
    let mut session = executor::open_session(
        fixture.config.clone(),
        DataEndpoint {
            saved_connection_id: "cancel-source".into(),
            database: schema.clone(),
        },
        token.clone(),
    )
    .await
    .unwrap();
    session.begin_read().await.unwrap();
    session.load_metadata().await.unwrap();
    fixture
        .client
        .batch_execute(&format!(
            "BEGIN; LOCK TABLE {schema}.src IN ACCESS EXCLUSIVE MODE"
        ))
        .await
        .unwrap();
    let (sender, _receiver) = RowSender::channel(Default::default());
    let signal = token.clone();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        signal.store(true, Ordering::Release);
        std::time::Instant::now()
    });
    let read = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        session.stream_rows(
            vec![Projection {
                table: "src".into(),
                output_table: "src".into(),
                columns: vec!["id".into()],
                key_indices: vec![0],
            }],
            token,
            sender,
        ),
    )
    .await;
    let elapsed = canceller.await.unwrap().elapsed();
    // 先释放测试锁，失败断言也不能遗留被阻塞的后端。
    fixture.client.batch_execute("ROLLBACK").await.unwrap();
    let rollback =
        tokio::time::timeout(std::time::Duration::from_secs(3), session.rollback()).await;
    drop(session);
    fixture.cleanup().await;
    assert!(read.is_ok(), "取消等待快照查询不应等到表锁超时");
    assert!(read.unwrap().unwrap_err().starts_with("cancelled:"));
    assert!(
        rollback.is_ok_and(|r| r.is_ok()),
        "取消后必须可确认回滚并释放连接"
    );
    assert!(elapsed < std::time::Duration::from_secs(2));
    println!(
        "DATA_TASK_CANCEL_METRICS phase=pending_snapshot elapsed_ms={}",
        elapsed.as_millis()
    );
}

fn transfer_request(schema: &str) -> DataTaskRequest {
    DataTaskRequest {
        protocol_version: 1,
        kind: DataTaskKind::Transfer,
        mode: DataTaskMode::Append,
        source: DataEndpoint {
            saved_connection_id: "source".into(),
            database: schema.into(),
        },
        target: DataEndpoint {
            saved_connection_id: "target".into(),
            database: schema.into(),
        },
        mappings: vec![TableMapping {
            source_table: "src".into(),
            target_table: "dst".into(),
            columns: vec![ColumnMapping {
                source_column: "id".into(),
                target_column: "id".into(),
            }],
        }],
    }
}

#[tokio::test]
#[ignore = "需要专属 PostgreSQL；执行等待目标保护锁时取消并确认回滚"]
async fn real_postgres_cancel_pending_target_lock_is_rolled_back() {
    let fixture = Fixture::new().await;
    let target_fixture = Fixture::new().await;
    let schema = &fixture.schema;
    let target_schema = &target_fixture.schema;
    fixture.client.batch_execute(&format!("CREATE TABLE {schema}.src(id BIGINT PRIMARY KEY); INSERT INTO {schema}.src VALUES(1); CREATE TABLE {target_schema}.dst(id BIGINT PRIMARY KEY)")).await.unwrap();
    let proxy = PgProxy::start(fixture.config.host.clone(), fixture.config.port, false).await;
    let mut target_config = fixture.config.clone();
    target_config.host = "127.0.0.1".into();
    target_config.port = proxy.port;
    let token = cancel();
    let mut request = transfer_request(schema);
    request.target.database = target_schema.clone();
    let plan = executor::prepare_task(
        "cancel-lock".into(),
        request,
        fixture.config.clone(),
        target_config.clone(),
        fixture.directory.join("spool"),
        token.clone(),
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    fixture
        .client
        .batch_execute(&format!(
            "BEGIN; LOCK TABLE {target_schema}.dst IN ACCESS EXCLUSIVE MODE"
        ))
        .await
        .unwrap();
    let signal = token.clone();
    let stats = proxy.stats.clone();
    let canceller = tokio::spawn(async move {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            while stats.locks.load(Ordering::Acquire) == 0 {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("必须观测到目标会话已发送保护锁请求");
        signal.store(true, Ordering::Release);
        std::time::Instant::now()
    });
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(4),
        executor::execute_plan(
            Arc::new(plan),
            fixture.config.clone(),
            target_config,
            token,
            Arc::new(|_| {}),
        ),
    )
    .await;
    let elapsed = canceller.await.unwrap().elapsed();
    fixture.client.batch_execute("ROLLBACK").await.unwrap();
    let count: i64 = fixture
        .client
        .query_one(&format!("SELECT count(*) FROM {target_schema}.dst"), &[])
        .await
        .unwrap()
        .get(0);
    fixture.cleanup().await;
    target_fixture.cleanup().await;
    let result = result.expect("取消不能等待目标锁的10秒超时");
    assert_eq!(result.status, DataTaskStatus::Cancelled);
    assert_eq!(result.commit_state, DataCommitState::RolledBack);
    assert_eq!(result.error.unwrap().code, "cancelled");
    assert_eq!(count, 0);
    assert!(elapsed < std::time::Duration::from_secs(2));
    println!(
        "DATA_TASK_CANCEL_METRICS phase=pending_target_lock elapsed_ms={}",
        elapsed.as_millis()
    );
}
