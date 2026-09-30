//! 仅在显式创建的 PostgreSQL 17 隔离容器运行；不读取应用连接配置。
use crate::db::postgres::{list_tables, list_tables_batch};
use crate::models::types::TableInfo;
use deadpool_postgres::{Config, Pool, PoolConfig, Runtime};
use serde_json::Value;
use std::path::PathBuf;
use tokio_postgres::{Client, NoTls};

const SPECIAL_SCHEMA: &str = "metadata'quote\"|]";

fn checked<T, E>(result: Result<T, E>, stage: &str) -> T {
    result.unwrap_or_else(|_| panic!("PostgreSQL 隔离验收失败：{stage}"))
}

fn pool(config: &Value, limited: bool) -> Pool {
    let mut pg = Config::new();
    pg.host = Some("127.0.0.1".into());
    let port = config["port"].as_u64().expect("端口必须是整数");
    assert!(port > 1024 && port <= u16::MAX as u64 && port != 5432);
    pg.port = Some(port as u16);
    pg.dbname = Some("metadata_fixture".into());
    pg.user = Some(
        if limited {
            "metadata_reader"
        } else {
            "metadata_owner"
        }
        .into(),
    );
    pg.password = Some(
        config[if limited {
            "limited_password"
        } else {
            "password"
        }]
        .as_str()
        .expect("缺少临时密码")
        .into(),
    );
    pg.pool = Some(PoolConfig::new(1));
    checked(
        pg.create_pool(Some(Runtime::Tokio1), NoTls),
        "建立专用连接池",
    )
}

async fn fixture() -> (Value, Pool) {
    let path = checked(
        std::env::var("DB_CONNECT_METADATA_PG_FIXTURE"),
        "缺少夹具路径",
    );
    let path = checked(PathBuf::from(path).canonicalize(), "夹具路径不存在");
    assert!(path
        .to_string_lossy()
        .starts_with("/private/tmp/db-connect-metadata-pg-"));
    let config: Value = checked(
        serde_json::from_slice(&checked(
            std::fs::read(path.join("fixture.json")),
            "缺少夹具描述",
        )),
        "夹具描述无效",
    );
    let marker = config["marker"].as_str().expect("缺少实例标记");
    assert!(marker.starts_with("db-connect-metadata-pg-"));
    assert!(marker.len() == "db-connect-metadata-pg-".len() + 32);
    assert!(marker["db-connect-metadata-pg-".len()..]
        .bytes()
        .all(|b| b.is_ascii_hexdigit()));
    let owner = pool(&config, false);
    let client = checked(owner.get().await, "借出校验连接");
    let identity = checked(
        client.query_one(
            "SELECT current_setting('cluster_name'), current_database(), current_setting('server_version_num')::int",
            &[],
        ).await,
        "校验隔离实例身份",
    );
    assert_eq!(identity.get::<_, String>(0), marker);
    assert_eq!(identity.get::<_, String>(1), "metadata_fixture");
    assert!((170000..180000).contains(&identity.get::<_, i32>(2)));
    drop(client);
    (config, owner)
}

async fn catalog_calls(observer: &Client, user: &str) -> i64 {
    let pattern = "%FROM pg_catalog.pg_class c%JOIN pg_catalog.pg_namespace%";
    checked(
        observer.query_one(
            "SELECT COALESCE(SUM(calls), 0)::bigint FROM pg_stat_statements WHERE userid = (SELECT oid FROM pg_roles WHERE rolname = $1) AND query LIKE $2",
            &[&user, &pattern],
        ).await,
        "读取实际目录执行次数",
    ).get(0)
}

