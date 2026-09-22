//! 仅连接显式配置的 PostgreSQL 测试库，每项测试使用独立随机 schema。
//! 运行：DB_CONNECT_TEST_POSTGRES_URL=... cargo test --lib postgres_batch_live_ -- --ignored
use super::{batch_update_rows, PgRowUpdate};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod, Runtime};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration;
use tokio_postgres::NoTls;

struct Fixture {
    pool: Pool,
    schema: String,
}

impl Fixture {
    async fn new(ddl: &str) -> Self {
        let schema = format!("batch_test_{}", uuid::Uuid::new_v4().simple());
        let mut config: tokio_postgres::Config = std::env::var("DB_CONNECT_TEST_POSTGRES_URL")
            .expect("set DB_CONNECT_TEST_POSTGRES_URL to an isolated test database")
            .parse()
            .unwrap();
        config.options(format!("-c search_path={schema},public"));
        let manager = Manager::from_config(
            config,
            NoTls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(4)
            .runtime(Runtime::Tokio1)
            .build()
            .unwrap();
        let sql = format!(
            "CREATE SCHEMA {schema}; {}",
            ddl.replace("$schema", &schema)
        );
        pool.get().await.unwrap().batch_execute(&sql).await.unwrap();
        Self { pool, schema }
    }

    async fn cleanup(&self) {
        self.pool
            .get()
            .await
            .unwrap()
            .batch_execute(&format!("DROP SCHEMA {} CASCADE", self.schema))
            .await
            .unwrap();
    }

    async fn query(&self, sql: &str) -> Vec<tokio_postgres::Row> {
        self.pool
            .get()
            .await
            .unwrap()
            .query(&sql.replace("$schema", &self.schema), &[])
            .await
            .unwrap()
    }
}

fn update(keys: &[(&str, Value)], values: &[(&str, Value)]) -> PgRowUpdate {
    PgRowUpdate {
        primary_keys: keys
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone()))
            .collect::<HashMap<_, _>>(),
        updates: values
            .iter()
            .map(|(key, value)| (key.to_string(), value.clone()))
            .collect::<HashMap<_, _>>(),
    }
}

#[tokio::test]
#[ignore = "requires DB_CONNECT_TEST_POSTGRES_URL"]
async fn postgres_batch_live_groups_and_preserves_typed_values() {
    let fixture = Fixture::new(
        r#"
        CREATE TYPE $schema.mood AS ENUM ('old', 'new');
        CREATE DOMAIN $schema.positive AS integer CHECK (VALUE > 0);
        CREATE TABLE $schema.items (
            tenant integer, id bigint, mood $schema.mood, payload jsonb,
            amount $schema.positive, note text, PRIMARY KEY (tenant, id)
        );
        INSERT INTO $schema.items VALUES
            (1, 1, 'old', '{}', 1, 'old'), (1, 2, 'old', '{}', 1, 'old'),
            (2, 1, 'old', '{}', 1, 'untouched');
        CREATE TABLE $schema.update_statements (id integer);
        CREATE FUNCTION $schema.record_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO $schema.update_statements VALUES (1); RETURN NULL; END; $$;
        CREATE TRIGGER record_update AFTER UPDATE ON $schema.items
            FOR EACH STATEMENT EXECUTE FUNCTION $schema.record_update();
    "#,
    )
    .await;
    let result = batch_update_rows(
        &fixture.pool,
        &fixture.schema,
        "items",
        vec![
            update(
                &[("tenant", json!(1)), ("id", json!(1))],
                &[
                    ("mood", json!("new")),
                    ("payload", json!({"k": [1, null]})),
                    ("amount", json!("42")),
                    ("note", Value::Null),
                ],
            ),
            update(
                &[("tenant", json!(1)), ("id", json!(2))],
                &[
                    ("mood", Value::Null),
                    ("payload", Value::Null),
                    ("amount", Value::Null),
                    ("note", json!("'quoted'")),
                ],
            ),
        ],
    )
    .await;
    let rows = fixture.query("SELECT tenant, id, mood::text, payload::text, amount::integer, note FROM $schema.items ORDER BY tenant, id").await;
    let statements: i64 = fixture
        .query("SELECT count(*) FROM $schema.update_statements")
        .await[0]
        .get(0);
    fixture.cleanup().await;
    assert_eq!(result.unwrap(), 2);
    assert_eq!(statements, 1, "相同更新字段集合只触发一次语句级 UPDATE");
    assert_eq!(rows[0].get::<_, Option<String>>(2).as_deref(), Some("new"));
    let payload: String = rows[0].get(3);
    assert_eq!(
        serde_json::from_str::<Value>(&payload).unwrap(),
        json!({"k": [1, null]})
    );
    assert_eq!(rows[0].get::<_, Option<i32>>(4), Some(42));
    assert_eq!(rows[0].get::<_, Option<String>>(5), None);
    assert_eq!(rows[1].get::<_, Option<String>>(2), None);
    assert_eq!(rows[1].get::<_, Option<String>>(3), None);
    assert_eq!(rows[1].get::<_, Option<i32>>(4), None);
    assert_eq!(
        rows[1].get::<_, Option<String>>(5).as_deref(),
        Some("'quoted'")
    );
    assert_eq!(rows[2].get::<_, String>(5), "untouched");
}

