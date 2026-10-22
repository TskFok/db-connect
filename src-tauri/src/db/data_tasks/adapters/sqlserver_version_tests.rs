//! SQL Server 2017/2019/2022/2025 专属容器合约；不读取应用保存连接。
use super::{id, open, server_version_verified};
use crate::{
    db::{
        data_tasks::{
            executor::{execute_plan, prepare_task},
            metadata::{DataMetadataSnapshot, DataTable},
            plan::StoredDataPlan,
            Cancellation,
        },
        sqlserver::build_tiberius_config,
    },
    models::{data_tasks::*, types::ConnectionConfig},
};
use bb8::ManageConnection;
use bb8_tiberius::{rt::Client, ConnectionManager};
use futures_util::FutureExt;
use std::{
    panic::AssertUnwindSafe,
    path::Path,
    sync::{atomic::AtomicBool, atomic::AtomicU64, atomic::Ordering, Arc},
    time::Duration,
};
use tiberius::Row;

// URL、驱动错误可能包含口令；验收日志只输出固定阶段及经过校验的数字版本。
fn required<T, E>(result: Result<T, E>, stage: &str) -> T {
    result.unwrap_or_else(|_| panic!("{stage}"))
}

fn cancel() -> Cancellation {
    Arc::new(AtomicBool::new(false))
}

fn url_component(value: &str) -> String {
    let mut bytes = Vec::new();
    let mut input = value.as_bytes().iter().copied();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let high = input.next().and_then(|b| (b as char).to_digit(16));
            let low = input.next().and_then(|b| (b as char).to_digit(16));
            bytes.push(((high.expect("URL 转义无效") << 4) | low.expect("URL 转义无效")) as u8);
        } else {
            bytes.push(byte);
        }
    }
    required(String::from_utf8(bytes), "URL 字符编码无效")
}

fn string(row: &Row, index: usize) -> String {
    required(row.try_get::<&str, _>(index), "字符串回读失败")
        .expect("字符串回读为空")
        .into()
}

struct Fixture {
    observer: Client,
    config: ConnectionConfig,
    endpoint: DataEndpoint,
    version: String,
    major: i32,
    instance: String,
    events: Option<String>,
}

impl Fixture {
    async fn connect(env: &str) -> Self {
        let url = required(std::env::var(env), "必须显式提供专属 SQL Server 容器 URL");
        let parsed = required(reqwest::Url::parse(&url), "专属 SQL Server URL 无效");
        assert!(parsed.scheme() == "sqlserver", "夹具必须使用 sqlserver URL");
        let host = parsed.host_str().expect("夹具缺少回环地址");
        assert!(
            matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1"),
            "合约仅允许本机回环 TCP 地址"
        );
        let port = parsed.port().expect("夹具必须显式指定随机端口");
        assert!(port != 0 && port != 1433, "夹具必须使用容器随机映射端口");
        assert!(
            parsed.query().is_none() && parsed.fragment().is_none(),
            "夹具不接受额外 URL 连接选项"
        );
        let database = url_component(parsed.path().trim_start_matches('/'));
        assert!(!database.is_empty(), "夹具必须显式指定数据库");
        let unique = format!("data_task_mssql_{}", uuid::Uuid::new_v4().simple());
        let config: ConnectionConfig = required(
            serde_json::from_value(serde_json::json!({
                "id": unique,
                "database_type": "sqlserver",
                "name": "SQL Server 版本隔离合约",
                "host": host.trim_matches(['[', ']']),
                "port": port,
                "username": url_component(parsed.username()),
                "password": parsed.password().map(url_component),
                "database": database,
                "ssl_mode": "required_insecure",
                "ssh": null
            })),
            "构造隔离连接失败",
        );
        let mut tds = required(
            build_tiberius_config(&config.host, config.port, &config),
            "构造专属实例连接失败",
        );
        // 元数据预算只统计适配器的 db-connect 会话，不统计测试观察连接。
        tds.application_name("data-task-sqlserver-observer");
        let manager = ConnectionManager::new(tds);
        let mut observer = required(
            required(
                tokio::time::timeout(Duration::from_secs(15), manager.connect()).await,
                "连接专属实例超时",
            ),
            "连接专属实例失败",
        );
        let rows = required(
            required(
                observer
                    .simple_query(
                        "SELECT CAST(SERVERPROPERTY(N'ProductVersion') AS nvarchar(100)),\
                 CAST(SERVERPROPERTY(N'ProductMajorVersion') AS int),\
                 CAST(SERVERPROPERTY(N'ProductLevel') AS nvarchar(100)),\
                 CAST(SERVERPROPERTY(N'EngineEdition') AS int),\
                 CAST(SERVERPROPERTY(N'ServerName') AS nvarchar(256))",
                    )
                    .await,
                "读取实例版本失败",
            )
            .into_first_result()
            .await,
            "读取实例版本结果失败",
        );
        let facts = rows.first().expect("实例版本事实缺失");
        let version = string(facts, 0);
        let major = facts.get::<i32, _>(1).expect("实例主版本缺失");
        assert!(
            server_version_verified(
                major,
                &version,
                &string(facts, 2),
                facts.get(3).expect("实例引擎缺失")
            ),
            "实例未通过版本门禁"
        );
        assert!(
            version.bytes().all(|b| b.is_ascii_digit() || b == b'.'),
            "版本日志必须只包含数字"
        );
        let mut fixture = Self {
            observer,
            config,
            endpoint: DataEndpoint {
                saved_connection_id: unique.clone(),
                database: unique.clone(),
            },
            version,
            major,
            instance: string(facts, 4),
            events: None,
        };
        // 兼容级别和 ledger 都是数据库级能力；新建本任务专属库，避免修改 URL 指定库。
        fixture
            .sql(format!("CREATE DATABASE {}", id(&unique)))
            .await;
        fixture
            .sql(format!(
                "ALTER DATABASE {} SET ALLOW_SNAPSHOT_ISOLATION ON; USE {}",
                id(&unique),
                id(&unique)
            ))
            .await;
        fixture.config.database = Some(unique);
        fixture
            .sql(format!("CREATE SCHEMA {}", id(&fixture.endpoint.database)))
            .await;
        fixture
    }