// 保留执行前 HEAD 的单 schema 查询及映射，用于真实服务端对照权限与字段。
async fn legacy_tables(client: &Client, schema: &str) -> Vec<TableInfo> {
    let rows = checked(client.query(
        "SELECT c.relname AS name, \
         CASE WHEN c.relkind IN ('v', 'm') THEN 'VIEW' ELSE 'TABLE' END AS table_type, \
         CASE WHEN c.relkind IN ('r', 'p') THEN 'PostgreSQL' ELSE NULL END AS engine, \
         CASE WHEN c.relkind IN ('r', 'p') THEN GREATEST(c.reltuples::bigint, 0) ELSE NULL END AS rows_est, \
         CASE WHEN c.relkind IN ('r', 'p') THEN pg_catalog.pg_relation_size(c.oid)::bigint ELSE NULL END AS data_length, \
         CASE WHEN c.relkind IN ('r', 'p') THEN (pg_catalog.pg_total_relation_size(c.oid) - pg_catalog.pg_relation_size(c.oid))::bigint ELSE NULL END AS index_length, \
         COALESCE(pg_catalog.obj_description(c.oid, 'pg_class'), '') AS comment \
         FROM pg_catalog.pg_class c \
         JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm') ORDER BY c.relname",
        &[&schema],
    ).await, "执行原单 schema 对照查询");
    rows.iter()
        .map(|row| TableInfo {
            name: row.get("name"),
            table_type: row.get("table_type"),
            engine: row.get("engine"),
            rows: row
                .get::<_, Option<i64>>("rows_est")
                .and_then(|n| u64::try_from(n).ok()),
            data_length: row
                .get::<_, Option<i64>>("data_length")
                .and_then(|n| u64::try_from(n).ok()),
            index_length: row
                .get::<_, Option<i64>>("index_length")
                .and_then(|n| u64::try_from(n).ok()),
            comment: row.get("comment"),
        })
        .collect()
}

fn assert_tables(actual: &[TableInfo], expected: &[TableInfo]) {
    assert_eq!(
        checked(serde_json::to_value(actual), "序列化当前目录"),
        checked(serde_json::to_value(expected), "序列化原目录"),
    );
}

