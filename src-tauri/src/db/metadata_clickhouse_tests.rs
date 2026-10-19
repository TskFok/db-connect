//! 仅供独立 ClickHouse 容器的 T03 目录兼容及服务端执行计数验收。
use super::clickhouse::{fetch_json_each_rows, list_tables_batch};
use crate::models::types::TableInfo;
use clickhouse_rs::Client;
use serde_json::{json, Value};
use std::path::PathBuf;

const SPECIAL_DATABASE: &str = "metadata'quote`\"|]";

fn checked<T, E>(result: Result<T, E>, stage: &str) -> T {
    result.unwrap_or_else(|_| panic!("ClickHouse 隔离验收失败：{stage}"))
}

fn ensure(condition: bool, stage: &str) {
    assert!(condition, "ClickHouse 隔离验收失败：{stage}");
}

fn client(config: &Value, user: &str, password_key: &str) -> Client {
    let port = config["port"].as_u64().expect("缺少隔离端口");
    ensure(port > 1024 && port <= 65535 && port != 8123, "端口范围");
    Client::default()
        .with_url(format!("http://127.0.0.1:{port}"))
        .with_user(user)
        .with_password(config[password_key].as_str().expect("缺少临时密码"))
        .with_setting("log_queries", "1")
        .with_setting("log_queries_probability", "1")
}

fn tagged(client: &Client, marker: &str, label: &str) -> Client {
    client
        .clone()
        .with_setting("log_comment", format!("{marker}:{label}"))
}

fn number(value: &Value) -> Option<u64> {
    if value.is_null() {
        None
    } else if let Some(number) = value.as_u64() {
        Some(number)
    } else {
        Some(checked(
            value.as_str().expect("统计值类型").parse(),
            "统计值解析",
        ))
    }
}

// 独立保留 17e37adaa 的单目录 SQL 和字段映射，禁止调用已委托批量的新包装器。
async fn legacy_tables(client: &Client, database: &str) -> Vec<TableInfo> {
    let rows: Vec<Value> = checked(
        fetch_json_each_rows(
            client
                .query(
                    "SELECT name, CASE WHEN engine IN ('View', 'MaterializedView', 'LiveView') \
             THEN 'VIEW' ELSE 'TABLE' END AS table_type, engine, total_rows, total_bytes, comment \
             FROM system.tables WHERE database = ? ORDER BY name",
                )
                .bind(database),
            "独立旧单目录查询",
        )
        .await,
        "旧单目录读取",
    );
    rows.into_iter()
        .map(|row| {
            let engine = row["engine"].as_str().expect("旧引擎字段");
            TableInfo {
                name: row["name"].as_str().expect("旧名称字段").into(),
                table_type: if row["table_type"] == "VIEW" {
                    "VIEW"
                } else {
                    "TABLE"
                }
                .into(),
                engine: (!engine.is_empty()).then(|| engine.to_string()),
                rows: number(&row["total_rows"]),
                data_length: number(&row["total_bytes"]),
                index_length: None,
                comment: row["comment"].as_str().expect("旧注释字段").into(),
            }
        })
        .collect()
}

fn same_tables(actual: &[TableInfo], legacy: &[TableInfo]) {
    ensure(
        checked(serde_json::to_value(actual), "序列化当前字段")
            == checked(serde_json::to_value(legacy), "序列化旧字段"),
        "字段、顺序或 NULL 语义不一致",
    );
}

