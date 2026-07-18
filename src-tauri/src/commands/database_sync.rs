use super::connection::load_saved_connections_internal;
use super::temporary_database::{
    find_saved_connection, merge_operation_and_cleanup, merge_single_operation_and_cleanup,
    redact_error_text, temporary_connection_error, validate_endpoint_configs, validate_sync_target,
    TemporaryDatabaseConnection,
};
use crate::db::connection::{get_conn_with_retry, DatabasePoolHandle};
use crate::db::postgres;
use crate::db::schema_compare::{compare_schema_snapshots, list_databases_for_compare};
use crate::db::schema_sync::{
    build_database_sync_preview, load_sync_schema_snapshot, normalize_selected_tables,
    SyncSchemaSnapshot,
};
use crate::models::types::{
    CompareEndpointInfo, ConnectionConfig, DatabaseSyncExecutionResult,
    DatabaseSyncExecutionStatus, DatabaseSyncFailure, DatabaseSyncOperation, DatabaseSyncPreview,
    DatabaseSyncProgress, DatabaseSyncProgressPhase, DatabaseSyncRequest, DatabaseSyncRisk,
    DatabaseSyncStatementSuccess, DatabaseType, ExecuteDatabaseSyncRequest,
};
use mysql_async::prelude::Queryable;
use std::future::Future;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

const DATABASE_SYNC_PROGRESS_EVENT: &str = "database-sync-progress";
type DatabaseSyncProgressSink = Arc<dyn Fn(DatabaseSyncProgress) + Send + Sync>;

#[tauri::command]
pub async fn preview_database_sync(
    app: AppHandle,
    request: DatabaseSyncRequest,
) -> Result<DatabaseSyncPreview, String> {
    let saved = redact_preview_result(load_saved_connections_internal(&app), &[])?;
    let result = preview_database_sync_with_saved(&saved, &request).await;
    redact_preview_result(result, &saved)
}

#[tauri::command]
pub async fn execute_database_sync(
    app: AppHandle,
    input: ExecuteDatabaseSyncRequest,
) -> Result<DatabaseSyncExecutionResult, String> {
    let progress_app = app.clone();
    let progress_sink: DatabaseSyncProgressSink = Arc::new(move |progress| {
        let _ = progress_app.emit(DATABASE_SYNC_PROGRESS_EVENT, progress);
    });
    execute_database_sync_command_with_loader(
        input,
        || load_saved_connections_internal(&app),
        progress_sink,
    )
    .await
}

async fn execute_database_sync_command_with_loader<L>(
    input: ExecuteDatabaseSyncRequest,
    load_saved: L,
    progress_sink: DatabaseSyncProgressSink,
) -> Result<DatabaseSyncExecutionResult, String>
where
    L: FnOnce() -> Result<Vec<ConnectionConfig>, String>,
{
    emit_database_sync_progress(
        Some(&progress_sink),
        &input.plan_fingerprint,
        DatabaseSyncProgressPhase::Validating,
        0,
        0,
    );
    let saved = load_saved().map_err(|error| redact_error_text(error, &[]))?;
    let result = execute_database_sync_with_saved(&saved, input, Some(progress_sink)).await;
    redact_execution_result(result, &saved)
}

fn emit_database_sync_progress(
    progress_sink: Option<&DatabaseSyncProgressSink>,
    plan_fingerprint: &str,
    phase: DatabaseSyncProgressPhase,
    current: usize,
    total: usize,
) {
    let Some(progress_sink) = progress_sink else {
        return;
    };
    progress_sink(DatabaseSyncProgress {
        plan_fingerprint: plan_fingerprint.to_string(),
        phase,
        current,
        total,
    });
}

fn redact_preview_result<T>(
    result: Result<T, String>,
    saved: &[ConnectionConfig],
) -> Result<T, String> {
    result.map_err(|error| redact_error_text(error, saved))
}

fn redact_execution_result(
    result: Result<DatabaseSyncExecutionResult, String>,
    saved: &[ConnectionConfig],
) -> Result<DatabaseSyncExecutionResult, String> {
    result
        .map(|mut result| {
            if let Some(failed) = result.failed.as_mut() {
                failed.error = redact_error_text(std::mem::take(&mut failed.error), saved);
            }
            for error in &mut result.cleanup_errors {
                *error = redact_error_text(std::mem::take(error), saved);
            }
            result
        })
        .map_err(|error| redact_error_text(error, saved))
}

fn validate_plan_fingerprint(confirmed: &str, current: &str) -> Result<(), String> {
    if confirmed == current {
        Ok(())
    } else {
        Err("数据库结构已变化，请重新对比并预览同步计划".to_string())
    }
}

fn validate_executable_preview(
    preview: &DatabaseSyncPreview,
    include_drops: bool,
) -> Result<(), String> {
    if !preview.blockers.is_empty() {
        return Err("同步计划包含阻塞项，不能执行".to_string());
    }
    if preview.operations.is_empty() {
        return Err("同步计划没有可执行操作".to_string());
    }
    if !preview.can_execute
        || preview
            .operations
            .iter()
            .any(|operation| operation.sql.is_empty())
    {
        return Err("同步计划包含不可执行操作".to_string());
    }
    if !include_drops
        && preview.operations.iter().any(|operation| {
            operation.risk == DatabaseSyncRisk::Destructive
                || matches!(
                    operation.kind,
                    crate::models::types::DatabaseSyncOperationKind::DropColumn
                        | crate::models::types::DatabaseSyncOperationKind::DropTable
                )
        })
    {
        return Err("同步计划包含删除操作，但请求未开启包含删除操作".to_string());
    }
    Ok(())
}

