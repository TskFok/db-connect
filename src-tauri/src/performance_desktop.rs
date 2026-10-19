//! 仅供显式 performance-desktop 构建使用的完整应用隔离守卫。
//! 默认构建不编译此模块，也不接受运行时开关启用。

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const PREFIX: &str = "com.tskfok.dbconnect.performance.";
const MARKER: &str = ".db-connect-performance.json";

#[derive(Deserialize)]
struct Marker {
    run_id: String,
    identifier: String,
}

pub struct Isolation {
    pub root: PathBuf,
    pub fixture: PathBuf,
    pub webview_store_id: [u8; 16],
}

static ISOLATION: OnceLock<Isolation> = OnceLock::new();

fn validate(
    identifier: &str,
    root: Option<&Path>,
    run_id: Option<&str>,
) -> Result<Isolation, String> {
    let root = root.ok_or("缺少 DB_CONNECT_PERFORMANCE_DIR，拒绝启动验收构建")?;
    let run_id = run_id.ok_or("缺少 DB_CONNECT_PERFORMANCE_RUN_ID，拒绝启动验收构建")?;
    let parsed = uuid::Uuid::parse_str(run_id).map_err(|_| "验收身份不是有效 UUID")?;
    if identifier != format!("{PREFIX}{}", parsed.simple()) {
        return Err("验收构建 identifier 与本次随机身份不匹配".into());
    }
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("验收目录不可用: {e}"))?;
    if !root.is_absolute() || canonical != root {
        return Err("验收目录必须是绝对规范路径，且不能经过符号链接".into());
    }
    // prepare 在系统临时目录建立唯一目录；不接受 HOME 或任意用户配置目录。
    let temp = std::env::temp_dir()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !canonical.starts_with(&temp)
        || canonical.file_name().and_then(|v| v.to_str())
            != Some(format!("db-connect-desktop-{}", parsed.simple()).as_str())
    {
        return Err("验收目录必须是系统临时目录下的本次随机目录".into());
    }
    let marker_path = canonical.join(MARKER);
    if std::fs::symlink_metadata(&marker_path)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("验收身份标记不能是符号链接".into());
    }
    let marker: Marker = serde_json::from_slice(
        &std::fs::read(marker_path).map_err(|e| format!("缺少验收身份标记: {e}"))?,
    )
    .map_err(|e| format!("验收身份标记无效: {e}"))?;
    if marker.run_id != run_id || marker.identifier != identifier {
        return Err("验收身份标记不匹配".into());
    }
    let fixture = canonical.join("synthetic.sqlite3");
    if fixture.canonicalize().map_err(|e| e.to_string())? != fixture {
        return Err("验收数据库不能是符号链接".into());
    }
    Ok(Isolation {
        root: canonical,
        fixture,
        webview_store_id: *parsed.as_bytes(),
    })
}

pub fn initialize(identifier: &str) -> Result<(), String> {
    let dir = std::env::var_os("DB_CONNECT_PERFORMANCE_DIR").map(PathBuf::from);
    let run_id = std::env::var("DB_CONNECT_PERFORMANCE_RUN_ID").ok();
    let isolation = validate(identifier, dir.as_deref(), run_id.as_deref())?;
    ISOLATION
        .set(isolation)
        .map_err(|_| "验收隔离已初始化".to_string())
}

pub fn isolation() -> Result<&'static Isolation, String> {
    ISOLATION
        .get()
        .ok_or_else(|| "验收隔离未初始化，拒绝访问持久化或密钥".into())
}

fn configure_window_storage_with(config: &mut tauri::Config, id: [u8; 16]) -> Result<(), String> {
    if config.app.windows.len() != 1 || config.app.windows[0].label != "main" {
        return Err("验收构建必须只有一个 main 主窗口".into());
    }
    // tauri-utils 2.8.3 的配置代码生成把该数组错误生成 Vec；运行时原生数组赋值
    // 发生在 Builder 创建之前，Tauri 随后仍按原配置创建完整主窗口。
    config.app.windows[0].data_store_identifier = Some(id);
    Ok(())
}

pub fn configure_window_storage(config: &mut tauri::Config) -> Result<(), String> {
    configure_window_storage_with(config, isolation()?.webview_store_id)
}

pub fn data_dir() -> Result<PathBuf, String> {
    let dir = isolation()?.root.join("config");
    if dir.exists() && dir.canonicalize().map_err(|e| e.to_string())? != dir {
        return Err("验收配置目录不能是符号链接".into());
    }
    Ok(dir)
}

pub fn validate_connection(config: &crate::models::types::ConnectionConfig) -> Result<(), String> {
    use crate::models::types::DatabaseType;
    if !matches!(config.database_type, DatabaseType::Sqlite)
        || config.ssh.is_some()
        || config.password.is_some()
        || config.ssl_ca_path.is_some()
        || config.ssl_pkcs12_path.is_some()
    {
        return Err("验收构建只允许本次合成 SQLite 连接".into());
    }
    let path = Path::new(config.sqlite_path.as_deref().unwrap_or(""));
    if path != isolation()?.fixture || path.canonicalize().map_err(|e| e.to_string())? != path {
        return Err("验收数据库路径与本次合成夹具不匹配".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, String, String) {
        let id = uuid::Uuid::new_v4();
        let root = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("db-connect-desktop-{}", id.simple()));
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("synthetic.sqlite3"), []).unwrap();
        (root, id.to_string(), format!("{PREFIX}{}", id.simple()))
    }

    #[test]
    fn missing_parameters_reject_before_any_storage_access() {
        assert!(validate("com.tskfok.dbconnect", None, None).is_err());
        assert!(validate("com.tskfok.dbconnect", Some(Path::new("/")), None).is_err());
    }

    #[test]
    fn production_identifier_is_rejected() {
        let (root, run_id, _) = fixture();
        assert!(validate("com.tskfok.dbconnect", Some(&root), Some(&run_id)).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_or_mismatched_marker_is_rejected_and_matching_marker_is_accepted() {
        let (root, run_id, identifier) = fixture();
        assert!(validate(&identifier, Some(&root), Some(&run_id)).is_err());
        let marker_path = root.join(MARKER);
        std::fs::write(
            &marker_path,
            serde_json::json!({"run_id": "wrong", "identifier": identifier}).to_string(),
        )
        .unwrap();
        assert!(validate(&identifier, Some(&root), Some(&run_id)).is_err());
        std::fs::write(
            &marker_path,
            serde_json::json!({"run_id": run_id, "identifier": identifier}).to_string(),
        )
        .unwrap();
        let accepted = validate(&identifier, Some(&root), Some(&run_id)).unwrap();
        assert_eq!(accepted.root, root);
        assert_eq!(accepted.fixture, root.join("synthetic.sqlite3"));
        assert_eq!(
            accepted.webview_store_id,
            *uuid::Uuid::parse_str(&run_id).unwrap().as_bytes()
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn window_storage_uses_exact_run_uuid_before_window_creation() {
        let mut config = tauri::Config::default();
        let id = *uuid::Uuid::new_v4().as_bytes();
        assert!(configure_window_storage_with(&mut config, id).is_err());
        config
            .app
            .windows
            .push(tauri::utils::config::WindowConfig::default());
        configure_window_storage_with(&mut config, id).unwrap();
        assert_eq!(config.app.windows[0].data_store_identifier, Some(id));
        config
            .app
            .windows
            .push(tauri::utils::config::WindowConfig::default());
        assert!(configure_window_storage_with(&mut config, id).is_err());
    }
}
