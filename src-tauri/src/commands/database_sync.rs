use super::connection::load_saved_connections_internal;
use super::temporary_database::{
    find_saved_connection, merge_operation_and_cleanup, merge_single_operation_and_cleanup,
    redact_error_text, temporary_connection_error, validate_endpoint_configs, validate_sync_target,
    TemporaryDatabaseConnection,
};
use crate::db::schema_compare::list_databases_for_compare;
use crate::db::schema_sync::{
    build_database_sync_preview, load_sync_schema_snapshot, normalize_selected_tables,
    SyncSchemaSnapshot,
};
use crate::models::types::{
    ConnectionConfig, DatabaseSyncPreview, DatabaseSyncRequest, DatabaseType,
};
use std::future::Future;
use tauri::AppHandle;

#[tauri::command]
pub async fn preview_database_sync(
    app: AppHandle,
    request: DatabaseSyncRequest,
) -> Result<DatabaseSyncPreview, String> {
    let saved = redact_preview_result(load_saved_connections_internal(&app), &[])?;
    let result = preview_database_sync_with_saved(&saved, &request).await;
    redact_preview_result(result, &saved)
}

fn redact_preview_result<T>(
    result: Result<T, String>,
    saved: &[ConnectionConfig],
) -> Result<T, String> {
    result.map_err(|error| redact_error_text(error, saved))
}

fn resolve_sync_configs(
    saved: &[ConnectionConfig],
    request: &DatabaseSyncRequest,
) -> Result<(ConnectionConfig, ConnectionConfig), String> {
    let source = find_saved_connection(saved, &request.source.saved_connection_id, "源端")?;
    let target = find_saved_connection(saved, &request.target.saved_connection_id, "目标端")?;
    validate_endpoint_configs(&source, &target)?;
    validate_sync_target(&target)?;
    Ok((source, target))
}

fn normalize_sync_request(request: &DatabaseSyncRequest) -> Result<DatabaseSyncRequest, String> {
    let mut normalized = request.clone();
    normalized.selected_tables = normalize_selected_tables(&request.selected_tables)?;
    Ok(normalized)
}

fn selected_database_error(
    side: &str,
    connection_name: &str,
    database: &str,
    error: &str,
) -> String {
    format!("{side}连接「{connection_name}」读取数据库/schema「{database}」失败: {error}")
}

fn validate_selected_database(
    side: &str,
    connection_name: &str,
    selected_database: &str,
    databases: &[String],
) -> Result<(), String> {
    if databases
        .iter()
        .any(|database| database == selected_database)
    {
        Ok(())
    } else {
        Err(format!(
            "{side}连接「{connection_name}」中的数据库/schema「{selected_database}」不存在"
        ))
    }
}

fn combine_endpoint_results<S, T>(
    source: Result<S, String>,
    target: Result<T, String>,
) -> Result<(S, T), String> {
    match (source, target) {
        (Ok(source), Ok(target)) => Ok((source, target)),
        (Err(source_error), Ok(_)) => Err(source_error),
        (Ok(_), Err(target_error)) => Err(target_error),
        (Err(source_error), Err(target_error)) => Err(format!("{source_error}；{target_error}")),
    }
}

#[allow(clippy::too_many_arguments)]
async fn with_temporary_connections<
    C,
    H,
    T,
    Open,
    OpenFuture,
    Handle,
    Operation,
    OperationFuture,
    Close,
    CloseFuture,
