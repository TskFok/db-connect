//! macOS / Linux：系统 OpenSSH（`ssh -L`）。

use crate::models::types::SshConfig;
use std::io::Write;
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
}

#[derive(Default)]
struct CleanupPaths(Vec<PathBuf>);

impl Drop for CleanupPaths {
    fn drop(&mut self) {
        for path in self.0.iter().rev() {
            if std::fs::remove_file(path).is_err() {
                let _ = std::fs::remove_dir(path);
            }
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
        drop(cleanup);

        Ok(SshTunnel {
            local_port,
            child: Arc::new(Mutex::new(Some(child))),
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

fn prepare_askpass(password: &str) -> Result<(PathBuf, CleanupPaths), String> {
    let id = uuid::Uuid::new_v4();
    let temp_dir = std::env::temp_dir().join(format!("db-connect-ssh-askpass-{id}"));
    let pass_path = temp_dir.join("password");
    let script_path = temp_dir.join("askpass.sh");
    let mut cleanup = CleanupPaths::default();

    let mut dir_builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        dir_builder.mode(0o700);
    }
    dir_builder
        .create(&temp_dir)
        .map_err(|e| format!("创建 SSH askpass 临时目录失败: {}", e))?;
    cleanup.0.push(temp_dir.clone());

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("设置 askpass 临时目录权限失败: {}", e))?;
    }

    let mut pass_file = create_new_askpass_file(&pass_path, 0o600)?;
    cleanup.0.push(pass_path.clone());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        pass_file
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("设置 askpass 数据权限失败: {}", e))?;
    }
    pass_file
        .write_all(password.as_bytes())
        .map_err(|e| format!("写入 SSH askpass 数据失败: {}", e))?;
    drop(pass_file);

    let body = format!(
        "#!/bin/sh\nexec cat {}\n",
        shell_single_quoted_path(&pass_path)
    );
    let mut script_file = create_new_askpass_file(&script_path, 0o700)?;
    cleanup.0.push(script_path.clone());
    script_file
        .write_all(body.as_bytes())
        .map_err(|e| format!("写入 SSH_ASKPASS 脚本失败: {}", e))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        script_file
            .set_permissions(std::fs::Permissions::from_mode(0o700))
            .map_err(|e| format!("设置 askpass 脚本权限失败: {}", e))?;
    }
    drop(script_file);

    Ok((script_path, cleanup))
}

fn create_new_askpass_file(path: &Path, mode: u32) -> Result<std::fs::File, String> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }

    #[cfg(not(unix))]
    let _ = mode;

    options
        .open(path)
        .map_err(|e| format!("创建 SSH askpass 临时文件失败: {}", e))
}

fn build_ssh_command(
    cfg: &SshConfig,
    remote_host: &str,
    remote_mysql_port: u16,
    local_port: u16,
    known_hosts: &Path,
) -> Result<(CleanupPaths, Command), String> {
    let remote = ssh_forward_remote_target(remote_host, remote_mysql_port);
    let forward = format!("127.0.0.1:{local_port}:{remote}");
    let mut cleanup = CleanupPaths::default();

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
        cleanup.0.append(&mut paths.0);
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
    use std::fs;

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

    #[test]
    fn dropping_askpass_cleanup_removes_the_secret_and_script() {
        let (script_path, cleanup) = prepare_askpass("temporary secret").unwrap();
        let script = fs::read_to_string(&script_path).unwrap();
        let pass_path = PathBuf::from(
            script
                .strip_prefix("#!/bin/sh\nexec cat '")
                .and_then(|value| value.strip_suffix("'\n"))
                .expect("askpass 脚本应引用口令文件"),
        );
        assert!(script_path.exists());
        assert!(pass_path.exists());

        drop(cleanup);

        let script_remained = script_path.exists();
        let password_remained = pass_path.exists();
        fs::remove_file(&script_path).ok();
        fs::remove_file(&pass_path).ok();
        if let Some(parent) = script_path.parent() {
            fs::remove_dir(parent).ok();
        }
        assert!(!script_remained, "清理守卫释放后 askpass 脚本仍然存在");
        assert!(!password_remained, "清理守卫释放后明文口令仍然存在");
    }
}
