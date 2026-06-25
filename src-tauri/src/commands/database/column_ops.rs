//! 列级操作命令：新增 / 修改 / 删除列，以及列定义 SQL 片段构建。

use crate::db::connection::{get_conn_with_retry, DatabasePoolHandle};
use crate::db::postgres_ddl;
use crate::db::sql_utils::{esc_id, esc_str, validate_column_extra, validate_column_type};
use crate::models::types::{AddColumnRequest, AlterColumnPlacement, AlterColumnRequest};
use crate::AppState;
use mysql_async::prelude::*;
use tauri::State;

/// 构建列定义 SQL 片段 (不含列名)
/// 例如: `varchar(255) NOT NULL DEFAULT '0' COMMENT '状态'`
pub fn build_column_definition(
    column_type: &str,
    nullable: bool,
    default_value: &Option<String>,
    extra: &str,
    comment: &str,
) -> String {
    let mut parts = vec![column_type.to_string()];

    if nullable {
        parts.push("NULL".to_string());
    } else {
        parts.push("NOT NULL".to_string());
    }

    if let Some(ref default) = default_value {
        let upper = default.trim().to_uppercase();
        if upper == "CURRENT_TIMESTAMP" || upper == "NULL" || upper.starts_with("CURRENT_TIMESTAMP")
        {
            parts.push(format!("DEFAULT {}", default));
        } else {
            parts.push(format!("DEFAULT {}", esc_str(default)));
        }
    }

    if !extra.is_empty() {
        parts.push(extra.to_string());
    }

    if !comment.is_empty() {
        parts.push(format!("COMMENT {}", esc_str(comment)));
    }

    parts.join(" ")
}

/// 修改列定义
#[tauri::command]
pub async fn alter_column(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    request: AlterColumnRequest,
) -> Result<(), String> {
    validate_column_type(&request.column_type)?;
    validate_column_extra(&request.extra)?;

    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            // PostgreSQL 不支持像 MySQL 那样的 FIRST/AFTER 列重排；存在 column_placement 时返回明确提示。
            if request.column_placement.is_some() {
                return Err(
                    "PostgreSQL 不支持调整列顺序，请通过新增列后逐列迁移数据来实现".to_string(),
                );
            }
            return postgres_ddl::alter_column(&handle.pool, &database, &table, &request).await;
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let col_def = build_column_definition(
        &request.column_type,
        request.nullable,
        &request.default_value,
        &request.extra,
        &request.comment,
    );

    let position_sql = match &request.column_placement {
        None => String::new(),
        Some(AlterColumnPlacement::First) => " FIRST".to_string(),
        Some(AlterColumnPlacement::After { column }) => format!(" AFTER {}", esc_id(column)),
    };

    let current_pk_columns: Vec<String> = conn
        .query(format!(
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS \
             WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} AND COLUMN_KEY = 'PRI' \
             ORDER BY ORDINAL_POSITION",
            esc_str(&database),
            esc_str(&table)
        ))
        .await
        .map_err(|e| format!("查询主键信息失败: {}", e))?;

    let query = if request.old_name != request.new_name {
        format!(
            "ALTER TABLE {}.{} CHANGE COLUMN {} {} {}{}",
            esc_id(&database),
            esc_id(&table),
            esc_id(&request.old_name),
            esc_id(&request.new_name),
            col_def,
            position_sql
        )
    } else {
        format!(
            "ALTER TABLE {}.{} MODIFY COLUMN {} {}{}",
            esc_id(&database),
            esc_id(&table),
            esc_id(&request.old_name),
            col_def,
            position_sql
        )
    };

    conn.query_drop(&query)
        .await
        .map_err(|e| format!("修改列失败: {}", e))?;

    if let Some(is_primary) = request.is_primary {
        let mut target_pk_columns: Vec<String> = current_pk_columns
            .iter()
            .map(|c| {
                if c == &request.old_name {
                    request.new_name.clone()
                } else {
                    c.clone()
                }
            })
            .collect();

        if is_primary {
            if !target_pk_columns.iter().any(|c| c == &request.new_name) {
                target_pk_columns.push(request.new_name.clone());
            }
        } else {
            target_pk_columns.retain(|c| c != &request.old_name && c != &request.new_name);
        }

        let pk_changed = if is_primary {
            !current_pk_columns.iter().any(|c| c == &request.old_name)
        } else {
            current_pk_columns.iter().any(|c| c == &request.old_name)
        };

        if pk_changed {
            let pk_query = if target_pk_columns.is_empty() {
                format!(
                    "ALTER TABLE {}.{} DROP PRIMARY KEY",
                    esc_id(&database),
                    esc_id(&table)
                )
            } else if current_pk_columns.is_empty() {
                format!(
                    "ALTER TABLE {}.{} ADD PRIMARY KEY ({})",
                    esc_id(&database),
                    esc_id(&table),
                    target_pk_columns
                        .iter()
                        .map(|c| esc_id(c))
                        .collect::<Vec<String>>()
                        .join(", ")
                )
            } else {
                format!(
                    "ALTER TABLE {}.{} DROP PRIMARY KEY, ADD PRIMARY KEY ({})",
                    esc_id(&database),
                    esc_id(&table),
                    target_pk_columns
                        .iter()
                        .map(|c| esc_id(c))
                        .collect::<Vec<String>>()
                        .join(", ")
                )
            };

            conn.query_drop(&pk_query)
                .await
                .map_err(|e| format!("修改主键失败: {}", e))?;
        }
    }

    Ok(())
}

/// 新增列
#[tauri::command]
pub async fn add_column(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    request: AddColumnRequest,
) -> Result<(), String> {
    validate_column_type(&request.column_type)?;
    validate_column_extra(&request.extra)?;

    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            // PostgreSQL 总是末尾添加列；`after_column` 在 PG 下不生效，提前丢弃避免误导。
            return postgres_ddl::add_column(&handle.pool, &database, &table, &request).await;
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let col_def = build_column_definition(
        &request.column_type,
        request.nullable,
        &request.default_value,
        &request.extra,
        &request.comment,
    );

    let position = match &request.after_column {
        Some(after) => format!(" AFTER {}", esc_id(after)),
        None => String::new(),
    };

    let query = format!(
        "ALTER TABLE {}.{} ADD COLUMN {} {}{}",
        esc_id(&database),
        esc_id(&table),
        esc_id(&request.name),
        col_def,
        position
    );

    conn.query_drop(&query)
        .await
        .map_err(|e| format!("新增列失败: {}", e))?;

    Ok(())
}

/// 删除列
#[tauri::command]
pub async fn drop_column(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    column_name: String,
) -> Result<(), String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return postgres_ddl::drop_column(&handle.pool, &database, &table, &column_name).await;
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let query = format!(
        "ALTER TABLE {}.{} DROP COLUMN {}",
        esc_id(&database),
        esc_id(&table),
        esc_id(&column_name)
    );

    conn.query_drop(&query)
        .await
        .map_err(|e| format!("删除列失败: {}", e))?;

    Ok(())
}
