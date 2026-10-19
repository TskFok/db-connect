//! PostgreSQL 17 的生产表页入口验收；仅使用 runner 生成的合成隔离库。
//! 删除缓存命中分支、漏掉失效或放宽继承表主键信任均应使本测试失败。
use super::metadata_pg_tests::{checked, fixture, pool};
use super::postgres::{query_table_data, PostgresCancelTls, PostgresPoolHandle};
use super::table_pagination::{
    cached_metadata_for_navigation, cached_table_metadata, invalidate_table_metadata, Engine,
    PageContext,
};
use super::table_query::TableQueryCancellation;
use crate::models::types::{TablePageNavigation, TablePageResult};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tokio_postgres::Client;

fn context(table: &str) -> PageContext {
    PageContext {
        engine: Engine::Postgres,
        connection: uuid::Uuid::new_v4().to_string(),
        database: "metadata_pagination".into(),
        table: table.into(),
        filter: String::new(),
        sort: vec![],
        page_size: 2,
    }
}

// 同一条观察 SQL 一次返回三项，绑定 pattern，观察者自身不匹配被测语句。
async fn calls(observer: &Client) -> [i64; 3] {
    let metadata = "SELECT a.attname, ty.typname,%";
    let page = "SELECT % FROM \"metadata_pagination\".\"trusted\"%";
    let count = "SELECT COUNT(% FROM \"metadata_pagination\".\"trusted\"%";
    let row = checked(
        observer.query_one(
            "SELECT COALESCE(SUM(calls) FILTER (WHERE query LIKE $1), 0)::bigint, \
             COALESCE(SUM(calls) FILTER (WHERE query LIKE $2 AND query NOT LIKE $3), 0)::bigint, \
             COALESCE(SUM(calls) FILTER (WHERE query LIKE $3), 0)::bigint \
             FROM pg_stat_statements WHERE userid = (SELECT oid FROM pg_roles WHERE rolname = 'metadata_owner') \
             AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())",
            &[&metadata, &page, &count],
        ).await,
        "读取分页元数据/数据页/COUNT 服务端计数",
    );
    [row.get(0), row.get(1), row.get(2)]
}

async fn page(
    handle: &PostgresPoolHandle,
    context: &PageContext,
    number: u32,
    navigation: Option<TablePageNavigation>,
) -> (TablePageResult, f64) {
    let cancellation = TableQueryCancellation::default();
    let start = Instant::now();
    let result = checked(
        query_table_data(
            handle,
            &context.database,
            &context.table,
            number,
            context.page_size,
            String::new(),
            None,
            None,
            Some(true),
            context.clone(),
            navigation,
            &cancellation,
        )
        .await,
        "生产非游标表页请求",
    );
    let ms = start.elapsed().as_secs_f64() * 1000.0;
    (result, ms)
}

async fn warm_page(handle: &PostgresPoolHandle, context: &PageContext, number: u32) -> f64 {
    let (result, ms) = page(handle, context, number, None).await;
    assert_eq!(result.result.rows.len(), 2);
    assert_eq!(result.pagination.as_ref().unwrap().mode, "offset");
    ms
}

