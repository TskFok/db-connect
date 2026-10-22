use super::{now_ms, Cancellation, ProgressUpdate};
use crate::models::data_tasks::*;
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[derive(Default)]
pub struct DataTaskRegistry {
    inner: Mutex<RegistryInner>,
}
#[derive(Default)]
struct RegistryInner {
    records: HashMap<String, Record>,
    cancelled_before_register: HashSet<String>,
    writer: Option<String>,
}
struct Record {
    snapshot: DataTaskSnapshot,
    cancel: Cancellation,
    execution: Option<ExecuteDataTaskInput>,
    plan_id: Option<String>,
    pending_cleanup_errors: Vec<String>,
}

fn missing() -> DataTaskError {
    DataTaskError::new("task_not_found", "数据任务不存在")
}
fn touch(snapshot: &mut DataTaskSnapshot) {
    snapshot.sequence = (snapshot.sequence.parse::<u64>().unwrap_or(0) + 1).to_string();
    snapshot.updated_at = now_ms().to_string();
    snapshot.elapsed_ms = now_ms()
        .saturating_sub(snapshot.created_at.parse().unwrap_or(0))
        .to_string();
}
fn cancel_result() -> DataTaskResult {
    DataTaskResult {
        status: DataTaskStatus::Cancelled,
        commit_state: DataCommitState::None,
        tables: vec![],
        error: Some(DataTaskError::new("cancelled", "任务已取消")),
        cleanup_errors: vec![],
        requires_target_refresh: false,
    }
}
fn phase(status: DataTaskStatus) -> u8 {
    match status {
        DataTaskStatus::Created => 0,
        DataTaskStatus::Validating => 1,
        DataTaskStatus::Reading => 2,
        DataTaskStatus::Comparing => 3,
        DataTaskStatus::Ready => 4,
        DataTaskStatus::Executing => 5,
        DataTaskStatus::Verifying => 6,
        DataTaskStatus::Committing => 7,
        _ => 8,
    }
}
fn expire(inner: &mut RegistryInner) {
    let now = now_ms();
    for record in inner.records.values_mut() {
        if record.snapshot.status == DataTaskStatus::Ready
            && record
                .snapshot
                .preview
                .as_ref()
                .is_some_and(|p| p.expires_at.parse::<u64>().unwrap_or(0) <= now)
        {
            record.snapshot.status = DataTaskStatus::Expired;
            record.snapshot.preview = None;
            record.snapshot.result = Some(DataTaskResult {
                status: DataTaskStatus::Expired,
                commit_state: DataCommitState::None,
                tables: vec![],
                error: Some(DataTaskError::new("plan_expired", "预览已过期，请重新预览")),
                cleanup_errors: std::mem::take(&mut record.pending_cleanup_errors),
                requires_target_refresh: false,
            });
            record.cancel.store(true, Ordering::Release);
            touch(&mut record.snapshot);
        }
    }
}

