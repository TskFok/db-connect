use crate::crypto;
use crate::db::connection::{ConnectionManager, DatabasePoolHandle};
use crate::db::{postgres, sqlite, sqlserver};
use crate::models::types::{
    redact_connection_secrets, ConnectionConfig, ConnectionGroup, TestResult, PASSWORD_REDACTED,
};
use crate::util::secure_fs::{set_secure_dir_permissions, set_secure_file_permissions};
use crate::AppState;
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use pbkdf2::pbkdf2_hmac;
use rand_core::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;
use std::collections::HashMap;
use tauri::{AppHandle, Manager, State};

const CONNECTION_EXPORT_FORMAT: &str = "db-connect.connections";
const CONNECTION_EXPORT_VERSION: u32 = 1;
const CONNECTION_EXPORT_ENCRYPTED_FORMAT: &str = "db-connect.connections.encrypted";
const CONNECTION_EXPORT_ENCRYPTED_VERSION: u32 = 2;
const CONNECTION_EXPORT_KDF: &str = "pbkdf2-sha256";
const CONNECTION_EXPORT_KDF_ITERATIONS: u32 = 100_000;
const CONNECTION_EXPORT_SALT_SIZE: usize = 16;
const CONNECTION_EXPORT_NONCE_SIZE: usize = 12;
const CONNECTION_EXPORT_KEY_SIZE: usize = 32;

/// 存储文件格式：版本 2 为加密格式
#[derive(Debug, Serialize, Deserialize)]
struct StorageFile {
    version: u32,
    data: String, // version 2: base64 加密的 JSON
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConnectionStorageData {
    #[serde(default)]
    connections: Vec<ConnectionConfig>,
    #[serde(default)]
    groups: Vec<ConnectionGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectionImportResult {
    pub imported_connections: usize,
    pub imported_groups: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConnectionTransferFile {
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    connections: Vec<ConnectionConfig>,
    #[serde(default)]
    groups: Vec<ConnectionGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedConnectionTransferFile {
    format: String,
    version: u32,
    kdf: String,
    iterations: u32,
    salt: String,
    nonce: String,
    data: String,
}

fn parse_connection_storage_json(content: &str) -> Result<ConnectionStorageData, String> {
    if let Ok(connections) = serde_json::from_str::<Vec<ConnectionConfig>>(content) {
        return Ok(ConnectionStorageData {
            connections,
            groups: Vec::new(),
        });
    }
    serde_json::from_str::<ConnectionStorageData>(content)
        .map_err(|e| format!("解析配置失败: {}", e))
}

fn parse_connection_transfer_json(content: &str) -> Result<ConnectionStorageData, String> {
    let value =
        serde_json::from_str::<Value>(content).map_err(|e| format!("解析导入文件失败: {}", e))?;

    match value {
        Value::Array(_) => parse_connection_storage_json(content),
        Value::Object(ref object)
            if object.contains_key("connections")
                || object.contains_key("groups")
                || object.contains_key("format") =>
        {
            let transfer = serde_json::from_str::<ConnectionTransferFile>(content)
                .map_err(|e| format!("解析导入文件失败: {}", e))?;
            if let Some(format) = transfer.format.as_deref() {
                if format != CONNECTION_EXPORT_FORMAT {
                    return Err("导入文件格式不正确".to_string());
                }
            }
            if let Some(version) = transfer.version {
                if version > CONNECTION_EXPORT_VERSION {
                    return Err("导入文件版本过高，请升级应用后重试".to_string());
                }
            }
            Ok(ConnectionStorageData {
                connections: transfer.connections,
                groups: transfer.groups,
            })
        }
        _ => Err("导入文件格式不正确".to_string()),
    }
}

fn export_connection_storage_json(storage: &ConnectionStorageData) -> Result<String, String> {
    let transfer = ConnectionTransferFile {
        format: Some(CONNECTION_EXPORT_FORMAT.to_string()),
        version: Some(CONNECTION_EXPORT_VERSION),
        connections: storage.connections.clone(),
        groups: storage.groups.clone(),
    };
    serde_json::to_string_pretty(&transfer).map_err(|e| format!("序列化导出文件失败: {}", e))
}

fn validate_transfer_password(password: &str) -> Result<&str, String> {
    if password.trim().is_empty() {
        return Err("导入导出密码不能为空".to_string());
    }
    Ok(password)
}

fn derive_transfer_key(
    password: &str,
    salt: &[u8],
    iterations: u32,
) -> Result<[u8; CONNECTION_EXPORT_KEY_SIZE], String> {
    if iterations == 0 {
        return Err("导入文件加密参数无效".to_string());
    }
    let mut key = [0u8; CONNECTION_EXPORT_KEY_SIZE];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut key);
    Ok(key)
}

fn export_connection_storage_encrypted_json(
    storage: &ConnectionStorageData,
    password: &str,
) -> Result<String, String> {
    let password = validate_transfer_password(password)?;
    let plaintext = export_connection_storage_json(storage)?;

    let mut salt = [0u8; CONNECTION_EXPORT_SALT_SIZE];
    rand_core::OsRng.fill_bytes(&mut salt);
    let key = derive_transfer_key(password, &salt, CONNECTION_EXPORT_KDF_ITERATIONS)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("创建导出加密器失败: {}", e))?;

    let mut nonce = [0u8; CONNECTION_EXPORT_NONCE_SIZE];
    rand_core::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
        .map_err(|e| format!("导出加密失败: {}", e))?;

    let encrypted = EncryptedConnectionTransferFile {
        format: CONNECTION_EXPORT_ENCRYPTED_FORMAT.to_string(),
        version: CONNECTION_EXPORT_ENCRYPTED_VERSION,
        kdf: CONNECTION_EXPORT_KDF.to_string(),
        iterations: CONNECTION_EXPORT_KDF_ITERATIONS,
        salt: BASE64.encode(salt),
        nonce: BASE64.encode(nonce),
        data: BASE64.encode(ciphertext),
    };

    serde_json::to_string_pretty(&encrypted).map_err(|e| format!("序列化导出文件失败: {}", e))
}

fn decrypt_connection_transfer_json(content: &str, password: &str) -> Result<String, String> {
    let password = validate_transfer_password(password)?;
    let envelope = serde_json::from_str::<EncryptedConnectionTransferFile>(content)
        .map_err(|_| "导入文件格式不正确或未加密".to_string())?;

    if envelope.format != CONNECTION_EXPORT_ENCRYPTED_FORMAT {
        return Err("导入文件格式不正确".to_string());
    }
    if envelope.version > CONNECTION_EXPORT_ENCRYPTED_VERSION {
        return Err("导入文件版本过高，请升级应用后重试".to_string());
    }
    if envelope.kdf != CONNECTION_EXPORT_KDF {
        return Err("导入文件加密参数不受支持".to_string());
    }

    let salt = BASE64
        .decode(envelope.salt)
        .map_err(|_| "导入文件加密参数无效".to_string())?;
    let nonce = BASE64
        .decode(envelope.nonce)
        .map_err(|_| "导入文件加密参数无效".to_string())?;
    let ciphertext = BASE64
        .decode(envelope.data)
        .map_err(|_| "导入文件加密参数无效".to_string())?;
    if nonce.len() != CONNECTION_EXPORT_NONCE_SIZE {
        return Err("导入文件加密参数无效".to_string());
    }

    let key = derive_transfer_key(password, &salt, envelope.iterations)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("创建导入解密器失败: {}", e))?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "解密失败：密码错误或导入文件已损坏".to_string())?;