    async fn sql(&mut self, sql: String) {
        self.observer
            .simple_query(sql)
            .await
            .unwrap_or_else(|error| panic!("夹具 SQL 执行失败，服务端代码 {:?}", error.code()))
            .into_results()
            .await
            .unwrap_or_else(|error| panic!("夹具 SQL 结果读取失败，服务端代码 {:?}", error.code()));
    }

    async fn rows(&mut self, sql: String) -> Vec<Row> {
        required(
            required(self.observer.simple_query(sql).await, "夹具核验查询失败")
                .into_first_result()
                .await,
            "夹具核验结果读取失败",
        )
    }

    async fn compatibility(&mut self, level: i32) {
        self.sql(format!(
            "ALTER DATABASE {} SET COMPATIBILITY_LEVEL = {level}",
            id(self.config.database.as_deref().expect("数据库缺失"))
        ))
        .await;
    }

    async fn start_budget(&mut self) {
        let name = format!("data_task_rpc_{}", uuid::Uuid::new_v4().simple());
        self.sql(format!("CREATE EVENT SESSION {} ON SERVER ADD EVENT sqlserver.rpc_starting(WHERE (sqlserver.client_app_name=N'db-connect')) ADD TARGET package0.event_counter WITH(MAX_MEMORY=1024KB); ALTER EVENT SESSION {} ON SERVER STATE=START", id(&name), id(&name))).await;
        self.events = Some(name);
    }

    async fn rpc_count(&mut self) -> i64 {
        // event_counter 是同步目标；一次读取即可核验，不通过轮询查询等待事件。
        let name = self.events.as_ref().expect("查询预算事件缺失");
        let rows = self.rows(format!("SELECT CAST(t.target_data AS xml).value('sum(//Event/@count)','bigint') FROM sys.dm_xe_session_targets t JOIN sys.dm_xe_sessions s ON s.address=t.event_session_address WHERE s.name=N'{name}' AND t.target_name=N'event_counter'")).await;
        rows.first()
            .and_then(|r| r.get(0))
            .expect("查询预算计数缺失")
    }

    async fn stop_budget(&mut self) {
        if let Some(name) = self.events.take() {
            self.sql(format!("DROP EVENT SESSION {} ON SERVER", id(&name)))
                .await;
        }
    }

    async fn close(mut self) {
        self.stop_budget().await;
        let database = id(self.config.database.as_deref().expect("专属数据库缺失"));
        // DROP DATABASE 同时清除时态历史与 ledger 逻辑删除对象，不遗留随机 schema。
        self.sql("USE [master]".into()).await;
        self.sql(format!("DROP DATABASE {database}")).await;
    }
}

fn mapping(source: &str, target: &str, columns: &[&str]) -> TableMapping {
    TableMapping {
        source_table: source.into(),
        target_table: target.into(),
        columns: columns
            .iter()
            .map(|name| ColumnMapping {
                source_column: (*name).into(),
                target_column: (*name).into(),
            })
            .collect(),
    }
}

fn request(
    source: &Fixture,
    target: &Fixture,
    mode: DataTaskMode,
    mappings: Vec<TableMapping>,
) -> DataTaskRequest {
    DataTaskRequest {
        protocol_version: 1,
        kind: match mode {
            DataTaskMode::Merge | DataTaskMode::Mirror => DataTaskKind::RowSync,
            DataTaskMode::Append | DataTaskMode::Replace => DataTaskKind::Transfer,
        },
        source: source.endpoint.clone(),
        target: target.endpoint.clone(),
        mappings,
        mode,
    }
}

async fn prepare(
    source: &Fixture,
    target: &Fixture,
    request: DataTaskRequest,
    directory: &Path,
) -> StoredDataPlan {
    required(
        prepare_task(
            format!("sqlserver-version-{}", uuid::Uuid::new_v4().simple()),
            request,
            source.config.clone(),
            target.config.clone(),
            directory.to_path_buf(),
            cancel(),
            Arc::new(|_| {}),
        )
        .await,
        "SQL Server 版本预览失败",
    )
}

