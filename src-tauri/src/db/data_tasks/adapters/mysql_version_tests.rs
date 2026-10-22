//! 双实例、双版本真实合约；必须显式提供两个本任务专属容器 URL。
use super::{id, open_native, server_version_verified};
use crate::{
    db::data_tasks::{
        adapters::DataSession,
        executor::{execute_plan, prepare_task},
        plan::StoredDataPlan,
        Cancellation,
    },
    models::{
        data_tasks::{
            ColumnMapping, DataCommitState, DataEndpoint, DataTaskKind, DataTaskMode,
            DataTaskRequest, DataTaskStatus, TableMapping,
        },
        types::ConnectionConfig,
    },
};
use mysql_async::{prelude::Queryable, Conn, Opts, Row};
use std::{path::Path, sync::atomic::AtomicBool, sync::Arc, time::Duration};

// 错误正文可能来自驱动或 URL 解析；验收日志只输出阶段和确认过的服务端版本。
fn required<T, E>(result: Result<T, E>, stage: &str) -> T {
    result.unwrap_or_else(|_| panic!("{stage}"))
}

struct Fixture {
    observer: Conn,
    opts: Opts,
    config: ConnectionConfig,
    endpoint: DataEndpoint,
    version: String,
    instance: String,
}

impl Fixture {
    async fn new(env: &str) -> Self {
        let url = required(std::env::var(env), "必须显式提供本任务专属 MySQL 容器 URL");
        let opts = required(Opts::from_url(&url), "专属 MySQL 容器 URL 无效");
        assert!(
            matches!(opts.ip_or_hostname(), "127.0.0.1" | "localhost"),
            "跨版本测试仅允许本机回环地址"
        );
        assert!(
            opts.tcp_port() != 3306 && opts.tcp_port() != 0,
            "跨版本测试必须使用专属容器随机端口"
        );
        let mut observer = required(Conn::new(opts.clone()).await, "连接专属容器失败");
        let (version, hostname, port, server_id): (String, String, u64, u64) = required(
            observer
                .query_first("SELECT @@version,@@hostname,@@port,@@server_id")
                .await,
            "读取跨版本实例身份失败",
        )
        .expect("跨版本实例身份缺失");
        assert!(server_version_verified(&version), "实例版本未通过能力门禁");
        let unique = format!("data_task_cross_version_{}", uuid::Uuid::new_v4().simple());
        required(
            observer
                .query_drop(format!(
                    "SET NAMES utf8mb4; SET SESSION time_zone='+00:00'; \
                     SET SESSION sql_mode='STRICT_ALL_TABLES,NO_AUTO_VALUE_ON_ZERO'; \
                     CREATE DATABASE {} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin",
                    id(&unique)
                ))
                .await,
            "创建跨版本隔离数据库失败",
        );
        let config: ConnectionConfig = required(
            serde_json::from_value(serde_json::json!({
                "id": unique,
                "database_type": "mysql",
                "name": "数据任务跨版本隔离测试",
                "host": opts.ip_or_hostname(),
                "port": opts.tcp_port(),
                "username": opts.user().unwrap_or("root"),
                "password": opts.pass(),
                "ssh": null,
                "database": null
            })),
            "构造跨版本隔离连接失败",
        );
        Self {
            observer,
            opts,
            config,
            endpoint: DataEndpoint {
                saved_connection_id: unique.clone(),
                database: unique,
            },
            version,
            // 与生产适配器使用相同的实例身份，MySQL 5.5 尚无 server_uuid。
            instance: format!("mysql:{hostname}:{port}:{server_id}"),
        }
    }

    fn supports_fractional_seconds(&self) -> bool {
        !self.version.starts_with("5.5.")
    }

    async fn sql(&mut self, sql: String) {
        required(
            self.observer.query_drop(sql).await,
            "跨版本夹具 SQL 执行失败",
        );
    }

    async fn close(mut self) {
        self.sql(format!("DROP DATABASE {}", id(&self.endpoint.database)))
            .await;
        required(self.observer.disconnect().await, "跨版本夹具连接关闭失败");
    }
}