    String::from_utf8(plaintext).map_err(|_| "解密后的导入文件编码无效".to_string())
}

fn import_connection_storage_json(
    storage: &mut ConnectionStorageData,
    content: &str,
) -> Result<ConnectionImportResult, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("导入文件为空".to_string());
    }

    let imported = parse_connection_transfer_json(content)?;
    let imported_groups = imported.groups.len();
    let imported_connections = imported.connections.len();

    let mut group_id_map = HashMap::new();
    for mut group in imported.groups {
        let old_id = group.id.clone();
        group.id = uuid::Uuid::new_v4().to_string();
        group_id_map.insert(old_id, group.id.clone());
        storage.groups.push(group);
    }

    for mut conn in imported.connections {
        conn.id = Some(uuid::Uuid::new_v4().to_string());
        conn.group_id = conn
            .group_id
            .as_deref()
            .and_then(|id| group_id_map.get(id))
            .cloned();
        storage.connections.push(conn);
    }

    Ok(ConnectionImportResult {
        imported_connections,
        imported_groups,
    })
}

fn import_encrypted_connection_storage_json(
    storage: &mut ConnectionStorageData,
    content: &str,
    password: &str,
) -> Result<ConnectionImportResult, String> {
    let decrypted = decrypt_connection_transfer_json(content, password)?;
    import_connection_storage_json(storage, &decrypted)
}

/// 对连接配置中的密码进行脱敏
pub(crate) fn mask_passwords(config: &mut ConnectionConfig) {
    redact_connection_secrets(config);
}

/// 获取连接配置文件路径
fn get_connections_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败: {}", e))?;
    set_secure_dir_permissions(&data_dir)?;
    Ok(data_dir.join("connections.json"))
}

/// 从文件加载已保存的连接配置（内部使用，返回解密后的完整配置）
fn load_connection_storage_internal(app: &AppHandle) -> Result<ConnectionStorageData, String> {
    let file_path = get_connections_file(app)?;

    if !file_path.exists() {
        return Ok(ConnectionStorageData {
            connections: Vec::new(),
            groups: Vec::new(),
        });
    }

    let content =
        std::fs::read_to_string(&file_path).map_err(|e| format!("读取配置文件失败: {}", e))?;
    let content = content.trim();

    if content.is_empty() {
        return Ok(ConnectionStorageData {
            connections: Vec::new(),
            groups: Vec::new(),
        });
    }

    // 尝试解析为存储格式
    if let Ok(storage) = serde_json::from_str::<StorageFile>(content) {
        if storage.version == 2 {
            let decrypted = crypto::decrypt(&storage.data)?;
            let decrypted_str =
                String::from_utf8(decrypted).map_err(|e| format!("解密数据编码错误: {}", e))?;
            return parse_connection_storage_json(&decrypted_str);
        }
    }

    // 兼容旧版明文格式 (version 1)
    parse_connection_storage_json(content).map_err(|e| format!("解析配置文件失败: {}", e))
}

fn load_saved_connections_internal(app: &AppHandle) -> Result<Vec<ConnectionConfig>, String> {
    Ok(load_connection_storage_internal(app)?.connections)
}

