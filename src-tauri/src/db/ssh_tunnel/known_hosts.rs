use std::io::Write;
use std::path::{Path, PathBuf};

use super::ensure_db_connect_data_dir;
use crate::util::secure_fs::{create_secure_file, set_secure_file_permissions};

pub async fn clear_known_host(host: String, port: u16) -> Result<bool, String> {
    let host = host.trim();
    if host.is_empty()
        || host.starts_with('-')
        || host
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "\\/,[]*?!|".contains(c))
    {
        return Err("请输入有效的 SSH 服务器地址，不能包含通配符或路径".to_string());
    }
    if port == 0 {
        return Err("SSH 端口必须在 1–65535 之间".to_string());
    }
    if cfg!(feature = "performance-desktop") {
        return Err("验收模式不支持清除 SSH 主机密钥缓存".to_string());
    }
    let host = host.to_string();
    let dir = ensure_db_connect_data_dir()?;
    clear_known_host_at(dir, host, port).await
}

async fn clear_known_host_at(dir: PathBuf, host: String, port: u16) -> Result<bool, String> {
    let guard = super::KNOWN_HOSTS_LOCK.lock().await;
    tokio::task::spawn_blocking(move || {
        // 即使调用方取消等待，后台文件操作结束前仍保持互斥。
        let _guard = guard;
        clear_known_host_in_dir(&dir, &host, port)
    })
    .await
    .map_err(|e| format!("清除 SSH 主机密钥缓存任务失败: {e}"))?
}

struct TemporaryCacheDir(PathBuf);

impl TemporaryCacheDir {
    fn create(parent: &Path) -> Result<Self, String> {
        let path = parent.join(format!(".ssh-known-hosts-{}", uuid::Uuid::new_v4()));
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder
            .create(&path)
            .map_err(|e| format!("创建主机密钥缓存临时目录失败: {e}"))?;
        Ok(Self(path))
    }
}

impl Drop for TemporaryCacheDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn clear_known_host_in_dir(dir: &Path, host: &str, port: u16) -> Result<bool, String> {
    let filename = if cfg!(target_os = "windows") {
        "ssh_known_hosts.json"
    } else {
        "ssh_openssh_known_hosts"
    };
    let path = dir.join(filename);
    match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("检查 SSH 主机密钥缓存失败: {e}")),
        Ok(meta) if !meta.file_type().is_file() => {
            return Err("SSH 主机密钥缓存不是普通文件，拒绝清理".to_string());
        }
        Ok(_) => {}
    }
    let original = std::fs::read(&path).map_err(|e| format!("读取 SSH 主机密钥缓存失败: {e}"))?;

    #[cfg(target_os = "windows")]
    let updated = match cleared_json_hosts(&original, host, port)? {
        Some(updated) => updated,
        None => return Ok(false),
    };
    #[cfg(not(target_os = "windows"))]
    let updated = original.clone();

    // 仅在私有临时副本上调用 ssh-keygen；成功后原子替换，工具失败不会破坏原记录。
    let staging_dir = TemporaryCacheDir::create(dir)?;
    let staging_path = staging_dir.0.join(filename);
    create_secure_file(&staging_path)?
        .write_all(&updated)
        .map_err(|e| format!("写入 SSH 主机密钥缓存临时文件失败: {e}"))?;

    #[cfg(not(target_os = "windows"))]
    {
        let host_id = if port == 22 {
            host.to_string()
        } else {
            format!("[{host}]:{port}")
        };
        let program = if cfg!(target_os = "macos") {
            "/usr/bin/ssh-keygen"
        } else {
            "ssh-keygen"
        };
        let matched = std::process::Command::new(program)
            .arg("-F")
            .arg(&host_id)
            .arg("-f")
            .arg(&staging_path)
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("查找 SSH 主机密钥缓存失败，请确认 ssh-keygen 可用: {e}"))?;
        if !matched.status.success() {
            if matched.status.code() == Some(1) && matched.stderr.is_empty() {
                return Ok(false);
            }
            return Err(format!(
                "查找 SSH 主机密钥缓存失败: {}",
                String::from_utf8_lossy(&matched.stderr).trim()
            ));
        }
        // 通配符/否定模式可能代表多台服务器，无法仅忘记其中一台，保留原记录。
        if String::from_utf8_lossy(&matched.stdout)
            .lines()
            .any(|line| {
                host_list_range(line).is_some_and(|range| line[range].contains(['*', '?', '!']))
            })
        {
            return Err("匹配的主机密钥记录包含通配符或排除规则，请手动编辑应用的 known_hosts 文件；未修改缓存".to_string());
        }
        // ssh-keygen -R 会删除整行，先拆分普通多主机列表，保留同行的其他主机与端口。
        let contents = std::str::from_utf8(&original)
            .map_err(|e| format!("SSH 主机密钥缓存编码无效，未修改原文件: {e}"))?;
        let mut expanded = String::new();
        for line in contents.lines() {
            match host_list_range(line) {
                Some(range)
                    if line[range.clone()].contains(',')
                        && !line[range.clone()].contains(['*', '?', '!']) =>
                {
                    for host in line[range.clone()].split(',') {
                        expanded.push_str(&line[..range.start]);
                        expanded.push_str(host);
                        expanded.push_str(&line[range.end..]);
                        expanded.push('\n');
                    }
                }
                _ => {
                    expanded.push_str(line);
                    expanded.push('\n');
                }
            }
        }
        create_secure_file(&staging_path)?
            .write_all(expanded.as_bytes())
            .map_err(|e| format!("准备 SSH 主机密钥缓存清理失败: {e}"))?;
        let output = std::process::Command::new(program)
            .arg("-R")
            .arg(&host_id)
            .arg("-f")
            .arg(&staging_path)
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("清除 SSH 主机密钥缓存失败，请确认 ssh-keygen 可用: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "清除 SSH 主机密钥缓存失败: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let updated = std::fs::read(&staging_path)
            .map_err(|e| format!("读取更新后的 SSH 主机密钥缓存失败: {e}"))?;
        if updated == original {
            return Ok(false);
        }
    }

    set_secure_file_permissions(&staging_path)?;
    // 若另一连接刚写入新记录，让用户重试，避免用旧快照覆盖它。
    if std::fs::read(&path).map_err(|e| format!("检查 SSH 主机密钥缓存更新失败: {e}"))? != original
    {
        return Err("SSH 主机密钥缓存已发生变化，请重试清理".to_string());
    }
    std::fs::rename(&staging_path, &path).map_err(|e| format!("保存 SSH 主机密钥缓存失败: {e}"))?;
    Ok(true)
}

