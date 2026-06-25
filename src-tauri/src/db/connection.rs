use crate::db::adapter::{DatabaseAdapter, MySqlDatabaseAdapter, PostgresDatabaseAdapter};
use crate::db::postgres::{self, PostgresCancelTls, PostgresPoolHandle};
use crate::db::ssh_tunnel::SshTunnel;
use crate::models::types::{ConnectionConfig, DatabaseType};
use mysql_async::prelude::*;
use mysql_async::{
    ClientIdentity, Conn, Opts, OptsBuilder, Pool, PoolConstraints, PoolOpts, SslOpts,
};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// 根据连接配置构造 SSL 选项；未启用 SSL 时返回 `None`。
fn ssl_opts_from_config(config: &ConnectionConfig) -> Result<Option<SslOpts>, String> {
    let mode_raw = config
        .ssl_mode
        .as_deref()
        .unwrap_or("disabled")
        .trim()
        .to_lowercase();
    if mode_raw.is_empty() || mode_raw == "disabled" || mode_raw == "none" || mode_raw == "off" {
        return Ok(None);
    }

    let mut ssl = match mode_raw.as_str() {
        "required" => SslOpts::default(),
        "verify_ca" => {
            let ca = config
                .ssl_ca_path
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .ok_or("VERIFY_CA 模式需要填写 CA 证书路径（PEM）")?;
            SslOpts::default()
                .with_root_certs(vec![PathBuf::from(ca).into()])
                .with_danger_skip_domain_validation(true)
        }
        "verify_identity" => {
            let ca = config
                .ssl_ca_path
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .ok_or("VERIFY_IDENTITY 模式需要填写 CA 证书路径（PEM）")?;
            SslOpts::default().with_root_certs(vec![PathBuf::from(ca).into()])
        }
        "required_insecure" => SslOpts::default()
            .with_danger_accept_invalid_certs(true)
            .with_danger_skip_domain_validation(true),
        other => {
            return Err(format!(
                "未知的 ssl_mode: {}（支持: disabled, required, verify_ca, verify_identity, required_insecure）",
                other
            ));
        }
    };

    if let Some(p12) = config
        .ssl_pkcs12_path
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        let ident = ClientIdentity::new(PathBuf::from(p12).into());
        let ident = if let Some(pw) = config.ssl_pkcs12_password.as_ref() {
            ident.with_password(pw.clone())
        } else {
            ident
        };
        ssl = ssl.with_client_identity(Some(ident));
    }

    if let Some(host) = config
        .ssl_tls_hostname
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        ssl = ssl.with_danger_tls_hostname_override(Some(host.to_string()));
    }

    Ok(Some(ssl))
}

