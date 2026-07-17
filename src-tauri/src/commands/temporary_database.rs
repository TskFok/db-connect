use crate::db::connection::{ActiveConnection, ConnectionManager, DatabasePoolHandle};
use crate::models::types::{ConnectionConfig, PASSWORD_REDACTED};
use std::future::Future;
use std::time::Duration;

const TEMPORARY_CONNECTION_CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

pub(crate) struct TemporaryDatabaseConnection {
    active: ActiveConnection,
}

impl TemporaryDatabaseConnection {
    pub(crate) async fn open(config: ConnectionConfig) -> Result<Self, String> {
        let (_, active) = ConnectionManager::prepare_connection(config).await?;
        Ok(Self { active })
    }

    pub(crate) fn pool_handle(&self) -> DatabasePoolHandle {
        self.active.database.pool_handle()
    }

    pub(crate) async fn close(self) -> Result<(), String> {
        run_cleanup_with_timeout(
            self.active.database.disconnect(),
            TEMPORARY_CONNECTION_CLOSE_TIMEOUT,
        )
        .await
    }
}

async fn run_cleanup_with_timeout<F>(cleanup: F, timeout: Duration) -> Result<(), String>
where
    F: Future<Output = Result<(), String>>,
{
    tokio::time::timeout(timeout, cleanup)
        .await
        .unwrap_or_else(|_| Err("释放临时数据库连接超时".to_string()))
}

pub(crate) fn find_saved_connection(
    saved: &[ConnectionConfig],
    connection_id: &str,
    side: &str,
) -> Result<ConnectionConfig, String> {
    saved
        .iter()
        .find(|config| config.id.as_deref() == Some(connection_id))
        .cloned()
        .ok_or_else(|| format!("{}保存连接不存在或已删除", side))
}

pub(crate) fn validate_endpoint_configs(
    source: &ConnectionConfig,
    target: &ConnectionConfig,
) -> Result<(), String> {
    if source.id == target.id {
        return Err("源端和目标端不能使用同一个保存连接".to_string());
    }
    if source.database_type != target.database_type {
        return Err("源端和目标端的数据库类型必须一致".to_string());
    }
    Ok(())
}

#[allow(
    dead_code,
    reason = "Task 8 先提供共享目标端守卫，后续数据库同步命令将直接复用"
)]
pub(crate) fn validate_sync_target(target: &ConnectionConfig) -> Result<(), String> {
    if target.read_only == Some(true) {
        Err("目标端保存连接配置为只读，不能执行数据库同步".to_string())
    } else {
        Ok(())
    }
}