>(
    source_config: ConnectionConfig,
    target_config: ConnectionConfig,
    source_name: &str,
    target_name: &str,
    open: Open,
    handle: Handle,
    operation: Operation,
    close: Close,
) -> Result<T, String>
where
    Open: Fn(ConnectionConfig) -> OpenFuture,
    OpenFuture: Future<Output = Result<C, String>>,
    Handle: Fn(&C) -> H,
    Operation: FnOnce(H, H) -> OperationFuture,
    OperationFuture: Future<Output = Result<T, String>>,
    Close: Fn(C) -> CloseFuture,
    CloseFuture: Future<Output = Result<(), String>>,
{
    let (source_open, target_open) = tokio::join!(open(source_config), open(target_config));
    let (source_connection, target_connection) = match (source_open, target_open) {
        (Ok(source_connection), Ok(target_connection)) => (source_connection, target_connection),
        (Ok(source_connection), Err(error)) => {
            let operation = Err(temporary_connection_error("目标端", target_name, error));
            return merge_single_operation_and_cleanup(
                operation,
                "源端",
                close(source_connection).await,
            );
        }
        (Err(error), Ok(target_connection)) => {
            let operation = Err(temporary_connection_error("源端", source_name, error));
            return merge_single_operation_and_cleanup(
                operation,
                "目标端",
                close(target_connection).await,
            );
        }
        (Err(source_error), Err(target_error)) => {
            return Err(format!(
                "{}；{}",
                temporary_connection_error("源端", source_name, source_error),
                temporary_connection_error("目标端", target_name, target_error)
            ));
        }
    };

    let operation = operation(handle(&source_connection), handle(&target_connection)).await;
    let (source_cleanup, target_cleanup) =
        tokio::join!(close(source_connection), close(target_connection));
    merge_operation_and_cleanup(operation, source_cleanup, target_cleanup)
}

#[allow(clippy::too_many_arguments)]
async fn build_preview_with_loaders<P, List, ListFuture, Load, LoadFuture>(
    database_type: DatabaseType,
    source_name: &str,
    target_name: &str,
    source_pool: P,
    target_pool: P,
    request: &DatabaseSyncRequest,
    list_databases: List,
    load_snapshot: Load,
) -> Result<DatabaseSyncPreview, String>
where
    P: Clone,
    List: Fn(P) -> ListFuture,
    ListFuture: Future<Output = Result<Vec<String>, String>>,
    Load: Fn(P, String) -> LoadFuture,
    LoadFuture: Future<Output = Result<SyncSchemaSnapshot, String>>,
{
    let (source_databases, target_databases) = tokio::join!(
        list_databases(source_pool.clone()),
        list_databases(target_pool.clone())
    );
    let source_databases = source_databases.map_err(|error| {
        selected_database_error("源端", source_name, &request.source.database, &error)
    });
    let target_databases = target_databases.map_err(|error| {
        selected_database_error("目标端", target_name, &request.target.database, &error)
    });
    let (source_databases, target_databases) =
        combine_endpoint_results(source_databases, target_databases)?;
    combine_endpoint_results(
        validate_selected_database(
            "源端",
            source_name,
            &request.source.database,
            &source_databases,
        ),
        validate_selected_database(
            "目标端",
            target_name,
            &request.target.database,
            &target_databases,
        ),
    )?;

    let (source_snapshot, target_snapshot) = tokio::join!(
        load_snapshot(source_pool, request.source.database.clone()),
        load_snapshot(target_pool, request.target.database.clone())
    );
    let source_snapshot = source_snapshot.map_err(|error| {
        selected_database_error("源端", source_name, &request.source.database, &error)
    });
    let target_snapshot = target_snapshot.map_err(|error| {
        selected_database_error("目标端", target_name, &request.target.database, &error)
    });
    let (source_snapshot, target_snapshot) =
        combine_endpoint_results(source_snapshot, target_snapshot)?;
    build_database_sync_preview(database_type, request, &source_snapshot, &target_snapshot)
}

