//! 表结构只读 SQL 预览。只读取必要元数据，复用实际 DDL 构建器。

use super::column_ops::{build_mysql_add_column_sql, build_mysql_alter_column_sqls};
use crate::db::connection::{get_conn_with_retry, DatabasePoolHandle};
use crate::db::sql_utils::{esc_str, validate_column_extra, validate_column_type};
use crate::db::{postgres_ddl, sqlite, sqlserver, sqlserver_ddl};
use crate::models::types::{
    AddColumnRequest, AlterColumnRequest, CreateTableRequest, DatabaseType,
};
use crate::AppState;
use mysql_async::prelude::*;
use tauri::State;

#[tauri::command]
pub async fn preview_add_column(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    request: AddColumnRequest,
) -> Result<Vec<String>, String> {
    let pool = state
        .connection_manager
        .lock()
        .await
        .get_database_pool_and_touch(&conn_id)?;
    validate_column_type(&request.column_type)?;
    match pool {
        DatabasePoolHandle::MySql(_) => {
            validate_column_extra(&request.extra)?;
            Ok(vec![build_mysql_add_column_sql(
                &database, &table, &request,
            )])
        }
        DatabasePoolHandle::Postgres(_) => {
            validate_column_extra(&request.extra)?;
            Ok(postgres_ddl::build_add_column_sqls(
                &database, &table, &request,
            ))
        }
        DatabasePoolHandle::Sqlite(_) => Ok(vec![sqlite::build_add_column_sql(
            &database, &table, &request,
        )?]),
        DatabasePoolHandle::SqlServer(_) => {
            sqlserver_ddl::build_add_column_sqls(&database, &table, &request)
        }
        DatabasePoolHandle::ClickHouse(_) => Err(
            "ClickHouse 暂不支持通过表结构面板新增列，请使用 SQL 编辑器执行明确的 ALTER TABLE"
                .to_string(),
        ),
    }
}

#[tauri::command]
pub async fn preview_alter_column(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    request: AlterColumnRequest,
) -> Result<Vec<String>, String> {
    let pool = state
        .connection_manager
        .lock()
        .await
        .get_database_pool_and_touch(&conn_id)?;
    match pool {
        DatabasePoolHandle::MySql(pool) => {
            validate_column_type(&request.column_type)?;
            validate_column_extra(&request.extra)?;
            let current_pk_columns = if request.is_primary.is_some() {
                let mut conn = get_conn_with_retry(&pool).await?;
                conn.query(format!(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS \
                     WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} AND COLUMN_KEY = 'PRI' \
                     ORDER BY ORDINAL_POSITION",
                    esc_str(&database), esc_str(&table),
                )).await.map_err(|e| format!("查询主键信息失败: {}", e))?
            } else {
                Vec::<String>::new()
            };
            Ok(build_mysql_alter_column_sqls(&database, &table, &request, &current_pk_columns))
        }
        DatabasePoolHandle::Postgres(handle) => {
            validate_column_type(&request.column_type)?;
            validate_column_extra(&request.extra)?;
            if request.column_placement.is_some() {
                return Err("PostgreSQL 不支持调整列顺序，请通过新增列后逐列迁移数据来实现".to_string());
            }
            postgres_ddl::preview_alter_column(&handle.pool, &database, &table, &request).await
        }
        DatabasePoolHandle::Sqlite(_) => Err("SQLite 暂不支持修改列定义，请通过新建表迁移数据完成该操作".to_string()),
        DatabasePoolHandle::SqlServer(handle) => {
            validate_column_type(&request.column_type)?;
            let columns = sqlserver::get_table_structure(&handle.pool, &database, &table).await?;
            let current = columns.into_iter().find(|column| column.name == request.old_name)
                .ok_or_else(|| format!("列 `{}` 不存在", request.old_name))?;
            sqlserver_ddl::build_alter_column_sqls(&database, &table, &current, &request)
        }
        DatabasePoolHandle::ClickHouse(_) => Err("ClickHouse 暂不支持通过表结构面板修改列定义或列顺序，请使用 SQL 编辑器执行明确的 ALTER TABLE".to_string()),
    }
}

#[tauri::command]
pub async fn preview_table_properties(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    new_name: String,
    engine: Option<String>,
) -> Result<Vec<String>, String> {
    let pool = state
        .connection_manager
        .lock()
        .await
        .get_database_pool_and_touch(&conn_id)?;
    let database_type = match pool {
        DatabasePoolHandle::MySql(_) => DatabaseType::MySql,
        DatabasePoolHandle::Postgres(_) => DatabaseType::Postgres,
        DatabasePoolHandle::Sqlite(_) => DatabaseType::Sqlite,
        DatabasePoolHandle::SqlServer(_) => DatabaseType::SqlServer,
        DatabasePoolHandle::ClickHouse(_) => DatabaseType::ClickHouse,
    };
    super::build_table_properties_sqls(
        database_type,
        &database,
        &table,
        &new_name,
        engine.as_deref(),
    )
}

#[tauri::command]
pub async fn preview_create_table(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    request: CreateTableRequest,
) -> Result<Vec<String>, String> {
    if request.columns.is_empty() {
        return Err("至少需要定义一个列".to_string());
    }
    for column in &request.columns {
        validate_column_type(&column.column_type)?;
        validate_column_extra(&column.extra)?;
    }
    let pool = state
        .connection_manager
        .lock()
        .await
        .get_database_pool_and_touch(&conn_id)?;
    match pool {
        DatabasePoolHandle::MySql(_) => Ok(vec![super::build_mysql_create_table_sql(
            &database, &request,
        )?]),
        DatabasePoolHandle::Postgres(_) => {
            let (create_sql, after_sqls) =
                postgres_ddl::build_create_table_sqls(&database, &request)?;
            Ok(std::iter::once(create_sql).chain(after_sqls).collect())
        }
        DatabasePoolHandle::Sqlite(_) => {
            Ok(vec![sqlite::build_create_table_sql(&database, &request)?])
        }
        DatabasePoolHandle::SqlServer(_) => {
            let (create_sql, after_sqls) =
                sqlserver_ddl::build_create_table_sqls(&database, &request)?;
            Ok(std::iter::once(create_sql).chain(after_sqls).collect())
        }
        DatabasePoolHandle::ClickHouse(_) => Ok(vec![super::build_clickhouse_create_table_sql(
            &database, &request,
        )?]),
    }
}
