//! 只通过 mysql-budget-validation.py 创建的随机回环隔离实例运行。
//! 测试调用真实生产命令；MockRuntime 仅用于构造 State，不代表 IPC/WebView 测量。
use super::*;
use crate::db::connection::ConnectionManager;
use crate::models::types::ConnectionConfig;
use serde_json::json;
use std::path::PathBuf;
use tauri::Manager;

const DATABASE: &str = "budget_fixture";
const FIELD_BYTES: usize = 9 * 1024 * 1024;

fn checked<T, E>(result: Result<T, E>, stage: &str) -> T {
    // 驱动错误可能含 SQL/结果，不直接打印；只记录断言阶段。
    result.unwrap_or_else(|_| panic!("MySQL 预算隔离验收失败：{stage}"))
}

async fn page(
    state: State<'_, AppState>,
    id: &str,
    table: &str,
    selected: Option<Vec<String>>,
    execution: &str,
) -> Result<TablePageResult, String> {
    query_table_data(
        state,
        id.into(),
        DATABASE.into(),
        table.into(),
        1,
        10,
        Some(vec![TableSortField {
            column: "id".into(),
            order: "ASC".into(),
        }]),
        None,
        selected,
        Some(true),
        None,
        Some(execution.into()),
    )
    .await
}

async fn full(
    state: State<'_, AppState>,
    id: &str,
    table: &str,
    locators: Option<Vec<HashMap<String, JsonValue>>>,
    values: Vec<JsonValue>,
) -> Result<QueryResult, String> {
    query_full_rows(
        state,
        id.into(),
        DATABASE.into(),
        table.into(),
        "id".into(),
        values,
        locators,
        None,
    )
    .await
}

fn assert_budget_failure<T>(result: Result<T, String>) {
    // Err 本身证明整个命令未返回半页；不接受驱动错误冒充预算拒绝。
    assert!(
        matches!(result, Err(error) if error == crate::db::result_budget::result_bytes_exceeded())
    );
}

fn assert_small_page(result: Result<TablePageResult, String>) {
    let page = checked(result, "失败后仍能通过同一生产连接管理器取页");
    assert_eq!(page.result.columns, vec!["id"]);
    assert_eq!(page.result.rows.len(), 7);
}

fn assert_preview(result: Result<TablePageResult, String>, composite: bool) {
    let result = checked(result, "有可靠主键的大字段表页使用预览").result;
    assert_eq!(result.rows.len(), 7);
    let body_index = usize::from(composite) + 1;
    assert_eq!(result.rows[0][body_index]["__deferred_field"], true);
    assert_eq!(result.rows[0][body_index]["byte_length"], FIELD_BYTES);
    assert_eq!(
        result.rows[0][body_index]["preview"]
            .as_str()
            .expect("预览必须是文本")
            .len(),
        120
    );
    assert_eq!(result.rows[6][body_index].as_str().map(str::len), Some(7));
}