#[tokio::test]
#[ignore = "requires DB_CONNECT_TEST_POSTGRES_URL"]
async fn postgres_batch_live_rejects_database_equivalent_locators() {
    let fixture = Fixture::new("CREATE TABLE $schema.items (id integer PRIMARY KEY, a integer, b integer); INSERT INTO $schema.items VALUES (1, 0, 0);").await;
    let same_group = batch_update_rows(
        &fixture.pool,
        &fixture.schema,
        "items",
        vec![
            update(&[("id", json!(1))], &[("a", json!(10))]),
            update(&[("id", json!("01"))], &[("a", json!(20))]),
        ],
    )
    .await;
    let separate_groups = batch_update_rows(
        &fixture.pool,
        &fixture.schema,
        "items",
        vec![
            update(&[("id", json!(1))], &[("a", json!(10))]),
            update(&[("id", json!("01"))], &[("b", json!(20))]),
        ],
    )
    .await;
    let rows = fixture.query("SELECT a, b FROM $schema.items").await;
    fixture.cleanup().await;
    assert!(same_group.unwrap_err().contains("重复"));
    assert!(separate_groups.unwrap_err().contains("重复"));
    assert_eq!((rows[0].get::<_, i32>(0), rows[0].get::<_, i32>(1)), (0, 0));
}

#[tokio::test]
#[ignore = "requires DB_CONNECT_TEST_POSTGRES_URL"]
async fn postgres_batch_live_rejects_citext_equivalent_locators() {
    let fixture = Fixture::new(
        r#"
        CREATE EXTENSION citext WITH SCHEMA $schema;
        CREATE TABLE $schema.items (id $schema.citext PRIMARY KEY, value integer);
        INSERT INTO $schema.items VALUES ('Alpha', 0);
    "#,
    )
    .await;
    let result = batch_update_rows(
        &fixture.pool,
        &fixture.schema,
        "items",
        vec![
            update(&[("id", json!("Alpha"))], &[("value", json!(1))]),
            update(&[("id", json!("ALPHA"))], &[("value", json!(2))]),
        ],
    )
    .await;
    let rows = fixture.query("SELECT value FROM $schema.items").await;
    fixture.cleanup().await;
    assert!(result.unwrap_err().contains("重复"));
    assert_eq!(rows[0].get::<_, i32>(0), 0);
}

#[tokio::test]
#[ignore = "requires DB_CONNECT_TEST_POSTGRES_URL"]
async fn postgres_batch_live_rolls_back_on_later_domain_failure() {
    let fixture = Fixture::new(
        r#"
        CREATE DOMAIN $schema.positive AS integer CHECK (VALUE > 0);
        CREATE TABLE $schema.items (id integer PRIMARY KEY, a text, z $schema.positive);
        INSERT INTO $schema.items VALUES (1, 'old', 1), (2, 'old', 1);
    "#,
    )
    .await;
    let result = batch_update_rows(
        &fixture.pool,
        &fixture.schema,
        "items",
        vec![
            update(&[("id", json!(1))], &[("a", json!("new"))]),
            update(&[("id", json!(2))], &[("z", json!(-1))]),
        ],
    )
    .await;
    let rows = fixture
        .query("SELECT a, z::integer FROM $schema.items ORDER BY id")
        .await;
    fixture.cleanup().await;
    assert!(result.unwrap_err().contains("回滚"));
    assert_eq!(rows[0].get::<_, String>(0), "old");
    assert_eq!(rows[1].get::<_, i32>(1), 1);
}

#[tokio::test]
#[ignore = "requires DB_CONNECT_TEST_POSTGRES_URL"]
async fn postgres_batch_live_requires_complete_composite_primary_key() {
    let fixture = Fixture::new("CREATE TABLE $schema.items (tenant integer, id integer, value integer, PRIMARY KEY (tenant, id)); INSERT INTO $schema.items VALUES (1, 1, 0), (2, 1, 0);").await;
    let result = batch_update_rows(
        &fixture.pool,
        &fixture.schema,
        "items",
        vec![update(&[("id", json!(1))], &[("value", json!(10))])],
    )
    .await;
    let rows = fixture
        .query("SELECT value FROM $schema.items ORDER BY tenant")
        .await;
    fixture.cleanup().await;
    assert!(result.is_err());
    assert_eq!(rows[0].get::<_, i32>(0), 0);
    assert_eq!(rows[1].get::<_, i32>(0), 0);
}

