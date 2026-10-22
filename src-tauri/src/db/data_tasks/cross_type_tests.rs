//! 每个用例均创建自有命名空间；不读取应用保存连接，也不复用个人业务表。
use super::{
    adapters::{batch::Dialect, sqlite::Projection, RowSender},
    executor::{execute_plan, open_session, prepare_task},
    spool::ResourceBudget,
    value::DataValue,
    Cancellation,
};
use crate::{
    commands::temporary_database::TemporaryDatabaseConnection,
    db::connection::DatabasePoolHandle,
    models::{
        data_tasks::*,
        types::{ConnectionConfig, DatabaseType},
    },
};
use mysql_async::prelude::Queryable;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

fn cancellation() -> Cancellation {
    Arc::new(AtomicBool::new(false))
}
pub(crate) struct Fixture {
    pub(crate) config: ConnectionConfig,
    pub(crate) endpoint: DataEndpoint,
    pub(crate) directory: PathBuf,
    pub(crate) dialect: Dialect,
    pub(crate) table: String,
}
impl Fixture {
    pub(crate) async fn new(database_type: DatabaseType, source: bool) -> Self {
        let unique = format!("dbtask_{}", uuid::Uuid::new_v4().simple());
        let directory = std::env::temp_dir().join(&unique);
        std::fs::create_dir(&directory).unwrap();
        let (dialect, url) = match database_type {
            DatabaseType::Sqlite => (Dialect::Sqlite, None),
            DatabaseType::Postgres => (
                Dialect::Postgres,
                Some(
                    std::env::var("DB_CONNECT_DATA_TASK_PG_URL").expect("缺少专属 PostgreSQL 夹具"),
                ),
            ),
            DatabaseType::MySql => (
                Dialect::MySql,
                Some(std::env::var("DB_CONNECT_DATA_TASK_MYSQL_URL").expect("缺少专属 MySQL 夹具")),
            ),
            DatabaseType::SqlServer => (
                Dialect::SqlServer,
                Some(
                    std::env::var("DB_CONNECT_DATA_TASK_SQLSERVER_URL")
                        .expect("缺少专属 SQL Server 夹具"),
                ),
            ),
            _ => panic!("此矩阵仅验证四类事务数据库"),
        };
        let mut config:ConnectionConfig=serde_json::from_value(serde_json::json!({"id":unique,"database_type":database_type,"name":"isolated-cross-type-fixture","host":"","port":0,"username":"","sqlite_path":directory.join("data.sqlite")})).unwrap();
        if let Some(url) = url {
            let parsed = reqwest::Url::parse(&url).unwrap();
            config.host = parsed.host_str().unwrap().into();
            config.port = parsed.port().unwrap_or(match database_type {
                DatabaseType::Postgres => 5432,
                DatabaseType::SqlServer => 1433,
                _ => 3306,
            });
            config.username = parsed.username().into();
            config.password = parsed.password().map(str::to_string);
            config.database = match database_type {
                DatabaseType::Postgres => Some(parsed.path().trim_start_matches('/').to_string())
                    .filter(|s| !s.is_empty())
                    .or(Some("postgres".into())),
                DatabaseType::SqlServer => {
                    config.ssl_mode = Some("required_insecure".into());
                    Some("master".into())
                }
                _ => None,
            };
        }
        let endpoint = DataEndpoint {
            saved_connection_id: unique.clone(),
            database: if database_type == DatabaseType::Sqlite {
                "main".into()
            } else {
                unique.clone()
            },
        };
        let table = format!(
            "{}.{}",
            dialect.identifier(&endpoint.database),
            dialect.identifier("t")
        );
        let fixture = Self {
            config,
            endpoint,
            directory,
            dialect,
            table,
        };
        let types = match database_type {
            DatabaseType::Sqlite => ("INTEGER", "TEXT", "BLOB"),
            DatabaseType::Postgres => ("BIGINT", "TEXT", "BYTEA"),
            DatabaseType::MySql => ("BIGINT", "LONGTEXT", "LONGBLOB"),
            DatabaseType::SqlServer => ("BIGINT", "NVARCHAR(MAX)", "VARBINARY(MAX)"),
            _ => unreachable!(),
        };
        let namespace = if database_type == DatabaseType::Sqlite {
            String::new()
        } else if database_type == DatabaseType::MySql {
            format!(
                "CREATE DATABASE {} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;",
                dialect.identifier(&unique)
            )
        } else {
            format!("CREATE SCHEMA {};", dialect.identifier(&unique))
        };
        // SQL Server 要求 CREATE SCHEMA 是批次的第一条；本次夹具先独立建立命名空间。
        if !namespace.is_empty() {
            fixture.sql(&namespace).await;
        }
        let schema = format!(
            "CREATE TABLE {}(id {} PRIMARY KEY,v {} NULL,b {} NULL);",
            fixture.table, types.0, types.1, types.2
        );
        fixture.sql(&schema).await;
        let blob = match database_type {
            DatabaseType::SqlServer => "0x00ff",
            DatabaseType::Postgres => "decode('00ff','hex')",
            _ => "X'00ff'",
        };
        let chinese = if database_type == DatabaseType::SqlServer {
            "N'中文'"
        } else {
            "'中文'"
        };
        let data = if source {
            format!(
                "INSERT INTO {}(id,v,b)VALUES(9007199254740993,{chinese},{blob}),(2,NULL,NULL);",
                fixture.table
            )
        } else {
            format!(
                "INSERT INTO {}(id,v,b)VALUES(3,'retained',NULL);",
                fixture.table
            )
        };
        fixture.sql(&data).await;
        fixture
    }
    pub(crate) async fn sql(&self, sql: &str) {
        if self.config.database_type == DatabaseType::Sqlite {
            rusqlite::Connection::open(self.config.sqlite_path.as_ref().unwrap())
                .unwrap()
                .execute_batch(sql)
                .unwrap();
            return;
        }
        let temporary = TemporaryDatabaseConnection::open(self.config.clone())
            .await
            .unwrap();
        match temporary.pool_handle() {
            DatabasePoolHandle::Postgres(handle) => handle
                .pool
                .get()
                .await
                .unwrap()
                .batch_execute(sql)
                .await
                .unwrap(),
            DatabasePoolHandle::MySql(pool) => pool
                .get_conn()
                .await
                .unwrap()
                .query_drop(sql)
                .await
                .unwrap(),
            DatabasePoolHandle::SqlServer(handle) => {
                handle
                    .pool
                    .get()
                    .await
                    .unwrap()
                    .simple_query(sql)
                    .await
                    .unwrap()
                    .into_results()
                    .await
                    .unwrap();
            }
            _ => panic!("无效的专属夹具"),
        }
        temporary.close().await.unwrap();
    }
    pub(crate) async fn rows(&self) -> Vec<Vec<DataValue>> {
        let mut session = open_session(self.config.clone(), self.endpoint.clone(), cancellation())
            .await
            .unwrap();
        session.begin_read().await.unwrap();
        session.load_metadata().await.unwrap();
        let (sender, mut receiver) = RowSender::channel(ResourceBudget::default());
        let collect = async move {
            let mut rows = Vec::new();
            while let Some(row) = receiver.recv().await {
                rows.push(row.row.values);
            }
            rows
        };
        let (read, mut rows) = tokio::join!(
            session.stream_rows(
                vec![Projection {
                    table: "t".into(),
                    output_table: "t".into(),
                    columns: vec!["id".into(), "v".into(), "b".into()],
                    key_indices: vec![]
                }],
                cancellation(),
                sender
            ),
            collect
        );
        assert_eq!(read.unwrap(), rows.len() as u64);
        session.rollback().await.unwrap();
        rows.sort_by_key(|r| match r[0] {
            DataValue::Int(v) => v,
            _ => panic!("整数值类型改变"),
        });
        rows
    }
    pub(crate) async fn cleanup(self) {
        if self.config.database_type != DatabaseType::Sqlite {
            let namespace = self.dialect.identifier(&self.endpoint.database);
            self.sql(&match self.config.database_type {
                DatabaseType::MySql => format!("DROP DATABASE {namespace}"),
                DatabaseType::Postgres => format!("DROP SCHEMA {namespace} CASCADE"),
                _ => format!("DROP TABLE {};DROP SCHEMA {namespace};", self.table),
            })
            .await;
        }
        std::fs::remove_dir_all(self.directory).unwrap();
    }
}
fn request(source: &Fixture, target: &Fixture, mode: DataTaskMode) -> DataTaskRequest {
    DataTaskRequest {
        protocol_version: 1,
        kind: if matches!(mode, DataTaskMode::Merge | DataTaskMode::Mirror) {
            DataTaskKind::RowSync
        } else {
            DataTaskKind::Transfer
        },
        mode,
        source: source.endpoint.clone(),
        target: target.endpoint.clone(),
        mappings: vec![TableMapping {
            source_table: "t".into(),
            target_table: "t".into(),
            columns: ["id", "v", "b"]
                .iter()
                .map(|c| ColumnMapping {
                    source_column: (*c).into(),
                    target_column: (*c).into(),
                })
                .collect(),
        }],
    }
}
async fn transfer(source_type: DatabaseType, target_type: DatabaseType, mode: DataTaskMode) {
    let source = Fixture::new(source_type, true).await;
    let target = Fixture::new(target_type, false).await;
    if matches!(mode, DataTaskMode::Merge | DataTaskMode::Mirror) {
        target
            .sql(&format!(
                "INSERT INTO {}(id,v,b)VALUES(2,'old',NULL);",
                target.table
            ))
            .await;
    }
    let directory = source.directory.join("spool");
    let cancel = cancellation();
    let plan = prepare_task(
        "cross-type".into(),
        request(&source, &target, mode),
        source.config.clone(),
        target.config.clone(),
        directory,
        cancel.clone(),
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    source
        .sql(&format!(
            "UPDATE {} SET v='changed-after-preview';",
            source.table
        ))
        .await;
    let result = execute_plan(
        Arc::new(plan),
        source.config.clone(),
        target.config.clone(),
        cancel,
        Arc::new(|_| {}),
    )
    .await;
    assert_eq!(
        result.commit_state,
        DataCommitState::Committed,
        "{:?}",
        result.error
    );
    let mut expected = vec![
        vec![DataValue::Int(2), DataValue::Null, DataValue::Null],
        vec![
            DataValue::Int(9007199254740993),
            DataValue::Text("中文".into()),
            DataValue::Binary(vec![0, 255]),
        ],
    ];
    if matches!(mode, DataTaskMode::Append | DataTaskMode::Merge) {
        expected.insert(
            1,
            vec![
                DataValue::Int(3),
                DataValue::Text("retained".into()),
                DataValue::Null,
            ],
        );
    }
    assert_eq!(target.rows().await, expected);
    source.cleanup().await;
    target.cleanup().await;
}
macro_rules! direction {
    ($name:ident,$source:ident,$target:ident) => {
        #[tokio::test]
        #[ignore = "需专属网络数据库，validate.py 显式执行"]
        async fn $name() {
            transfer(
                DatabaseType::$source,
                DatabaseType::$target,
                DataTaskMode::Append,
            )
            .await;
            transfer(
                DatabaseType::$source,
                DatabaseType::$target,
                DataTaskMode::Replace,
            )
            .await;
        }
    };
}
direction!(real_sqlite_to_postgres, Sqlite, Postgres);
direction!(real_sqlite_to_mysql, Sqlite, MySql);
direction!(real_sqlite_to_sqlserver, Sqlite, SqlServer);
direction!(real_postgres_to_sqlite, Postgres, Sqlite);
direction!(real_postgres_to_mysql, Postgres, MySql);
direction!(real_postgres_to_sqlserver, Postgres, SqlServer);
direction!(real_mysql_to_sqlite, MySql, Sqlite);
direction!(real_mysql_to_postgres, MySql, Postgres);
direction!(real_mysql_to_sqlserver, MySql, SqlServer);
direction!(real_sqlserver_to_sqlite, SqlServer, Sqlite);
direction!(real_sqlserver_to_postgres, SqlServer, Postgres);
direction!(real_sqlserver_to_mysql, SqlServer, MySql);

#[tokio::test]
#[ignore = "需专属 PostgreSQL，验证同类型四种模式"]
async fn real_postgres_same_type_all_modes() {
    transfer(
        DatabaseType::Postgres,
        DatabaseType::Postgres,
        DataTaskMode::Merge,
    )
    .await;
    transfer(
        DatabaseType::Postgres,
        DatabaseType::Postgres,
        DataTaskMode::Mirror,
    )
    .await;
    transfer(
        DatabaseType::Postgres,
        DatabaseType::Postgres,
        DataTaskMode::Append,
    )
    .await;
    transfer(
        DatabaseType::Postgres,
        DatabaseType::Postgres,
        DataTaskMode::Replace,
    )
    .await;
}

#[tokio::test]
#[ignore = "需专属 SQL Server，验证共享执行器的完整事务与取消"]
async fn real_sqlserver_same_type_executor_and_cancel() {
    transfer(
        DatabaseType::SqlServer,
        DatabaseType::SqlServer,
        DataTaskMode::Merge,
    )
    .await;
    transfer(
        DatabaseType::SqlServer,
        DatabaseType::SqlServer,
        DataTaskMode::Mirror,
    )
    .await;
    transfer(
        DatabaseType::SqlServer,
        DatabaseType::SqlServer,
        DataTaskMode::Append,
    )
    .await;
    transfer(
        DatabaseType::SqlServer,
        DatabaseType::SqlServer,
        DataTaskMode::Replace,
    )
    .await;
    let source = Fixture::new(DatabaseType::SqlServer, true).await;
    let target = Fixture::new(DatabaseType::SqlServer, false).await;
    let cancel = cancellation();
    let plan = prepare_task(
        "rollback".into(),
        request(&source, &target, DataTaskMode::Replace),
        source.config.clone(),
        target.config.clone(),
        source.directory.join("spool"),
        cancel.clone(),
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    let signal = cancel.clone();
    let result = execute_plan(
        Arc::new(plan),
        source.config.clone(),
        target.config.clone(),
        cancel,
        Arc::new(move |p| {
            if p.written_rows > 0 {
                signal.store(true, Ordering::Release);
            }
        }),
    )
    .await;
    assert_eq!(result.commit_state, DataCommitState::RolledBack);
    assert_eq!(result.status, DataTaskStatus::Cancelled);
    assert_eq!(
        target.rows().await,
        vec![vec![
            DataValue::Int(3),
            DataValue::Text("retained".into()),
            DataValue::Null
        ]]
    );
    source.cleanup().await;
    target.cleanup().await;
}