#[tokio::test]
#[ignore = "需要 mysql-budget-validation.py 创建的隔离 MySQL 8 实例"]
async fn mysql_budget_isolated_commands() {
    let path = checked(
        std::env::var("DB_CONNECT_BUDGET_MYSQL_FIXTURE"),
        "缺少隔离夹具路径",
    );
    let path = checked(PathBuf::from(path).canonicalize(), "夹具目录不存在");
    let config: JsonValue = checked(
        serde_json::from_slice(&checked(
            std::fs::read(path.join("fixture.json")),
            "缺少夹具描述",
        )),
        "无效夹具描述",
    );
    let marker = config["marker"].as_str().expect("缺少隔离标记");
    assert_eq!(marker.len(), 32);
    assert!(marker.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let name = format!("db-connect-budget-mysql-{marker}");
    assert_eq!(path, PathBuf::from("/private/tmp").join(&name));
    assert_eq!(config["container"], name);
    let port = config["port"].as_u64().expect("缺少随机端口");
    assert!(port > 1024 && port <= u16::MAX as u64 && port != 3306);
    let opts = mysql_async::OptsBuilder::default()
        .ip_or_hostname("127.0.0.1")
        .tcp_port(port as u16)
        .user(Some("root"))
        .prefer_socket(false);
    let mut observer = checked(mysql_async::Conn::new(opts).await, "创建隔离观察连接");
    let identity: (String, String, u8, u16, String) = checked(
        observer.query_first("SELECT @@version, @@server_uuid, @@lower_case_table_names, @@port, token FROM budget_fixture.marker WHERE id=1").await,
        "核验隔离实例标记",
    ).expect("缺少服务标记");
    assert!(identity.0.starts_with("8.4.") || identity.0.starts_with("8.0."));
    assert_eq!(identity.0, config["version"]);
    assert_eq!(identity.1, config["server_uuid"]);
    assert_eq!(identity.2, 0);
    assert_eq!(identity.3, 3306);
    assert_eq!(identity.4, marker);

    // 一次集合核验数据形状，后续命令显式逐案例调用，禁止遍历/轮询发 SQL。
    let shape: (u64, u64, u64, u64) = checked(
        observer.query_first("SELECT (SELECT COUNT(*) FROM budget_fixture.no_key_items), (SELECT COUNT(*) FROM budget_fixture.single_items), (SELECT COUNT(*) FROM budget_fixture.composite_items), (SELECT SUM(OCTET_LENGTH(body)) FROM budget_fixture.single_items WHERE id<=6)").await,
        "核验合成大字段夹具",
    ).expect("夹具形状缺失");
    assert_eq!(shape, (7, 7, 7, (6 * FIELD_BYTES) as u64));

    // JSON 只包含合成配置，不读取应用保存连接/凭据。
    let connection: ConnectionConfig = checked(
        serde_json::from_value(json!({
            "name": "isolated-budget", "host": "127.0.0.1", "port": port,
            "username": "root", "database": DATABASE, "ssl_mode": "disabled"
        })),
        "构造隔离连接配置",
    );
    let (id, active) = checked(
        ConnectionManager::prepare_connection(connection).await,
        "建立生产连接管理器连接",
    );
    let app = tauri::test::mock_builder()
        .manage(AppState::new())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("MockRuntime 初始化失败");
    let state = app.state::<AppState>();
    state
        .connection_manager
        .lock()
        .await
        .register(id.clone(), active);

    assert_budget_failure(page(state.clone(), &id, "no_key_items", None, "no-key-budget").await);
    assert_small_page(
        page(
            state.clone(),
            &id,
            "no_key_items",
            Some(vec!["id".into()]),
            "after-page-budget",
        )
        .await,
    );

    assert_preview(
        page(state.clone(), &id, "single_items", None, "single-preview").await,
        false,
    );
    assert_budget_failure(
        full(
            state.clone(),
            &id,
            "single_items",
            None,
            vec![json!(1), json!(2), json!(3), json!(4), json!(5), json!(6)],
        )
        .await,
    );
    assert_small_page(
        page(
            state.clone(),
            &id,
            "single_items",
            Some(vec!["id".into()]),
            "after-single-budget",
        )
        .await,
    );
    let small = checked(
        full(state.clone(), &id, "single_items", None, vec![json!(7)]).await,
        "超预算后完整行入口仍可用",
    );
    assert_eq!(small.rows.len(), 1);
    assert_eq!(small.rows[0][1].as_str().map(str::len), Some(7));

    assert_preview(
        page(
            state.clone(),
            &id,
            "composite_items",
            None,
            "composite-preview",
        )
        .await,
        true,
    );
    let locators = (1..=6)
        .map(|value| HashMap::from([("tenant".into(), json!(1)), ("id".into(), json!(value))]))
        .collect();
    assert_budget_failure(
        full(
            state.clone(),
            &id,
            "composite_items",
            Some(locators),
            vec![],
        )
        .await,
    );
    let small = checked(
        full(
            state.clone(),
            &id,
            "composite_items",
            Some(vec![HashMap::from([
                ("tenant".into(), json!(1)),
                ("id".into(), json!(7)),
            ])]),
            vec![],
        )
        .await,
        "复合主键预算失败后完整行仍可用",
    );
    assert_eq!(small.rows.len(), 1);
    assert_eq!(small.rows[0][2].as_str().map(str::len), Some(7));

    assert!(
        matches!(full(state.clone(), &id, "no_key_items", None, vec![json!(1)]).await, Err(error) if error.contains("缺少可靠的完整主键"))
    );
    let empty = checked(
        page(state.clone(), &id, "empty_no_key", None, "empty-no-key").await,
        "空无键表页",
    );
    assert!(empty.result.rows.is_empty());
    assert_eq!(empty.result.columns, vec!["id", "body"]);
    let empty = checked(
        page(
            state.clone(),
            &id,
            "empty_composite",
            None,
            "empty-composite",
        )
        .await,
        "空复合键表页",
    );
    assert!(empty.result.rows.is_empty());
    assert_eq!(empty.result.columns, vec!["tenant", "id", "body"]);
    let empty = checked(
        full(
            state.clone(),
            &id,
            "empty_composite",
            Some(vec![HashMap::from([
                ("tenant".into(), json!(1)),
                ("id".into(), json!(1)),
            ])]),
            vec![],
        )
        .await,
        "空复合键完整行",
    );
    assert!(empty.rows.is_empty());
    assert_eq!(empty.columns, vec!["tenant", "id", "body"]);

    assert!(checked(
        cancel_table_query(state.clone(), id.clone(), "pre-cancelled".into()).await,
        "登记预取消"
    ));
    let manager = state.connection_manager.lock().await;
    let mut cancelled = Box::pin(page(
        state.clone(),
        &id,
        "single_items",
        Some(vec!["id".into()]),
        "pre-cancelled",
    ));
    assert!(
        matches!(futures_util::poll!(cancelled.as_mut()), std::task::Poll::Ready(Err(error)) if error == "表数据加载已中断")
    );
    drop(cancelled);

    // 单次 poll + 持锁是确定性握手；新命令登记后必然停在连接获取之前。
    let mut newer = Box::pin(page(
        state.clone(),
        &id,
        "single_items",
        Some(vec!["id".into()]),
        "new-after-old",
    ));
    assert!(futures_util::poll!(newer.as_mut()).is_pending());
    assert!(!checked(
        cancel_table_query(state.clone(), id.clone(), "after-single-budget".into()).await,
        "旧已完成句柄取消"
    ));
    assert!(!checked(
        cancel_table_query(state.clone(), id.clone(), "pre-cancelled".into()).await,
        "旧取消句柄重试"
    ));
    drop(manager);
    assert_small_page(newer.await);

    checked(
        state.connection_manager.lock().await.disconnect(&id).await,
        "断开自有生产连接",
    );
    checked(observer.disconnect().await, "断开观察连接");
    let evidence = json!({
        "result_budget_bytes": 32 * 1024 * 1024,
        "field_bytes": FIELD_BYTES, "large_rows_per_table": 6,
        "production_commands": ["query_table_data", "query_full_rows", "cancel_table_query"],
        "passed": ["no_key_page_over_budget_returns_error", "single_key_preview", "single_key_full_over_budget_returns_error", "composite_key_preview", "composite_key_full_over_budget_returns_error", "post_failure_page_and_full_row_queries", "no_key_full_row_rejected", "empty_no_key_page_columns", "empty_composite_page_and_full_row_columns", "pre_cancel_before_connection_access", "finished_and_cancelled_old_handles_do_not_cancel_new_real_query"],
        "not_measured": ["in_flight_server_cancellation", "IPC", "WebView", "RSS", "100000_row_limit"],
        "cancellation_scope": "deterministic pre-connection cancellation and stale-handle isolation; not active server query termination"
    });
    checked(
        std::fs::write(
            path.join("results.json"),
            checked(serde_json::to_vec_pretty(&evidence), "序列化证据"),
        ),
        "保存断言证据",
    );
    println!("MySQL 预算实库：生产表页/完整行预算、恢复、主键/空表及连接前取消断言通过");
}
