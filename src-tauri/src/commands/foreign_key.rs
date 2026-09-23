use crate::db::connection::{get_conn_with_retry, DatabasePoolHandle};
use crate::db::postgres_objects;
use crate::db::sql_utils::esc_id;
use crate::db::sqlite;
use crate::db::sqlserver_objects;
use crate::models::types::{
    AddForeignKeyRequest, ForeignKeyInfo, SqlCompletionForeignKey, SqlCompletionForeignKeyResult,
};
use crate::AppState;
use mysql_async::prelude::*;
use std::collections::{BTreeMap, HashMap};
use tauri::State;

const SQLITE_FOREIGN_KEY_WRITE_UNSUPPORTED: &str =
    "SQLite 暂不支持通过当前入口新增或删除外键，请通过重建表结构完成该操作";

#[derive(Debug, Clone)]
struct FkAgg {
    constraint_name: String,
    table_schema: String,
    table_name: String,
    referenced_table_schema: String,
    referenced_table_name: String,
    cols: Vec<(u64, String, String)>,
    update_rule: String,
    delete_rule: String,
}

fn ordinal_as_u64(row: &mysql_async::Row) -> u64 {
    row.get::<Option<u64>, _>("ORDINAL_POSITION")
        .flatten()
        .or_else(|| {
            row.get::<Option<i64>, _>("ORDINAL_POSITION")
                .flatten()
                .filter(|&i| i >= 0)
                .map(|i| i as u64)
        })
        .unwrap_or(0)
}

