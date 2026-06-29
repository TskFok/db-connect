use crate::models::types::ConnectionConfig;
use bb8::Pool;
use bb8_tiberius::ConnectionManager as SqlServerConnectionManager;
use std::time::Duration;
use tiberius::{AuthMethod, Config as TiberiusConfig, EncryptionLevel};

pub type SqlServerPool = Pool<SqlServerConnectionManager>;

#[derive(Clone)]
pub struct SqlServerPoolHandle {
    pub pool: SqlServerPool,
}

pub(crate) fn normalize_sqlserver_error(context: &str, err: impl AsRef<str>) -> String {
    format!("SQL Server {}: {}", context, err.as_ref())
}

pub(crate) fn build_tiberius_config(
    host: &str,
    port: u16,
    config: &ConnectionConfig,
) -> Result<TiberiusConfig, String> {
    let mut tds = TiberiusConfig::new();
    tds.host(host);
    tds.port(port);
    tds.application_name("db-connect");
    tds.authentication(AuthMethod::sql_server(
        config.username.as_str(),
        config.password.as_deref().unwrap_or(""),
    ));
    if let Some(database) = config
        .database
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        tds.database(database);
    }
    if config.read_only.unwrap_or(false) {
        tds.readonly(true);
    }

    let mode = config
        .ssl_mode
        .as_deref()
        .unwrap_or("disabled")
        .trim()
        .to_lowercase();

    match mode.as_str() {
        "" | "disabled" | "none" | "off" => {
            tds.encryption(EncryptionLevel::Off);
        }
        "required" => {
            tds.encryption(EncryptionLevel::Required);
        }
        "verify_ca" | "verify_identity" => {
            let ca = config
                .ssl_ca_path
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or("VERIFY_CA 模式需要填写 CA 证书路径（PEM）")?;
            tds.encryption(EncryptionLevel::Required);
            tds.trust_cert_ca(ca);
        }
        "required_insecure" => {
            tds.encryption(EncryptionLevel::Required);
            tds.trust_cert();
        }
        other => {
            return Err(format!(
                "未知的 ssl_mode: {}（支持: disabled, required, verify_ca, verify_identity, required_insecure）",
                other
            ));
        }
    }

    if config
        .ssl_pkcs12_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some()
    {
        return Err("SQL Server 暂不支持 PKCS#12 客户端证书".to_string());
    }

    Ok(tds)
}

pub fn build_sqlserver_pool(
    host: &str,
    port: u16,
    config: &ConnectionConfig,
) -> Result<SqlServerPoolHandle, String> {
    let tds = build_tiberius_config(host, port, config)?;
    let manager = SqlServerConnectionManager::new(tds);
    let pool = Pool::builder()
        .max_size(5)
        .connection_timeout(Duration::from_secs(10))
        .build_unchecked(manager);
    Ok(SqlServerPoolHandle { pool })
}

pub async fn test_pool(pool: &SqlServerPool) -> Result<(), String> {
    let mut client = pool
        .get()
        .await
        .map_err(|e| normalize_sqlserver_error("获取连接失败", e.to_string()))?;
    client
        .simple_query("SELECT 1")
        .await
        .map_err(|e| normalize_sqlserver_error("查询测试失败", e.to_string()))?;
    Ok(())
}

pub async fn ping_pool(pool: &SqlServerPool) -> bool {
    let probe = async {
        let mut client = pool.get().await.map_err(|e| e.to_string())?;
        client
            .simple_query("SELECT 1")
            .await
            .map_err(|e| e.to_string())?;
        Ok::<(), String>(())
    };

    matches!(
        tokio::time::timeout(Duration::from_secs(3), probe).await,
        Ok(Ok(()))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{ConnectionConfig, DatabaseType};

    fn sample_config() -> ConnectionConfig {
        ConnectionConfig {
            id: None,
            database_type: DatabaseType::SqlServer,
            name: "SQL Server".to_string(),
            host: "sql.example.com".to_string(),
            port: 1433,
            username: "sa".to_string(),
            password: Some("secret".to_string()),
            database: Some("appdb".to_string()),
            sqlite_path: None,
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
    fn build_tiberius_config_sets_addr_database_and_auth_without_leaking_password() {
        let config = sample_config();

        let tds = build_tiberius_config("127.0.0.1", 14330, &config).unwrap();
        let debug = format!("{:?}", tds);

        assert_eq!(tds.get_addr(), "127.0.0.1:14330");
        assert!(debug.contains("database: Some(\"appdb\")"));
        assert!(debug.contains("SqlServerAuth"));
        assert!(!debug.contains("secret"));
    }

    #[test]
    fn build_tiberius_config_rejects_verify_ca_without_ca_path() {
        let mut config = sample_config();
        config.ssl_mode = Some("verify_ca".to_string());

        let err = build_tiberius_config("127.0.0.1", 1433, &config)
            .expect_err("verify_ca should require a CA path");

        assert!(err.contains("VERIFY_CA 模式需要填写 CA 证书路径"));
    }

    #[test]
    fn normalize_error_adds_sqlserver_context() {
        let msg = normalize_sqlserver_error("连接测试失败", "Login failed");

        assert_eq!(msg, "SQL Server 连接测试失败: Login failed");
    }
}