pub(crate) fn merge_operation_and_cleanup<T>(
    operation: Result<T, String>,
    source_cleanup: Result<(), String>,
    target_cleanup: Result<(), String>,
) -> Result<T, String> {
    let cleanup_errors = [
        source_cleanup.err().map(|error| format!("源端: {}", error)),
        target_cleanup
            .err()
            .map(|error| format!("目标端: {}", error)),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    merge_operation_with_cleanup_errors(operation, cleanup_errors)
}

fn merge_operation_with_cleanup_errors<T>(
    operation: Result<T, String>,
    cleanup_errors: Vec<String>,
) -> Result<T, String> {
    match (operation, cleanup_errors.is_empty()) {
        (Ok(value), true) => Ok(value),
        (Ok(_), false) => Err(format!(
            "释放数据库对比临时连接失败: {}",
            cleanup_errors.join("；")
        )),
        (Err(error), true) => Err(error),
        (Err(error), false) => Err(format!(
            "{}；清理临时连接失败: {}",
            error,
            cleanup_errors.join("；")
        )),
    }
}

pub(crate) fn merge_single_operation_and_cleanup<T>(
    operation: Result<T, String>,
    cleanup_side: &str,
    cleanup: Result<(), String>,
) -> Result<T, String> {
    let cleanup_errors = cleanup
        .err()
        .map(|error| format!("{}: {}", cleanup_side, error))
        .into_iter()
        .collect();
    merge_operation_with_cleanup_errors(operation, cleanup_errors)
}

pub(crate) fn temporary_connection_error(side: &str, name: &str, error: String) -> String {
    format!("{}连接「{}」建立临时连接失败: {}", side, name, error)
}

pub(crate) fn redact_error_text(mut error: String, saved: &[ConnectionConfig]) -> String {
    let mut secrets = saved
        .iter()
        .flat_map(|config| {
            [
                config.password.as_deref(),
                config.ssh.as_ref().and_then(|ssh| ssh.password.as_deref()),
                config.ssl_pkcs12_password.as_deref(),
            ]
        })
        .flatten()
        .filter(|secret| !secret.is_empty() && *secret != PASSWORD_REDACTED)
        .collect::<Vec<_>>();
    secrets.sort_unstable_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    secrets.dedup();
    for secret in secrets {
        error = error.replace(secret, PASSWORD_REDACTED);
    }
    error
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{ConnectionConfig, DatabaseType, SshConfig};

    fn config(id: &str, database_type: DatabaseType, read_only: bool) -> ConnectionConfig {
        ConnectionConfig {
            id: Some(id.to_string()),
            database_type,
            name: format!("连接-{id}"),
            host: "127.0.0.1".to_string(),
            port: 3306,
            username: "tester".to_string(),
            password: None,
            database: None,
            sqlite_path: None,
            ssh: None,
            ssl_mode: None,
            ssl_ca_path: None,
            ssl_pkcs12_path: None,
            ssl_pkcs12_password: None,
            ssl_tls_hostname: None,
            client_charset: None,
            session_init_commands: None,
            read_only: Some(read_only),
            skip_dangerous_sql_confirm: None,
            group_id: None,
        }
    }

    fn config_with_secrets(
        database_password: &str,
        ssh_password: &str,
        certificate_password: &str,
    ) -> ConnectionConfig {
        let mut config = config("secret", DatabaseType::MySql, false);
        config.password = Some(database_password.to_string());
        config.ssh = Some(SshConfig {
            host: "ssh.example.com".to_string(),
            port: 22,
            username: "ssh-user".to_string(),
            password: Some(ssh_password.to_string()),
            private_key_path: None,
        });
        config.ssl_pkcs12_password = Some(certificate_password.to_string());
        config
    }

    #[test]
    fn validation_rejects_same_connection_and_read_only_target() {
        let source = config("same", DatabaseType::MySql, false);
        let same_target = config("same", DatabaseType::MySql, false);
        assert_eq!(
            validate_endpoint_configs(&source, &same_target).unwrap_err(),
            "源端和目标端不能使用同一个保存连接"
        );
        let target = config("target", DatabaseType::MySql, true);
        assert_eq!(
            validate_sync_target(&target).unwrap_err(),
            "目标端保存连接配置为只读，不能执行数据库同步"
        );
    }

    #[test]
    fn redaction_removes_database_ssh_and_certificate_passwords() {
        let saved = vec![config_with_secrets("db-pass", "ssh-pass", "cert-pass")];
        let redacted = redact_error_text("db-pass / ssh-pass / cert-pass".to_string(), &saved);
        assert_eq!(redacted, "•••••••• / •••••••• / ••••••••");
    }

    #[tokio::test]
    async fn cleanup_timeout_returns_completed_result() {
        let result = run_cleanup_with_timeout(async { Ok(()) }, Duration::from_millis(50)).await;
        assert_eq!(result, Ok(()));
    }

    #[tokio::test]
    async fn cleanup_timeout_returns_clear_error_when_deadline_expires() {
        let result = run_cleanup_with_timeout(
            std::future::pending::<Result<(), String>>(),
            Duration::from_millis(1),
        )
        .await;
        assert_eq!(result.unwrap_err(), "释放临时数据库连接超时");
    }
}
