use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeInfo {
    pub os_name: String,
    pub os_version: String,
    pub webkit_version: Option<String>,
    pub arch: String,
}

#[tauri::command]
pub fn get_runtime_info() -> RuntimeInfo {
    RuntimeInfo {
        os_name: current_os_name(),
        os_version: current_os_version(),
        webkit_version: current_webkit_version(),
        arch: std::env::consts::ARCH.to_string(),
    }
}

#[cfg(target_os = "macos")]
const WEBKIT_INFO_PLIST_PATH: &str =
    "/System/Library/Frameworks/WebKit.framework/Resources/Info.plist";

#[cfg(target_os = "macos")]
fn current_os_name() -> String {
    command_stdout("sw_vers", &["-productName"]).unwrap_or_else(|| "macOS".to_string())
}

#[cfg(not(target_os = "macos"))]
fn current_os_name() -> String {
    std::env::consts::OS.to_string()
}

#[cfg(target_os = "macos")]
fn current_os_version() -> String {
    command_stdout("sw_vers", &["-productVersion"]).unwrap_or_else(|| "unknown".to_string())
}

#[cfg(not(target_os = "macos"))]
fn current_os_version() -> String {
    "unknown".to_string()
}

#[cfg(target_os = "macos")]
fn current_webkit_version() -> Option<String> {
    let contents = std::fs::read_to_string(WEBKIT_INFO_PLIST_PATH).ok()?;
    parse_plist_string_value(&contents, "CFBundleVersion")
}

#[cfg(not(target_os = "macos"))]
fn current_webkit_version() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
fn command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8(output.stdout).ok()?;
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(any(target_os = "macos", test))]
fn parse_plist_string_value(contents: &str, key: &str) -> Option<String> {
    let key_tag = format!("<key>{}</key>", key);
    let key_pos = contents.find(&key_tag)?;
    let after_key = &contents[key_pos + key_tag.len()..];
    let string_start = after_key.find("<string>")?;
    let after_start = &after_key[string_start + "<string>".len()..];
    let string_end = after_start.find("</string>")?;
    let value = after_start[..string_end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::parse_plist_string_value;

    #[test]
    fn parse_plist_value_extracts_matching_string() {
        let contents = r#"
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleVersion</key>
  <string>21622.2.11.11.9</string>
</dict>
</plist>
"#;

        assert_eq!(
            parse_plist_string_value(contents, "CFBundleVersion"),
            Some("21622.2.11.11.9".to_string())
        );
    }

    #[test]
    fn parse_plist_value_returns_none_for_missing_key() {
        assert_eq!(
            parse_plist_string_value("<plist></plist>", "CFBundleVersion"),
            None
        );
    }
}
