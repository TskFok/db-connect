use crate::db::connection::{get_conn_with_retry, DatabasePoolHandle};
use crate::db::postgres_objects;
use crate::db::sql_utils::esc_id;
use crate::models::types::{EventInfo, RoutineInfo};
use crate::AppState;
use mysql_async::prelude::*;
use tauri::State;

/// 列出指定库中的存储过程与/或函数
#[tauri::command]
pub async fn list_routines(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    routine_type: Option<String>,
) -> Result<Vec<RoutineInfo>, String> {
    if database.is_empty() {
        return Err("数据库名不能为空".to_string());
    }

    let pool = {
        let mut manager = state.connection_manager.lock().await;
        match manager.get_database_pool_and_touch(&conn_id)? {
            DatabasePoolHandle::MySql(pool) => pool,
            DatabasePoolHandle::Postgres(handle) => {
                return postgres_objects::list_routines(
                    &handle.pool,
                    &database,
                    routine_type.as_deref(),
                )
                .await;
            }
            DatabasePoolHandle::Sqlite(_) => {
                return Err(DatabasePoolHandle::sqlite_unsupported_error());
            }
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let rows: Vec<mysql_async::Row> = match routine_type.as_deref().map(|s| s.trim().to_uppercase()) {
        Some(ref t) if t == "PROCEDURE" || t == "FUNCTION" => {
            conn
                .exec(
                    r#"
SELECT ROUTINE_NAME, ROUTINE_TYPE, DATA_TYPE, SECURITY_TYPE, DEFINER, ROUTINE_COMMENT, CREATED, LAST_ALTERED
FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = ? AND ROUTINE_TYPE = ?
ORDER BY ROUTINE_TYPE, ROUTINE_NAME
"#,
                    (database.clone(), t.clone()),
                )
                .await
                .map_err(|e| format!("查询例程列表失败: {}", e))?
        }
        None => {
            conn
                .exec(
                    r#"
SELECT ROUTINE_NAME, ROUTINE_TYPE, DATA_TYPE, SECURITY_TYPE, DEFINER, ROUTINE_COMMENT, CREATED, LAST_ALTERED
FROM information_schema.ROUTINES
WHERE ROUTINE_SCHEMA = ?
ORDER BY ROUTINE_TYPE, ROUTINE_NAME
"#,
                    (database.clone(),),
                )
                .await
                .map_err(|e| format!("查询例程列表失败: {}", e))?
        }
        Some(t) => {
            return Err(format!(
                "routine_type 仅支持 PROCEDURE、FUNCTION 或留空，收到: {}",
                t
            ));
        }
    };

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(RoutineInfo {
            name: row
                .get::<Option<String>, _>("ROUTINE_NAME")
                .flatten()
                .unwrap_or_default(),
            routine_type: row
                .get::<Option<String>, _>("ROUTINE_TYPE")
                .flatten()
                .unwrap_or_default(),
            data_type: row.get::<Option<String>, _>("DATA_TYPE").flatten(),
            definer: row
                .get::<Option<String>, _>("DEFINER")
                .flatten()
                .unwrap_or_default(),
            security_type: row
                .get::<Option<String>, _>("SECURITY_TYPE")
                .flatten()
                .unwrap_or_default(),
            routine_comment: row
                .get::<Option<String>, _>("ROUTINE_COMMENT")
                .flatten()
                .unwrap_or_default(),
            created: row.get::<Option<String>, _>("CREATED").flatten(),
            last_altered: row.get::<Option<String>, _>("LAST_ALTERED").flatten(),
            identity_arguments: None,
        });
    }

    Ok(out)
}

fn routine_kind_upper(s: &str) -> Result<String, String> {
    let u = s.to_uppercase();
    if u == "PROCEDURE" || u == "FUNCTION" {
        Ok(u)
    } else {
        Err("例程类型必须为 PROCEDURE 或 FUNCTION".to_string())
    }
}

/// SHOW CREATE PROCEDURE / FUNCTION 的 DDL
#[tauri::command]
pub async fn get_routine_definition(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    routine_name: String,
    routine_type: String,
    identity_arguments: Option<String>,
) -> Result<String, String> {
    if routine_name.trim().is_empty() {
        return Err("例程名称不能为空".to_string());
    }

    let pool = {
        let mut manager = state.connection_manager.lock().await;
        match manager.get_database_pool_and_touch(&conn_id)? {
            DatabasePoolHandle::MySql(pool) => pool,
            DatabasePoolHandle::Postgres(handle) => {
                return postgres_objects::get_routine_definition(
                    &handle.pool,
                    &database,
                    &routine_name,
                    &routine_type,
                    identity_arguments.as_deref(),
                )
                .await;
            }
            DatabasePoolHandle::Sqlite(_) => {
                return Err(DatabasePoolHandle::sqlite_unsupported_error());
            }
        }
    };

    let kind = routine_kind_upper(&routine_type)?;
    let mut conn = get_conn_with_retry(&pool).await?;

    let q = if kind == "PROCEDURE" {
        format!(
            "SHOW CREATE PROCEDURE {}.{}",
            esc_id(&database),
            esc_id(routine_name.trim())
        )
    } else {
        format!(
            "SHOW CREATE FUNCTION {}.{}",
            esc_id(&database),
            esc_id(routine_name.trim())
        )
    };

    let rows: Vec<mysql_async::Row> = conn
        .query(&q)
        .await
        .map_err(|e| format!("获取例程定义失败: {}", e))?;

    let row = rows
        .first()
        .ok_or_else(|| format!("例程 '{}' 不存在", routine_name.trim()))?;

    let col = if kind == "PROCEDURE" {
        "Create Procedure"
    } else {
        "Create Function"
    };

    row.get::<Option<String>, _>(col)
        .flatten()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "服务端未返回 DDL".to_string())
}

