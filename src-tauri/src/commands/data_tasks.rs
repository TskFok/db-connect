use super::temporary_database::find_saved_connection;
use crate::db::data_tasks::{
    self as engine, executor, history, metadata, plan::StoredDataPlan, registry::DataTaskRegistry,
    Cancellation, ProgressCallback,
};
use crate::models::types::DatabaseType;
use crate::models::{data_tasks::*, types::ConnectionConfig};
use crate::util::secure_fs::set_secure_dir_permissions;
use crate::AppState;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

// 仅驻留内存，用于检测任何保存配置变更；此摘要不会进入计划、日志或 IPC。
fn configuration_digest(config: &ConnectionConfig) -> [u8; 32] {
    Sha256::digest(serde_json::to_vec(config).unwrap_or_default()).into()
}
fn selected_configs(
    saved: &[ConnectionConfig],
    request: &DataTaskRequest,
) -> Result<(ConnectionConfig, ConnectionConfig), DataTaskError> {
    request.validate()?;
    let source = find_saved_connection(saved, &request.source.saved_connection_id, "源端")
        .map_err(|_| DataTaskError::new("plan_stale", "源端保存连接不存在或已删除"))?;
    let target = find_saved_connection(saved, &request.target.saved_connection_id, "目标端")
        .map_err(|_| DataTaskError::new("plan_stale", "目标端保存连接不存在或已删除"))?;
    if target.read_only == Some(true) {
        return Err(DataTaskError::new(
            "read_only_target",
            "目标连接为只读，不能执行数据任务",
        ));
    }
    Ok((source, target))
}
fn check_configurations(
    source: &ConnectionConfig,
    target: &ConnectionConfig,
    expected_source: &[u8; 32],
    expected_target: &[u8; 32],
) -> Result<(), DataTaskError> {
    if configuration_digest(source) != *expected_source
        || configuration_digest(target) != *expected_target
    {
        return Err(DataTaskError::new(
            "plan_stale",
            "保存连接已变更，请重新预览",
        ));
    }
    Ok(())
}

struct PlanEnvelope {
    plan: Arc<StoredDataPlan>,
    source_digest: [u8; 32],
    target_digest: [u8; 32],
    directory: PathBuf,
}

#[derive(Default)]
pub struct DataTaskRuntime {
    pub registry: DataTaskRegistry,
    plans: Mutex<HashMap<String, Arc<PlanEnvelope>>>,
    directory: Mutex<Option<PathBuf>>,
    directory_lock: Mutex<Option<std::fs::File>>,
    history_lock: Mutex<()>,
    pub exit_prompt_open: AtomicBool,
}

fn file_error() -> DataTaskError {
    DataTaskError::new("resource_limit", "无法初始化数据任务临时目录或历史记录")
}
fn internal_error() -> DataTaskError {
    DataTaskError::new("task_failed", "数据任务执行中断，请重新预览或核对目标")
}
fn lock_directory(directory: &Path) -> Result<std::fs::File, DataTaskError> {
    let file = crate::util::secure_fs::create_secure_file(&directory.join("runtime.lock"))
        .map_err(|_| file_error())?;
    file.try_lock().map_err(|_| {
        DataTaskError::new(
            "task_busy",
            "另一个 DB Connect 实例正在使用数据任务，请在该实例中操作",
        )
    })?;
    Ok(file)
}
fn failed_result(error: DataTaskError) -> DataTaskResult {
    DataTaskResult {
        status: if error.code == "cancelled" {
            DataTaskStatus::Cancelled
        } else {
            DataTaskStatus::Failed
        },
        commit_state: DataCommitState::None,
        tables: vec![],
        error: Some(error),
        cleanup_errors: vec![],
        requires_target_refresh: false,
    }
}

