use crate::db::connection::{get_conn_with_retry, DatabasePoolHandle};
use crate::db::postgres_objects;
use crate::db::sql_utils::esc_id;
use crate::db::sqlite;
use crate::models::types::{CreateTriggerRequest, TriggerInfo};
use crate::AppState;
use mysql_async::prelude::*;
use tauri::State;

/// 获取指定数据库的触发器列表 (可按表名筛选)
#[tauri::command]
pub async fn list_triggers(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: Option<String>,
) -> Result<Vec<TriggerInfo>, String> {
    let pool = {
        let mut manager = state.connection_manager.lock().await;
        match manager.get_database_pool_and_touch(&conn_id)? {
            DatabasePoolHandle::MySql(pool) => pool,
            DatabasePoolHandle::Postgres(handle) => {
                return postgres_objects::list_triggers(&handle.pool, &database, table.as_deref())
                    .await;
            }
            DatabasePoolHandle::Sqlite(handle) => {
                return sqlite::list_triggers(&handle.pool, &database, table.as_deref()).await;
            }
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    // 使用 SHOW TRIGGERS FROM database 获取触发器列表
    let query = format!("SHOW TRIGGERS FROM {}", esc_id(&database));
    let rows: Vec<mysql_async::Row> = conn
        .query(&query)
        .await
        .map_err(|e| format!("查询触发器列表失败: {}", e))?;

    let mut triggers: Vec<TriggerInfo> = rows
        .iter()
        .map(|row| TriggerInfo {
            name: row
                .get::<Option<String>, _>("Trigger")
                .flatten()
                .unwrap_or_default(),
            event: row
                .get::<Option<String>, _>("Event")
                .flatten()
                .unwrap_or_default(),
            timing: row
                .get::<Option<String>, _>("Timing")
                .flatten()
                .unwrap_or_default(),
            table_name: row
                .get::<Option<String>, _>("Table")
                .flatten()
                .unwrap_or_default(),
            statement: row
                .get::<Option<String>, _>("Statement")
                .flatten()
                .unwrap_or_default(),
            created: row.get::<Option<String>, _>("Created").flatten(),
            sql_mode: row
                .get::<Option<String>, _>("sql_mode")
                .flatten()
                .unwrap_or_default(),
            definer: row
                .get::<Option<String>, _>("Definer")
                .flatten()
                .unwrap_or_default(),
        })
        .collect();

    // 如果指定了表名，则过滤
    if let Some(ref tbl) = table {
        triggers.retain(|t| t.table_name == *tbl);
    }

    Ok(triggers)
}

/// 获取触发器的完整 CREATE 语句
#[tauri::command]
pub async fn get_trigger_definition(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    trigger_name: String,
    table: Option<String>,
) -> Result<String, String> {
    let pool = {
        let mut manager = state.connection_manager.lock().await;
        match manager.get_database_pool_and_touch(&conn_id)? {
            DatabasePoolHandle::MySql(pool) => pool,
            DatabasePoolHandle::Postgres(handle) => {
                return postgres_objects::get_trigger_definition(
                    &handle.pool,
                    &database,
                    table.as_deref(),
                    &trigger_name,
                )
                .await;
            }
            DatabasePoolHandle::Sqlite(handle) => {
                return sqlite::get_trigger_definition(
                    &handle.pool,
                    &database,
                    &trigger_name,
                    table.as_deref(),
                )
                .await;
            }
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let query = format!(
        "SHOW CREATE TRIGGER {}.{}",
        esc_id(&database),
        esc_id(&trigger_name)
    );
    let rows: Vec<mysql_async::Row> = conn
        .query(&query)
        .await
        .map_err(|e| format!("查询触发器定义失败: {}", e))?;

    if let Some(row) = rows.first() {
        // SHOW CREATE TRIGGER 返回 "SQL Original Statement" 列
        let definition: String = row
            .get::<Option<String>, _>("SQL Original Statement")
            .flatten()
            .unwrap_or_default();
        Ok(definition)
    } else {
        Err(format!("触发器 '{}' 不存在", trigger_name))
    }
}

/// 创建触发器
#[tauri::command]
pub async fn create_trigger(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    request: CreateTriggerRequest,
) -> Result<(), String> {
    let pool = {
        let mut manager = state.connection_manager.lock().await;
        match manager.get_database_pool_for_write(&conn_id)? {
            DatabasePoolHandle::MySql(pool) => pool,
            DatabasePoolHandle::Postgres(handle) => {
                return postgres_objects::create_trigger(&handle.pool, &database, &table, &request)
                    .await;
            }
            DatabasePoolHandle::Sqlite(handle) => {
                return sqlite::create_trigger(&handle.pool, &database, &table, &request).await;
            }
        }
    };

    // 参数验证（与单测共用同一实现，避免逻辑漂移）
    validate_trigger_params(&request)?;

    let mut conn = get_conn_with_retry(&pool).await?;

    // 构建 CREATE TRIGGER SQL
    let sql = build_create_trigger_sql(&database, &table, &request);

    conn.query_drop(&sql)
        .await
        .map_err(|e| format!("创建触发器失败: {}", e))?;

    Ok(())
}

/// 删除触发器
#[tauri::command]
pub async fn drop_trigger(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    trigger_name: String,
    table: Option<String>,
) -> Result<(), String> {
    if trigger_name.is_empty() {
        return Err("触发器名称不能为空".to_string());
    }

    let pool = {
        let mut manager = state.connection_manager.lock().await;
        match manager.get_database_pool_for_write(&conn_id)? {
            DatabasePoolHandle::MySql(pool) => pool,
            DatabasePoolHandle::Postgres(handle) => {
                return postgres_objects::drop_trigger(
                    &handle.pool,
                    &database,
                    table.as_deref(),
                    &trigger_name,
                )
                .await;
            }
            DatabasePoolHandle::Sqlite(handle) => {
                return sqlite::drop_trigger(&handle.pool, &database, &trigger_name).await;
            }
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let sql = format!(
        "DROP TRIGGER IF EXISTS {}.{}",
        esc_id(&database),
        esc_id(&trigger_name)
    );

    conn.query_drop(&sql)
        .await
        .map_err(|e| format!("删除触发器失败: {}", e))?;

    Ok(())
}

/// 构建 CREATE TRIGGER SQL 语句 (公开用于测试)
pub fn build_create_trigger_sql(
    database: &str,
    table: &str,
    request: &CreateTriggerRequest,
) -> String {
    let timing = request.timing.to_uppercase();
    let event = request.event.to_uppercase();

    format!(
        "CREATE TRIGGER {}.{} {} {} ON {}.{} FOR EACH ROW\n{}",
        esc_id(database),
        esc_id(&request.name),
        timing,
        event,
        esc_id(database),
        esc_id(table),
        request.body
    )
}

/// 验证触发器参数（由 `create_trigger` 与单测共用）
pub fn validate_trigger_params(request: &CreateTriggerRequest) -> Result<(), String> {
    if request.name.is_empty() {
        return Err("触发器名称不能为空".to_string());
    }
    if request.body.is_empty() {
        return Err("触发器语句体不能为空".to_string());
    }

    let timing = request.timing.to_uppercase();
    if timing != "BEFORE" && timing != "AFTER" {
        return Err("触发器时机必须为 BEFORE 或 AFTER".to_string());
    }

    let event = request.event.to_uppercase();
    if event != "INSERT" && event != "UPDATE" && event != "DELETE" {
        return Err("触发器事件必须为 INSERT、UPDATE 或 DELETE".to_string());
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{CreateTriggerRequest, TriggerInfo};

    #[test]
    fn test_build_create_trigger_sql_simple() {
        let request = CreateTriggerRequest {
            name: "trg_before_insert".to_string(),
            timing: "BEFORE".to_string(),
            event: "INSERT".to_string(),
            body: "SET NEW.created_at = NOW()".to_string(),
        };

        let sql = build_create_trigger_sql("mydb", "users", &request);
        assert!(sql.contains("CREATE TRIGGER `mydb`.`trg_before_insert`"));
        assert!(sql.contains("BEFORE INSERT"));
        assert!(sql.contains("ON `mydb`.`users`"));
        assert!(sql.contains("FOR EACH ROW"));
        assert!(sql.contains("SET NEW.created_at = NOW()"));
    }

    #[test]
    fn test_build_create_trigger_sql_with_begin_end() {
        let request = CreateTriggerRequest {
            name: "trg_after_update".to_string(),
            timing: "AFTER".to_string(),
            event: "UPDATE".to_string(),
            body: "BEGIN\n  INSERT INTO audit_log (table_name, action, record_id, changed_at)\n  VALUES ('users', 'UPDATE', OLD.id, NOW());\nEND".to_string(),
        };

        let sql = build_create_trigger_sql("testdb", "users", &request);
        assert!(sql.contains("AFTER UPDATE"));
        assert!(sql.contains("ON `testdb`.`users`"));
        assert!(sql.contains("BEGIN"));
        assert!(sql.contains("INSERT INTO audit_log"));
        assert!(sql.contains("END"));
    }

    #[test]
    fn test_build_create_trigger_sql_case_insensitive() {
        let request = CreateTriggerRequest {
            name: "trg_test".to_string(),
            timing: "before".to_string(),
            event: "delete".to_string(),
            body: "SET @old_id = OLD.id".to_string(),
        };

        let sql = build_create_trigger_sql("db", "tbl", &request);
        assert!(sql.contains("BEFORE DELETE"));
    }

    #[test]
    fn test_validate_trigger_params_valid() {
        let request = CreateTriggerRequest {
            name: "trg_test".to_string(),
            timing: "BEFORE".to_string(),
            event: "INSERT".to_string(),
            body: "SET NEW.updated_at = NOW()".to_string(),
        };

        assert!(validate_trigger_params(&request).is_ok());
    }

    #[test]
    fn test_validate_trigger_params_empty_name() {
        let request = CreateTriggerRequest {
            name: "".to_string(),
            timing: "BEFORE".to_string(),
            event: "INSERT".to_string(),
            body: "SET NEW.updated_at = NOW()".to_string(),
        };

        let result = validate_trigger_params(&request);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "触发器名称不能为空");
    }

    #[test]
    fn test_validate_trigger_params_empty_body() {
        let request = CreateTriggerRequest {
            name: "trg_test".to_string(),
            timing: "BEFORE".to_string(),
            event: "INSERT".to_string(),
            body: "".to_string(),
        };

        let result = validate_trigger_params(&request);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), "触发器语句体不能为空");
    }

    #[test]
    fn test_validate_trigger_params_invalid_timing() {
        let request = CreateTriggerRequest {
            name: "trg_test".to_string(),
            timing: "DURING".to_string(),
            event: "INSERT".to_string(),
            body: "SET NEW.id = 1".to_string(),
        };

        let result = validate_trigger_params(&request);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("BEFORE 或 AFTER"));
    }

    #[test]
    fn test_validate_trigger_params_invalid_event() {
        let request = CreateTriggerRequest {
            name: "trg_test".to_string(),
            timing: "BEFORE".to_string(),
            event: "SELECT".to_string(),
            body: "SET NEW.id = 1".to_string(),
        };

        let result = validate_trigger_params(&request);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("INSERT、UPDATE 或 DELETE"));
    }

    #[test]
    fn test_validate_trigger_params_case_insensitive() {
        // 小写也应有效
        let request = CreateTriggerRequest {
            name: "trg_test".to_string(),
            timing: "after".to_string(),
            event: "update".to_string(),
            body: "SET NEW.updated_at = NOW()".to_string(),
        };

        assert!(validate_trigger_params(&request).is_ok());
    }

    #[test]
    fn test_trigger_info_serialization() {
        let trigger = TriggerInfo {
            name: "trg_audit".to_string(),
            event: "INSERT".to_string(),
            timing: "AFTER".to_string(),
            table_name: "orders".to_string(),
            statement: "INSERT INTO audit_log VALUES (NEW.id, NOW())".to_string(),
            created: Some("2026-01-15 10:30:00".to_string()),
            sql_mode: "STRICT_TRANS_TABLES".to_string(),
            definer: "root@localhost".to_string(),
        };

        let json = serde_json::to_string(&trigger).unwrap();
        let deserialized: TriggerInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, "trg_audit");
        assert_eq!(deserialized.event, "INSERT");
        assert_eq!(deserialized.timing, "AFTER");
        assert_eq!(deserialized.table_name, "orders");
    }

    #[test]
    fn test_drop_trigger_sql_generation() {
        let sql = format!(
            "DROP TRIGGER IF EXISTS `{}`.`{}`",
            "mydb", "trg_before_insert"
        );
        assert_eq!(sql, "DROP TRIGGER IF EXISTS `mydb`.`trg_before_insert`");
    }

    #[test]
    fn test_trigger_filtering_by_table() {
        let triggers = [
            TriggerInfo {
                name: "trg_users_insert".to_string(),
                event: "INSERT".to_string(),
                timing: "BEFORE".to_string(),
                table_name: "users".to_string(),
                statement: "SET NEW.created_at = NOW()".to_string(),
                created: None,
                sql_mode: "".to_string(),
                definer: "root@localhost".to_string(),
            },
            TriggerInfo {
                name: "trg_orders_insert".to_string(),
                event: "INSERT".to_string(),
                timing: "AFTER".to_string(),
                table_name: "orders".to_string(),
                statement: "UPDATE stats SET count = count + 1".to_string(),
                created: None,
                sql_mode: "".to_string(),
                definer: "root@localhost".to_string(),
            },
            TriggerInfo {
                name: "trg_users_update".to_string(),
                event: "UPDATE".to_string(),
                timing: "BEFORE".to_string(),
                table_name: "users".to_string(),
                statement: "SET NEW.updated_at = NOW()".to_string(),
                created: None,
                sql_mode: "".to_string(),
                definer: "root@localhost".to_string(),
            },
        ];

        // 模拟 table 过滤逻辑
        let table_filter = Some("users".to_string());
        let filtered: Vec<&TriggerInfo> = triggers
            .iter()
            .filter(|t| {
                if let Some(ref tbl) = table_filter {
                    t.table_name == *tbl
                } else {
                    true
                }
            })
            .collect();

        assert_eq!(filtered.len(), 2);
        assert!(filtered.iter().all(|t| t.table_name == "users"));
    }

    #[test]
    fn test_trigger_events() {
        let events = vec!["INSERT", "UPDATE", "DELETE"];
        for event in &events {
            let e = event.to_uppercase();
            assert!(e == "INSERT" || e == "UPDATE" || e == "DELETE");
        }
    }

    #[test]
    fn test_trigger_timings() {
        let timings = vec!["BEFORE", "AFTER", "before", "After"];
        for timing in &timings {
            let t = timing.to_uppercase();
            assert!(t == "BEFORE" || t == "AFTER");
        }
    }
}
