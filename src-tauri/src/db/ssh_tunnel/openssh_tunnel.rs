//! macOS / Linux：系统 OpenSSH（`ssh -L`）。

use crate::models::types::SshConfig;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::process::Command;

use super::{ensure_db_connect_data_dir, expand_ssh_private_key_path};

pub struct SshTunnel {
    local_port: u16,
    process: Arc<Mutex<Option<SshProcess>>>,
}

struct SshProcess {
    child: tokio::process::Child,
    // 隧道建立后仍需持续消费 stderr，避免 SSH 写满管道后阻塞。
    _stderr: StderrCapture,
}

const MAX_STDERR_BYTES: usize = 16 * 1024;

#[derive(Default)]
struct StderrOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

struct StderrCapture {
    output: Arc<Mutex<StderrOutput>>,
    reader: Option<tokio::task::JoinHandle<()>>,
}

impl StderrCapture {
    fn start(child: &mut tokio::process::Child) -> Self {
        let output = Arc::new(Mutex::new(StderrOutput::default()));
        let reader = child.stderr.take().map(|mut stderr| {
            let output = Arc::clone(&output);
            tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                loop {
                    let size = match stderr.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(size) => size,
                    };
                    let mut output = output.lock().unwrap_or_else(|e| e.into_inner());
                    let excess = (output.bytes.len() + size).saturating_sub(MAX_STDERR_BYTES);
                    if excess > 0 {
                        output.bytes.drain(..excess);
                        output.truncated = true;
                    }
                    output.bytes.extend_from_slice(&buffer[..size]);
                }
            })
        });
        Self { output, reader }
    }

    async fn finish(&mut self) -> String {
        if let Some(reader) = self.reader.as_mut() {
            // 子进程退出后通常立即 EOF；继承了管道的辅助进程不应拖住错误返回。
            // 等待期间保留守卫对任务的所有权，取消此 future 时仍能中止读取。
            if tokio::time::timeout(Duration::from_millis(200), &mut *reader)
                .await
                .is_err()
            {
                reader.abort();
                let _ = reader.await;
            }
        }
        self.reader.take();
        let output = self.output.lock().unwrap_or_else(|e| e.into_inner());
        let details = String::from_utf8_lossy(&output.bytes);
        if output.truncated {
            format!(
                "[较早的错误输出已截断，仅保留最后 16 KiB]\n{}",
                details.trim()
            )
        } else {
            details.trim().to_string()
        }
    }
}

impl Drop for StderrCapture {
    fn drop(&mut self) {
        if let Some(reader) = self.reader.take() {
            reader.abort();
        }
    }
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
        let _known_hosts_guard = super::KNOWN_HOSTS_LOCK.lock().await;

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

        let mut child = spawn_ssh_process(&mut cmd)?;
        let stderr = wait_for_local_forward(local_port, &mut child, 60).await?;
        drop(cleanup);

        Ok(SshTunnel {
            local_port,
            process: Arc::new(Mutex::new(Some(SshProcess {
                child,
                _stderr: stderr,
            }))),
        })
    }

    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    pub fn close(&self) {
        let taken = self.process.lock().ok().and_then(|mut g| g.take());
        if let Some(mut process) = taken {
            let _ = process.child.start_kill();
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    let _ = process.child.wait().await;
                    drop(process);
                });
            }
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

fn spawn_ssh_process(cmd: &mut Command) -> Result<tokio::process::Child, String> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| {
            format!(
                "启动 ssh 失败: {}（请确认系统已安装 OpenSSH 客户端，且 {} 可用）",
                e,
                ssh_program()
            )
        })
}