impl DataTaskRegistry {
    pub fn register_preview(
        &self,
        task_id: String,
        request: DataTaskRequest,
    ) -> Result<(DataTaskSnapshot, bool, Cancellation), DataTaskError> {
        request.validate()?;
        if task_id.trim().is_empty() || task_id.len() > 128 {
            return Err(DataTaskError::new("invalid_task_id", "任务标识无效"));
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        expire(&mut inner);
        if let Some(record) = inner.records.get(&task_id) {
            if record.snapshot.request != request {
                return Err(DataTaskError::new(
                    "task_conflict",
                    "此任务标识已用于其他请求",
                ));
            }
            return Ok((record.snapshot.clone(), false, record.cancel.clone()));
        }
        if inner
            .records
            .values()
            .filter(|r| !r.snapshot.status.is_terminal() && r.snapshot.execution_id.is_none())
            .count()
            >= 3
        {
            return Err(DataTaskError::new(
                "resource_limit",
                "最多保留三个预览，请关闭旧预览",
            ));
        }
        let cancelled = inner.cancelled_before_register.remove(&task_id);
        let cancel = Arc::new(AtomicBool::new(cancelled));
        let now = now_ms().to_string();
        let snapshot = DataTaskSnapshot {
            task_id: task_id.clone(),
            execution_id: None,
            sequence: "1".into(),
            status: if cancelled {
                DataTaskStatus::Cancelled
            } else {
                DataTaskStatus::Created
            },
            request,
            created_at: now.clone(),
            updated_at: now,
            read_rows: "0".into(),
            written_rows: "0".into(),
            verified_rows: "0".into(),
            bytes: "0".into(),
            elapsed_ms: "0".into(),
            preview: None,
            result: cancelled.then(cancel_result),
        };
        inner.records.insert(
            task_id,
            Record {
                snapshot: snapshot.clone(),
                cancel: cancel.clone(),
                execution: None,
                plan_id: None,
                pending_cleanup_errors: vec![],
            },
        );
        Self::trim(&mut inner);
        Ok((snapshot, !cancelled, cancel))
    }
    pub fn set_ready(
        &self,
        task_id: &str,
        preview: DataTaskPreview,
    ) -> Result<DataTaskSnapshot, DataTaskError> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let record = inner.records.get_mut(task_id).ok_or_else(missing)?;
        if record.cancel.load(Ordering::Acquire) || record.snapshot.status.is_terminal() {
            return Err(DataTaskError::new("cancelled", "预览已取消"));
        }
        if preview.task_id != task_id || record.snapshot.execution_id.is_some() {
            return Err(DataTaskError::new("plan_stale", "预览不属于此任务"));
        }
        record.snapshot.status = DataTaskStatus::Ready;
        record.plan_id = Some(preview.plan_id.clone());
        record.snapshot.preview = Some(preview);
        touch(&mut record.snapshot);
        Ok(record.snapshot.clone())
    }
    pub fn begin_execution(
        &self,
        input: &ExecuteDataTaskInput,
    ) -> Result<(DataTaskSnapshot, bool, Cancellation), DataTaskError> {
        if uuid::Uuid::parse_str(&input.execution_id).is_err() {
            return Err(DataTaskError::new(
                "invalid_execution_id",
                "执行标识必须为 UUID",
            ));
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        expire(&mut inner);
        if let Some(record) = inner.records.values().find(|r| {
            r.execution
                .as_ref()
                .is_some_and(|e| e.execution_id == input.execution_id)
        }) {
            if record.execution.as_ref() != Some(input) {
                return Err(DataTaskError::new("plan_stale", "执行标识与原请求不匹配"));
            }
            return Ok((record.snapshot.clone(), false, record.cancel.clone()));
        }
        let task_id = inner
            .records
            .iter()
            .find(|(_, r)| {
                r.plan_id.as_ref() == Some(&input.plan_id)
                    || r.execution
                        .as_ref()
                        .is_some_and(|e| e.plan_id == input.plan_id)
            })
            .map(|(id, _)| id.clone());
        // Expired previews are no longer retained. Their task still distinguishes expiry from a missing plan.
        let task_id = match task_id {
            Some(id) => id,
            None => {
                if inner
                    .records
                    .values()
                    .any(|r| r.snapshot.status == DataTaskStatus::Expired)
                {
                    return Err(DataTaskError::new("plan_expired", "预览已过期，请重新预览"));
                }
                return Err(DataTaskError::new("plan_stale", "预览不存在或已失效"));
            }
        };
        let record = inner.records.get(&task_id).ok_or_else(missing)?;
        if record.snapshot.status == DataTaskStatus::Expired {
            return Err(DataTaskError::new("plan_expired", "预览已过期，请重新预览"));
        }
        if record.execution.is_some() {
            return Err(DataTaskError::new(
                "plan_stale",
                "此预览已经启动过，请重新预览",
            ));
        }
        let preview = record
            .snapshot
            .preview
            .as_ref()
            .ok_or_else(|| DataTaskError::new("plan_stale", "预览已失效"))?;
        if record.snapshot.status != DataTaskStatus::Ready
            || preview.fingerprint != input.fingerprint
            || !preview.can_execute
        {
            return Err(DataTaskError::new("plan_stale", "预览不可执行或指纹不匹配"));
        }
        if preview
            .risks
            .iter()
            .any(|r| r.required && !input.accepted_risk_ids.contains(&r.id))
        {
            return Err(DataTaskError::new(
                "risk_confirmation_required",
                "请先确认全部破坏性操作风险",
            ));
        }
        if inner.writer.is_some() {
            return Err(DataTaskError::new("task_busy", "已有写入任务正在执行"));
        }
        inner.writer = Some(task_id.clone());
        let record = inner.records.get_mut(&task_id).ok_or_else(missing)?;
        record.execution = Some(input.clone());
        record.snapshot.execution_id = Some(input.execution_id.clone());
        record.snapshot.status = DataTaskStatus::Executing;
        touch(&mut record.snapshot);
        Ok((record.snapshot.clone(), true, record.cancel.clone()))
    }
    pub fn cancel(&self, task_id: &str) -> Result<DataTaskSnapshot, DataTaskError> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(record) = inner.records.get_mut(task_id) else {
            if !task_id.is_empty()
                && task_id.len() <= 128
                && inner.cancelled_before_register.len() < 1000
            {
                inner.cancelled_before_register.insert(task_id.into());
            }
            return Err(missing());
        };
        if record.snapshot.status.is_terminal()
            || record.snapshot.status == DataTaskStatus::Committing
        {
            return Ok(record.snapshot.clone());
        }
        record.cancel.store(true, Ordering::Release);
        if record.snapshot.status == DataTaskStatus::Ready
            || record.snapshot.status == DataTaskStatus::Created
        {
            record.snapshot.status = DataTaskStatus::Cancelled;
            record.snapshot.preview = None;
            let mut result = cancel_result();
            result
                .cleanup_errors
                .append(&mut record.pending_cleanup_errors);
            record.snapshot.result = Some(result);
        } else {
            record.snapshot.status = DataTaskStatus::Cancelling;
        }
        touch(&mut record.snapshot);
        Ok(record.snapshot.clone())
    }
    pub fn snapshot(&self, task_id: &str) -> Result<DataTaskSnapshot, DataTaskError> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        expire(&mut inner);
        inner
            .records
            .get(task_id)
            .map(|r| r.snapshot.clone())
            .ok_or_else(missing)
    }
    pub fn progress(&self, task_id: &str, update: ProgressUpdate) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(record) = inner.records.get_mut(task_id) {
            let s = &mut record.snapshot;
            if s.status.is_terminal()
                || s.status == DataTaskStatus::Cancelling
                || update.status.is_terminal()
                || phase(update.status) < phase(s.status)
            {
                return;
            }
            s.status = update.status;
            s.read_rows = update
                .read_rows
                .max(s.read_rows.parse().unwrap_or(0))
                .to_string();
            s.written_rows = update
                .written_rows
                .max(s.written_rows.parse().unwrap_or(0))
                .to_string();
            s.verified_rows = update
                .verified_rows
                .max(s.verified_rows.parse().unwrap_or(0))
                .to_string();
            s.bytes = update.bytes.max(s.bytes.parse().unwrap_or(0)).to_string();
            touch(s);
        }
    }
    pub fn finish(
        &self,
        task_id: &str,
        mut result: DataTaskResult,
    ) -> Result<DataTaskSnapshot, DataTaskError> {
        if !result.status.is_terminal() {
            return Err(DataTaskError::new("invalid_state", "结果必须为终态"));
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let record = inner.records.get_mut(task_id).ok_or_else(missing)?;
        if record.snapshot.status.is_terminal() {
            return Ok(record.snapshot.clone());
        }
        result
            .cleanup_errors
            .append(&mut record.pending_cleanup_errors);
        record.snapshot.status = result.status;
        record.snapshot.result = Some(result);
        record.snapshot.preview = None;
        touch(&mut record.snapshot);
        let snapshot = record.snapshot.clone();
        if inner.writer.as_deref() == Some(task_id) {
            inner.writer = None;
        }
        Self::trim(&mut inner);
        Ok(snapshot)
    }
    pub fn list(&self) -> Vec<DataTaskSnapshot> {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        expire(&mut inner);
        let mut records = inner
            .records
            .values()
            .map(|r| r.snapshot.clone())
            .collect::<Vec<_>>();
        records.sort_by_key(|s| std::cmp::Reverse(s.created_at.parse::<u64>().unwrap_or(0)));
        records
    }
    pub fn discard(&self, plan_id: &str) -> Result<Option<DataTaskSnapshot>, DataTaskError> {
        let task = self
            .list()
            .into_iter()
            .find(|s| s.preview.as_ref().is_some_and(|p| p.plan_id == plan_id));
        match task {
            Some(s) if s.execution_id.is_some() => {
                Err(DataTaskError::new("task_busy", "运行中计划不能被丢弃"))
            }
            Some(s) => self.cancel(&s.task_id).map(Some),
            None => Ok(None),
        }
    }
    pub fn has_active(&self) -> bool {
        self.list()
            .iter()
            .any(|s| !s.status.is_terminal() && s.status != DataTaskStatus::Ready)
    }
    pub fn restore(&self, snapshots: Vec<DataTaskSnapshot>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        for snapshot in snapshots.into_iter().take(100) {
            inner
                .records
                .entry(snapshot.task_id.clone())
                .or_insert(Record {
                    snapshot,
                    cancel: Arc::new(AtomicBool::new(true)),
                    execution: None,
                    plan_id: None,
                    pending_cleanup_errors: vec![],
                });
        }
    }
    fn trim(inner: &mut RegistryInner) {
        let mut terminal = inner
            .records
            .iter()
            .filter(|(_, r)| r.snapshot.status.is_terminal())
            .map(|(id, r)| {
                (
                    id.clone(),
                    r.snapshot.updated_at.parse::<u64>().unwrap_or(0),
                )
            })
            .collect::<Vec<_>>();
        terminal.sort_by_key(|(_, time)| *time);
        let count = terminal.len().saturating_sub(100);
        for (id, _) in terminal.into_iter().take(count) {
            inner.records.remove(&id);
        }
    }
    pub fn append_cleanup_error(&self, task_id: &str, message: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(record) = inner.records.get_mut(task_id) {
            if record.snapshot.status.is_terminal() {
                let result = record
                    .snapshot
                    .result
                    .get_or_insert_with(|| DataTaskResult {
                        status: record.snapshot.status,
                        commit_state: DataCommitState::None,
                        tables: vec![],
                        error: None,
                        cleanup_errors: vec![],
                        requires_target_refresh: false,
                    });
                result
                    .cleanup_errors
                    .append(&mut record.pending_cleanup_errors);
                result.cleanup_errors.push(message.into());
                touch(&mut record.snapshot);
            } else {
                record.pending_cleanup_errors.push(message.into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> DataTaskRequest {
        DataTaskRequest {
            protocol_version: 1,
            kind: DataTaskKind::RowSync,
            mode: DataTaskMode::Merge,
            source: DataEndpoint {
                saved_connection_id: "source".into(),
                database: "main".into(),
            },
            target: DataEndpoint {
                saved_connection_id: "target".into(),
                database: "main".into(),
            },
            mappings: vec![TableMapping {
                source_table: "items".into(),
                target_table: "items".into(),
                columns: vec![ColumnMapping {
                    source_column: "id".into(),
                    target_column: "id".into(),
                }],
            }],
        }
    }
    fn preview(task: &str, expires: u64) -> DataTaskPreview {
        let r = request();
        DataTaskPreview {
            task_id: task.into(),
            plan_id: format!("plan-{task}"),
            fingerprint: "fingerprint".into(),
            source: r.source,
            target: r.target,
            kind: r.kind,
            mode: r.mode,
            tables: vec![],
            source_captured_at: "1".into(),
            target_captured_at: "2".into(),
            expires_at: expires.to_string(),
            risks: vec![],
            blockers: vec![],
            can_execute: true,
            sql_examples: vec![],
        }
    }
    fn execution(task: &str) -> ExecuteDataTaskInput {
        ExecuteDataTaskInput {
            plan_id: format!("plan-{task}"),
            fingerprint: "fingerprint".into(),
            execution_id: uuid::Uuid::new_v4().to_string(),
            accepted_risk_ids: vec![],
        }
    }
    fn ready(r: &DataTaskRegistry, task: &str) {
        r.register_preview(task.into(), request()).unwrap();
        r.set_ready(task, preview(task, now_ms() + 900_000))
            .unwrap();
    }
    #[test]
    fn rejects_invalid_mode_and_untrusted_payload() {
        let r = DataTaskRegistry::default();
        let mut input = request();
        input.mode = DataTaskMode::Append;
        assert_eq!(
            r.register_preview("a".into(), input).unwrap_err().code,
            "unsupported_capability"
        );
        let mut json = serde_json::to_value(request()).unwrap();
        json["path"] = "/tmp/untrusted".into();
        assert!(serde_json::from_value::<DataTaskRequest>(json).is_err());
    }
    #[test]
    fn retry_is_idempotent_and_writer_slot_is_atomic() {
        let r = DataTaskRegistry::default();
        ready(&r, "a");
        ready(&r, "b");
        let input = execution("a");
        assert!(r.begin_execution(&input).unwrap().1);
        assert!(!r.begin_execution(&input).unwrap().1);
        assert_eq!(
            r.begin_execution(&execution("b")).unwrap_err().code,
            "task_busy"
        );
        let mut forged = input.clone();
        forged.fingerprint = "other".into();
        assert_eq!(r.begin_execution(&forged).unwrap_err().code, "plan_stale");
    }
    #[test]
    fn cancellation_before_registration_is_honored() {
        let r = DataTaskRegistry::default();
        assert!(r.cancel("a").is_err());
        let (s, start, c) = r.register_preview("a".into(), request()).unwrap();
        assert!(!start);
        assert_eq!(s.status, DataTaskStatus::Cancelled);
        assert!(c.load(Ordering::Acquire));
    }
    #[test]
    fn expired_or_unconfirmed_plan_cannot_acquire_writer() {
        let r = DataTaskRegistry::default();
        r.register_preview("a".into(), request()).unwrap();
        r.set_ready("a", preview("a", 1)).unwrap();
        assert_eq!(
            r.begin_execution(&execution("a")).unwrap_err().code,
            "plan_expired"
        );
        ready(&r, "b");
        let mut p = preview("b", now_ms() + 900_000);
        p.risks.push(DataTaskRisk {
            id: "delete".into(),
            message: "确认删除".into(),
            required: true,
        });
        r.set_ready("b", p).unwrap();
        assert_eq!(
            r.begin_execution(&execution("b")).unwrap_err().code,
            "risk_confirmation_required"
        );
    }
    #[test]
    fn cancellation_during_commit_cannot_claim_rollback_and_late_updates_are_ignored() {
        let r = DataTaskRegistry::default();
        ready(&r, "a");
        r.begin_execution(&execution("a")).unwrap();
        r.progress(
            "a",
            ProgressUpdate {
                status: DataTaskStatus::Committing,
                read_rows: 2,
                written_rows: 1,
                verified_rows: 2,
                bytes: 8,
            },
        );
        assert_eq!(r.cancel("a").unwrap().status, DataTaskStatus::Committing);
        r.finish(
            "a",
            DataTaskResult {
                status: DataTaskStatus::Succeeded,
                commit_state: DataCommitState::Committed,
                tables: vec![],
                error: None,
                cleanup_errors: vec![],
                requires_target_refresh: true,
            },
        )
        .unwrap();
        let before = r.snapshot("a").unwrap();
        r.progress(
            "a",
            ProgressUpdate {
                status: DataTaskStatus::Reading,
                read_rows: 0,
                written_rows: 0,
                verified_rows: 0,
                bytes: 0,
            },
        );
        assert_eq!(r.snapshot("a").unwrap(), before);
        assert_eq!(
            r.cancel("a").unwrap().result.unwrap().commit_state,
            DataCommitState::Committed
        );
    }
    #[test]
    fn illegal_backward_phase_does_not_replace_newer_phase() {
        let r = DataTaskRegistry::default();
        ready(&r, "a");
        r.progress(
            "a",
            ProgressUpdate {
                status: DataTaskStatus::Reading,
                read_rows: 0,
                written_rows: 0,
                verified_rows: 0,
                bytes: 0,
            },
        );
        assert_eq!(r.snapshot("a").unwrap().status, DataTaskStatus::Ready);
    }
    #[test]
    fn bounded_previews_and_repeated_ids_do_not_replace_requests() {
        let r = DataTaskRegistry::default();
        for id in ["a", "b", "c"] {
            ready(&r, id);
        }
        assert_eq!(
            r.register_preview("d".into(), request()).unwrap_err().code,
            "resource_limit"
        );
        assert!(!r.register_preview("a".into(), request()).unwrap().1);
        let mut changed = request();
        changed.target.database = "other".into();
        assert_eq!(
            r.register_preview("a".into(), changed).unwrap_err().code,
            "task_conflict"
        );
    }
    #[test]
    fn cleanup_failure_does_not_change_confirmed_commit() {
        let r = DataTaskRegistry::default();
        ready(&r, "a");
        r.begin_execution(&execution("a")).unwrap();
        r.finish(
            "a",
            DataTaskResult {
                status: DataTaskStatus::Succeeded,
                commit_state: DataCommitState::Committed,
                tables: vec![],
                error: None,
                cleanup_errors: vec![],
                requires_target_refresh: true,
            },
        )
        .unwrap();
        r.append_cleanup_error("a", "临时快照清理失败");
        let result = r.snapshot("a").unwrap().result.unwrap();
        assert_eq!(result.status, DataTaskStatus::Succeeded);
        assert_eq!(result.commit_state, DataCommitState::Committed);
        assert_eq!(result.cleanup_errors, vec!["临时快照清理失败"]);
    }
    #[test]
    fn active_cleanup_error_is_reported_only_with_final_result() {
        let r = DataTaskRegistry::default();
        r.register_preview("a".into(), request()).unwrap();
        r.append_cleanup_error("a", "历史记录写入失败");
        assert!(r.snapshot("a").unwrap().result.is_none());
        r.set_ready("a", preview("a", now_ms() + 900_000)).unwrap();
        r.begin_execution(&execution("a")).unwrap();
        let s = r
            .finish(
                "a",
                DataTaskResult {
                    status: DataTaskStatus::Succeeded,
                    commit_state: DataCommitState::Committed,
                    tables: vec![],
                    error: None,
                    cleanup_errors: vec![],
                    requires_target_refresh: true,
                },
            )
            .unwrap();
        assert_eq!(s.result.unwrap().cleanup_errors, vec!["历史记录写入失败"]);
    }
    #[test]
    fn expired_preview_preserves_pending_cleanup_errors() {
        let r = DataTaskRegistry::default();
        r.register_preview("a".into(), request()).unwrap();
        r.append_cleanup_error("a", "历史记录写入失败");
        r.set_ready("a", preview("a", 1)).unwrap();
        let snapshot = r.snapshot("a").unwrap();
        assert_eq!(snapshot.status, DataTaskStatus::Expired);
        assert_eq!(
            snapshot.result.unwrap().cleanup_errors,
            vec!["历史记录写入失败"]
        );
    }
}