#[cfg(not(target_os = "windows"))]
fn host_list_range(line: &str) -> Option<std::ops::Range<usize>> {
    let trimmed = line.trim_start();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }
    let mut start = line.len() - trimmed.len();
    if trimmed.starts_with('@') {
        let marker_end = trimmed.find(char::is_whitespace)?;
        let rest = trimmed[marker_end..].trim_start();
        start = line.len() - rest.len();
    }
    let length = line[start..].find(char::is_whitespace)?;
    Some(start..start + length)
}

#[cfg(any(target_os = "windows", test))]
fn cleared_json_hosts(contents: &[u8], host: &str, port: u16) -> Result<Option<Vec<u8>>, String> {
    let mut hosts: std::collections::HashMap<String, String> = serde_json::from_slice(contents)
        .map_err(|e| format!("解析 SSH 主机密钥缓存失败，未修改原文件: {e}"))?;
    if hosts.remove(&format!("[{host}]:{port}")).is_none() {
        return Ok(None);
    }
    serde_json::to_vec_pretty(&hosts)
        .map(Some)
        .map_err(|e| format!("序列化 SSH 主机密钥缓存失败: {e}"))
}

#[cfg(test)]
mod json_tests {
    use super::*;

    #[test]
    fn clears_only_matching_windows_host_and_port() {
        let input = br#"{"[example.com]:22":"old","[example.com]:2222":"keep","[other.example.com]:22":"other"}"#;
        let output = cleared_json_hosts(input, "example.com", 22)
            .unwrap()
            .unwrap();
        let hosts: serde_json::Value = serde_json::from_slice(&output).unwrap();
        assert!(hosts.get("[example.com]:22").is_none());
        assert_eq!(hosts["[example.com]:2222"], "keep");
        assert_eq!(hosts["[other.example.com]:22"], "other");
        assert!(cleared_json_hosts(&output, "example.com", 22)
            .unwrap()
            .is_none());
    }

    #[test]
    fn refuses_corrupt_windows_cache_instead_of_erasing_it() {
        assert!(cleared_json_hosts(b"not json", "example.com", 22).is_err());
    }
}