const EXACT_COLUMNS: [&str; 10] = [
    "id",
    "signed_value",
    "unsigned_value",
    "amount",
    "bytes_value",
    "dt",
    "ts",
    "d",
    "tm",
    "v",
];
const EXACT_DEFINITION: &str = "id BIGINT PRIMARY KEY AUTO_INCREMENT, \
    signed_value BIGINT, unsigned_value BIGINT UNSIGNED, amount DECIMAL(65,20), \
    bytes_value VARBINARY(100), dt DATETIME(6), ts TIMESTAMP(6) NULL, d DATE, tm TIME(6), \
    v VARCHAR(80)";
const SOURCE_VALUES: &str = "\
    (9007199254740993,-9223372036854775808,18446744073709551615,\
     123456789012345678901234567890123456789012345.12345678901234567890,\
     X'0001FEFF','2026-10-20 12:34:56.123456','2026-10-20 12:34:56.654321',\
     '9999-12-31','-838:59:58.123456','中文😀'),\
    (9007199254740994,9223372036854775807,0,-0.00000000000000000001,\
     X'','1000-01-01 00:00:00.000001','1970-01-01 00:00:01.000001',\
     '1000-01-01','838:59:58.123456',''),\
    (9007199254740995,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)";

fn exact_definition(fractional_seconds: bool) -> String {
    if fractional_seconds {
        EXACT_DEFINITION.into()
    } else {
        EXACT_DEFINITION
            .replace("DATETIME(6)", "DATETIME")
            .replace("TIMESTAMP(6)", "TIMESTAMP")
            .replace("TIME(6)", "TIME")
    }
}

