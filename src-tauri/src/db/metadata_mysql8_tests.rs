//! 显式运行的 MySQL 8.4 Linux 隔离验收，不读取应用连接配置。
use crate::commands::database::list_mysql_tables_batch;
use crate::models::types::TableInfo;
use mysql_async::prelude::*;
use mysql_async::{Conn, Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, Row};
use std::path::PathBuf;

fn checked<T, E>(result: Result<T, E>, stage: &str) -> T {
    result.unwrap_or_else(|_| panic!("MySQL 8.4 隔离验收失败：{stage}"))
}

async fn fixture() -> (Pool, Conn, u32, String) {
    let path = checked(
        std::env::var("DB_CONNECT_METADATA_MYSQL8_FIXTURE"),
        "缺少夹具路径",
    );
    let path = checked(PathBuf::from(path).canonicalize(), "夹具路径不存在");
    let config: serde_json::Value = checked(
        serde_json::from_slice(&checked(
            std::fs::read(path.join("fixture.json")),
            "缺少夹具描述",
        )),
        "夹具描述无效",
    );
    let marker = config["marker"].as_str().expect("缺少隔离标记");
    assert_eq!(marker.len(), 32);
    assert!(marker.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(
        path,
        PathBuf::from(format!("/private/tmp/db-connect-metadata-mysql8-{marker}"))
    );
    assert_eq!(
        config["container"],
        format!("db-connect-metadata-mysql8-{marker}")
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
    let mut observer = checked(Conn::new(opts.clone()).await, "建立隔离观察连接");
    let actual: (String, String, u8, u16, String) = checked(
        observer.query_first("SELECT @@version, @@server_uuid, @@lower_case_table_names, @@port, token FROM metadata8_fixture.marker WHERE id=1").await,
        "核验服务与夹具标记",
    ).expect("服务信息缺失");
    assert!(actual.0.starts_with("8.4."));
    assert_eq!(actual.0, config["version"]);
    assert_eq!(actual.1, config["server_uuid"]);
    assert_eq!(actual.2, 0, "此夹具必须运行在名称大小写敏感模式");
    assert_eq!(
        actual.3, 3306,
        "容器端口必须固定为 3306，宿主使用描述中的随机端口"
    );
    assert_eq!(actual.4, marker);
    let pool = Pool::new(opts);
    let conn = checked(pool.get_conn().await, "初始化验收连接");
    let id = conn.id();
    drop(conn);
    (pool, observer, id, actual.0)
}

async fn catalog_count(observer: &mut Conn, id: u32) -> u64 {
    checked(observer.exec_first(
        "SELECT COALESCE(SUM(s.COUNT_STAR),0) FROM performance_schema.events_statements_summary_by_thread_by_event_name s JOIN performance_schema.threads t ON s.THREAD_ID=t.THREAD_ID WHERE t.PROCESSLIST_ID=? AND s.EVENT_NAME IN ('statement/sql/select','statement/sql/show_table_status','statement/sql/show_keys','statement/sql/show_grants','statement/com/Execute')", (id,)
    ).await, "读取目标连接目录语句计数").unwrap_or(0)
}

fn assert_same_tables(actual: &[TableInfo], legacy: &[Row]) {
    assert_eq!(actual.len(), legacy.len());
    // 仅遍历内存结果做映射对照，不在循环中查询 SQL。
    for (table, old) in actual.iter().zip(legacy.iter()) {
        let engine: Option<String> = old.get::<Option<String>, _>("Engine").flatten();
        assert_eq!(table.name, old.get::<String, _>("Name").unwrap());
        assert_eq!(
            table.table_type,
            if engine.is_some() { "TABLE" } else { "VIEW" }
        );
        assert_eq!(table.engine, engine);
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
}

async fn assert_user_tables(
    root_opts: &Opts,
    observer: &mut Conn,
    user: &str,
    database: &str,
    names: &[&str],
) {
    let opts = Opts::from(OptsBuilder::from_opts(root_opts.clone()).user(Some(user)));
    let pool = Pool::new(opts.clone());
    let conn = checked(pool.get_conn().await, "初始化权限验收连接");
    let id = conn.id();
    drop(conn);
    let before = catalog_count(observer, id).await;
    let groups = checked(
        list_mysql_tables_batch(&pool, &[database.into()]).await,
        user,
    );
    assert_eq!(
        catalog_count(observer, id).await - before,
        if names.is_empty() { 2 } else { 1 }
    );
    let mut legacy = checked(Conn::new(opts).await, "建立授权 SHOW 基线连接");
    let old: Vec<Row> = checked(
        legacy
            .query(format!(
                "SHOW TABLE STATUS FROM {}",
                crate::db::sql_utils::esc_id(database)
            ))
            .await,
        user,
    );
    assert_same_tables(&groups[0].tables, &old);
    assert_eq!(
        groups[0]
            .tables
            .iter()
            .map(|table| table.name.as_str())
            .collect::<Vec<_>>(),
        names
    );
    checked(legacy.disconnect().await, "关闭授权基线连接");
    checked(pool.disconnect().await, "关闭授权验收池");
}

async fn assert_user_denied(root_opts: &Opts, observer: &mut Conn, user: &str, database: &str) {
    let opts = Opts::from(OptsBuilder::from_opts(root_opts.clone()).user(Some(user)));
    let pool = Pool::new(opts.clone());
    let conn = checked(pool.get_conn().await, "初始化拒绝验收连接");
    let id = conn.id();
    drop(conn);
    let mut legacy = checked(Conn::new(opts).await, "建立拒绝 SHOW 基线连接");
    let old: Result<Vec<Row>, _> = legacy
        .query(format!(
            "SHOW TABLE STATUS FROM {}",
            crate::db::sql_utils::esc_id(database)
        ))
        .await;
    assert!(
        matches!(old, Err(mysql_async::Error::Server(ref error)) if error.code == 1044),
        "{user}"
    );
    let before = catalog_count(observer, id).await;
    assert!(
        list_mysql_tables_batch(&pool, &[database.into()])
            .await
            .is_err(),
        "{user}"
    );
    let statements = catalog_count(observer, id).await - before;
    assert!((1..=2).contains(&statements));
    checked(legacy.disconnect().await, "关闭拒绝基线连接");
    checked(pool.disconnect().await, "关闭拒绝验收池");
}

#[tokio::test]
#[ignore = "仅限自有 Docker MySQL 8.4 Linux 隔离夹具；必须显式提供路径、随机本地端口和实例标记"]
async fn metadata_mysql8_isolated_catalog_acceptance() {
    let (pool, mut observer, id, version) = fixture().await;
    let before_empty = catalog_count(&mut observer, id).await;
    assert!(checked(list_mysql_tables_batch(&pool, &[]).await, "空请求").is_empty());
    assert_eq!(catalog_count(&mut observer, id).await - before_empty, 0);

    let requested = vec![
        "metadata8".into(),
        "metadata8_empty".into(),
        "metadata8'quote`\"]|fixture".into(),
        "Metadata8Case".into(),
        "metadata8case".into(),
    ];
    let before_batch = catalog_count(&mut observer, id).await;
    let batch = checked(
        list_mysql_tables_batch(&pool, &requested).await,
        "五库集合目录",
    );
    let batch_sql_count = catalog_count(&mut observer, id).await - before_batch;
    assert_eq!(
        batch_sql_count, 2,
        "包含空库的 MySQL 8 批次只能补读一次有效授权"
    );
    let before_nonempty = catalog_count(&mut observer, id).await;
    checked(
        list_mysql_tables_batch(
            &pool,
            &[
                "metadata8".into(),
                "Metadata8Case".into(),
                "metadata8case".into(),
            ],
        )
        .await,
        "非空库集合目录",
    );
    assert_eq!(catalog_count(&mut observer, id).await - before_nonempty, 1);
    assert_eq!(batch.len(), requested.len());
    assert_eq!(
        batch
            .iter()
            .map(|group| &group.database)
            .collect::<Vec<_>>(),
        requested.iter().collect::<Vec<_>>()
    );
    let old_main: Vec<Row> = checked(
        observer.query("SHOW TABLE STATUS FROM metadata8").await,
        "主库 SHOW 基线",
    );
    assert_same_tables(&batch[0].tables, &old_main);
    assert_eq!(
        batch[0]
            .tables
            .iter()
            .map(|table| table.name.as_str())
            .collect::<Vec<_>>(),
        vec!["A_items", "Z_items", "a_items", "q'quote`table", "v_items"]
    );
    assert!(batch[1].tables.is_empty());
    let old_special: Vec<Row> = checked(
        observer
            .query("SHOW TABLE STATUS FROM `metadata8'quote``\"]|fixture`")
            .await,
        "特殊库 SHOW 基线",
    );
    assert_same_tables(&batch[2].tables, &old_special);
    assert_eq!(batch[3].tables[0].name, "upper_items");
    assert_eq!(batch[4].tables[0].name, "lower_items");

    let wrong_case: Result<Vec<Row>, _> = observer.query("SHOW TABLE STATUS FROM METADATA8").await;
    assert!(matches!(wrong_case, Err(mysql_async::Error::Server(ref error)) if error.code == 1049));
    assert!(list_mysql_tables_batch(&pool, &["METADATA8".into()])
        .await
        .is_err());
    let missing: Result<Vec<Row>, _> = observer
        .query("SHOW TABLE STATUS FROM metadata8_missing")
        .await;
    assert!(matches!(missing, Err(mysql_async::Error::Server(ref error)) if error.code == 1049));
    assert!(
        list_mysql_tables_batch(&pool, &["metadata8".into(), "metadata8_missing".into()])
            .await
            .is_err()
    );

    let limited_opts =
        Opts::from(OptsBuilder::from_opts(observer.opts().clone()).user(Some("metadata8_limited")));
    let limited = Pool::new(limited_opts.clone());
    let mut limited_legacy = checked(Conn::new(limited_opts).await, "建立单表 SELECT 账号连接");
    let visible = checked(
        list_mysql_tables_batch(&limited, &["metadata8".into()]).await,
        "受限可见表",
    );
    let old_visible: Vec<Row> = checked(
        limited_legacy
            .query("SHOW TABLE STATUS FROM metadata8")
            .await,
        "受限 SHOW 基线",
    );
    assert_same_tables(&visible[0].tables, &old_visible);
    assert_eq!(visible[0].tables.len(), 1);
    assert_eq!(visible[0].tables[0].name, "a_items");
    let denied: Result<Vec<Row>, _> = limited_legacy
        .query("SHOW TABLE STATUS FROM metadata8_hidden")
        .await;
    assert!(matches!(denied, Err(mysql_async::Error::Server(ref error)) if error.code == 1044));
    assert!(
        list_mysql_tables_batch(&limited, &["metadata8".into(), "metadata8_hidden".into()])
            .await
            .is_err()
    );

    let show_opts = Opts::from(
        OptsBuilder::from_opts(observer.opts().clone()).user(Some("metadata8_show_only")),
    );
    let show = Pool::new(show_opts.clone());
    let mut show_legacy = checked(Conn::new(show_opts).await, "建立仅 SHOW DATABASES 账号连接");
    let old_denied: Result<Vec<Row>, _> =
        show_legacy.query("SHOW TABLE STATUS FROM metadata8").await;
    assert!(matches!(old_denied, Err(mysql_async::Error::Server(ref error)) if error.code == 1044));
    assert!(
        list_mysql_tables_batch(&show, &["metadata8".into(), "metadata8_empty".into()])
            .await
            .is_err(),
        "MySQL 8.4 仅 SHOW DATABASES 账号被原 SHOW 拒绝，集合查询也必须整批失败"
    );

    let root_opts = observer.opts().clone();
    assert_user_tables(
        &root_opts,
        &mut observer,
        "metadata8_create",
        "metadata8_empty",
        &[],
    )
    .await;
    assert_user_tables(
        &root_opts,
        &mut observer,
        "metadata8_role_user",
        "metadata8_role_empty",
        &[],
    )
    .await;
    assert_user_tables(
        &root_opts,
        &mut observer,
        "metadata8_column",
        "metadata8",
        &["a_items"],
    )
    .await;
    assert_user_tables(
        &root_opts,
        &mut observer,
        "metadata8_grant_only",
        "metadata8",
        &["a_items"],
    )
    .await;
    assert_user_tables(
        &root_opts,
        &mut observer,
        "metadata8_routine_user",
        "metadata8_routine",
        &[],
    )
    .await;
    assert_user_tables(
        &root_opts,
        &mut observer,
        "metadata8_wildcard",
        "metadata8_wild_one",
        &[],
    )
    .await;
    assert_user_denied(
        &root_opts,
        &mut observer,
        "metadata8_empty_role",
        "metadata8_empty",
    )
    .await;

    assert_user_denied(
        &root_opts,
        &mut observer,
        "metadata8_overlap",
        "metadata8probeexact",
    )
    .await;

    // 只修改本测试通过随机端口、server_uuid 和 marker 核验的自有夹具。
    checked(
        observer.query_drop("SET GLOBAL partial_revokes=ON").await,
        "启用隔离实例部分撤权",
    );
    checked(
        observer
            .query_drop("CREATE USER 'metadata8_partial_test'@'%'")
            .await,
        "建立部分撤权账号",
    );
    checked(
        observer
            .query_drop("GRANT SELECT, SHOW DATABASES ON *.* TO 'metadata8_partial_test'@'%'")
            .await,
        "建立合成全局授权",
    );
    checked(
        observer
            .query_drop("REVOKE SELECT ON metadata8_empty.* FROM 'metadata8_partial_test'@'%'")
            .await,
        "建立空库部分撤权",
    );
    assert_user_denied(
        &root_opts,
        &mut observer,
        "metadata8_partial_test",
        "metadata8_empty",
    )
    .await;
    // 部分撤权模式将已有库授权里的 % 和 _ 视为字面量。
    assert_user_denied(
        &root_opts,
        &mut observer,
        "metadata8_wildcard",
        "metadata8_wild_one",
    )
    .await;
    checked(
        observer
            .query_drop("DROP USER 'metadata8_partial_test'@'%'")
            .await,
        "关闭合成部分撤权账号",
    );
    checked(
        observer.query_drop("SET GLOBAL partial_revokes=OFF").await,
        "恢复隔离实例授权模式",
    );

    checked(limited_legacy.disconnect().await, "关闭受限基线连接");
    checked(show_legacy.disconnect().await, "关闭仅库可见基线连接");
    checked(limited.disconnect().await, "关闭受限池");
    checked(show.disconnect().await, "关闭仅库可见池");
    checked(pool.disconnect().await, "关闭验收池");
    checked(observer.disconnect().await, "关闭观察连接");
    println!("METADATA_MYSQL8_ACCEPTANCE version={version} lower_case_table_names=0 databases=5 catalog_sql_count={batch_sql_count} nonempty_batch_sql_count=1 empty_request_sql_count=0 verified");
}
