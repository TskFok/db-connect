use crate::AppState;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::http::HeaderMap;
use tauri::ipc::{InvokeBody, Request};
use tauri::State;
use uuid::Uuid;

const BINARY_EXPORT_TTL: Duration = Duration::from_secs(5 * 60);

/// 将文本写入用户通过系统对话框选择的路径
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(path.as_str(), contents.as_bytes()).map_err(|e| format!("写入文件失败: {}", e))
}

/// 只保留一个尚未领取的导出路径，领取与取消共用原子移除操作。
#[derive(Default)]
pub struct BinaryExportRegistry {
    pending: Mutex<Option<PendingBinaryExport>>,
}

struct PendingBinaryExport {
    id: String,
    path: String,
    created_at: Instant,
}

impl BinaryExportRegistry {
    fn prepare(&self, path: String, now: Instant) -> Result<String, String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "导出任务状态不可用".to_owned())?;
        if pending.as_ref().is_some_and(|export| {
            now.saturating_duration_since(export.created_at) >= BINARY_EXPORT_TTL
        }) {
            *pending = None;
        }
        if pending.is_some() {
            return Err("已有导出任务正在进行".to_owned());
        }
        let id = Uuid::new_v4().to_string();
        *pending = Some(PendingBinaryExport {
            id: id.clone(),
            path,
            created_at: now,
        });
        Ok(id)
    }

    fn take(&self, export_id: &str, now: Instant) -> Result<String, String> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| "导出任务状态不可用".to_owned())?;
        if pending.as_ref().is_none_or(|export| export.id != export_id) {
            return Err("导出任务不存在、已取消或已使用".to_owned());
        }
        let export = pending.take().ok_or_else(|| "导出任务不存在".to_owned())?;
        if now.saturating_duration_since(export.created_at) >= BINARY_EXPORT_TTL {
            return Err("导出任务已过期，请重新导出".to_owned());
        }
        Ok(export.path)
    }

    fn cancel(&self, export_id: &str, now: Instant) -> Result<(), String> {
        self.take(export_id, now).map(|_| ())
    }
}

async fn write_binary_export_payload(
    headers: &HeaderMap,
    body: &InvokeBody,
    registry: &BinaryExportRegistry,
) -> Result<(), String> {
    let export_id = headers
        .get("x-db-connect-export-id")
        .ok_or_else(|| "缺少导出任务标识".to_owned())?
        .to_str()
        .map_err(|_| "导出任务标识必须为 ASCII UUID".to_owned())?;
    Uuid::parse_str(export_id).map_err(|_| "导出任务标识必须为 ASCII UUID".to_owned())?;
    let InvokeBody::Raw(bytes) = body else {
        return Err("导出文件必须通过原始二进制请求体传输".to_owned());
    };
    let path = registry.take(export_id, Instant::now())?;
    // Request 只借用 IPC 内容；阻塞任务需要独立持有字节，不再生成 Base64 中间表示。
    let bytes = bytes.clone();
    tokio::task::spawn_blocking(move || {
        std::fs::write(path, bytes).map_err(|error| format!("写入文件失败: {error}"))
    })
    .await
    .map_err(|error| format!("写入文件任务失败: {error}"))?
}

/// 登记用户选定的路径；此时不创建或截断文件。
#[tauri::command]
pub fn prepare_binary_export(path: String, state: State<'_, AppState>) -> Result<String, String> {
    state.binary_exports.prepare(path, Instant::now())
}

/// 领取一次性 ID 后在锁外写盘，原始请求头中仅传输 ASCII UUID。
#[tauri::command]
pub async fn write_binary_export(
    request: Request<'_>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    write_binary_export_payload(request.headers(), request.body(), &state.binary_exports).await
}

