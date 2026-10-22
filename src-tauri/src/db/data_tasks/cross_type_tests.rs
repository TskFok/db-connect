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

#[derive(Clone, Copy)]
enum ExactShape {
    DecimalTimestamp,
    Boolean,
    BooleanTinyInt,
    DateTime,
}
impl Fixture {
    async fn exact_shape(&self, shape: ExactShape, source: bool) {
        use DatabaseType::*;
        let (value_type, other_type) = match shape {
            ExactShape::DecimalTimestamp => (
                if source {
                    "DECIMAL(30,10)"
                } else {
                    "DECIMAL(38,12)"
                },
                match self.config.database_type {
                    Postgres => "TIMESTAMP(6) WITHOUT TIME ZONE",
                    SqlServer if source => "DATETIME2(6)",
                    SqlServer => "DATETIME2",
                    MySql => "DATETIME(6)",
                    _ => unreachable!(),
                },
            ),
            ExactShape::Boolean | ExactShape::BooleanTinyInt => {
                let boolean = match self.config.database_type {
                    SqlServer if matches!(shape, ExactShape::BooleanTinyInt) => "TINYINT",
                    SqlServer => "BIT",
                    MySql => "TINYINT",
                    _ => "BOOLEAN",
                };
                (boolean, boolean)
            }
            ExactShape::DateTime => ("DATE", "TIME(6)"),
        };
        let integer = if self.config.database_type == Sqlite {
            "INTEGER"
        } else {
            "BIGINT"
        };
        let values = match (shape, source) {
            (ExactShape::DecimalTimestamp, true) => "(1,12345678901234567890.1234567890,'2026-10-21 12:34:56.123400'),(2,NULL,NULL),(4,-0.0000000001,'2024-02-29 00:00:00')",
            (ExactShape::DecimalTimestamp, false) => "(3,7,'2020-01-01 01:02:03')",
            (ExactShape::Boolean | ExactShape::BooleanTinyInt, true) if self.config.database_type == Postgres => "(1,TRUE,FALSE),(2,NULL,NULL),(4,FALSE,TRUE)",
            (ExactShape::Boolean | ExactShape::BooleanTinyInt, false) if self.config.database_type == Postgres => "(3,FALSE,FALSE)",
            (ExactShape::Boolean | ExactShape::BooleanTinyInt, true) => "(1,1,0),(2,NULL,NULL),(4,0,1)",
            (ExactShape::Boolean | ExactShape::BooleanTinyInt, false) => "(3,0,0)",
            (ExactShape::DateTime, true) => "(1,'2024-02-29','12:34:56.123400'),(2,NULL,NULL),(4,'1000-01-01','00:00:00')",
            (ExactShape::DateTime, false) => "(3,'2020-01-01','01:02:03')",
        };
        // SQL Server 同批编译 INSERT 会沿用被 DROP 表的旧字段类型。
        self.sql(&format!("DROP TABLE {};CREATE TABLE {}(id {integer} PRIMARY KEY,v {value_type} NULL,b {other_type} NULL);",self.table,self.table)).await;
        self.sql(&format!(
            "INSERT INTO {}(id,v,b)VALUES{values};",
            self.table
        ))
        .await;
    }
}
fn exact_expected(
    database: DatabaseType,
    shape: ExactShape,
    mode: DataTaskMode,
) -> Vec<Vec<DataValue>> {
    use DataValue::*;
    let temporal = |kind: &str, value: &str| Temporal {
        kind: kind.into(),
        value: value.into(),
    };
    let (v1, b1, v3, b3, v4, b4) = match shape {
        ExactShape::DecimalTimestamp => {
            let (kind, one, three, four) = match database {
                DatabaseType::Postgres => (
                    "timestamp",
                    "2026-10-21 12:34:56.1234",
                    "2020-01-01 01:02:03",
                    "2024-02-29 00:00:00",
                ),
                DatabaseType::MySql => (
                    "datetime",
                    "2026-10-21 12:34:56.1234",
                    "2020-01-01 01:02:03",
                    "2024-02-29 00:00:00",
                ),
                _ => (
                    "datetime2",
                    "2026-10-21T12:34:56.1234000",
                    "2020-01-01T01:02:03",
                    "2024-02-29T00:00:00",
                ),
            };
            (
                Decimal("12345678901234567890.123456789".into()),
                temporal(kind, one),
                Decimal("7".into()),
                temporal(kind, three),
                Decimal("-0.0000000001".into()),
                temporal(kind, four),
            )
        }
        ExactShape::Boolean | ExactShape::BooleanTinyInt => {
            let (yes, no) = if matches!(database, DatabaseType::Sqlite | DatabaseType::MySql)
                || matches!(shape, ExactShape::BooleanTinyInt)
            {
                (Int(1), Int(0))
            } else {
                (Bool(true), Bool(false))
            };
            (yes.clone(), no.clone(), no.clone(), no.clone(), no, yes)
        }
        ExactShape::DateTime => {
            let (one, three, four) = match database {
                DatabaseType::Postgres => ("12:34:56.1234", "01:02:03", "00:00:00"),
                DatabaseType::MySql => ("12:34:56.1234", "01:02:03", "00:00:00"),
                _ => ("12:34:56.123400", "01:02:03", "00:00:00"),
            };
            (
                temporal("date", "2024-02-29"),
                temporal("time", one),
                temporal("date", "2020-01-01"),
                temporal("time", three),
                temporal("date", "1000-01-01"),
                temporal("time", four),
            )
        }
    };
    let mut rows = vec![
        vec![Int(1), v1, b1],
        vec![Int(2), Null, Null],
        vec![Int(4), v4, b4],
    ];
    if mode == DataTaskMode::Append {
        rows.insert(2, vec![Int(3), v3, b3]);
    }
    rows
}
async fn exact_transfer(
    source_db: DatabaseType,
    target_db: DatabaseType,
    mode: DataTaskMode,
    shape: ExactShape,
) {
    let source = Fixture::new(source_db, true).await;
    let target = Fixture::new(target_db, false).await;
    source.exact_shape(shape, true).await;
    target.exact_shape(shape, false).await;
    let cancel = cancellation();
    let plan = prepare_task(
        "exact-cross-type".into(),
        request(&source, &target, mode),
        source.config.clone(),
        target.config.clone(),
        source.directory.join("spool"),
        cancel.clone(),
        Arc::new(|_| {}),
    )
    .await
    .unwrap();
    source
        .sql(&format!("UPDATE {} SET v=NULL,b=NULL", source.table))
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
    assert_eq!(target.rows().await, exact_expected(target_db, shape, mode));
    source.cleanup().await;
    target.cleanup().await;
}
macro_rules! exact_direction {
    ($name:ident,$source:ident,$target:ident,$shape:ident) => {
        #[tokio::test]
        #[ignore = "需隔离数据库，验收精确类型跨库追加/替换及冻结源值"]
        async fn $name() {
            exact_transfer(
                DatabaseType::$source,
                DatabaseType::$target,
                DataTaskMode::Append,
                ExactShape::$shape,
            )
            .await;
            exact_transfer(
                DatabaseType::$source,
                DatabaseType::$target,
                DataTaskMode::Replace,
                ExactShape::$shape,
            )
            .await;
        }
    };
}
exact_direction!(
    real_exact_decimal_timestamp_postgres_to_mysql,
    Postgres,
    MySql,
    DecimalTimestamp
);
exact_direction!(
    real_exact_decimal_timestamp_mysql_to_postgres,
    MySql,
    Postgres,
    DecimalTimestamp
);
exact_direction!(
    real_exact_decimal_timestamp_postgres_to_sqlserver,
    Postgres,
    SqlServer,
    DecimalTimestamp
);
exact_direction!(
    real_exact_decimal_timestamp_sqlserver_to_postgres,
    SqlServer,
    Postgres,
    DecimalTimestamp
);
exact_direction!(
    real_exact_decimal_timestamp_mysql_to_sqlserver,
    MySql,
    SqlServer,
    DecimalTimestamp
);
exact_direction!(
    real_exact_decimal_timestamp_sqlserver_to_mysql,
    SqlServer,
    MySql,
    DecimalTimestamp
);
exact_direction!(
    real_exact_boolean_postgres_to_sqlserver,
    Postgres,
    SqlServer,
    Boolean
);
exact_direction!(
    real_exact_boolean_sqlserver_to_postgres,
    SqlServer,
    Postgres,
    Boolean
);
exact_direction!(
    real_exact_boolean_postgres_to_sqlite,
    Postgres,
    Sqlite,
    Boolean
);
exact_direction!(
    real_exact_boolean_sqlite_to_postgres,
    Sqlite,
    Postgres,
    Boolean
);
exact_direction!(
    real_exact_boolean_sqlserver_to_sqlite,
    SqlServer,
    Sqlite,
    Boolean
);
exact_direction!(
    real_exact_boolean_sqlite_to_sqlserver,
    Sqlite,
    SqlServer,
    Boolean
);
exact_direction!(
    real_exact_boolean_postgres_to_mysql,
    Postgres,
    MySql,
    Boolean
);
exact_direction!(
    real_exact_boolean_sqlserver_to_mysql,
    SqlServer,
    MySql,
    Boolean
);
exact_direction!(real_exact_boolean_sqlite_to_mysql, Sqlite, MySql, Boolean);
exact_direction!(
    real_exact_date_time_postgres_to_mysql,
    Postgres,
    MySql,
    DateTime
);
exact_direction!(
    real_exact_date_time_mysql_to_postgres,
    MySql,
    Postgres,
    DateTime
);
exact_direction!(
    real_exact_date_time_postgres_to_sqlserver,
    Postgres,
    SqlServer,
    DateTime
);
exact_direction!(
    real_exact_date_time_sqlserver_to_postgres,
    SqlServer,
    Postgres,
    DateTime
);
exact_direction!(
    real_exact_date_time_mysql_to_sqlserver,
    MySql,
    SqlServer,
    DateTime
);
exact_direction!(
    real_exact_date_time_sqlserver_to_mysql,
    SqlServer,
    MySql,
    DateTime
);