fn is_safe_mysql_charset_name(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// 每条新物理连接建立后由 mysql_async 依次执行的初始化 SQL（`SET NAMES` + 用户自定义会话语句）。
pub(crate) fn session_init_from_config(config: &ConnectionConfig) -> Vec<String> {
    let raw = config
        .client_charset
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let charset = raw
        .filter(|s| is_safe_mysql_charset_name(s))
        .unwrap_or("utf8mb4");
    let mut out = vec![format!("SET NAMES {}", charset)];
    if let Some(ref cmds) = config.session_init_commands {
        for c in cmds {
            let t = c.trim();
            if !t.is_empty() {
                out.push(t.to_string());
            }
        }
    }
    out
}

fn build_opts(
    host: &str,
    port: u16,
    config: &ConnectionConfig,
    pool_opts: Option<PoolOpts>,
) -> Result<Opts, String> {
    let init = session_init_from_config(config);
    let mut builder = OptsBuilder::default()
        .ip_or_hostname(host)
        .tcp_port(port)
        .user(Some(config.username.as_str()))
        .pass(config.password.as_deref())
        .db_name(config.database.as_deref());
    if !init.is_empty() {
        builder = builder.init(init);
    }
    if let Some(po) = pool_opts {
        builder = builder.pool_opts(po);
    }
    if let Some(ssl) = ssl_opts_from_config(config)? {
        builder = builder.ssl_opts(ssl);
    }
    // 降低长时间空闲后首个包被中间设备掐断的概率。
    builder = builder.tcp_keepalive(Some(Duration::from_millis(30_000)));
    Ok(Opts::from(builder))
}

/// 活跃的数据库连接
pub struct MySqlActiveConnection {
    pub adapter: MySqlDatabaseAdapter,
    pub ssh_tunnel: Option<SshTunnel>,
}

pub struct PostgresActiveConnection {
    pub adapter: PostgresDatabaseAdapter,
    pub ssh_tunnel: Option<SshTunnel>,
    pub cancel_tls: PostgresCancelTls,
}

#[derive(Clone)]
pub enum DatabasePoolHandle {
    MySql(Pool),
    Postgres(PostgresPoolHandle),
}

/// 活跃连接的数据库类型分发结构。
pub enum ActiveDatabaseConnection {
    MySql(MySqlActiveConnection),
    Postgres(PostgresActiveConnection),
}

pub struct ActiveConnection {
    pub database: ActiveDatabaseConnection,
    pub config: ConnectionConfig,
    /// 最后一次活动时间，用于空闲超时断开
    pub last_activity: std::time::Instant,
}

impl ActiveDatabaseConnection {
    fn mysql_pool(&self) -> Result<Pool, String> {
        match self {
            ActiveDatabaseConnection::MySql(conn) => Ok(conn.adapter.pool_clone()),
            ActiveDatabaseConnection::Postgres(_) => {
                Err("当前连接不是 MySQL，不支持该操作".to_string())
            }
        }
    }

    fn pool_handle(&self) -> DatabasePoolHandle {
        match self {
            ActiveDatabaseConnection::MySql(conn) => {
                DatabasePoolHandle::MySql(conn.adapter.pool_clone())
            }
            ActiveDatabaseConnection::Postgres(conn) => {
                DatabasePoolHandle::Postgres(PostgresPoolHandle {
                    pool: conn.adapter.pool_clone(),
                    cancel_tls: conn.cancel_tls.clone(),
                })
            }
        }
    }

    pub fn adapter_database_type(&self) -> DatabaseType {
        match self {
            ActiveDatabaseConnection::MySql(conn) => conn.adapter.database_type(),
            ActiveDatabaseConnection::Postgres(conn) => conn.adapter.database_type(),
        }
    }

    async fn disconnect(self) -> Result<(), String> {
        match self {
            ActiveDatabaseConnection::MySql(mut conn) => {
                if let Some(tunnel) = conn.ssh_tunnel.take() {
                    tunnel.close();
                }
                conn.adapter
                    .into_pool()
                    .disconnect()
                    .await
                    .map_err(|e| format!("断开连接失败: {}", e))
            }
            ActiveDatabaseConnection::Postgres(mut conn) => {
                if let Some(tunnel) = conn.ssh_tunnel.take() {
                    tunnel.close();
                }
                conn.adapter.close();
                Ok(())
            }
        }
    }

    async fn force_disconnect(self) {
        match self {
            ActiveDatabaseConnection::MySql(mut conn) => {
                if let Some(tunnel) = conn.ssh_tunnel.take() {
                    tunnel.close();
                }
                let _ = tokio::time::timeout(
                    Duration::from_secs(2),
                    conn.adapter.into_pool().disconnect(),
                )
                .await;
            }
            ActiveDatabaseConnection::Postgres(mut conn) => {
                if let Some(tunnel) = conn.ssh_tunnel.take() {
                    tunnel.close();
                }
                conn.adapter.close();
            }
        }
    }
}

/// 连接管理器，管理所有活跃的 MySQL 连接
pub struct ConnectionManager {
    connections: HashMap<String, ActiveConnection>,
}

impl ConnectionManager {
    pub fn new() -> Self {
        Self {
            connections: HashMap::new(),
        }
    }

    /// 建立 MySQL 连接（兼容入口）。内部委托给 `prepare_connection` + `register`。
    ///
    /// 注意：该方法持有 `&mut self`，调用方若在持有全局锁时调用，会把慢速网络 I/O 也纳入锁内。
    /// 命令层应改用 `prepare_connection`（锁外）+ `register`（短暂持锁）以避免序列化所有连接的操作。
    pub async fn connect(&mut self, config: ConnectionConfig) -> Result<String, String> {
        let (conn_id, active) = Self::prepare_connection(config).await?;
        self.register(conn_id.clone(), active);
        Ok(conn_id)
    }

    /// 执行建立连接的慢速 I/O（SSH 隧道、建池、测试连接），不接触管理器内部状态，因此可在锁外调用。
    /// 返回新连接 ID 与待注册的 `ActiveConnection`，由调用方在短暂持锁时通过 `register` 写入。
    ///
    /// 如果配置了 SSH 隧道，先建立隧道再通过本地端口连接 MySQL。
    pub async fn prepare_connection(
        config: ConnectionConfig,
    ) -> Result<(String, ActiveConnection), String> {
        match config.database_type {
            DatabaseType::MySql => Self::prepare_mysql_connection(config).await,
            DatabaseType::Postgres => Self::prepare_postgres_connection(config).await,
        }
    }

    async fn prepare_mysql_connection(
        config: ConnectionConfig,
    ) -> Result<(String, ActiveConnection), String> {
        let conn_id = uuid::Uuid::new_v4().to_string();

        let (host, port, tunnel) = if let Some(ssh_config) = &config.ssh {
            // 通过 SSH 隧道连接（与 Tauri 共用 Tokio 运行时，避免嵌套 block_on 死锁）
            let tunnel = SshTunnel::start(ssh_config, &config.host, config.port).await?;
            let local_port = tunnel.local_port();
            (String::from("127.0.0.1"), local_port, Some(tunnel))
        } else {
            // 直接连接
            (config.host.clone(), config.port, None)
        };

        let pool_opts = PoolOpts::default()
            .with_constraints(PoolConstraints::new(0, 5).unwrap())
            .with_inactive_connection_ttl(Duration::from_secs(30))
            .with_ttl_check_interval(Duration::from_secs(15))
            .with_abs_conn_ttl(Some(Duration::from_secs(4 * 3600)));

        let opts = build_opts(&host, port, &config, Some(pool_opts))?;
        let pool = Pool::new(opts);

        // 测试连接是否可用
        let conn = match pool.get_conn().await {
            Ok(conn) => conn,
            Err(e) => {
                // 连接测试失败：显式关闭已建立的 SSH 隧道，避免隧道线程/端口泄漏
                if let Some(tunnel) = tunnel {
                    tunnel.close();
                }
                return Err(format!("连接 MySQL 失败: {}", e));
            }
        };
        drop(conn);

        let active = ActiveConnection {
            database: ActiveDatabaseConnection::MySql(MySqlActiveConnection {
                adapter: MySqlDatabaseAdapter::new(pool),
                ssh_tunnel: tunnel,
            }),
            config,
            last_activity: Instant::now(),
        };

        Ok((conn_id, active))
    }

    async fn prepare_postgres_connection(
        config: ConnectionConfig,
    ) -> Result<(String, ActiveConnection), String> {
        let conn_id = uuid::Uuid::new_v4().to_string();

        let (host, port, tunnel) = if let Some(ssh_config) = &config.ssh {
            let tunnel = SshTunnel::start(ssh_config, &config.host, config.port).await?;
            let local_port = tunnel.local_port();
            (String::from("127.0.0.1"), local_port, Some(tunnel))
        } else {
            (config.host.clone(), config.port, None)
        };

        let handle = match postgres::build_postgres_pool(&host, port, &config) {
            Ok(handle) => handle,
            Err(e) => {
                if let Some(tunnel) = tunnel {
                    tunnel.close();
                }
                return Err(e);
            }
        };

        if let Err(e) = postgres::test_pool(&handle.pool).await {
            if let Some(tunnel) = tunnel {
                tunnel.close();
            }
            handle.pool.close();
            return Err(format!("连接 PostgreSQL 失败: {}", e));
        }

        let active = ActiveConnection {
            database: ActiveDatabaseConnection::Postgres(PostgresActiveConnection {
                adapter: PostgresDatabaseAdapter::new(handle.pool),
                ssh_tunnel: tunnel,
                cancel_tls: handle.cancel_tls,
            }),
            config,
            last_activity: Instant::now(),
        };

        Ok((conn_id, active))
    }

    /// 注册一个已建立好的连接（仅写入 HashMap，调用方只需短暂持锁）。
    pub fn register(&mut self, conn_id: String, active: ActiveConnection) {
        self.connections.insert(conn_id, active);
    }

    /// 断开连接
    /// 若连接已被移除（如空闲超时断开），则静默返回 Ok，保持幂等性
    pub async fn disconnect(&mut self, conn_id: &str) -> Result<(), String> {
        if let Some(conn) = self.connections.remove(conn_id) {
            conn.database.disconnect().await?;
            Ok(())
        } else {
            // 连接已不存在（可能已被空闲超时断开），视为已断开
            Ok(())
        }
    }

    /// 强制移除并尽力关闭连接（不返回断开错误）。
    /// 适用于：连接已被对端/中间设备/系统休眠掐断，常规 disconnect 可能会卡住或报错。
    /// 永远返回 Ok，便于前端在检测到连接失效时无副作用地清理。
    pub async fn force_remove(&mut self, conn_id: &str) -> Result<(), String> {
        if let Some(conn) = self.connections.remove(conn_id) {
            conn.database.force_disconnect().await;
        }
        Ok(())
    }

    /// 探测连接是否仍然可用：尝试获取一个连接并执行 `SELECT 1`。
    ///
    /// - 连接不存在：返回 false（视为不可用）。
    /// - 连接获取或查询失败：返回 false。
    /// - 超时（默认 3 秒）：返回 false。
    ///
    /// 不会自动断开/清理连接，由调用方决定是否后续 `force_remove`。
    pub async fn ping(&self, conn_id: &str) -> bool {
        match self.pool_for_ping(conn_id) {
            Some(DatabasePoolHandle::MySql(pool)) => Self::ping_pool(&pool).await,
            Some(DatabasePoolHandle::Postgres(handle)) => postgres::ping_pool(&handle.pool).await,
            None => false,
        }
    }

    /// 克隆指定连接的连接池引用（不更新活动时间），供命令层在锁外执行探测。
    /// 连接不存在时返回 None。
    pub fn pool_for_ping(&self, conn_id: &str) -> Option<DatabasePoolHandle> {
        self.connections
            .get(conn_id)
            .map(|c| c.database.pool_handle())
    }

    /// 对给定连接池执行带超时的 `SELECT 1` 存活探测；不接触管理器状态，可在锁外调用。
    pub async fn ping_pool(pool: &Pool) -> bool {
        let probe = async {
            let mut conn = pool.get_conn().await.map_err(|e| e.to_string())?;
            let _: Vec<i64> = conn.query("SELECT 1").await.map_err(|e| e.to_string())?;
            Ok::<(), String>(())
        };

        matches!(
            tokio::time::timeout(Duration::from_secs(3), probe).await,
            Ok(Ok(()))
        )
    }

    /// 当前是否存在指定 conn_id 的活跃连接
    pub fn has_connection(&self, conn_id: &str) -> bool {
        self.connections.contains_key(conn_id)
    }

    /// 获取连接池引用并更新最后活动时间
    pub fn get_pool_and_touch(&mut self, conn_id: &str) -> Result<Pool, String> {
        if let Some(conn) = self.connections.get_mut(conn_id) {
            conn.last_activity = Instant::now();
            conn.database.mysql_pool()
        } else {
            Err("连接不存在".to_string())
        }
    }

    /// 获取连接池并更新最后活动时间，按数据库类型返回对应 handle。
    pub fn get_database_pool_and_touch(
        &mut self,
        conn_id: &str,
    ) -> Result<DatabasePoolHandle, String> {
        if let Some(conn) = self.connections.get_mut(conn_id) {
            conn.last_activity = Instant::now();
            Ok(conn.database.pool_handle())
        } else {
            Err("连接不存在".to_string())
        }
    }

    /// 获取连接池并更新活动时间；若为只读连接则拒绝写类操作。
    pub fn get_pool_for_write(&mut self, conn_id: &str) -> Result<Pool, String> {
        let conn = self
            .connections
            .get_mut(conn_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        if conn.config.read_only.unwrap_or(false) {
            return Err("当前连接为只读模式，不允许执行写操作".to_string());
        }
        conn.last_activity = Instant::now();
        conn.database.mysql_pool()
    }

    /// 同 `get_pool_for_write`，但同时支持 MySQL/PostgreSQL，返回带类型分发的 handle。
    pub fn get_database_pool_for_write(
        &mut self,
        conn_id: &str,
    ) -> Result<DatabasePoolHandle, String> {
        let conn = self
            .connections
            .get_mut(conn_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        if conn.config.read_only.unwrap_or(false) {
            return Err("当前连接为只读模式，不允许执行写操作".to_string());
        }
        conn.last_activity = Instant::now();
        Ok(conn.database.pool_handle())
    }

    /// 获取连接池、更新活动时间，并返回该连接是否启用客户端只读模式。
    pub fn get_pool_touch_and_read_only(&mut self, conn_id: &str) -> Result<(Pool, bool), String> {
        let conn = self
            .connections
            .get_mut(conn_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        conn.last_activity = Instant::now();
        let read_only = conn.config.read_only.unwrap_or(false);
        Ok((conn.database.mysql_pool()?, read_only))
    }

    pub fn get_database_pool_touch_and_read_only(
        &mut self,
        conn_id: &str,
    ) -> Result<(DatabasePoolHandle, bool), String> {
        let conn = self
            .connections
            .get_mut(conn_id)
            .ok_or_else(|| "连接不存在".to_string())?;
        conn.last_activity = Instant::now();
        let read_only = conn.config.read_only.unwrap_or(false);
        Ok((conn.database.pool_handle(), read_only))
    }

    /// 检查空闲超时并断开连接，减少凭据驻留时间
    /// 若连接空闲超过 idle_secs 秒则断开，返回 true；否则返回 false
    pub async fn check_idle_and_disconnect(
        &mut self,
        conn_id: &str,
        idle_secs: u64,
    ) -> Result<bool, String> {
        let should_disconnect = self
            .connections
            .get(conn_id)
            .map(|c| c.last_activity.elapsed().as_secs() >= idle_secs)
            .unwrap_or(false);

        if should_disconnect {
            self.disconnect(conn_id).await?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// 测试连接配置是否可用
    pub async fn test_connection(config: &ConnectionConfig) -> Result<u64, String> {
        match config.database_type {
            DatabaseType::MySql => Self::test_mysql_connection(config).await,
            DatabaseType::Postgres => Self::test_postgres_connection(config).await,
        }
    }

    async fn test_mysql_connection(config: &ConnectionConfig) -> Result<u64, String> {
        let start = Instant::now();

        let (host, port, _tunnel) = if let Some(ssh_config) = &config.ssh {
            let tunnel = SshTunnel::start(ssh_config, &config.host, config.port).await?;
            let local_port = tunnel.local_port();
            (String::from("127.0.0.1"), local_port, Some(tunnel))
        } else {
            (config.host.clone(), config.port, None)
        };

        let opts = build_opts(&host, port, config, None)?;
        let pool = Pool::new(opts);

        let mut conn = pool
            .get_conn()
            .await
            .map_err(|e| format!("连接测试失败: {}", e))?;

        // 执行一个简单的查询验证连接
        let _: Vec<String> = conn
            .query("SELECT 1")
            .await
            .map_err(|e| format!("查询测试失败: {}", e))?;

        drop(conn);
        pool.disconnect()
            .await
            .map_err(|e| format!("断开测试连接失败: {}", e))?;

        let latency = start.elapsed().as_millis() as u64;
        Ok(latency)
    }

    async fn test_postgres_connection(config: &ConnectionConfig) -> Result<u64, String> {
        let start = Instant::now();

        let (host, port, tunnel) = if let Some(ssh_config) = &config.ssh {
            let tunnel = SshTunnel::start(ssh_config, &config.host, config.port).await?;
            let local_port = tunnel.local_port();
            (String::from("127.0.0.1"), local_port, Some(tunnel))
        } else {
            (config.host.clone(), config.port, None)
        };

        let handle = match postgres::build_postgres_pool(&host, port, config) {
            Ok(handle) => handle,
            Err(e) => {
                if let Some(tunnel) = tunnel {
                    tunnel.close();
                }
                return Err(e);
            }
        };

        let result = postgres::test_pool(&handle.pool).await;
        handle.pool.close();
        if let Some(tunnel) = tunnel {
            tunnel.close();
        }
        result?;

        Ok(start.elapsed().as_millis() as u64)
    }

    /// 获取所有活跃连接的 ID 列表
    pub fn active_connection_ids(&self) -> Vec<String> {
        self.connections.keys().cloned().collect()
    }
}

/// 从连接池获取连接，遇到 I/O 错误（过期连接）时自动重试一次
pub async fn get_conn_with_retry(pool: &Pool) -> Result<Conn, String> {
    match pool.get_conn().await {
        Ok(conn) => Ok(conn),
        Err(first_err) => {
            let msg = first_err.to_string();
            if msg.contains("connection closed")
                || msg.contains("Input/output error")
                || msg.contains("Broken pipe")
            {
                pool.get_conn()
                    .await
                    .map_err(|e| format!("获取连接失败: {}", e))
            } else {
                Err(format!("获取连接失败: {}", first_err))
            }
        }
    }
}

impl Default for ConnectionManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{ConnectionConfig, DatabaseType};

    #[test]
    fn test_connection_manager_new() {
        let manager = ConnectionManager::new();
        assert!(manager.active_connection_ids().is_empty());
    }

    #[test]
    fn test_get_pool_and_touch_not_found() {
        let mut manager = ConnectionManager::new();
        let result = manager.get_pool_and_touch("nonexistent");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "连接不存在");
    }

    #[tokio::test]
    async fn test_check_idle_disconnect_nonexistent_returns_false() {
        let mut manager = ConnectionManager::new();
        let result = manager
            .check_idle_and_disconnect("nonexistent", 900)
            .await
            .unwrap();
        assert!(!result);
    }

    #[tokio::test]
    async fn test_disconnect_idempotent_when_not_found() {
        let mut manager = ConnectionManager::new();
        // 连接不存在时断开应静默成功（幂等）
        let result = manager.disconnect("nonexistent").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_force_remove_idempotent_when_not_found() {
        let mut manager = ConnectionManager::new();
        // 不存在的连接强制清理应无副作用地成功，方便前端在错误恢复时无脑调用
        let result = manager.force_remove("nonexistent").await;
        assert!(result.is_ok());
        assert!(!manager.has_connection("nonexistent"));
    }

    #[tokio::test]
    async fn test_ping_nonexistent_returns_false() {
        let manager = ConnectionManager::new();
        // 不存在的连接探测应返回 false（视为不可用），不应 panic
        assert!(!manager.ping("nonexistent").await);
    }

    #[test]
    fn test_has_connection_for_unknown_id() {
        let manager = ConnectionManager::new();
        assert!(!manager.has_connection("nonexistent"));
    }

    #[test]
    fn test_active_database_connection_exposes_mysql_adapter_type() {
        let config = sample_config();
        let opts = build_opts("127.0.0.1", 3306, &config, None).unwrap();
        let active = ActiveConnection {
            database: ActiveDatabaseConnection::MySql(MySqlActiveConnection {
                adapter: MySqlDatabaseAdapter::new(Pool::new(opts)),
                ssh_tunnel: None,
            }),
            config,
            last_activity: Instant::now(),
        };

        assert_eq!(active.database.adapter_database_type(), DatabaseType::MySql);
    }

    fn sample_config() -> ConnectionConfig {
        ConnectionConfig {
            id: None,
            database_type: DatabaseType::MySql,
            name: "t".into(),
            host: "h".into(),
            port: 3306,
            username: "u".into(),
            password: None,
            database: None,
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
        }
    }

    #[test]
    fn session_init_default_set_names_utf8mb4() {
        let c = sample_config();
        let v = session_init_from_config(&c);
        assert_eq!(v.first().map(String::as_str), Some("SET NAMES utf8mb4"));
    }

    #[test]
    fn session_init_custom_charset_and_commands() {
        let mut c = sample_config();
        c.client_charset = Some("latin1".into());
        c.session_init_commands = Some(vec!["SET SESSION sql_mode = 'STRICT_TRANS_TABLES'".into()]);
        let v = session_init_from_config(&c);
        assert_eq!(v[0], "SET NAMES latin1");
        assert!(v[1].contains("sql_mode"));
    }

    #[test]
    fn session_init_invalid_charset_falls_back_utf8mb4() {
        let mut c = sample_config();
        c.client_charset = Some("utf8mb4; DROP".into());
        let v = session_init_from_config(&c);
        assert_eq!(v[0], "SET NAMES utf8mb4");
    }

    #[test]
    fn ssl_opts_disabled_when_mode_missing() {
        let mut c = sample_config();
        c.ssl_mode = None;
        assert!(ssl_opts_from_config(&c).unwrap().is_none());
    }

    #[test]
    fn ssl_opts_required_returns_some() {
        let mut c = sample_config();
        c.ssl_mode = Some("required".into());
        assert!(ssl_opts_from_config(&c).unwrap().is_some());
    }

    #[test]
    fn ssl_opts_verify_ca_errors_without_ca_path() {
        let mut c = sample_config();
        c.ssl_mode = Some("verify_ca".into());
        c.ssl_ca_path = None;
        assert!(ssl_opts_from_config(&c).is_err());
    }

    #[test]
    fn ssl_opts_unknown_mode_errors() {
        let mut c = sample_config();
        c.ssl_mode = Some("nope".into());
        assert!(ssl_opts_from_config(&c).is_err());
    }
}