/// 保存连接配置到文件（加密存储）
fn save_connection_storage_to_file(
    app: &AppHandle,
    storage_data: &ConnectionStorageData,
) -> Result<(), String> {
    let file_path = get_connections_file(app)?;
    let json = serde_json::to_vec(storage_data).map_err(|e| format!("序列化配置失败: {}", e))?;
    let encrypted = crypto::encrypt(&json)?;
    let storage = StorageFile {
        version: 2,
        data: encrypted,
    };
    let content =
        serde_json::to_string_pretty(&storage).map_err(|e| format!("序列化存储文件失败: {}", e))?;
    std::fs::write(&file_path, content).map_err(|e| format!("写入配置文件失败: {}", e))?;
    set_secure_file_permissions(&file_path)?;
    Ok(())
}

fn save_connections_to_file(
    app: &AppHandle,
    connections: Vec<ConnectionConfig>,
) -> Result<(), String> {
    let mut storage = load_connection_storage_internal(app)?;
    storage.connections = connections;
    save_connection_storage_to_file(app, &storage)
}

fn find_group_index(storage: &ConnectionStorageData, id: &str) -> Option<usize> {
    storage.groups.iter().position(|g| g.id == id)
}

fn validate_group_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("分组名称不能为空".to_string());
    }
    Ok(trimmed.to_string())
}

fn create_group_in_storage(
    storage: &mut ConnectionStorageData,
    name: String,
) -> Result<ConnectionGroup, String> {
    let name = validate_group_name(&name)?;
    let group = ConnectionGroup {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        collapsed: false,
    };
    storage.groups.insert(0, group.clone());
    Ok(group)
}

fn rename_group_in_storage(
    storage: &mut ConnectionStorageData,
    id: &str,
    name: String,
) -> Result<(), String> {
    let name = validate_group_name(&name)?;
    let index = find_group_index(storage, id).ok_or_else(|| "连接分组不存在".to_string())?;
    storage.groups[index].name = name;
    Ok(())
}

fn delete_group_from_storage(storage: &mut ConnectionStorageData, id: &str) -> Result<(), String> {
    let index = find_group_index(storage, id).ok_or_else(|| "连接分组不存在".to_string())?;
    storage.groups.remove(index);
    for conn in storage.connections.iter_mut() {
        if conn.group_id.as_deref() == Some(id) {
            conn.group_id = None;
        }
    }
    Ok(())
}

fn set_group_collapsed_in_storage(
    storage: &mut ConnectionStorageData,
    id: &str,
    collapsed: bool,
) -> Result<(), String> {
    let index = find_group_index(storage, id).ok_or_else(|| "连接分组不存在".to_string())?;
    storage.groups[index].collapsed = collapsed;
    Ok(())
}

fn reorder_groups_in_storage(
    storage: &mut ConnectionStorageData,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    if ordered_ids.is_empty() {
        return Ok(());
    }

    let id_set: std::collections::HashSet<&str> = ordered_ids.iter().map(|s| s.as_str()).collect();
    let mut reordered: Vec<ConnectionGroup> = Vec::with_capacity(storage.groups.len());
    for id in &ordered_ids {
        if let Some(group) = storage.groups.iter().find(|g| g.id == *id) {
            reordered.push(group.clone());
        }
    }
    for group in storage.groups.iter() {
        if !id_set.contains(group.id.as_str()) {
            reordered.push(group.clone());
        }
    }
    storage.groups = reordered;
    Ok(())
}

fn move_connection_to_group_in_storage(
    storage: &mut ConnectionStorageData,
    connection_id: &str,
    group_id: Option<String>,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    if let Some(ref id) = group_id {
        if find_group_index(storage, id).is_none() {
            return Err("连接分组不存在".to_string());
        }
    }
    let mut moved = false;
    for conn in storage.connections.iter_mut() {
        if conn.id.as_deref() == Some(connection_id) {
            conn.group_id = group_id.clone();
            moved = true;
            break;
        }
    }
    if !moved {
        return Err("连接配置不存在".to_string());
    }

    if ordered_ids.is_empty() {
        return Ok(());
    }

    let id_set: std::collections::HashSet<&str> = ordered_ids.iter().map(|s| s.as_str()).collect();
    let mut reordered: Vec<ConnectionConfig> = Vec::with_capacity(storage.connections.len());
    for id in &ordered_ids {
        if let Some(conn) = storage
            .connections
            .iter()
            .find(|c| c.id.as_deref() == Some(id))
        {
            reordered.push(conn.clone());
        }
    }
    for conn in storage.connections.iter() {
        if let Some(ref id) = conn.id {
            if !id_set.contains(id.as_str()) {
                reordered.push(conn.clone());
            }
        } else {
            reordered.push(conn.clone());
        }
    }
    storage.connections = reordered;
    Ok(())
}

/// 测试数据库连接
#[tauri::command]
pub async fn test_connection(config: ConnectionConfig) -> Result<TestResult, String> {
    match ConnectionManager::test_connection(&config).await {
        Ok(latency_ms) => Ok(TestResult {
            success: true,
            message: format!("连接成功! 延迟: {}ms", latency_ms),
            latency_ms,
        }),
        Err(e) => Ok(TestResult {
            success: false,
            message: format!("连接失败: {}", e),
            latency_ms: 0,
        }),
    }
}