/// 列出与指定表相关的外键：本表作为子表 (outgoing) 或作为父表被引用 (incoming)
#[tauri::command]
pub async fn list_foreign_keys(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<Vec<ForeignKeyInfo>, String> {
    if database.is_empty() || table.is_empty() {
        return Err("数据库名与表名不能为空".to_string());
    }

    let pool = {
        let mut manager = state.connection_manager.lock().await;
        match manager.get_database_pool_and_touch(&conn_id)? {
            DatabasePoolHandle::MySql(pool) => pool,
            DatabasePoolHandle::Postgres(handle) => {
                return postgres_objects::list_foreign_keys(&handle.pool, &database, &table).await;
            }
            DatabasePoolHandle::Sqlite(handle) => {
                return sqlite::list_foreign_keys(&handle.pool, &database, &table).await;
            }
            DatabasePoolHandle::SqlServer(handle) => {
                return sqlserver_objects::list_foreign_keys(&handle.pool, &database, &table).await;
            }
            DatabasePoolHandle::ClickHouse(_) => {
                return Err(DatabasePoolHandle::clickhouse_unsupported_error());
            }
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let sql = r#"
SELECT
  kcu.CONSTRAINT_SCHEMA,
  kcu.CONSTRAINT_NAME,
  kcu.TABLE_SCHEMA,
  kcu.TABLE_NAME,
  kcu.COLUMN_NAME,
  kcu.ORDINAL_POSITION,
  kcu.REFERENCED_TABLE_SCHEMA,
  kcu.REFERENCED_TABLE_NAME,
  kcu.REFERENCED_COLUMN_NAME,
  rc.UPDATE_RULE,
  rc.DELETE_RULE
FROM information_schema.KEY_COLUMN_USAGE kcu
INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
  ON kcu.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA
  AND kcu.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
WHERE kcu.REFERENCED_TABLE_NAME IS NOT NULL
  AND (
    (kcu.TABLE_SCHEMA = ? AND kcu.TABLE_NAME = ?)
    OR
    (kcu.REFERENCED_TABLE_SCHEMA = ? AND kcu.REFERENCED_TABLE_NAME = ?)
  )
ORDER BY kcu.CONSTRAINT_SCHEMA, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
"#;

    let rows: Vec<mysql_async::Row> = conn
        .exec(
            sql,
            (
                database.clone(),
                table.clone(),
                database.clone(),
                table.clone(),
            ),
        )
        .await
        .map_err(|e| format!("查询外键信息失败: {}", e))?;

    let mut map: HashMap<(String, String), FkAgg> = HashMap::new();

    for row in rows {
        let constraint_schema: String = row
            .get::<Option<String>, _>("CONSTRAINT_SCHEMA")
            .flatten()
            .unwrap_or_default();
        let constraint_name: String = row
            .get::<Option<String>, _>("CONSTRAINT_NAME")
            .flatten()
            .unwrap_or_default();
        let table_schema: String = row
            .get::<Option<String>, _>("TABLE_SCHEMA")
            .flatten()
            .unwrap_or_default();
        let table_name: String = row
            .get::<Option<String>, _>("TABLE_NAME")
            .flatten()
            .unwrap_or_default();
        let column: String = row
            .get::<Option<String>, _>("COLUMN_NAME")
            .flatten()
            .unwrap_or_default();
        let ord = ordinal_as_u64(&row);
        let ref_schema: String = row
            .get::<Option<String>, _>("REFERENCED_TABLE_SCHEMA")
            .flatten()
            .unwrap_or_default();
        let ref_table: String = row
            .get::<Option<String>, _>("REFERENCED_TABLE_NAME")
            .flatten()
            .unwrap_or_default();
        let ref_col: String = row
            .get::<Option<String>, _>("REFERENCED_COLUMN_NAME")
            .flatten()
            .unwrap_or_default();
        let update_rule: String = row
            .get::<Option<String>, _>("UPDATE_RULE")
            .flatten()
            .unwrap_or_default();
        let delete_rule: String = row
            .get::<Option<String>, _>("DELETE_RULE")
            .flatten()
            .unwrap_or_default();

        let key = (constraint_schema, constraint_name.clone());
        map.entry(key)
            .and_modify(|agg| {
                agg.cols.push((ord, column.clone(), ref_col.clone()));
            })
            .or_insert_with(|| FkAgg {
                constraint_name,
                table_schema: table_schema.clone(),
                table_name: table_name.clone(),
                referenced_table_schema: ref_schema.clone(),
                referenced_table_name: ref_table.clone(),
                cols: vec![(ord, column, ref_col)],
                update_rule,
                delete_rule,
            });
    }

    let mut result: Vec<ForeignKeyInfo> = map
        .into_values()
        .map(|mut agg| {
            agg.cols.sort_by_key(|(o, _, _)| *o);
            let column_names: Vec<String> = agg.cols.iter().map(|(_, c, _)| c.clone()).collect();
            let referenced_column_names: Vec<String> =
                agg.cols.iter().map(|(_, _, r)| r.clone()).collect();
            let direction = if agg.table_schema == database && agg.table_name == table {
                "outgoing".to_string()
            } else {
                "incoming".to_string()
            };
            ForeignKeyInfo {
                constraint_name: agg.constraint_name,
                direction,
                table_schema: agg.table_schema,
                table_name: agg.table_name,
                column_names,
                referenced_table_schema: agg.referenced_table_schema,
                referenced_table_name: agg.referenced_table_name,
                referenced_column_names,
                update_rule: agg.update_rule,
                delete_rule: agg.delete_rule,
            }
        })
        .collect();

    result.sort_by(|a, b| {
        a.direction
            .cmp(&b.direction)
            .then_with(|| a.constraint_name.cmp(&b.constraint_name))
    });

    Ok(result)
}

#[derive(Debug)]
struct MysqlCompletionForeignKeyRow {
    constraint_schema: String,
    constraint_name: String,
    table_namespace: String,
    table_name: String,
    column: String,
    ordinal: u64,
    referenced_namespace: String,
    referenced_table: String,
    referenced_column: String,
}

impl MysqlCompletionForeignKeyRow {
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    fn new(
        constraint_schema: &str,
        constraint_name: &str,
        table_namespace: &str,
        table_name: &str,
        column: &str,
        ordinal: u64,
        referenced_namespace: &str,
        referenced_table: &str,
        referenced_column: &str,
    ) -> Self {
        Self {
            constraint_schema: constraint_schema.into(),
            constraint_name: constraint_name.into(),
            table_namespace: table_namespace.into(),
            table_name: table_name.into(),
            column: column.into(),
            ordinal,
            referenced_namespace: referenced_namespace.into(),
            referenced_table: referenced_table.into(),
            referenced_column: referenced_column.into(),
        }
    }
}

fn aggregate_mysql_completion_foreign_key_rows(
    rows: Vec<MysqlCompletionForeignKeyRow>,
) -> Vec<SqlCompletionForeignKey> {
    let mut groups: BTreeMap<(String, String, String, String), Vec<MysqlCompletionForeignKeyRow>> =
        BTreeMap::new();
    for row in rows {
        groups
            .entry((
                row.constraint_schema.clone(),
                row.table_namespace.clone(),
                row.table_name.clone(),
                row.constraint_name.clone(),
            ))
            .or_default()
            .push(row);
    }

    groups
        .into_values()
        .filter_map(|mut rows| {
            rows.sort_by_key(|row| row.ordinal);
            let first = rows.first()?;
            if rows.iter().any(|row| {
                row.ordinal == 0
                    || row.constraint_schema.is_empty()
                    || row.constraint_name.is_empty()
                    || row.table_namespace.is_empty()
                    || row.table_name.is_empty()
                    || row.column.is_empty()
                    || row.referenced_column.is_empty()
                    || row.referenced_namespace.is_empty()
                    || row.referenced_table.is_empty()
                    || row.referenced_namespace != first.referenced_namespace
                    || row.referenced_table != first.referenced_table
            }) || rows
                .windows(2)
                .any(|pair| pair[0].ordinal == pair[1].ordinal)
            {
                return None;
            }
            Some(SqlCompletionForeignKey {
                id: format!(
                    "mysql:{}",
                    serde_json::json!([
                        first.constraint_schema,
                        first.table_namespace,
                        first.table_name,
                        first.constraint_name
                    ])
                ),
                constraint_name: first.constraint_name.clone(),
                table_namespace: first.table_namespace.clone(),
                table_name: first.table_name.clone(),
                columns: rows.iter().map(|row| row.column.clone()).collect(),
                referenced_namespace: first.referenced_namespace.clone(),
                referenced_table: first.referenced_table.clone(),
                referenced_columns: rows
                    .iter()
                    .map(|row| row.referenced_column.clone())
                    .collect(),
            })
        })
        .collect()
}

fn mysql_completion_text(value: Option<mysql_async::Value>) -> String {
    value
        .and_then(|value| mysql_async::from_value_opt::<Option<String>>(value).ok())
        .flatten()
        .unwrap_or_default()
}

/// 一次性读取与所选 MySQL 库相邻的全部外键约束。
pub async fn list_sql_completion_foreign_keys(
    pool: &mysql_async::Pool,
    namespace: &str,
) -> Result<Vec<SqlCompletionForeignKey>, String> {
    let mut conn = get_conn_with_retry(pool).await?;
    let rows: Vec<mysql_async::Row> = conn
        .exec(
            r#"SELECT kcu.CONSTRAINT_SCHEMA, kcu.CONSTRAINT_NAME,
                      kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME,
                      kcu.ORDINAL_POSITION, kcu.REFERENCED_TABLE_SCHEMA,
                      kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME
                 FROM information_schema.KEY_COLUMN_USAGE AS kcu
                 JOIN information_schema.REFERENTIAL_CONSTRAINTS AS rc
                   ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
                  AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
                  AND rc.TABLE_NAME = kcu.TABLE_NAME
                WHERE kcu.REFERENCED_TABLE_NAME IS NOT NULL
                  AND (kcu.TABLE_SCHEMA = ? OR kcu.REFERENCED_TABLE_SCHEMA = ?)
                ORDER BY kcu.CONSTRAINT_SCHEMA, kcu.TABLE_SCHEMA,
                         kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION"#,
            (namespace, namespace),
        )
        .await
        .map_err(|e| format!("查询 SQL 补全外键失败: {e}"))?;
    let rows = rows
        .into_iter()
        .map(|row| MysqlCompletionForeignKeyRow {
            constraint_schema: mysql_completion_text(row.get("CONSTRAINT_SCHEMA")),
            constraint_name: mysql_completion_text(row.get("CONSTRAINT_NAME")),
            table_namespace: mysql_completion_text(row.get("TABLE_SCHEMA")),
            table_name: mysql_completion_text(row.get("TABLE_NAME")),
            column: mysql_completion_text(row.get("COLUMN_NAME")),
            ordinal: ordinal_as_u64(&row),
            referenced_namespace: mysql_completion_text(row.get("REFERENCED_TABLE_SCHEMA")),
            referenced_table: mysql_completion_text(row.get("REFERENCED_TABLE_NAME")),
            referenced_column: mysql_completion_text(row.get("REFERENCED_COLUMN_NAME")),
        })
        .collect();
    Ok(aggregate_mysql_completion_foreign_key_rows(rows))
}

/// 批量读取选中 namespace 相邻的真实外键，供 SQL JOIN 显式补全使用。
#[tauri::command]
pub async fn get_sql_completion_foreign_keys(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
) -> Result<SqlCompletionForeignKeyResult, String> {
    let Some(namespace) = database.as_deref().filter(|name| !name.trim().is_empty()) else {
        return Ok(SqlCompletionForeignKeyResult::ready(Vec::new()));
    };
    let handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_and_touch(&conn_id)?
    };
    let foreign_keys = match handle {
        DatabasePoolHandle::MySql(pool) => {
            list_sql_completion_foreign_keys(&pool, namespace).await?
        }
        DatabasePoolHandle::Postgres(handle) => {
            postgres_objects::list_sql_completion_foreign_keys(&handle.pool, namespace).await?
        }
        DatabasePoolHandle::Sqlite(handle) => {
            sqlite::list_sql_completion_foreign_keys(&handle.pool, namespace).await?
        }
        DatabasePoolHandle::SqlServer(handle) => {
            sqlserver_objects::list_sql_completion_foreign_keys(&handle.pool, namespace).await?
        }
        DatabasePoolHandle::ClickHouse(_) => {
            return Ok(SqlCompletionForeignKeyResult::unsupported());
        }
    };
    Ok(SqlCompletionForeignKeyResult::ready(foreign_keys))
}

fn validate_referential_action(rule: &str) -> Result<(), String> {
    let u = rule.to_uppercase();
    match u.as_str() {
        "RESTRICT" | "CASCADE" | "SET NULL" | "NO ACTION" | "SET DEFAULT" => Ok(()),
        _ => Err(format!(
            "无效的引用动作: {}（允许 RESTRICT、CASCADE、SET NULL、NO ACTION、SET DEFAULT）",
            rule
        )),
    }
}

/// 生成 ADD FOREIGN KEY 的 DDL（用于测试与前端预览）
pub fn build_add_foreign_key_sql(
    database: &str,
    table: &str,
    request: &AddForeignKeyRequest,
) -> Result<String, String> {
    if request.constraint_name.trim().is_empty() {
        return Err("约束名不能为空".to_string());
    }
    if request.columns.is_empty() {
        return Err("至少需要一列本地列".to_string());
    }
    if request.referenced_columns.len() != request.columns.len() {
        return Err("本地列与引用列数量必须一致".to_string());
    }
    if request.referenced_table.trim().is_empty() {
        return Err("被引用表不能为空".to_string());
    }
    validate_referential_action(&request.on_update)?;
    validate_referential_action(&request.on_delete)?;

    let cols: Vec<String> = request.columns.iter().map(|c| esc_id(c.trim())).collect();
    let refcols: Vec<String> = request
        .referenced_columns
        .iter()
        .map(|c| esc_id(c.trim()))
        .collect();

    // referenced_table 允许 "db.table" 或仅 "table"（默认当前库）
    let (ref_schema, ref_tbl) = parse_qualified_table(database, &request.referenced_table)?;

    let fk_cols = cols.join(", ");
    let ref_fk_cols = refcols.join(", ");
    let on_up = request.on_update.to_uppercase();
    let on_del = request.on_delete.to_uppercase();

    Ok(format!(
        "ALTER TABLE {}.{} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({}) ON UPDATE {} ON DELETE {}",
        esc_id(database),
        esc_id(table),
        esc_id(request.constraint_name.trim()),
        fk_cols,
        esc_id(&ref_schema),
        esc_id(&ref_tbl),
        ref_fk_cols,
        on_up,
        on_del
    ))
}

/// `name` 为 `table` 或 `otherdb.table`
fn parse_qualified_table(default_db: &str, name: &str) -> Result<(String, String), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("被引用表名无效".to_string());
    }
    if let Some(dot) = name.rfind('.') {
        let (a, b) = name.split_at(dot);
        let b = &b[1..];
        let a = a.trim();
        let b = b.trim();
        if a.is_empty() || b.is_empty() {
            return Err("被引用表限定名格式无效".to_string());
        }
        Ok((a.to_string(), b.to_string()))
    } else {
        Ok((default_db.to_string(), name.to_string()))
    }
}