#[allow(dead_code, reason = "保留无进度调用方的简洁接口")]
async fn execute_operations_with<F, Fut>(
    operations: &[DatabaseSyncOperation],
    execute: F,
) -> DatabaseSyncExecutionResult
where
    F: FnMut(&str) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    execute_operations_with_progress(operations, execute, |_current, _total| {}).await
}

async fn execute_operations_with_progress<F, Fut, P>(
    operations: &[DatabaseSyncOperation],
    mut execute: F,
    mut on_progress: P,
) -> DatabaseSyncExecutionResult
where
    F: FnMut(&str) -> Fut,
    Fut: Future<Output = Result<(), String>>,
    P: FnMut(usize, usize),
{
    let total = operations.iter().map(|operation| operation.sql.len()).sum();
    let mut completed = Vec::new();
    on_progress(0, total);

    for (operation_index, operation) in operations.iter().enumerate() {
        for (statement_index, sql) in operation.sql.iter().enumerate() {
            if let Err(error) = execute(sql).await {
                return DatabaseSyncExecutionResult {
                    status: if completed.is_empty() {
                        DatabaseSyncExecutionStatus::Failed
                    } else {
                        DatabaseSyncExecutionStatus::PartiallySucceeded
                    },
                    completed_statements: completed,
                    failed: Some(DatabaseSyncFailure {
                        operation_id: operation.id.clone(),
                        statement_index,
                        error,
                    }),
                    pending_operation_ids: operations[operation_index + 1..]
                        .iter()
                        .map(|item| item.id.clone())
                        .collect(),
                    cleanup_errors: Vec::new(),
                    latest_compare_result: None,
                };
            }
            completed.push(DatabaseSyncStatementSuccess {
                operation_id: operation.id.clone(),
                statement_index,
            });
            on_progress(completed.len(), total);
        }
    }
    DatabaseSyncExecutionResult {
        status: DatabaseSyncExecutionStatus::Succeeded,
        completed_statements: completed,
        failed: None,
        pending_operation_ids: Vec::new(),
        cleanup_errors: Vec::new(),
        latest_compare_result: None,
    }
}

async fn execute_sync_statement(pool: DatabasePoolHandle, sql: &str) -> Result<(), String> {
    match pool {
        DatabasePoolHandle::MySql(pool) => {
            let mut connection = get_conn_with_retry(&pool)
                .await
                .map_err(|error| format!("MySQL 同步 DDL 获取连接失败: {error}"))?;
            connection
                .query_drop(sql)
                .await
                .map_err(|error| format!("MySQL 同步 DDL 执行失败: {error}"))
        }
        DatabasePoolHandle::Postgres(handle) => {
            let client = postgres::get_client_with_retry(&handle.pool)
                .await
                .map_err(|error| format!("PostgreSQL 同步 DDL 获取连接失败: {error}"))?;
            client
                .batch_execute(sql)
                .await
                .map_err(|error| format!("PostgreSQL 同步 DDL 执行失败: {error}"))
        }
        DatabasePoolHandle::Sqlite(handle) => {
            let sql = sql.to_string();
            let connection = handle
                .pool
                .get()
                .await
                .map_err(|error| format!("SQLite 同步 DDL 获取连接失败: {error}"))?;
            connection
                .interact(move |connection| {
                    connection
                        .execute_batch(&sql)
                        .map_err(|error| format!("SQLite 同步 DDL 执行失败: {error}"))
                })
                .await
                .map_err(|error| format!("SQLite 同步 DDL 连接任务失败: {error}"))?
        }
        DatabasePoolHandle::SqlServer(handle) => {
            let mut client = handle
                .pool
                .get()
                .await
                .map_err(|error| format!("SQL Server 同步 DDL 获取连接失败: {error}"))?;
            let stream = client
                .simple_query(sql)
                .await
                .map_err(|error| format!("SQL Server 同步 DDL 执行失败: {error}"))?;
            stream
                .into_results()
                .await
                .map(|_| ())
                .map_err(|error| format!("SQL Server 同步 DDL 读取结果失败: {error}"))
        }
        DatabasePoolHandle::ClickHouse(handle) => handle
            .client
            .query(sql)
            .execute()
            .await
            .map_err(|error| format!("ClickHouse 同步 DDL 执行失败: {error}")),
    }
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
async fn with_temporary_execution_connections<
    C,
    H,
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
) -> Result<DatabaseSyncExecutionResult, String>
where
    Open: Fn(ConnectionConfig) -> OpenFuture,
    OpenFuture: Future<Output = Result<C, String>>,
    Handle: Fn(&C) -> H,
    Operation: FnOnce(H, H) -> OperationFuture,
    OperationFuture: Future<Output = Result<DatabaseSyncExecutionResult, String>>,
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
    merge_execution_and_cleanup(operation, source_cleanup, target_cleanup)
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