impl DataTaskRuntime {
    pub fn initialize(&self, app: &AppHandle) -> Result<PathBuf, DataTaskError> {
        let mut directory = self.directory.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(dir) = directory.as_ref() {
            return Ok(dir.clone());
        }
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|_| file_error())?
            .join("data-tasks");
        if std::fs::symlink_metadata(&dir).is_ok_and(|m| !m.is_dir() || m.file_type().is_symlink())
        {
            return Err(file_error());
        }
        std::fs::create_dir_all(&dir).map_err(|_| file_error())?;
        set_secure_dir_permissions(&dir).map_err(|_| file_error())?;
        let directory_lock = lock_directory(&dir)?;
        let restored = history::load_history(&dir.join("history.json"))?;
        let snapshots = dir.join("snapshots");
        if snapshots.exists() {
            let m = std::fs::symlink_metadata(&snapshots).map_err(|_| file_error())?;
            if m.file_type().is_symlink() || !m.is_dir() {
                return Err(file_error());
            }
            std::fs::remove_dir_all(&snapshots).map_err(|_| file_error())?;
        }
        std::fs::create_dir(&snapshots).map_err(|_| file_error())?;
        set_secure_dir_permissions(&snapshots).map_err(|_| file_error())?;
        self.registry.restore(restored);
        *directory = Some(dir.clone());
        *self
            .directory_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(directory_lock);
        Ok(dir)
    }
    fn persist(&self) -> Result<(), DataTaskError> {
        let _serial = self.history_lock.lock().unwrap_or_else(|e| e.into_inner());
        let path = self
            .directory
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
            .ok_or_else(file_error)?;
        history::save_history(&path.join("history.json"), &self.registry.list())
    }
    fn publish(&self, app: &AppHandle, snapshot: &DataTaskSnapshot) {
        if self.persist().is_err() {
            self.registry.append_cleanup_error(
                &snapshot.task_id,
                "任务摘要保存失败，请在退出前保留并核对执行结果",
            );
        }
        // 事件是通知通道，发送失败不改变已经确认的数据库提交结果。
        let current = self
            .registry
            .snapshot(&snapshot.task_id)
            .unwrap_or_else(|_| snapshot.clone());
        let _ = app.emit("data-task-progress", current);
    }
    fn prune(&self) {
        let keep = self
            .registry
            .list()
            .into_iter()
            .filter_map(|s| s.preview.map(|p| p.plan_id))
            .collect::<HashSet<_>>();
        let removed = {
            let mut plans = self.plans.lock().unwrap_or_else(|e| e.into_inner());
            let ids = plans
                .keys()
                .filter(|id| !keep.contains(*id))
                .cloned()
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| plans.remove(&id))
                .collect::<Vec<_>>()
        };
        // Spool 析构可能访问磁盘，必须在释放任务/计划注册锁后执行。
        let directories = removed
            .iter()
            .map(|p| (p.plan.preview.task_id.clone(), p.directory.clone()))
            .collect::<Vec<_>>();
        drop(removed);
        for (task_id, path) in directories {
            if path.exists() && std::fs::remove_dir_all(path).is_err() {
                self.registry
                    .append_cleanup_error(&task_id, "临时快照清理失败，将在下次启动时重试");
            }
        }
    }
    pub fn maintenance(&self) {
        self.prune();
        let _ = self.persist();
    }
    pub fn cancel_all(&self, app: &AppHandle) {
        for snapshot in self.registry.list() {
            if !snapshot.status.is_terminal() {
                if let Ok(cancelled) = self.registry.cancel(&snapshot.task_id) {
                    self.publish(app, &cancelled);
                }
            }
        }
        self.prune();
    }
    fn progress(
        self: &Arc<Self>,
        app: AppHandle,
        task_id: String,
        cancel: Cancellation,
    ) -> ProgressCallback {
        let runtime = self.clone();
        let last = Mutex::new((
            Instant::now() - Duration::from_secs(1),
            DataTaskStatus::Created,
        ));
        Arc::new(move |update| {
            let status = update.status;
            runtime.registry.progress(&task_id, update);
            let emit = {
                let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
                if last.1 != status || last.0.elapsed() >= Duration::from_millis(200) {
                    *last = (Instant::now(), status);
                    true
                } else {
                    false
                }
            };
            if emit {
                // 写入阶段日志失败时请求取消；不会将未知提交伪报为已回滚。
                if runtime.persist().is_err() {
                    cancel.store(true, Ordering::Release);
                }
                if let Ok(s) = runtime.registry.snapshot(&task_id) {
                    let _ = app.emit("data-task-progress", s);
                }
            }
        })
    }
}

fn saved_connections(app: &AppHandle) -> Result<Vec<ConnectionConfig>, DataTaskError> {
    super::connection::load_saved_connections_internal(app)
        .map_err(|_| DataTaskError::new("plan_stale", "读取保存连接失败，请检查连接配置"))
}