async fn execute(source: &Fixture, target: &Fixture, plan: StoredDataPlan) {
    let mode = plan.request.mode;
    let table = plan.request.mappings[0].target_table.clone();
    let result = execute_plan(
        Arc::new(plan),
        source.config.clone(),
        target.config.clone(),
        cancel(),
        Arc::new(|_| {}),
    )
    .await;
    assert!(
        result.status == DataTaskStatus::Succeeded
            && result.commit_state == DataCommitState::Committed
            && result.cleanup_errors.is_empty(),
        "版本任务必须成功提交并释放资源：mode={mode:?}, table={table}, status={:?}, commit={:?}, code={:?}, cleanup_count={}",
        result.status, result.commit_state, result.error.as_ref().map(|e| &e.code), result.cleanup_errors.len()
    );
}

async fn metadata(fixture: &Fixture) -> DataMetadataSnapshot {
    let mut session = required(
        open(fixture.config.clone(), fixture.endpoint.clone(), cancel()).await,
        "打开版本元数据会话失败",
    );
    required(session.begin_read().await, "打开元数据快照失败");
    let snapshot = required(session.load_metadata().await, "读取版本元数据失败");
    required(session.rollback().await, "关闭元数据快照失败");
    snapshot
}

fn table<'a>(snapshot: &'a DataMetadataSnapshot, name: &str) -> &'a DataTable {
    snapshot
        .tables
        .iter()
        .find(|t| t.name == name)
        .expect("元数据夹具表缺失")
}

const EXACT_COLUMNS: [&str; 12] = [
    "id",
    "signed_value",
    "amount",
    "bytes_value",
    "dt",
    "offset_value",
    "d",
    "tm",
    "real_value",
    "double_value",
    "flag",
    "v",
];
const EXACT_DEFINITION: &str = "id BIGINT IDENTITY(1,1) PRIMARY KEY,signed_value BIGINT NULL,amount DECIMAL(38,20) NULL,bytes_value VARBINARY(MAX) NULL,dt DATETIME2(7) NULL,offset_value DATETIMEOFFSET(7) NULL,d DATE NULL,tm TIME(7) NULL,real_value REAL NULL,double_value FLOAT(53) NULL,flag BIT NULL,v NVARCHAR(MAX) NULL";
// REAL 最小正规数使用完整有效数字；较短的 1.17549435e-38 低于边界，SQL Server 会下溢为零。
const SOURCE_VALUES: &str = "\
    (9007199254740993,-9223372036854775808,123456789012345678.12345678901234567890,0x0001FEFF,'2026-10-20T12:34:56.1234567','2026-10-20T12:34:56.1234567+08:00','9999-12-31','23:59:59.9999999',0.1,0.1,1,N'中文😀尾空格  '),\
    (9007199254740994,9223372036854775807,-0.00000000000000000001,0x,'0001-01-01T00:00:00.0000001','2000-01-01T00:00:00.0000001-03:30','0001-01-01','00:00:00.0000001',1.1754943508222875e-38,1.7976931348623157e308,0,N''),\
    (9007199254740995,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)";

fn strings(values: &[&str]) -> Vec<Option<String>> {
    values.iter().map(|v| Some((*v).into())).collect()
}

fn exact_expected() -> Vec<Vec<Option<String>>> {
    let mut nulls = vec![None; EXACT_COLUMNS.len()];
    nulls[0] = Some("9007199254740995".into());
    vec![
        strings(&[
            "9007199254740993",
            "-9223372036854775808",
            "123456789012345678.12345678901234567890",
            "0001FEFF",
            "2026-10-20T12:34:56.1234567",
            "2026-10-20T12:34:56.1234567+08:00",
            "9999-12-31",
            "23:59:59.9999999",
            "3dcccccd",
            "3fb999999999999a",
            "1",
            "中文😀尾空格  ",
        ]),
        strings(&[
            "9007199254740994",
            "9223372036854775807",
            "-0.00000000000000000001",
            "",
            "0001-01-01T00:00:00.0000001",
            "2000-01-01T00:00:00.0000001-03:30",
            "0001-01-01",
            "00:00:00.0000001",
            "00800000",
            "7fefffffffffffff",
            "0",
            "",
        ]),
        nulls,
    ]
}

fn retained_row() -> Vec<Option<String>> {
    let mut row = vec![None; EXACT_COLUMNS.len()];
    row[0] = Some("9007199254740996".into());
    row[11] = Some("target-only".into());
    row
}

