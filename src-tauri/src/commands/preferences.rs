use crate::util::secure_fs::{set_secure_dir_permissions, set_secure_file_permissions};
use tauri::{AppHandle, Manager};

const TABLE_COLUMN_SETTINGS_FILE: &str = "table-column-settings.json";

/// 获取表列设置文件路径
fn get_table_column_settings_file(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("创建数据目录失败: {}", e))?;
    set_secure_dir_permissions(&data_dir)?;
    Ok(data_dir.join(TABLE_COLUMN_SETTINGS_FILE))
}

/// 获取表列设置（zustand persist 格式的 JSON 字符串）
#[tauri::command]
pub fn get_table_column_settings(app: AppHandle) -> Result<Option<String>, String> {
    let file_path = get_table_column_settings_file(&app)?;

    if !file_path.exists() {
        return Ok(None);
    }

    let content =
        std::fs::read_to_string(&file_path).map_err(|e| format!("读取列设置失败: {}", e))?;
    let content = content.trim();

    if content.is_empty() {
        return Ok(None);
    }

    Ok(Some(content.to_string()))
}

/// 保存表列设置
#[tauri::command]
pub fn save_table_column_settings(app: AppHandle, value: String) -> Result<(), String> {
    let file_path = get_table_column_settings_file(&app)?;
    std::fs::write(&file_path, value).map_err(|e| format!("写入列设置失败: {}", e))?;
    set_secure_file_permissions(&file_path)?;
    Ok(())
}

/// 删除表列设置（用于 clearStorage）
#[tauri::command]
pub fn delete_table_column_settings(app: AppHandle) -> Result<(), String> {
    let file_path = get_table_column_settings_file(&app)?;
    if file_path.exists() {
        std::fs::remove_file(&file_path).map_err(|e| format!("删除列设置失败: {}", e))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_settings_file_name() {
        assert_eq!(
            super::TABLE_COLUMN_SETTINGS_FILE,
            "table-column-settings.json"
        );
    }
}