fn source_values(fractional_seconds: bool) -> String {
    if fractional_seconds {
        SOURCE_VALUES.into()
    } else {
        // 仅改变六个时间字面量，不能截断高精度 DECIMAL 的小数部分。
        SOURCE_VALUES
            .replace("'2026-10-20 12:34:56.123456'", "'2026-10-20 12:34:56'")
            .replace("'2026-10-20 12:34:56.654321'", "'2026-10-20 12:34:56'")
            .replace("'-838:59:58.123456'", "'-838:59:58'")
            .replace("'1000-01-01 00:00:00.000001'", "'1000-01-01 00:00:00'")
            .replace("'1970-01-01 00:00:01.000001'", "'1970-01-01 00:00:01'")
            .replace("'838:59:58.123456'", "'838:59:58'")
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
            format!("mysql-cross-version-{}", uuid::Uuid::new_v4().simple()),
            request,
            source.config.clone(),
            target.config.clone(),
            directory.to_path_buf(),
            Arc::new(AtomicBool::new(false)),
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
        Arc::new(AtomicBool::new(false)),
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

fn strings(values: &[&str]) -> Vec<Option<String>> {
    values.iter().map(|value| Some((*value).into())).collect()
}

fn exact_expected(fractional_seconds: bool) -> Vec<Vec<Option<String>>> {
    let mut nulls = vec![None; EXACT_COLUMNS.len()];
    nulls[0] = Some("9007199254740995".into());
    let mut rows = vec![
        strings(&[
            "9007199254740993",
            "-9223372036854775808",
            "18446744073709551615",
            "123456789012345678901234567890123456789012345.12345678901234567890",
            "0001FEFF",
            "2026-10-20 12:34:56.123456",
            "2026-10-20 12:34:56.654321",
            "9999-12-31",
            "-838:59:58.123456",
            "中文😀",
        ]),
        strings(&[
            "9007199254740994",
            "9223372036854775807",
            "0",
            "-0.00000000000000000001",
            "",
            "1000-01-01 00:00:00.000001",
            "1970-01-01 00:00:01.000001",
            "1000-01-01",
            "838:59:58.123456",
            "",
        ]),
        nulls,
    ];
    if !fractional_seconds {
        rows[0][5] = Some("2026-10-20 12:34:56".into());
        rows[0][6] = Some("2026-10-20 12:34:56".into());
        rows[0][8] = Some("-838:59:58".into());
        rows[1][5] = Some("1000-01-01 00:00:00".into());
        rows[1][6] = Some("1970-01-01 00:00:01".into());
        rows[1][8] = Some("838:59:58".into());
    }
    rows
}

fn retained_row() -> Vec<Option<String>> {
    let mut row = vec![None; EXACT_COLUMNS.len()];
    row[0] = Some("9007199254740996".into());
    row[9] = Some("target-only".into());
    row
}

async fn exact_rows(fixture: &mut Fixture, table: &str) -> Vec<Vec<Option<String>>> {
    // 独立直接读取存储值，不复用适配器 JSON 解码，避免同一实现的错误相互抵消。
    let rows: Vec<Row> = required(
        fixture
            .observer
            .query(format!(
                "SELECT CAST(id AS CHAR),CAST(signed_value AS CHAR),\
                 CAST(unsigned_value AS CHAR),CAST(amount AS CHAR),HEX(bytes_value),\
                 CAST(dt AS CHAR),CAST(ts AS CHAR),CAST(d AS CHAR),CAST(tm AS CHAR),v \
                 FROM {}.{} ORDER BY id",
                id(&fixture.endpoint.database),
                id(table)
            ))
            .await,
        "跨版本精确值核验查询失败",
    );
    rows.into_iter()
        .map(|row| {
            (0..EXACT_COLUMNS.len())
                .map(|index| required(super::cell(&row, index), "跨版本核验值解码失败"))
                .collect()
        })
        .collect()
}

async fn exact_modes(source: &mut Fixture, target: &mut Fixture, directory: &Path) {
    let source_db = id(&source.endpoint.database);
    let target_db = id(&target.endpoint.database);
    let fractional_seconds =
        source.supports_fractional_seconds() && target.supports_fractional_seconds();
    let definition = exact_definition(fractional_seconds);
    let values = source_values(fractional_seconds);
    source
        .sql(format!(
            "CREATE TABLE {source_db}.exact_rows({definition}) ENGINE=InnoDB; \
             INSERT INTO {source_db}.exact_rows VALUES {values}"
        ))
        .await;
    target
        .sql(format!(
            "CREATE TABLE {target_db}.exact_rows({definition}) ENGINE=InnoDB; \
             CREATE TABLE {target_db}.transfer_rows({definition}) ENGINE=InnoDB; \
             INSERT INTO {target_db}.exact_rows(id,signed_value,unsigned_value,amount,bytes_value,v) \
             VALUES(9007199254740994,0,1,1,X'FF','old'),\
                   (9007199254740996,NULL,NULL,NULL,NULL,'target-only'); \
             INSERT INTO {target_db}.transfer_rows(id,v) VALUES(9007199254740996,'target-only')"
        ))
        .await;
    let mut expected = exact_expected(fractional_seconds);
    assert!(
        exact_rows(source, "exact_rows").await == expected,
        "源夹具的整数、小数、二进制、日期时间与空值必须精确"
    );
    let row_mapping = vec![mapping("exact_rows", "exact_rows", &EXACT_COLUMNS)];
    let merge = prepare(
        source,
        target,
        request(source, target, DataTaskMode::Merge, row_mapping.clone()),
        directory,
    )
    .await;
    let counts = &merge.preview.tables[0].counts;
    assert!(
        counts.inserted == "2" && counts.updated == "1" && counts.retained == "1",
        "跨版本合并预览应包含插入、更新和保留"
    );
    source
        .sql(format!(
            "UPDATE {source_db}.exact_rows SET v='source-after-preview' WHERE id=9007199254740993"
        ))
        .await;
    execute(source, target, merge).await;
    let mut with_retained = expected.clone();
    with_retained.push(retained_row());
    assert!(
        exact_rows(target, "exact_rows").await == with_retained,
        "跨版本合并必须使用冻结源值，精确写入所有类型并保留目标独有行"
    );

    expected[0][9] = Some("source-after-preview".into());
    let mirror = prepare(
        source,
        target,
        request(source, target, DataTaskMode::Mirror, row_mapping),
        directory,
    )
    .await;
    assert!(
        mirror.preview.tables[0].counts.deleted == "1",
        "镜像应删除目标独有行"
    );
    execute(source, target, mirror).await;
    assert!(
        exact_rows(target, "exact_rows").await == expected,
        "跨版本镜像的全部列必须与源存储值精确一致"
    );

    let transfer_mapping = vec![mapping("exact_rows", "transfer_rows", &EXACT_COLUMNS)];
    let append = prepare(
        source,
        target,
        request(
            source,
            target,
            DataTaskMode::Append,
            transfer_mapping.clone(),
        ),
        directory,
    )
    .await;
    execute(source, target, append).await;
    let mut appended = expected.clone();
    appended.push(retained_row());
    assert!(
        exact_rows(target, "transfer_rows").await == appended,
        "跨版本追加必须保留目标旧行并无损插入全部源值"
    );
    let replace = prepare(
        source,
        target,
        request(source, target, DataTaskMode::Replace, transfer_mapping),
        directory,
    )
    .await;
    execute(source, target, replace).await;
    assert!(
        exact_rows(target, "transfer_rows").await == expected,
        "跨版本替换必须完整替换目标并保留全部精确值"
    );
}

async fn temporal_precision_widening_preserves_values(
    source: &mut Fixture,
    target: &mut Fixture,
    directory: &Path,
) {
    if source.supports_fractional_seconds() || !target.supports_fractional_seconds() {
        return;
    }
    let source_db = id(&source.endpoint.database);
    let target_db = id(&target.endpoint.database);
    // 显式 TIMESTAMP 默认值禁用 5.5 的隐式 ON UPDATE；沿用支持的整数定位键。
    source
        .sql(format!(
            "CREATE TABLE {source_db}.precision_widen_rows(\
             id BIGINT PRIMARY KEY,dt DATETIME NOT NULL,ts TIMESTAMP NOT NULL DEFAULT '2000-01-01 00:00:01',\
             tm TIME NOT NULL,v VARCHAR(80)) ENGINE=InnoDB; \
             INSERT INTO {source_db}.precision_widen_rows VALUES\
             (1,'2026-10-20 12:34:56','2026-10-20 12:34:56','-838:59:58','updated'),\
             (2,'1000-01-01 00:00:00','1970-01-01 00:00:01','838:59:58','inserted')"
        ))
        .await;
    target
        .sql(format!(
            "CREATE TABLE {target_db}.precision_widen_rows(\
             id BIGINT PRIMARY KEY,dt DATETIME(6) NOT NULL,ts TIMESTAMP(6) NOT NULL DEFAULT '2000-01-01 00:00:01',\
             tm TIME(6) NOT NULL,v VARCHAR(80)) ENGINE=InnoDB; \
             INSERT INTO {target_db}.precision_widen_rows VALUES\
             (1,'2026-10-20 12:34:56.000000','2026-10-20 12:34:56.000000','-838:59:58.000000','old'),\
             (3,'2027-01-02 03:04:05.000000','2027-01-02 03:04:05.000000','-25:00:00.000000','target-only')"
        ))
        .await;
    let source_rows: Vec<(String, String, String, String)> = required(
        source
            .observer
            .query(format!(
                "SELECT CAST(dt AS CHAR),CAST(ts AS CHAR),CAST(tm AS CHAR),v \
                 FROM {source_db}.precision_widen_rows ORDER BY dt,ts,tm"
            ))
            .await,
        "秒精度扩大场景源存储值核验失败",
    );
    assert!(
        source_rows
            == vec![
                (
                    "1000-01-01 00:00:00".into(),
                    "1970-01-01 00:00:01".into(),
                    "838:59:58".into(),
                    "inserted".into(),
                ),
                (
                    "2026-10-20 12:34:56".into(),
                    "2026-10-20 12:34:56".into(),
                    "-838:59:58".into(),
                    "updated".into(),
                ),
            ],
        "MySQL 5.5 源夹具必须实际保存秒精度与正负超过 24 小时的 TIME"
    );
    let merge = prepare(
        source,
        target,
        request(
            source,
            target,
            DataTaskMode::Merge,
            vec![mapping(
                "precision_widen_rows",
                "precision_widen_rows",
                &["id", "dt", "ts", "tm", "v"],
            )],
        ),
        directory,
    )
    .await;
    let counts = &merge.preview.tables[0].counts;
    assert!(
        counts.inserted == "1" && counts.updated == "1" && counts.retained == "1",
        "时间精度扩大后的合并应包含一次插入、更新和保留"
    );
    execute(source, target, merge).await;
    let target_rows: Vec<(String, String, String, String)> = required(
        target
            .observer
            .query(format!(
                "SELECT CAST(dt AS CHAR),CAST(ts AS CHAR),CAST(tm AS CHAR),v \
                 FROM {target_db}.precision_widen_rows ORDER BY dt,ts,tm"
            ))
            .await,
        "秒精度扩大后的目标存储值核验失败",
    );
    assert!(
        target_rows
            == vec![
                (
                    "1000-01-01 00:00:00.000000".into(),
                    "1970-01-01 00:00:01.000000".into(),
                    "838:59:58.000000".into(),
                    "inserted".into(),
                ),
                (
                    "2026-10-20 12:34:56.000000".into(),
                    "2026-10-20 12:34:56.000000".into(),
                    "-838:59:58.000000".into(),
                    "updated".into(),
                ),
                (
                    "2027-01-02 03:04:05.000000".into(),
                    "2027-01-02 03:04:05.000000".into(),
                    "-25:00:00.000000".into(),
                    "target-only".into(),
                ),
            ],
        "精度扩大必须真实提交插入与更新，保留负时长、时间主键和目标独有记录"
    );
}

async fn assert_temporal_narrowing_rejected(
    source: &Fixture,
    target: &Fixture,
    directory: &Path,
    column: &str,
) {
    let outcome = prepare_task(
        format!("mysql-cross-version-{}", uuid::Uuid::new_v4().simple()),
        request(
            source,
            target,
            DataTaskMode::Replace,
            vec![mapping("precision_rows", "precision_rows", &["id", column])],
        ),
        source.config.clone(),
        target.config.clone(),
        directory.to_path_buf(),
        Arc::new(AtomicBool::new(false)),
        Arc::new(|_| {}),
    )
    .await;
    assert!(
        matches!(outcome, Err(ref error)
            if error.code == "unsupported_capability"
                && error.message.contains("字段类型不能证明无损兼容")),
        "{column} 从微秒精度写入 MySQL 5.5 秒精度目标必须在预览阶段以类型不兼容拒绝"
    );
}

async fn temporal_precision_loss_is_rejected(
    source: &mut Fixture,
    target: &mut Fixture,
    directory: &Path,
) {
    if !source.supports_fractional_seconds() || target.supports_fractional_seconds() {
        return;
    }
    let source_db = id(&source.endpoint.database);
    let target_db = id(&target.endpoint.database);
    source
        .sql(format!(
            "CREATE TABLE {source_db}.precision_rows(\
             id BIGINT PRIMARY KEY,dt DATETIME(6),ts TIMESTAMP(6) NULL,tm TIME(6)) ENGINE=InnoDB; \
             INSERT INTO {source_db}.precision_rows VALUES(1,\
             '2026-10-20 12:34:56.123456','2026-10-20 12:34:56.654321','-838:59:58.123456')"
        ))
        .await;
    target
        .sql(format!(
            "CREATE TABLE {target_db}.precision_rows(\
             id BIGINT PRIMARY KEY,dt DATETIME,ts TIMESTAMP NULL,tm TIME) ENGINE=InnoDB; \
             INSERT INTO {target_db}.precision_rows VALUES(7,\
             '2025-01-02 03:04:05','2025-01-02 03:04:05','00:01:02')"
        ))
        .await;
    let source_rows: Vec<(i64, String, String, String)> = required(
        source
            .observer
            .query(format!(
                "SELECT id,CAST(dt AS CHAR),CAST(ts AS CHAR),CAST(tm AS CHAR) \
                 FROM {source_db}.precision_rows ORDER BY id"
            ))
            .await,
        "微秒源值独立核验查询失败",
    );
    assert!(
        source_rows
            == vec![(
                1,
                "2026-10-20 12:34:56.123456".into(),
                "2026-10-20 12:34:56.654321".into(),
                "-838:59:58.123456".into(),
            )],
        "拒绝场景的 DATETIME、TIMESTAMP、TIME 源数据必须真实包含非零微秒"
    );
    // 分别验证三种时间类型，避免首个不兼容列掩盖其余类型的精度检查。
    assert_temporal_narrowing_rejected(source, target, directory, "dt").await;
    assert_temporal_narrowing_rejected(source, target, directory, "ts").await;
    assert_temporal_narrowing_rejected(source, target, directory, "tm").await;
    let target_rows: Vec<(i64, String, String, String)> = required(
        target
            .observer
            .query(format!(
                "SELECT id,CAST(dt AS CHAR),CAST(ts AS CHAR),CAST(tm AS CHAR) \
                 FROM {target_db}.precision_rows ORDER BY id"
            ))
            .await,
        "精度拒绝后的目标值独立核验查询失败",
    );
    assert!(
        target_rows
            == vec![(
                7,
                "2025-01-02 03:04:05".into(),
                "2025-01-02 03:04:05".into(),
                "00:01:02".into(),
            )],
        "精度不兼容的替换任务必须保留目标原值，不能截断源值或清空目标"
    );
}

fn foreign_key_schema(database: &str) -> String {
    format!(
        "CREATE TABLE {database}.z_parent(id BIGINT PRIMARY KEY,v VARCHAR(80)) ENGINE=InnoDB; \
         CREATE TABLE {database}.a_child(id BIGINT PRIMARY KEY,parent_id BIGINT NOT NULL,v VARCHAR(80),\
         CONSTRAINT parent_fk FOREIGN KEY(parent_id) REFERENCES {database}.z_parent(id) \
         ON UPDATE RESTRICT ON DELETE RESTRICT) ENGINE=InnoDB"
    )
}

async fn foreign_key_rows(fixture: &mut Fixture) -> Vec<(String, i64, i64, String)> {
    let database = id(&fixture.endpoint.database);
    required(
        fixture
            .observer
            .query(format!(
                "SELECT 'parent',id,id,v FROM {database}.z_parent \
                 UNION ALL SELECT 'child',id,parent_id,v FROM {database}.a_child ORDER BY 1,2"
            ))
            .await,
        "跨版本外键多表核验失败",
    )
}

fn assert_foreign_key_order(plan: &StoredDataPlan) {
    assert!(
        plan.mapping.insert_order == ["z_parent", "a_child"]
            && plan.mapping.delete_order == ["a_child", "z_parent"],
        "多表外键任务必须先插父表、先删子表，不能依赖表名排序"
    );
}

async fn foreign_key_modes(source: &mut Fixture, target: &mut Fixture, directory: &Path) {
    let source_db = id(&source.endpoint.database);
    let target_db = id(&target.endpoint.database);
    source
        .sql(format!(
            "{}; INSERT INTO {source_db}.z_parent VALUES(1,'P1'),(2,'P2'); \
             INSERT INTO {source_db}.a_child VALUES(11,1,'C1'),(12,2,'C2')",
            foreign_key_schema(&source_db)
        ))
        .await;
    target
        .sql(format!(
            "{}; INSERT INTO {target_db}.z_parent VALUES(3,'P3'); \
             INSERT INTO {target_db}.a_child VALUES(13,3,'C3')",
            foreign_key_schema(&target_db)
        ))
        .await;
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
    assert_foreign_key_order(&append);
    execute(source, target, append).await;
    assert!(
        foreign_key_rows(target).await
            == vec![
                ("child".into(), 11, 1, "C1".into()),
                ("child".into(), 12, 2, "C2".into()),
                ("child".into(), 13, 3, "C3".into()),
                ("parent".into(), 1, 1, "P1".into()),
                ("parent".into(), 2, 2, "P2".into()),
                ("parent".into(), 3, 3, "P3".into()),
            ],
        "跨版本外键追加必须保留旧父子记录且完整插入新父子记录"
    );
    let replace = prepare(
        source,
        target,
        request(source, target, DataTaskMode::Replace, mappings),
        directory,
    )
    .await;
    assert_foreign_key_order(&replace);
    execute(source, target, replace).await;
    assert!(
        foreign_key_rows(target).await
            == vec![
                ("child".into(), 11, 1, "C1".into()),
                ("child".into(), 12, 2, "C2".into()),
                ("parent".into(), 1, 1, "P1".into()),
                ("parent".into(), 2, 2, "P2".into()),
            ],
        "跨版本外键替换必须按依赖删除并重建全部父子记录"
    );
}

async fn foreign_key_locks(target: &mut Fixture) {
    let cancel: Cancellation = Arc::new(AtomicBool::new(false));
    let mut session = required(
        open_native(target.config.clone(), target.endpoint.clone(), cancel).await,
        "打开外键目标保护会话失败",
    );
    let mut writer = required(
        Conn::new(target.opts.clone()).await,
        "打开外键并发写连接失败",
    );
    let mut ddl = required(
        Conn::new(target.opts.clone()).await,
        "打开外键并发 DDL 连接失败",
    );
    required(
        session
            .begin_protected_write(vec!["a_child".into(), "z_parent".into()])
            .await,
        "外键多表保护锁获取失败",
    );
    assert!(
        required(
            session.delete_all("a_child".into()).await,
            "保护事务内删除子表失败"
        ) == 2,
        "保护事务应删除两条子记录"
    );
    let database = id(&target.endpoint.database);
    let insert = format!("INSERT INTO {database}.a_child VALUES(99,1,'after-lock')");
    let alter = format!("ALTER TABLE {database}.z_parent ADD COLUMN after_lock INT NULL");
    let (write_started, writing) = tokio::sync::oneshot::channel();
    let (ddl_started, altering) = tokio::sync::oneshot::channel();
    let blocked_write = tokio::spawn(async move {
        let _ = write_started.send(());
        required(writer.query_drop(insert).await, "解锁后的外键并发写失败");
        required(writer.disconnect().await, "关闭外键并发写连接失败");
    });
    let blocked_ddl = tokio::spawn(async move {
        let _ = ddl_started.send(());
        required(ddl.query_drop(alter).await, "解锁后的父表 DDL 失败");
        required(ddl.disconnect().await, "关闭外键 DDL 连接失败");
    });
    required(writing.await, "外键并发写任务未启动");
    required(altering.await, "外键并发 DDL 任务未启动");
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!blocked_write.is_finished(), "保护锁必须阻止子表并发写入");
    assert!(!blocked_ddl.is_finished(), "保护锁必须阻止父表结构变化");
    required(session.rollback().await, "外键多表保护事务回滚失败");
    required(
        required(
            tokio::time::timeout(Duration::from_secs(5), blocked_write).await,
            "回滚后外键并发写仍被阻塞",
        ),
        "外键并发写任务失败",
    );
    required(
        required(
            tokio::time::timeout(Duration::from_secs(5), blocked_ddl).await,
            "回滚后父表 DDL 仍被阻塞",
        ),
        "外键 DDL 任务失败",
    );
    assert!(
        session.take_cleanup_errors().is_empty(),
        "外键保护锁清理失败"
    );
    assert!(
        foreign_key_rows(target).await
            == vec![
                ("child".into(), 11, 1, "C1".into()),
                ("child".into(), 12, 2, "C2".into()),
                ("child".into(), 99, 1, "after-lock".into()),
                ("parent".into(), 1, 1, "P1".into()),
                ("parent".into(), 2, 2, "P2".into()),
            ],
        "回滚必须恢复原子表记录并释放锁，不能被 LOCK TABLES 隐式提交"
    );
}

#[tokio::test]
#[ignore = "需要显式配置 MYSQL_URL 与 MYSQL_TARGET_URL 的不同版本专属隔离容器"]
async fn real_mysql_cross_version_contract() {
    let mut source = Fixture::new("DB_CONNECT_DATA_TASK_MYSQL_URL").await;
    let mut target = Fixture::new("DB_CONNECT_DATA_TASK_MYSQL_TARGET_URL").await;
    assert!(
        source.instance != target.instance,
        "跨版本合约必须连接不同物理实例"
    );
    assert!(
        source.version != target.version,
        "跨版本合约必须连接不同服务端版本"
    );
    println!(
        "DATA_TASK_MYSQL_CROSS_VERSION source={} target={}",
        source.version, target.version
    );
    let directory = std::env::temp_dir().join(format!(
        "db-connect-data-task-mysql-cross-version-{}",
        uuid::Uuid::new_v4().simple()
    ));
    required(std::fs::create_dir(&directory), "创建跨版本临时目录失败");
    exact_modes(&mut source, &mut target, &directory).await;
    temporal_precision_widening_preserves_values(&mut source, &mut target, &directory).await;
    temporal_precision_loss_is_rejected(&mut source, &mut target, &directory).await;
    foreign_key_modes(&mut source, &mut target, &directory).await;
    foreign_key_locks(&mut target).await;
    source.close().await;
    target.close().await;
    required(std::fs::remove_dir_all(directory), "清理跨版本临时目录失败");
}
