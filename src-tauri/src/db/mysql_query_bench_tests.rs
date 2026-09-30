//! 显式临时实例上的单样本基准；由外部脚本重复运行，Rust 中不循环发 SQL。
//! 需要 DB_CONNECT_MYSQL_BENCH_FIXTURE 指向本轮创建的临时夹具目录。
use super::*;
use crate::commands::data::execute_mysql_sql;
use mysql_async::{params, Pool, PoolConstraints, PoolOpts};
use std::path::PathBuf;
use std::sync::atomic::Ordering;

fn verified<T, E>(result: Result<T, E>, message: &str) -> T {
    match result {
        Ok(value) => value,
        // 不把驱动错误中的 SQL 或连接配置打印进性能证据。
        Err(_) => panic!("{message}"),
    }
}

async fn pool_gauge(pool: &Pool, expected_in_use: usize, expected_available: usize) {
    let metrics = pool.metrics();
    verified(
        tokio::time::timeout(Duration::from_secs(5), async {
            while metrics.connections_in_use.load(Ordering::Relaxed) != expected_in_use
                || metrics.connections_in_pool.load(Ordering::Relaxed) != expected_available
            {
                // 这里只观察进程内计数，不向数据库轮询。
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        })
        .await,
        "连接池未在预算内达到夹具要求的状态",
    );
}

async fn warm_five_connections(pool: &Pool) {
    let (a, b, c, d, e) = tokio::join!(
        pool.get_conn(),
        pool.get_conn(),
        pool.get_conn(),
        pool.get_conn(),
        pool.get_conn()
    );
    let leases = (
        verified(a, "预热连接 1 失败"),
        verified(b, "预热连接 2 失败"),
        verified(c, "预热连接 3 失败"),
        verified(d, "预热连接 4 失败"),
        verified(e, "预热连接 5 失败"),
    );
    assert_eq!(pool.metrics().connection_count.load(Ordering::Relaxed), 5);
    drop(leases);
    pool_gauge(pool, 0, 5).await;
}

fn blocker(pool: Pool, sql: String) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut conn = verified(pool.get_conn().await, "占池连接获取失败");
        verified(conn.query_drop(sql).await, "占池查询执行失败");
    })
}

#[tokio::test]
#[ignore = "需要本轮创建的独立 MySQL 夹具；每次仅执行一个测量样本"]
async fn mysql_query_bench_isolated_sample() {
    verified(
        tokio::time::timeout(Duration::from_secs(15), isolated_sample()).await,
        "隔离基准超出单样本预算",
    );
}

