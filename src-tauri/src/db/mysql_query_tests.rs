use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

#[tokio::test]
async fn mysql_query_early_cancel_stops_acquisition() {
    let registry = MysqlQueryRegistry::default();
    assert!(registry.cancel("a", "early").await.unwrap());
    let guard = registry.register("a", "early").unwrap();
    let acquisitions = AtomicUsize::new(0);
    let result = guard
        .run(async {
            acquisitions.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await;
    assert!(result.is_err());
    assert_eq!(acquisitions.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn mysql_query_registry_scopes_and_rejects_duplicates() {
    let registry = MysqlQueryRegistry::default();
    let first = registry.register("a", "same").unwrap();
    let other = registry.register("b", "same").unwrap();
    assert!(registry.register("a", "same").is_err());
    assert!(registry.cancel("a", "same").await.unwrap());
    assert!(first.is_cancelled());
    assert!(!other.is_cancelled());
}

#[tokio::test]
async fn mysql_query_finished_token_is_idempotent() {
    let registry = MysqlQueryRegistry::default();
    drop(registry.register("a", "old").unwrap());
    assert!(!registry.cancel("a", "old").await.unwrap());
    assert!(!registry.cancel("a", "old").await.unwrap());
    assert!(registry.register("a", "old").is_err());
    let current = registry.register("a", "new").unwrap();
    assert!(!current.is_cancelled());
    // 过期后可重新使用；旧 guard 不得移除新代次。
    registry.entries.lock().unwrap().insert(
        ("a".into(), "old".into()),
        Entry::Finished(Instant::now() - Duration::from_secs(61)),
    );
    let reused = registry.register("a", "old").unwrap();
    assert!(!reused.is_cancelled());
}

#[tokio::test]
async fn mysql_query_tombstones_are_bounded_without_evicting_active_queries() {
    let registry = MysqlQueryRegistry::default();
    let guard = registry.register("a", "active").unwrap();
    for index in 0..300 {
        registry.cancel("a", &index.to_string()).await.unwrap();
    }
    assert_eq!(registry.entries.lock().unwrap().len(), 257);
    assert!(registry.register("a", "active").is_err());
    assert!(!guard.is_cancelled());
}

fn with_transport(
    transport: impl Fn(mysql_async::Opts, u64) -> futures_util::future::BoxFuture<'static, Result<(), String>>
        + Send
        + Sync
        + 'static,
) -> MysqlQueryRegistry {
    MysqlQueryRegistry {
        transport: Arc::new(transport),
        cancel_budget: Duration::from_millis(40),
        ..MysqlQueryRegistry::default()
    }
}

#[tokio::test]
async fn mysql_query_cancel_bypasses_busy_pool() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let registry = with_transport(move |_, thread| {
        assert_eq!(thread, 123);
        counter.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    });
    let guard = registry.register("a", "run").unwrap();
    guard
        .attach_connection(123, mysql_async::Opts::default())
        .unwrap();
    // 已占满的业务池不能再发出租约；取消路径的依赖中没有业务池。
    let pool = tokio::sync::Semaphore::new(0);
    let waiter = pool.acquire();
    tokio::pin!(waiter);
    let (first, second) = tokio::join!(registry.cancel("a", "run"), registry.cancel("a", "run"));
    assert_eq!(first, Ok(true));
    assert_eq!(second, Ok(true));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(tokio::time::timeout(Duration::from_millis(1), &mut waiter)
        .await
        .is_err());
}

#[tokio::test]
async fn mysql_query_cancel_timeout_is_bounded() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let registry = with_transport(move |_, _| {
        counter.fetch_add(1, Ordering::SeqCst);
        Box::pin(std::future::pending())
    });
    let guard = registry.register("a", "run").unwrap();
    guard
        .attach_connection(1, mysql_async::Opts::default())
        .unwrap();
    let error = tokio::time::timeout(Duration::from_secs(1), registry.cancel("a", "run"))
        .await
        .unwrap()
        .unwrap_err();
    assert!(error.contains("超时"));
    assert!(error.contains("刷新确认"));
    assert_eq!(registry.cancel("a", "run").await, Err(error));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

struct Lease(Arc<AtomicUsize>);
impl Drop for Lease {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn mysql_query_completion_race_keeps_original_lease() {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let barrier = Arc::new(tokio::sync::Semaphore::new(0));
    let unblock = barrier.clone();
    let mut registry = with_transport(move |_, _| {
        counter.fetch_add(1, Ordering::SeqCst);
        let wait = unblock.clone();
        Box::pin(async move {
            wait.acquire().await.unwrap().forget();
            Ok(())
        })
    });
    registry.cancel_budget = Duration::from_secs(1);
    let guard = registry.register("a", "run").unwrap();
    guard
        .attach_connection(1, mysql_async::Opts::default())
        .unwrap();
    let cancel = registry.cancel("a", "run");
    tokio::pin!(cancel);
    assert!(tokio::time::timeout(Duration::from_millis(5), &mut cancel)
        .await
        .is_err());
    let released = Arc::new(AtomicUsize::new(0));
    let finish = finish_connection(
        Lease(released.clone()),
        Ok(()),
        &guard,
        |lease| async move {
            drop(lease);
            Ok(())
        },
    );
    tokio::pin!(finish);
    assert!(tokio::time::timeout(Duration::from_millis(5), &mut finish)
        .await
        .is_err());
    assert_eq!(released.load(Ordering::SeqCst), 0);
    barrier.add_permits(1);
    assert!(cancel.await.unwrap());
    assert!(finish.await.is_err());
    assert_eq!(released.load(Ordering::SeqCst), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(!registry.cancel("a", "run").await.unwrap());

    let guard = registry.register("a", "natural").unwrap();
    guard
        .attach_connection(2, mysql_async::Opts::default())
        .unwrap();
    let closed = Arc::new(AtomicUsize::new(0));
    let count = closed.clone();
    assert_eq!(
        finish_connection((), Ok(42), &guard, move |_| async move {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .await,
        Ok(42)
    );
    assert!(!registry.cancel("a", "natural").await.unwrap());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert_eq!(closed.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn mysql_query_cancel_failure_discards_connection() {
    for failure in ["认证失败", "KILL 权限不足", "网络超时"] {
        let registry = with_transport(move |_, _| Box::pin(async move { Err(failure.into()) }));
        let guard = registry.register("a", "run").unwrap();
        guard
            .attach_connection(1, mysql_async::Opts::default())
            .unwrap();
        let cancel_error = registry.cancel("a", "run").await.unwrap_err();
        assert!(cancel_error.contains(failure));
        let closed = Arc::new(AtomicUsize::new(0));
        let count = closed.clone();
        let result: Result<(), String> =
            finish_connection((), Err("原查询错误".into()), &guard, move |_| async move {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            })
            .await;
        let error = result.unwrap_err();
        assert!(error.starts_with("原查询错误"));
        assert!(error.contains(failure));
        assert!(error.contains("刷新确认"));
        assert_eq!(closed.load(Ordering::SeqCst), 1);
        assert!(!registry.cancel("a", "run").await.unwrap());
    }
}

#[tokio::test]
async fn mysql_query_cancel_request_drop_does_not_strand_cleanup() {
    let registry = with_transport(|_, _| {
        Box::pin(async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            Ok(())
        })
    });
    let guard = registry.register("a", "run").unwrap();
    guard
        .attach_connection(1, mysql_async::Opts::default())
        .unwrap();
    {
        let cancel = registry.cancel("a", "run");
        tokio::pin!(cancel);
        assert!(tokio::time::timeout(Duration::from_millis(1), &mut cancel)
            .await
            .is_err());
    }
    assert!(
        tokio::time::timeout(Duration::from_secs(1), registry.cancel("a", "run"))
            .await
            .unwrap()
            .unwrap()
    );
}

#[tokio::test]
async fn mysql_query_cancel_options_keep_tls_endpoint_without_session_sql() {
    let registry = with_transport(|opts, _| {
        assert_eq!(opts.ip_or_hostname(), "127.0.0.1");
        assert_eq!(opts.tcp_port(), 13306);
        assert!(opts.ssl_opts().is_some());
        assert_eq!(opts.user(), Some("synthetic"));
        assert!(opts.pass() == Some("synthetic-secret"));
        assert!(opts.init().is_empty());
        assert!(opts.setup().is_empty());
        Box::pin(async { Ok(()) })
    });
    let guard = registry.register("a", "run").unwrap();
    let opts = mysql_async::OptsBuilder::default()
        .ip_or_hostname("127.0.0.1")
        .tcp_port(13306)
        .user(Some("synthetic"))
        .pass(Some("synthetic-secret"))
        .ssl_opts(mysql_async::SslOpts::default())
        .init(vec!["SET @init = 1"])
        .setup(vec!["SET @setup = 1"]);
    guard.attach_connection(1, opts.into()).unwrap();
    assert!(registry.cancel("a", "run").await.unwrap());
}

// 小型 MySQL 协议替身，只响应客户端命令；不依赖数据库、凭据或系统服务。
struct ProtocolServer {
    opts: Opts,
    queries: Arc<Mutex<Vec<(u32, String)>>>,
    release_use: Arc<tokio::sync::Semaphore>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ProtocolServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn read_packet(stream: &mut tokio::net::TcpStream) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut header = [0; 4];
    stream.read_exact(&mut header).await?;
    let size = u32::from_le_bytes([header[0], header[1], header[2], 0]) as usize;
    let mut body = vec![0; size];
    stream.read_exact(&mut body).await?;
    Ok(body)
}

async fn write_packet(
    stream: &mut tokio::net::TcpStream,
    seq: u8,
    body: &[u8],
) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;
    let len = (body.len() as u32).to_le_bytes();
    stream.write_all(&[len[0], len[1], len[2], seq]).await?;
    stream.write_all(body).await
}

impl ProtocolServer {
    async fn start() -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let queries = Arc::new(Mutex::new(Vec::new()));
        let observed = queries.clone();
        let release_use = Arc::new(tokio::sync::Semaphore::new(0));
        let unblock = release_use.clone();
        let task = tokio::spawn(async move {
            let mut children = tokio::task::JoinSet::new();
            let mut thread_id = 100;
            while let Ok((mut stream, _)) = listener.accept().await {
                thread_id += 1;
                let queries = observed.clone();
                let release = unblock.clone();
                children.spawn(async move {
                    let serve = async {
                        let mut greeting = b"\x0a8.0.0-test\0".to_vec();
                        greeting.extend_from_slice(&u32::to_le_bytes(thread_id));
                        greeting.extend_from_slice(b"12345678\0\x05\xa2\x2d\x02\0\x08\0\x15");
                        greeting.extend_from_slice(&[0; 10]);
                        greeting.extend_from_slice(b"abcdefghijkl\0mysql_native_password\0");
                        write_packet(&mut stream, 0, &greeting).await?;
                        read_packet(&mut stream).await?;
                        let ok = [0, 0, 0, 2, 0, 0, 0];
                        write_packet(&mut stream, 2, &ok).await?;
                        loop {
                            let packet = read_packet(&mut stream).await?;
                            match packet.first() {
                                Some(1) | None => return Ok::<(), std::io::Error>(()),
                                Some(3) => {
                                    let sql = String::from_utf8_lossy(&packet[1..]).into_owned();
                                    queries.lock().unwrap().push((thread_id, sql.clone()));
                                    if sql.starts_with("USE `hold`") {
                                        release.acquire().await.unwrap().forget();
                                    }
                                    if sql == "SELECT oversized_multi" {
                                        // 一次结果流包含 100001 行和第二结果头；第二结果行流停顿。
                                        // 这是协议响应，不是在循环内发送 SQL。
                                        use tokio::io::AsyncWriteExt;
                                        let column = b"\x03def\0\0\0\x01n\0\x0c\x21\0\x0b\0\0\0\x03\0\0\0\0\0";
                                        write_packet(&mut stream, 1, &[1]).await?;
                                        write_packet(&mut stream, 2, column).await?;
                                        write_packet(&mut stream, 3, &[0xfe, 0, 0, 2, 0]).await?;
                                        let mut frames = Vec::with_capacity(600_100);
                                        let mut sequence = 4u8;
                                        for _ in 0..100_001 {
                                            frames.extend_from_slice(&[2, 0, 0, sequence, 1, b'1']);
                                            sequence = sequence.wrapping_add(1);
                                        }
                                        stream.write_all(&frames).await?;
                                        write_packet(&mut stream, sequence, &[0xfe, 0, 0, 10, 0]).await?;
                                        sequence = sequence.wrapping_add(1);
                                        write_packet(&mut stream, sequence, &[1]).await?;
                                        sequence = sequence.wrapping_add(1);
                                        write_packet(&mut stream, sequence, column).await?;
                                        sequence = sequence.wrapping_add(1);
                                        write_packet(&mut stream, sequence, &[0xfe, 0, 0, 2, 0]).await?;
                                        release.acquire().await.unwrap().forget();
                                        write_packet(&mut stream, sequence.wrapping_add(1), &[0xfe, 0, 0, 2, 0]).await?;
                                    } else if sql == "UPDATE broken SET x=1" {
                                        write_packet(&mut stream, 1, b"\xff\x28\x04#HY000synthetic query error").await?;
                                    } else {
                                        write_packet(&mut stream, 1, &ok).await?;
                                    }
                                }
                                _ => write_packet(&mut stream, 1, &ok).await?,
                            }
                        }
                    };
                    let _ = serve.await;
                });
            }
        });
        let opts = OptsBuilder::default()
            .ip_or_hostname("127.0.0.1")
            .tcp_port(port)
            .user(Some("synthetic"))
            .prefer_socket(false)
            .max_allowed_packet(Some(16 * 1024 * 1024))
            .wait_timeout(Some(28800))
            .pool_opts(
                mysql_async::PoolOpts::default()
                    .with_constraints(mysql_async::PoolConstraints::new(0, 5).unwrap()),
            );
        Self {
            opts: opts.into(),
            queries,
            release_use,
            task,
        }
    }

    async fn wait_for_query(&self, expected: &str) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if self
                    .queries
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|(_, sql)| sql == expected)
                {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("协议替身未收到预期命令");
    }
}

#[tokio::test]
async fn mysql_query_execution_uses_driver_thread_id() {
    let server = ProtocolServer::start().await;
    let pool = mysql_async::Pool::new(server.opts.clone());
    let registry = MysqlQueryRegistry::default();
    let guard = registry.register("a", "driver").unwrap();
    let run = crate::commands::data::execute_mysql_sql(
        pool.clone(),
        Some(guard),
        Some("hold".into()),
        "UPDATE test SET x=1".into(),
        false,
    );
    let cancel = async {
        server.wait_for_query("USE `hold`").await;
        registry.cancel("a", "driver").await
    };
    let (result, cancelled) = tokio::join!(run, cancel);
    assert!(result.is_err());
    assert_eq!(cancelled, Ok(true));
    let queries = server.queries.lock().unwrap().clone();
    let thread = queries
        .iter()
        .find(|(_, sql)| sql == "USE `hold`")
        .unwrap()
        .0;
    assert_eq!(
        queries
            .iter()
            .filter(|(_, sql)| sql.starts_with("KILL QUERY "))
            .map(|(_, sql)| sql.clone())
            .collect::<Vec<_>>(),
        vec![format!("KILL QUERY {thread}")]
    );
    assert!(!queries
        .iter()
        .any(|(_, sql)| sql == "SELECT CONNECTION_ID()" || sql == "UPDATE test SET x=1"));
    server.release_use.add_permits(1);
    pool.disconnect().await.unwrap();
}

#[tokio::test]
async fn mysql_query_cancel_during_wait_or_use_prevents_sql() {
    let server = ProtocolServer::start().await;
    let pool = mysql_async::Pool::new(server.opts.clone());
    let (a, b, c, d, e) = tokio::join!(
        pool.get_conn(),
        pool.get_conn(),
        pool.get_conn(),
        pool.get_conn(),
        pool.get_conn()
    );
    let leases = (a.unwrap(), b.unwrap(), c.unwrap(), d.unwrap(), e.unwrap());
    let registry = MysqlQueryRegistry::default();
    let guard = registry.register("a", "wait").unwrap();
    let run = crate::commands::data::execute_mysql_sql(
        pool.clone(),
        Some(guard),
        None,
        "UPDATE test SET x=1".into(),
        false,
    );
    let cancel = async {
        tokio::time::sleep(Duration::from_millis(5)).await;
        registry.cancel("a", "wait").await
    };
    let (result, cancelled) = tokio::join!(run, cancel);
    assert!(result.is_err());
    assert_eq!(cancelled, Ok(true));
    assert!(server.queries.lock().unwrap().is_empty());
    drop(leases);
    pool.disconnect().await.unwrap();
}

#[tokio::test]
async fn mysql_query_error_and_success_unregister() {
    let server = ProtocolServer::start().await;
    let pool = mysql_async::Pool::new(server.opts.clone());
    let registry = MysqlQueryRegistry::default();
    let guard = registry.register("a", "ok").unwrap();
    assert!(crate::commands::data::execute_mysql_sql(
        pool.clone(),
        Some(guard),
        None,
        "UPDATE test SET x=1".into(),
        false
    )
    .await
    .is_ok());
    assert!(!registry.cancel("a", "ok").await.unwrap());
    let guard = registry.register("a", "error").unwrap();
    let err = crate::commands::data::execute_mysql_sql(
        pool.clone(),
        Some(guard),
        None,
        "UPDATE broken SET x=1".into(),
        false,
    )
    .await
    .unwrap_err();
    assert!(err.contains("synthetic query error"));
    assert!(!registry.cancel("a", "error").await.unwrap());
    assert!(crate::commands::data::execute_mysql_sql(
        pool.clone(),
        None,
        None,
        "UPDATE legacy SET x=1".into(),
        false
    )
    .await
    .is_ok());
    let queries = server.queries.lock().unwrap().clone();
    let error_thread = queries
        .iter()
        .find(|(_, q)| q == "UPDATE broken SET x=1")
        .unwrap()
        .0;
    let next_thread = queries
        .iter()
        .find(|(_, q)| q == "UPDATE legacy SET x=1")
        .unwrap()
        .0;
    assert_ne!(error_thread, next_thread, "错误连接不能重入池");
    assert!(!queries.iter().any(|(_, q)| q == "SELECT CONNECTION_ID()"));
    pool.disconnect().await.unwrap();
}

#[tokio::test]
async fn mysql_query_dropped_execution_waiter_keeps_original_lease() {
    let server = ProtocolServer::start().await;
    let pool = mysql_async::Pool::new(server.opts.clone());
    let registry = MysqlQueryRegistry::default();
    let guard = registry.register("a", "abort").unwrap();
    let execution = tokio::spawn(crate::commands::data::execute_mysql_sql(
        pool.clone(),
        Some(guard),
        Some("hold".into()),
        "UPDATE test SET x=1".into(),
        false,
    ));
    server.wait_for_query("USE `hold`").await;
    execution.abort();
    let _ = execution.await;
    assert!(
        registry.cancel("a", "abort").await.unwrap(),
        "执行者须继续持有租约和登记"
    );
    server.release_use.add_permits(1);
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if matches!(
                registry
                    .entries
                    .lock()
                    .unwrap()
                    .get(&("a".into(), "abort".into())),
                Some(Entry::Finished(_))
            ) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!server
        .queries
        .lock()
        .unwrap()
        .iter()
        .any(|(_, q)| q == "UPDATE test SET x=1"));
    pool.disconnect().await.unwrap();
}

#[tokio::test]
async fn mysql_query_cancel_during_close_shares_failure_until_finished() {
    let registry = with_transport(|_, _| Box::pin(async { Err("KILL 权限不足".into()) }));
    let guard = registry.register("a", "close").unwrap();
    guard.attach_connection(1, Opts::default()).unwrap();
    let first = registry.cancel("a", "close").await;
    let close_gate = tokio::sync::Semaphore::new(0);
    let finish = finish_connection((), Ok(()), &guard, |_| async {
        close_gate.acquire().await.unwrap().forget();
        Ok(())
    });
    tokio::pin!(finish);
    assert!(tokio::time::timeout(Duration::from_millis(5), &mut finish)
        .await
        .is_err());
    assert_eq!(registry.cancel("a", "close").await, first);
    close_gate.add_permits(1);
    assert!(finish.await.is_err());
    assert_eq!(registry.cancel("a", "close").await, Ok(false));
}

#[tokio::test]
async fn mysql_query_budget_error_discards_stalled_multi_result_connection() {
    let server = ProtocolServer::start().await;
    let pool = mysql_async::Pool::new(server.opts.clone());
    let registry = MysqlQueryRegistry::default();
    let guard = registry.register("a", "budget").unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        crate::commands::data::execute_mysql_sql(
            pool.clone(),
            Some(guard),
            None,
            "SELECT oversized_multi".into(),
            false,
        ),
    )
    .await
    .unwrap();
    assert!(result.unwrap_err().contains("最大行数"));
    assert_eq!(registry.cancel("a", "budget").await, Ok(false));
    let metrics = pool.metrics();
    // 第二结果没有结束，原物理连接仍必须关闭并释放池槽。
    tokio::time::timeout(Duration::from_millis(300), async {
        while metrics.connection_count.load(Ordering::SeqCst) != 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("错误连接仍在后台排空结果，池槽没有有界释放");
    assert_eq!(metrics.connections_in_pool.load(Ordering::SeqCst), 0);
    server.release_use.add_permits(1);
    assert!(crate::commands::data::execute_mysql_sql(
        pool.clone(),
        None,
        None,
        "UPDATE next SET x=1".into(),
        false
    )
    .await
    .is_ok());
    let queries = server.queries.lock().unwrap().clone();
    assert_ne!(
        queries
            .iter()
            .find(|(_, q)| q == "SELECT oversized_multi")
            .unwrap()
            .0,
        queries
            .iter()
            .find(|(_, q)| q == "UPDATE next SET x=1")
            .unwrap()
            .0
    );
    pool.disconnect().await.unwrap();
}