async fn exact_rows(fixture: &mut Fixture, table: &str) -> Vec<Vec<Option<String>>> {
    let rows = fixture.rows(format!("SELECT CONVERT(nvarchar(max),id),CONVERT(nvarchar(max),signed_value),CONVERT(nvarchar(max),amount),CONVERT(varchar(max),bytes_value,2),CONVERT(nvarchar(max),dt,126),CONVERT(nvarchar(max),offset_value,126),CONVERT(nvarchar(max),d,126),CONVERT(nvarchar(max),tm,126),real_value,double_value,CONVERT(nvarchar(max),flag),v FROM {}.{} ORDER BY id", id(&fixture.endpoint.database), id(table))).await;
    // 由独立 TDS 读回浮点位模式，不复用适配器编码器，避免同源错误相互掩盖。
    rows.iter()
        .map(|row| {
            (0..EXACT_COLUMNS.len())
                .map(|index| match index {
                    8 => required(row.try_get::<f32, _>(index), "REAL 回读失败")
                        .map(|v| format!("{:08x}", v.to_bits())),
                    9 => required(row.try_get::<f64, _>(index), "FLOAT 回读失败")
                        .map(|v| format!("{:016x}", v.to_bits())),
                    _ => required(row.try_get::<&str, _>(index), "精确值回读失败")
                        .map(str::to_string),
                })
                .collect()
        })
        .collect()
}

async fn exact_modes(source: &mut Fixture, target: &mut Fixture, directory: &Path) {
    let s = id(&source.endpoint.database);
    let t = id(&target.endpoint.database);
    let columns = EXACT_COLUMNS
        .iter()
        .map(|name| id(name))
        .collect::<Vec<_>>()
        .join(",");
    source.sql(format!("CREATE TABLE {s}.exact_rows({EXACT_DEFINITION}); SET IDENTITY_INSERT {s}.exact_rows ON; INSERT INTO {s}.exact_rows({columns}) VALUES {SOURCE_VALUES}; SET IDENTITY_INSERT {s}.exact_rows OFF")).await;
    target.sql(format!("CREATE TABLE {t}.exact_rows({EXACT_DEFINITION}); CREATE TABLE {t}.transfer_rows({EXACT_DEFINITION}); SET IDENTITY_INSERT {t}.exact_rows ON; INSERT INTO {t}.exact_rows(id,signed_value,amount,bytes_value,v) VALUES(9007199254740994,0,1,0xFF,N'old'),(9007199254740996,NULL,NULL,NULL,N'target-only'); SET IDENTITY_INSERT {t}.exact_rows OFF; SET IDENTITY_INSERT {t}.transfer_rows ON; INSERT INTO {t}.transfer_rows(id,v) VALUES(9007199254740996,N'target-only'); SET IDENTITY_INSERT {t}.transfer_rows OFF")).await;
    let mut expected = exact_expected();
    assert_eq!(
        exact_rows(source, "exact_rows").await,
        expected,
        "源夹具必须保留全部边界值"
    );
    let mappings = vec![mapping("exact_rows", "exact_rows", &EXACT_COLUMNS)];
    let merge = prepare(
        source,
        target,
        request(source, target, DataTaskMode::Merge, mappings.clone()),
        directory,
    )
    .await;
    let counts = &merge.preview.tables[0].counts;
    assert!(
        counts.inserted == "2" && counts.updated == "1" && counts.retained == "1",
        "合并应覆盖插入、更新及保留"
    );
    source
        .sql(format!(
            "UPDATE {s}.exact_rows SET v=N'source-after-preview' WHERE id=9007199254740993"
        ))
        .await;
    execute(source, target, merge).await;
    let mut retained = expected.clone();
    retained.push(retained_row());
    assert!(
        exact_rows(target, "exact_rows").await == retained,
        "合并必须使用冻结源并无损保留所有列"
    );

    expected[0][11] = Some("source-after-preview".into());
    let mirror = prepare(
        source,
        target,
        request(source, target, DataTaskMode::Mirror, mappings),
        directory,
    )
    .await;
    assert!(
        mirror.preview.tables[0].counts.deleted == "1",
        "镜像必须识别目标独有行"
    );
    execute(source, target, mirror).await;
    assert!(
        exact_rows(target, "exact_rows").await == expected,
        "镜像必须准确删除目标独有行"
    );

    let mappings = vec![mapping("exact_rows", "transfer_rows", &EXACT_COLUMNS)];
    let append = prepare(
        source,
        target,
        request(source, target, DataTaskMode::Append, mappings.clone()),
        directory,
    )
    .await;
    execute(source, target, append).await;
    let mut appended = expected.clone();
    appended.push(retained_row());
    assert!(
        exact_rows(target, "transfer_rows").await == appended,
        "追加必须无损写入并保留旧行"
    );
    let replace = prepare(
        source,
        target,
        request(source, target, DataTaskMode::Replace, mappings),
        directory,
    )
    .await;
    execute(source, target, replace).await;
    assert!(
        exact_rows(target, "transfer_rows").await == expected,
        "替换必须无损写回全部源值"
    );
    let generated = target
        .rows(format!(
            "INSERT INTO {t}.transfer_rows(v) OUTPUT inserted.id VALUES(N'default-after-transfer')"
        ))
        .await;
    assert!(
        generated
            .first()
            .and_then(|r| r.get::<i64, _>(0))
            .is_some_and(|v| v > 9007199254740996),
        "显式大整数传输后 identity 不得回退"
    );
}

