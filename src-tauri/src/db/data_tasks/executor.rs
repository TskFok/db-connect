//! 单任务目标事务编排；SQLite 只在 blocking 工作线程运行原生驱动。
use super::{
    adapters::{
        batch::{self, Dialect},
        sqlite::{self, Projection},
    },
    metadata::{self, DataMetadataSnapshot, ValidatedMapping},
    now_ms,
    plan::{self, Operation, StoredDataPlan},
    spool::{external_sort, ResourceBudget, SortedSpool, SpoolHandle, SpoolWriter},
    value::{CanonicalRow, DataValue},
    Cancellation, ProgressCallback, ProgressUpdate,
};
use crate::{
    db::sql_utils::sqlite_id,
    models::{
        data_tasks::*,
        types::{redact_connection_secrets, ConnectionConfig, DatabaseType},
    },
};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};

pub fn configuration_fingerprint(config: &ConnectionConfig) -> String {
    let mut sanitized = config.clone();
    redact_connection_secrets(&mut sanitized);
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&sanitized).unwrap_or_default())
    )
}
fn error(message: String) -> DataTaskError {
    let (code, body) = message
        .split_once(": ")
        .unwrap_or(("database_error", &message));
    let allowed = [
        "plan_stale",
        "cancelled",
        "invalid_mapping",
        "unsupported_capability",
        "resource_limit",
        "read_only_target",
        "same_physical_target",
        "validation_failed",
        "constraint_conflict",
        "plan_expired",
        "lock_timeout",
        "outcome_unknown",
    ];
    DataTaskError::new(
        if allowed.contains(&code) {
            code
        } else {
            "database_error"
        },
        body,
    )
}
fn checked(cancel: &Cancellation) -> Result<(), String> {
    if cancel.load(Ordering::Acquire) {
        Err("cancelled: 数据任务已取消".into())
    } else {
        Ok(())
    }
}
struct Progress {
    callback: ProgressCallback,
    last: Instant,
    status: DataTaskStatus,
    read: u64,
    written: u64,
    verified: u64,
    bytes: u64,
}
impl Progress {
    fn new(callback: ProgressCallback) -> Self {
        Self {
            callback,
            last: Instant::now() - Duration::from_secs(1),
            status: DataTaskStatus::Created,
            read: 0,
            written: 0,
            verified: 0,
            bytes: 0,
        }
    }
    fn emit(&mut self, status: DataTaskStatus, force: bool) {
        if force || status != self.status || self.last.elapsed() >= Duration::from_millis(200) {
            self.status = status;
            self.last = Instant::now();
            let value = ProgressUpdate {
                status,
                read_rows: self.read,
                written_rows: self.written,
                verified_rows: self.verified,
                bytes: self.bytes,
            };
            let _ =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.callback)(value)));
        }
    }
}
fn paths(
    request: &DataTaskRequest,
    source: &ConnectionConfig,
    target: &ConnectionConfig,
) -> Result<(PathBuf, PathBuf), String> {
    if source.database_type != DatabaseType::Sqlite || target.database_type != DatabaseType::Sqlite
    {
        return Err("unsupported_capability: 此有向数据库组合尚未通过完整数据任务验收".into());
    }
    if request.source.database != "main" || request.target.database != "main" {
        return Err("unsupported_capability: SQLite 数据任务仅支持 main 数据库".into());
    }
    if target.read_only.unwrap_or(false) {
        return Err("read_only_target: 目标连接为只读".into());
    }
    let source_path = source
        .sqlite_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or("invalid_mapping: 缺少 SQLite 源文件")?;
    let target_path = target
        .sqlite_path
        .as_ref()
        .map(PathBuf::from)
        .ok_or("invalid_mapping: 缺少 SQLite 目标文件")?;
    if std::fs::metadata(&target_path)
        .map_err(|_| "invalid_mapping: 无法读取目标文件")?
        .permissions()
        .readonly()
    {
        return Err("read_only_target: 目标文件为只读".into());
    }
    metadata::resolve_endpoints(
        request,
        metadata::EndpointIdentity {
            database_type: DatabaseType::Sqlite,
            instance: None,
            database: "main".into(),
            sqlite_path: Some(source_path.clone()),
        },
        metadata::EndpointIdentity {
            database_type: DatabaseType::Sqlite,
            instance: None,
            database: "main".into(),
            sqlite_path: Some(target_path.clone()),
        },
    )?;
    Ok((source_path, target_path))
}
fn load_metadata(
    conn: &rusqlite::Connection,
    config: &ConnectionConfig,
) -> Result<DataMetadataSnapshot, String> {
    let loaded = sqlite::load_metadata(conn)?;
    Ok(DataMetadataSnapshot {
        database_type: DatabaseType::Sqlite,
        tables: loaded.tables,
        read_only: config.read_only.unwrap_or(false),
        permissions_verified: true,
        consistent_snapshot: true,
        protected_write: true,
        schema_fingerprint: loaded.signature,
        configuration_fingerprint: configuration_fingerprint(config),
    })
}
fn projections(mapping: &ValidatedMapping, source: bool) -> Vec<Projection> {
    mapping
        .tables
        .iter()
        .map(|m| Projection {
            table: if source {
                m.source_table.clone()
            } else {
                m.target_table.clone()
            },
            output_table: m.target_table.clone(),
            columns: if source {
                m.source_columns.clone()
            } else {
                m.target_columns.clone()
            },
            key_indices: m.key_indices.clone(),
        })
        .collect()
}
fn full_projections(
    mapping: &ValidatedMapping,
    metadata: &DataMetadataSnapshot,
) -> Result<Vec<Projection>, String> {
    mapping
        .tables
        .iter()
        .map(|m| {
            let table = metadata
                .tables
                .iter()
                .find(|t| t.name == m.target_table)
                .ok_or("plan_stale: 目标物理表已不存在")?;
            Ok(Projection {
                table: table.name.clone(),
                output_table: table.name.clone(),
                columns: table.columns.iter().map(|c| c.name.clone()).collect(),
                key_indices: vec![],
            })
        })
        .collect()
}
fn projected_row(
    row: &CanonicalRow,
    full: &Projection,
    projected: &Projection,
) -> Result<CanonicalRow, String> {
    let values = projected
        .columns
        .iter()
        .map(|name| {
            full.columns
                .iter()
                .position(|c| c == name)
                .and_then(|index| row.values.get(index).cloned())
                .ok_or_else(|| "plan_stale: 目标映射字段已不存在".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let key = projected
        .key_indices
        .iter()
        .map(|i| values[*i].clone())
        .collect();
    CanonicalRow::new(projected.output_table.clone(), key, values)
}
/// 每行一个有认证的加密块，既不缓存整表，也不使用无界队列。
fn snapshot(
    conn: &rusqlite::Connection,
    projections: &[Projection],
    mut writer: SpoolWriter,
    cancel: &Cancellation,
    progress: &mut Progress,
) -> Result<SpoolHandle, String> {
    sqlite::stream_rows(conn, projections, cancel, |row| {
        checked(cancel)?;
        progress.read += 1;
        progress.bytes = progress.bytes.saturating_add(row.encoded_size() as u64);
        writer.push_batch(std::slice::from_ref(&row))?;
        progress.emit(DataTaskStatus::Reading, false);
        Ok(())
    })?;
    writer.finish()
}
pub async fn prepare_task(
    task_id: String,
    request: DataTaskRequest,
    source_config: ConnectionConfig,
    target_config: ConnectionConfig,
    directory: PathBuf,
    cancel: Cancellation,
    progress: ProgressCallback,
) -> Result<StoredDataPlan, DataTaskError> {
    if source_config.database_type != DatabaseType::Sqlite
        || target_config.database_type != DatabaseType::Sqlite
    {
        return prepare_network(
            task_id,
            request,
            source_config,
            target_config,
            directory,
            cancel,
            progress,
        )
        .await
        .map_err(error);
    }
    tokio::task::spawn_blocking(move || {
        prepare_sqlite(
            &task_id,
            request,
            &source_config,
            &target_config,
            &directory,
            cancel,
            progress,
        )
        .map_err(error)
    })
    .await
    .map_err(|_| DataTaskError::new("database_error", "数据任务工作线程中断"))?
}
fn prepare_sqlite(
    task_id: &str,
    request: DataTaskRequest,
    source_config: &ConnectionConfig,
    target_config: &ConnectionConfig,
    directory: &Path,
    cancel: Cancellation,
    callback: ProgressCallback,
) -> Result<StoredDataPlan, String> {
    request
        .validate()
        .map_err(|e| format!("{}: {}", e.code, e.message))?;
    checked(&cancel)?;
    let mut progress = Progress::new(callback);
    progress.emit(DataTaskStatus::Validating, true);
    let (source_path, target_path) = paths(&request, source_config, target_config)?;
    let source = sqlite::open(&source_path, false, cancel.clone())?;
    let target = sqlite::open(&target_path, true, cancel.clone())?;
    source
        .execute_batch("BEGIN DEFERRED")
        .map_err(|_| "无法建立 SQLite 源一致读取事务")?;
    target
        .execute_batch("BEGIN DEFERRED")
        .map_err(|_| "无法建立 SQLite 目标一致读取事务")?;
    let source_metadata = load_metadata(&source, source_config)?;
    let target_metadata = load_metadata(&target, target_config)?;
    let mapping = metadata::validate_mapping(&request, &source_metadata, &target_metadata)?;
    let budget = ResourceBudget::with_cancellation(cancel.clone());
    let source_rows = snapshot(
        &source,
        &projections(&mapping, true),
        SpoolWriter::new(directory, budget.clone())?,
        &cancel,
        &mut progress,
    )?;
    let full = full_projections(&mapping, &target_metadata)?;
    let projected = projections(&mapping, false);
    let mut target_writer = SpoolWriter::new(directory, budget.clone())?;
    let mut full_writer = SpoolWriter::new(directory, budget)?;
    sqlite::stream_rows(&target, &full, &cancel, |row| {
        checked(&cancel)?;
        let index = full
            .iter()
            .position(|p| p.output_table == row.table)
            .ok_or("目标快照表不存在")?;
        let projection = projected_row(&row, &full[index], &projected[index])?;
        target_writer.push_batch(&[projection])?;
        progress.bytes = progress.bytes.saturating_add(row.encoded_size() as u64);
        full_writer.push_batch(&[row])?;
        progress.read += 1;
        progress.emit(DataTaskStatus::Reading, false);
        Ok(())
    })?;
    let target_rows = target_writer.finish()?;
    let target_full = full_writer.finish()?;
    source
        .execute_batch("ROLLBACK")
        .map_err(|_| "无法释放 SQLite 源读取事务")?;
    target
        .execute_batch("ROLLBACK")
        .map_err(|_| "无法释放 SQLite 目标读取事务")?;
    checked(&cancel)?;
    progress.emit(DataTaskStatus::Comparing, true);
    let plan = plan::build_plan(
        task_id,
        request,
        mapping,
        source_metadata,
        target_metadata,
        source_rows,
        target_rows,
        target_full,
    )?;
    checked(&cancel)?;
    progress.emit(DataTaskStatus::Ready, true);
    Ok(plan)
}
fn equal_sorted(
    left: &SortedSpool,
    right: &SortedSpool,
    cancel: &Cancellation,
) -> Result<bool, String> {
    if left.digest != right.digest || left.spool.row_count() != right.spool.row_count() {
        return Ok(false);
    }
    let mut a = left.spool.cursor()?;
    let mut b = right.spool.cursor()?;
    loop {
        checked(cancel)?;
        match (a.next_row()?, b.next_row()?) {
            (None, None) => return Ok(true),
            (Some(a), Some(b)) if a.canonical_bytes()? == b.canonical_bytes()? => {}
            _ => return Ok(false),
        }
    }
}
fn flush(
    conn: &rusqlite::Connection,
    mapping: &metadata::ValidatedTableMapping,
    kind: DataDiffOperation,
    rows: &mut Vec<Vec<DataValue>>,
    cancel: &Cancellation,
    progress: &mut Progress,
    budget: &ResourceBudget,
) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    checked(cancel)?;
    // CASE 更新会重复绑定定位键；必须在 build_batch 克隆参数之前计算展开开销。
    let expanded = rows
        .iter()
        .map(|row| parameter_memory(row, mapping, kind))
        .try_fold(0usize, |total, n| {
            total
                .checked_add(n)
                .ok_or("resource_limit: SQLite 参数内存预算溢出")
        })?;
    let binding_bytes = expanded
        .checked_mul(2)
        .and_then(|n| n.checked_add(1024 * 1024))
        .ok_or("resource_limit: SQLite 参数内存预算溢出")?;
    let _binding_memory = budget.reserve_memory(binding_bytes)?;
    let batch = batch::build_batch(
        Dialect::Sqlite,
        "main",
        &mapping.target_table,
        &mapping.target_columns,
        &mapping.key_indices,
        kind,
        rows,
    )?;
    let values = batch
        .params
        .iter()
        .map(sqlite::bind_value)
        .collect::<Result<Vec<_>, _>>()?;
    let affected = conn
        .execute(&batch.sql, rusqlite::params_from_iter(values))
        .map_err(|_| "批量写入失败：目标约束、值类型或权限不允许本次操作")?;
    if affected != rows.len() {
        return Err("validation_failed: 批量写入影响行数与计划不一致".into());
    }
    progress.written += rows.len() as u64;
    rows.clear();
    progress.emit(DataTaskStatus::Executing, false);
    checked(cancel)
}
fn write_kind(
    conn: &rusqlite::Connection,
    plan: &StoredDataPlan,
    kind: DataDiffOperation,
    cancel: &Cancellation,
    progress: &mut Progress,
) -> Result<(), String> {
    let order = if kind == DataDiffOperation::Delete {
        &plan.mapping.delete_order
    } else {
        &plan.mapping.insert_order
    };
    let budget = plan.operations.budget();
    for table in order {
        checked(cancel)?;
        let mapping = plan
            .mapping
            .tables
            .iter()
            .find(|m| &m.target_table == table)
            .ok_or("计划表不存在")?;
        let parameter_count = batch::parameters_per_row(
            mapping.target_columns.len(),
            mapping.key_indices.len(),
            kind,
        );
        if parameter_count == 0 {
            continue;
        }
        let row_limit = 500.min(Dialect::Sqlite.parameter_limit() / parameter_count);
        if row_limit == 0 {
            return Err("resource_limit: 单行超过 SQLite 参数预算".into());
        }
        let mut cursor = plan.operations.cursor()?;
        let mut rows = Vec::new();
        let mut leases = Vec::new();
        let mut bytes = 0usize;
        while let Some(row) = cursor.next_row()? {
            checked(cancel)?;
            if &row.table != table {
                continue;
            }
            let operation = Operation::from_row(&row)?;
            if operation.kind != kind {
                continue;
            }
            let data = if kind == DataDiffOperation::Delete {
                operation.old
            } else {
                operation.new
            }
            .ok_or("计划操作缺少类型化数据")?;
            let size = parameter_memory(&data.values, mapping, kind);
            if size.saturating_mul(2) > budget.memory_bytes / 2 {
                return Err("resource_limit: 单行展开参数超过 SQLite 共享内存预算".into());
            }
            if !rows.is_empty()
                && (rows.len() >= row_limit || bytes.saturating_add(size) > 4 * 1024 * 1024)
            {
                flush(conn, mapping, kind, &mut rows, cancel, progress, &budget)?;
                leases.clear();
                bytes = 0;
            }
            leases.push(budget.reserve_memory(data.memory_size())?);
            bytes += size;
            rows.push(data.values);
        }
        flush(conn, mapping, kind, &mut rows, cancel, progress, &budget)?;
    }
    Ok(())
}
fn execute_transaction(
    conn: &rusqlite::Connection,
    plan: &StoredDataPlan,
    target_config: &ConnectionConfig,
    cancel: &Cancellation,
    progress: &mut Progress,
) -> Result<(), String> {
    checked(cancel)?;
    let current = load_metadata(conn, target_config)?;
    if current.schema_fingerprint != plan.target_metadata.schema_fingerprint {
        return Err("plan_stale: 目标结构已变化，请重新预览".into());
    }
    metadata::validate_mapping(&plan.request, &plan.source_metadata, &current)?;
    let full = full_projections(&plan.mapping, &current)?;
    let reread = snapshot(
        conn,
        &full,
        plan.target_full.spool.writer()?,
        cancel,
        progress,
    )?;
    let reread = external_sort(&reread)?;
    if !equal_sorted(&reread, &plan.target_full, cancel)? {
        return Err("plan_stale: 目标内容已变化，请重新预览".into());
    }
    drop(reread);
    progress.emit(DataTaskStatus::Executing, true);
    if plan.request.mode == DataTaskMode::Replace {
        for table in &plan.mapping.delete_order {
            checked(cancel)?;
            let count = conn
                .execute(&format!("DELETE FROM main.{}", sqlite_id(table)), [])
                .map_err(|_| "删除目标原有行失败")?;
            progress.written += count as u64;
        }
    } else {
        write_kind(conn, plan, DataDiffOperation::Delete, cancel, progress)?;
    }
    write_kind(conn, plan, DataDiffOperation::Update, cancel, progress)?;
    write_kind(conn, plan, DataDiffOperation::Insert, cancel, progress)?;
    // 阶段变化必发，使取消请求能在最后一批后、COMMIT 前被观察。
    progress.emit(DataTaskStatus::Verifying, true);
    checked(cancel)?;
    let projected = projections(&plan.mapping, false);
    let final_rows = snapshot(
        conn,
        &projected,
        plan.expected.spool.writer()?,
        cancel,
        progress,
    )?;
    progress.verified = final_rows.row_count();
    let final_rows = external_sort(&final_rows)?;
    if !equal_sorted(&final_rows, &plan.expected, cancel)? {
        return Err("validation_failed: 事务内最终集合校验不一致，已拒绝提交".into());
    }
    checked(cancel)?;
    Ok(())
}
pub async fn execute_plan(
    plan: Arc<StoredDataPlan>,
    source_config: ConnectionConfig,
    target_config: ConnectionConfig,
    cancel: Cancellation,
    progress: ProgressCallback,
) -> DataTaskResult {
    if source_config.database_type != DatabaseType::Sqlite
        || target_config.database_type != DatabaseType::Sqlite
    {
        return execute_network(plan, source_config, target_config, cancel, progress).await;
    }
    let tables = plan.preview.tables.clone();
    match tokio::task::spawn_blocking(move || {
        execute_sqlite(&plan, &source_config, &target_config, cancel, progress)
    })
    .await
    {
        Ok(result) => result,
        Err(_) => DataTaskResult {
            status: DataTaskStatus::OutcomeUnknown,
            commit_state: DataCommitState::Unknown,
            tables,
            error: Some(DataTaskError::new(
                "outcome_unknown",
                "数据任务工作线程中断，需要核对目标状态",
            )),
            cleanup_errors: vec![],
            requires_target_refresh: true,
        },
    }
}
fn execute_sqlite(
    plan: &StoredDataPlan,
    source_config: &ConnectionConfig,
    target_config: &ConnectionConfig,
    cancel: Cancellation,
    callback: ProgressCallback,
) -> DataTaskResult {
    let mut progress = Progress::new(callback);
    let mut result = DataTaskResult {
        status: DataTaskStatus::Failed,
        commit_state: DataCommitState::None,
        tables: plan.preview.tables.clone(),
        error: None,
        cleanup_errors: vec![],
        requires_target_refresh: false,
    };
    let preflight = (|| -> Result<rusqlite::Connection, String> {
        checked(&cancel)?;
        if plan
            .preview
            .expires_at
            .parse::<u64>()
            .ok()
            .filter(|expiry| *expiry > now_ms())
            .is_none()
        {
            return Err("plan_expired: 预览已过期，请重新预览".into());
        }
        if configuration_fingerprint(source_config)
            != plan.source_metadata.configuration_fingerprint
            || configuration_fingerprint(target_config)
                != plan.target_metadata.configuration_fingerprint
        {
            return Err("plan_stale: 已保存连接配置发生变化".into());
        }
        let (source_path, target_path) = paths(&plan.request, source_config, target_config)?;
        let source = sqlite::open(&source_path, false, cancel.clone())?;
        if load_metadata(&source, source_config)?.schema_fingerprint
            != plan.source_metadata.schema_fingerprint
        {
            return Err("plan_stale: 源结构已变化，请重新预览".into());
        }
        sqlite::open(&target_path, true, cancel.clone())
    })();
    let conn = match preflight {
        Ok(conn) => conn,
        Err(message) => {
            let e = error(message);
            result.status = if e.code == "cancelled" {
                DataTaskStatus::Cancelled
            } else {
                DataTaskStatus::Failed
            };
            result.error = Some(e);
            return result;
        }
    };
    if conn.execute_batch("BEGIN IMMEDIATE").is_err() {
        result.error = Some(DataTaskError::new(
            if cancel.load(Ordering::Acquire) {
                "cancelled"
            } else {
                "lock_timeout"
            },
            "无法在 10 秒内锁定目标数据库",
        ));
        result.status = if cancel.load(Ordering::Acquire) {
            DataTaskStatus::Cancelled
        } else {
            DataTaskStatus::Failed
        };
        return result;
    }
    if let Err(message) = execute_transaction(&conn, plan, target_config, &cancel, &mut progress) {
        // 取消后 SQLite progress handler 不能阻止回滚本身。
        let _ = conn.progress_handler(0, None::<fn() -> bool>);
        let e = if cancel.load(Ordering::Acquire) {
            DataTaskError::new("cancelled", "数据任务已取消，目标事务正在回滚")
        } else {
            error(message)
        };
        if conn.execute_batch("ROLLBACK").is_ok() {
            result.commit_state = DataCommitState::RolledBack;
            result.status = if e.code == "cancelled" {
                DataTaskStatus::Cancelled
            } else {
                DataTaskStatus::Failed
            };
        } else {
            result.commit_state = DataCommitState::Unknown;
            result.status = DataTaskStatus::OutcomeUnknown;
            result.requires_target_refresh = true;
            result
                .cleanup_errors
                .push("目标事务回滚未得到确认，需要核对目标状态".into());
        }
        result.error = Some(e);
        return result;
    }
    progress.emit(DataTaskStatus::Committing, true);
    if cancel.load(Ordering::Acquire) {
        let _ = conn.progress_handler(0, None::<fn() -> bool>);
        if conn.execute_batch("ROLLBACK").is_ok() {
            result.status = DataTaskStatus::Cancelled;
            result.commit_state = DataCommitState::RolledBack;
            result.error = Some(DataTaskError::new(
                "cancelled",
                "数据任务已取消，目标事务已回滚",
            ));
        } else {
            result.status = DataTaskStatus::OutcomeUnknown;
            result.commit_state = DataCommitState::Unknown;
            result.requires_target_refresh = true;
        }
        return result;
    }
    match conn.execute_batch("COMMIT") {
        Ok(()) => {
            result.status = DataTaskStatus::Succeeded;
            result.commit_state = DataCommitState::Committed;
            result.requires_target_refresh = true;
            for table in &mut result.tables {
                let inserts = table.counts.inserted.parse::<u64>().unwrap_or(0);
                let updates = table.counts.updated.parse::<u64>().unwrap_or(0);
                let deletes = table.counts.deleted.parse::<u64>().unwrap_or(0);
                table.counts.written = (inserts + updates + deletes).to_string();
            }
            progress.emit(DataTaskStatus::Succeeded, true);
        }
        Err(_) => {
            let _ = conn.progress_handler(0, None::<fn() -> bool>);
            if !conn.is_autocommit() && conn.execute_batch("ROLLBACK").is_ok() {
                result.commit_state = DataCommitState::RolledBack;
                result.error = Some(DataTaskError::new(
                    "database_error",
                    "提交失败，目标事务已回滚",
                ));
            } else {
                result.status = DataTaskStatus::OutcomeUnknown;
                result.commit_state = DataCommitState::Unknown;
                result.requires_target_refresh = true;
                result.error = Some(DataTaskError::new(
                    "outcome_unknown",
                    "提交结果无法确认，请核对目标；不会自动重放",
                ));
            }
        }
    }
    result
}

/// 只用于任务独占会话；不登记到普通编辑器连接池。
pub async fn open_session(
    config: ConnectionConfig,
    endpoint: DataEndpoint,
    cancel: Cancellation,
) -> Result<Box<dyn super::adapters::DataSession>, String> {
    match config.database_type {
        DatabaseType::Sqlite => {
            super::adapters::sqlite_async::SqliteAsyncSession::open(config, endpoint, cancel).await
        }
        DatabaseType::Postgres => super::adapters::postgres::open(config, endpoint, cancel).await,
        DatabaseType::MySql => super::adapters::mysql::open(config, endpoint, cancel).await,
        DatabaseType::SqlServer => super::adapters::sqlserver::open(config, endpoint, cancel).await,
        DatabaseType::ClickHouse => {
            super::adapters::clickhouse::open(config, endpoint, cancel).await
        }
    }
}
pub async fn inspect_endpoints(
    source_config: ConnectionConfig,
    source_endpoint: DataEndpoint,
    target_config: ConnectionConfig,
    target_endpoint: DataEndpoint,
    cancel: Cancellation,
) -> Result<(DataMetadataSnapshot, DataMetadataSnapshot), DataTaskError> {
    let mut source = open_session(source_config, source_endpoint, cancel.clone())
        .await
        .map_err(error)?;
    let mut target = open_session(target_config, target_endpoint, cancel.clone())
        .await
        .map_err(error)?;
    source.begin_read().await.map_err(error)?;
    target.begin_read().await.map_err(error)?;
    let s = source.load_metadata().await.map_err(error)?;
    let t = target.load_metadata().await.map_err(error)?;
    source.rollback().await.map_err(error)?;
    target.rollback().await.map_err(error)?;
    Ok((s, t))
}
struct SnapshotOutput {
    full: SpoolHandle,
    projected: Option<SpoolHandle>,
}
struct SnapshotInput {
    full: Vec<Projection>,
    projected: Option<Vec<Projection>>,
    directory: PathBuf,
    seed: Option<SpoolHandle>,
    budget: ResourceBudget,
    cancel: Cancellation,
    status: DataTaskStatus,
    conversion: Option<(DataMetadataSnapshot, DataMetadataSnapshot, ValidatedMapping)>,
}
async fn network_snapshot(
    session: &mut dyn super::adapters::DataSession,
    input: SnapshotInput,
    progress: &mut Progress,
) -> Result<SnapshotOutput, String> {
    let SnapshotInput {
        full,
        projected,
        directory,
        seed,
        budget,
        cancel,
        status,
        conversion,
    } = input;
    let (sender, mut receiver) = super::adapters::RowSender::channel(budget.clone());
    let worker_full = full.clone();
    let worker_cancel = cancel.clone();
    let callback = progress.callback.clone();
    let base_read = progress.read;
    let base_written = progress.written;
    let base_verified = progress.verified;
    let base_bytes = progress.bytes;
    let worker = tokio::task::spawn_blocking(move || -> Result<SnapshotOutput, String> {
        let mut writer = match seed {
            Some(ref seed) => seed.writer()?,
            None => SpoolWriter::new(&directory, budget.clone())?,
        };
        let mut projected_writer = if projected.is_some() {
            Some(match seed {
                Some(ref seed) => seed.writer()?,
                None => SpoolWriter::new(&directory, budget.clone())?,
            })
        } else {
            None
        };
        let mut progress = Progress::new(callback);
        progress.read = base_read;
        progress.written = base_written;
        progress.verified = base_verified;
        progress.bytes = base_bytes;
        while let Some(envelope) = receiver.blocking_recv() {
            checked(&worker_cancel)?;
            let row = if let Some((source, target, mapping)) = &conversion {
                super::type_mapping::normalize_transfer_row(envelope.row, source, target, mapping)?
            } else {
                envelope.row
            };
            if let (Some(projections), Some(writer)) = (&projected, &mut projected_writer) {
                let index = worker_full
                    .iter()
                    .position(|p| p.output_table == row.table)
                    .ok_or("集合快照表索引无效")?;
                let row = projected_row(&row, &worker_full[index], &projections[index])?;
                let _memory = budget.reserve_memory(row.memory_size())?;
                writer.push_batch(&[row])?;
            }
            writer.push_batch(std::slice::from_ref(&row))?;
            progress.read += 1;
            progress.bytes = progress.bytes.saturating_add(row.encoded_size() as u64);
            progress.emit(status, false);
        }
        Ok(SnapshotOutput {
            full: writer.finish()?,
            projected: projected_writer.map(SpoolWriter::finish).transpose()?,
        })
    });
    let read_result = session.stream_rows(full, cancel.clone(), sender).await;
    let output = worker.await.map_err(|_| "数据快照写入线程中断")?;
    // 转换/落盘失败会关闭接收端，随后读取端只看到通道关闭。
    // 优先保留消费端的根因；读取端独立失败时，仍拒绝不完整快照。
    let output = output?;
    let count = read_result?;
    progress.read += count;
    progress.bytes = progress.bytes.saturating_add(output.full.byte_count());
    checked(&cancel)?;
    Ok(output)
}
fn resolve_network_identity(
    request: &DataTaskRequest,
    source: &dyn super::adapters::DataSession,
    target: &dyn super::adapters::DataSession,
) -> Result<(), String> {
    let source = source
        .endpoint_identity()
        .ok_or("same_physical_target: 无法验证源端真实实例身份")?;
    let target = target
        .endpoint_identity()
        .ok_or("same_physical_target: 无法验证目标端真实实例身份")?;
    metadata::resolve_endpoints(request, source, target)?;
    Ok(())
}
async fn prepare_network(
    task_id: String,
    request: DataTaskRequest,
    source_config: ConnectionConfig,
    target_config: ConnectionConfig,
    directory: PathBuf,
    cancel: Cancellation,
    callback: ProgressCallback,
) -> Result<StoredDataPlan, String> {
    request
        .validate()
        .map_err(|e| format!("{}: {}", e.code, e.message))?;
    checked(&cancel)?;
    if source_config.database_type != target_config.database_type
        && request.kind == DataTaskKind::RowSync
    {
        return Err("unsupported_capability: 跨类型不支持行同步".into());
    }
    if target_config.read_only.unwrap_or(false) {
        return Err("read_only_target: 目标保存连接为只读".into());
    }
    let mut progress = Progress::new(callback);
    progress.emit(DataTaskStatus::Validating, true);
    let mut source = open_session(source_config, request.source.clone(), cancel.clone()).await?;
    let mut target = open_session(target_config, request.target.clone(), cancel.clone()).await?;
    source.begin_read().await?;
    target.begin_read().await?;
    let source_metadata = source.load_metadata().await?;
    let target_metadata = target.load_metadata().await?;
    resolve_network_identity(&request, source.as_ref(), target.as_ref())?;
    let mapping = metadata::validate_mapping(&request, &source_metadata, &target_metadata)?;
    let budget = ResourceBudget::with_cancellation(cancel.clone());
    let conversion = (source_metadata.database_type != target_metadata.database_type).then(|| {
        (
            source_metadata.clone(),
            target_metadata.clone(),
            mapping.clone(),
        )
    });
    let source_output = network_snapshot(
        source.as_mut(),
        SnapshotInput {
            full: projections(&mapping, true),
            projected: None,
            directory: directory.clone(),
            seed: None,
            budget: budget.clone(),
            cancel: cancel.clone(),
            status: DataTaskStatus::Reading,
            conversion,
        },
        &mut progress,
    )
    .await?;
    let target_output = network_snapshot(
        target.as_mut(),
        SnapshotInput {
            full: full_projections(&mapping, &target_metadata)?,
            projected: Some(projections(&mapping, false)),
            directory,
            seed: None,
            budget,
            cancel: cancel.clone(),
            status: DataTaskStatus::Reading,
            conversion: None,
        },
        &mut progress,
    )
    .await?;
    source.rollback().await?;
    target.rollback().await?;
    checked(&cancel)?;
    progress.emit(DataTaskStatus::Comparing, true);
    let plan = tokio::task::spawn_blocking(move || {
        plan::build_plan(
            &task_id,
            request,
            mapping,
            source_metadata,
            target_metadata,
            source_output.full,
            target_output.projected.ok_or("目标映射快照缺失")?,
            target_output.full,
        )
    })
    .await
    .map_err(|_| "计划排序工作线程中断")??;
    checked(&cancel)?;
    progress.emit(DataTaskStatus::Ready, true);
    Ok(plan)
}
fn value_memory(v: &DataValue) -> usize {
    std::mem::size_of::<DataValue>().saturating_add(v.encoded_size())
}
fn parameter_memory(
    row: &[DataValue],
    mapping: &metadata::ValidatedTableMapping,
    kind: DataDiffOperation,
) -> usize {
    let keys = mapping
        .key_indices
        .iter()
        .map(|i| value_memory(&row[*i]))
        .sum::<usize>();
    match kind {
        DataDiffOperation::Insert => row.iter().map(value_memory).sum(),
        DataDiffOperation::Delete => keys,
        DataDiffOperation::Update => row
            .iter()
            .enumerate()
            .filter(|(i, _)| !mapping.key_indices.contains(i))
            .map(|(_, v)| keys.saturating_add(value_memory(v)))
            .sum::<usize>()
            .saturating_add(keys),
        _ => 0,
    }
}
struct PreparedBatch {
    batch: batch::WriteBatch,
    rows: u64,
    _memory: super::spool::MemoryLease,
}
struct BatchReader {
    plan: Arc<StoredDataPlan>,
    kind: DataDiffOperation,
    table_index: usize,
    cursor: Option<super::spool::SpoolCursor>,
    pending: Option<(CanonicalRow, super::spool::MemoryLease)>,
}
impl BatchReader {
    fn next_batch(
        &mut self,
        dialect: Dialect,
        schema: &str,
        cancel: &Cancellation,
    ) -> Result<Option<PreparedBatch>, String> {
        loop {
            let order = if self.kind == DataDiffOperation::Delete {
                &self.plan.mapping.delete_order
            } else {
                &self.plan.mapping.insert_order
            };
            let Some(table) = order.get(self.table_index) else {
                return Ok(None);
            };
            let mapping = self
                .plan
                .mapping
                .tables
                .iter()
                .find(|m| &m.target_table == table)
                .ok_or("差异表不存在")?;
            let parameters = batch::parameters_per_row(
                mapping.target_columns.len(),
                mapping.key_indices.len(),
                self.kind,
            );
            if parameters == 0 {
                self.table_index += 1;
                continue;
            }
            let limit = 500.min(dialect.parameter_limit() / parameters);
            if limit == 0 {
                return Err("resource_limit: 单行参数超过目标数据库预算".into());
            }
            if self.cursor.is_none() {
                self.cursor = Some(self.plan.operations.cursor()?);
            }
            let budget = self.plan.operations.budget();
            let mut rows = Vec::new();
            let mut leases = Vec::new();
            let mut parameter_bytes = 0usize;
            loop {
                checked(cancel)?;
                let (data, pending_memory) = if let Some((row, lease)) = self.pending.take() {
                    (Some(row), Some(lease))
                } else {
                    (
                        loop {
                            let Some(row) = self.cursor.as_mut().unwrap().next_row()? else {
                                break None;
                            };
                            if &row.table != table {
                                continue;
                            }
                            let op = Operation::from_row(&row)?;
                            if op.kind != self.kind {
                                continue;
                            }
                            break if self.kind == DataDiffOperation::Delete {
                                op.old
                            } else {
                                op.new
                            };
                        },
                        None,
                    )
                };
                let Some(data) = data else { break };
                let size = parameter_memory(&data.values, mapping, self.kind);
                if !rows.is_empty()
                    && (rows.len() >= limit
                        || parameter_bytes.saturating_add(size) > 4 * 1024 * 1024)
                {
                    let memory = match pending_memory {
                        Some(m) => m,
                        None => budget.reserve_memory(data.memory_size())?,
                    };
                    self.pending = Some((data, memory));
                    break;
                }
                let encoded_multiplier = if dialect == Dialect::ClickHouse { 8 } else { 2 };
                if size.saturating_mul(encoded_multiplier) > budget.memory_bytes / 2 {
                    return Err("resource_limit: 单行绑定参数超过共享内存预算".into());
                }
                leases.push(match pending_memory {
                    Some(m) => m,
                    None => budget.reserve_memory(data.memory_size())?,
                });
                parameter_bytes += size;
                rows.push(data.values);
            }
            if rows.is_empty() {
                self.cursor = None;
                self.table_index += 1;
                continue;
            }
            let encoded_multiplier = if dialect == Dialect::ClickHouse { 8 } else { 2 };
            let memory = budget.reserve_memory(
                parameter_bytes
                    .saturating_mul(encoded_multiplier)
                    .saturating_add(1024 * 1024),
            )?;
            let count = rows.len() as u64;
            let batch = batch::build_batch(
                dialect,
                schema,
                &mapping.target_table,
                &mapping.target_columns,
                &mapping.key_indices,
                self.kind,
                &rows,
            )?;
            return Ok(Some(PreparedBatch {
                batch,
                rows: count,
                _memory: memory,
            }));
        }
    }
}
async fn write_network_kind(
    session: &mut dyn super::adapters::DataSession,
    plan: Arc<StoredDataPlan>,
    kind: DataDiffOperation,
    cancel: &Cancellation,
    progress: &mut Progress,
) -> Result<(), String> {
    let dialect = session.dialect();
    let schema = plan.request.target.database.clone();
    let mut reader = BatchReader {
        plan,
        kind,
        table_index: 0,
        cursor: None,
        pending: None,
    };
    loop {
        let worker_cancel = cancel.clone();
        let schema = schema.clone();
        let (returned, prepared) = tokio::task::spawn_blocking(move || {
            let result = reader.next_batch(dialect, &schema, &worker_cancel);
            (reader, result)
        })
        .await
        .map_err(|_| "写入批次工作线程中断")?;
        reader = returned;
        let Some(prepared) = prepared? else { break };
        checked(cancel)?;
        let affected = session.write_batch(prepared.batch).await?;
        // MySQL默认报告changed rows；预先差异已保证UPDATE不同，故每条计划行均应改变。
        if affected != prepared.rows {
            return Err("validation_failed: 批量写入影响行数与计划不一致".into());
        }
        progress.written += affected;
        progress.emit(DataTaskStatus::Executing, false);
        checked(cancel)?;
    }
    Ok(())
}
async fn sort_compare(
    snapshot: SpoolHandle,
    expected: SortedSpool,
    cancel: Cancellation,
) -> Result<(bool, u64), String> {
    tokio::task::spawn_blocking(move || {
        let count = snapshot.row_count();
        let sorted = external_sort(&snapshot)?;
        Ok((equal_sorted(&sorted, &expected, &cancel)?, count))
    })
    .await
    .map_err(|_| "集合校验工作线程中断")?
}
async fn execute_network_transaction(
    session: &mut dyn super::adapters::DataSession,
    source_identity: metadata::EndpointIdentity,
    plan: Arc<StoredDataPlan>,
    cancel: Cancellation,
    progress: &mut Progress,
) -> Result<(), String> {
    checked(&cancel)?;
    let current = session.load_metadata().await?;
    if current.schema_fingerprint != plan.target_metadata.schema_fingerprint {
        return Err("plan_stale: 目标结构已变化，请重新预览".into());
    }
    metadata::resolve_endpoints(
        &plan.request,
        source_identity,
        session
            .endpoint_identity()
            .ok_or("same_physical_target: 无法确认目标真实身份")?,
    )?;
    metadata::validate_mapping(&plan.request, &plan.source_metadata, &current)?;
    let budget = plan.target_full.spool.budget();
    let reread = network_snapshot(
        session,
        SnapshotInput {
            full: full_projections(&plan.mapping, &current)?,
            projected: None,
            directory: PathBuf::new(),
            seed: Some(plan.target_full.spool.clone()),
            budget: budget.clone(),
            cancel: cancel.clone(),
            status: DataTaskStatus::Executing,
            conversion: None,
        },
        progress,
    )
    .await?;
    if !sort_compare(reread.full, plan.target_full.clone(), cancel.clone())
        .await?
        .0
    {
        return Err("plan_stale: 目标内容已变化，请重新预览".into());
    }
    progress.emit(DataTaskStatus::Executing, true);
    if plan.request.mode == DataTaskMode::Replace {
        for table in &plan.mapping.delete_order {
            checked(&cancel)?;
            progress.written += session.delete_all(table.clone()).await?;
        }
    } else {
        write_network_kind(
            session,
            plan.clone(),
            DataDiffOperation::Delete,
            &cancel,
            progress,
        )
        .await?;
    }
    write_network_kind(
        session,
        plan.clone(),
        DataDiffOperation::Update,
        &cancel,
        progress,
    )
    .await?;
    write_network_kind(
        session,
        plan.clone(),
        DataDiffOperation::Insert,
        &cancel,
        progress,
    )
    .await?;
    session
        .maintain_generators(plan.mapping.tables.clone())
        .await?;
    progress.emit(DataTaskStatus::Verifying, true);
    checked(&cancel)?;
    let final_rows = network_snapshot(
        session,
        SnapshotInput {
            full: projections(&plan.mapping, false),
            projected: None,
            directory: PathBuf::new(),
            seed: Some(plan.expected.spool.clone()),
            budget,
            cancel: cancel.clone(),
            status: DataTaskStatus::Verifying,
            conversion: None,
        },
        progress,
    )
    .await?;
    let (equal, count) =
        sort_compare(final_rows.full, plan.expected.clone(), cancel.clone()).await?;
    progress.verified = count;
    if !equal {
        return Err("validation_failed: 最终集合校验不一致，已拒绝提交".into());
    }
    checked(&cancel)
}
const TRANSACTION_COMPLETION_TIMEOUT: Duration = Duration::from_secs(10);

async fn rollback_network_failure(
    target: &mut dyn super::adapters::DataSession,
    result: &mut DataTaskResult,
    cancel: &Cancellation,
    message: String,
) {
    result.error = Some(if cancel.load(Ordering::Acquire) {
        DataTaskError::new("cancelled", "数据任务已取消")
    } else {
        error(message)
    });
    match tokio::time::timeout(TRANSACTION_COMPLETION_TIMEOUT, target.rollback()).await {
        Ok(Ok(())) => {
            result.commit_state = DataCommitState::RolledBack;
            result.status = if cancel.load(Ordering::Acquire) {
                DataTaskStatus::Cancelled
            } else {
                DataTaskStatus::Failed
            };
        }
        _ => {
            result.commit_state = DataCommitState::Unknown;
            result.status = DataTaskStatus::OutcomeUnknown;
            result.requires_target_refresh = true;
            result
                .cleanup_errors
                .push("目标回滚尚未确认，需要核对目标".into());
        }
    }
}

async fn execute_network(
    plan: Arc<StoredDataPlan>,
    source_config: ConnectionConfig,
    target_config: ConnectionConfig,
    cancel: Cancellation,
    callback: ProgressCallback,
) -> DataTaskResult {
    let mut result = DataTaskResult {
        status: DataTaskStatus::Failed,
        commit_state: DataCommitState::None,
        tables: plan.preview.tables.clone(),
        error: None,
        cleanup_errors: vec![],
        requires_target_refresh: false,
    };
    let mut progress = Progress::new(callback);
    let preflight = async {
        checked(&cancel)?;
        if target_config.database_type == DatabaseType::ClickHouse {
            return Err(format!(
                "unsupported_capability: {}",
                metadata::CLICKHOUSE_TARGET_BLOCKER
            ));
        }
        if plan
            .preview
            .expires_at
            .parse::<u64>()
            .ok()
            .filter(|e| *e > now_ms())
            .is_none()
        {
            return Err("plan_expired: 预览已过期".into());
        }
        if configuration_fingerprint(&source_config)
            != plan.source_metadata.configuration_fingerprint
            || configuration_fingerprint(&target_config)
                != plan.target_metadata.configuration_fingerprint
        {
            return Err("plan_stale: 已保存连接配置发生变化".into());
        }
        let mut source =
            open_session(source_config, plan.request.source.clone(), cancel.clone()).await?;
        source.begin_read().await?;
        let metadata = source.load_metadata().await?;
        if metadata.schema_fingerprint != plan.source_metadata.schema_fingerprint {
            return Err("plan_stale: 源结构已变化".into());
        }
        source.rollback().await?;
        let target =
            open_session(target_config, plan.request.target.clone(), cancel.clone()).await?;
        if !target.supports_transaction() {
            return Err("unsupported_capability: 目标会话不支持整任务事务".into());
        }
        Ok::<_, String>((source, target))
    }
    .await;
    let (source, mut target) = match preflight {
        Ok(s) => s,
        Err(e) => {
            let e = error(e);
            result.status = if cancel.load(Ordering::Acquire) {
                DataTaskStatus::Cancelled
            } else {
                DataTaskStatus::Failed
            };
            result.error = Some(e);
            return result;
        }
    };
    if let Err(message) = target
        .begin_protected_write(plan.mapping.insert_order.clone())
        .await
    {
        rollback_network_failure(target.as_mut(), &mut result, &cancel, message).await;
        result.cleanup_errors.extend(target.take_cleanup_errors());
        return result;
    }
    let source_identity = match source.endpoint_identity() {
        Some(identity) => identity,
        None => {
            let _ = target.rollback().await;
            result.error = Some(DataTaskError::new(
                "same_physical_target",
                "无法确认源端真实身份",
            ));
            return result;
        }
    };
    let work = execute_network_transaction(
        target.as_mut(),
        source_identity,
        plan.clone(),
        cancel.clone(),
        &mut progress,
    )
    .await;
    let work = if work.is_ok() {
        progress.emit(DataTaskStatus::Committing, true);
        checked(&cancel)
    } else {
        work
    };
    if let Err(message) = work {
        rollback_network_failure(target.as_mut(), &mut result, &cancel, message).await;
    } else {
        // TCP仍开放也可能永远收不到COMMIT响应。超时只能判为未知，绝不重放或声称回滚。
        match tokio::time::timeout(TRANSACTION_COMPLETION_TIMEOUT, target.commit()).await {
            Ok(Ok(())) => {
                result.status = DataTaskStatus::Succeeded;
                result.commit_state = DataCommitState::Committed;
                result.requires_target_refresh = true;
                progress.emit(DataTaskStatus::Succeeded, true);
            }
            _ => {
                result.status = DataTaskStatus::OutcomeUnknown;
                result.commit_state = DataCommitState::Unknown;
                result.error = Some(DataTaskError::new(
                    "outcome_unknown",
                    "提交响应未确认，不会自动重试；请核对目标",
                ));
                result.requires_target_refresh = true;
            }
        }
    }
    result.cleanup_errors.extend(target.take_cleanup_errors());
    result
}