#[cfg(all(test, not(target_os = "windows")))]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::process::Command;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir()
                .join(format!("db-connect-known-hosts-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }

        fn write_hosts(&self, hosts: &[&str]) -> PathBuf {
            let key = self.0.join("test_key");
            assert!(Command::new("ssh-keygen")
                .args(["-q", "-t", "ed25519", "-N", "", "-f"])
                .arg(&key)
                .status()
                .unwrap()
                .success());
            let public_key = fs::read_to_string(key.with_extension("pub")).unwrap();
            let path = self.0.join("ssh_openssh_known_hosts");
            let contents = hosts
                .iter()
                .map(|host| format!("{host} {public_key}"))
                .collect::<String>();
            fs::write(&path, contents).unwrap();
            path
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn clears_only_the_requested_host_and_port() {
        let fixture = Fixture::new();
        let path = fixture.write_hosts(&["example.com", "[example.com]:2222", "other.example.com"]);
        let private_key = fs::read(fixture.0.join("test_key")).unwrap();
        assert!(clear_known_host_in_dir(&fixture.0, "example.com", 22).unwrap());
        let remaining = fs::read_to_string(&path).unwrap();
        assert!(!remaining
            .lines()
            .any(|line| line.starts_with("example.com ")));
        assert!(remaining.contains("[example.com]:2222 "));
        assert!(remaining.contains("other.example.com "));
        assert_eq!(fs::read(fixture.0.join("test_key")).unwrap(), private_key);
        assert!(!clear_known_host_in_dir(&fixture.0, "example.com", 22).unwrap());
        assert!(clear_known_host_in_dir(&fixture.0, "example.com", 2222).unwrap());
        assert!(!fs::read_to_string(&path)
            .unwrap()
            .contains("[example.com]:2222 "));
    }

    #[test]
    fn preserves_other_hosts_and_ports_sharing_the_same_line() {
        let fixture = Fixture::new();
        let path = fixture.write_hosts(&["example.com,other.example.com,[example.com]:2222"]);
        assert!(clear_known_host_in_dir(&fixture.0, "example.com", 22).unwrap());
        let remaining = fs::read_to_string(path).unwrap();
        assert!(remaining.contains("other.example.com "));
        assert!(remaining.contains("[example.com]:2222 "));
        assert!(!remaining
            .lines()
            .any(|line| line.starts_with("example.com ")));
    }

    #[test]
    fn refuses_matching_wildcard_records_without_removing_other_hosts_trust() {
        let fixture = Fixture::new();
        let path = fixture.write_hosts(&["*.example.com", "other.example.org"]);
        let original = fs::read(&path).unwrap();
        assert!(clear_known_host_in_dir(&fixture.0, "db.example.com", 22).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
    }

    #[test]
    fn clears_hashed_host_entries_and_keeps_others() {
        let fixture = Fixture::new();
        let path = fixture.write_hosts(&["[example.com]:2222", "other.example.com"]);
        assert!(Command::new("ssh-keygen")
            .args(["-H", "-f"])
            .arg(&path)
            .output()
            .unwrap()
            .status
            .success());
        let before = fs::read_to_string(&path).unwrap();
        assert!(!before.contains("example.com"));
        assert!(clear_known_host_in_dir(&fixture.0, "example.com", 2222).unwrap());
        let remaining = fs::read_to_string(&path).unwrap();
        assert_eq!(remaining.lines().count(), 1);
        assert!(before.contains(remaining.trim()));
    }

    #[test]
    fn missing_cache_is_a_noop() {
        let fixture = Fixture::new();
        assert!(!clear_known_host_in_dir(&fixture.0, "example.com", 22).unwrap());
        assert!(!fixture.0.join("ssh_openssh_known_hosts").exists());
    }

    #[tokio::test]
    async fn clearing_waits_for_in_progress_host_verification() {
        let fixture = Fixture::new();
        let path = fixture.write_hosts(&["example.com"]);
        let original = fs::read(&path).unwrap();
        let verification = super::super::KNOWN_HOSTS_LOCK.lock().await;
        let mut clear = tokio::spawn(clear_known_host_at(
            fixture.0.clone(),
            "example.com".to_string(),
            22,
        ));
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(50), &mut clear)
                .await
                .is_err()
        );
        assert_eq!(fs::read(&path).unwrap(), original);
        drop(verification);
        assert!(clear.await.unwrap().unwrap());
    }

    #[test]
    fn refuses_symlink_cache_without_modifying_its_target() {
        let fixture = Fixture::new();
        let outside = fixture.0.join("unrelated_file");
        fs::write(&outside, b"keep this file").unwrap();
        std::os::unix::fs::symlink(&outside, fixture.0.join("ssh_openssh_known_hosts")).unwrap();
        assert!(clear_known_host_in_dir(&fixture.0, "example.com", 22).is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"keep this file");
    }

    #[tokio::test]
    async fn rejects_patterns_and_invalid_ports_before_accessing_cache() {
        for host in [
            "",
            " ",
            "*",
            "*.example.com",
            "a,b",
            "a b",
            "-host",
            "a/b",
            "a\\b",
            "!host",
            "[::1]",
            "a\nb",
        ] {
            assert!(
                clear_known_host(host.to_string(), 22).await.is_err(),
                "{host:?}"
            );
        }
        assert!(clear_known_host("example.com".to_string(), 0)
            .await
            .is_err());
    }
}