async fn simple_rows(fixture: &mut Fixture, table: &str) -> Vec<(i64, String)> {
    fixture
        .rows(format!(
            "SELECT id,v FROM {}.{} ORDER BY id",
            id(&fixture.endpoint.database),
            id(table)
        ))
        .await
        .iter()
        .map(|r| (r.get(0).expect("键回读失败"), string(r, 1)))
        .collect()
}

async fn stale_and_rollback(source: &mut Fixture, target: &mut Fixture, directory: &Path) {
    let s = id(&source.endpoint.database);
    let t = id(&target.endpoint.database);
    source.sql(format!("CREATE TABLE {s}.drift_rows(id BIGINT PRIMARY KEY,v NVARCHAR(80) NOT NULL); INSERT INTO {s}.drift_rows VALUES(1,N'new'),(2,N'inserted'); CREATE TABLE {s}.conflict_rows(id BIGINT PRIMARY KEY,v NVARCHAR(80) NOT NULL); WITH n AS (SELECT TOP(1200) ROW_NUMBER() OVER(ORDER BY a.object_id,b.object_id) AS id FROM sys.all_objects a CROSS JOIN sys.all_objects b) INSERT INTO {s}.conflict_rows SELECT id,N'source' FROM n")).await;
    target.sql(format!("CREATE TABLE {t}.drift_rows(id BIGINT PRIMARY KEY,v NVARCHAR(80) NOT NULL); INSERT INTO {t}.drift_rows VALUES(1,N'old'); CREATE TABLE {t}.conflict_rows(id BIGINT PRIMARY KEY,v NVARCHAR(80) NOT NULL); INSERT INTO {t}.conflict_rows VALUES(1100,N'existing')")).await;
    let plan = prepare(
        source,
        target,
        request(
            source,
            target,
            DataTaskMode::Merge,
            vec![mapping("drift_rows", "drift_rows", &["id", "v"])],
        ),
        directory,
    )
    .await;
    target
        .sql(format!(
            "UPDATE {t}.drift_rows SET v=N'independent-drift' WHERE id=1"
        ))
        .await;
    let result = execute_plan(
        Arc::new(plan),
        source.config.clone(),
        target.config.clone(),
        cancel(),
        Arc::new(|_| {}),
    )
    .await;
    assert!(
        result.error.as_ref().map(|e| e.code.as_str()) == Some("plan_stale")
            && result.commit_state == DataCommitState::RolledBack,
        "目标漂移必须在写入前阻塞"
    );
    assert!(
        simple_rows(target, "drift_rows").await == vec![(1, "independent-drift".into())],
        "漂移阻塞后必须零写入"
    );

    let mappings = vec![mapping("conflict_rows", "conflict_rows", &["id", "v"])];
    let plan = prepare(
        source,
        target,
        request(source, target, DataTaskMode::Append, mappings.clone()),
        directory,
    )
    .await;
    let written = Arc::new(AtomicU64::new(0));
    let observed = written.clone();
    let result = execute_plan(
        Arc::new(plan),
        source.config.clone(),
        target.config.clone(),
        cancel(),
        Arc::new(move |p| {
            observed.fetch_max(p.written_rows, Ordering::Relaxed);
        }),
    )
    .await;
    assert!(
        written.load(Ordering::Relaxed) > 0,
        "冲突前必须已经成功写入至少一个批次"
    );
    assert!(
        result.status == DataTaskStatus::Failed
            && result.commit_state == DataCommitState::RolledBack,
        "后续批次主键冲突必须回滚全部写入"
    );
    assert!(
        simple_rows(target, "conflict_rows").await == vec![(1100, "existing".into())],
        "冲突不得遗留前面批次的写入"
    );

    let mut plan = prepare(
        source,
        target,
        request(source, target, DataTaskMode::Replace, mappings),
        directory,
    )
    .await;
    plan.expected = plan.target.clone();
    let result = execute_plan(
        Arc::new(plan),
        source.config.clone(),
        target.config.clone(),
        cancel(),
        Arc::new(|_| {}),
    )
    .await;
    assert!(
        result.error.as_ref().map(|e| e.code.as_str()) == Some("validation_failed")
            && result.commit_state == DataCommitState::RolledBack,
        "最终核验失败必须回滚替换"
    );
    assert!(
        simple_rows(target, "conflict_rows").await == vec![(1100, "existing".into())],
        "核验失败必须恢复原目标"
    );
}

