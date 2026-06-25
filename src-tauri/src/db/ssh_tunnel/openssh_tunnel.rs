//! macOS / Linux：系统 OpenSSH（`ssh -L`）。

use crate::models::types::SshConfig;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::process::Command;

use super::{ensure_db_connect_data_dir, expand_ssh_private_key_path};

pub struct SshTunnel {
    local_port: u16,
    child: Arc<Mutex<Option<tokio::process::Child>>>,
    _cleanup: CleanupPaths,
}

struct CleanupPaths(Vec<PathBuf>);

impl Drop for CleanupPaths {
    fn drop(&mut self) {
        for p in &self.0 {
            let _ = std::fs::remove_file(p);
        }
    }
}

impl SshTunnel {
    pub async fn start(
        ssh_config: &SshConfig,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<Self, String> {
        validate_ssh_auth(ssh_config)?;

        let local_port = alloc_free_local_port().await?;
        let known_hosts = ensure_db_connect_data_dir()?.join("ssh_openssh_known_hosts");
        if !known_hosts.exists() {
            std::fs::File::create(&known_hosts)
                .map_err(|e| format!("创建 OpenSSH known_hosts 文件失败: {}", e))?;
            crate::util::secure_fs::set_secure_file_permissions(&known_hosts)
                .map_err(|e| format!("设置 known_hosts 权限失败: {}", e))?;
        }

        let (cleanup, mut cmd) = build_ssh_command(
            ssh_config,
            remote_host,
            remote_port,
            local_port,
            &known_hosts,
        )?;

        let mut child = cmd
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| {
                format!(
                    "启动 ssh 失败: {}（请确认系统已安装 OpenSSH 客户端，且 {} 可用）",
                    e,
                    ssh_program()
                )
            })?;

        wait_for_local_forward(local_port, &mut child).await?;

        Ok(SshTunnel {
            local_port,
            child: Arc::new(Mutex::new(Some(child))),
            _cleanup: CleanupPaths(cleanup),
        })
    }

    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    pub fn close(&self) {
        let taken = self.child.lock().ok().and_then(|mut g| g.take());
        if let Some(mut child) = taken {
            let _ = child.start_kill();
            tokio::spawn(async move {
                let _ = child.wait().await;
            });
        }
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.close();
    }
}

fn ssh_program() -> &'static str {
    if cfg!(target_os = "macos") {
        "/usr/bin/ssh"
    } else {
        "ssh"
    }
}

fn validate_ssh_auth(cfg: &SshConfig) -> Result<(), String> {
    let has_key = cfg
        .private_key_path
        .as_ref()
        .map(|p| !p.trim().is_empty())
        .unwrap_or(false);
    let has_password = cfg
        .password
        .as_ref()
        .map(|p| !p.is_empty())
        .unwrap_or(false);
    if !has_key && !has_password {
        return Err("未提供 SSH 认证方式 (密码或私钥)".to_string());
    }
    Ok(())
}

fn ssh_forward_remote_target(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{}]:{}", host, port)
    } else {
        format!("{}:{}", host, port)
    }
}

async fn alloc_free_local_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("预留本地端口失败: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("获取本地端口失败: {}", e))?
        .port();
    drop(listener);
    Ok(port)
}

fn shell_single_quoted_path(p: &Path) -> String {
    let s = p.to_string_lossy();
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

fn prepare_askpass(password: &str) -> Result<(PathBuf, Vec<PathBuf>), String> {
    let id = uuid::Uuid::new_v4();
    let pass_path = std::env::temp_dir().join(format!("db-connect-ssh-pass-{id}"));
    let script_path = std::env::temp_dir().join(format!("db-connect-ssh-askpass-{id}.sh"));

    std::fs::write(&pass_path, password.as_bytes())
        .map_err(|e| format!("写入 SSH askpass 数据失败: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&pass_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置 askpass 文件权限失败: {}", e))?;
    }

    let body = format!(
        "#!/bin/sh\nexec cat {}\n",
        shell_single_quoted_path(&pass_path)
    );
    std::fs::write(&script_path, &body).map_err(|e| format!("写入 SSH_ASKPASS 脚本失败: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("设置 askpass 脚本权限失败: {}", e))?;
    }

    let cleanup = vec![pass_path, script_path.clone()];
    Ok((script_path, cleanup))
}

fn build_ssh_command(
    cfg: &SshConfig,
    remote_host: &str,
    remote_mysql_port: u16,
    local_port: u16,
    known_hosts: &Path,
) -> Result<(Vec<PathBuf>, Command), String> {
    let remote = ssh_forward_remote_target(remote_host, remote_mysql_port);
    let forward = format!("127.0.0.1:{local_port}:{remote}");
    let mut cleanup = Vec::new();

    let mut cmd = Command::new(ssh_program());
    cmd.arg("-N");
    cmd.arg("-L").arg(forward);
    cmd.arg("-p").arg(cfg.port.to_string());
    cmd.arg("-o").arg("ExitOnForwardFailure=yes");
    cmd.arg("-o").arg("ServerAliveInterval=60");
    cmd.arg("-o").arg("StrictHostKeyChecking=accept-new");
    cmd.arg("-o")
        .arg(format!("UserKnownHostsFile={}", known_hosts.display()));

    if let Some(ref key_path) = cfg.private_key_path {
        if !key_path.trim().is_empty() {
            let p = expand_ssh_private_key_path(key_path);
            cmd.arg("-i").arg(p);
            cmd.arg("-o").arg("IdentitiesOnly=yes");
        }
    }

    let need_askpass = cfg
        .password
        .as_ref()
        .map(|p| !p.is_empty())
        .unwrap_or(false);
    if need_askpass {
        let pwd = cfg.password.as_ref().unwrap();
        let (script, mut paths) = prepare_askpass(pwd)?;
        cleanup.append(&mut paths);
        cmd.env("SSH_ASKPASS", &script);
        cmd.env("SSH_ASKPASS_REQUIRE", "force");
        cmd.env("DISPLAY", "");
    }

    let dest = format!("{}@{}", cfg.username, cfg.host);
    cmd.arg(dest);

    Ok((cleanup, cmd))
}

async fn wait_for_local_forward(
    port: u16,
    child: &mut tokio::process::Child,
) -> Result<(), String> {
    for _ in 0..60 {
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!(
                "SSH 进程已退出，本地转发未就绪 (退出码: {:?})",
                status.code()
            ));
        }
        match tokio::time::timeout(
            Duration::from_millis(200),
            tokio::net::TcpStream::connect(("127.0.0.1", port)),
        )
        .await
        {
            Ok(Ok(s)) => {
                drop(s);
                return Ok(());
            }
            _ => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    let _ = child.start_kill();
    Err("等待 SSH 本地端口转发超时".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ssh_forward_remote_target_ipv4() {
        assert_eq!(ssh_forward_remote_target("10.0.0.1", 3306), "10.0.0.1:3306");
    }

    #[test]
    fn test_ssh_forward_remote_target_hostname() {
        assert_eq!(
            ssh_forward_remote_target("db.internal", 3306),
            "db.internal:3306"
        );
    }

    #[test]
    fn test_ssh_forward_remote_target_ipv6_literal() {
        assert_eq!(
            ssh_forward_remote_target("2001:db8::1", 3306),
            "[2001:db8::1]:3306"
        );
    }

    #[test]
    fn test_ssh_forward_remote_target_ipv6_already_bracketed() {
        assert_eq!(
            ssh_forward_remote_target("[2001:db8::1]", 3306),
            "[2001:db8::1]:3306"
        );
    }
}