async fn sample(handle: &PostgresPoolHandle, observer: &Client) -> Value {
    let context = context("trusted");
    let started = Instant::now();
    let before = calls(observer).await;
    let (cold, cold_ms) = page(handle, &context, 1, None).await;
    assert_eq!(cold.result.rows.len(), 2);
    assert_eq!(cold.pagination.as_ref().unwrap().sort_column, "id");
    assert_eq!(
        cached_table_metadata(&context).unwrap().primary_keys,
        ["id"]
    );
    let after_cold = calls(observer).await;
    // 有意显式序列调用；禁止在循环、map 或递归内发 SQL。
    let warm_ms = [
        warm_page(handle, &context, 1).await,
        warm_page(handle, &context, 2).await,
        warm_page(handle, &context, 3).await,
        warm_page(handle, &context, 1).await,
        warm_page(handle, &context, 2).await,
        warm_page(handle, &context, 3).await,
        warm_page(handle, &context, 1).await,
        warm_page(handle, &context, 2).await,
        warm_page(handle, &context, 3).await,
        warm_page(handle, &context, 1).await,
        warm_page(handle, &context, 2).await,
        warm_page(handle, &context, 3).await,
        warm_page(handle, &context, 1).await,
        warm_page(handle, &context, 2).await,
        warm_page(handle, &context, 3).await,
        warm_page(handle, &context, 1).await,
        warm_page(handle, &context, 2).await,
        warm_page(handle, &context, 3).await,
        warm_page(handle, &context, 1).await,
        warm_page(handle, &context, 2).await,
    ];
    assert!(
        started.elapsed() < Duration::from_secs(300),
        "热请求必须位于 TTL 内"
    );
    assert!(cached_table_metadata(&context).is_some());
    let after_warm = calls(observer).await;
    invalidate_table_metadata(
        &context.connection,
        Some(&context.database),
        Some(&context.table),
    );
    assert!(cached_table_metadata(&context).is_none());
    let (_, invalidated_ms) = page(handle, &context, 1, None).await;
    let after_invalidated = calls(observer).await;
    let cold_delta = std::array::from_fn::<_, 3, _>(|i| after_cold[i] - before[i]);
    let warm_delta = std::array::from_fn::<_, 3, _>(|i| after_warm[i] - after_cold[i]);
    let invalidated_delta =
        std::array::from_fn::<_, 3, _>(|i| after_invalidated[i] - after_warm[i]);
    assert_eq!(cold_delta, [1, 1, 0], "冷读：1 元数据 + 1 数据页，无 COUNT");
    assert_eq!(
        warm_delta,
        [0, 20, 0],
        "20 次热读：0 元数据 + 20 数据页，无 COUNT"
    );
    assert_eq!(invalidated_delta, [1, 1, 0], "显式失效后重新读取元数据");
    invalidate_table_metadata(&context.connection, None, None);
    json!({
        "cold_ms": cold_ms, "warm_ms": warm_ms, "invalidated_ms": invalidated_ms,
        "cold_sql": cold_delta, "warm_sql": warm_delta, "invalidated_sql": invalidated_delta,
        "warm_metadata_cache_hits": 20, "warm_metadata_cache_requests": 20,
    })
}

async fn trust_and_cursor(handle: &PostgresPoolHandle) {
    let trusted = context("trusted");
    let (first, _) = page(handle, &trusted, 1, None).await;
    let old = TablePageNavigation {
        direction: "next".into(),
        cursor: first.pagination.unwrap().next_cursor.unwrap(),
    };
    let (next, _) = page(handle, &trusted, 2, Some(old.clone())).await;
    assert_eq!(next.pagination.unwrap().mode, "keyset");
    assert_eq!(next.result.rows[0][0], json!(3));
    invalidate_table_metadata(
        &trusted.connection,
        Some(&trusted.database),
        Some(&trusted.table),
    );
    assert!(cached_metadata_for_navigation(&trusted, 2, Some(&old)).is_none());
    let (fallback, _) = page(handle, &trusted, 2, Some(old)).await;
    assert_eq!(fallback.pagination.unwrap().mode, "offset");
    assert_eq!(fallback.result.rows[0][0], json!(3));
    let (large, _) = page(handle, &trusted, 3, None).await;
    assert_eq!(large.result.rows[0][0], json!("9007199254740993"));
    assert_eq!(large.result.rows[1][0], json!("9223372036854775807"));
    let (composite, _) = page(handle, &context("composite"), 1, None).await;
    assert!(composite.pagination.is_none());
    let (inherited, _) = page(handle, &context("inherited_parent"), 1, None).await;
    assert_eq!(inherited.result.rows.len(), 2);
    assert_eq!(inherited.result.rows[0][0], json!(1));
    assert_eq!(inherited.result.rows[1][0], json!(1));
    assert!(
        inherited.pagination.is_none(),
        "继承父表的主键不能证明子表合并后唯一"
    );
    let (view, _) = page(handle, &context("trusted_view"), 1, None).await;
    assert!(view.pagination.is_none());
    let (text, _) = page(handle, &context("text_key"), 1, None).await;
    assert!(text.pagination.is_none());
    let (no_key, _) = page(handle, &context("no_key"), 1, None).await;
    assert!(no_key.pagination.is_none());
    let (empty, _) = page(handle, &context("empty_table"), 1, None).await;
    assert!(empty.result.rows.is_empty());
    assert_eq!(empty.result.columns, ["id", "value"]);
    assert!(empty.pagination.unwrap().next_cursor.is_none());
    invalidate_table_metadata(&trusted.connection, None, None);
}

