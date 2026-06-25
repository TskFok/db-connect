//! Windows：russh，每路 MySQL TCP 独立 SSH + direct-tcpip（与连接池并发匹配）。

use crate::models::types::SshConfig;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use russh::client::AuthResult;
use russh::keys::{
    key::PrivateKeyWithHashAlg, load_secret_key, ssh_key::PublicKey, PublicKeyBase64,
};
use russh::{client, Disconnect};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener as TokioTcpListener;

use super::ensure_db_connect_data_dir;
use super::expand_ssh_private_key_path;

pub struct SshTunnel {
    local_port: u16,
    shutdown: Arc<AtomicBool>,
}

impl SshTunnel {
    pub async fn start(
        ssh_config: &SshConfig,
        remote_host: &str,
        remote_port: u16,
    ) -> Result<Self, String> {
        let listener = TokioTcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|e| format!("绑定本地端口失败: {}", e))?;
        let local_port = listener
            .local_addr()
            .map_err(|e| format!("获取本地监听地址失败: {}", e))?
            .port();

        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_clone = shutdown.clone();
        let ssh_config = ssh_config.clone();
        let remote_host = remote_host.to_string();

        tokio::spawn(async move {
            tunnel_accept_loop(
                listener,
                shutdown_clone,
                ssh_config,
                remote_host,
                remote_port,
            )
            .await;
        });

        Ok(SshTunnel {
            local_port,
            shutdown,
        })
    }

    pub fn local_port(&self) -> u16 {
        self.local_port
    }

    pub fn close(&self) {
        self.shutdown.store(true, Ordering::Relaxed);
    }
}

impl Drop for SshTunnel {
    fn drop(&mut self) {
        self.close();
    }
}

fn host_key_fingerprint_b64(key: &PublicKey) -> String {
    BASE64.encode(key.public_key_bytes())
}

struct RusshClientHandler {
    host: String,
    port: u16,
}

impl client::Handler for RusshClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        let fp = host_key_fingerprint_b64(server_public_key);
        let host_id = format!("[{}]:{}", self.host, self.port);
        let known_hosts_path =
            get_known_hosts_path().map_err(|e| russh::Error::IO(std::io::Error::other(e)))?;
        let mut known_hosts = load_known_hosts(&known_hosts_path);
        match known_hosts.get(&host_id) {
            Some(stored) if stored == &fp => Ok(true),
            Some(_) => Err(russh::Error::IO(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!(
                    "SSH 主机密钥已变更！主机 {} 的密钥与 {} 中记录不匹配。\
                     若确认服务器已换钥，请删除该文件中对应条目后重试。",
                    host_id,
                    known_hosts_path.display()
                ),
            ))),
            None => {
                known_hosts.insert(host_id.clone(), fp);
                save_known_hosts(&known_hosts_path, &known_hosts)
                    .map_err(|e| russh::Error::IO(std::io::Error::other(e)))?;
                Ok(true)
            }
        }
    }
}

async fn authenticate_russh(
    handle: &mut client::Handle<RusshClientHandler>,
    cfg: &SshConfig,
) -> Result<(), String> {
    if let Some(ref key_path) = cfg.private_key_path {
        let path = expand_ssh_private_key_path(key_path);
        let key_pair = load_secret_key(&path, cfg.password.as_deref())
            .map_err(|e| format!("读取 SSH 私钥失败: {}", e))?;
        let rsa_hash = handle
            .best_supported_rsa_hash()
            .await
            .map_err(|e| format!("SSH 协商 RSA 哈希失败: {}", e))?
            .flatten();
        let auth = handle
            .authenticate_publickey(
                cfg.username.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key_pair), rsa_hash),
            )
            .await
            .map_err(|e| format!("SSH 公钥认证失败: {}", e))?;
        if auth != AuthResult::Success {
            return Err("SSH 公钥认证被拒绝".to_string());
        }
        return Ok(());
    }
    if let Some(ref password) = cfg.password {
        let auth = handle
            .authenticate_password(cfg.username.clone(), password.clone())
            .await
            .map_err(|e| format!("SSH 密码认证失败: {}", e))?;
        if auth != AuthResult::Success {
            return Err("SSH 密码认证被拒绝".to_string());
        }
        return Ok(());
    }
    Err("未提供 SSH 认证方式 (密码或私钥)".to_string())
}