#[tauri::command]
pub async fn get_data_task_capabilities(
    app: AppHandle,
    source: DataEndpoint,
    target: DataEndpoint,
) -> Result<DataTaskCapabilities, DataTaskError> {
    let saved = saved_connections(&app)?;
    let s = find_saved_connection(&saved, &source.saved_connection_id, "源端")
        .map_err(|_| DataTaskError::new("plan_stale", "源端连接已删除"))?;
    let t = find_saved_connection(&saved, &target.saved_connection_id, "目标端")
        .map_err(|_| DataTaskError::new("plan_stale", "目标端连接已删除"))?;
    let mut caps = metadata::get_config_capabilities(&s, &t);
    if s.database_type == DatabaseType::Sqlite && t.database_type == DatabaseType::Sqlite {
        if source.database != "main" || target.database != "main" {
            return Err(DataTaskError::new(
                "unsupported_capability",
                "SQLite 数据任务仅支持 main 数据库",
            ));
        }
        let objects = |config: &ConnectionConfig| -> Result<Vec<DataTaskObject>, DataTaskError> {
            let path = config
                .sqlite_path
                .as_ref()
                .ok_or_else(|| DataTaskError::new("plan_stale", "SQLite 文件配置不存在"))?;
            let connection = engine::adapters::sqlite::open(
                Path::new(path),
                false,
                Arc::new(AtomicBool::new(false)),
            )
            .map_err(|_| {
                DataTaskError::new("unsupported_capability", "无法只读打开 SQLite 文件")
            })?;
            let m = engine::adapters::sqlite::load_metadata(&connection).map_err(|_| {
                DataTaskError::new("unsupported_capability", "无法批量读取 SQLite 元数据")
            })?;
            Ok(m.tables
                .into_iter()
                .filter(|table| table.physical)
                .map(|table| DataTaskObject {
                    table: table.name,
                    columns: table
                        .columns
                        .into_iter()
                        .filter(|c| !c.generated)
                        .map(|c| c.name)
                        .collect(),
                })
                .collect())
        };
        let (source_tables, target_tables) = tokio::task::spawn_blocking(move || {
            Ok::<_, DataTaskError>((objects(&s)?, objects(&t)?))
        })
        .await
        .map_err(|_| internal_error())??;
        caps.source_tables = source_tables;
        caps.target_tables = target_tables;
    } else if !caps.supported_modes.is_empty() {
        let (source_metadata, target_metadata) =
            executor::inspect_endpoints(s, source, t, target, Arc::new(AtomicBool::new(false)))
                .await?;
        let metadata_caps = metadata::get_capabilities(&source_metadata, &target_metadata);
        caps.row_sync &= metadata_caps.row_sync;
        caps.transfer &= metadata_caps.transfer;
        caps.supported_modes
            .retain(|mode| metadata_caps.supported_modes.contains(mode));
        caps.blockers.extend(metadata_caps.blockers);
        caps.source_tables = source_metadata
            .tables
            .into_iter()
            .filter(|table| table.physical)
            .map(|table| DataTaskObject {
                table: table.name,
                columns: table.columns.into_iter().map(|c| c.name).collect(),
            })
            .collect();
        caps.target_tables = target_metadata
            .tables
            .into_iter()
            .filter(|table| table.physical)
            .map(|table| DataTaskObject {
                table: table.name,
                columns: table
                    .columns
                    .into_iter()
                    .filter(|c| !c.generated)
                    .map(|c| c.name)
                    .collect(),
            })
            .collect();
    }
    Ok(caps)
}

