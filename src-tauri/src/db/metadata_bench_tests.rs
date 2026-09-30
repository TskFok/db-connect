//! 仅供显式启动的临时 MySQL 夹具；不读取应用连接配置。
use crate::commands::database::{list_mysql_tables_batch, mysql_catalog_query};
use mysql_async::prelude::*;
use mysql_async::{Conn, Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts};
use std::path::PathBuf;
use std::time::Instant;

fn checked<T, E>(result: Result<T, E>, stage: &str) -> T {
    result.unwrap_or_else(|_| panic!("隔离元数据基准失败：{stage}"))
}

async fn fixture() -> (Pool, Conn, u32) {
    let path = checked(std::env::var("DB_CONNECT_METADATA_FIXTURE"), "缺少夹具路径");
    let path = checked(PathBuf::from(path).canonicalize(), "夹具路径不存在");
    assert!(path
        .to_string_lossy()
        .starts_with("/private/tmp/db-connect-metadata-"));
    let config: serde_json::Value = checked(
        serde_json::from_slice(&checked(
            std::fs::read(path.join("fixture.json")),
            "缺少夹具描述",
        )),
        "夹具描述无效",
    );
    let port = config["port"].as_u64().expect("端口必须是整数");
    assert!(port > 1024 && port <= u16::MAX as u64 && port != 3306);
    let opts = Opts::from(
        OptsBuilder::default()
            .ip_or_hostname("127.0.0.1")
            .tcp_port(port as u16)
            .user(Some("root"))
            .prefer_socket(false)
            .pool_opts(PoolOpts::default().with_constraints(PoolConstraints::new(1, 1).unwrap())),
    );
    let mut observer = checked(Conn::new(opts.clone()).await, "建立观察连接");
    let (actual_port, datadir): (u16, String) = checked(
        observer.query_first("SELECT @@port, @@datadir").await,
        "校验实例",
    )
    .expect("实例信息缺失");
    assert_eq!(port as u16, actual_port);
    assert_eq!(PathBuf::from(datadir), path.join("data"));
    let pool = Pool::new(opts);
    let conn = checked(pool.get_conn().await, "借出测量连接");
    let id = conn.id();
    drop(conn);
    (pool, observer, id)
}

async fn selects(observer: &mut Conn, id: u32) -> u64 {
    checked(observer.exec_first(
        "SELECT COALESCE(SUM(s.COUNT_STAR),0) FROM performance_schema.events_statements_summary_by_thread_by_event_name s JOIN performance_schema.threads t ON s.THREAD_ID=t.THREAD_ID WHERE t.PROCESSLIST_ID=? AND s.EVENT_NAME IN ('statement/sql/select','statement/sql/show_table_status','statement/sql/show_keys','statement/com/Execute')", (id,)
    ).await, "读取目录语句计数").unwrap_or(0)
}

#[tokio::test]
#[ignore = "仅限 scripts/performance/metadata-access-benchmark.py 创建的独立 MySQL 夹具"]
async fn metadata_access_isolated_sample() {
    let (pool, mut observer, id) = fixture().await;
    let count: usize = std::env::var("DB_CONNECT_METADATA_DATABASES")
        .unwrap_or_else(|_| "1".into())
        .parse()
        .unwrap();
    assert!(matches!(count, 1 | 10 | 100));
    let databases: Vec<String> = (0..count).map(|i| format!("metadata_{i:03}")).collect();
    let variant = std::env::var("DB_CONNECT_METADATA_VARIANT").unwrap_or_else(|_| "batch".into());
    assert!(matches!(variant.as_str(), "batch" | "legacy-single"));
    let before = selects(&mut observer, id).await;
    let started = Instant::now();
    if variant == "legacy-single" {
        assert_eq!(count, 1);
        let mut conn = checked(pool.get_conn().await, "旧单库借出");
        let result: Vec<mysql_async::Row> = checked(
            conn.query("SHOW TABLE STATUS FROM metadata_000").await,
            "旧单库目录",
        );
        // 重现原单库字段映射，计时包含同样的 TableInfo 构造。
        let tables: Vec<crate::models::types::TableInfo> = result
            .iter()
            .map(|row| {
                let engine: Option<String> = row.get("Engine").flatten();
                crate::models::types::TableInfo {
                    name: row
                        .get::<Option<String>, _>("Name")
                        .flatten()
                        .unwrap_or_default(),
                    table_type: if engine.is_some() { "TABLE" } else { "VIEW" }.into(),
                    engine,
                    rows: row.get::<Option<u64>, _>("Rows").flatten(),
                    data_length: row.get::<Option<u64>, _>("Data_length").flatten(),
                    index_length: row.get::<Option<u64>, _>("Index_length").flatten(),
                    comment: row
                        .get::<Option<String>, _>("Comment")
                        .flatten()
                        .unwrap_or_default(),
                }
            })
            .collect();
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(tables.len(), 2);
        let after = selects(&mut observer, id).await;
        assert_eq!(after - before, 1);
        println!(
            "METADATA_BENCH {}",
            serde_json::json!({"variant":variant,"databases":1,"catalog_sql_count":after-before,"elapsed_ms":elapsed_ms})
        );
        drop(conn);
        drop(observer);
        checked(pool.disconnect().await, "关闭旧路径池");
        return;
    }
    let result = checked(
        list_mysql_tables_batch(&pool, &databases).await,
        "批量目录查询",
    );
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
    let after = selects(&mut observer, id).await;
    assert_eq!(result.len(), count);
    assert_eq!(
        result.iter().map(|g| g.tables.len()).sum::<usize>(),
        count + 1
    );
    assert_eq!(after - before, 1, "单批目录必须只有一条集合 SELECT");
    println!(
        "METADATA_BENCH {}",
        serde_json::json!({"variant":variant,"databases":count,"catalog_sql_count":after-before,"elapsed_ms":elapsed_ms})
    );
    drop(observer);
    checked(pool.disconnect().await, "关闭测量池");
}