/// 添加外键（谨慎：会锁表；失败时由 MySQL 返回错误）
#[tauri::command]
pub async fn add_foreign_key(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    request: AddForeignKeyRequest,
) -> Result<(), String> {
    let pool = {
        let mut manager = state.connection_manager.lock().await;
        match manager.get_database_pool_for_write(&conn_id)? {
            DatabasePoolHandle::MySql(pool) => pool,
            DatabasePoolHandle::Postgres(handle) => {
                return postgres_objects::add_foreign_key(
                    &handle.pool,
                    &database,
                    &table,
                    &request,
                )
                .await;
            }
            DatabasePoolHandle::Sqlite(_) => {
                return Err(SQLITE_FOREIGN_KEY_WRITE_UNSUPPORTED.to_string());
            }
            DatabasePoolHandle::SqlServer(handle) => {
                return sqlserver_objects::add_foreign_key(
                    &handle.pool,
                    &database,
                    &table,
                    &request,
                )
                .await;
            }
            DatabasePoolHandle::ClickHouse(_) => {
                return Err(DatabasePoolHandle::clickhouse_write_unsupported_error());
            }
        }
    };

    let sql = build_add_foreign_key_sql(&database, &table, &request)?;
    let mut conn = get_conn_with_retry(&pool).await?;
    conn.query_drop(&sql)
        .await
        .map_err(|e| format!("添加外键失败: {}", e))?;
    Ok(())
}

