use crate::db::sql_utils::{
    sqlite_count_query, sqlite_id, sqlite_paginated_select, sqlite_str, validate_where_clause,
};
use crate::models::types::{ColumnInfo, ConnectionConfig, QueryResult, TableInfo};
use deadpool_sqlite::{Config as SqliteConfig, Pool, Runtime};
use rusqlite::types::Value as SqliteValue;
use serde_json::Value as JsonValue;
use std::path::Path;
use std::time::Instant;

const JS_MAX_SAFE_INTEGER: i64 = 9007199254740991;
const JS_MIN_SAFE_INTEGER: i64 = -9007199254740991;

#[derive(Clone)]
pub struct SqlitePoolHandle {
    pub pool: Pool,
}

pub fn sqlite_path_from_config(config: &ConnectionConfig) -> Result<String, String> {
    let path = config
        .sqlite_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "SQLite 连接需要选择数据库文件".to_string())?;
    Ok(path.to_string())
}

pub fn build_sqlite_pool(config: &ConnectionConfig) -> Result<SqlitePoolHandle, String> {
    let path = sqlite_path_from_config(config)?;
    if !Path::new(&path).exists() {
        return Err("SQLite 数据库文件不存在".to_string());
    }
    let cfg = SqliteConfig::new(path);
    let pool = cfg
        .create_pool(Runtime::Tokio1)
        .map_err(|e| format!("构造 SQLite 连接池失败: {}", e))?;
    Ok(SqlitePoolHandle { pool })
}

pub async fn test_pool(pool: &Pool) -> Result<(), String> {
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(|conn| {
        conn.query_row("SELECT 1", [], |_row| Ok(()))
            .map_err(|e| format!("查询测试失败: {}", e))
    })
    .await
    .map_err(|e| format!("SQLite 连接任务失败: {}", e))?
}

pub async fn ping_pool(pool: &Pool) -> bool {
    tokio::time::timeout(std::time::Duration::from_secs(3), test_pool(pool))
        .await
        .is_ok_and(|r| r.is_ok())
}

