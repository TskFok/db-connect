use super::connection::load_saved_connections_internal;
use super::temporary_database::{
    find_saved_connection, merge_operation_and_cleanup, merge_single_operation_and_cleanup,
    redact_error_text, temporary_connection_error, validate_endpoint_configs,
    TemporaryDatabaseConnection,
};
use crate::db::connection::DatabasePoolHandle;
use crate::db::schema_compare::{
    compare_schema_snapshots, list_databases_for_compare, load_schema_snapshot, TableSnapshot,
};
use crate::models::types::{
    CompareEndpointInfo, ConnectionConfig, DatabaseCompareEndpointRequest, DatabaseCompareResult,
};
use tauri::AppHandle;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

fn format_compared_at(value: OffsetDateTime) -> Result<String, String> {
    value
        .format(&Rfc3339)
        .map_err(|_| "生成对比时间失败".to_string())
}

fn generate_compared_at() -> Result<String, String> {
    format_compared_at(OffsetDateTime::now_utc())
}

fn redact_command_result<T>(
    result: Result<T, String>,
    saved: &[ConnectionConfig],
) -> Result<T, String> {
    result.map_err(|error| redact_error_text(error, saved))
}

async fn load_selected_snapshot(
    side: &str,
    connection_name: &str,
    pool: DatabasePoolHandle,
    database: &str,
) -> Result<Vec<TableSnapshot>, String> {
    let databases = list_databases_for_compare(pool.clone())
        .await
        .map_err(|error| {
            format!(
                "{}连接「{}」加载数据库列表失败: {}",
                side, connection_name, error
            )
        })?;
    if !databases.iter().any(|name| name == database) {
        return Err(format!(
            "{}连接「{}」中的数据库/schema「{}」不存在",
            side, connection_name, database
        ));
    }
    load_schema_snapshot(pool, database).await.map_err(|error| {
        format!(
            "{}连接「{}」读取对比元数据失败: {}",
            side, connection_name, error
        )
    })
}

#[tauri::command]
pub async fn list_compare_databases(
    app: AppHandle,
    saved_connection_id: String,
) -> Result<Vec<String>, String> {
    let saved = match load_saved_connections_internal(&app) {
        Ok(saved) => saved,
        Err(error) => return redact_command_result(Err(error), &[]),
    };
    let result = list_compare_databases_with_saved(&saved, &saved_connection_id).await;
    redact_command_result(result, &saved)
}

async fn list_compare_databases_with_saved(
    saved: &[ConnectionConfig],
    saved_connection_id: &str,
) -> Result<Vec<String>, String> {
    let config = find_saved_connection(saved, saved_connection_id, "待对比")?;
    let connection_name = config.name.clone();
    let temporary = TemporaryDatabaseConnection::open(config)
        .await
        .map_err(|error| temporary_connection_error("待对比", &connection_name, error))?;
    let operation = list_databases_for_compare(temporary.pool_handle())
        .await
        .map_err(|error| {
            format!(
                "待对比连接「{}」加载数据库列表失败: {}",
                connection_name, error
            )
        });
    let cleanup = temporary.close().await;
    merge_single_operation_and_cleanup(operation, "待对比", cleanup)
}

#[tauri::command]
pub async fn compare_databases(
    app: AppHandle,
    source: DatabaseCompareEndpointRequest,
    target: DatabaseCompareEndpointRequest,
) -> Result<DatabaseCompareResult, String> {
    let saved = match load_saved_connections_internal(&app) {
        Ok(saved) => saved,
        Err(error) => return redact_command_result(Err(error), &[]),
    };
    let result = compare_databases_with_saved(&saved, source, target).await;
    redact_command_result(result, &saved)
}