async fn preview_database_sync_with_saved(
    saved: &[ConnectionConfig],
    request: &DatabaseSyncRequest,
) -> Result<DatabaseSyncPreview, String> {
    let (source_config, target_config) = resolve_sync_configs(saved, request)?;
    let request = normalize_sync_request(request)?;
    let database_type = source_config.database_type;
    let source_name = source_config.name.clone();
    let target_name = target_config.name.clone();
    with_temporary_connections(
        source_config,
        target_config,
        &source_name,
        &target_name,
        TemporaryDatabaseConnection::open,
        |connection| connection.pool_handle(),
        |source_pool, target_pool| async {
            build_preview_with_loaders(
                database_type,
                &source_name,
                &target_name,
                source_pool,
                target_pool,
                &request,
                list_databases_for_compare,
                |pool, database| async move { load_sync_schema_snapshot(pool, &database).await },
            )
            .await
        },
        |connection| connection.close(),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema_compare::TableSnapshot;
    use crate::models::types::{
        ColumnSnapshot, ConnectionConfig, DatabaseCompareEndpointRequest, DatabaseSyncRequest,
        DatabaseType,
    };
    use std::collections::{BTreeMap, HashMap};
    use std::sync::{Arc, Mutex};

    fn config(id: &str, database_type: DatabaseType, read_only: bool) -> ConnectionConfig {
        ConnectionConfig {
            id: Some(id.to_string()),
            database_type,
            name: format!("连接-{id}"),
            host: "127.0.0.1".to_string(),
            port: 3306,
            username: "tester".to_string(),
            password: None,
            database: None,
            sqlite_path: None,
            ssh: None,
            ssl_mode: None,
            ssl_ca_path: None,
            ssl_pkcs12_path: None,
            ssl_pkcs12_password: None,
            ssl_tls_hostname: None,
            client_charset: None,
            session_init_commands: None,
            read_only: Some(read_only),
            skip_dangerous_sql_confirm: None,
            group_id: None,
        }
    }

    fn request(selected_tables: Vec<&str>, include_drops: bool) -> DatabaseSyncRequest {
        DatabaseSyncRequest {
            source: DatabaseCompareEndpointRequest {
                saved_connection_id: "source".to_string(),
                database: "app".to_string(),
            },
            target: DatabaseCompareEndpointRequest {
                saved_connection_id: "target".to_string(),
                database: "app_copy".to_string(),
            },
            selected_tables: selected_tables.into_iter().map(str::to_string).collect(),
            include_drops,
        }
    }

    #[test]
    fn resolve_sync_configs_rejects_read_only_target() {
        let saved = vec![
            config("source", DatabaseType::Postgres, false),
            config("target", DatabaseType::Postgres, true),
        ];

        let error = resolve_sync_configs(&saved, &request(vec!["users"], false)).unwrap_err();

        assert_eq!(error, "目标端保存连接配置为只读，不能执行数据库同步");
    }

    #[test]
    fn endpoint_error_mentions_side_connection_and_database() {
        let error = selected_database_error("目标端", "测试库", "app_copy", "无权限");

        assert_eq!(
            error,
            "目标端连接「测试库」读取数据库/schema「app_copy」失败: 无权限"
        );
    }

    #[test]
    fn preview_command_is_registered_with_request_payload_contract() {
        #[derive(serde::Deserialize)]
        struct PreviewCommandArguments {
            request: DatabaseSyncRequest,
        }

        let lib_source = include_str!("../lib.rs");
        assert!(lib_source.contains("database_sync::preview_database_sync"));

        let payload = serde_json::json!({
            "request": {
                "source": {
                    "saved_connection_id": "source",
                    "database": "app"
                },
                "target": {
                    "saved_connection_id": "target",
                    "database": "app_copy"
                },
                "selected_tables": ["users", "orders"],
                "include_drops": true
            }
        });
        let arguments: PreviewCommandArguments = serde_json::from_value(payload).unwrap();

        assert_eq!(arguments.request.selected_tables, vec!["users", "orders"]);
        assert!(arguments.request.include_drops);
    }

    #[test]
    fn preview_command_boundary_redacts_saved_connection_secrets() {
        let mut saved = config("source", DatabaseType::MySql, false);
        saved.password = Some("sync-secret".to_string());

        let error =
            redact_preview_result::<()>(Err("读取快照失败: sync-secret".to_string()), &[saved])
                .unwrap_err();

        assert_eq!(error, "读取快照失败: ••••••••");
        assert!(!error.contains("sync-secret"));
    }

    #[test]
    fn sync_request_preflight_rejects_empty_and_blank_selection() {
        assert_eq!(
            normalize_sync_request(&request(Vec::new(), false)).unwrap_err(),
            "请至少选择一张差异表"
        );
        assert_eq!(
            normalize_sync_request(&request(vec!["   "], false)).unwrap_err(),
            "同步表名不能为空"
        );
    }

    #[test]
    fn sync_request_preflight_normalizes_tables_and_preserves_drop_guard() {
        let normalized =
            normalize_sync_request(&request(vec![" users ", "orders", "users"], true)).unwrap();

        assert_eq!(normalized.selected_tables, vec!["orders", "users"]);
        assert!(normalized.include_drops);
    }

    #[derive(Clone)]
    struct FakeTemporaryConnection {
        side: &'static str,
        cleanup_error: Option<&'static str>,
    }

    async fn run_lifecycle_case(
        source_open: Result<FakeTemporaryConnection, String>,
        target_open: Result<FakeTemporaryConnection, String>,
        operation: Result<u32, String>,
    ) -> (Result<u32, String>, Vec<&'static str>) {
        let outcomes = Arc::new(Mutex::new(HashMap::from([
            ("source".to_string(), source_open),
            ("target".to_string(), target_open),
        ])));
        let closed = Arc::new(Mutex::new(Vec::new()));
        let result = with_temporary_connections(
            config("source", DatabaseType::MySql, false),
            config("target", DatabaseType::MySql, false),
            "连接-source",
            "连接-target",
            {
                let outcomes = outcomes.clone();
                move |config| {
                    let outcome = outcomes
                        .lock()
                        .unwrap()
                        .remove(config.id.as_deref().unwrap())
                        .unwrap();
                    async move { outcome }
                }
            },
            |connection| connection.side,
            move |source, target| async move {
                assert_eq!((source, target), ("源端", "目标端"));
                operation
            },
            {
                let closed = closed.clone();
                move |connection: FakeTemporaryConnection| {
                    let closed = closed.clone();
                    async move {
                        closed.lock().unwrap().push(connection.side);
                        connection
                            .cleanup_error
                            .map_or(Ok(()), |error| Err(error.to_string()))
                    }
                }
            },
        )
        .await;
        let mut closed = closed.lock().unwrap().clone();
        closed.sort_unstable();
        (result, closed)
    }

    fn fake_connection(
        side: &'static str,
        cleanup_error: Option<&'static str>,
    ) -> FakeTemporaryConnection {
        FakeTemporaryConnection {
            side,
            cleanup_error,
        }
    }

    #[tokio::test]
    async fn temporary_lifecycle_cleans_open_connections_for_all_open_outcomes() {
        let (result, closed) = run_lifecycle_case(
            Ok(fake_connection("源端", None)),
            Ok(fake_connection("目标端", None)),
            Ok(7),
        )
        .await;
        assert_eq!(result, Ok(7));
        assert_eq!(closed, vec!["源端", "目标端"]);

        let (result, closed) = run_lifecycle_case(
            Err("源建连失败".to_string()),
            Ok(fake_connection("目标端", None)),
            Ok(7),
        )
        .await;
        assert_eq!(
            result.unwrap_err(),
            "源端连接「连接-source」建立临时连接失败: 源建连失败"
        );
        assert_eq!(closed, vec!["目标端"]);

        let (result, closed) = run_lifecycle_case(
            Ok(fake_connection("源端", None)),
            Err("目标建连失败".to_string()),
            Ok(7),
        )
        .await;
        assert_eq!(
            result.unwrap_err(),
            "目标端连接「连接-target」建立临时连接失败: 目标建连失败"
        );
        assert_eq!(closed, vec!["源端"]);

        let (result, closed) = run_lifecycle_case(
            Err("源建连失败".to_string()),
            Err("目标建连失败".to_string()),
            Ok(7),
        )
        .await;
        assert_eq!(
            result.unwrap_err(),
            "源端连接「连接-source」建立临时连接失败: 源建连失败；目标端连接「连接-target」建立临时连接失败: 目标建连失败"
        );
        assert!(closed.is_empty());
    }

    #[tokio::test]
    async fn temporary_lifecycle_merges_operation_and_both_cleanup_failures() {
        let (result, closed) = run_lifecycle_case(
            Ok(fake_connection("源端", Some("源关闭失败"))),
            Ok(fake_connection("目标端", Some("目标关闭失败"))),
            Err("计划失败".to_string()),
        )
        .await;

        assert_eq!(closed, vec!["源端", "目标端"]);
        assert_eq!(
            result.unwrap_err(),
            "计划失败；清理临时连接失败: 源端: 源关闭失败；目标端: 目标关闭失败"
        );
    }

    #[tokio::test]
    async fn temporary_lifecycle_opens_both_sides_concurrently() {
        let barrier = Arc::new(tokio::sync::Barrier::new(2));
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            with_temporary_connections(
                config("source", DatabaseType::MySql, false),
                config("target", DatabaseType::MySql, false),
                "连接-source",
                "连接-target",
                {
                    let barrier = barrier.clone();
                    move |config| {
                        let barrier = barrier.clone();
                        async move {
                            barrier.wait().await;
                            Ok(fake_connection(
                                if config.id.as_deref() == Some("source") {
                                    "源端"
                                } else {
                                    "目标端"
                                },
                                None,
                            ))
                        }
                    }
                },
                |connection| connection.side,
                |_, _| async { Ok(11) },
                |_| async { Ok(()) },
            ),
        )
        .await
        .expect("双端建连应并行完成");

        assert_eq!(result, Ok(11));
    }

    #[tokio::test]
    async fn preview_loads_each_endpoint_once_and_runs_endpoint_io_concurrently() {
        let request = request(vec!["legacy"], false);
        let list_barrier = Arc::new(tokio::sync::Barrier::new(2));
        let snapshot_barrier = Arc::new(tokio::sync::Barrier::new(2));
        let calls = Arc::new(Mutex::new(HashMap::<String, usize>::new()));
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            build_preview_with_loaders(
                DatabaseType::MySql,
                "连接-source",
                "连接-target",
                "源端",
                "目标端",
                &request,
                {
                    let calls = calls.clone();
                    let list_barrier = list_barrier.clone();
                    move |side| {
                        let calls = calls.clone();
                        let list_barrier = list_barrier.clone();
                        async move {
                            *calls
                                .lock()
                                .unwrap()
                                .entry(format!("list-{side}"))
                                .or_default() += 1;
                            list_barrier.wait().await;
                            Ok(vec![if side == "源端" {
                                "app".to_string()
                            } else {
                                "app_copy".to_string()
                            }])
                        }
                    }
                },
                {
                    let calls = calls.clone();
                    let snapshot_barrier = snapshot_barrier.clone();
                    move |side, _database| {
                        let calls = calls.clone();
                        let snapshot_barrier = snapshot_barrier.clone();
                        async move {
                            *calls
                                .lock()
                                .unwrap()
                                .entry(format!("snapshot-{side}"))
                                .or_default() += 1;
                            snapshot_barrier.wait().await;
                            let tables = if side == "源端" {
                                Vec::new()
                            } else {
                                vec![TableSnapshot {
                                    name: "legacy".to_string(),
                                    columns: vec![(
                                        "id".to_string(),
                                        ColumnSnapshot {
                                            ordinal_position: 1,
                                            column_type: "bigint".to_string(),
                                            nullable: false,
                                            default_value: None,
                                            primary_key: true,
                                            extra: String::new(),
                                            comment: String::new(),
                                        },
                                    )],
                                }]
                            };
                            Ok(SyncSchemaSnapshot {
                                tables,
                                metadata: BTreeMap::new(),
                            })
                        }
                    }
                },
            ),
        )
        .await
        .expect("列库和快照应分别在两端并行完成")
        .unwrap();

        assert!(result.operations.is_empty());
        assert_eq!(result.skipped_items.len(), 1);
        assert!(!result.can_execute);
        assert_eq!(
            *calls.lock().unwrap(),
            HashMap::from([
                ("list-源端".to_string(), 1),
                ("list-目标端".to_string(), 1),
                ("snapshot-源端".to_string(), 1),
                ("snapshot-目标端".to_string(), 1),
            ])
        );
    }
}