/// 删除外键（在子表上 DROP FOREIGN KEY）
#[tauri::command]
pub async fn drop_foreign_key(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    constraint_name: String,
) -> Result<(), String> {
    if constraint_name.trim().is_empty() {
        return Err("约束名不能为空".to_string());
    }

    let pool = {
        let mut manager = state.connection_manager.lock().await;
        match manager.get_database_pool_for_write(&conn_id)? {
            DatabasePoolHandle::MySql(pool) => pool,
            DatabasePoolHandle::Postgres(handle) => {
                return postgres_objects::drop_foreign_key(
                    &handle.pool,
                    &database,
                    &table,
                    &constraint_name,
                )
                .await;
            }
            DatabasePoolHandle::Sqlite(_) => {
                return Err(SQLITE_FOREIGN_KEY_WRITE_UNSUPPORTED.to_string());
            }
            DatabasePoolHandle::SqlServer(handle) => {
                return sqlserver_objects::drop_foreign_key(
                    &handle.pool,
                    &database,
                    &table,
                    &constraint_name,
                )
                .await;
            }
            DatabasePoolHandle::ClickHouse(_) => {
                return Err(DatabasePoolHandle::clickhouse_write_unsupported_error());
            }
        }
    };

    let sql = format!(
        "ALTER TABLE {}.{} DROP FOREIGN KEY {}",
        esc_id(&database),
        esc_id(&table),
        esc_id(constraint_name.trim())
    );

    let mut conn = get_conn_with_retry(&pool).await?;
    conn.query_drop(&sql)
        .await
        .map_err(|e| format!("删除外键失败: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_completion_foreign_keys_mysql_nullable_catalog_column_does_not_panic() {
        assert_eq!(mysql_completion_text(Some(mysql_async::Value::NULL)), "");
        assert_eq!(mysql_completion_text(None), "");
        assert_eq!(
            mysql_completion_text(Some(mysql_async::Value::Bytes(b"customer_id".to_vec()))),
            "customer_id"
        );
    }

    #[test]
    fn sql_completion_foreign_keys_mysql_groups_by_child_table_and_preserves_ordinals() {
        let rows = vec![
            MysqlCompletionForeignKeyRow::new(
                "sales",
                "same_fk",
                "sales",
                "orders",
                "customer_id",
                2,
                "auth",
                "users",
                "id",
            ),
            MysqlCompletionForeignKeyRow::new(
                "sales", "same_fk", "sales", "invoices", "payer_id", 1, "auth", "users", "id",
            ),
            MysqlCompletionForeignKeyRow::new(
                "sales",
                "same_fk",
                "sales",
                "orders",
                "tenant_id",
                1,
                "auth",
                "users",
                "tenant_id",
            ),
        ];
        let keys = aggregate_mysql_completion_foreign_key_rows(rows);
        assert_eq!(keys.len(), 2);
        let orders = keys.iter().find(|key| key.table_name == "orders").unwrap();
        assert_eq!(orders.table_namespace, "sales");
        assert_eq!(orders.referenced_namespace, "auth");
        assert_eq!(orders.columns, ["tenant_id", "customer_id"]);
        assert_eq!(orders.referenced_columns, ["tenant_id", "id"]);
        assert_ne!(
            orders.id,
            keys.iter()
                .find(|key| key.table_name == "invoices")
                .unwrap()
                .id
        );
    }

    #[test]
    fn sql_completion_foreign_keys_mysql_rejects_incomplete_column_mapping() {
        let rows = vec![
            MysqlCompletionForeignKeyRow::new(
                "sales",
                "fk",
                "sales",
                "orders",
                "tenant_id",
                1,
                "auth",
                "users",
                "tenant_id",
            ),
            MysqlCompletionForeignKeyRow::new(
                "sales",
                "fk",
                "sales",
                "orders",
                "customer_id",
                2,
                "auth",
                "users",
                "",
            ),
        ];
        assert!(aggregate_mysql_completion_foreign_key_rows(rows).is_empty());
    }
    use crate::models::types::AddForeignKeyRequest;

    #[test]
    fn test_build_add_foreign_key_sql_simple() {
        let req = AddForeignKeyRequest {
            constraint_name: "fk_user".to_string(),
            columns: vec!["user_id".to_string()],
            referenced_table: "users".to_string(),
            referenced_columns: vec!["id".to_string()],
            on_update: "CASCADE".to_string(),
            on_delete: "RESTRICT".to_string(),
        };
        let s = build_add_foreign_key_sql("mydb", "orders", &req).unwrap();
        assert!(s.contains("ADD CONSTRAINT"));
        assert!(s.contains("`fk_user`"));
        assert!(s.contains("FOREIGN KEY (`user_id`)"));
        assert!(s.contains("REFERENCES `mydb`.`users` (`id`)"));
        assert!(s.contains("ON UPDATE CASCADE"));
        assert!(s.contains("ON DELETE RESTRICT"));
    }

    #[test]
    fn test_build_add_foreign_key_qualified_ref() {
        let req = AddForeignKeyRequest {
            constraint_name: "fk_x".to_string(),
            columns: vec!["a".to_string(), "b".to_string()],
            referenced_table: "other.refs".to_string(),
            referenced_columns: vec!["x".to_string(), "y".to_string()],
            on_update: "NO ACTION".to_string(),
            on_delete: "SET NULL".to_string(),
        };
        let s = build_add_foreign_key_sql("db1", "t1", &req).unwrap();
        assert!(s.contains("REFERENCES `other`.`refs` (`x`, `y`)"));
    }

    #[test]
    fn test_validate_referential_action_rejects() {
        assert!(validate_referential_action("BADCASE").is_err());
    }

    #[test]
    fn test_drop_foreign_key_sql_shape() {
        let sql = format!(
            "ALTER TABLE {}.{} DROP FOREIGN KEY {}",
            esc_id("mydb"),
            esc_id("orders"),
            esc_id("fk_o")
        );
        assert_eq!(sql, "ALTER TABLE `mydb`.`orders` DROP FOREIGN KEY `fk_o`");
    }

    #[test]
    fn test_foreign_key_info_serialization() {
        let fk = ForeignKeyInfo {
            constraint_name: "fk1".to_string(),
            direction: "outgoing".to_string(),
            table_schema: "db".to_string(),
            table_name: "child".to_string(),
            column_names: vec!["pid".to_string()],
            referenced_table_schema: "db".to_string(),
            referenced_table_name: "parent".to_string(),
            referenced_column_names: vec!["id".to_string()],
            update_rule: "CASCADE".to_string(),
            delete_rule: "RESTRICT".to_string(),
        };
        let j = serde_json::to_string(&fk).unwrap();
        let d: ForeignKeyInfo = serde_json::from_str(&j).unwrap();
        assert_eq!(d.constraint_name, "fk1");
        assert_eq!(d.direction, "outgoing");
    }
}