#[tauri::command]
pub async fn start_data_task_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    request: DataTaskRequest,
) -> Result<DataTaskSnapshot, DataTaskError> {
    let runtime = state.data_tasks.clone();
    let directory = runtime.initialize(&app)?;
    let saved = saved_connections(&app)?;
    let (source, target) = selected_configs(&saved, &request)?;
    let caps = metadata::get_config_capabilities(&source, &target);
    if !caps.supported_modes.contains(&request.mode) {
        return Err(DataTaskError::new(
            "unsupported_capability",
            "此数据库组合或模式尚未通过完整验收",
        ));
    }
    let (snapshot, start, cancel) = runtime
        .registry
        .register_preview(task_id.clone(), request.clone())?;
    if !start {
        return Ok(snapshot);
    }
    if let Err(error) = runtime.persist() {
        runtime
            .registry
            .finish(&task_id, failed_result(error.clone()))?;
        return Err(error);
    }
    runtime.publish(&app, &snapshot);
    let source_digest = configuration_digest(&source);
    let target_digest = configuration_digest(&target);
    let progress = runtime.progress(app.clone(), task_id.clone(), cancel.clone());
    tauri::async_runtime::spawn(async move {
        let path = directory
            .join("snapshots")
            .join(format!("task-{}", uuid::Uuid::new_v4()));
        let worker = tauri::async_runtime::spawn(executor::prepare_task(
            task_id.clone(),
            request,
            source,
            target,
            path.clone(),
            cancel.clone(),
            progress,
        ));
        let result = worker.await.unwrap_or_else(|_| Err(internal_error()));
        let outcome = match result {
            Ok(plan) => {
                let preview = plan.preview.clone();
                let plan_id = preview.plan_id.clone();
                let envelope = Arc::new(PlanEnvelope {
                    plan: Arc::new(plan),
                    source_digest,
                    target_digest,
                    directory: path.clone(),
                });
                runtime
                    .plans
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(plan_id.clone(), envelope);
                match runtime.registry.set_ready(&task_id, preview) {
                    Ok(snapshot) => Ok(snapshot),
                    Err(error) => {
                        let removed = runtime
                            .plans
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .remove(&plan_id);
                        drop(removed);
                        runtime.registry.finish(&task_id, failed_result(error))
                    }
                }
            }
            Err(error) => runtime.registry.finish(&task_id, failed_result(error)),
        };
        if let Ok(snapshot) = outcome {
            runtime.publish(&app, &snapshot);
        }
        runtime.prune();
        if !path.read_dir().is_ok_and(|mut d| d.next().is_some()) {
            let _ = std::fs::remove_dir(&path);
        }
    });
    Ok(snapshot)
}

#[tauri::command]
pub async fn get_data_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<DataTaskSnapshot, DataTaskError> {
    state.data_tasks.initialize(&app)?;
    let snapshot = state.data_tasks.registry.snapshot(&task_id)?;
    state.data_tasks.prune();
    Ok(snapshot)
}

#[tauri::command]
pub async fn get_data_task_diff(
    app: AppHandle,
    state: State<'_, AppState>,
    plan_id: String,
    table_id: String,
    cursor: Option<String>,
    page_size: u32,
) -> Result<DataDiffPage, DataTaskError> {
    state.data_tasks.initialize(&app)?;
    state.data_tasks.prune();
    if page_size == 0 || page_size > 200 {
        return Err(DataTaskError::new(
            "resource_limit",
            "差异每页必须为 1 至 200 行",
        ));
    }
    let entry = state
        .data_tasks
        .plans
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&plan_id)
        .cloned()
        .ok_or_else(|| DataTaskError::new("plan_stale", "预览不存在或已过期"))?;
    let page = tokio::task::spawn_blocking(move || {
        entry
            .plan
            .diff_page(&table_id, cursor.as_deref(), page_size)
    })
    .await
    .map_err(|_| internal_error())?
    .map_err(|_| DataTaskError::new("resource_limit", "读取差异失败，请检查分页参数或重新预览"))?;
    if serde_json::to_vec(&page)
        .map_err(|_| internal_error())?
        .len()
        > 1024 * 1024
    {
        return Err(DataTaskError::new(
            "resource_limit",
            "差异页超过 1 MiB，请减小页大小",
        ));
    }
    Ok(page)
}

#[tauri::command]
pub async fn execute_data_task(
    app: AppHandle,
    state: State<'_, AppState>,
    input: ExecuteDataTaskInput,
) -> Result<DataTaskSnapshot, DataTaskError> {
    let runtime = state.data_tasks.clone();
    runtime.initialize(&app)?;
    // 先识别已登记的幂等执行；其快照即使终态后已清理计划也必须可重取。
    if runtime
        .registry
        .list()
        .iter()
        .any(|s| s.execution_id.as_deref() == Some(&input.execution_id))
    {
        return runtime.registry.begin_execution(&input).map(|(s, _, _)| s);
    }
    runtime.prune();
    let envelope = runtime
        .plans
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&input.plan_id)
        .cloned()
        .ok_or_else(|| DataTaskError::new("plan_stale", "预览已失效，请重新预览"))?;
    let saved = saved_connections(&app)?;
    let (source, target) = selected_configs(&saved, &envelope.plan.request)?;
    check_configurations(
        &source,
        &target,
        &envelope.source_digest,
        &envelope.target_digest,
    )?;
    let (snapshot, start, cancel) = runtime.registry.begin_execution(&input)?;
    if !start {
        return Ok(snapshot);
    }
    if let Err(error) = runtime.persist() {
        runtime
            .registry
            .finish(&snapshot.task_id, failed_result(error.clone()))?;
        return Err(error);
    }
    runtime.publish(&app, &snapshot);
    let task_id = snapshot.task_id.clone();
    let progress = runtime.progress(app.clone(), task_id.clone(), cancel.clone());
    tauri::async_runtime::spawn(async move {
        let worker = tauri::async_runtime::spawn(executor::execute_plan(
            envelope.plan.clone(),
            source,
            target,
            cancel,
            progress,
        ));
        let result = worker.await.unwrap_or_else(|_| DataTaskResult {
            status: DataTaskStatus::OutcomeUnknown,
            commit_state: DataCommitState::Unknown,
            tables: envelope.plan.preview.tables.clone(),
            error: Some(DataTaskError::new(
                "outcome_unknown",
                "执行中断，提交结果无法确认，请先核对目标",
            )),
            cleanup_errors: vec![],
            requires_target_refresh: true,
        });
        let _ = runtime.registry.finish(&task_id, result);
        drop(envelope);
        runtime.prune();
        if let Ok(snapshot) = runtime.registry.snapshot(&task_id) {
            runtime.publish(&app, &snapshot);
        }
    });
    Ok(snapshot)
}