async fn tunnel_accept_loop(
    listener: TokioTcpListener,
    shutdown: Arc<AtomicBool>,
    ssh_config: SshConfig,
    remote_mysql_host: String,
    remote_mysql_port: u16,
) {
    while !shutdown.load(Ordering::Relaxed) {
        match tokio::time::timeout(Duration::from_millis(250), listener.accept()).await {
            Ok(Ok((socket, peer))) => {
                let _ = socket.set_nodelay(true);
                let cfg = ssh_config.clone();
                let rh = remote_mysql_host.clone();
                let rp = remote_mysql_port;
                tokio::spawn(async move {
                    if let Err(e) = ssh_forward_one_connection(cfg, socket, peer, rh, rp).await {
                        eprintln!("SSH 转发连接结束: {}", e);
                    }
                });
            }
            Ok(Err(e)) => {
                eprintln!("SSH 隧道 accept 错误: {}", e);
                break;
            }
            Err(_) => {}
        }
    }
}

async fn ssh_forward_one_connection(
    ssh_config: SshConfig,
    mut local_tcp: tokio::net::TcpStream,
    peer_addr: SocketAddr,
    target_host: String,
    target_port: u16,
) -> Result<(), String> {
    let config = Arc::new(client::Config {
        nodelay: true,
        ..Default::default()
    });
    let handler = RusshClientHandler {
        host: ssh_config.host.clone(),
        port: ssh_config.port,
    };
    let mut handle = client::connect(config, (ssh_config.host.as_str(), ssh_config.port), handler)
        .await
        .map_err(|e| format!("SSH 连接失败: {}", e))?;

    authenticate_russh(&mut handle, &ssh_config).await?;

    let channel = handle
        .channel_open_direct_tcpip(
            target_host.clone(),
            target_port as u32,
            peer_addr.ip().to_string(),
            peer_addr.port() as u32,
        )
        .await
        .map_err(|e| format!("打开 SSH direct-tcpip 通道失败: {}", e))?;

    let mut ch_stream = channel.into_stream();
    match tokio::io::copy_bidirectional(&mut local_tcp, &mut ch_stream).await {
        Ok(_) => {}
        Err(e) => return Err(format!("隧道数据转发错误: {}", e)),
    }

    let _ = handle.disconnect(Disconnect::ByApplication, "", "").await;
    Ok(())
}

fn get_known_hosts_path() -> Result<PathBuf, String> {
    Ok(ensure_db_connect_data_dir()?.join("ssh_known_hosts.json"))
}

fn load_known_hosts(path: &Path) -> HashMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn save_known_hosts(path: &Path, hosts: &HashMap<String, String>) -> Result<(), String> {
    let json = serde_json::to_string_pretty(hosts)
        .map_err(|e| format!("序列化 SSH known_hosts 失败: {}", e))?;
    std::fs::write(path, json).map_err(|e| format!("保存 SSH known_hosts 失败: {}", e))?;
    crate::util::secure_fs::set_secure_file_permissions(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_known_hosts_missing_file() {
        let path = Path::new("/tmp/nonexistent_known_hosts_test.json");
        let hosts = load_known_hosts(path);
        assert!(hosts.is_empty());
    }

    #[test]
    fn test_save_and_load_known_hosts() {
        let dir = std::env::temp_dir().join("db-connect-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test_known_hosts.json");

        let mut hosts = HashMap::new();
        hosts.insert("[example.com]:22".to_string(), "dGVzdGtleQ==".to_string());
        hosts.insert("[other.com]:2222".to_string(), "b3RoZXJrZXk=".to_string());

        save_known_hosts(&path, &hosts).unwrap();
        let loaded = load_known_hosts(&path);

        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded.get("[example.com]:22").unwrap(), "dGVzdGtleQ==");
        assert_eq!(loaded.get("[other.com]:2222").unwrap(), "b3RoZXJrZXk=");

        std::fs::remove_file(&path).ok();
        std::fs::remove_dir(&dir).ok();
    }

    #[test]
    fn test_load_known_hosts_invalid_json() {
        let dir = std::env::temp_dir().join("db-connect-test-invalid");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bad_known_hosts.json");
        std::fs::write(&path, "not valid json").unwrap();

        let hosts = load_known_hosts(&path);
        assert!(hosts.is_empty());

        std::fs::remove_file(&path).ok();
        std::fs::remove_dir(&dir).ok();
    }
}
