use crate::models::data_tasks::*;
use crate::util::secure_fs::create_secure_file;
use std::io::Write;
use std::path::Path;

fn history_error() -> DataTaskError {
    DataTaskError::new(
        "history_unavailable",
        "数据任务历史无法读写，请检查应用目录权限",
    )
}

fn summary(snapshot: &DataTaskSnapshot) -> DataTaskSnapshot {
    let mut value = snapshot.clone();
    value.preview = None;
    for mapping in &mut value.request.mappings {
        mapping.columns.clear();
    }
    if let Some(result) = &mut value.result {
        if let Some(error) = &mut result.error {
            error.message = "任务未完成，请根据错误码重新预览或核对目标".into();
        }
        result.cleanup_errors = result
            .cleanup_errors
            .iter()
            .map(|_| "资源清理失败".into())
            .collect();
    }
    value
}

pub fn save_history(path: &Path, snapshots: &[DataTaskSnapshot]) -> Result<(), DataTaskError> {
    if std::fs::symlink_metadata(path).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
        return Err(history_error());
    }
    let mut items = snapshots.iter().map(summary).collect::<Vec<_>>();
    items.sort_by_key(|s| std::cmp::Reverse(s.updated_at.parse::<u64>().unwrap_or(0)));
    items.truncate(100);
    let bytes = serde_json::to_vec(&items).map_err(|_| history_error())?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(history_error());
    }
    let temporary = path.with_file_name(format!("data-task-history-{}.tmp", uuid::Uuid::new_v4()));
    let operation = (|| {
        let mut file = create_secure_file(&temporary).map_err(|_| history_error())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| history_error())?;
        std::fs::rename(&temporary, path).map_err(|_| history_error())?;
        Ok(())
    })();
    if operation.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    operation
}

pub fn load_history(path: &Path) -> Result<Vec<DataTaskSnapshot>, DataTaskError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err(history_error()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 2 * 1024 * 1024
    {
        return Err(history_error());
    }
    let bytes = std::fs::read(path).map_err(|_| history_error())?;
    let mut items: Vec<DataTaskSnapshot> =
        serde_json::from_slice(&bytes).map_err(|_| history_error())?;
    items.truncate(100);
    for snapshot in &mut items {
        snapshot.preview = None;
        if !snapshot.status.is_terminal() {
            let unknown = snapshot.execution_id.is_some();
            snapshot.status = if unknown {
                DataTaskStatus::OutcomeUnknown
            } else {
                DataTaskStatus::Interrupted
            };
            snapshot.result = Some(DataTaskResult {
                status: snapshot.status,
                commit_state: if unknown {
                    DataCommitState::Unknown
                } else {
                    DataCommitState::None
                },
                tables: snapshot
                    .request
                    .mappings
                    .iter()
                    .enumerate()
                    .map(|(i, m)| DataTablePreview {
                        table_id: i.to_string(),
                        source_table: m.source_table.clone(),
                        target_table: m.target_table.clone(),
                        counts: DataTaskCounts::default(),
                    })
                    .collect(),
                error: Some(DataTaskError::new(
                    if unknown {
                        "outcome_unknown"
                    } else {
                        "interrupted"
                    },
                    if unknown {
                        "应用退出前执行结果未确认，请核对目标，禁止直接重放"
                    } else {
                        "应用退出中断了预览，请重新预览"
                    },
                )),
                cleanup_errors: vec![],
                requires_target_refresh: unknown,
            });
            snapshot.sequence = (snapshot.sequence.parse::<u64>().unwrap_or(0) + 1).to_string();
        }
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(id: usize, status: DataTaskStatus) -> DataTaskSnapshot {
        DataTaskSnapshot {
            task_id: id.to_string(),
            execution_id: (status == DataTaskStatus::Committing).then(|| "execution".into()),
            sequence: "3".into(),
            status,
            request: DataTaskRequest {
                protocol_version: 1,
                kind: DataTaskKind::Transfer,
                mode: DataTaskMode::Append,
                source: DataEndpoint {
                    saved_connection_id: "source".into(),
                    database: "main".into(),
                },
                target: DataEndpoint {
                    saved_connection_id: "target".into(),
                    database: "main".into(),
                },
                mappings: vec![],
            },
            created_at: id.to_string(),
            updated_at: id.to_string(),
            read_rows: "9007199254740993".into(),
            written_rows: "0".into(),
            verified_rows: "0".into(),
            bytes: "0".into(),
            elapsed_ms: "0".into(),
            preview: None,
            result: Some(DataTaskResult {
                status,
                commit_state: DataCommitState::None,
                tables: vec![],
                error: Some(DataTaskError::new(
                    "constraint_conflict",
                    "sensitive row: 123456",
                )),
                cleanup_errors: vec!["sensitive path".into()],
                requires_target_refresh: false,
            }),
        }
    }
    #[test]
    fn history_is_bounded_private_and_preserves_exact_counts() {
        let dir = std::env::temp_dir().join(format!("db-connect-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("history.json");
        let items = (0..105)
            .map(|id| snapshot(id, DataTaskStatus::Failed))
            .collect::<Vec<_>>();
        save_history(&path, &items).unwrap();
        let data = std::fs::read_to_string(&path).unwrap();
        assert!(!data.contains("sensitive"));
        let loaded = load_history(&path).unwrap();
        assert_eq!(loaded.len(), 100);
        assert_eq!(loaded[0].task_id, "104");
        assert_eq!(loaded[0].read_rows, "9007199254740993");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn restart_never_replays_and_marks_possible_commit_unknown() {
        let dir = std::env::temp_dir().join(format!("db-connect-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("history.json");
        save_history(
            &path,
            &[
                snapshot(1, DataTaskStatus::Reading),
                snapshot(2, DataTaskStatus::Committing),
            ],
        )
        .unwrap();
        let loaded = load_history(&path).unwrap();
        assert_eq!(loaded[0].status, DataTaskStatus::OutcomeUnknown);
        assert_eq!(
            loaded[0].result.as_ref().unwrap().commit_state,
            DataCommitState::Unknown
        );
        assert_eq!(loaded[1].status, DataTaskStatus::Interrupted);
        assert_eq!(
            loaded[1].result.as_ref().unwrap().commit_state,
            DataCommitState::None
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn refuses_symlink_history_without_touching_target() {
        let dir = std::env::temp_dir().join(format!("db-connect-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let target = dir.join("target");
        std::fs::write(&target, "keep").unwrap();
        let path = dir.join("history.json");
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(save_history(&path, &[]).is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
