//! SSH 隧道：**Windows** 使用 russh；**macOS / Linux** 使用系统 OpenSSH（`ssh`）。

#[cfg(target_os = "windows")]
mod russh_tunnel;
#[cfg(target_os = "windows")]
pub use russh_tunnel::SshTunnel;

#[cfg(not(target_os = "windows"))]
mod openssh_tunnel;
#[cfg(not(target_os = "windows"))]
pub use openssh_tunnel::SshTunnel;

use std::path::{Path, PathBuf};

pub(crate) fn ssh_user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

pub(crate) fn expand_ssh_private_key_path_impl(path: &str, home: Option<&Path>) -> PathBuf {
    let path = path.trim();
    if let Some(home) = home {
        if path == "~" {
            return home.to_path_buf();
        }
        if let Some(rest) = path.strip_prefix("~/") {
            return home.join(rest);
        }
        if let Some(rest) = path.strip_prefix("~\\") {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

pub(crate) fn expand_ssh_private_key_path(path: &str) -> PathBuf {
    expand_ssh_private_key_path_impl(path, ssh_user_home_dir().as_deref())
}

pub(crate) fn ensure_db_connect_data_dir() -> Result<PathBuf, String> {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map_err(|_| "无法获取用户主目录".to_string())?;
    let dir = PathBuf::from(home).join(".db-connect");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    crate::util::secure_fs::set_secure_dir_permissions(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_expand_ssh_private_key_path_impl_tilde_slash() {
        let home = Path::new("/home/u");
        assert_eq!(
            expand_ssh_private_key_path_impl("~/.ssh/id_rsa", Some(home)),
            PathBuf::from("/home/u/.ssh/id_rsa")
        );
    }

    #[test]
    #[cfg(windows)]
    fn test_expand_ssh_private_key_path_impl_tilde_backslash() {
        let home = Path::new(r"C:\Users\u");
        assert_eq!(
            expand_ssh_private_key_path_impl(r"~\.ssh\id_rsa", Some(home)),
            PathBuf::from(r"C:\Users\u\.ssh\id_rsa")
        );
    }

    #[test]
    fn test_expand_ssh_private_key_impl_tilde_only() {
        let home = Path::new("/home/u");
        assert_eq!(
            expand_ssh_private_key_path_impl("~", Some(home)),
            PathBuf::from("/home/u")
        );
    }

    #[test]
    fn test_expand_ssh_private_key_impl_no_home_unchanged() {
        assert_eq!(
            expand_ssh_private_key_path_impl("~/.ssh/id_rsa", None),
            PathBuf::from("~/.ssh/id_rsa")
        );
    }

    #[test]
    fn test_expand_ssh_private_key_impl_absolute_unchanged() {
        let home = Path::new("/home/u");
        assert_eq!(
            expand_ssh_private_key_path_impl("/etc/ssh/key", Some(home)),
            PathBuf::from("/etc/ssh/key")
        );
    }
}