async fn exact_rejection(
    shape: ExactShape,
    source_db: DatabaseType,
    target_db: DatabaseType,
    source_update: &str,
    target_alter: &str,
) {
    let source = Fixture::new(source_db, true).await;
    let target = Fixture::new(target_db, false).await;
    source.exact_shape(shape, true).await;
    target.exact_shape(shape, false).await;
    if !source_update.is_empty() {
        source
            .sql(&format!("UPDATE {} SET {source_update}", source.table))
            .await;
    }
    if !target_alter.is_empty() {
        target
            .sql(&format!("ALTER TABLE {} {target_alter}", target.table))
            .await;
    }
    let before = target.rows().await;
    let error = prepare_task(
        "blocked-exact-cross-type".into(),
        request(&source, &target, DataTaskMode::Replace),
        source.config.clone(),
        target.config.clone(),
        source.directory.join("spool"),
        cancellation(),
        Arc::new(|_| {}),
    )
    .await
    .expect_err("不兼容精确值必须在预览冻结前阻止");
    assert_eq!(error.code, "unsupported_capability", "{error}");
    assert_eq!(target.rows().await, before, "阻止转换时不能触碰目标数据");
    source.cleanup().await;
    target.cleanup().await;
}
#[tokio::test]
#[ignore = "需隔离 PostgreSQL/MySQL，缩窄必须在替换前阻止"]
async fn real_exact_decimal_narrowing_blocks_before_replace() {
    exact_rejection(
        ExactShape::DecimalTimestamp,
        DatabaseType::Postgres,
        DatabaseType::MySql,
        "",
        "MODIFY v DECIMAL(20,5) NULL",
    )
    .await;
}
#[tokio::test]
#[ignore = "需隔离 PostgreSQL/MySQL，时间精度缩窄必须在替换前阻止"]
async fn real_exact_temporal_narrowing_blocks_before_replace() {
    exact_rejection(
        ExactShape::DecimalTimestamp,
        DatabaseType::Postgres,
        DatabaseType::MySql,
        "",
        "MODIFY b DATETIME(3) NULL",
    )
    .await;
}
#[tokio::test]
#[ignore = "需隔离 PostgreSQL/MySQL，日期越界必须在替换前阻止"]
async fn real_exact_date_range_blocks_before_replace() {
    exact_rejection(
        ExactShape::DateTime,
        DatabaseType::Postgres,
        DatabaseType::MySql,
        "v='0001-01-01'",
        "",
    )
    .await;
}
#[tokio::test]
#[ignore = "需隔离 PostgreSQL，SQLite非0/1布尔值必须在替换前阻止"]
async fn real_exact_boolean_invalid_sqlite_blocks_before_replace() {
    exact_rejection(
        ExactShape::Boolean,
        DatabaseType::Sqlite,
        DatabaseType::Postgres,
        "v=2",
        "",
    )
    .await;
}

#[tokio::test]
#[ignore = "需隔离 MySQL，SQLite非0/1布尔值不能因整数目标被放行"]
async fn real_exact_boolean_invalid_sqlite_to_mysql_blocks_before_replace() {
    exact_rejection(
        ExactShape::Boolean,
        DatabaseType::Sqlite,
        DatabaseType::MySql,
        "v=2",
        "",
    )
    .await;
}

exact_direction!(
    real_exact_pg_boolean_to_sqlserver_tinyint,
    Postgres,
    SqlServer,
    BooleanTinyInt
);
exact_direction!(
    real_exact_sqlite_boolean_to_sqlserver_tinyint,
    Sqlite,
    SqlServer,
    BooleanTinyInt
);