/// 建立数据库连接
#[tauri::command]
pub async fn connect(
    state: State<'_, AppState>,
    config: ConnectionConfig,
) -> Result<String, String> {
    // 慢速 I/O（SSH 隧道、建池、SELECT 1 测试）在锁外完成，避免阻塞其它连接的所有命令
    let (conn_id, active) = ConnectionManager::prepare_connection(config).await?;
    let mut manager = state.connection_manager.lock().await;
    manager.register(conn_id.clone(), active);
    Ok(conn_id)
}

/// 断开数据库连接
#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, conn_id: String) -> Result<(), String> {
    let mut manager = state.connection_manager.lock().await;
    manager.disconnect(&conn_id).await
}

/// 探测连接是否仍然可用（带超时，SELECT 1）。
/// 用于屏幕休眠 / 网络切换后恢复时检查连接是否已被对端掐断。
/// 返回 true 表示存活；false 表示已失效或不存在。
#[tauri::command]
pub async fn ping_connection(state: State<'_, AppState>, conn_id: String) -> Result<bool, String> {
    // 仅在锁内克隆连接池引用，带超时的 SELECT 1 探测在锁外执行，避免长时间持锁阻塞其它命令
    let pool = {
        let manager = state.connection_manager.lock().await;
        manager.pool_for_ping(&conn_id)
    };
    match pool {
        Some(DatabasePoolHandle::MySql(pool)) => Ok(ConnectionManager::ping_pool(&pool).await),
        Some(DatabasePoolHandle::Postgres(handle)) => Ok(postgres::ping_pool(&handle.pool).await),
        Some(DatabasePoolHandle::Sqlite(handle)) => Ok(sqlite::ping_pool(&handle.pool).await),
        Some(DatabasePoolHandle::SqlServer(handle)) => Ok(sqlserver::ping_pool(&handle.pool).await),
        None => Ok(false),
    }
}

/// 强制清理连接（不报错地移除，尽力关闭底层资源）。
/// 用于连接已被对端 / 中间设备 / 系统休眠掐断、常规 disconnect 可能卡住的场景。
#[tauri::command]
pub async fn force_disconnect(state: State<'_, AppState>, conn_id: String) -> Result<(), String> {
    let mut manager = state.connection_manager.lock().await;
    manager.force_remove(&conn_id).await
}

/// 检查空闲超时并断开连接，减少凭据驻留时间
/// 若连接空闲超过 idle_timeout_secs 秒则断开，返回 true；否则返回 false
#[tauri::command]
pub async fn check_idle_disconnect(
    state: State<'_, AppState>,
    conn_id: String,
    idle_timeout_secs: u64,
) -> Result<bool, String> {
    let mut manager = state.connection_manager.lock().await;
    manager
        .check_idle_and_disconnect(&conn_id, idle_timeout_secs)
        .await
}

/// 保存连接配置
#[tauri::command]
pub async fn save_connection(app: AppHandle, mut config: ConnectionConfig) -> Result<(), String> {
    let mut storage = load_connection_storage_internal(&app)?;

    match config.id.clone() {
        None => {
            config.id = Some(uuid::Uuid::new_v4().to_string());
            storage.connections.push(config);
        }
        Some(id) => {
            if let Some(existing) = storage
                .connections
                .iter_mut()
                .find(|c| c.id.as_deref() == Some(&id))
            {
                // 编辑时若密码为占位符，保留原密码
                if config.password.as_deref() == Some(PASSWORD_REDACTED) {
                    config.password = existing.password.clone();
                }
                if let (Some(ref mut new_ssh), Some(ref old_ssh)) = (&mut config.ssh, &existing.ssh)
                {
                    if new_ssh.password.as_deref() == Some(PASSWORD_REDACTED) {
                        new_ssh.password = old_ssh.password.clone();
                    }
                }
                *existing = config;
            } else {
                storage.connections.push(config);
            }
        }
    }

    save_connection_storage_to_file(&app, &storage)?;
    Ok(())
}

/// 获取所有已保存的连接配置（密码已脱敏，用于列表展示）
#[tauri::command]
pub async fn list_saved_connections(app: AppHandle) -> Result<Vec<ConnectionConfig>, String> {
    let mut connections = load_saved_connections_internal(&app)?;
    for c in connections.iter_mut() {
        mask_passwords(c);
    }
    Ok(connections)
}

/// 获取连接分组
#[tauri::command]
pub async fn list_connection_groups(app: AppHandle) -> Result<Vec<ConnectionGroup>, String> {
    Ok(load_connection_storage_internal(&app)?.groups)
}

/// 创建连接分组
#[tauri::command]
pub async fn create_connection_group(
    app: AppHandle,
    name: String,
) -> Result<ConnectionGroup, String> {
    let mut storage = load_connection_storage_internal(&app)?;
    let group = create_group_in_storage(&mut storage, name)?;
    save_connection_storage_to_file(&app, &storage)?;
    Ok(group)
}

/// 重命名连接分组
#[tauri::command]
pub async fn rename_connection_group(
    app: AppHandle,
    id: String,
    name: String,
) -> Result<(), String> {
    let mut storage = load_connection_storage_internal(&app)?;
    rename_group_in_storage(&mut storage, &id, name)?;
    save_connection_storage_to_file(&app, &storage)?;
    Ok(())
}