#[tauri::command]
pub async fn drop_routine(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    routine_name: String,
    routine_type: String,
    identity_arguments: Option<String>,
) -> Result<(), String> {
    if routine_name.trim().is_empty() {
        return Err("例程名称不能为空".to_string());
    }

    let pool = {
        let mut manager = state.connection_manager.lock().await;
        match manager.get_database_pool_for_write(&conn_id)? {
            DatabasePoolHandle::MySql(pool) => pool,
            DatabasePoolHandle::Postgres(handle) => {
                return postgres_objects::drop_routine(
                    &handle.pool,
                    &database,
                    &routine_name,
                    &routine_type,
                    identity_arguments.as_deref(),
                )
                .await;
            }
            DatabasePoolHandle::Sqlite(_) => {
                return Err(DatabasePoolHandle::sqlite_unsupported_error());
            }
        }
    };

    let kind = routine_kind_upper(&routine_type)?;
    let sql = if kind == "PROCEDURE" {
        format!(
            "DROP PROCEDURE IF EXISTS {}.{}",
            esc_id(&database),
            esc_id(routine_name.trim())
        )
    } else {
        format!(
            "DROP FUNCTION IF EXISTS {}.{}",
            esc_id(&database),
            esc_id(routine_name.trim())
        )
    };

    let mut conn = get_conn_with_retry(&pool).await?;
    conn.query_drop(&sql)
        .await
        .map_err(|e| format!("删除例程失败: {}", e))?;
    Ok(())
}

fn event_string(row: &mysql_async::Row, keys: &[&str]) -> Option<String> {
    for k in keys {
        if let Some(v) = row.get::<Option<String>, _>(*k).flatten() {
            if !v.is_empty() {
                return Some(v);
            }
        }
    }
    None
}