fn distribution(mut samples: Vec<f64>) -> Value {
    assert!(!samples.is_empty());
    samples.sort_by(f64::total_cmp);
    let rank = |percent: usize| (samples.len() * percent).div_ceil(100) - 1;
    json!({"n": samples.len(), "p50_ms": samples[rank(50)], "p95_ms": samples[rank(95)]})
}

#[tokio::test]
#[ignore = "仅限 metadata-postgres-validation.py 创建的 PostgreSQL 17 隔离库；5 预热 + 20 正式样本"]
async fn metadata_access_isolated_postgres17_pagination() {
    let (config, owner) = fixture().await;
    let observer_pool = pool(&config, false);
    let observer = checked(observer_pool.get().await, "借出分页观察连接");
    let version: String = checked(
        observer.query_one("SHOW server_version", &[]).await,
        "读取版本",
    )
    .get(0);
    let handle = PostgresPoolHandle {
        pool: owner,
        cancel_tls: PostgresCancelTls::NoTls,
    };
    // 预先建立生产池连接；不将首次 TCP 建连混入元数据冷/热比较。
    drop(checked(handle.pool.get().await, "预建生产连接"));
    trust_and_cursor(&handle).await;
    let warmups = [
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
    ];
    let samples = [
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
        sample(&handle, &observer).await,
    ];
    // 以下迭代仅聚合内存中的数值，绝不调用数据库。
    let cold = samples
        .iter()
        .map(|s| s["cold_ms"].as_f64().unwrap())
        .collect();
    let warm = samples
        .iter()
        .flat_map(|s| {
            s["warm_ms"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_f64().unwrap())
        })
        .collect();
    let invalidated = samples
        .iter()
        .map(|s| s["invalidated_ms"].as_f64().unwrap())
        .collect();
    println!(
        "METADATA_POSTGRES_PAGINATION {}",
        json!({
            "server_version": version, "passed": true, "clock": "Rust std::time::Instant monotonic",
            "scope": "production Rust query_table_data over loopback TCP; includes pool acquire, metadata if cold, data page and decode; excludes Tauri IPC/WebView/render/COUNT",
            "build_profile": if cfg!(debug_assertions) { "debug" } else { "release" },
            "warmups": warmups, "samples": samples,
            "summary": {"cold": distribution(cold), "warm": distribution(warm), "invalidated": distribution(invalidated)},
            "percentile_method": "nearest rank; warm n=400 individual requests from 20 sequences",
            "counter_order": ["pagination_metadata", "data_page", "count"],
            "trust_cases": ["single bigint key", "composite key fallback", "inheritance duplicate key fallback", "view fallback", "text key fallback", "no key fallback", "empty trusted table", "bigint precision"],
            "old_cursor_after_invalidation": "offset fallback", "fixture_retries": 0,
            "failure_policy": "abort; no failed sample is discarded or retried",
            "old_end_to_end_baseline": "unavailable; no speedup percentage",
        })
    );
    handle.pool.close();
    observer_pool.close();
}
