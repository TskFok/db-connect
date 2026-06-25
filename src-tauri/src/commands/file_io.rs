use base64::{engine::general_purpose::STANDARD, Engine as _};

/// 将文本写入用户通过系统对话框选择的路径
#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(path.as_str(), contents.as_bytes()).map_err(|e| format!("写入文件失败: {}", e))
}

/// 将 Base64 编码的二进制内容写入路径（供导出 xlsx 等）
#[tauri::command]
pub fn write_binary_file(path: String, contents_base64: String) -> Result<(), String> {
    let bytes = STANDARD
        .decode(contents_base64.trim())
        .map_err(|e| format!("解析文件内容失败: {}", e))?;
    std::fs::write(path.as_str(), bytes).map_err(|e| format!("写入文件失败: {}", e))
}
