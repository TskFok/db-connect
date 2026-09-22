//! 仅对显式提供的临时数据库运行：DB_CONNECT_TEST_MYSQL_URL=... cargo test
//! --lib mysql_batch_live -- --ignored --nocapture
use super::*;
use serde_json::json;

fn row(keys: &[(&str, JsonValue)], values: &[(&str, JsonValue)]) -> RowUpdate {
    RowUpdate {
        primary_keys: keys
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
        updates: values
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect(),
    }
}

#[tokio::test]
#[ignore = "需要 DB_CONNECT_TEST_MYSQL_URL 指向隔离测试数据库"]
async fn mysql_batch_live_set_updates_and_atomic_rollback() {
    let url = std::env::var("DB_CONNECT_TEST_MYSQL_URL").expect("isolated MySQL URL");
    let pool = mysql_async::Pool::new(mysql_async::Opts::from_url(&url).unwrap());
    let mut conn = pool.get_conn().await.unwrap();
    let database = format!("batch_test_{}", uuid::Uuid::new_v4().simple());
    conn.query_drop(format!("CREATE DATABASE {}", esc_id(&database)))
        .await
        .unwrap();
    let table = format!("{}.items", esc_id(&database));
    conn.query_drop(format!("CREATE TABLE {table} (tenant INT NOT NULL, id INT NOT NULL, name VARCHAR(100), value INT NOT NULL, PRIMARY KEY(tenant,id)) ENGINE=InnoDB")).await.unwrap();
    let values = (1..=1100)
        .map(|id| format!("(1,{id},'before',0)"))
        .collect::<Vec<_>>()
        .join(",");
    conn.query_drop(format!("INSERT INTO {table} VALUES {values}"))
        .await
        .unwrap();
    let (_, before): (String, u64) = conn
        .query_first("SHOW GLOBAL STATUS LIKE 'Com_update_multi'")
        .await
        .unwrap()
        .unwrap();
    let rows = (1..=1100)
        .map(|id| {
            row(
                &[("tenant", json!(1)), ("id", json!(id))],
                &[("value", json!(id))],
            )
        })
        .collect();
    assert_eq!(
        mysql_batch_update_rows(&pool, &database, "items", rows)
            .await
            .unwrap(),
        1100
    );
    let (_, after): (String, u64) = conn
        .query_first("SHOW GLOBAL STATUS LIKE 'Com_update_multi'")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        after - before,
        9,
        "1100 rows must execute only nine set-based UPDATEs"
    );
    let wrong: u64 = conn
        .query_first(format!("SELECT COUNT(*) FROM {table} WHERE value <> id"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(wrong, 0);

    let rows = vec![
        row(
            &[("tenant", json!(1)), ("id", json!(1))],
            &[("name", JsonValue::Null)],
        ),
        row(
            &[("tenant", json!(1)), ("id", json!(2))],
            &[("value", json!(22))],
        ),
    ];
    assert_eq!(
        mysql_batch_update_rows(&pool, &database, "items", rows)
            .await
            .unwrap(),
        2
    );
    let first: (Option<String>, i32) = conn
        .query_first(format!(
            "SELECT name, value FROM {table} WHERE tenant=1 AND id=1"
        ))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first, (None, 1));

    let duplicate = vec![
        row(
            &[("tenant", json!(1)), ("id", json!(1))],
            &[("name", json!("wrong"))],
        ),
        row(
            &[("tenant", json!("01")), ("id", json!("01"))],
            &[("value", json!(99))],
        ),
    ];
    assert!(
        mysql_batch_update_rows(&pool, &database, "items", duplicate)
            .await
            .unwrap_err()
            .contains("重复")
    );
    let unchanged: Option<String> = conn
        .query_first(format!("SELECT name FROM {table} WHERE tenant=1 AND id=1"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(unchanged, None);

    // 第二块 NOT NULL 失败，第一块已经执行也必须回滚。
    let rows = (1..=130)
        .map(|id| {
            row(
                &[("tenant", json!(1)), ("id", json!(id))],
                &[(
                    "value",
                    if id == 130 {
                        JsonValue::Null
                    } else {
                        json!(999)
                    },
                )],
            )
        })
        .collect();
    assert!(mysql_batch_update_rows(&pool, &database, "items", rows)
        .await
        .unwrap_err()
        .contains("回滚"));
    let still_before: i32 = conn
        .query_first(format!("SELECT value FROM {table} WHERE tenant=1 AND id=1"))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(still_before, 1);

    // 同时改两个主键列和普通列，所有值必须按原定位键计算。
    let rows = vec![
        row(
            &[("tenant", json!(1)), ("id", json!(1))],
            &[
                ("tenant", json!(2)),
                ("id", json!(2001)),
                ("value", json!(71)),
            ],
        ),
        row(
            &[("tenant", json!(1)), ("id", json!(2))],
            &[
                ("tenant", json!(2)),
                ("id", json!(2002)),
                ("value", json!(72)),
            ],
        ),
    ];
    assert_eq!(
        mysql_batch_update_rows(&pool, &database, "items", rows)
            .await
            .unwrap(),
        2
    );
    let moved: Vec<(i32, i32, i32)> = conn
        .query(format!(
            "SELECT tenant,id,value FROM {table} WHERE tenant=2 ORDER BY id"
        ))
        .await
        .unwrap();
    assert_eq!(moved, vec![(2, 2001, 71), (2, 2002, 72)]);
    conn.query_drop(format!("DROP DATABASE {}", esc_id(&database)))
        .await
        .unwrap();
    drop(conn);
    pool.disconnect().await.unwrap();
}