async fn identity_cancel(source: &mut Fixture, target: &mut Fixture, directory: &Path) {
    let s = id(&source.endpoint.database);
    let t = id(&target.endpoint.database);
    source.sql(format!("CREATE TABLE {s}.identity_rows(id BIGINT IDENTITY(1,1) PRIMARY KEY,v NVARCHAR(80) NOT NULL); SET IDENTITY_INSERT {s}.identity_rows ON; INSERT INTO {s}.identity_rows(id,v) VALUES(1,N'new'),(5000,N'high'); SET IDENTITY_INSERT {s}.identity_rows OFF")).await;
    target.sql(format!("CREATE TABLE {t}.identity_rows(id BIGINT IDENTITY(1,1) PRIMARY KEY,v NVARCHAR(80) NOT NULL); INSERT INTO {t}.identity_rows(v) VALUES(N'old')")).await;
    let mappings = vec![mapping("identity_rows", "identity_rows", &["id", "v"])];
    let plan = prepare(
        source,
        target,
        request(source, target, DataTaskMode::Merge, mappings.clone()),
        directory,
    )
    .await;
    let token = cancel();
    let signal = token.clone();
    let result = execute_plan(
        Arc::new(plan),
        source.config.clone(),
        target.config.clone(),
        token,
        Arc::new(move |p| {
            if p.status == DataTaskStatus::Verifying {
                signal.store(true, Ordering::Release);
            }
        }),
    )
    .await;
    assert!(
        result.status == DataTaskStatus::Cancelled
            && result.commit_state == DataCommitState::RolledBack,
        "核验阶段取消必须回滚 identity 写入"
    );
    assert!(
        simple_rows(target, "identity_rows").await == vec![(1, "old".into())],
        "取消后必须恢复原 identity 行"
    );
    let rows = target
        .rows(format!(
            "INSERT INTO {t}.identity_rows(v) OUTPUT inserted.id VALUES(N'independent')"
        ))
        .await;
    let allocated = rows
        .first()
        .and_then(|r| r.get::<i64, _>(0))
        .expect("取消后默认 identity 插入失败");
    assert!(allocated > 5000, "取消后的 identity 不能退回显式键以下");
    let plan = prepare(
        source,
        target,
        request(source, target, DataTaskMode::Merge, mappings),
        directory,
    )
    .await;
    execute(source, target, plan).await;
    assert!(
        simple_rows(target, "identity_rows").await
            == vec![
                (1, "new".into()),
                (5000, "high".into()),
                (allocated, "independent".into())
            ],
        "再次合并必须保留显式 identity 与独立默认插入值"
    );
}

async fn metadata_contract(fixture: &mut Fixture) {
    let s = id(&fixture.endpoint.database);
    fixture.sql(format!("CREATE TABLE {s}.ordinary_rows(id BIGINT IDENTITY(1,1) PRIMARY KEY,v BIGINT NOT NULL DEFAULT(7),g AS(v*2) PERSISTED,rv ROWVERSION,amount DECIMAL(38,20),dt DATETIME2(7),dto DATETIMEOFFSET(7)); CREATE TABLE {s}.temporal_rows(id BIGINT PRIMARY KEY,v NVARCHAR(80),valid_from DATETIME2 GENERATED ALWAYS AS ROW START NOT NULL,valid_to DATETIME2 GENERATED ALWAYS AS ROW END NOT NULL,PERIOD FOR SYSTEM_TIME(valid_from,valid_to)) WITH(SYSTEM_VERSIONING=ON(HISTORY_TABLE={s}.temporal_history)); CREATE TABLE {s}.graph_nodes(id BIGINT PRIMARY KEY,v NVARCHAR(80)) AS NODE; CREATE TABLE {s}.graph_edges(v NVARCHAR(80)) AS EDGE")).await;
    fixture
        .sql(format!(
            "CREATE VIEW {s}.ordinary_view AS SELECT id,v FROM {s}.ordinary_rows"
        ))
        .await;
    if fixture.major >= 16 {
        fixture.sql(format!("CREATE TABLE {s}.ledger_rows(id BIGINT PRIMARY KEY,v NVARCHAR(80)) WITH(LEDGER=ON(APPEND_ONLY=ON))")).await;
    }
    fixture.start_budget().await;
    let first = metadata(fixture).await;
    let count = fixture.rpc_count().await;
    assert_eq!(count, 7, "元数据读取必须使用七次固定集合查询");
    assert!(
        first.permissions_verified && first.consistent_snapshot && first.protected_write,
        "专属容器应通过权限与事务能力门禁"
    );
    let ordinary = table(&first, "ordinary_rows");
    assert!(ordinary.physical, "普通物理表必须可识别");
    let column = |name: &str| {
        ordinary
            .columns
            .iter()
            .find(|c| c.name == name)
            .expect("普通字段缺失")
    };
    assert!(
        column("id").identity
            && column("id").generator_safe
            && column("id").primary_key_ordinal == 1,
        "单调 identity 必须可安全传输"
    );
    assert!(
        column("g").generated && column("rv").generated && !column("v").generated,
        "计算列和 rowversion 必须识别为不可写生成列"
    );
    assert!(
        column("amount").declared_type == "DECIMAL(38,20)"
            && column("dt").declared_type == "DATETIME2(7)"
            && column("dto").declared_type == "DATETIMEOFFSET(7)",
        "目录必须保留精度与时间小数位"
    );
    assert!(
        !table(&first, "ordinary_view").physical
            && !table(&first, "temporal_rows").physical
            && !table(&first, "temporal_history").physical
            && !table(&first, "graph_nodes").physical
            && !table(&first, "graph_edges").physical,
        "视图、时态表和图表不能当作普通物理表写入"
    );
    if fixture.major >= 16 {
        assert!(
            !table(&first, "ledger_rows").physical,
            "账本表不能当作普通物理表写入"
        );
    }
    let additions = (0..24)
        .map(|i| format!("CREATE TABLE {s}.budget_{i}(id BIGINT PRIMARY KEY,v NVARCHAR(40));"))
        .collect::<String>();
    fixture.sql(additions).await;
    let expanded = metadata(fixture).await;
    let expanded_count = fixture.rpc_count().await;
    assert!(
        expanded.tables.len() == first.tables.len() + 24 && expanded_count == count * 2,
        "增加表数量不得增加目录查询次数"
    );
    fixture.stop_budget().await;
}

