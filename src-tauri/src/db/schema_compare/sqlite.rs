use crate::db::sql_utils::{sqlite_id, sqlite_str};
use crate::models::types::ColumnSnapshot;
use deadpool_sqlite::Pool;

use super::{rows_to_tables, SnapshotRow, TableSnapshot};

pub(crate) fn snapshot_sql(schema: &str) -> String {
    format!(
        "SELECT objects.name AS table_name, columns.name AS column_name, \
                columns.cid + 1 AS ordinal_position, columns.type AS column_type, \
                CASE WHEN columns.\"notnull\" = 0 AND columns.pk = 0 THEN 1 ELSE 0 END AS nullable, \
                columns.dflt_value AS default_value, \
                CASE WHEN columns.pk > 0 THEN 1 ELSE 0 END AS primary_key, \
                CASE \
                  WHEN columns.hidden <> 0 THEN 'generated' \
                  WHEN columns.pk > 0 AND instr(upper(COALESCE(objects.sql, '')), 'AUTOINCREMENT') > 0 THEN 'auto_increment' \
                  ELSE '' \
                END AS extra \
         FROM {}.sqlite_schema objects \
         JOIN pragma_table_xinfo(objects.name, {}) columns \
         WHERE objects.type = 'table' AND objects.name NOT LIKE 'sqlite_%' \
         ORDER BY objects.name, columns.cid, columns.name",
        sqlite_id(schema),
        sqlite_str(schema)
    )
}

pub(crate) async fn load_snapshot(pool: &Pool, schema: &str) -> Result<Vec<TableSnapshot>, String> {
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 对比连接失败: {}", e))?;
    let sql = snapshot_sql(schema);
    conn.interact(move |conn| {
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("查询 SQLite 对比元数据失败: {}", e))?;
        let rows = stmt
            .query_map([], |row| {
                let ordinal_position = row.get::<_, i64>("ordinal_position")?;
                Ok(SnapshotRow {
                    table_name: row.get("table_name")?,
                    column_name: row.get("column_name")?,
                    details: ColumnSnapshot {
                        ordinal_position: u32::try_from(ordinal_position).unwrap_or_default(),
                        column_type: row.get("column_type")?,
                        nullable: row.get::<_, i64>("nullable")? != 0,
                        default_value: row.get("default_value")?,
                        primary_key: row.get::<_, i64>("primary_key")? != 0,
                        extra: row.get("extra")?,
                        comment: String::new(),
                    },
                })
            })
            .map_err(|e| format!("查询 SQLite 对比元数据失败: {}", e))?;
        let mapped = rows
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("查询 SQLite 对比元数据失败: {}", e))?;
        Ok(rows_to_tables(mapped))
    })
    .await
    .map_err(|e| format!("SQLite 对比查询任务失败: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use deadpool_sqlite::{Config as SqliteConfig, Runtime};
    use uuid::Uuid;

    #[tokio::test]
    async fn loads_all_physical_tables_without_per_table_queries() {
        let path =
            std::env::temp_dir().join(format!("db-connect-compare-{}.sqlite", Uuid::new_v4()));
        std::fs::File::create(&path).expect("create sqlite file");
        let pool = SqliteConfig::new(path.to_str().expect("utf8 path"))
            .create_pool(Runtime::Tokio1)
            .expect("create pool");
        let conn = pool.get().await.expect("get connection");
        conn.interact(|conn| {
            conn.execute_batch(
                "CREATE TABLE users (\
                   id INTEGER PRIMARY KEY AUTOINCREMENT,\
                   name TEXT NOT NULL DEFAULT 'anon',\
                   upper_name TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL\
                 );\
                 CREATE TABLE order_items (\
                   order_id INTEGER NOT NULL, item_id INTEGER NOT NULL,\
                   PRIMARY KEY (order_id, item_id)\
                 );\
                 CREATE VIEW user_names AS SELECT name FROM users;",
            )
        })
        .await
        .expect("interact")
        .expect("create schema");
        drop(conn);

        let tables = load_snapshot(&pool, "main").await.expect("load snapshot");
        assert_eq!(
            tables
                .iter()
                .map(|table| table.name.as_str())
                .collect::<Vec<_>>(),
            vec!["order_items", "users"]
        );
        let users = tables.iter().find(|table| table.name == "users").unwrap();
        assert_eq!(users.columns[0].0, "id");
        assert!(users.columns[0].1.primary_key);
        assert_eq!(users.columns[0].1.extra, "auto_increment");
        assert_eq!(users.columns[1].1.default_value.as_deref(), Some("'anon'"));
        assert_eq!(users.columns[2].1.extra, "generated");

        pool.close();
        let _ = std::fs::remove_file(path);
    }
}
