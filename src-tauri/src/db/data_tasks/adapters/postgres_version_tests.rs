//! 只连接显式提供的不同大版本专属实例；不读取应用保存连接。
use super::{id, open, server_version_verified};
use crate::{
    db::data_tasks::{
        executor::{execute_plan, prepare_task},
        metadata::DataMetadataSnapshot,
        plan::StoredDataPlan,
        Cancellation,
    },
    models::{data_tasks::*, types::ConnectionConfig},
};
use std::{
    path::Path,
    sync::{atomic::AtomicBool, atomic::Ordering, Arc},
};
use tokio_postgres::{Client, Config, NoTls};

// 驱动错误可能包含 URL 或连接参数；日志只记录固定阶段及确认过的版本。
fn required<T, E>(result: Result<T, E>, stage: &str) -> T {
    result.unwrap_or_else(|_| panic!("{stage}"))
}

fn cancel() -> Cancellation {
    Arc::new(AtomicBool::new(false))
}

struct Fixture {
    observer: Client,
    driver: tokio::task::JoinHandle<()>,
    config: ConnectionConfig,
    endpoint: DataEndpoint,
    version: String,
    major: u32,
    instance: String,
    port: u16,
}

impl Fixture {
    async fn connect(env: &str) -> Self {
        let url = required(std::env::var(env), "必须显式提供专属 PostgreSQL 容器 URL");
        assert!(
            url.starts_with("postgres://") || url.starts_with("postgresql://"),
            "夹具必须使用显式 PostgreSQL URL"
        );
        let pg: Config = required(url.parse(), "专属 PostgreSQL URL 无效");
        assert!(
            pg.get_hosts().len() == 1 && pg.get_ports().len() == 1 && pg.get_hostaddrs().is_empty(),
            "夹具必须显式指定唯一回环地址和随机端口"
        );
        let host = match &pg.get_hosts()[0] {
            tokio_postgres::config::Host::Tcp(host)
                if matches!(host.as_str(), "127.0.0.1" | "localhost" | "::1") =>
            {
                host.clone()
            }
            _ => panic!("跨版本合约仅允许本机回环 TCP 地址"),
        };
        let port = pg.get_ports()[0];
        assert!(port != 0 && port != 5432, "夹具必须使用容器随机映射端口");
        let (observer, connection) = required(pg.connect(NoTls).await, "连接专属实例失败");
        let driver = tokio::spawn(async move {
            let _ = connection.await;
        });
        let facts = required(
            observer
                .query_one(
                    "SELECT current_setting('server_version_num'),current_setting('server_version'),system_identifier::text FROM pg_control_system()",
                    &[],
                )
                .await,
            "读取实例身份及版本失败",
        );
        let number: String = required(facts.try_get(0), "实例版本编码无效");
        let number: u32 = required(number.parse(), "实例版本编号无效");
        let release: String = required(facts.try_get(1), "实例版本字符串无效");
        assert!(
            server_version_verified(number, &release),
            "实例未通过版本门禁"
        );
        let version = release
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string();
        assert!(
            !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit() || b == b'.'),
            "仅允许输出已验证的数字版本"
        );
        let unique = format!("data_task_pg_cross_{}", uuid::Uuid::new_v4().simple());
        let config = required(
            serde_json::from_value(serde_json::json!({
                "id": unique,
                "database_type": "postgres",
                "name": "数据任务跨版本隔离测试",
                "host": host,
                "port": port,
                "username": pg.get_user().unwrap_or("postgres"),
                "password": String::from_utf8_lossy(pg.get_password().unwrap_or_default()),
                "database": pg.get_dbname().unwrap_or("postgres"),
                "ssh": null
            })),
            "构造隔离连接失败",
        );
        Self {
            observer,
            driver,
            config,
            endpoint: DataEndpoint {
                saved_connection_id: unique.clone(),
                database: unique,
            },
            version,
            major: number / 10000,
            instance: required(facts.try_get(2), "实例身份无效"),
            port,
        }
    }

    async fn sql(&self, sql: String) {
        self.observer
            .batch_execute(&sql)
            .await
            .unwrap_or_else(|error| {
                // 这里只执行测试合成DDL/DML；仅公开服务端SQL诊断，不格式化驱动/连接错误。
                if let Some(database) = error.as_db_error() {
                    panic!(
                        "跨版本夹具 SQL 执行失败 [{}]: {}",
                        database.code().code(),
                        database.message()
                    );
                }
                panic!("跨版本夹具 SQL 执行失败：未取得服务端 SQLSTATE");
            });
    }

    async fn initialize(&self) {
        self.sql(format!(
            "SET TIME ZONE 'UTC'; SET datestyle='ISO, YMD'; CREATE SCHEMA {}",
            id(&self.endpoint.database)
        ))
        .await;
    }

    async fn close(self) {
        self.sql(format!(
            "DROP SCHEMA {} CASCADE",
            id(&self.endpoint.database)
        ))
        .await;
        drop(self.observer);
        required(self.driver.await, "关闭跨版本夹具连接失败");
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
            format!("postgres-cross-version-{}", uuid::Uuid::new_v4().simple()),
            request,
            source.config.clone(),
            target.config.clone(),
            directory.to_path_buf(),
            cancel(),
            Arc::new(|_| {}),
        )
        .await,
        "跨版本预览失败",
    )
}