async fn isolated_sample() {
    let fixture = PathBuf::from(verified(
        std::env::var("DB_CONNECT_MYSQL_BENCH_FIXTURE"),
        "缺少显式临时夹具目录",
    ));
    let fixture = verified(fixture.canonicalize(), "临时夹具目录不存在");
    assert!(fixture
        .to_string_lossy()
        .starts_with("/private/tmp/db-connect-mysql-cancel-"));
    let metadata: serde_json::Value = verified(
        serde_json::from_slice(&verified(
            std::fs::read(fixture.join("fixture.json")),
            "临时夹具元信息不存在",
        )),
        "临时夹具元信息无效",
    );
    let port = metadata["port"].as_u64().expect("临时端口必须是数字");
    assert!(port > 1024 && port <= u16::MAX as u64 && port != 3306);
    let variant = std::env::var("DB_CONNECT_MYSQL_BENCH_VARIANT").unwrap_or_else(|_| "new".into());
    let thermal = std::env::var("DB_CONNECT_MYSQL_BENCH_THERMAL").unwrap_or_else(|_| "cold".into());
    assert!(matches!(variant.as_str(), "old" | "new"));
    assert!(matches!(thermal.as_str(), "cold" | "warm"));
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let new_path = variant == "new";
    let opts = Opts::from(
        OptsBuilder::default()
            .ip_or_hostname("127.0.0.1")
            .tcp_port(port as u16)
            .user(Some("root"))
            .pass(None::<String>)
            .prefer_socket(false)
            .tcp_keepalive(Some(Duration::from_secs(30)))
            .init(vec!["SET NAMES utf8mb4"])
            .pool_opts(
                PoolOpts::default()
                    .with_constraints(PoolConstraints::new(0, 5).unwrap())
                    .with_inactive_connection_ttl(Duration::from_secs(30))
                    .with_ttl_check_interval(Duration::from_secs(15))
                    .with_abs_conn_ttl(Some(Duration::from_secs(4 * 3600))),
            ),
    );
    let mut observer = verified(Conn::new(opts.clone()).await, "临时观察连接建立失败");
    let server: Option<(u16, String, u8)> = verified(
        observer
            .query_first("SELECT @@port, @@datadir, @@performance_schema")
            .await,
        "临时实例身份验证失败",
    );
    let (actual_port, actual_datadir, performance_schema) = server.expect("实例身份未返回");
    assert_eq!(actual_port, port as u16);
    assert_eq!(PathBuf::from(actual_datadir), fixture.join("data"));
    assert_eq!(performance_schema, 1);

    let registry = MysqlQueryRegistry::default();
    // 普通成功查询使用单独的新池，避免让冷池取消样本提前获得热连接。
    let ordinary_pool = Pool::new(opts.clone());
    let ordinary_sql = format!("SELECT 1 AS fixture_probe, '{run_id}-ordinary' AS marker");
    if new_path {
        let guard = verified(registry.register("bench", "ordinary"), "普通查询登记失败");
        assert!(execute_mysql_sql(
            ordinary_pool.clone(),
            Some(guard),
            None,
            ordinary_sql.clone(),
            false
        )
        .await
        .is_ok());
    } else {
        let mut conn = verified(ordinary_pool.get_conn().await, "旧路径普通连接获取失败");
        let _: Option<u64> = verified(
            conn.query_first("SELECT CONNECTION_ID()").await,
            "旧路径普通登记失败",
        );
        verified(
            conn.query_drop(ordinary_sql.clone()).await,
            "旧路径普通查询失败",
        );
        drop(conn);
    }
    verified(ordinary_pool.disconnect().await, "普通查询池关闭失败");

    let pool = Pool::new(opts);
    if thermal == "warm" {
        // 每次测试进程中同时借出五条真实连接，再全部归还并等回收完成。
        warm_five_connections(&pool).await;
    }
    let target_sql = format!("SELECT SLEEP(30) + 1 AS delay_value, '{run_id}-target' AS marker");
    let target_pool = pool.clone();
    let target_statement = target_sql.clone();
    let target_guard =
        new_path.then(|| verified(registry.register("bench", "target"), "目标查询登记失败"));
    let target = tokio::spawn(async move {
        let failed = if new_path {
            execute_mysql_sql(target_pool, target_guard, None, target_statement, false)
                .await
                .is_err()
        } else {
            let mut conn = verified(target_pool.get_conn().await, "旧路径目标连接获取失败");
            let _: Option<u64> = verified(
                conn.query_first("SELECT CONNECTION_ID()").await,
                "旧路径目标登记失败",
            );
            let result = conn.query_drop(target_statement).await;
            let failed = result.is_err();
            if failed {
                verified(conn.disconnect().await, "旧路径目标连接关闭失败");
            }
            failed
        };
        (Instant::now(), failed)
    });
    // 固定五个显式并发任务；不通过遍历构造查询任务。
    let first = blocker(
        pool.clone(),
        format!("SELECT SLEEP(1.5), '{run_id}-blocker-1'"),
    );
    let second = blocker(
        pool.clone(),
        format!("SELECT SLEEP(1.5), '{run_id}-blocker-2'"),
    );
    let third = blocker(
        pool.clone(),
        format!("SELECT SLEEP(1.5), '{run_id}-blocker-3'"),
    );
    let fourth = blocker(
        pool.clone(),
        format!("SELECT SLEEP(1.5), '{run_id}-blocker-4'"),
    );
    pool_gauge(&pool, 5, 0).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    // 只执行一次集合快照，确证五条 SQL 均在服务端执行；不靠轮询凑满。
    let running: Vec<(u64, u64, u64, u8)> = verified(
        observer.exec(
            "SELECT threads.PROCESSLIST_ID, threads.THREAD_ID, current_statement.EVENT_ID, threads.PROCESSLIST_INFO = :target_sql FROM performance_schema.threads AS threads JOIN performance_schema.events_statements_current AS current_statement ON current_statement.THREAD_ID = threads.THREAD_ID WHERE threads.PROCESSLIST_INFO LIKE 'SELECT SLEEP(%' AND threads.PROCESSLIST_INFO LIKE :marker",
            params! { "target_sql" => &target_sql, "marker" => format!("%{run_id}%") },
        ).await,
        "占池查询集合快照失败",
    );
    assert_eq!(running.len(), 5, "必须由服务端确认五条慢查询全部在执行");
    let (target_id, target_thread, target_event, _) = running
        .into_iter()
        .find(|row| row.3 == 1)
        .expect("没有找到目标查询");
    let kill_sql = format!("KILL QUERY {target_id}");
    let cancel_start = Instant::now();
    let cancel = async {
        if new_path {
            assert!(verified(
                registry.cancel("bench", "target").await,
                "新路径取消失败"
            ));
        } else {
            let mut killer = verified(pool.get_conn().await, "旧路径取消借连接失败");
            verified(
                killer.query_drop(kill_sql.clone()).await,
                "旧路径取消发送失败",
            );
        }
        cancel_start.elapsed()
    };
    let capacity = async {
        let lease = verified(pool.get_conn().await, "第六次借连接失败");
        let restored = cancel_start.elapsed();
        let connection_id = u64::from(lease.id());
        drop(lease);
        (restored, connection_id)
    };
    let (cancel_elapsed, (capacity_elapsed, reused_id), target_result) =
        tokio::join!(cancel, capacity, target);
    let (target_returned, target_failed) = verified(target_result, "目标任务失败");
    assert!(target_returned >= cancel_start);
    if new_path {
        assert!(target_failed, "生产取消路径应返回取消状态");
        assert_ne!(reused_id, target_id, "已取消的目标连接不能重入业务池");
    }
    let (first, second, third, fourth) = tokio::join!(first, second, third, fourth);
    verified(first, "占池任务 1 失败");
    verified(second, "占池任务 2 失败");
    verified(third, "占池任务 3 失败");
    verified(fourth, "占池任务 4 失败");

    // 所有性能证据一次性集合读取；查询内部匹配合成 SQL，输出只保留数量和时间。
    let measured: Option<(u64, u64, u64, u64, u64, u64)> = verified(
        observer.exec_first(
            "SELECT target.TIMER_WAIT, target.TIMER_END, killer.TIMER_START, target.MYSQL_ERRNO, \
             (SELECT COUNT(*) FROM performance_schema.events_statements_history_long AS prior \
              JOIN performance_schema.events_statements_history_long AS ordinary ON prior.THREAD_ID = ordinary.THREAD_ID \
              WHERE ordinary.SQL_TEXT = :ordinary_sql AND prior.EVENT_ID < ordinary.EVENT_ID \
              AND prior.SQL_TEXT = 'SELECT CONNECTION_ID()'), \
             (SELECT COUNT(*) FROM performance_schema.events_statements_history_long AS prior \
              JOIN performance_schema.events_statements_history_long AS ordinary ON prior.THREAD_ID = ordinary.THREAD_ID \
              WHERE ordinary.SQL_TEXT = :ordinary_sql AND prior.EVENT_ID < ordinary.EVENT_ID \
              AND prior.EVENT_NAME LIKE 'statement/sql/%') \
             FROM performance_schema.events_statements_history_long AS target \
             JOIN performance_schema.events_statements_history_long AS killer ON killer.SQL_TEXT = :kill_sql \
             WHERE target.THREAD_ID = :target_thread AND target.EVENT_ID = :target_event LIMIT 1",
            params! { "ordinary_sql" => ordinary_sql, "kill_sql" => kill_sql, "target_thread" => target_thread, "target_event" => target_event },
        ).await,
        "服务端计时集合读取失败",
    );
    let (server_total, target_end, kill_start, server_error, registration_sql, ordinary_before_sql) =
        measured.expect("服务端未保存完整语句计时");
    assert!(
        target_end >= kill_start,
        "服务端目标语句必须在取消开始后结束"
    );
    assert_eq!(registration_sql, if new_path { 0 } else { 1 });
    assert!(server_total < 5_000_000_000_000, "目标慢查询没有及时终止");
    verified(pool.disconnect().await, "测量池关闭失败");
    verified(observer.disconnect().await, "观察连接关闭失败");
    println!(
        "MYSQL_CANCEL_BENCH {}",
        serde_json::json!({
            "variant": variant,
            "thermal": thermal,
            "run_id": run_id,
            "pool_max": 5,
            "running_queries": 5,
            "prewarmed_connections": if thermal == "warm" { 5 } else { 0 },
            "cancel_ms": cancel_elapsed.as_secs_f64() * 1000.0,
            "capacity_ms": capacity_elapsed.as_secs_f64() * 1000.0,
            "execution_return_ms": target_returned.duration_since(cancel_start).as_secs_f64() * 1000.0,
            "server_target_total_ms": server_total as f64 / 1_000_000_000.0,
            "server_after_kill_ms": (target_end - kill_start) as f64 / 1_000_000_000.0,
            "server_error_code": server_error,
            "normal_registration_sql_count": registration_sql,
            "normal_sql_before_count": ordinary_before_sql,
        })
    );
}
