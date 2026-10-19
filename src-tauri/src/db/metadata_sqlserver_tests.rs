//! 仅在专属 SQL Server 2022 隔离容器显式运行；不读取应用连接配置。
use crate::db::sql_utils::sqlserver_str;
use crate::db::sqlserver::{
    build_sqlserver_pool, build_tiberius_config, list_tables_batch, SqlServerPool,
};
use crate::models::types::{ConnectionConfig, TableInfo};
use bb8::ManageConnection;
use serde_json::Value;
use std::path::PathBuf;

const SPECIAL_SCHEMA: &str = "metadata'quote\"|]";

fn checked<T, E>(result: Result<T, E>, stage: &str) -> T {
    result.unwrap_or_else(|_| panic!("SQL Server 隔离验收失败：{stage}"))
}

fn connection_config(config: &Value, user: &str) -> ConnectionConfig {
    let port = config["port"].as_u64().expect("缺少隔离端口");
    assert!(port > 1024 && port <= u16::MAX as u64 && port != 1433);
    let password_key = match user {
        "sa" => "password",
        "metadata_owner" => "owner_password",
        "metadata_reader" => "reader_password",
        "metadata_denied" => "denied_password",
        _ => panic!("无效隔离账号"),
    };
    checked(
        serde_json::from_value(serde_json::json!({
            "name": "isolated-metadata-sqlserver",
            "database_type": "sqlserver",
            "host": "127.0.0.1",
            "port": port,
            "username": user,
            "password": config[password_key],
            "database": "metadata_fixture",
            "ssl_mode": config["ssl_mode"].as_str().unwrap_or("required_insecure")
        })),
        "构造临时连接配置",
    )
}

fn pool(config: &Value, user: &str) -> SqlServerPool {
    let settings = connection_config(config, user);
    checked(
        build_sqlserver_pool("127.0.0.1", settings.port, &settings),
        "建立生产连接池",
    )
    .pool
}

async fn probe_connection(config: &Value) -> Value {
    let settings = connection_config(config, "sa");
    let tds = checked(
        build_tiberius_config("127.0.0.1", settings.port, &settings),
        "构造生产 TDS 配置",
    );
    let manager = bb8_tiberius::ConnectionManager::new(tds);
    let connected =
        tokio::time::timeout(std::time::Duration::from_secs(10), manager.connect()).await;
    match connected {
        Ok(Ok(client)) => {
            drop(client);
            let diagnostic = serde_json::json!({"stage": "direct_production_config_connection", "ssl_mode": settings.ssl_mode, "category": "connected", "status": "connected"});
            eprintln!("SQLSERVER_CONNECTION_DIAGNOSTIC {diagnostic}");
            diagnostic
        }
        result => {
            let mut diagnostic = serde_json::json!({"stage": "direct_production_config_connection", "ssl_mode": settings.ssl_mode, "status": "failed"});
            match result {
                Ok(Err(bb8_tiberius::Error::Io(error))) => {
                    diagnostic["category"] = "tcp_io".into();
                    diagnostic["io_kind"] = format!("{:?}", error.kind()).into();
                    diagnostic["os_error"] = serde_json::json!(error.raw_os_error());
                }
                Ok(Err(bb8_tiberius::Error::Tiberius(error))) => {
                    diagnostic["server_error_code"] = serde_json::json!(error.code());
                    match error {
                        tiberius::error::Error::Tls(message) => {
                            diagnostic["category"] = "tls".into();
                            diagnostic["numeric_codes"] = serde_json::json!(message
                                .split(|c: char| c != '-' && !c.is_ascii_digit())
                                .filter_map(|part| part.parse::<i32>().ok())
                                .collect::<Vec<_>>());
                            let lower = message.to_ascii_lowercase();
                            diagnostic["tls_subcategory"] = if lower.contains("certificate")
                                || lower.contains("trust")
                                || lower.contains("hostname")
                            {
                                "certificate_or_identity"
                            } else if lower.contains("protocol")
                                || lower.contains("version")
                                || lower.contains("handshake")
                            {
                                "protocol_or_handshake"
                            } else if lower.contains("security framework")
                                || lower.contains("security-framework")
                                || lower.contains("secure transport")
                                || lower.contains("osstatus")
                            {
                                "native_backend"
                            } else {
                                "other"
                            }
                            .into();
                            let mut safe_message = message;
                            // 仅针对 TLS 错误文本剔除本次随机秘密；不输出其他错误原文。
                            for key in [
                                "password",
                                "owner_password",
                                "reader_password",
                                "denied_password",
                            ] {
                                if let Some(secret) = config[key].as_str() {
                                    safe_message = safe_message.replace(secret, "[REDACTED]");
                                }
                            }
                            let upper = safe_message.to_ascii_uppercase();
                            if [
                                "SELECT ",
                                "CREATE ",
                                "INSERT ",
                                "ALTER ",
                                "WITH REQUESTED",
                                "PASSWORD=",
                            ]
                            .iter()
                            .any(|sql| upper.contains(sql))
                            {
                                diagnostic["tls_error_text_suppressed"] = true.into();
                            } else {
                                diagnostic["tls_error_text"] =
                                    safe_message.chars().take(800).collect::<String>().into();
                            }
                        }
                        tiberius::error::Error::Io { kind, .. } => {
                            diagnostic["category"] = "tds_io".into();
                            diagnostic["io_kind"] = format!("{kind:?}").into();
                        }
                        _ => diagnostic["category"] = "tds_other".into(),
                    }
                }
                Err(_) => diagnostic["category"] = "timeout".into(),
                Ok(Ok(_)) => unreachable!(),
            }
            eprintln!("SQLSERVER_CONNECTION_DIAGNOSTIC {diagnostic}");
            diagnostic
        }
    }
}