/// 删除连接分组；组内连接回到未分组
#[tauri::command]
pub async fn delete_connection_group(app: AppHandle, id: String) -> Result<(), String> {
    let mut storage = load_connection_storage_internal(&app)?;
    delete_group_from_storage(&mut storage, &id)?;
    save_connection_storage_to_file(&app, &storage)?;
    Ok(())
}

/// 设置连接分组折叠状态
#[tauri::command]
pub async fn set_connection_group_collapsed(
    app: AppHandle,
    id: String,
    collapsed: bool,
) -> Result<(), String> {
    let mut storage = load_connection_storage_internal(&app)?;
    set_group_collapsed_in_storage(&mut storage, &id, collapsed)?;
    save_connection_storage_to_file(&app, &storage)?;
    Ok(())
}

/// 按指定顺序重新排列连接分组
#[tauri::command]
pub async fn reorder_connection_groups(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let mut storage = load_connection_storage_internal(&app)?;
    reorder_groups_in_storage(&mut storage, ids)?;
    save_connection_storage_to_file(&app, &storage)?;
    Ok(())
}

/// 移动连接到分组并保存新的全局连接顺序
#[tauri::command]
pub async fn move_connection_to_group(
    app: AppHandle,
    connection_id: String,
    group_id: Option<String>,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    let mut storage = load_connection_storage_internal(&app)?;
    move_connection_to_group_in_storage(&mut storage, &connection_id, group_id, ordered_ids)?;
    save_connection_storage_to_file(&app, &storage)?;
    Ok(())
}

/// 获取指定连接的完整配置（含解密后的密码，仅用于编辑和连接时）
#[tauri::command]
pub async fn get_decrypted_connection(
    app: AppHandle,
    id: String,
) -> Result<ConnectionConfig, String> {
    let connections = load_saved_connections_internal(&app)?;
    connections
        .into_iter()
        .find(|c| c.id.as_deref() == Some(&id))
        .ok_or_else(|| "连接配置不存在".to_string())
}

/// 删除已保存的连接配置
#[tauri::command]
pub async fn delete_saved_connection(app: AppHandle, id: String) -> Result<(), String> {
    let mut connections = load_saved_connections_internal(&app)?;
    connections.retain(|c| c.id.as_deref() != Some(&id));
    save_connections_to_file(&app, connections)?;
    Ok(())
}

/// 按指定顺序重新排列连接（用于自定义显示顺序）
#[tauri::command]
pub async fn reorder_connections(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let connections = load_saved_connections_internal(&app)?;
    if ids.is_empty() {
        return Ok(());
    }
    let id_set: std::collections::HashSet<&str> = ids.iter().map(|s| s.as_str()).collect();
    let mut reordered: Vec<ConnectionConfig> = Vec::with_capacity(connections.len());
    for id in &ids {
        if let Some(conn) = connections.iter().find(|c| c.id.as_deref() == Some(id)) {
            reordered.push(conn.clone());
        }
    }
    for conn in connections.iter() {
        if let Some(ref id) = conn.id {
            if !id_set.contains(id.as_str()) {
                reordered.push(conn.clone());
            }
        }
    }
    save_connections_to_file(&app, reordered)?;
    Ok(())
}

/// 导出所有保存的连接和分组；内容使用迁移密码加密
#[tauri::command]
pub async fn export_connections(
    app: AppHandle,
    path: String,
    password: String,
) -> Result<usize, String> {
    let storage = load_connection_storage_internal(&app)?;
    let content = export_connection_storage_encrypted_json(&storage, &password)?;
    let file_path = std::path::PathBuf::from(path);
    std::fs::write(&file_path, content).map_err(|e| format!("写入导出文件失败: {}", e))?;
    set_secure_file_permissions(&file_path)?;
    Ok(storage.connections.len())
}