async fn generated_columns(source: &mut Fixture, target: &mut Fixture, directory: &Path) {
    let s = id(&source.endpoint.database);
    let t = id(&target.endpoint.database);
    source.sql(format!("CREATE TABLE {s}.generated_rows(id BIGINT PRIMARY KEY,v BIGINT NOT NULL,g AS(v*2) PERSISTED,rv ROWVERSION); INSERT INTO {s}.generated_rows(id,v) VALUES(1,7)")).await;
    target.sql(format!("CREATE TABLE {t}.generated_rows(id BIGINT PRIMARY KEY,v BIGINT NOT NULL,g AS(v*2) PERSISTED,rv ROWVERSION)")).await;
    let rejected = prepare_task(
        format!(
            "sqlserver-generated-reject-{}",
            uuid::Uuid::new_v4().simple()
        ),
        request(
            source,
            target,
            DataTaskMode::Append,
            vec![mapping(
                "generated_rows",
                "generated_rows",
                &["id", "v", "g", "rv"],
            )],
        ),
        source.config.clone(),
        target.config.clone(),
        directory.to_path_buf(),
        cancel(),
        Arc::new(|_| {}),
    )
    .await;
    assert!(
        matches!(rejected, Err(ref e) if e.code == "invalid_mapping"),
        "显式映射计算列或 rowversion 必须在预览拒绝"
    );
    // PERSISTED 表写入要求 NUMERIC_ROUNDABORT OFF；适配器保留 ON 精度保护。
    // 上面验证持久化列不可显式映射；成功用例只要求普通计算列由目标自行生成。
    target
        .sql(format!(
            "ALTER TABLE {t}.generated_rows DROP COLUMN g; ALTER TABLE {t}.generated_rows ADD g AS(v*2)"
        ))
        .await;
    let plan = prepare(
        source,
        target,
        request(
            source,
            target,
            DataTaskMode::Append,
            vec![mapping("generated_rows", "generated_rows", &["id", "v"])],
        ),
        directory,
    )
    .await;
    execute(source, target, plan).await;
    let rows = target
        .rows(format!(
            "SELECT id,v,g,DATALENGTH(rv) FROM {t}.generated_rows"
        ))
        .await;
    let row = rows.first().expect("生成字段结果缺失");
    assert!(
        row.get::<i64, _>(0) == Some(1)
            && row.get::<i64, _>(1) == Some(7)
            && row.get::<i64, _>(2) == Some(14)
            && row.get::<i32, _>(3) == Some(8),
        "目标必须自行计算生成值并创建 rowversion"
    );
}

async fn rejected_new_type(
    source: &Fixture,
    target: &mut Fixture,
    directory: &Path,
    name: &str,
    mode: DataTaskMode,
) {
    let query = format!(
        "SELECT id,CONVERT(nvarchar(max),v) FROM {}.{} ORDER BY id",
        id(&target.endpoint.database),
        id(name)
    );
    let before: Vec<(i64, String)> = target
        .rows(query.clone())
        .await
        .iter()
        .map(|row| (row.get(0).expect("新类型目标键缺失"), string(row, 1)))
        .collect();
    let result = prepare_task(
        format!("sqlserver-new-type-{}", uuid::Uuid::new_v4().simple()),
        request(
            source,
            target,
            mode,
            vec![mapping(name, name, &["id", "v"])],
        ),
        source.config.clone(),
        target.config.clone(),
        directory.to_path_buf(),
        cancel(),
        Arc::new(|_| {}),
    )
    .await;
    assert!(
        matches!(result, Err(ref error) if error.code == "unsupported_capability"),
        "2025 新类型未经无损验收，必须在预览阶段拒绝"
    );
    let after: Vec<(i64, String)> = target
        .rows(query)
        .await
        .iter()
        .map(|row| (row.get(0).expect("新类型目标键缺失"), string(row, 1)))
        .collect();
    assert!(
        after == before && after.len() == 1 && after[0].0 == 1,
        "新类型预览阻塞后必须保留原目标值且零写入"
    );
}

