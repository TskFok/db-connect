//! 私有 CA 的真实 PostgreSQL TLS 验收；只接收显式隔离夹具配置。
use super::{executor, Cancellation};
use crate::models::{data_tasks::*, types::ConnectionConfig};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::watch,
    task::JoinHandle,
};

struct Fixture {
    client: tokio_postgres::Client,
    config: ConnectionConfig,
    wrong_ca: String,
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
        let path = std::env::var("DB_CONNECT_DATA_TASK_TLS_CONFIG")
            .expect("需要 validate_tls.py 创建的显式专属配置");
        let config: ConnectionConfig =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(config.host, "127.0.0.1", "只能使用回环隔离夹具");
        assert_eq!(config.ssl_mode.as_deref(), Some("verify_identity"));
        assert_eq!(
            config.ssl_tls_hostname.as_deref(),
            Some("db-connect-validate.local")
        );
        let mut admin = tokio_postgres::Config::new();
        admin
            .host(&config.host)
            .port(config.port)
            .user(&config.username)
            .password(config.password.as_deref().unwrap())
            .dbname(config.database.as_deref().unwrap());
        // 仅夹具管理员通过回环明文检查；被测数据任务必须走项目 verify_identity 路径。
        let (client, connection) = admin.connect(tokio_postgres::NoTls).await.unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let schema = format!("dbconnect_tls_{}", uuid::Uuid::new_v4().simple());
        let directory = std::env::temp_dir().join(&schema);
        std::fs::create_dir(&directory).unwrap();
        client.batch_execute(&format!("CREATE SCHEMA {schema}; CREATE TABLE {schema}.src(id BIGINT PRIMARY KEY,n NUMERIC(38,18),v TEXT,b BYTEA); CREATE TABLE {schema}.dst(LIKE {schema}.src INCLUDING ALL); INSERT INTO {schema}.src VALUES(9007199254740993,12345678901234567890.123456789012345678,'证书验收',decode('0001ff','hex')),(9007199254740994,NULL,NULL,NULL)")).await.unwrap();
        Self {
            client,
            config,
            schema,
            directory,
            wrong_ca: std::env::var("DB_CONNECT_DATA_TASK_TLS_WRONG_CA").unwrap(),
        }
    }
    fn request(&self) -> DataTaskRequest {
        DataTaskRequest {
            protocol_version: 1,
            kind: DataTaskKind::Transfer,
            mode: DataTaskMode::Append,
            source: DataEndpoint {
                saved_connection_id: "tls-source".into(),
                database: self.schema.clone(),
            },
            target: DataEndpoint {
                saved_connection_id: "tls-target".into(),
                database: self.schema.clone(),
            },
            mappings: vec![TableMapping {
                source_table: "src".into(),
                target_table: "dst".into(),
                columns: ["id", "n", "v", "b"]
                    .into_iter()
                    .map(|name| ColumnMapping {
                        source_column: name.into(),
                        target_column: name.into(),
                    })
                    .collect(),
            }],
        }
    }
    async fn count(&self) -> i64 {
        self.client
            .query_one(&format!("SELECT count(*) FROM {}.dst", self.schema), &[])
            .await
            .unwrap()
            .get(0)
    }
    async fn assert_connections_released(&self) {
        // 给异步 Drop 关闭专属池的任务一个有界宽限；不循环查询数据库。
        tokio::time::sleep(Duration::from_millis(300)).await;
        let count: i64 = self.client.query_one("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND usename=current_user AND pid<>pg_backend_pid()", &[]).await.unwrap().get(0);
        assert_eq!(count, 0, "TLS 数据任务不得遗留专属物理连接");
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
#[ignore = "需要 validate_tls.py 的独立 PostgreSQL TLS 容器及临时私有CA"]
async fn real_postgres_verify_identity_custom_ca_transfer_is_exact() {
    let f = Fixture::new().await;
    let session = executor::open_session(f.config.clone(), f.request().source, cancel())
        .await
        .expect("项目 verify_identity 必须接受本次临时私有 CA 和正确 DNS 主机名");
    let ssl: bool = f.client.query_one("SELECT bool_and(s.ssl) FROM pg_stat_activity a JOIN pg_stat_ssl s ON a.pid=s.pid WHERE a.datname=current_database() AND a.usename=current_user AND a.pid<>pg_backend_pid()", &[]).await.unwrap().get(0);
    assert!(ssl, "被测真实数据任务连接必须使用 TLS");
    drop(session);
    let plan = executor::prepare_task(
        "tls-exact".into(),
        f.request(),
        f.config.clone(),
        f.config.clone(),
        f.directory.join("spool"),
        cancel(),
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    let result = executor::execute_plan(
        Arc::new(plan),
        f.config.clone(),
        f.config.clone(),
        cancel(),
        Arc::new(|_| {}),
    )
    .await;
    assert_eq!(result.status, DataTaskStatus::Succeeded);
    assert_eq!(result.commit_state, DataCommitState::Committed);
    let rows = f
        .client
        .query(
            &format!(
                "SELECT id::text,n::text,v,encode(b,'hex') FROM {}.dst ORDER BY id",
                f.schema
            ),
            &[],
        )
        .await
        .unwrap();
    let actual = rows
        .iter()
        .map(|r| {
            (
                r.get::<_, String>(0),
                r.get::<_, Option<String>>(1),
                r.get::<_, Option<String>>(2),
                r.get::<_, Option<String>>(3),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        actual,
        vec![
            (
                "9007199254740993".into(),
                Some("12345678901234567890.123456789012345678".into()),
                Some("证书验收".into()),
                Some("0001ff".into())
            ),
            ("9007199254740994".into(), None, None, None)
        ]
    );
    f.assert_connections_released().await;
    f.cleanup().await;
    println!("DATA_TASK_TLS_METRICS case=custom_ca_exact rows=2 ssl=true connections_after=0");
}

async fn rejected_identity(wrong_ca: bool) {
    let f = Fixture::new().await;
    let mut invalid = f.config.clone();
    if wrong_ca {
        invalid.ssl_ca_path = Some(f.wrong_ca.clone());
    } else {
        invalid.ssl_tls_hostname = Some("incorrect-db-connect.local".into());
    }
    // 直接验证项目连接器确实拒绝证书，再验证任务入口拒绝且目标未写入。
    let handle =
        crate::db::postgres::build_postgres_pool(&invalid.host, invalid.port, &invalid).unwrap();
    assert!(
        handle.pool.get().await.is_err(),
        "错误 CA/主机名必须导致真实 TLS 握手失败"
    );
    handle.pool.close();
    drop(handle);
    let result = executor::prepare_task(
        "tls-reject".into(),
        f.request(),
        f.config.clone(),
        invalid,
        f.directory.join("spool"),
        cancel(),
        Arc::new(|_| {}),
    )
    .await;
    assert!(result.is_err(), "证书校验失败不能返回可执行计划");
    assert_eq!(f.count().await, 0);
    f.assert_connections_released().await;
    f.cleanup().await;
    println!(
        "DATA_TASK_TLS_METRICS case={} rejected=true target_rows=0 connections_after=0",
        if wrong_ca {
            "wrong_ca"
        } else {
            "wrong_hostname"
        }
    );
}
#[tokio::test]
#[ignore = "需要 validate_tls.py 的临时私有CA"]
async fn real_postgres_wrong_ca_is_rejected_without_target_writes() {
    rejected_identity(true).await;
}
#[tokio::test]
#[ignore = "需要 validate_tls.py 的临时私有CA"]
async fn real_postgres_wrong_hostname_is_rejected_without_target_writes() {
    rejected_identity(false).await;
}

/// TLS 不解密代理：只提供断链信号及连接数，不检查认证或 SQL。
struct TlsProxy {
    port: u16,
    disconnect: watch::Sender<bool>,
    active: Arc<AtomicUsize>,
    acceptor: JoinHandle<()>,
}
impl Drop for TlsProxy {
    fn drop(&mut self) {
        let _ = self.disconnect.send(true);
        self.acceptor.abort();
    }
}
impl TlsProxy {
    async fn start(upstream: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (disconnect, receiver) = watch::channel(false);
        let active = Arc::new(AtomicUsize::new(0));
        let connections = active.clone();
        let acceptor = tokio::spawn(async move {
            while let Ok((mut client, _)) = listener.accept().await {
                let mut stop = receiver.clone();
                let connections = connections.clone();
                tokio::spawn(async move {
                    if *stop.borrow() {
                        return;
                    }
                    let Ok(mut server) = TcpStream::connect(("127.0.0.1", upstream)).await else {
                        return;
                    };
                    connections.fetch_add(1, Ordering::SeqCst);
                    tokio::select! { _ = tokio::io::copy_bidirectional(&mut client, &mut server) => {}, _ = stop.changed() => {} }
                    connections.fetch_sub(1, Ordering::SeqCst);
                });
            }
        });
        Self {
            port,
            disconnect,
            active,
            acceptor,
        }
    }
}
#[tokio::test]
#[ignore = "需要 validate_tls.py；真实TLS事务中断链且不解密"]
async fn real_postgres_tls_disconnect_is_honest_and_releases_connections() {
    let f = Fixture::new().await;
    let proxy = TlsProxy::start(f.config.port).await;
    let mut target = f.config.clone();
    target.port = proxy.port;
    let plan = executor::prepare_task(
        "tls-disconnect".into(),
        f.request(),
        f.config.clone(),
        target.clone(),
        f.directory.join("spool"),
        cancel(),
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    let disconnect = proxy.disconnect.clone();
    let tripped = Arc::new(AtomicBool::new(false));
    let signal = tripped.clone();
    let result = tokio::time::timeout(
        Duration::from_secs(15),
        executor::execute_plan(
            Arc::new(plan),
            f.config.clone(),
            target,
            cancel(),
            Arc::new(move |progress| {
                if progress.status == DataTaskStatus::Executing
                    && !signal.swap(true, Ordering::SeqCst)
                {
                    let _ = disconnect.send(true);
                }
            }),
        ),
    )
    .await
    .expect("TLS 断链不能无限等待");
    assert!(
        tripped.load(Ordering::SeqCst),
        "必须在真实目标事务工作期间触发断链"
    );
    assert!(matches!(
        result.status,
        DataTaskStatus::Failed | DataTaskStatus::OutcomeUnknown
    ));
    assert_ne!(result.commit_state, DataCommitState::Committed);
    if result.commit_state == DataCommitState::Unknown {
        assert_eq!(result.status, DataTaskStatus::OutcomeUnknown);
        assert!(result.requires_target_refresh);
    }
    assert_eq!(f.count().await, 0);
    f.assert_connections_released().await;
    assert_eq!(proxy.active.load(Ordering::SeqCst), 0);
    f.cleanup().await;
    println!("DATA_TASK_TLS_METRICS case=disconnect status={:?} commit={:?} target_rows=0 connections_after=0", result.status, result.commit_state);
}