pub async fn list_databases(pool: &Pool) -> Result<Vec<String>, String> {
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(|conn| {
        let mut stmt = conn
            .prepare("PRAGMA database_list")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("SQLite 查询任务失败: {}", e))?
}

pub async fn list_tables(pool: &Pool, database: &str) -> Result<Vec<TableInfo>, String> {
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    let internal_table_pattern = sqlite_str("sqlite_%");
    let sql = format!(
        "SELECT name, \
                CASE WHEN type = 'view' THEN 'VIEW' ELSE 'TABLE' END AS table_type, \
                type, \
                sql \
         FROM {}.sqlite_schema \
         WHERE type IN ('table', 'view') \
           AND name NOT LIKE {} \
         ORDER BY name",
        sqlite_id(database),
        internal_table_pattern
    );

    conn.interact(move |conn| {
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                let table_type: String = row.get("table_type")?;
                let object_type: String = row.get("type")?;
                Ok(TableInfo {
                    name: row.get("name")?,
                    table_type,
                    engine: if object_type == "table" {
                        Some("SQLite".to_string())
                    } else {
                        None
                    },
                    rows: None,
                    data_length: None,
                    index_length: None,
                    comment: String::new(),
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("SQLite 查询任务失败: {}", e))?
}

pub async fn get_table_structure(
    pool: &Pool,
    database: &str,
    table: &str,
) -> Result<Vec<ColumnInfo>, String> {
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    let database = database.to_string();
    let table = table.to_string();

    conn.interact(move |conn| {
        let mut stmt = conn
            .prepare(
                "SELECT name, \
                        type, \
                        \"notnull\", \
                        dflt_value, \
                        pk, \
                        hidden \
                 FROM pragma_table_xinfo(?1, ?2) \
                 ORDER BY cid",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([table.as_str(), database.as_str()], |row| {
                let notnull: i64 = row.get("notnull")?;
                let pk: i64 = row.get("pk")?;
                let hidden: i64 = row.get("hidden")?;
                Ok(ColumnInfo {
                    name: row.get("name")?,
                    column_type: row.get("type")?,
                    nullable: notnull == 0 && pk == 0,
                    key: if pk > 0 {
                        "PRI".to_string()
                    } else {
                        String::new()
                    },
                    default_value: row.get("dflt_value")?,
                    extra: if hidden != 0 {
                        "generated".to_string()
                    } else {
                        String::new()
                    },
                    comment: String::new(),
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("SQLite 查询任务失败: {}", e))?
}

pub fn sqlite_value_to_json(value: &SqliteValue) -> JsonValue {
    match value {
        SqliteValue::Null => JsonValue::Null,
        SqliteValue::Integer(i) => {
            if (JS_MIN_SAFE_INTEGER..=JS_MAX_SAFE_INTEGER).contains(i) {
                serde_json::json!(*i)
            } else {
                JsonValue::String(i.to_string())
            }
        }
        SqliteValue::Real(n) => serde_json::json!(*n),
        SqliteValue::Text(s) => JsonValue::String(s.clone()),
        SqliteValue::Blob(bytes) => JsonValue::String(format!("[binary {} bytes]", bytes.len())),
    }
}

pub fn build_order_by_sql(fields: &[(&str, &str)]) -> String {
    if fields.is_empty() {
        return String::new();
    }
    let mut parts = Vec::new();
    for (column, order) in fields {
        let col = column.trim();
        if col.is_empty() {
            continue;
        }
        let safe_order = if order.to_uppercase() == "DESC" {
            "DESC"
        } else {
            "ASC"
        };
        parts.push(format!("{} {}", sqlite_id(col), safe_order));
    }
    if parts.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", parts.join(", "))
    }
}

pub async fn query_table_count(
    pool: &Pool,
    database: &str,
    table: &str,
    where_clause: Option<String>,
) -> Result<u64, String> {
    let where_sql = build_where_sql(&where_clause)?;
    let count_sql = sqlite_count_query(database, table, &where_sql);
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(move |conn| {
        let count = conn
            .query_row(&count_sql, [], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        Ok(i64_to_u64(count))
    })
    .await
    .map_err(|e| format!("SQLite 查询任务失败: {}", e))?
}

#[allow(clippy::too_many_arguments)]
pub async fn query_table_data(
    pool: &Pool,
    database: &str,
    table: &str,
    page: u32,
    page_size: u32,
    order_sql: String,
    where_clause: Option<String>,
    select_columns: Option<Vec<String>>,
    skip_count: Option<bool>,
) -> Result<QueryResult, String> {
    let start = Instant::now();
    let where_sql = build_where_sql(&where_clause)?;
    let select_part = build_select_part(&select_columns);
    let offset = (page.saturating_sub(1) as u64) * page_size as u64;
    let count_sql = sqlite_count_query(database, table, &where_sql);
    let data_sql = sqlite_paginated_select(
        &select_part,
        database,
        table,
        &where_sql,
        &order_sql,
        page_size as u64,
        offset,
    );

    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    let (columns, rows, total) = conn
        .interact(move |conn| {
            let total = if skip_count == Some(true) {
                0
            } else {
                let count = conn
                    .query_row(&count_sql, [], |row| row.get::<_, i64>(0))
                    .map_err(|e| e.to_string())?;
                i64_to_u64(count)
            };

            let mut stmt = conn.prepare(&data_sql).map_err(|e| e.to_string())?;
            let columns = stmt
                .column_names()
                .iter()
                .map(|name| (*name).to_string())
                .collect::<Vec<_>>();
            let col_count = stmt.column_count();
            let row_iter = stmt
                .query_map([], |row| {
                    let mut values = Vec::with_capacity(col_count);
                    for idx in 0..col_count {
                        let value: SqliteValue = row.get(idx)?;
                        values.push(sqlite_value_to_json(&value));
                    }
                    Ok(values)
                })
                .map_err(|e| e.to_string())?;
            let mut rows = Vec::new();
            for row in row_iter {
                rows.push(row.map_err(|e| e.to_string())?);
            }
            Ok::<(Vec<String>, Vec<Vec<JsonValue>>, u64), String>((columns, rows, total))
        })
        .await
        .map_err(|e| format!("SQLite 查询任务失败: {}", e))??;

    Ok(QueryResult {
        columns,
        rows,
        total,
        execution_time_ms: start.elapsed().as_millis() as u64,
    })
}

fn build_where_sql(where_clause: &Option<String>) -> Result<String, String> {
    match where_clause {
        Some(w) if !w.trim().is_empty() => {
            validate_where_clause(w)?;
            Ok(format!(" WHERE {}", w))
        }
        _ => Ok(String::new()),
    }
}

fn build_select_part(select_columns: &Option<Vec<String>>) -> String {
    match select_columns {
        Some(cols) if !cols.is_empty() => {
            let columns = cols
                .iter()
                .map(|c| c.trim())
                .filter(|c| !c.is_empty())
                .map(sqlite_id)
                .collect::<Vec<_>>();
            if columns.is_empty() {
                "*".to_string()
            } else {
                columns.join(", ")
            }
        }
        _ => "*".to_string(),
    }
}

fn i64_to_u64(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::types::Value as SqliteValue;
    use serde_json::Value as JsonValue;
    use std::fs;
    use std::path::PathBuf;
    use uuid::Uuid;

    async fn test_pool_with_schema() -> (Pool, PathBuf) {
        let path = std::env::temp_dir().join(format!("db-connect-{}.sqlite", Uuid::new_v4()));
        fs::File::create(&path).expect("create sqlite test file");
        let cfg = SqliteConfig::new(path.to_str().expect("utf8 sqlite path"));
        let pool = cfg.create_pool(Runtime::Tokio1).expect("create sqlite pool");
        let conn = pool.get().await.expect("get sqlite connection");
        conn.interact(|conn| {
            conn.execute_batch(
                "CREATE TABLE users (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL DEFAULT 'anon',
                    age INTEGER,
                    big INTEGER,
                    payload BLOB,
                    upper_name TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL
                );
                INSERT INTO users (id, name, age, big, payload)
                VALUES
                    (1, 'Alice', 30, 9007199254740992, X'000102'),
                    (2, 'Bob', 20, 42, X'FF');
                CREATE VIEW adult_users AS
                    SELECT id, name FROM users WHERE age >= 18;",
            )
            .map_err(|e| e.to_string())
        })
        .await
        .expect("sqlite interact")
        .expect("seed sqlite schema");
        drop(conn);
        (pool, path)
    }

    #[tokio::test]
    async fn sqlite_metadata_lists_databases_tables_and_columns() {
        let (pool, path) = test_pool_with_schema().await;

        let databases = list_databases(&pool).await.expect("list databases");
        assert_eq!(databases, vec!["main"]);

        let tables = list_tables(&pool, "main").await.expect("list tables");
        let users = tables.iter().find(|t| t.name == "users").expect("users table");
        assert_eq!(users.table_type, "TABLE");
        assert_eq!(users.engine.as_deref(), Some("SQLite"));
        assert_eq!(users.rows, None);
        assert_eq!(users.data_length, None);
        assert_eq!(users.index_length, None);
        assert_eq!(users.comment, "");

        let view = tables
            .iter()
            .find(|t| t.name == "adult_users")
            .expect("adult_users view");
        assert_eq!(view.table_type, "VIEW");
        assert_eq!(view.engine, None);

        let columns = get_table_structure(&pool, "main", "users")
            .await
            .expect("get table structure");
        let id = columns.iter().find(|c| c.name == "id").expect("id column");
        assert_eq!(id.column_type, "INTEGER");
        assert!(!id.nullable);
        assert_eq!(id.key, "PRI");

        let name = columns
            .iter()
            .find(|c| c.name == "name")
            .expect("name column");
        assert_eq!(name.column_type, "TEXT");
        assert!(!name.nullable);
        assert_eq!(name.default_value.as_deref(), Some("'anon'"));

        let generated = columns
            .iter()
            .find(|c| c.name == "upper_name")
            .expect("generated column");
        assert_eq!(generated.extra, "generated");

        let _ = fs::remove_file(path);
    }

    #[tokio::test]
    async fn sqlite_data_queries_count_page_sort_and_convert_values() {
        let (pool, path) = test_pool_with_schema().await;

        let count = query_table_count(
            &pool,
            "main",
            "users",
            Some("\"age\" >= 20".to_string()),
        )
        .await
        .expect("query count");
        assert_eq!(count, 2);

        let order_sql = build_order_by_sql(&[("age", "DESC"), ("name", "invalid")]);
        assert_eq!(order_sql, " ORDER BY \"age\" DESC, \"name\" ASC");

        let result = query_table_data(
            &pool,
            "main",
            "users",
            1,
            1,
            order_sql,
            Some("\"age\" >= 20".to_string()),
            Some(vec![
                "name".to_string(),
                "big".to_string(),
                "payload".to_string(),
            ]),
            Some(false),
        )
        .await
        .expect("query data");

        assert_eq!(result.columns, vec!["name", "big", "payload"]);
        assert_eq!(result.total, 2);
        assert_eq!(result.rows.len(), 1);
        assert_eq!(result.rows[0][0], JsonValue::String("Alice".to_string()));
        assert_eq!(
            result.rows[0][1],
            JsonValue::String("9007199254740992".to_string())
        );
        assert_eq!(
            result.rows[0][2],
            JsonValue::String("[binary 3 bytes]".to_string())
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn sqlite_value_to_json_preserves_large_integers_and_binary_display() {
        assert_eq!(
            sqlite_value_to_json(&SqliteValue::Integer(9_007_199_254_740_992)),
            JsonValue::String("9007199254740992".to_string())
        );
        assert_eq!(
            sqlite_value_to_json(&SqliteValue::Blob(vec![1, 2, 3, 4])),
            JsonValue::String("[binary 4 bytes]".to_string())
        );
    }
}