async fn scalar_i64(observer: &SqlServerPool, sql: &str, parameter: &str) -> i64 {
    let mut client = checked(observer.get().await, "借出观察连接");
    let row = checked(
        checked(client.query(sql, &[&parameter]).await, "执行观察语句")
            .into_row()
            .await,
        "读取观察结果",
    )
    .expect("观察结果缺失");
    row.get::<i64, _>(0).expect("观察计数类型无效")
}

async fn counter(observer: &SqlServerPool, session: &str) -> i64 {
    let count = scalar_i64(
        observer,
        "SELECT COALESCE((SELECT CAST(t.target_data AS xml).value('sum(//Event/@count)', 'bigint') \
         FROM sys.dm_xe_sessions s JOIN sys.dm_xe_session_targets t ON s.address=t.event_session_address \
         WHERE s.name=@P1 AND t.target_name=N'event_counter'), CAST(-1 AS bigint))",
        session,
    )
    .await;
    assert!(count >= 0, "SQL Server 服务端计数会话或 target 缺失");
    count
}

fn map_row(row: &tiberius::Row) -> TableInfo {
    let nonnegative = |value: Option<i64>| value.and_then(|n| u64::try_from(n).ok());
    TableInfo {
        name: row.get::<&str, _>("name").unwrap_or_default().into(),
        table_type: row.get::<&str, _>("table_type").unwrap_or_default().into(),
        engine: row.get::<&str, _>("engine").map(str::to_string),
        rows: nonnegative(row.get::<i64, _>("rows_est")),
        data_length: nonnegative(row.get::<i64, _>("data_length")),
        index_length: nonnegative(row.get::<i64, _>("index_length")),
        comment: row.get::<&str, _>("comment").unwrap_or_default().into(),
    }
}

async fn legacy_tables(pool: &SqlServerPool, schema: &str) -> Result<Vec<TableInfo>, ()> {
    let mut client = pool.get().await.map_err(|_| ())?;
    let rows = client
        .simple_query(legacy_sql(schema))
        .await
        .map_err(|_| ())?
        .into_first_result()
        .await
        .map_err(|_| ())?;
    Ok(rows.iter().map(map_row).collect())
}

fn assert_tables(actual: &[TableInfo], expected: &[TableInfo]) {
    assert_eq!(
        checked(serde_json::to_value(actual), "序列化当前目录"),
        checked(serde_json::to_value(expected), "序列化原目录")
    );
}