async fn execute_database_sync_with_saved(
    saved: &[ConnectionConfig],
    input: ExecuteDatabaseSyncRequest,
    progress_sink: Option<DatabaseSyncProgressSink>,
) -> Result<DatabaseSyncExecutionResult, String> {
    let (source_config, target_config) = resolve_sync_configs(saved, &input.request)?;
    let request = normalize_sync_request(&input.request)?;
    let database_type = source_config.database_type;
    let source_name = source_config.name.clone();
    let target_name = target_config.name.clone();

    with_temporary_execution_connections(
        source_config,
        target_config,
        &source_name,
        &target_name,
        TemporaryDatabaseConnection::open,
        |connection| connection.pool_handle(),
        |source_pool, target_pool| async {
            execute_database_sync_on_pools(
                database_type,
                &source_name,
                &target_name,
                source_pool,
                target_pool,
                &request,
                &input.plan_fingerprint,
                progress_sink,
            )
            .await
        },
        |connection| connection.close(),
    )
    .await
}

fn merge_execution_and_cleanup(
    operation: Result<DatabaseSyncExecutionResult, String>,
    source_cleanup: Result<(), String>,
    target_cleanup: Result<(), String>,
) -> Result<DatabaseSyncExecutionResult, String> {
    match operation {
        Ok(mut result) => {
            result.cleanup_errors.extend(
                [
                    source_cleanup.err().map(|error| format!("源端: {error}")),
                    target_cleanup.err().map(|error| format!("目标端: {error}")),
                ]
                .into_iter()
                .flatten(),
            );
            Ok(result)
        }
        Err(error) => merge_operation_and_cleanup(Err(error), source_cleanup, target_cleanup),
    }
}

#[allow(clippy::too_many_arguments)]
async fn execute_database_sync_on_pools(
    database_type: DatabaseType,
    source_name: &str,
    target_name: &str,
    source_pool: DatabasePoolHandle,
    target_pool: DatabasePoolHandle,
    request: &DatabaseSyncRequest,
    confirmed_fingerprint: &str,
    progress_sink: Option<DatabaseSyncProgressSink>,
) -> Result<DatabaseSyncExecutionResult, String> {
    let preview = build_preview_with_loaders(
        database_type,
        source_name,
        target_name,
        source_pool.clone(),
        target_pool.clone(),
        request,
        list_databases_for_compare,
        |pool, database| async move { load_sync_schema_snapshot(pool, &database).await },
    )
    .await?;
    validate_plan_fingerprint(confirmed_fingerprint, &preview.plan_fingerprint)?;
    validate_executable_preview(&preview, request.include_drops)?;

    let target_pool_for_execute = target_pool.clone();
    let progress_sink_for_execute = progress_sink.clone();
    let progress_fingerprint = confirmed_fingerprint.to_string();
    let mut result = execute_operations_with_progress(
        &preview.operations,
        move |sql| {
            let target_pool = target_pool_for_execute.clone();
            let sql = sql.to_string();
            async move { execute_sync_statement(target_pool, &sql).await }
        },
        move |current, total| {
            emit_database_sync_progress(
                progress_sink_for_execute.as_ref(),
                &progress_fingerprint,
                DatabaseSyncProgressPhase::Executing,
                current,
                total,
            );
        },
    )
    .await;
    add_execution_failure_context(&mut result, &preview.operations, target_name, request);
    if result.status != DatabaseSyncExecutionStatus::Succeeded {
        return Ok(result);
    }

    emit_database_sync_progress(
        progress_sink.as_ref(),
        confirmed_fingerprint,
        DatabaseSyncProgressPhase::Refreshing,
        result.completed_statements.len(),
        result.completed_statements.len(),
    );

    let (source_snapshot, target_snapshot) = tokio::join!(
        load_sync_schema_snapshot(source_pool, &request.source.database),
        load_sync_schema_snapshot(target_pool, &request.target.database)
    );
    let source_snapshot = source_snapshot.map_err(|error| {
        selected_database_error("源端", source_name, &request.source.database, &error)
    });
    let target_snapshot = target_snapshot.map_err(|error| {
        selected_database_error("目标端", target_name, &request.target.database, &error)
    });
    match combine_endpoint_results(source_snapshot, target_snapshot) {
        Ok((source_snapshot, target_snapshot)) => {
            let compared_at = OffsetDateTime::now_utc()
                .format(&Rfc3339)
                .map_err(|_| "生成对比时间失败".to_string());
            match compared_at {
                Ok(compared_at) => {
                    result.latest_compare_result = Some(compare_schema_snapshots(
                        database_type,
                        compare_endpoint(&request.source, source_name),
                        compare_endpoint(&request.target, target_name),
                        compared_at,
                        source_snapshot.tables,
                        target_snapshot.tables,
                    ));
                }
                Err(error) => result
                    .cleanup_errors
                    .push(format!("同步 DDL 已完成，但重新对比失败: {error}")),
            }
        }
        Err(error) => result
            .cleanup_errors
            .push(format!("同步 DDL 已完成，但重新对比失败: {error}")),
    }
    Ok(result)
}

fn compare_endpoint(
    endpoint: &crate::models::types::DatabaseCompareEndpointRequest,
    connection_name: &str,
) -> CompareEndpointInfo {
    CompareEndpointInfo {
        connection_id: endpoint.saved_connection_id.clone(),
        connection_name: connection_name.to_string(),
        database: endpoint.database.clone(),
    }
}