async fn execute(source: &Fixture, target: &Fixture, plan: StoredDataPlan) {
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
        "跨版本任务必须成功提交并释放资源"
    );
}

const EXACT_COLUMNS: [&str; 9] = [
    "id",
    "signed_value",
    "amount",
    "bytes_value",
    "dt",
    "d",
    "real_value",
    "double_value",
    "v",
];
// 保持既有映射范围：默认 TIMESTAMP 支持微秒；原生 TIME 尚未通过类型映射，不能用 TEXT 冒充。
const EXACT_DEFINITION: &str = "id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, \
    signed_value BIGINT,amount NUMERIC(65,20),bytes_value BYTEA,dt TIMESTAMP,d DATE, \
    real_value REAL,double_value DOUBLE PRECISION,v TEXT";
const SOURCE_VALUES: &str = "\
    (9007199254740993,-9223372036854775808,\
     123456789012345678901234567890123456789012345.12345678901234567890,\
     decode('0001feff','hex'),'2026-10-20 12:34:56.123456','9999-12-31',0.1,0.1,'中文😀'),\
    (9007199254740994,9223372036854775807,-0.00000000000000000001,\
     decode('','hex'),'1000-01-01 00:00:00.000001','1000-01-01',\
     1.401298464324817e-45,1.7976931348623157e308,''),\
    (9007199254740995,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)";

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
            "123456789012345678901234567890123456789012345.12345678901234567890",
            "0001feff",
            "2026-10-20 12:34:56.123456",
            "9999-12-31",
            "3dcccccd",
            "3fb999999999999a",
            "中文😀",
        ]),
        strings(&[
            "9007199254740994",
            "9223372036854775807",
            "-0.00000000000000000001",
            "",
            "1000-01-01 00:00:00.000001",
            "1000-01-01",
            "00000001",
            "7fefffffffffffff",
            "",
        ]),
        nulls,
    ]
}

fn retained_row() -> Vec<Option<String>> {
    let mut row = vec![None; EXACT_COLUMNS.len()];
    row[0] = Some("9007199254740996".into());
    row[8] = Some("target-only".into());
    row
}

async fn exact_rows(fixture: &Fixture, table: &str) -> Vec<Vec<Option<String>>> {
    // 直接回读全部存储值。浮点用 IEEE 网络字节，避免10/11与12+不同文本格式影响核验。
    let rows = required(
        fixture
            .observer
            .query(
                &format!(
                    "SELECT id::text,signed_value::text,amount::text,encode(bytes_value,'hex'),\
                 dt::text,d::text,encode(float4send(real_value),'hex'),\
                 encode(float8send(double_value),'hex'),v FROM {}.{} ORDER BY id",
                    id(&fixture.endpoint.database),
                    id(table)
                ),
                &[],
            )
            .await,
        "跨版本精确值核验查询失败",
    );
    rows.iter()
        .map(|row| {
            (0..EXACT_COLUMNS.len())
                .map(|i| required(row.try_get(i), "精确值解码失败"))
                .collect()
        })
        .collect()
}