#[tokio::test]
#[ignore = "仅限 metadata-clickhouse-validation.py 创建的专属容器；真实权限及 query_log 计数"]
async fn metadata_batch_isolated_clickhouse_catalog() {
    let path = checked(
        std::env::var("DB_CONNECT_METADATA_CH_FIXTURE"),
        "缺少夹具路径",
    );
    let path = checked(PathBuf::from(path).canonicalize(), "夹具路径不存在");
    ensure(
        path.to_string_lossy()
            .starts_with("/private/tmp/db-connect-metadata-ch-"),
        "夹具路径范围",
    );
    let config: Value = checked(
        serde_json::from_slice(&checked(
            std::fs::read(path.join("fixture.json")),
            "缺少夹具描述",
        )),
        "夹具描述无效",
    );
    let marker = config["marker"].as_str().expect("缺少实例标记");
    let prefix = "db-connect-metadata-ch-";
    ensure(
        marker.starts_with(prefix)
            && marker.len() == prefix.len() + 32
            && marker[prefix.len()..]
                .bytes()
                .all(|b| b.is_ascii_hexdigit()),
        "实例标记格式",
    );
    let owner = client(&config, "metadata_owner", "password");
    let identity: Vec<Value> = checked(fetch_json_each_rows(owner.query(
        "SELECT hostName() AS hostname, version() AS version, token FROM metadata_fixture.marker"), "验证隔离身份").await, "隔离身份读取");
    ensure(
        identity.len() == 1 && identity[0]["hostname"] == marker && identity[0]["token"] == marker,
        "实例身份不符",
    );
    let version = identity[0]["version"].as_str().expect("缺少版本");
    ensure(version.starts_with("25.8."), "要求固定 LTS 25.8 系列");

    let requested = vec![
        "metadata_b".into(),
        "metadata_empty".into(),
        "metadata_a".into(),
        SPECIAL_DATABASE.into(),
        "metadata_missing".into(),
        "metadata_a".into(),
    ];
    let owner_batch = checked(
        list_tables_batch(&tagged(&owner, marker, "owner_multi"), &requested).await,
        "普通账号批量",
    );
    ensure(
        owner_batch
            .iter()
            .map(|group| group.database.as_str())
            .collect::<Vec<_>>()
            == [
                "metadata_b",
                "metadata_empty",
                "metadata_a",
                SPECIAL_DATABASE,
                "metadata_missing",
            ],
        "去重保序",
    );
    let old_a = legacy_tables(&owner, "metadata_a").await;
    let old_b = legacy_tables(&owner, "metadata_b").await;
    let old_empty = legacy_tables(&owner, "metadata_empty").await;
    let old_special = legacy_tables(&owner, SPECIAL_DATABASE).await;
    let old_missing = legacy_tables(&owner, "metadata_missing").await;
    same_tables(&owner_batch[0].tables, &old_b);
    same_tables(&owner_batch[1].tables, &old_empty);
    same_tables(&owner_batch[2].tables, &old_a);
    same_tables(&owner_batch[3].tables, &old_special);
    same_tables(&owner_batch[4].tables, &old_missing);
    ensure(
        owner_batch[0].tables.len() == 1
            && owner_batch[0].tables[0].name == "same"
            && owner_batch[3].tables.len() == 1
            && owner_batch[3].tables[0].name == "same",
        "同名表隔离",
    );
    ensure(
        owner_batch[1].tables.is_empty() && owner_batch[4].tables.is_empty(),
        "空库与缺失库旧语义",
    );
    let view = owner_batch[2]
        .tables
        .iter()
        .find(|table| table.name == "item_view")
        .expect("缺少视图");
    ensure(
        view.table_type == "VIEW"
            && view.engine.as_deref() == Some("View")
            && view.rows.is_none()
            && view.data_length.is_none(),
        "视图及 NULL 统计",
    );
    ensure(
        owner_batch[2]
            .tables
            .iter()
            .any(|table| table.name == "q'quote`\"|]"),
        "特殊表名",
    );

    let one = checked(
        list_tables_batch(&tagged(&owner, marker, "owner_one"), &["metadata_a".into()]).await,
        "单目录批量",
    );
    same_tables(&one[0].tables, &old_a);
    let maximum = (0..256)
        .map(|index| format!("metadata_absent_{index}"))
        .collect::<Vec<_>>();
    let maximum_groups = checked(
        list_tables_batch(&tagged(&owner, marker, "owner_256"), &maximum).await,
        "256 目录集合",
    );
    ensure(
        maximum_groups.len() == 256 && maximum_groups.iter().all(|group| group.tables.is_empty()),
        "256 空组保留",
    );
    let empty = checked(
        list_tables_batch(&tagged(&owner, marker, "owner_empty"), &[]).await,
        "空请求",
    );
    ensure(empty.is_empty(), "空请求返回");
    let oversized = (0..257)
        .map(|index| format!("metadata_absent_{index}"))
        .collect::<Vec<_>>();
    ensure(
        list_tables_batch(&tagged(&owner, marker, "owner_257"), &oversized)
            .await
            .is_err(),
        "257 请求拒绝",
    );

    let reader = client(&config, "metadata_reader", "limited_password");
    let limited = checked(
        list_tables_batch(&tagged(&reader, marker, "reader_multi"), &requested).await,
        "单表 SELECT 账号批量",
    );
    let limited_old_a = legacy_tables(&reader, "metadata_a").await;
    let limited_old_b = legacy_tables(&reader, "metadata_b").await;
    let limited_old_empty = legacy_tables(&reader, "metadata_empty").await;
    let limited_old_special = legacy_tables(&reader, SPECIAL_DATABASE).await;
    let limited_old_missing = legacy_tables(&reader, "metadata_missing").await;
    same_tables(&limited[0].tables, &limited_old_b);
    same_tables(&limited[1].tables, &limited_old_empty);
    same_tables(&limited[2].tables, &limited_old_a);
    same_tables(&limited[3].tables, &limited_old_special);
    same_tables(&limited[4].tables, &limited_old_missing);
    ensure(
        limited[2].tables.len() == 1
            && limited[2].tables[0].name == "same"
            && limited[0].tables.is_empty(),
        "受限目录可见性",
    );
    let denied_data = fetch_json_each_rows::<Value>(
        reader.query("SELECT id FROM metadata_b.same"),
        "受限数据拒绝",
    )
    .await;
    ensure(denied_data.is_err(), "受限账号不得访问隐藏表数据");
    let no_access = client(&config, "metadata_none", "limited_password");
    let invisible = checked(
        list_tables_batch(&tagged(&no_access, marker, "none_multi"), &requested).await,
        "无对象授权目录",
    );
    let invisible_old = legacy_tables(&no_access, "metadata_a").await;
    same_tables(&invisible[2].tables, &invisible_old);
    ensure(
        invisible.iter().all(|group| group.tables.is_empty()),
        "无授权账号不泄露表目录",
    );
    let invalid = reader
        .clone()
        .with_password(uuid::Uuid::new_v4().to_string());
    ensure(
        list_tables_batch(&invalid, &requested).await.is_err(),
        "认证失败整批拒绝不得部分成功",
    );

    checked(
        owner.query("SYSTEM FLUSH LOGS").execute().await,
        "刷新自有实例日志",
    );
    let counters: Vec<Value> = checked(fetch_json_each_rows(owner.query(
        "SELECT log_comment AS label, count() AS calls, countIf(type != 'QueryFinish') AS failures \
         FROM system.query_log WHERE startsWith(log_comment, ?) AND is_initial_query = 1 \
         AND type IN ('QueryFinish', 'ExceptionBeforeStart', 'ExceptionWhileProcessing') \
         GROUP BY log_comment ORDER BY log_comment").bind(format!("{marker}:")), "服务端执行计数").await, "计数读取");
    let count = |label: &str| {
        counters
            .iter()
            .find(|row| row["label"] == format!("{marker}:{label}"))
            .map(|row| number(&row["calls"]).unwrap())
            .unwrap_or(0)
    };
    ensure(
        count("owner_multi") == 1
            && count("owner_one") == 1
            && count("owner_256") == 1
            && count("reader_multi") == 1
            && count("none_multi") == 1,
        "有效目录批次必须恰好一次服务端执行",
    );
    ensure(
        count("owner_empty") == 0 && count("owner_257") == 0,
        "空输入和超限必须零查询",
    );
    ensure(
        counters
            .iter()
            .all(|row| number(&row["failures"]) == Some(0)),
        "被测目录批次不得有隐藏错误",
    );
    let safe_counters = counters
        .iter()
        .map(|row| {
            json!({
                "case": row["label"].as_str().unwrap().strip_prefix(&format!("{marker}:")).unwrap(),
                "calls": number(&row["calls"]), "failures": number(&row["failures"]),
            })
        })
        .collect::<Vec<_>>();
    println!(
        "METADATA_CLICKHOUSE_VALIDATION {}",
        json!({
            "passed": true, "server_version": version, "requested_databases": 6, "unique_databases": 5,
            "legacy_fields_and_order_match": true, "table_view_and_null_statistics": true,
            "empty_missing_invisible": "empty groups, same as independent legacy query",
            "permission_matrix": {"owner": "all requested visible objects", "single_table_select": "only granted table visible; hidden data denied", "no_object_grants": "all requested groups empty", "invalid_password": "whole batch error, no partial success"},
            "counter_source": "system.query_log terminal initial-query events, isolated log_comment per case; SYSTEM FLUSH LOGS before one observation query",
            "server_counters": safe_counters, "empty_request_sql": count("owner_empty"), "oversized_257_sql": count("owner_257"),
            "sql_calls_in_iteration": false, "latency_benchmark": false,
            "limitations": ["ClickHouse 25.8 LTS Linux arm64 only", "No Tauri IPC, network p95, TLS, SSH, distributed cluster or broad version matrix", "Metadata invisibility is successful filtering under legacy ClickHouse semantics, not an ACL error"],
        })
    );
}