#[tauri::command]
pub async fn cancel_data_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<DataTaskSnapshot, DataTaskError> {
    state.data_tasks.initialize(&app)?;
    let snapshot = state.data_tasks.registry.cancel(&task_id)?;
    state.data_tasks.publish(&app, &snapshot);
    state.data_tasks.prune();
    Ok(snapshot)
}

#[tauri::command]
pub async fn list_data_tasks(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<DataTaskSnapshot>, DataTaskError> {
    state.data_tasks.initialize(&app)?;
    state.data_tasks.prune();
    Ok(state.data_tasks.registry.list())
}

#[tauri::command]
pub async fn discard_data_task_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    plan_id: String,
) -> Result<(), DataTaskError> {
    state.data_tasks.initialize(&app)?;
    if let Some(snapshot) = state.data_tasks.registry.discard(&plan_id)? {
        state.data_tasks.publish(&app, &snapshot);
    }
    state.data_tasks.prune();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(id: &str) -> ConnectionConfig {
        serde_json::from_value(serde_json::json!({"id":id,"name":id,"database_type":"sqlite","host":"","port":0,"username":"","sqlite_path":"/tmp/db.sqlite"})).unwrap()
    }
    fn request() -> DataTaskRequest {
        serde_json::from_value(serde_json::json!({"protocol_version":1,"kind":"transfer","mode":"append","source":{"saved_connection_id":"s","database":"main"},"target":{"saved_connection_id":"t","database":"main"},"mappings":[{"source_table":"t","target_table":"t","columns":[{"source_column":"id","target_column":"id"}]}]})).unwrap()
    }
    #[test]
    fn changing_credentials_or_settings_invalidates_plan_without_revealing_values() {
        let s = config("s");
        let t = config("t");
        let sd = configuration_digest(&s);
        let td = configuration_digest(&t);
        assert!(check_configurations(&s, &t, &sd, &td).is_ok());
        let mut changed = t.clone();
        changed.password = Some("do-not-disclose-this".into());
        let err = check_configurations(&s, &changed, &sd, &td).unwrap_err();
        assert_eq!(err.code, "plan_stale");
        assert!(!serde_json::to_string(&err)
            .unwrap()
            .contains("do-not-disclose"));
        let mut changed = s.clone();
        changed.read_only = Some(true);
        assert!(check_configurations(&changed, &t, &sd, &td).is_err());
    }
    #[test]
    fn deleted_connection_and_readonly_target_are_rejected_in_backend() {
        let mut t = config("t");
        t.read_only = Some(true);
        assert_eq!(
            selected_configs(&[config("s"), t], &request())
                .unwrap_err()
                .code,
            "read_only_target"
        );
        assert_eq!(
            selected_configs(&[config("s")], &request())
                .unwrap_err()
                .code,
            "plan_stale"
        );
    }
    #[test]
    fn accepts_same_saved_connection_for_distinct_database_before_physical_preflight() {
        let mut r = request();
        r.target.saved_connection_id = "s".into();
        r.target.database = "other".into();
        assert!(selected_configs(&[config("s")], &r).is_ok());
    }
    #[test]
    fn second_process_cannot_clean_an_active_snapshot_directory() {
        let dir =
            std::env::temp_dir().join(format!("db-connect-runtime-lock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let first = lock_directory(&dir).unwrap();
        assert_eq!(lock_directory(&dir).unwrap_err().code, "task_busy");
        drop(first);
        let next = lock_directory(&dir).unwrap();
        drop(next);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