#[tokio::test]
#[ignore = "仅限本轮独立 MySQL 夹具，验证 SHOW 基线和集合查询权限语义"]
async fn metadata_access_isolated_permissions() {
    let (pool, mut observer, _) = fixture().await;
    let (sql, params) = mysql_catalog_query(&["metadata_000".into()]);
    let explain: Vec<mysql_async::Row> = checked(
        observer.exec(format!("EXPLAIN {sql}"), params).await,
        "生产集合SQL扫描范围",
    );
    let extras: Vec<String> = explain
        .iter()
        .filter_map(|row| row.get::<Option<String>, _>("Extra").flatten())
        .collect();
    assert!(
        extras
            .iter()
            .any(|extra| extra.contains("Scanned 1 database")),
        "MySQL5.7目录必须限定请求库"
    );
    assert!(
        !extras
            .iter()
            .any(|extra| extra.contains("Scanned all databases")),
        "禁止扫描未请求库"
    );
    let databases = vec![
        "metadata_000".into(),
        "metadata_empty".into(),
        "metadata'quote`\"]|fixture".into(),
    ];
    let batch = checked(list_mysql_tables_batch(&pool, &databases).await, "目录语义");
    let old: Vec<mysql_async::Row> = checked(
        observer.query("SHOW TABLE STATUS FROM metadata_000").await,
        "SHOW 基线",
    );
    assert_eq!(batch[0].tables.len(), old.len());
    for (table, old) in batch[0].tables.iter().zip(old.iter()) {
        assert_eq!(table.name, old.get::<String, _>("Name").unwrap());
        assert_eq!(
            table.engine,
            old.get::<Option<String>, _>("Engine").flatten()
        );
        assert_eq!(table.rows, old.get::<Option<u64>, _>("Rows").flatten());
        assert_eq!(
            table.data_length,
            old.get::<Option<u64>, _>("Data_length").flatten()
        );
        assert_eq!(
            table.index_length,
            old.get::<Option<u64>, _>("Index_length").flatten()
        );
        assert_eq!(table.comment, old.get::<String, _>("Comment").unwrap());
    }
    assert!(batch[1].tables.is_empty());
    assert_eq!(batch[2].tables[0].name, "items");
    assert!(list_mysql_tables_batch(&pool, &["metadata_missing".into()])
        .await
        .is_err());
    let opts =
        Opts::from(OptsBuilder::from_opts(observer.opts().clone()).user(Some("metadata_limited")));
    let limited = Pool::new(opts);
    let visible = checked(
        list_mysql_tables_batch(&limited, &["metadata_000".into()]).await,
        "受限可见表",
    );
    assert_eq!(visible[0].tables.len(), 1);
    assert!(
        list_mysql_tables_batch(&limited, &["metadata_000".into(), "metadata_001".into()])
            .await
            .is_err()
    );
    let show = Pool::new(Opts::from(
        OptsBuilder::from_opts(observer.opts().clone()).user(Some("metadata_show_only")),
    ));
    let empty = checked(
        list_mysql_tables_batch(&show, &["metadata_000".into()]).await,
        "仅库可见权限",
    );
    assert!(empty[0].tables.is_empty());
    checked(limited.disconnect().await, "关闭受限池");
    checked(show.disconnect().await, "关闭库可见池");
    checked(pool.disconnect().await, "关闭池");
    println!("METADATA_PERMISSIONS verified");
}

#[tokio::test]
#[ignore = "独立 MySQL 夹具；元数据缓存冷读和无导航热读"]
async fn metadata_access_isolated_pagination() {
    use crate::commands::data::fetch_table_page_metadata;
    use crate::db::table_pagination::{
        invalidate_table_metadata, load_table_metadata, Engine, PageContext,
    };
    let (pool, mut observer, id) = fixture().await;
    let context = PageContext {
        engine: Engine::MySql,
        connection: uuid::Uuid::new_v4().to_string(),
        database: "metadata_000".into(),
        table: "items".into(),
        filter: String::new(),
        sort: vec![],
        page_size: 50,
    };
    let mut conn = checked(pool.get_conn().await, "借出分页连接");
    let before = selects(&mut observer, id).await;
    let cold_start = Instant::now();
    let cold = checked(
        load_table_metadata(&context, &mut conn, |conn, ctx| {
            Box::pin(fetch_table_page_metadata(conn, &ctx.database, &ctx.table))
        })
        .await,
        "冷读元数据",
    );
    let cold_ms = cold_start.elapsed().as_secs_f64() * 1000.0;
    let middle = selects(&mut observer, id).await;
    let warm_start = Instant::now();
    let warm = checked(
        load_table_metadata(&context, &mut conn, |conn, ctx| {
            Box::pin(fetch_table_page_metadata(conn, &ctx.database, &ctx.table))
        })
        .await,
        "无导航热读元数据",
    );
    let warm_ms = warm_start.elapsed().as_secs_f64() * 1000.0;
    let after = selects(&mut observer, id).await;
    assert_eq!(cold.primary_keys, warm.primary_keys);
    assert_eq!(middle - before, 2);
    assert_eq!(after - middle, 0);
    invalidate_table_metadata(&context.connection, None, None);
    println!(
        "METADATA_PAGINATION {}",
        serde_json::json!({"cold_ms":cold_ms,"warm_ms":warm_ms,"cold_sql_count":middle-before,"warm_sql_count":after-middle})
    );
    drop(conn);
    drop(observer);
    checked(pool.disconnect().await, "关闭分页池");
}