#[tokio::test]
#[ignore = "仅限 metadata-sqlserver-validation.py 创建的 SQL Server 2022 隔离容器"]
async fn metadata_access_isolated_sqlserver2022() {
    let path = checked(
        std::env::var("DB_CONNECT_METADATA_SQLSERVER_FIXTURE"),
        "缺少夹具路径",
    );
    let path = checked(PathBuf::from(path).canonicalize(), "夹具路径无效");
    let config: Value = checked(
        serde_json::from_slice(&checked(
            std::fs::read(path.join("fixture.json")),
            "缺少描述",
        )),
        "夹具描述无效",
    );
    let marker = config["marker"].as_str().expect("缺少随机标记");
    assert_eq!(marker.len(), 32);
    assert!(marker.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert_eq!(
        path,
        PathBuf::from(format!(
            "/private/tmp/db-connect-metadata-sqlserver-{marker}"
        ))
    );
    assert_eq!(
        config["container"],
        format!("db-connect-metadata-sqlserver-{marker}")
    );
    // 两种模式均使用原生产配置构造器，仅比较随机 loopback 夹具。
    let mut required_config = config.clone();
    required_config["ssl_mode"] = "required_insecure".into();
    let required_probe = probe_connection(&required_config).await;
    let mut disabled_config = config.clone();
    disabled_config["ssl_mode"] = "disabled".into();
    let disabled_probe = probe_connection(&disabled_config).await;
    let selected = if config["ssl_mode"].as_str() == Some("disabled") {
        &disabled_probe
    } else {
        &required_probe
    };
    assert_eq!(
        selected["status"], "connected",
        "SQL Server 隔离验收失败：生产配置底层连接"
    );
    let observer = pool(&config, "sa");
    let mut identity_client = checked(observer.get().await, "借出身份连接");
    let identity = checked(
        checked(identity_client.simple_query(
            "SELECT CONVERT(nvarchar(128), SERVERPROPERTY('ProductVersion')) AS version, DB_NAME() AS db_name, token FROM dbo.fixture_marker WHERE id=1"
        ).await, "核验隔离身份").into_row().await,
        "读取隔离身份",
    ).expect("隔离身份缺失");
    let version = identity
        .get::<&str, _>("version")
        .expect("版本缺失")
        .to_string();
    assert!(version.starts_with("16."));
    assert_eq!(identity.get::<&str, _>("db_name"), Some("metadata_fixture"));
    assert_eq!(identity.get::<&str, _>("token"), Some(marker));
    drop(identity_client);
    let owner = pool(&config, "metadata_owner");
    let reader = pool(&config, "metadata_reader");
    let denied = pool(&config, "metadata_denied");
    // 显式预热；空/越界输入随后必须连健康检查 SQL 也不发送。
    drop(checked(owner.get().await, "预热普通账号"));
    drop(checked(reader.get().await, "预热受限账号"));
    drop(checked(denied.get().await, "预热无 DMV 权限账号"));

    let requested: Vec<String> = [
        "metadata_b",
        "metadata_a",
        "metadata_empty",
        SPECIAL_SCHEMA,
        "metadata_missing",
        "metadata_b",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    let before = counter(&observer, "metadata_owner_catalog").await;
    assert!(before >= 0, "目录计数会话必须存在");
    let groups = checked(
        list_tables_batch(&owner, &requested).await,
        "普通账号集合读取",
    );
    let after = counter(&observer, "metadata_owner_catalog").await;
    assert_eq!(after - before, 1, "多 schema 必须只执行一次集合目录查询");
    assert_eq!(
        groups
            .iter()
            .map(|group| group.database.as_str())
            .collect::<Vec<_>>(),
        [
            "metadata_b",
            "metadata_a",
            "metadata_empty",
            SPECIAL_SCHEMA,
            "metadata_missing"
        ]
    );
    assert!(groups[2].tables.is_empty());
    assert!(groups[4].tables.is_empty());
    assert_eq!(groups[0].tables[0].name, "same");
    assert_eq!(groups[0].tables[0].comment, "schema b");
    assert_eq!(groups[3].tables[0].comment, "special schema");
    let view = groups[1]
        .tables
        .iter()
        .find(|table| table.name == "item_view")
        .expect("视图缺失");
    assert_eq!(view.table_type, "VIEW");
    assert!(
        view.engine.is_none()
            && view.rows.is_none()
            && view.data_length.is_none()
            && view.index_length.is_none()
    );
    assert!(groups[1]
        .tables
        .windows(2)
        .all(|pair| pair[0].name < pair[1].name));

    let empty_before = counter(&observer, "metadata_owner_total").await;
    assert!(checked(list_tables_batch(&owner, &[]).await, "空输入").is_empty());
    assert_eq!(
        counter(&observer, "metadata_owner_total").await,
        empty_before,
        "空输入必须零 SQL"
    );
    let oversized: Vec<String> = (0..257).map(|index| format!("unused_{index}")).collect();
    assert!(list_tables_batch(&owner, &oversized).await.is_err());
    assert_eq!(
        counter(&observer, "metadata_owner_total").await,
        empty_before,
        "257 个去重输入必须零 SQL"
    );
    let one_before = counter(&observer, "metadata_owner_catalog").await;
    let one = checked(
        list_tables_batch(&owner, &["metadata_a".into()]).await,
        "单 schema 集合读取",
    );
    assert_eq!(
        counter(&observer, "metadata_owner_catalog").await - one_before,
        1
    );
    assert_tables(&one[0].tables, &groups[1].tables);

    // 旧单 schema SQL 来自优化前提交的独立副本；不调用当前单 schema 包装器自证。
    let old_a = checked(legacy_tables(&owner, "metadata_a").await, "原单 schema a");
    let old_b = checked(legacy_tables(&owner, "metadata_b").await, "原单 schema b");
    let old_empty = checked(legacy_tables(&owner, "metadata_empty").await, "原空 schema");
    let old_special = checked(legacy_tables(&owner, SPECIAL_SCHEMA).await, "原特殊 schema");
    let old_missing = checked(
        legacy_tables(&owner, "metadata_missing").await,
        "原缺失 schema",
    );
    assert_tables(&groups[0].tables, &old_b);
    assert_tables(&groups[1].tables, &old_a);
    assert_tables(&groups[2].tables, &old_empty);
    assert_tables(&groups[3].tables, &old_special);
    assert_tables(&groups[4].tables, &old_missing);

    let reader_before = counter(&observer, "metadata_reader_catalog").await;
    let limited = checked(
        list_tables_batch(&reader, &requested).await,
        "受限账号集合读取",
    );
    let reader_after = counter(&observer, "metadata_reader_catalog").await;
    assert_eq!(reader_after - reader_before, 1);
    assert_eq!(
        limited
            .iter()
            .map(|group| group.database.as_str())
            .collect::<Vec<_>>(),
        groups
            .iter()
            .map(|group| group.database.as_str())
            .collect::<Vec<_>>()
    );
    let limited_a = checked(
        legacy_tables(&reader, "metadata_a").await,
        "受限原 schema a",
    );
    let limited_b = checked(
        legacy_tables(&reader, "metadata_b").await,
        "受限原 schema b",
    );
    let limited_special = checked(
        legacy_tables(&reader, SPECIAL_SCHEMA).await,
        "受限原特殊 schema",
    );
    let limited_empty = checked(
        legacy_tables(&reader, "metadata_empty").await,
        "受限原空 schema",
    );
    let limited_missing = checked(
        legacy_tables(&reader, "metadata_missing").await,
        "受限原缺失 schema",
    );
    assert_tables(&limited[0].tables, &limited_b);
    assert_tables(&limited[1].tables, &limited_a);
    assert_tables(&limited[2].tables, &limited_empty);
    assert_tables(&limited[3].tables, &limited_special);
    assert_tables(&limited[4].tables, &limited_missing);
    let mut limited_client = checked(reader.get().await, "借出受限读取连接");
    let blocked_read = match limited_client
        .simple_query("SELECT id FROM metadata_b.same")
        .await
    {
        Ok(stream) => stream.into_first_result().await.is_err(),
        Err(_) => true,
    };
    assert!(blocked_read, "受限账号不得读取未授权 schema 的数据");
    drop(limited_client);
    assert!(
        legacy_tables(&denied, "metadata_a").await.is_err(),
        "原语义应报告 DMV 权限错误"
    );
    assert!(
        list_tables_batch(&denied, &requested).await.is_err(),
        "混合请求权限失败不得返回部分成功"
    );

    println!(
        "METADATA_SQLSERVER_VALIDATION {}",
        serde_json::json!({
            "status": "passed", "version": version,
            "fixture_ssl_mode": config["ssl_mode"],
            "connection_diagnostics": [required_probe, disabled_probe],
            "scope": "production SQL Server batch adapter; isolated Docker amd64 emulation; no IPC/UI/performance claim",
            "requested_names": requested.len(), "unique_names": groups.len(),
            "server_counter": "synchronous Extended Events package0.event_counter; rpc_starting and sql_batch_starting; per-login total and catalog filters",
            "catalog_query_deltas": {"owner_multi": after-before, "owner_single": 1, "reader_multi": reader_after-reader_before},
            "empty_total_sql_delta": 0, "oversized_total_sql_delta": 0,
            "limited_group_sizes": limited.iter().map(|group| group.tables.len()).collect::<Vec<_>>(),
            "assertions_passed": ["ordinary_and_restricted_logins", "empty_missing_special_schema", "same_table_names_remain_grouped", "table_view_and_null_statistics", "deduplicate_preserve_order", "empty_and_257_zero_sql", "one_and_five_schemas_one_catalog_query", "independent_legacy_single_schema_equivalence", "restricted_ungranted_table_read_denied", "missing_dmv_permission_fails_without_partial_success"],
            "not_measured": ["native_x86_64_supported_host", "other_sqlserver_versions", "SSH", "verified_TLS", "IPC", "UI", "performance_latency"]
        })
    );
}

// 优化前独立对照：b8eae76de751ea26d33830dc7f0823ec9b2b8479。
fn legacy_sql(schema: &str) -> String {
    let schema = sqlserver_str(schema);
    format!(
        "WITH objects AS ( \
           SELECT t.object_id, t.name, CAST('TABLE' AS varchar(5)) AS table_type \
           FROM sys.tables t \
           JOIN sys.schemas s ON s.schema_id = t.schema_id \
           WHERE s.name = N{} AND t.is_ms_shipped = 0 \
           UNION ALL \
           SELECT v.object_id, v.name, CAST('VIEW' AS varchar(5)) AS table_type \
           FROM sys.views v \
           JOIN sys.schemas s ON s.schema_id = v.schema_id \
           WHERE s.name = N{} AND v.is_ms_shipped = 0 \
         ), stats AS ( \
           SELECT object_id, \
                  SUM(CASE WHEN index_id IN (0, 1) THEN row_count ELSE 0 END) AS rows_est, \
                  SUM(in_row_data_page_count + lob_used_page_count + row_overflow_used_page_count) * 8192 AS data_length, \
                  SUM(CASE WHEN used_page_count > in_row_data_page_count + lob_used_page_count + row_overflow_used_page_count \
                           THEN used_page_count - in_row_data_page_count - lob_used_page_count - row_overflow_used_page_count \
                           ELSE 0 END) * 8192 AS index_length \
           FROM sys.dm_db_partition_stats \
           GROUP BY object_id \
         ) \
         SELECT o.name, o.table_type, \
                CASE WHEN o.table_type = 'TABLE' THEN 'SQL Server' ELSE NULL END AS engine, \
                CASE WHEN o.table_type = 'TABLE' THEN CAST(COALESCE(st.rows_est, 0) AS bigint) ELSE NULL END AS rows_est, \
                CASE WHEN o.table_type = 'TABLE' THEN CAST(COALESCE(st.data_length, 0) AS bigint) ELSE NULL END AS data_length, \
                CASE WHEN o.table_type = 'TABLE' THEN CAST(COALESCE(st.index_length, 0) AS bigint) ELSE NULL END AS index_length, \
                COALESCE(CONVERT(nvarchar(4000), ep.value), N'') AS comment \
         FROM objects o \
         LEFT JOIN stats st ON st.object_id = o.object_id \
         LEFT JOIN sys.extended_properties ep \
           ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description' \
         ORDER BY o.name",
        schema, schema
    )
}