fn forward_failure(summary: String, details: String) -> String {
    let mut message = summary;
    if details.contains("REMOTE HOST IDENTIFICATION HAS CHANGED") {
        message.push_str("\nSSH 主机密钥已变更。请先确认服务器身份；确认安全后，在 SSH 配置中点击“清除主机密钥缓存”，再重新连接。");
    }
    if !details.is_empty() {
        message.push_str("\n\nOpenSSH 错误详情:\n");
        message.push_str(&details);
    }
    message
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
    attempts: usize,
) -> Result<StderrCapture, String> {
    let mut stderr = StderrCapture::start(child);
    for _ in 0..attempts {
        match child.try_wait() {
            Ok(Some(status)) => {
                let reason = match status.code() {
                    Some(code) => format!("退出码: {code}"),
                    None => format!("终止状态: {status}"),
                };
                return Err(forward_failure(
                    format!("SSH 进程已退出，本地转发未就绪 ({reason})"),
                    stderr.finish().await,
                ));
            }
            Err(error) => {
                let _ = child.kill().await;
                return Err(forward_failure(
                    format!("检查 SSH 进程状态失败: {error}"),
                    stderr.finish().await,
                ));
            }
            Ok(None) => {}
        }
        match tokio::time::timeout(
            Duration::from_millis(200),
            tokio::net::TcpStream::connect(("127.0.0.1", port)),
        )
        .await
        {
            Ok(Ok(s)) => {
                drop(s);
                return Ok(stderr);
            }
            _ => tokio::time::sleep(Duration::from_millis(100)).await,
        }
    }
    let _ = child.kill().await;
    Err(forward_failure(
        "等待 SSH 本地端口转发超时".to_string(),
        stderr.finish().await,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn shell_child(script: &str) -> tokio::process::Child {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(script);
        spawn_ssh_process(&mut command).expect("启动本地测试子进程")
    }

    fn reserved_closed_port() -> (tokio::net::TcpSocket, u16) {
        // 保留端口但不监听，避免被并行成功用例复用而误判转发就绪。
        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.bind("127.0.0.1:0".parse().unwrap()).unwrap();
        let port = socket.local_addr().unwrap().port();
        (socket, port)
    }

    #[tokio::test]
    async fn forward_failure_includes_original_stderr() {
        let (_reserved_port, port) = reserved_closed_port();
        let mut child = shell_child("printf 'Permission denied (publickey).\\n' >&2; exit 255");

        let error = wait_for_local_forward(port, &mut child, 60)
            .await
            .err()
            .expect("子进程应建连失败");

        assert!(error.contains("Permission denied (publickey)."), "{error}");
        assert!(error.contains("255"), "{error}");
        assert!(!error.contains("Some("), "{error}");
    }

    #[tokio::test]
    async fn host_key_failure_explains_how_to_clear_application_cache() {
        let (_reserved_port, port) = reserved_closed_port();
        let mut child = shell_child(
            "printf 'WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\\nHost key verification failed.\\n' >&2; exit 255",
        );

        let error = wait_for_local_forward(port, &mut child, 60)
            .await
            .err()
            .expect("主机密钥变更应建连失败");

        assert!(
            error.contains("REMOTE HOST IDENTIFICATION HAS CHANGED!"),
            "{error}"
        );
        assert!(error.contains("服务器身份"), "{error}");
        assert!(error.contains("SSH 配置"), "{error}");
        assert!(error.contains("清除主机密钥缓存"), "{error}");
    }

    #[tokio::test]
    async fn failure_without_stderr_has_a_readable_exit_code() {
        let (_reserved_port, port) = reserved_closed_port();
        let mut child = shell_child("exit 255");

        let error = wait_for_local_forward(port, &mut child, 60)
            .await
            .err()
            .expect("子进程应建连失败");

        assert!(error.contains("退出码: 255"), "{error}");
        assert!(!error.contains("Some("), "{error}");
    }

    #[tokio::test]
    async fn verbose_stderr_is_drained_and_keeps_the_final_failure() {
        let (_reserved_port, port) = reserved_closed_port();
        let mut child = shell_child(
            "i=0; while [ $i -lt 2048 ]; do printf 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' >&2; i=$((i + 1)); done; printf '\\nPermission denied (publickey).\\n' >&2; exit 255",
        );

        let error = tokio::time::timeout(
            Duration::from_secs(3),
            wait_for_local_forward(port, &mut child, 60),
        )
        .await
        .expect("大量 stderr 不应阻塞子进程")
        .err()
        .expect("子进程应建连失败");

        assert!(error.contains("Permission denied (publickey)."), "{error}");
        assert!(error.len() < 17 * 1024, "错误详情必须有长度上限");
        assert!(error.contains("截断"), "应说明错误输出已截断");
    }

    #[tokio::test]
    async fn forward_timeout_returns_stderr_and_reaps_the_process() {
        let (_reserved_port, port) = reserved_closed_port();
        let mut child = shell_child("printf 'Connection setup stalled\\n' >&2; exec sleep 30");

        let error = wait_for_local_forward(port, &mut child, 1)
            .await
            .err()
            .expect("未监听本地端口应超时");

        assert!(error.contains("超时"), "{error}");
        assert!(error.contains("Connection setup stalled"), "{error}");
        assert!(
            child.try_wait().unwrap().is_some(),
            "超时返回前应回收子进程"
        );
    }

    #[tokio::test]
    async fn ready_forward_does_not_wait_for_stderr_to_close() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut child = shell_child("printf 'Forward ready\\n' >&2; exec sleep 30");

        let result = tokio::time::timeout(
            Duration::from_secs(1),
            wait_for_local_forward(port, &mut child, 60),
        )
        .await
        .expect("本地端口就绪后不应等待仍在运行的进程关闭 stderr");

        child.kill().await.unwrap();
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn cancelling_error_collection_aborts_the_stderr_reader() {
        let mut child = shell_child("exec sleep 30");
        let mut stderr = StderrCapture::start(&mut child);
        let reader = stderr.reader.as_ref().unwrap().abort_handle();

        assert!(
            tokio::time::timeout(Duration::from_millis(10), stderr.finish())
                .await
                .is_err()
        );
        drop(stderr);
        tokio::task::yield_now().await;
        let reader_stopped = reader.is_finished();
        child.kill().await.unwrap();

        assert!(reader_stopped, "错误收集被取消时不应遗留读取任务");
    }

    #[tokio::test]
    async fn error_collection_does_not_wait_forever_for_an_inherited_pipe() {
        let (_reserved_port, port) = reserved_closed_port();
        let mut child =
            shell_child("sleep 1 >&2 & printf 'Permission denied (publickey).\\n' >&2; exit 255");

        let error = tokio::time::timeout(
            Duration::from_millis(800),
            wait_for_local_forward(port, &mut child, 60),
        )
        .await
        .expect("主进程退出后不应等待继承 stderr 的子进程")
        .err()
        .expect("子进程应建连失败");

        assert!(error.contains("Permission denied (publickey)."), "{error}");
    }

    #[tokio::test]
    async fn closing_tunnel_reaps_the_process_and_stops_stderr_collection() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut child = shell_child("exec sleep 30");
        let pid = child.id().unwrap();
        let stderr = wait_for_local_forward(port, &mut child, 60)
            .await
            .expect("本地监听已就绪");
        let reader = stderr.reader.as_ref().unwrap().abort_handle();
        let tunnel = SshTunnel {
            local_port: port,
            process: Arc::new(Mutex::new(Some(SshProcess {
                child,
                _stderr: stderr,
            }))),
        };

        tunnel.close();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                // 信号 0 仅检查本测试启动的进程是否仍存在，不发送终止信号。
                if unsafe { libc::kill(pid as libc::pid_t, 0) } == -1 && reader.is_finished() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("关闭隧道应回收进程并结束 stderr 任务");
        assert!(tunnel.process.lock().unwrap().is_none());
    }

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