/// 取消尚未领取的导出；已经开始的文件写入无法撤销。
#[tauri::command]
pub fn cancel_binary_export(export_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.binary_exports.cancel(&export_id, Instant::now())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::{Arc, Barrier};
    use std::time::{Duration, Instant};
    use tauri::http::{HeaderMap, HeaderValue};
    use tauri::ipc::InvokeBody;
    use uuid::Uuid;

    struct TestDirectory(PathBuf);

    impl TestDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("db-connect-export-{}", Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self, file_name: &str) -> PathBuf {
            self.0.join(file_name)
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn headers(export_id: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-db-connect-export-id",
            HeaderValue::from_str(export_id).unwrap(),
        );
        headers
    }

    fn prepare(registry: &BinaryExportRegistry, path: &Path) -> String {
        registry
            .prepare(path.to_string_lossy().into_owned(), Instant::now())
            .unwrap()
    }

    #[test]
    fn file_io_registration_preserves_unicode_spaces_and_windows_paths() {
        let registry = BinaryExportRegistry::default();
        for path in ["/tmp/导出 文件.xlsx", r"C:\用户\测试 目录\报表.xlsx"] {
            let now = Instant::now();
            let export_id = registry.prepare(path.to_owned(), now).unwrap();
            assert!(export_id.is_ascii());
            assert!(Uuid::parse_str(&export_id).is_ok());
            assert_eq!(registry.take(&export_id, now).unwrap(), path);
        }
    }

    #[test]
    fn file_io_registration_neither_creates_nor_truncates_files() {
        let directory = TestDirectory::new();
        let registry = BinaryExportRegistry::default();
        let absent = directory.path("尚未创建.xlsx");
        let export_id = prepare(&registry, &absent);
        assert!(!absent.exists());
        registry.cancel(&export_id, Instant::now()).unwrap();

        let existing = directory.path("已有内容.xlsx");
        std::fs::write(&existing, b"existing bytes").unwrap();
        let export_id = prepare(&registry, &existing);
        assert_eq!(std::fs::read(&existing).unwrap(), b"existing bytes");
        registry.cancel(&export_id, Instant::now()).unwrap();
    }

    #[test]
    fn file_io_registration_rejects_a_second_pending_export() {
        let registry = BinaryExportRegistry::default();
        let now = Instant::now();
        let export_id = registry.prepare("first.xlsx".to_owned(), now).unwrap();
        assert!(registry.prepare("second.xlsx".to_owned(), now).is_err());
        assert_eq!(registry.take(&export_id, now).unwrap(), "first.xlsx");
        assert!(registry.prepare("second.xlsx".to_owned(), now).is_ok());
    }

    #[test]
    fn file_io_expiry_reclaims_capacity_at_five_minutes() {
        let registry = BinaryExportRegistry::default();
        let now = Instant::now();
        let export_id = registry.prepare("old.xlsx".to_owned(), now).unwrap();
        assert!(registry
            .prepare("too-early.xlsx".to_owned(), now + Duration::from_secs(299))
            .is_err());
        let replacement = registry
            .prepare("new.xlsx".to_owned(), now + Duration::from_secs(300))
            .unwrap();
        assert_ne!(export_id, replacement);
        assert!(registry
            .take(&export_id, now + Duration::from_secs(300))
            .is_err());
        assert_eq!(
            registry
                .take(&replacement, now + Duration::from_secs(300))
                .unwrap(),
            "new.xlsx"
        );
    }

    #[test]
    fn file_io_expired_id_cannot_be_claimed_or_cancelled() {
        let registry = BinaryExportRegistry::default();
        let now = Instant::now();
        let export_id = registry.prepare("expired.xlsx".to_owned(), now).unwrap();
        assert!(registry
            .take(&export_id, now + Duration::from_secs(300))
            .is_err());
        assert!(registry
            .cancel(&export_id, now + Duration::from_secs(300))
            .is_err());
        assert!(registry.prepare("next.xlsx".to_owned(), now).is_ok());
    }

    #[test]
    fn file_io_unknown_id_does_not_consume_the_pending_export() {
        let registry = BinaryExportRegistry::default();
        let now = Instant::now();
        let export_id = registry.prepare("retained.xlsx".to_owned(), now).unwrap();
        let unknown = Uuid::new_v4().to_string();
        assert!(registry.take(&unknown, now).is_err());
        assert!(registry.cancel(&unknown, now).is_err());
        assert_eq!(registry.take(&export_id, now).unwrap(), "retained.xlsx");
        assert!(registry.take(&export_id, now).is_err());
    }

    #[test]
    fn file_io_cancel_consumes_id_and_releases_capacity() {
        let registry = BinaryExportRegistry::default();
        let now = Instant::now();
        let export_id = registry.prepare("cancelled.xlsx".to_owned(), now).unwrap();
        registry.cancel(&export_id, now).unwrap();
        assert!(registry.take(&export_id, now).is_err());
        assert!(registry.cancel(&export_id, now).is_err());
        assert!(registry.prepare("next.xlsx".to_owned(), now).is_ok());
    }

    #[test]
    fn file_io_concurrent_registration_admits_only_one_export() {
        let registry = Arc::new(BinaryExportRegistry::default());
        let barrier = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let registry = Arc::clone(&registry);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    registry.prepare(format!("{index}.xlsx"), Instant::now())
                })
            })
            .collect();
        let successful = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(Result::is_ok)
            .count();
        assert_eq!(successful, 1);
    }

    #[test]
    fn file_io_concurrent_claim_and_cancel_consume_id_only_once() {
        let registry = Arc::new(BinaryExportRegistry::default());
        let export_id = registry
            .prepare("one.xlsx".to_owned(), Instant::now())
            .unwrap();
        let barrier = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let registry = Arc::clone(&registry);
                let barrier = Arc::clone(&barrier);
                let export_id = export_id.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    if index % 2 == 0 {
                        registry.take(&export_id, Instant::now()).map(|_| ())
                    } else {
                        registry.cancel(&export_id, Instant::now())
                    }
                })
            })
            .collect();
        let successful = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .filter(Result::is_ok)
            .count();
        assert_eq!(successful, 1);
        assert!(registry
            .prepare("next.xlsx".to_owned(), Instant::now())
            .is_ok());
    }

    #[tokio::test]
    async fn file_io_raw_bytes_write_verbatim_and_duplicate_write_is_rejected() {
        let directory = TestDirectory::new();
        let path = directory.path("中文 报表.xlsx");
        let registry = BinaryExportRegistry::default();
        let export_id = prepare(&registry, &path);
        let body = InvokeBody::Raw(vec![0x00, 0xff, 0x50, 0x4b, 0x80]);
        write_binary_export_payload(&headers(&export_id), &body, &registry)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            [0x00, 0xff, 0x50, 0x4b, 0x80]
        );
        assert!(write_binary_export_payload(
            &headers(&export_id),
            &InvokeBody::Raw(vec![1]),
            &registry
        )
        .await
        .is_err());
        assert_eq!(
            std::fs::read(&path).unwrap(),
            [0x00, 0xff, 0x50, 0x4b, 0x80]
        );
    }

    #[tokio::test]
    async fn file_io_raw_write_overwrites_and_truncates_existing_file() {
        let directory = TestDirectory::new();
        let path = directory.path("覆盖.xlsx");
        std::fs::write(&path, b"old and longer contents").unwrap();
        let registry = BinaryExportRegistry::default();
        let export_id = prepare(&registry, &path);
        write_binary_export_payload(
            &headers(&export_id),
            &InvokeBody::Raw(vec![0xff, 0x00]),
            &registry,
        )
        .await
        .unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), [0xff, 0x00]);
    }

    #[tokio::test]
    async fn file_io_failed_write_consumes_registration_and_returns_error() {
        let directory = TestDirectory::new();
        let path = directory.path("missing-parent/报表.xlsx");
        let registry = BinaryExportRegistry::default();
        let export_id = prepare(&registry, &path);
        let error = write_binary_export_payload(
            &headers(&export_id),
            &InvokeBody::Raw(vec![0xff]),
            &registry,
        )
        .await
        .unwrap_err();
        assert!(error.contains("写入文件失败"));
        assert!(!path.exists());
        assert!(registry.cancel(&export_id, Instant::now()).is_err());
        assert!(registry
            .prepare("next.xlsx".to_owned(), Instant::now())
            .is_ok());
    }

    #[tokio::test]
    async fn file_io_invalid_header_and_json_body_never_write_files() {
        let directory = TestDirectory::new();
        let path = directory.path("无效请求.xlsx");
        let registry = BinaryExportRegistry::default();
        let export_id = prepare(&registry, &path);
        let raw = InvokeBody::Raw(vec![0xff]);
        assert!(
            write_binary_export_payload(&HeaderMap::new(), &raw, &registry)
                .await
                .is_err()
        );
        assert!(
            write_binary_export_payload(&headers("not-a-uuid"), &raw, &registry)
                .await
                .is_err()
        );
        let mut non_ascii = HeaderMap::new();
        non_ascii.insert(
            "x-db-connect-export-id",
            HeaderValue::from_bytes(&[0xff]).unwrap(),
        );
        assert!(write_binary_export_payload(&non_ascii, &raw, &registry)
            .await
            .is_err());
        let json = InvokeBody::Json(serde_json::json!([0, 255]));
        assert!(
            write_binary_export_payload(&headers(&export_id), &json, &registry)
                .await
                .is_err()
        );
        assert!(!path.exists());
        registry.cancel(&export_id, Instant::now()).unwrap();
    }
}