#[tokio::test]
#[ignore = "requires DB_CONNECT_TEST_POSTGRES_URL"]
async fn postgres_batch_live_updates_keys_using_original_row_values() {
    let fixture = Fixture::new("CREATE TABLE $schema.items (id integer PRIMARY KEY, note text); INSERT INTO $schema.items VALUES (1, 'old'), (2, 'old');").await;
    let result = batch_update_rows(
        &fixture.pool,
        &fixture.schema,
        "items",
        vec![
            update(
                &[("id", json!(1))],
                &[("id", json!(11)), ("note", json!("first"))],
            ),
            update(
                &[("id", json!(2))],
                &[("id", json!(12)), ("note", json!("second"))],
            ),
        ],
    )
    .await;
    let rows = fixture
        .query("SELECT id, note FROM $schema.items ORDER BY id")
        .await;
    fixture.cleanup().await;
    assert_eq!(result.unwrap(), 2);
    assert_eq!(
        (rows[0].get::<_, i32>(0), rows[0].get::<_, String>(1)),
        (11, "first".into())
    );
    assert_eq!(
        (rows[1].get::<_, i32>(0), rows[1].get::<_, String>(1)),
        (12, "second".into())
    );
}

#[tokio::test]
#[ignore = "requires DB_CONNECT_TEST_POSTGRES_URL"]
async fn postgres_batch_live_rejects_missing_target_before_key_changes() {
    let fixture = Fixture::new("CREATE TABLE $schema.items (id integer PRIMARY KEY, note text); INSERT INTO $schema.items VALUES (1, 'old');").await;
    let result = batch_update_rows(
        &fixture.pool,
        &fixture.schema,
        "items",
        vec![
            update(&[("id", json!(1))], &[("id", json!(9))]),
            update(&[("id", json!("09"))], &[("note", json!("unexpected"))]),
        ],
    )
    .await;
    let rows = fixture.query("SELECT id, note FROM $schema.items").await;
    fixture.cleanup().await;
    assert!(result.unwrap_err().contains("刷新"));
    assert_eq!(
        (rows[0].get::<_, i32>(0), rows[0].get::<_, String>(1)),
        (1, "old".into())
    );
}

#[tokio::test]
#[ignore = "requires DB_CONNECT_TEST_POSTGRES_URL"]
async fn postgres_batch_live_does_not_update_rows_inserted_after_validation() {
    let fixture = Fixture::new(
        "CREATE TABLE $schema.items (id integer PRIMARY KEY, a text, z text); \
         INSERT INTO $schema.items VALUES (2, 'old', 'old');",
    )
    .await;
    let mut locking_client = fixture.pool.get().await.unwrap();
    let blocker_pid: i32 = locking_client
        .query_one("SELECT pg_backend_pid()", &[])
        .await
        .unwrap()
        .get(0);
    let blocker = locking_client.transaction().await.unwrap();
    blocker
        .query(
            &format!(
                "SELECT id FROM {}.items WHERE id = 2 FOR UPDATE",
                fixture.schema
            ),
            &[],
        )
        .await
        .unwrap();

    let pool = fixture.pool.clone();
    let schema = fixture.schema.clone();
    let batch = tokio::spawn(async move {
        batch_update_rows(
            &pool,
            &schema,
            "items",
            vec![
                update(&[("id", json!(1))], &[("a", json!("first"))]),
                update(&[("id", json!("01"))], &[("a", json!("second"))]),
                update(&[("id", json!(2))], &[("z", json!("updated"))]),
            ],
        )
        .await
    });

    let monitor = fixture.pool.get().await.unwrap();
    // 以服务端实际阻塞状态同步，不能靠固定 sleep 猜测第一组校验已执行。
    let waiting = tokio::time::timeout(Duration::from_secs(10), async {
        let mut polling = tokio::time::interval(Duration::from_millis(10));
        loop {
            polling.tick().await;
            let blocked: bool = monitor
                .query_one(
                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity \
                     WHERE $1 = ANY(pg_blocking_pids(pid)) \
                       AND query LIKE 'SELECT%batch_identity%' \
                       AND position($2 IN query) > 0)",
                    &[&blocker_pid, &fixture.schema],
                )
                .await
                .unwrap()
                .get(0);
            if blocked {
                break;
            }
        }
    })
    .await;
    if waiting.is_err() {
        blocker.rollback().await.unwrap();
        batch.abort();
        let _ = batch.await;
        fixture.cleanup().await;
        panic!("批量更新未在预期的第二组校验处阻塞");
    }

    monitor
        .execute(
            &format!(
                "INSERT INTO {}.items VALUES (1, 'inserted', 'inserted')",
                fixture.schema
            ),
            &[],
        )
        .await
        .unwrap();
    blocker.commit().await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(10), batch)
        .await
        .unwrap()
        .unwrap();
    let rows = fixture
        .query("SELECT id, a, z FROM $schema.items ORDER BY id")
        .await;
    fixture.cleanup().await;
    assert_eq!(
        rows[0].get::<_, String>(1),
        "inserted",
        "校验快照中不存在的新插入行不能被后续 UPDATE 命中"
    );
    assert_eq!(rows[1].get::<_, String>(2), "updated");
    assert_eq!(result.unwrap(), 1);
}