/// 从加密迁移文件导入连接和分组；始终合并并生成新 ID，不覆盖现有配置
#[tauri::command]
pub async fn import_connections(
    app: AppHandle,
    path: String,
    password: String,
) -> Result<ConnectionImportResult, String> {
    let content = std::fs::read_to_string(path).map_err(|e| format!("读取导入文件失败: {}", e))?;
    let mut storage = load_connection_storage_internal(&app)?;
    let result = import_encrypted_connection_storage_json(&mut storage, &content, &password)?;
    save_connection_storage_to_file(&app, &storage)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{DatabaseType, SshConfig};

    #[test]
    fn test_mask_passwords() {
        let mut config = ConnectionConfig {
            id: Some("1".to_string()),
            database_type: DatabaseType::MySql,
            name: "test".to_string(),
            host: "localhost".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: Some("secret123".to_string()),
            database: None,
            sqlite_path: None,
            ssh: Some(SshConfig {
                host: "sshhost".to_string(),
                port: 22,
                username: "sshuser".to_string(),
                password: Some("sshpass".to_string()),
                private_key_path: None,
            }),
            ssl_mode: None,
            ssl_ca_path: None,
            ssl_pkcs12_path: None,
            ssl_pkcs12_password: Some("pk12secret".to_string()),
            ssl_tls_hostname: None,
            client_charset: None,
            session_init_commands: None,
            read_only: None,
            skip_dangerous_sql_confirm: None,
            group_id: None,
        };

        mask_passwords(&mut config);

        assert_eq!(config.password, Some(PASSWORD_REDACTED.to_string()));
        assert_eq!(
            config.ssh.as_ref().unwrap().password,
            Some(PASSWORD_REDACTED.to_string())
        );
        assert_eq!(
            config.ssl_pkcs12_password,
            Some(PASSWORD_REDACTED.to_string())
        );
    }

    #[test]
    fn test_mask_passwords_empty() {
        let mut config = ConnectionConfig {
            id: Some("1".to_string()),
            database_type: DatabaseType::MySql,
            name: "test".to_string(),
            host: "localhost".to_string(),
            port: 3306,
            username: "root".to_string(),
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
            read_only: None,
            skip_dangerous_sql_confirm: None,
            group_id: None,
        };

        mask_passwords(&mut config);
        assert!(config.password.is_none());
    }

    #[test]
    fn test_parse_connection_storage_accepts_legacy_array() {
        let json = r#"[{
            "id": "conn-1",
            "name": "Local",
            "host": "localhost",
            "port": 3306,
            "username": "root",
            "password": null,
            "database": null,
            "ssh": null
        }]"#;

        let storage = parse_connection_storage_json(json).expect("legacy array should parse");

        assert_eq!(storage.connections.len(), 1);
        assert_eq!(storage.connections[0].id.as_deref(), Some("conn-1"));
        assert!(storage.connections[0].group_id.is_none());
        assert!(storage.groups.is_empty());
    }

    #[test]
    fn test_delete_group_keeps_connections_and_moves_them_to_ungrouped() {
        let mut storage = ConnectionStorageData {
            groups: vec![ConnectionGroup {
                id: "group-1".to_string(),
                name: "Dev".to_string(),
                collapsed: false,
            }],
            connections: vec![ConnectionConfig {
                id: Some("conn-1".to_string()),
                database_type: DatabaseType::MySql,
                name: "Local".to_string(),
                host: "localhost".to_string(),
                port: 3306,
                username: "root".to_string(),
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
                read_only: None,
                skip_dangerous_sql_confirm: None,
                group_id: Some("group-1".to_string()),
            }],
        };

        delete_group_from_storage(&mut storage, "group-1").expect("group should delete");

        assert!(storage.groups.is_empty());
        assert_eq!(storage.connections.len(), 1);
        assert!(storage.connections[0].group_id.is_none());
    }

    #[test]
    fn test_create_group_inserts_new_group_at_top() {
        let mut storage = ConnectionStorageData {
            groups: vec![ConnectionGroup {
                id: "group-1".to_string(),
                name: "Dev".to_string(),
                collapsed: false,
            }],
            connections: vec![],
        };

        let group =
            create_group_in_storage(&mut storage, "Prod".to_string()).expect("group should create");

        assert_eq!(storage.groups[0].id, group.id);
        assert_eq!(storage.groups[0].name, "Prod");
        assert_eq!(storage.groups[1].id, "group-1");
    }

    #[test]
    fn test_reorder_groups_keeps_missing_groups_after_ordered_ids() {
        let mut storage = ConnectionStorageData {
            groups: vec![
                ConnectionGroup {
                    id: "group-1".to_string(),
                    name: "Dev".to_string(),
                    collapsed: false,
                },
                ConnectionGroup {
                    id: "group-2".to_string(),
                    name: "Stage".to_string(),
                    collapsed: false,
                },
                ConnectionGroup {
                    id: "group-3".to_string(),
                    name: "Prod".to_string(),
                    collapsed: true,
                },
            ],
            connections: vec![],
        };

        reorder_groups_in_storage(
            &mut storage,
            vec!["group-3".to_string(), "group-1".to_string()],
        )
        .expect("groups should reorder");

        let ids: Vec<&str> = storage
            .groups
            .iter()
            .map(|group| group.id.as_str())
            .collect();
        assert_eq!(ids, vec!["group-3", "group-1", "group-2"]);
    }

    #[test]
    fn test_export_connection_storage_json_includes_connections_and_groups() {
        let storage = ConnectionStorageData {
            groups: vec![ConnectionGroup {
                id: "group-1".to_string(),
                name: "Dev".to_string(),
                collapsed: false,
            }],
            connections: vec![ConnectionConfig {
                id: Some("conn-1".to_string()),
                database_type: DatabaseType::MySql,
                name: "Local".to_string(),
                host: "localhost".to_string(),
                port: 3306,
                username: "root".to_string(),
                password: Some("secret".to_string()),
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
                read_only: None,
                skip_dangerous_sql_confirm: None,
                group_id: Some("group-1".to_string()),
            }],
        };

        let json = export_connection_storage_json(&storage).expect("export should serialize");

        assert!(json.contains("\"format\": \"db-connect.connections\""));
        assert!(json.contains("\"password\": \"secret\""));
        assert!(json.contains("\"groups\""));
        assert!(json.contains("\"connections\""));
    }

    #[test]
    fn test_connection_transfer_json_preserves_sqlserver_type() {
        let json = r#"{
            "format": "db-connect.connections",
            "version": 1,
            "connections": [
                {
                    "id": "sqlserver-conn",
                    "database_type": "sqlserver",
                    "name": "SQL Server",
                    "host": "sql.example.com",
                    "port": 1433,
                    "username": "sa",
                    "password": null,
                    "database": "appdb",
                    "ssh": null
                }
            ],
            "groups": []
        }"#;

        let parsed = parse_connection_transfer_json(json).expect("transfer JSON should parse");

        assert_eq!(parsed.connections.len(), 1);
        assert_eq!(parsed.connections[0].database_type, DatabaseType::SqlServer);
        assert_eq!(parsed.connections[0].database.as_deref(), Some("appdb"));
    }

    #[test]
    fn test_export_connection_storage_json_includes_sqlserver_type() {
        let storage = ConnectionStorageData {
            groups: vec![],
            connections: vec![ConnectionConfig {
                id: Some("sqlserver-conn".to_string()),
                database_type: DatabaseType::SqlServer,
                name: "SQL Server".to_string(),
                host: "sql.example.com".to_string(),
                port: 1433,
                username: "sa".to_string(),
                password: Some("secret".to_string()),
                database: Some("appdb".to_string()),
                sqlite_path: None,
                ssh: None,
                ssl_mode: Some("required".to_string()),
                ssl_ca_path: None,
                ssl_pkcs12_path: None,
                ssl_pkcs12_password: None,
                ssl_tls_hostname: None,
                client_charset: None,
                session_init_commands: None,
                read_only: Some(true),
                skip_dangerous_sql_confirm: None,
                group_id: None,
            }],
        };

        let json = export_connection_storage_json(&storage).expect("export should serialize");
        let parsed = parse_connection_transfer_json(&json).expect("export should reparse");

        assert!(json.contains("\"database_type\": \"sqlserver\""));
        assert_eq!(parsed.connections[0].database_type, DatabaseType::SqlServer);
        assert_eq!(parsed.connections[0].port, 1433);
    }

    #[test]
    fn test_export_connection_storage_encrypted_json_hides_plaintext_and_decrypts() {
        let storage = ConnectionStorageData {
            groups: vec![ConnectionGroup {
                id: "group-1".to_string(),
                name: "Dev".to_string(),
                collapsed: false,
            }],
            connections: vec![ConnectionConfig {
                id: Some("conn-1".to_string()),
                database_type: DatabaseType::MySql,
                name: "Local".to_string(),
                host: "localhost".to_string(),
                port: 3306,
                username: "root".to_string(),
                password: Some("secret".to_string()),
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
                read_only: None,
                skip_dangerous_sql_confirm: None,
                group_id: Some("group-1".to_string()),
            }],
        };

        let encrypted = export_connection_storage_encrypted_json(&storage, "迁移密码")
            .expect("export should encrypt");

        assert!(encrypted.contains("\"format\": \"db-connect.connections.encrypted\""));
        let envelope: EncryptedConnectionTransferFile =
            serde_json::from_str(&encrypted).expect("encrypted envelope should parse");
        assert!(!envelope.data.is_empty());
        let plaintext_json =
            export_connection_storage_json(&storage).expect("plaintext export should serialize");
        assert_ne!(envelope.data, BASE64.encode(plaintext_json.as_bytes()));

        let public_metadata = serde_json::to_string_pretty(&EncryptedConnectionTransferFile {
            salt: String::new(),
            nonce: String::new(),
            data: String::new(),
            ..envelope
        })
        .expect("public metadata should serialize");
        assert!(!public_metadata.contains("\"password\": \"secret\""));
        assert!(!public_metadata.contains("Local"));
        assert!(!public_metadata.contains("Dev"));

        let decrypted = decrypt_connection_transfer_json(&encrypted, "迁移密码")
            .expect("password should decrypt");
        let parsed =
            parse_connection_transfer_json(&decrypted).expect("decrypted JSON should parse");

        assert_eq!(parsed.connections.len(), 1);
        assert_eq!(parsed.groups.len(), 1);
        assert_eq!(parsed.connections[0].password.as_deref(), Some("secret"));
        assert_eq!(parsed.connections[0].group_id.as_deref(), Some("group-1"));
    }

    #[test]
    fn test_decrypt_connection_transfer_json_rejects_wrong_password() {
        let storage = ConnectionStorageData {
            groups: vec![],
            connections: vec![ConnectionConfig {
                id: Some("conn-1".to_string()),
                database_type: DatabaseType::MySql,
                name: "Local".to_string(),
                host: "localhost".to_string(),
                port: 3306,
                username: "root".to_string(),
                password: Some("secret".to_string()),
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
                read_only: None,
                skip_dangerous_sql_confirm: None,
                group_id: None,
            }],
        };

        let encrypted =
            export_connection_storage_encrypted_json(&storage, "correct-password").unwrap();
        let err = decrypt_connection_transfer_json(&encrypted, "wrong-password")
            .expect_err("wrong password should fail");

        assert_eq!(err, "解密失败：密码错误或导入文件已损坏");
    }

    #[test]
    fn test_export_connection_storage_encrypted_json_rejects_empty_password() {
        let storage = ConnectionStorageData {
            groups: vec![],
            connections: vec![],
        };

        let err = export_connection_storage_encrypted_json(&storage, "   ")
            .expect_err("empty password should fail");

        assert_eq!(err, "导入导出密码不能为空");
    }

    #[test]
    fn test_import_encrypted_connection_storage_wrong_password_does_not_mutate_storage() {
        let mut storage = ConnectionStorageData {
            groups: vec![ConnectionGroup {
                id: "existing-group".to_string(),
                name: "Existing".to_string(),
                collapsed: false,
            }],
            connections: vec![ConnectionConfig {
                id: Some("existing-conn".to_string()),
                database_type: DatabaseType::MySql,
                name: "Existing".to_string(),
                host: "127.0.0.1".to_string(),
                port: 3306,
                username: "root".to_string(),
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
                read_only: None,
                skip_dangerous_sql_confirm: None,
                group_id: Some("existing-group".to_string()),
            }],
        };
        let import_storage = ConnectionStorageData {
            groups: vec![ConnectionGroup {
                id: "import-group".to_string(),
                name: "Imported".to_string(),
                collapsed: true,
            }],
            connections: vec![ConnectionConfig {
                id: Some("import-conn".to_string()),
                database_type: DatabaseType::MySql,
                name: "Imported Local".to_string(),
                host: "localhost".to_string(),
                port: 3306,
                username: "root".to_string(),
                password: Some("secret".to_string()),
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
                read_only: None,
                skip_dangerous_sql_confirm: None,
                group_id: Some("import-group".to_string()),
            }],
        };
        let encrypted =
            export_connection_storage_encrypted_json(&import_storage, "correct-password").unwrap();

        let err =
            import_encrypted_connection_storage_json(&mut storage, &encrypted, "wrong-password")
                .expect_err("wrong password should fail");

        assert_eq!(err, "解密失败：密码错误或导入文件已损坏");
        assert_eq!(storage.groups.len(), 1);
        assert_eq!(storage.connections.len(), 1);
        assert_eq!(storage.groups[0].id, "existing-group");
        assert_eq!(storage.connections[0].id.as_deref(), Some("existing-conn"));
    }

    #[test]
    fn test_import_encrypted_connection_storage_merges_with_correct_password() {
        let mut storage = ConnectionStorageData {
            groups: vec![],
            connections: vec![],
        };
        let import_storage = ConnectionStorageData {
            groups: vec![ConnectionGroup {
                id: "import-group".to_string(),
                name: "Imported".to_string(),
                collapsed: true,
            }],
            connections: vec![ConnectionConfig {
                id: Some("import-conn".to_string()),
                database_type: DatabaseType::MySql,
                name: "Imported Local".to_string(),
                host: "localhost".to_string(),
                port: 3306,
                username: "root".to_string(),
                password: Some("secret".to_string()),
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
                read_only: None,
                skip_dangerous_sql_confirm: None,
                group_id: Some("import-group".to_string()),
            }],
        };
        let encrypted =
            export_connection_storage_encrypted_json(&import_storage, "correct-password").unwrap();

        let result =
            import_encrypted_connection_storage_json(&mut storage, &encrypted, "correct-password")
                .expect("correct password should import");

        assert_eq!(result.imported_connections, 1);
        assert_eq!(result.imported_groups, 1);
        assert_eq!(storage.groups.len(), 1);
        assert_eq!(storage.connections.len(), 1);
        assert_ne!(storage.groups[0].id, "import-group");
        assert_ne!(storage.connections[0].id.as_deref(), Some("import-conn"));
        assert_eq!(
            storage.connections[0].group_id.as_deref(),
            Some(storage.groups[0].id.as_str())
        );
    }

    #[test]
    fn test_import_connection_storage_merges_with_new_ids_and_group_mapping() {
        let mut storage = ConnectionStorageData {
            groups: vec![ConnectionGroup {
                id: "existing-group".to_string(),
                name: "Existing".to_string(),
                collapsed: false,
            }],
            connections: vec![ConnectionConfig {
                id: Some("existing-conn".to_string()),
                database_type: DatabaseType::MySql,
                name: "Existing".to_string(),
                host: "127.0.0.1".to_string(),
                port: 3306,
                username: "root".to_string(),
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
                read_only: None,
                skip_dangerous_sql_confirm: None,
                group_id: Some("existing-group".to_string()),
            }],
        };
        let import_json = r#"{
            "format": "db-connect.connections",
            "version": 1,
            "groups": [
                { "id": "import-group", "name": "Imported", "collapsed": true }
            ],
            "connections": [
                {
                    "id": "import-conn",
                    "name": "Imported Local",
                    "host": "localhost",
                    "port": 3306,
                    "username": "root",
                    "password": "secret",
                    "database": null,
                    "ssh": null,
                    "group_id": "import-group"
                }
            ]
        }"#;

        let result =
            import_connection_storage_json(&mut storage, import_json).expect("import should merge");

        assert_eq!(result.imported_connections, 1);
        assert_eq!(result.imported_groups, 1);
        assert_eq!(storage.groups.len(), 2);
        assert_eq!(storage.connections.len(), 2);
        assert_ne!(storage.groups[1].id, "import-group");
        assert_ne!(storage.connections[1].id.as_deref(), Some("import-conn"));
        assert_eq!(
            storage.connections[1].group_id.as_deref(),
            Some(storage.groups[1].id.as_str())
        );
        assert_eq!(storage.connections[1].password.as_deref(), Some("secret"));
    }

    #[test]
    fn test_import_connection_storage_rejects_empty_file() {
        let mut storage = ConnectionStorageData {
            groups: vec![],
            connections: vec![],
        };

        let err = import_connection_storage_json(&mut storage, "   ")
            .expect_err("empty import should fail");

        assert_eq!(err, "导入文件为空");
    }
}