fn add_execution_failure_context(
    result: &mut DatabaseSyncExecutionResult,
    operations: &[DatabaseSyncOperation],
    target_name: &str,
    request: &DatabaseSyncRequest,
) {
    let Some(failed) = result.failed.as_mut() else {
        return;
    };
    let Some(operation) = operations
        .iter()
        .find(|operation| operation.id == failed.operation_id)
    else {
        return;
    };
    failed.error = format!(
        "目标端连接「{}」数据库/schema「{}」执行同步操作「{}」（表「{}」）失败: {}",
        target_name, request.target.database, operation.summary, operation.table_name, failed.error
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema_compare::TableSnapshot;
    use crate::models::types::{
        ColumnSnapshot, ConnectionConfig, DatabaseCompareEndpointRequest,
        DatabaseSyncExecutionStatus, DatabaseSyncOperation, DatabaseSyncOperationKind,
        DatabaseSyncPreview, DatabaseSyncRequest, DatabaseSyncRisk, DatabaseType,
        ExecuteDatabaseSyncRequest,
    };
    use std::collections::{BTreeMap, HashMap};
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Mutex};
    use uuid::Uuid;

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

    fn operation(id: &str, sql: Vec<&str>) -> DatabaseSyncOperation {
        DatabaseSyncOperation {
            id: id.to_string(),
            table_name: format!("table-{id}"),
            kind: DatabaseSyncOperationKind::CreateTable,
            summary: format!("执行 {id}"),
            risk: DatabaseSyncRisk::Normal,
            sql: sql.into_iter().map(str::to_string).collect(),
        }
    }

    fn sqlite_fixture_paths() -> (PathBuf, PathBuf) {
        let id = Uuid::new_v4();
        let directory = std::env::temp_dir();
        (
            directory.join(format!("db-connect-sync-source-{id}.sqlite")),
            directory.join(format!("db-connect-sync-target-{id}.sqlite")),
        )
    }

    fn sqlite_config(id: &str, path: &Path) -> ConnectionConfig {
        let mut config = config(id, DatabaseType::Sqlite, false);
        config.sqlite_path = Some(path.to_string_lossy().into_owned());
        config
    }

    fn sqlite_request(selected_tables: Vec<&str>, include_drops: bool) -> DatabaseSyncRequest {
        DatabaseSyncRequest {
            source: DatabaseCompareEndpointRequest {
                saved_connection_id: "source".to_string(),
                database: "main".to_string(),
            },
            target: DatabaseCompareEndpointRequest {
                saved_connection_id: "target".to_string(),
                database: "main".to_string(),
            },
            selected_tables: selected_tables.into_iter().map(str::to_string).collect(),
            include_drops,
        }
    }

    fn sqlite_sync_fixture() -> (Vec<ConnectionConfig>, DatabaseSyncRequest, PathBuf, PathBuf) {
        let (source_path, target_path) = sqlite_fixture_paths();
        rusqlite::Connection::open(&source_path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);\
                 CREATE TABLE audit (id INTEGER PRIMARY KEY);\
                 CREATE TABLE obsolete_columns (id INTEGER PRIMARY KEY);",
            )
            .unwrap();
        rusqlite::Connection::open(&target_path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE users (id INTEGER PRIMARY KEY);\
                 CREATE TABLE obsolete_columns (id INTEGER PRIMARY KEY, legacy TEXT);\
                 CREATE TABLE old_table (id INTEGER PRIMARY KEY);",
            )
            .unwrap();
        (
            vec![
                sqlite_config("source", &source_path),
                sqlite_config("target", &target_path),
            ],
            sqlite_request(
                vec!["audit", "obsolete_columns", "old_table", "users"],
                true,
            ),
            source_path,
            target_path,
        )
    }

    fn sqlite_add_column_fixture() -> (Vec<ConnectionConfig>, DatabaseSyncRequest, PathBuf, PathBuf)
    {
        let (source_path, target_path) = sqlite_fixture_paths();
        rusqlite::Connection::open(&source_path)
            .unwrap()
            .execute_batch("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT);")
            .unwrap();
        rusqlite::Connection::open(&target_path)
            .unwrap()
            .execute_batch("CREATE TABLE users (id INTEGER PRIMARY KEY);")
            .unwrap();
        (
            vec![
                sqlite_config("source", &source_path),
                sqlite_config("target", &target_path),
            ],
            sqlite_request(vec!["users"], false),
            source_path,
            target_path,
        )
    }

    fn sqlite_column_names(path: &Path, table: &str) -> Vec<String> {
        let connection = rusqlite::Connection::open(path).unwrap();
        let sql = format!("PRAGMA table_info(\"{}\")", table.replace('"', "\"\""));
        let mut statement = connection.prepare(&sql).unwrap();
        statement
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<Vec<String>, _>>()
            .unwrap()
    }

    fn remove_sqlite_fixture(source_path: PathBuf, target_path: PathBuf) {
        std::fs::remove_file(source_path).unwrap();
        std::fs::remove_file(target_path).unwrap();
    }

    #[tokio::test]
    async fn execution_progress_reports_initial_total_and_only_successful_statements() {
        let operations = vec![
            operation("op-0001", vec!["SQL 1"]),
            operation("op-0002", vec!["SQL 2", "SQL 3"]),
            operation("op-0003", vec!["SQL 4"]),
        ];
        let progress = Arc::new(Mutex::new(Vec::new()));
        let progress_for_callback = progress.clone();

        let result = execute_operations_with_progress(
            &operations,
            |sql| {
                let sql = sql.to_string();
                async move {
                    if sql == "SQL 3" {
                        Err("模拟失败".to_string())
                    } else {
                        Ok(())
                    }
                }
            },
            move |current, total| {
                progress_for_callback.lock().unwrap().push((current, total));
            },
        )
        .await;

        assert_eq!(*progress.lock().unwrap(), vec![(0, 4), (1, 4), (2, 4)]);
        assert_eq!(
            result.status,
            DatabaseSyncExecutionStatus::PartiallySucceeded
        );
        assert_eq!(result.completed_statements.len(), 2);
    }

    #[tokio::test]
    async fn execution_stops_at_first_failed_statement_and_reports_pending_operations() {
        let operations = vec![
            operation("op-0001", vec!["SQL 1"]),
            operation("op-0002", vec!["SQL 2", "SQL 3"]),
            operation("op-0003", vec!["SQL 4"]),
        ];
        let seen = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let seen_for_execute = seen.clone();

        let result = execute_operations_with(&operations, move |sql| {
            let seen = seen_for_execute.clone();
            let sql = sql.to_string();
            async move {
                seen.lock().await.push(sql.clone());
                if sql == "SQL 3" {
                    Err("模拟失败".to_string())
                } else {
                    Ok(())
                }
            }
        })
        .await;

        assert_eq!(*seen.lock().await, vec!["SQL 1", "SQL 2", "SQL 3"]);
        assert_eq!(
            result.status,
            DatabaseSyncExecutionStatus::PartiallySucceeded
        );
        assert_eq!(result.completed_statements.len(), 2);
        assert_eq!(result.failed.unwrap().operation_id, "op-0002");
        assert_eq!(result.pending_operation_ids, vec!["op-0003"]);
    }

    #[tokio::test]
    async fn first_statement_failure_reports_failed_without_following_calls() {
        let operations = vec![
            operation("op-0001", vec!["FAIL", "SQL 2"]),
            operation("op-0002", vec!["SQL 3"]),
        ];
        let seen = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let seen_for_execute = seen.clone();

        let result = execute_operations_with(&operations, move |sql| {
            let seen = seen_for_execute.clone();
            let sql = sql.to_string();
            async move {
                seen.lock().await.push(sql);
                Err("首条失败".to_string())
            }
        })
        .await;

        assert_eq!(*seen.lock().await, vec!["FAIL"]);
        assert_eq!(result.status, DatabaseSyncExecutionStatus::Failed);
        assert!(result.completed_statements.is_empty());
        assert_eq!(result.pending_operation_ids, vec!["op-0002"]);
    }

    #[test]
    fn fingerprint_mismatch_is_rejected_before_execution() {
        let error = validate_plan_fingerprint("confirmed", "current").unwrap_err();

        assert_eq!(error, "数据库结构已变化，请重新对比并预览同步计划");
    }

    #[test]
    fn execution_gate_rejects_blocked_empty_and_unexecutable_plans() {
        let mut preview = DatabaseSyncPreview {
            plan_fingerprint: "fingerprint".to_string(),
            summary: Default::default(),
            operations: Vec::new(),
            skipped_items: Vec::new(),
            blockers: Vec::new(),
            can_execute: false,
        };
        assert_eq!(
            validate_executable_preview(&preview, false).unwrap_err(),
            "同步计划没有可执行操作"
        );

        preview
            .blockers
            .push(crate::models::types::DatabaseSyncBlocker {
                table_name: "users".to_string(),
                summary: "无法修改 users".to_string(),
                reason: "模拟阻塞".to_string(),
            });
        assert_eq!(
            validate_executable_preview(&preview, false).unwrap_err(),
            "同步计划包含阻塞项，不能执行"
        );

        preview.blockers.clear();
        preview.can_execute = true;
        preview.operations.push(operation("op-0001", Vec::new()));
        assert_eq!(
            validate_executable_preview(&preview, false).unwrap_err(),
            "同步计划包含不可执行操作"
        );
    }

    #[test]
    fn execution_gate_requires_drop_guard_for_destructive_plan() {
        let mut destructive = operation("op-0001", vec!["DROP TABLE users"]);
        destructive.kind = DatabaseSyncOperationKind::DropTable;
        destructive.risk = DatabaseSyncRisk::Destructive;
        let preview = DatabaseSyncPreview {
            plan_fingerprint: "fingerprint".to_string(),
            summary: Default::default(),
            operations: vec![destructive],
            skipped_items: Vec::new(),
            blockers: Vec::new(),
            can_execute: true,
        };

        assert_eq!(
            validate_executable_preview(&preview, false).unwrap_err(),
            "同步计划包含删除操作，但请求未开启包含删除操作"
        );
        assert!(validate_executable_preview(&preview, true).is_ok());
    }

    #[test]
    fn execute_command_is_registered_with_fingerprint_and_request_contract() {
        #[derive(serde::Deserialize)]
        struct ExecuteCommandArguments {
            input: ExecuteDatabaseSyncRequest,
        }

        let lib_source = include_str!("../lib.rs");
        assert!(lib_source.contains("database_sync::execute_database_sync"));

        let payload = serde_json::json!({
            "input": {
                "request": {
                    "source": { "saved_connection_id": "source", "database": "main" },
                    "target": { "saved_connection_id": "target", "database": "main" },
                    "selected_tables": ["users"],
                    "include_drops": false
                },
                "plan_fingerprint": "preview-fingerprint"
            }
        });
        let arguments: ExecuteCommandArguments = serde_json::from_value(payload).unwrap();

        assert_eq!(arguments.input.plan_fingerprint, "preview-fingerprint");
        assert_eq!(arguments.input.request.selected_tables, vec!["users"]);
    }

    #[test]
    fn execution_result_redaction_covers_statement_and_cleanup_errors() {
        let mut saved = config("source", DatabaseType::MySql, false);
        saved.password = Some("sync-secret".to_string());
        let result = crate::models::types::DatabaseSyncExecutionResult {
            status: DatabaseSyncExecutionStatus::Failed,
            completed_statements: Vec::new(),
            failed: Some(crate::models::types::DatabaseSyncFailure {
                operation_id: "op-0001".to_string(),
                statement_index: 0,
                error: "DDL 失败: sync-secret".to_string(),
            }),
            pending_operation_ids: vec!["op-0001".to_string()],
            cleanup_errors: vec!["清理失败: sync-secret".to_string()],
            latest_compare_result: None,
        };

        let redacted = redact_execution_result(Ok(result), &[saved]).unwrap();

        assert_eq!(redacted.failed.unwrap().error, "DDL 失败: ••••••••");
        assert_eq!(redacted.cleanup_errors, vec!["清理失败: ••••••••"]);
    }

    #[tokio::test]
    async fn sqlite_round_trip_creates_adds_drops_and_returns_no_remaining_diff() {
        let (saved, request, source_path, target_path) = sqlite_sync_fixture();
        let preview = preview_database_sync_with_saved(&saved, &request)
            .await
            .expect("preview");
        assert!(preview.can_execute, "preview: {preview:#?}");
        assert!(preview.summary.destructive_operations >= 2);

        let result = execute_database_sync_with_saved(
            &saved,
            ExecuteDatabaseSyncRequest {
                request,
                plan_fingerprint: preview.plan_fingerprint,
            },
            None,
        )
        .await
        .expect("execute");

        assert_eq!(result.status, DatabaseSyncExecutionStatus::Succeeded);
        assert!(result.failed.is_none());
        assert!(result.cleanup_errors.is_empty());
        assert!(result
            .latest_compare_result
            .as_ref()
            .expect("latest compare")
            .tables
            .is_empty());
        assert_eq!(
            sqlite_column_names(&target_path, "users"),
            vec!["id", "name"]
        );
        assert!(sqlite_column_names(&target_path, "audit").contains(&"id".to_string()));
        assert_eq!(
            sqlite_column_names(&target_path, "obsolete_columns"),
            vec!["id"]
        );
        assert!(rusqlite::Connection::open(&target_path)
            .unwrap()
            .query_row(
                "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'old_table'",
                [],
                |_| Ok(()),
            )
            .is_err());
        remove_sqlite_fixture(source_path, target_path);
    }

    #[tokio::test]
    async fn successful_command_reports_validating_executing_and_refreshing_in_order() {
        let (saved, request, source_path, target_path) = sqlite_add_column_fixture();
        let preview = preview_database_sync_with_saved(&saved, &request)
            .await
            .expect("preview");
        let progress = Arc::new(Mutex::new(Vec::new()));
        let progress_for_load = progress.clone();
        let progress_for_sink = progress.clone();
        let target_path_for_sink = target_path.clone();
        let sink: DatabaseSyncProgressSink = Arc::new(move |event| {
            if event.phase == DatabaseSyncProgressPhase::Refreshing {
                assert_eq!(
                    sqlite_column_names(&target_path_for_sink, "users"),
                    vec!["id", "name"]
                );
            }
            progress_for_sink.lock().unwrap().push(event);
        });

        let result = execute_database_sync_command_with_loader(
            ExecuteDatabaseSyncRequest {
                request,
                plan_fingerprint: preview.plan_fingerprint.clone(),
            },
            || {
                assert_eq!(
                    progress_for_load
                        .lock()
                        .unwrap()
                        .iter()
                        .map(|event| event.phase)
                        .collect::<Vec<_>>(),
                    vec![DatabaseSyncProgressPhase::Validating]
                );
                Ok(saved)
            },
            sink,
        )
        .await
        .expect("execute");

        assert_eq!(result.status, DatabaseSyncExecutionStatus::Succeeded);
        assert!(result.latest_compare_result.is_some());
        assert_eq!(
            *progress.lock().unwrap(),
            vec![
                DatabaseSyncProgress {
                    plan_fingerprint: preview.plan_fingerprint.clone(),
                    phase: DatabaseSyncProgressPhase::Validating,
                    current: 0,
                    total: 0,
                },
                DatabaseSyncProgress {
                    plan_fingerprint: preview.plan_fingerprint.clone(),
                    phase: DatabaseSyncProgressPhase::Executing,
                    current: 0,
                    total: 1,
                },
                DatabaseSyncProgress {
                    plan_fingerprint: preview.plan_fingerprint.clone(),
                    phase: DatabaseSyncProgressPhase::Executing,
                    current: 1,
                    total: 1,
                },
                DatabaseSyncProgress {
                    plan_fingerprint: preview.plan_fingerprint,
                    phase: DatabaseSyncProgressPhase::Refreshing,
                    current: 1,
                    total: 1,
                },
            ]
        );
        remove_sqlite_fixture(source_path, target_path);
    }

    #[tokio::test]
    async fn sqlite_sync_preserves_exact_selected_table_name_with_spaces() {
        let (source_path, target_path) = sqlite_fixture_paths();
        rusqlite::Connection::open(&source_path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE users (id INTEGER PRIMARY KEY);\
                 CREATE TABLE \" users \" (id INTEGER PRIMARY KEY, exact_only TEXT);",
            )
            .unwrap();
        rusqlite::Connection::open(&target_path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE users (id INTEGER PRIMARY KEY);\
                 CREATE TABLE \" users \" (id INTEGER PRIMARY KEY);",
            )
            .unwrap();
        let saved = vec![
            sqlite_config("source", &source_path),
            sqlite_config("target", &target_path),
        ];
        let request = sqlite_request(vec![" users "], false);

        let preview = preview_database_sync_with_saved(&saved, &request)
            .await
            .expect("preview exact table");
        assert_eq!(preview.operations.len(), 1);
        assert_eq!(preview.operations[0].table_name, " users ");
        assert!(preview.operations[0]
            .sql
            .iter()
            .all(|sql| sql.contains("\" users \"") && !sql.contains(".\"users\"")));

        let result = execute_database_sync_with_saved(
            &saved,
            ExecuteDatabaseSyncRequest {
                request,
                plan_fingerprint: preview.plan_fingerprint,
            },
            None,
        )
        .await
        .expect("execute exact table");
        assert_eq!(result.status, DatabaseSyncExecutionStatus::Succeeded);
        assert_eq!(
            sqlite_column_names(&target_path, " users "),
            vec!["id", "exact_only"]
        );
        assert_eq!(sqlite_column_names(&target_path, "users"), vec!["id"]);
        remove_sqlite_fixture(source_path, target_path);
    }

    #[tokio::test]
    async fn sqlite_composite_primary_key_round_trip_keeps_native_ordinal_order() {
        let (source_path, target_path) = sqlite_fixture_paths();
        rusqlite::Connection::open(&source_path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE memberships (\
                   a INTEGER NOT NULL,\
                   b INTEGER NOT NULL,\
                   PRIMARY KEY (b, a)\
                 );",
            )
            .unwrap();
        rusqlite::Connection::open(&target_path).unwrap();
        let saved = vec![
            sqlite_config("source", &source_path),
            sqlite_config("target", &target_path),
        ];
        let request = sqlite_request(vec!["memberships"], false);

        let preview = preview_database_sync_with_saved(&saved, &request)
            .await
            .expect("preview composite primary key");
        assert_eq!(preview.operations.len(), 1);
        assert!(preview.operations[0].sql[0].contains("PRIMARY KEY (\"b\", \"a\")"));
        let result = execute_database_sync_with_saved(
            &saved,
            ExecuteDatabaseSyncRequest {
                request: request.clone(),
                plan_fingerprint: preview.plan_fingerprint,
            },
            None,
        )
        .await
        .expect("execute composite primary key");
        assert_eq!(result.status, DatabaseSyncExecutionStatus::Succeeded);
        assert!(result
            .latest_compare_result
            .as_ref()
            .expect("latest compare")
            .tables
            .is_empty());

        let target = rusqlite::Connection::open(&target_path).unwrap();
        let mut statement = target
            .prepare(
                "SELECT name FROM pragma_table_xinfo('memberships', 'main') \
                 WHERE pk > 0 ORDER BY pk",
            )
            .unwrap();
        let primary_keys = statement
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(primary_keys, vec!["b", "a"]);
        drop(statement);
        drop(target);
        assert_eq!(
            preview_database_sync_with_saved(&saved, &request)
                .await
                .unwrap_err(),
            "所选表 memberships 已不存在差异，请重新对比"
        );
        remove_sqlite_fixture(source_path, target_path);
    }

    #[tokio::test]
    async fn sqlite_primary_key_order_mismatch_blocks_append_preview() {
        let (source_path, target_path) = sqlite_fixture_paths();
        rusqlite::Connection::open(&source_path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE memberships (\
                   a INTEGER NOT NULL,\
                   b INTEGER NOT NULL,\
                   note TEXT,\
                   PRIMARY KEY (b, a)\
                 );",
            )
            .unwrap();
        rusqlite::Connection::open(&target_path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE memberships (\
                   a INTEGER NOT NULL,\
                   b INTEGER NOT NULL,\
                   PRIMARY KEY (a, b)\
                 );",
            )
            .unwrap();
        let saved = vec![
            sqlite_config("source", &source_path),
            sqlite_config("target", &target_path),
        ];

        let preview =
            preview_database_sync_with_saved(&saved, &sqlite_request(vec!["memberships"], false))
                .await
                .expect("preview primary key mismatch");

        assert!(!preview.can_execute);
        assert!(preview.operations.is_empty());
        assert_eq!(preview.blockers.len(), 1);
        assert!(preview.blockers[0].reason.contains("主键顺序"));
        remove_sqlite_fixture(source_path, target_path);
    }

    #[tokio::test]
    async fn sqlite_strict_mismatch_blocks_append_preview() {
        let (source_path, target_path) = sqlite_fixture_paths();
        rusqlite::Connection::open(&source_path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE strict_users (\
                   id INTEGER PRIMARY KEY,\
                   note TEXT\
                 ) STRICT;",
            )
            .unwrap();
        rusqlite::Connection::open(&target_path)
            .unwrap()
            .execute_batch("CREATE TABLE strict_users (id INTEGER PRIMARY KEY);")
            .unwrap();
        let saved = vec![
            sqlite_config("source", &source_path),
            sqlite_config("target", &target_path),
        ];

        let preview =
            preview_database_sync_with_saved(&saved, &sqlite_request(vec!["strict_users"], false))
                .await
                .expect("preview strict mismatch");

        assert!(!preview.can_execute);
        assert!(preview.operations.is_empty());
        assert_eq!(preview.blockers.len(), 1);
        assert!(preview.blockers[0].reason.contains("表后缀"));
        remove_sqlite_fixture(source_path, target_path);
    }

    #[tokio::test]
    async fn sqlite_without_rowid_mismatch_blocks_append_preview() {
        let (source_path, target_path) = sqlite_fixture_paths();
        rusqlite::Connection::open(&source_path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE compact_users (\
                   id TEXT NOT NULL PRIMARY KEY,\
                   note TEXT\
                 ) WITHOUT ROWID;",
            )
            .unwrap();
        rusqlite::Connection::open(&target_path)
            .unwrap()
            .execute_batch(
                "CREATE TABLE compact_users (\
                   id TEXT NOT NULL PRIMARY KEY\
                 );",
            )
            .unwrap();
        let saved = vec![
            sqlite_config("source", &source_path),
            sqlite_config("target", &target_path),
        ];

        let preview =
            preview_database_sync_with_saved(&saved, &sqlite_request(vec!["compact_users"], false))
                .await
                .expect("preview without rowid mismatch");

        assert!(!preview.can_execute);
        assert!(preview.operations.is_empty());
        assert_eq!(preview.blockers.len(), 1);
        assert!(preview.blockers[0].reason.contains("表后缀"));
        remove_sqlite_fixture(source_path, target_path);
    }

    #[tokio::test]
    async fn sqlite_drift_rejects_execution_before_any_planned_ddl() {
        let (saved, request, source_path, target_path) = sqlite_add_column_fixture();
        let preview = preview_database_sync_with_saved(&saved, &request)
            .await
            .expect("preview");
        rusqlite::Connection::open(&target_path)
            .unwrap()
            .execute_batch("ALTER TABLE users ADD COLUMN external_change TEXT")
            .unwrap();

        let error = execute_database_sync_with_saved(
            &saved,
            ExecuteDatabaseSyncRequest {
                request,
                plan_fingerprint: preview.plan_fingerprint,
            },
            None,
        )
        .await
        .unwrap_err();

        assert_eq!(error, "数据库结构已变化，请重新对比并预览同步计划");
        let columns = sqlite_column_names(&target_path, "users");
        assert!(columns.contains(&"external_change".to_string()));
        assert!(!columns.contains(&"name".to_string()));
        remove_sqlite_fixture(source_path, target_path);
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
    fn sync_request_preflight_preserves_exact_table_names_and_drop_guard() {
        let normalized = normalize_sync_request(&request(
            vec![" users ", "orders", "users", " users "],
            true,
        ))
        .unwrap();

        assert_eq!(
            normalized.selected_tables,
            vec![" users ", "orders", "users"]
        );
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

    fn fake_execution_result() -> crate::models::types::DatabaseSyncExecutionResult {
        crate::models::types::DatabaseSyncExecutionResult {
            status: DatabaseSyncExecutionStatus::PartiallySucceeded,
            completed_statements: vec![crate::models::types::DatabaseSyncStatementSuccess {
                operation_id: "op-0001".to_string(),
                statement_index: 0,
            }],
            failed: Some(crate::models::types::DatabaseSyncFailure {
                operation_id: "op-0002".to_string(),
                statement_index: 0,
                error: "DDL 失败".to_string(),
            }),
            pending_operation_ids: vec!["op-0002".to_string()],
            cleanup_errors: Vec::new(),
            latest_compare_result: None,
        }
    }

    async fn run_execution_lifecycle_case(
        source_open: Result<FakeTemporaryConnection, String>,
        target_open: Result<FakeTemporaryConnection, String>,
        operation: Result<crate::models::types::DatabaseSyncExecutionResult, String>,
    ) -> (
        Result<crate::models::types::DatabaseSyncExecutionResult, String>,
        Vec<&'static str>,
    ) {
        let outcomes = Arc::new(Mutex::new(HashMap::from([
            ("source".to_string(), source_open),
            ("target".to_string(), target_open),
        ])));
        let closed = Arc::new(Mutex::new(Vec::new()));
        let result = with_temporary_execution_connections(
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

    #[tokio::test]
    async fn execution_lifecycle_preserves_partial_result_and_appends_cleanup_errors() {
        let (result, closed) = run_execution_lifecycle_case(
            Ok(fake_connection("源端", Some("源关闭失败"))),
            Ok(fake_connection("目标端", Some("目标关闭失败"))),
            Ok(fake_execution_result()),
        )
        .await;

        assert_eq!(closed, vec!["源端", "目标端"]);
        let result = result.expect("部分执行结果不得因清理失败丢失");
        assert_eq!(
            result.status,
            DatabaseSyncExecutionStatus::PartiallySucceeded
        );
        assert_eq!(result.completed_statements.len(), 1);
        assert_eq!(
            result.cleanup_errors,
            vec!["源端: 源关闭失败", "目标端: 目标关闭失败"]
        );
    }

    #[tokio::test]
    async fn execution_lifecycle_closes_the_only_open_endpoint_on_peer_open_failure() {
        let (result, closed) = run_execution_lifecycle_case(
            Err("源建连失败".to_string()),
            Ok(fake_connection("目标端", None)),
            Ok(fake_execution_result()),
        )
        .await;

        assert_eq!(closed, vec!["目标端"]);
        assert_eq!(
            result.unwrap_err(),
            "源端连接「连接-source」建立临时连接失败: 源建连失败"
        );
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