async fn exact_modes(source: &Fixture, target: &Fixture, directory: &Path) {
    let s = id(&source.endpoint.database);
    let t = id(&target.endpoint.database);
    source
        .sql(format!(
            "CREATE TABLE {s}.exact_rows({EXACT_DEFINITION}); \
         INSERT INTO {s}.exact_rows OVERRIDING SYSTEM VALUE VALUES {SOURCE_VALUES}"
        ))
        .await;
    target.sql(format!(
        "CREATE TABLE {t}.exact_rows({EXACT_DEFINITION}); \
         CREATE TABLE {t}.transfer_rows({EXACT_DEFINITION}); \
         INSERT INTO {t}.exact_rows(id,signed_value,amount,bytes_value,v) OVERRIDING SYSTEM VALUE \
         VALUES(9007199254740994,0,1,decode('ff','hex'),'old'),\
               (9007199254740996,NULL,NULL,NULL,'target-only'); \
         INSERT INTO {t}.transfer_rows(id,v) OVERRIDING SYSTEM VALUE VALUES(9007199254740996,'target-only')"
    )).await;
    let mut expected = exact_expected();
    assert!(
        exact_rows(source, "exact_rows").await == expected,
        "源夹具必须保留所有精确值"
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
        "合并应包含插入、更新和保留"
    );
    source
        .sql(format!(
            "UPDATE {s}.exact_rows SET v='source-after-preview' WHERE id=9007199254740993"
        ))
        .await;
    execute(source, target, merge).await;
    let mut retained = expected.clone();
    retained.push(retained_row());
    assert!(
        exact_rows(target, "exact_rows").await == retained,
        "合并必须使用冻结源且无损保留全部列"
    );

    expected[0][8] = Some("source-after-preview".into());
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
        "镜像必须精确替换所有列并删除独有行"
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
        "追加必须保留旧行并无损插入全部源值"
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
        "替换必须完整写回所有精确值"
    );
    let next: i64 = required(
        required(target.observer.query_one(&format!("INSERT INTO {t}.transfer_rows(v) VALUES('default-after-transfer') RETURNING id"), &[]).await, "传输后默认 identity 插入失败").try_get(0),
        "默认 identity 回读失败",
    );
    assert!(next > 9007199254740996, "显式大整数键传输后生成器不得回退");
}

async fn simple_rows(fixture: &Fixture, table: &str) -> Vec<(i64, String)> {
    required(
        fixture
            .observer
            .query(
                &format!(
                    "SELECT id,v FROM {}.{} ORDER BY id",
                    id(&fixture.endpoint.database),
                    id(table)
                ),
                &[],
            )
            .await,
        "简单值核验查询失败",
    )
    .iter()
    .map(|row| {
        (
            required(row.try_get(0), "键回读失败"),
            required(row.try_get(1), "文本回读失败"),
        )
    })
    .collect()
}

async fn stale_and_rollback(source: &Fixture, target: &Fixture, directory: &Path) {
    let s = id(&source.endpoint.database);
    let t = id(&target.endpoint.database);
    source.sql(format!("CREATE TABLE {s}.drift_rows(id BIGINT PRIMARY KEY,v TEXT NOT NULL); INSERT INTO {s}.drift_rows VALUES(1,'new'),(2,'inserted'); CREATE TABLE {s}.conflict_rows(id BIGINT PRIMARY KEY,v TEXT NOT NULL); INSERT INTO {s}.conflict_rows SELECT n,'source' FROM generate_series(1,1200)n")).await;
    target.sql(format!("CREATE TABLE {t}.drift_rows(id BIGINT PRIMARY KEY,v TEXT NOT NULL); INSERT INTO {t}.drift_rows VALUES(1,'old'); CREATE TABLE {t}.conflict_rows(id BIGINT PRIMARY KEY,v TEXT NOT NULL); INSERT INTO {t}.conflict_rows VALUES(1100,'existing')")).await;
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
            "UPDATE {t}.drift_rows SET v='independent-drift' WHERE id=1"
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
        "目标漂移后必须零写入"
    );

    let mappings = vec![mapping("conflict_rows", "conflict_rows", &["id", "v"])];
    let plan = prepare(
        source,
        target,
        request(source, target, DataTaskMode::Append, mappings.clone()),
        directory,
    )
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
        result.status == DataTaskStatus::Failed
            && result.commit_state == DataCommitState::RolledBack,
        "后续批次冲突必须回滚全部写入"
    );
    assert!(
        simple_rows(target, "conflict_rows").await == vec![(1100, "existing".into())],
        "冲突不能遗留前面批次已插入的行"
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
        "核验失败必须恢复原目标完整值"
    );
}