async fn new_types_remain_blocked(source: &mut Fixture, target: &mut Fixture, directory: &Path) {
    if source.major < 17 {
        return;
    }
    let s = id(&source.endpoint.database);
    let t = id(&target.endpoint.database);
    // 原生 JSON 与 VECTOR(3) 均支持所有兼容级别；不能用 NVARCHAR 代替原生类型。
    // https://learn.microsoft.com/sql/t-sql/data-types/json-data-type?view=sql-server-ver17
    // https://learn.microsoft.com/sql/t-sql/data-types/vector-data-type?view=sql-server-ver17
    source.sql(format!("CREATE TABLE {s}.native_json_rows(id BIGINT PRIMARY KEY,v JSON); INSERT INTO {s}.native_json_rows VALUES(2,N'{{\"number\":9007199254740993}}'); CREATE TABLE {s}.native_vector_rows(id BIGINT PRIMARY KEY,v VECTOR(3)); INSERT INTO {s}.native_vector_rows VALUES(2,'[0.1,2,30]')")).await;
    target.sql(format!("CREATE TABLE {t}.native_json_rows(id BIGINT PRIMARY KEY,v JSON); INSERT INTO {t}.native_json_rows VALUES(1,N'{{\"retained\":true}}'); CREATE TABLE {t}.native_vector_rows(id BIGINT PRIMARY KEY,v VECTOR(3)); INSERT INTO {t}.native_vector_rows VALUES(1,'[4,5,6]')")).await;
    let snapshot = metadata(source).await;
    assert!(
        table(&snapshot, "native_json_rows")
            .columns
            .iter()
            .any(|c| c.name == "v" && c.declared_type == "JSON")
            && table(&snapshot, "native_vector_rows")
                .columns
                .iter()
                .any(|c| c.name == "v" && c.declared_type == "VECTOR"),
        "夹具必须真实使用原生 JSON 和 VECTOR 类型"
    );
    rejected_new_type(
        source,
        target,
        directory,
        "native_json_rows",
        DataTaskMode::Append,
    )
    .await;
    rejected_new_type(
        source,
        target,
        directory,
        "native_vector_rows",
        DataTaskMode::Merge,
    )
    .await;
}

fn directory() -> std::path::PathBuf {
    let path = std::env::temp_dir().join(format!(
        "db-connect-sqlserver-version-{}",
        uuid::Uuid::new_v4().simple()
    ));
    required(std::fs::create_dir(&path), "创建版本合约临时目录失败");
    path
}

#[tokio::test]
#[ignore = "需显式配置 SQLSERVER_URL 的专属隔离容器"]
async fn real_sqlserver_version_contract() {
    let mut source = Fixture::connect("DB_CONNECT_DATA_TASK_SQLSERVER_URL").await;
    let mut target = Fixture::connect("DB_CONNECT_DATA_TASK_SQLSERVER_URL").await;
    let directory = directory();
    let outcome = AssertUnwindSafe(async {
        println!("DATA_TASK_SQLSERVER_VERSION {}", source.version);
        metadata_contract(&mut source).await;
        source.compatibility(100).await;
        target.compatibility(100).await;
        let compatibility = source.rows("SELECT CAST(compatibility_level AS int) FROM sys.databases WHERE database_id=DB_ID()".into()).await;
        assert!(compatibility.first().and_then(|r| r.get::<i32, _>(0)) == Some(100), "必须实际降到兼容级别100验证");
        exact_modes(&mut source, &mut target, &directory).await;
        generated_columns(&mut source, &mut target, &directory).await;
        new_types_remain_blocked(&mut source, &mut target, &directory).await;
    }).catch_unwind().await;
    source.close().await;
    target.close().await;
    required(
        std::fs::remove_dir_all(directory),
        "清理版本合约临时目录失败",
    );
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

#[tokio::test]
#[ignore = "需显式配置不同大版本、不同独立实例的 SQLSERVER_URL 和 SQLSERVER_TARGET_URL"]
async fn real_sqlserver_cross_version_contract() {
    let mut source = Fixture::connect("DB_CONNECT_DATA_TASK_SQLSERVER_URL").await;
    let mut target = Fixture::connect("DB_CONNECT_DATA_TASK_SQLSERVER_TARGET_URL").await;
    let directory = directory();
    let outcome = AssertUnwindSafe(async {
        assert!(
            source.config.port != target.config.port,
            "跨版本合约必须使用不同容器随机端口"
        );
        assert!(
            source.instance != target.instance,
            "跨版本合约必须连接不同物理实例"
        );
        assert!(
            source.major != target.major,
            "跨版本合约必须连接不同 SQL Server 主版本"
        );
        println!(
            "DATA_TASK_SQLSERVER_CROSS_VERSION source={} target={}",
            source.version, target.version
        );
        exact_modes(&mut source, &mut target, &directory).await;
        stale_and_rollback(&mut source, &mut target, &directory).await;
        identity_cancel(&mut source, &mut target, &directory).await;
        generated_columns(&mut source, &mut target, &directory).await;
    })
    .catch_unwind()
    .await;
    source.close().await;
    target.close().await;
    required(std::fs::remove_dir_all(directory), "清理跨版本临时目录失败");
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}