async fn compare_databases_with_saved(
    saved: &[ConnectionConfig],
    source: DatabaseCompareEndpointRequest,
    target: DatabaseCompareEndpointRequest,
) -> Result<DatabaseCompareResult, String> {
    let source_config = find_saved_connection(saved, &source.saved_connection_id, "源端")?;
    let target_config = find_saved_connection(saved, &target.saved_connection_id, "目标端")?;
    validate_endpoint_configs(&source_config, &target_config)?;

    let database_type = source_config.database_type;
    let source_name = source_config.name.clone();
    let target_name = target_config.name.clone();
    let source_endpoint = CompareEndpointInfo {
        connection_id: source.saved_connection_id,
        connection_name: source_name.clone(),
        database: source.database,
    };
    let target_endpoint = CompareEndpointInfo {
        connection_id: target.saved_connection_id,
        connection_name: target_name.clone(),
        database: target.database,
    };

    let (source_open, target_open) = tokio::join!(
        TemporaryDatabaseConnection::open(source_config),
        TemporaryDatabaseConnection::open(target_config)
    );
    let (source_connection, target_connection) = match (source_open, target_open) {
        (Ok(source_connection), Ok(target_connection)) => (source_connection, target_connection),
        (Ok(source_connection), Err(error)) => {
            let operation = Err(temporary_connection_error("目标端", &target_name, error));
            return merge_single_operation_and_cleanup(
                operation,
                "源端",
                source_connection.close().await,
            );
        }
        (Err(error), Ok(target_connection)) => {
            let operation = Err(temporary_connection_error("源端", &source_name, error));
            return merge_single_operation_and_cleanup(
                operation,
                "目标端",
                target_connection.close().await,
            );
        }
        (Err(source_error), Err(target_error)) => {
            return Err(format!(
                "{}；{}",
                temporary_connection_error("源端", &source_name, source_error),
                temporary_connection_error("目标端", &target_name, target_error)
            ));
        }
    };

    let (source_snapshot, target_snapshot) = tokio::join!(
        load_selected_snapshot(
            "源端",
            &source_name,
            source_connection.pool_handle(),
            &source_endpoint.database,
        ),
        load_selected_snapshot(
            "目标端",
            &target_name,
            target_connection.pool_handle(),
            &target_endpoint.database,
        )
    );

    let operation = match (source_snapshot, target_snapshot) {
        (Ok(source_tables), Ok(target_tables)) => generate_compared_at().map(|compared_at| {
            compare_schema_snapshots(
                database_type,
                source_endpoint,
                target_endpoint,
                compared_at,
                source_tables,
                target_tables,
            )
        }),
        (Err(source_error), Ok(_)) => Err(source_error),
        (Ok(_), Err(target_error)) => Err(target_error),
        (Err(source_error), Err(target_error)) => {
            Err(format!("{}；{}", source_error, target_error))
        }
    };

    let (source_cleanup, target_cleanup) =
        tokio::join!(source_connection.close(), target_connection.close());
    merge_operation_and_cleanup(operation, source_cleanup, target_cleanup)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{ConnectionConfig, DatabaseType, SshConfig, PASSWORD_REDACTED};
    use time::OffsetDateTime;

    fn config(id: &str, database_type: DatabaseType) -> ConnectionConfig {
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
            read_only: None,
            skip_dangerous_sql_confirm: None,
            group_id: None,
        }
    }

    #[test]
    fn resolve_endpoints_requires_distinct_connections_with_same_type() {
        let mysql_a = config("a", DatabaseType::MySql);
        let mysql_b = config("b", DatabaseType::MySql);
        let postgres = config("pg", DatabaseType::Postgres);

        assert!(validate_endpoint_configs(&mysql_a, &mysql_b).is_ok());
        assert_eq!(
            validate_endpoint_configs(&mysql_a, &mysql_a).unwrap_err(),
            "源端和目标端不能使用同一个保存连接"
        );
        assert_eq!(
            validate_endpoint_configs(&mysql_a, &postgres).unwrap_err(),
            "源端和目标端的数据库类型必须一致"
        );
    }

    #[test]
    fn missing_saved_connection_error_names_the_side() {
        let saved = vec![config("source", DatabaseType::MySql)];
        let error = find_saved_connection(&saved, "missing", "目标端").unwrap_err();
        assert_eq!(error, "目标端保存连接不存在或已删除");
    }

    #[test]
    fn merge_operation_and_cleanup_returns_success_when_everything_succeeds() {
        assert_eq!(merge_operation_and_cleanup(Ok(42), Ok(()), Ok(())), Ok(42));
    }

    #[test]
    fn merge_operation_and_cleanup_preserves_operation_failure() {
        assert_eq!(
            merge_operation_and_cleanup::<()>(Err("读取元数据失败".to_string()), Ok(()), Ok(())),
            Err("读取元数据失败".to_string())
        );
    }

    #[test]
    fn merge_operation_and_cleanup_reports_cleanup_failures() {
        assert_eq!(
            merge_operation_and_cleanup(
                Ok(42),
                Err("关闭失败 A".to_string()),
                Err("关闭失败 B".to_string()),
            ),
            Err("释放数据库对比临时连接失败: 源端: 关闭失败 A；目标端: 关闭失败 B".to_string())
        );
    }

    #[test]
    fn merge_operation_and_cleanup_keeps_operation_and_cleanup_failures() {
        assert_eq!(
            merge_operation_and_cleanup::<()>(
                Err("读取元数据失败".to_string()),
                Err("关闭失败".to_string()),
                Ok(()),
            ),
            Err("读取元数据失败；清理临时连接失败: 源端: 关闭失败".to_string())
        );
    }

    #[test]
    fn merge_single_cleanup_error_uses_the_supplied_side() {
        assert_eq!(
            merge_single_operation_and_cleanup::<()>(
                Err("目标端建连失败".to_string()),
                "源端",
                Err("关闭失败".to_string()),
            ),
            Err("目标端建连失败；清理临时连接失败: 源端: 关闭失败".to_string())
        );
    }

    #[test]
    fn compared_at_uses_utc_rfc3339_contract() {
        assert_eq!(
            format_compared_at(OffsetDateTime::UNIX_EPOCH).unwrap(),
            "1970-01-01T00:00:00Z"
        );
    }

    #[test]
    fn command_boundary_redacts_database_ssh_and_pkcs12_passwords() {
        let mut saved = config("secret", DatabaseType::MySql);
        saved.password = Some("db-secret".to_string());
        saved.ssh = Some(SshConfig {
            host: "ssh.example.com".to_string(),
            port: 22,
            username: "ssh-user".to_string(),
            password: Some("ssh-secret".to_string()),
            private_key_path: None,
        });
        saved.ssl_pkcs12_password = Some("certificate-secret".to_string());

        let error = redact_command_result::<()>(
            Err("驱动错误 db-secret；SSH 错误 ssh-secret；证书错误 certificate-secret".to_string()),
            &[saved],
        )
        .unwrap_err();

        assert_eq!(
            error,
            format!(
                "驱动错误 {0}；SSH 错误 {0}；证书错误 {0}",
                PASSWORD_REDACTED
            )
        );
        assert!(!error.contains("db-secret"));
        assert!(!error.contains("ssh-secret"));
        assert!(!error.contains("certificate-secret"));
    }
}