/// 列出事件（SHOW EVENTS）
#[tauri::command]
pub async fn list_events(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> Result<Vec<EventInfo>, String> {
    if database.is_empty() {
        return Err("数据库名不能为空".to_string());
    }

    let pool = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_pool_and_touch(&conn_id)?
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let q = format!("SHOW EVENTS FROM {}", esc_id(&database));
    let rows: Vec<mysql_async::Row> = conn
        .query(&q)
        .await
        .map_err(|e| format!("列出事件失败: {}", e))?;

    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        let originator = event_string(&row, &["Originator"]).or_else(|| {
            row.get::<Option<i64>, _>("Originator")
                .flatten()
                .map(|i| i.to_string())
        });

        out.push(EventInfo {
            name: event_string(&row, &["Name"]).unwrap_or_default(),
            definer: event_string(&row, &["Definer"]).unwrap_or_default(),
            time_zone: event_string(&row, &["Time zone", "timezone"]).unwrap_or_default(),
            event_type: event_string(&row, &["Type"]).unwrap_or_default(),
            execute_at: event_string(&row, &["Execute at"]),
            interval_value: event_string(&row, &["Interval value"]),
            interval_field: event_string(&row, &["Interval field"]),
            starts: event_string(&row, &["Starts"]),
            ends: event_string(&row, &["Ends"]),
            status: event_string(&row, &["Status"]).unwrap_or_default(),
            originator,
            character_set_client: event_string(&row, &["character_set_client"]).unwrap_or_default(),
            collation_connection: event_string(&row, &["collation_connection"]).unwrap_or_default(),
            database_collation: event_string(&row, &["Database Collation", "database_collation"])
                .unwrap_or_default(),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn get_event_definition(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    event_name: String,
) -> Result<String, String> {
    if event_name.trim().is_empty() {
        return Err("事件名称不能为空".to_string());
    }

    let pool = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_pool_and_touch(&conn_id)?
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let q = format!(
        "SHOW CREATE EVENT {}.{}",
        esc_id(&database),
        esc_id(event_name.trim())
    );
    let rows: Vec<mysql_async::Row> = conn
        .query(&q)
        .await
        .map_err(|e| format!("获取事件定义失败: {}", e))?;

    let row = rows
        .first()
        .ok_or_else(|| format!("事件 '{}' 不存在", event_name.trim()))?;

    row.get::<Option<String>, _>("Create Event")
        .flatten()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "服务端未返回 DDL".to_string())
}

#[tauri::command]
pub async fn drop_event(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    event_name: String,
) -> Result<(), String> {
    if event_name.trim().is_empty() {
        return Err("事件名称不能为空".to_string());
    }

    let sql = format!(
        "DROP EVENT IF EXISTS {}.{}",
        esc_id(&database),
        esc_id(event_name.trim())
    );

    let pool = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_pool_for_write(&conn_id)?
    };

    let mut conn = get_conn_with_retry(&pool).await?;
    conn.query_drop(&sql)
        .await
        .map_err(|e| format!("删除事件失败: {}", e))?;
    Ok(())
}

/// 启用或禁用事件
#[tauri::command]
pub async fn set_event_enabled(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    event_name: String,
    enabled: bool,
) -> Result<(), String> {
    if event_name.trim().is_empty() {
        return Err("事件名称不能为空".to_string());
    }

    let action = if enabled { "ENABLE" } else { "DISABLE" };
    let sql = format!(
        "ALTER EVENT {}.{} {}",
        esc_id(&database),
        esc_id(event_name.trim()),
        action
    );

    let pool = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_pool_for_write(&conn_id)?
    };

    let mut conn = get_conn_with_retry(&pool).await?;
    conn.query_drop(&sql)
        .await
        .map_err(|e| format!("修改事件状态失败: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_routine_kind_upper() {
        assert_eq!(routine_kind_upper("procedure").unwrap(), "PROCEDURE");
        assert_eq!(routine_kind_upper("FUNCTION").unwrap(), "FUNCTION");
        assert!(routine_kind_upper("VIEW").is_err());
    }
}