#[tokio::test]
#[ignore = "仅限 scripts/performance/metadata-postgres-validation.py 创建的 PostgreSQL 17 隔离容器"]
async fn metadata_access_isolated_postgres17() {
    let (config, owner) = fixture().await;
    // 观察者独占另一连接池；测量池只持有一条生产查询连接。
    let observer_pool = pool(&config, false);
    let observer = checked(observer_pool.get().await, "借出观察连接");
    let version: String = checked(
        observer.query_one("SHOW server_version", &[]).await,
        "读取版本",
    )
    .get(0);
    checked(
        observer
            .query_one("SELECT pg_stat_statements_reset()", &[])
            .await,
        "清零隔离实例统计",
    );
    let requested: Vec<String> = [
        "metadata_b",
        "metadata_a",
        "metadata_empty",
        SPECIAL_SCHEMA,
        "metadata_missing",
        "metadata_b",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    let before = catalog_calls(&observer, "metadata_owner").await;
    let groups = checked(
        list_tables_batch(&owner, &requested).await,
        "执行管理员集合目录",
    );
    let after = catalog_calls(&observer, "metadata_owner").await;
    assert_eq!(after - before, 1, "一次批量只执行一条目录集合 SQL");
    assert_eq!(
        groups
            .iter()
            .map(|group| group.database.as_str())
            .collect::<Vec<_>>(),
        [
            "metadata_b",
            "metadata_a",
            "metadata_empty",
            SPECIAL_SCHEMA,
            "metadata_missing"
        ]
    );
    assert!(groups[2].tables.is_empty());
    assert!(groups[4].tables.is_empty());
    assert_eq!(groups[0].tables[0].comment, "schema b");
    assert_eq!(groups[3].tables[0].comment, "special schema");
    assert_eq!(
        groups[1]
            .tables
            .iter()
            .map(|table| (table.name.as_str(), table.table_type.as_str()))
            .collect::<Vec<_>>(),
        [
            ("item_materialized", "VIEW"),
            ("item_view", "VIEW"),
            ("partitioned", "TABLE"),
            ("partitioned_0", "TABLE"),
            ("same", "TABLE")
        ]
    );
    let empty = checked(list_tables_batch(&owner, &[]).await, "空输入");
    assert!(empty.is_empty());
    assert_eq!(
        catalog_calls(&observer, "metadata_owner").await,
        after,
        "空输入不能执行目录 SQL"
    );
    let oversized: Vec<String> = (0..257).map(|i| format!("unused_{i}")).collect();
    assert!(list_tables_batch(&owner, &oversized).await.is_err());
    assert_eq!(
        catalog_calls(&observer, "metadata_owner").await,
        after,
        "超限输入不能执行目录 SQL"
    );
    let owner_client = checked(owner.get().await, "借出原路径对照连接");
    let old_a = legacy_tables(&owner_client, "metadata_a").await;
    let old_b = legacy_tables(&owner_client, "metadata_b").await;
    let old_special = legacy_tables(&owner_client, SPECIAL_SCHEMA).await;
    let old_empty = legacy_tables(&owner_client, "metadata_empty").await;
    let old_missing = legacy_tables(&owner_client, "metadata_missing").await;
    assert_tables(&groups[0].tables, &old_b);
    assert_tables(&groups[1].tables, &old_a);
    assert_tables(&groups[2].tables, &old_empty);
    assert_tables(&groups[3].tables, &old_special);
    assert_tables(&groups[4].tables, &old_missing);
    drop(owner_client);
    assert_tables(
        &checked(
            list_tables(&owner, "metadata_a").await,
            "兼容单 schema 入口",
        ),
        &old_a,
    );

    let limited = pool(&config, true);
    let limited_client = checked(limited.get().await, "借出受限用户连接");
    // regclass 文本解析本身要求 schema USAGE；无权限对象应通过目录 OID 检查权限。
    let name_resolution = limited_client
        .query_one(
            "SELECT has_table_privilege(current_user, 'metadata_b.same', 'SELECT')",
            &[],
        )
        .await;
    let permission_error = name_resolution.expect_err("无 USAGE 时文本对象名解析应失败");
    assert_eq!(
        permission_error.code().map(|code| code.code()),
        Some("42501")
    );
    let privileges = checked(limited_client.query_one(
        "SELECT has_schema_privilege(current_user, 'metadata_a', 'USAGE'), has_table_privilege(current_user, 'metadata_a.same', 'SELECT'), has_schema_privilege(current_user, 'metadata_b', 'USAGE'), has_table_privilege(current_user, (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'metadata_b' AND c.relname = 'same'), 'SELECT')",
        &[],
    ).await, "确认真实权限差异");
    assert!(privileges.get::<_, bool>(0));
    assert!(privileges.get::<_, bool>(1));
    assert!(!privileges.get::<_, bool>(2));
    assert!(!privileges.get::<_, bool>(3));
    let denied = limited_client
        .query("SELECT * FROM metadata_b.same", &[])
        .await;
    assert!(denied.is_err(), "受限用户确实不能读取无权限表");
    let limited_old_a = legacy_tables(&limited_client, "metadata_a").await;
    let limited_old_b = legacy_tables(&limited_client, "metadata_b").await;
    let limited_old_special = legacy_tables(&limited_client, SPECIAL_SCHEMA).await;
    drop(limited_client);
    let before_limited = catalog_calls(&observer, "metadata_reader").await;
    let limited_groups = checked(
        list_tables_batch(&limited, &requested).await,
        "受限用户集合目录",
    );
    assert_eq!(
        catalog_calls(&observer, "metadata_reader").await - before_limited,
        1
    );
    assert_tables(&limited_groups[0].tables, &limited_old_b);
    assert_tables(&limited_groups[1].tables, &limited_old_a);
    assert_tables(&limited_groups[3].tables, &limited_old_special);
    assert!(limited_groups[2].tables.is_empty());
    assert!(limited_groups[4].tables.is_empty());
    println!(
        "METADATA_POSTGRES_VALIDATION {}",
        serde_json::json!({
            "server_version": version,
            "admin_catalog_sql_count": after - before,
            "limited_catalog_sql_count": 1,
            "requested_schemas": requested.len(),
            "unique_schemas": groups.len(),
            "legacy_fields_match": true,
            "empty_and_missing_schema": "empty groups, same as legacy",
            "limited_permissions": "schema a USAGE plus same SELECT only; schema b data denied, catalog visibility matches legacy",
            "passed": true
        })
    );
    limited.close();
    owner.close();
    observer_pool.close();
}