async fn identity_cancel(source: &Fixture, target: &Fixture, directory: &Path) {
    let s = id(&source.endpoint.database);
    let t = id(&target.endpoint.database);
    let definition = "(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,v TEXT NOT NULL)";
    source.sql(format!("CREATE TABLE {s}.identity_rows{definition}; INSERT INTO {s}.identity_rows OVERRIDING SYSTEM VALUE VALUES(1,'new'),(5000,'high')")).await;
    target.sql(format!("CREATE TABLE {t}.identity_rows{definition}; INSERT INTO {t}.identity_rows OVERRIDING SYSTEM VALUE VALUES(1,'old')")).await;
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
        Arc::new(move |progress| {
            if progress.status == DataTaskStatus::Verifying {
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
        "取消必须恢复原 identity 行"
    );
    let allocated: i64 = required(
        required(
            target
                .observer
                .query_one(
                    &format!("INSERT INTO {t}.identity_rows(v) VALUES('independent') RETURNING id"),
                    &[],
                )
                .await,
            "取消后默认插入失败",
        )
        .try_get(0),
        "identity 回读失败",
    );
    assert!(allocated > 5000, "取消后的序列不能退回显式键以下");
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
        "再次合并必须保留显式 identity 和并发默认值"
    );
    let next: i64 = required(
        required(
            target
                .observer
                .query_one(
                    &format!("INSERT INTO {t}.identity_rows(v) VALUES('after') RETURNING id"),
                    &[],
                )
                .await,
            "成功后默认插入失败",
        )
        .try_get(0),
        "identity 回读失败",
    );
    assert!(next > allocated, "成功后默认 identity 必须继续递增");
}

fn fk_schema(schema: &str) -> String {
    format!("CREATE TABLE {schema}.z_parent(id BIGINT PRIMARY KEY,v TEXT NOT NULL); CREATE TABLE {schema}.a_child(id BIGINT PRIMARY KEY,parent_id BIGINT NOT NULL,v TEXT NOT NULL,CONSTRAINT parent_fk FOREIGN KEY(parent_id) REFERENCES {schema}.z_parent(id) ON UPDATE RESTRICT ON DELETE RESTRICT)")
}

async fn fk_rows(fixture: &Fixture) -> Vec<(String, i64, i64, String)> {
    let schema = id(&fixture.endpoint.database);
    required(fixture.observer.query(&format!("SELECT 'child'::text,id,parent_id,v FROM {schema}.a_child UNION ALL SELECT 'parent',id,id,v FROM {schema}.z_parent ORDER BY 1,2"), &[]).await, "外键完整值核验失败")
        .iter().map(|row| (required(row.try_get(0), "外键表名回读失败"), required(row.try_get(1), "外键键值回读失败"), required(row.try_get(2), "父键回读失败"), required(row.try_get(3), "外键文本回读失败"))).collect()
}

fn fk_expected(retain: bool) -> Vec<(String, i64, i64, String)> {
    let mut rows: Vec<_> = (1..=1200)
        .map(|n| ("child".into(), n + 10000, n, format!("C{n}")))
        .collect();
    if retain {
        rows.push(("child".into(), 20000, 2000, "old-child".into()));
    }
    rows.extend((1..=1200).map(|n| ("parent".into(), n, n, format!("P{n}"))));
    if retain {
        rows.push(("parent".into(), 2000, 2000, "old-parent".into()));
    }
    rows
}

async fn foreign_key_batches(source: &Fixture, target: &Fixture, directory: &Path) {
    let s = id(&source.endpoint.database);
    let t = id(&target.endpoint.database);
    source.sql(format!("{}; INSERT INTO {s}.z_parent SELECT n,'P'||n FROM generate_series(1,1200)n; INSERT INTO {s}.a_child SELECT n+10000,n,'C'||n FROM generate_series(1,1200)n", fk_schema(&s))).await;
    target.sql(format!("{}; INSERT INTO {t}.z_parent VALUES(2000,'old-parent'); INSERT INTO {t}.a_child VALUES(20000,2000,'old-child')", fk_schema(&t))).await;
    let mappings = vec![
        mapping("a_child", "a_child", &["id", "parent_id", "v"]),
        mapping("z_parent", "z_parent", &["id", "v"]),
    ];
    let append = prepare(
        source,
        target,
        request(source, target, DataTaskMode::Append, mappings.clone()),
        directory,
    )
    .await;
    assert!(
        append.mapping.insert_order == ["z_parent", "a_child"]
            && append.mapping.delete_order == ["a_child", "z_parent"],
        "外键批量任务必须按依赖顺序写入"
    );
    execute(source, target, append).await;
    assert!(
        fk_rows(target).await == fk_expected(true),
        "外键追加必须无损写入全部批次并保留旧父子记录"
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
        fk_rows(target).await == fk_expected(false),
        "外键替换必须按依赖删除并重建全部父子记录"
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

async fn generated_fixture(fixture: &Fixture, insert: bool) {
    let schema = id(&fixture.endpoint.database);
    let stored = if fixture.major >= 12 {
        "BIGINT GENERATED ALWAYS AS (v*2) STORED"
    } else {
        "BIGINT"
    };
    let virtual_column = if fixture.major >= 18 {
        ",virtual_value BIGINT GENERATED ALWAYS AS (v*3) VIRTUAL"
    } else {
        ""
    };
    fixture.sql(format!("CREATE TABLE {schema}.generated_rows(id BIGINT PRIMARY KEY,v BIGINT NOT NULL,g {stored}{virtual_column})")).await;
    if insert {
        let sql = if fixture.major >= 12 {
            format!("INSERT INTO {schema}.generated_rows(id,v) VALUES(1,7)")
        } else {
            format!("INSERT INTO {schema}.generated_rows(id,v,g) VALUES(1,7,14)")
        };
        fixture.sql(sql).await;
    }
    let snapshot = metadata(fixture).await;
    let table = snapshot
        .tables
        .iter()
        .find(|t| t.name == "generated_rows")
        .expect("生成字段夹具缺失");
    assert!(
        table
            .columns
            .iter()
            .find(|c| c.name == "g")
            .expect("生成列缺失")
            .generated
            == (fixture.major >= 12),
        "10/11普通列和12+stored列必须准确区分"
    );
    assert!(
        !table
            .columns
            .iter()
            .find(|c| c.name == "v")
            .expect("基础列缺失")
            .generated,
        "普通字段不能误判为生成字段"
    );
    if fixture.major >= 18 {
        assert!(
            table
                .columns
                .iter()
                .find(|c| c.name == "virtual_value")
                .expect("virtual列缺失")
                .generated,
            "18虚拟生成列必须识别为不可写字段"
        );
    }
}

async fn generated_columns(source: &Fixture, target: &Fixture, directory: &Path) {
    generated_fixture(source, true).await;
    generated_fixture(target, false).await;
    if target.major >= 12 {
        let rejected = prepare_task(
            format!("pg-generated-rejected-{}", uuid::Uuid::new_v4().simple()),
            request(
                source,
                target,
                DataTaskMode::Append,
                vec![mapping(
                    "generated_rows",
                    "generated_rows",
                    &["id", "v", "g"],
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
            matches!(rejected, Err(ref error) if error.code == "invalid_mapping"),
            "生成字段显式写入必须在预览阶段拒绝"
        );
    }
    let columns = if target.major >= 12 {
        vec!["id", "v"]
    } else {
        vec!["id", "v", "g"]
    };
    let plan = prepare(
        source,
        target,
        request(
            source,
            target,
            DataTaskMode::Append,
            vec![mapping("generated_rows", "generated_rows", &columns)],
        ),
        directory,
    )
    .await;
    execute(source, target, plan).await;
    let schema = id(&target.endpoint.database);
    let row = required(
        target
            .observer
            .query_one(&format!("SELECT id,v,g FROM {schema}.generated_rows"), &[])
            .await,
        "生成字段回读失败",
    );
    assert!(
        required(row.try_get::<_, i64>(0), "生成字段键回读失败") == 1
            && required(row.try_get::<_, i64>(1), "生成字段基础值回读失败") == 7
            && required(row.try_get::<_, i64>(2), "生成字段值回读失败") == 14,
        "必须正确读写生成值或让目标计算生成值"
    );
    if target.major >= 18 {
        let row = required(
            target
                .observer
                .query_one(
                    &format!("SELECT virtual_value FROM {schema}.generated_rows"),
                    &[],
                )
                .await,
            "虚拟生成值回读失败",
        );
        assert!(
            required(row.try_get::<_, i64>(0), "虚拟生成值解码失败") == 21,
            "18虚拟生成值必须正确计算"
        );
    }
}

async fn constraint_enforcement_fingerprint(fixture: &Fixture) {
    if fixture.major < 18 {
        return;
    }
    let schema = id(&fixture.endpoint.database);
    fixture.sql(format!("CREATE TABLE {schema}.enforcement_rows(id BIGINT PRIMARY KEY,v BIGINT,CONSTRAINT positive_value CHECK(v>0) NOT ENFORCED); INSERT INTO {schema}.enforcement_rows VALUES(1,7)")).await;
    let before = metadata(fixture).await;
    // PostgreSQL 18 的 CHECK 约束不能直接 ALTER enforceability，须重建同名约束。
    fixture
        .sql(format!(
            "ALTER TABLE {schema}.enforcement_rows DROP CONSTRAINT positive_value; \
             ALTER TABLE {schema}.enforcement_rows ADD CONSTRAINT positive_value CHECK(v>0) ENFORCED"
        ))
        .await;
    let after = metadata(fixture).await;
    assert!(
        before.schema_fingerprint != after.schema_fingerprint,
        "18约束执行状态改变必须导致元数据指纹改变"
    );
    let row = required(fixture.observer.query_one("SELECT conenforced FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='enforcement_rows' AND con.conname='positive_value'", &[&fixture.endpoint.database]).await, "约束执行状态核验失败");
    assert!(
        required(row.try_get::<_, bool>(0), "约束执行状态解码失败"),
        "夹具必须真实改变conenforced"
    );
}

async fn generated_kind_fingerprint(fixture: &Fixture) {
    if fixture.major < 18 {
        return;
    }
    let schema = id(&fixture.endpoint.database);
    fixture
        .sql(format!(
            "CREATE TABLE {schema}.generated_kind_rows(id BIGINT PRIMARY KEY,v BIGINT,\
         g BIGINT GENERATED ALWAYS AS (v*2) STORED); \
         INSERT INTO {schema}.generated_kind_rows(id,v) VALUES(1,7)"
        ))
        .await;
    let before = metadata(fixture).await;
    // 替换最后一列，使名称、类型、表达式与最终列顺序都不变，只改变存储方式。
    fixture
        .sql(format!(
            "ALTER TABLE {schema}.generated_kind_rows DROP COLUMN g; \
         ALTER TABLE {schema}.generated_kind_rows \
         ADD COLUMN g BIGINT GENERATED ALWAYS AS (v*2) VIRTUAL"
        ))
        .await;
    let after = metadata(fixture).await;
    assert!(
        before.schema_fingerprint != after.schema_fingerprint,
        "18生成列stored变成virtual必须改变元数据指纹"
    );
    let row = required(
        fixture
            .observer
            .query_one(&format!("SELECT g FROM {schema}.generated_kind_rows"), &[])
            .await,
        "生成列存储方式变化后回读失败",
    );
    assert!(
        required(row.try_get::<_, i64>(0), "生成列存储方式变化后解码失败") == 14,
        "stored与virtual转换应保持业务值不变"
    );
}

#[tokio::test]
#[ignore = "需要显式配置 PG_URL 与 PG_TARGET_URL 的不同大版本专属隔离容器"]
async fn real_postgres_cross_version_contract() {
    let source = Fixture::connect("DB_CONNECT_DATA_TASK_PG_URL").await;
    let target = Fixture::connect("DB_CONNECT_DATA_TASK_PG_TARGET_URL").await;
    assert!(
        source.port != target.port,
        "跨版本合约必须使用不同容器随机端口"
    );
    assert!(
        source.instance != target.instance,
        "跨版本合约必须连接不同物理实例"
    );
    assert!(
        source.major != target.major,
        "跨版本合约必须连接不同PostgreSQL大版本"
    );
    println!(
        "DATA_TASK_POSTGRES_CROSS_VERSION source={} target={}",
        source.version, target.version
    );
    source.initialize().await;
    target.initialize().await;
    let directory = std::env::temp_dir().join(format!(
        "db-connect-data-task-pg-cross-{}",
        uuid::Uuid::new_v4().simple()
    ));
    required(std::fs::create_dir(&directory), "创建跨版本临时目录失败");
    exact_modes(&source, &target, &directory).await;
    stale_and_rollback(&source, &target, &directory).await;
    identity_cancel(&source, &target, &directory).await;
    foreign_key_batches(&source, &target, &directory).await;
    generated_columns(&source, &target, &directory).await;
    generated_kind_fingerprint(&source).await;
    generated_kind_fingerprint(&target).await;
    constraint_enforcement_fingerprint(&source).await;
    constraint_enforcement_fingerprint(&target).await;
    source.close().await;
    target.close().await;
    required(std::fs::remove_dir_all(directory), "清理跨版本临时目录失败");
}
