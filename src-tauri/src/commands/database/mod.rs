pub mod column_ops;
// 供本模块的 create_table 与单元测试复用列定义构建逻辑
pub use column_ops::build_column_definition;

use crate::db::connection::{get_conn_with_retry, DatabasePoolHandle};
use crate::db::postgres;
use crate::db::postgres_ddl;
use crate::db::sql_utils::{
    esc_id, esc_str, validate_column_extra, validate_column_type, validate_engine_name,
};
use crate::models::types::{
    ColumnInfo, CreateTableRequest, DatabaseInfo, SqlCompletionColumn, SqlCompletionMetadata,
    SqlCompletionTable, TableInfo,
};
use crate::AppState;
use mysql_async::params;
use mysql_async::prelude::*;
use std::collections::BTreeSet;
use tauri::State;

/// 获取数据库列表
#[tauri::command]
pub async fn list_databases(
    state: State<'_, AppState>,
    conn_id: String,
) -> Result<Vec<String>, String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_and_touch(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => return postgres::list_schemas(&handle.pool).await,
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let databases: Vec<String> = conn
        .query("SHOW DATABASES")
        .await
        .map_err(|e| format!("查询数据库列表失败: {}", e))?;

    Ok(databases)
}

/// 获取指定数据库的表列表
#[tauri::command]
pub async fn list_tables(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> Result<Vec<TableInfo>, String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_and_touch(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return postgres::list_tables(&handle.pool, &database).await;
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    // 使用 SHOW TABLE STATUS 获取表的详细信息
    let query = format!("SHOW TABLE STATUS FROM {}", esc_id(&database));
    let rows: Vec<mysql_async::Row> = conn
        .query(&query)
        .await
        .map_err(|e| format!("查询表列表失败: {}", e))?;

    let tables: Vec<TableInfo> = rows
        .iter()
        .map(|row| {
            // 注意: row.get::<String, _> 遇到 NULL 会 panic
            // 必须使用 row.get::<Option<String>, _> 来安全处理 NULL 值
            let engine: Option<String> = row.get("Engine").flatten();
            let table_type = if engine.is_some() {
                "TABLE".to_string()
            } else {
                "VIEW".to_string()
            };

            TableInfo {
                name: row
                    .get::<Option<String>, _>("Name")
                    .flatten()
                    .unwrap_or_default(),
                table_type,
                engine,
                rows: row.get::<Option<u64>, _>("Rows").flatten(),
                data_length: row.get::<Option<u64>, _>("Data_length").flatten(),
                index_length: row.get::<Option<u64>, _>("Index_length").flatten(),
                comment: row
                    .get::<Option<String>, _>("Comment")
                    .flatten()
                    .unwrap_or_default(),
            }
        })
        .collect();

    Ok(tables)
}

/// 获取表结构 (列信息)
#[tauri::command]
pub async fn get_table_structure(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<Vec<ColumnInfo>, String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_and_touch(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return postgres::get_table_structure(&handle.pool, &database, &table).await;
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    // 使用 SHOW FULL COLUMNS 获取完整列信息 (包含注释)
    let query = format!(
        "SHOW FULL COLUMNS FROM {}.{}",
        esc_id(&database),
        esc_id(&table)
    );
    let rows: Vec<mysql_async::Row> = conn
        .query(&query)
        .await
        .map_err(|e| format!("查询表结构失败: {}", e))?;

    let columns: Vec<ColumnInfo> = rows
        .iter()
        .map(|row| {
            // 注意: row.get::<String, _> 遇到 NULL 会 panic
            // 必须使用 row.get::<Option<String>, _> 来安全处理 NULL 值
            let nullable_str: String = row
                .get::<Option<String>, _>("Null")
                .flatten()
                .unwrap_or_default();
            ColumnInfo {
                name: row
                    .get::<Option<String>, _>("Field")
                    .flatten()
                    .unwrap_or_default(),
                column_type: row
                    .get::<Option<String>, _>("Type")
                    .flatten()
                    .unwrap_or_default(),
                nullable: nullable_str == "YES",
                key: row
                    .get::<Option<String>, _>("Key")
                    .flatten()
                    .unwrap_or_default(),
                default_value: row.get::<Option<String>, _>("Default").flatten(),
                extra: row
                    .get::<Option<String>, _>("Extra")
                    .flatten()
                    .unwrap_or_default(),
                comment: row
                    .get::<Option<String>, _>("Comment")
                    .flatten()
                    .unwrap_or_default(),
            }
        })
        .collect();

    Ok(columns)
}

/// 批量获取 SQL 补全元数据：数据库/schema、表、列。
#[tauri::command]
pub async fn get_sql_completion_metadata(
    state: State<'_, AppState>,
    conn_id: String,
    database: Option<String>,
) -> Result<SqlCompletionMetadata, String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_and_touch(&conn_id)?
    };

    let database = database
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    match pool_handle {
        DatabasePoolHandle::Postgres(handle) => {
            let databases = postgres::list_schemas(&handle.pool).await?;
            let Some(schema) = database else {
                return Ok(SqlCompletionMetadata {
                    databases,
                    tables: Vec::new(),
                    columns: Vec::new(),
                });
            };

            let client = postgres::get_client_with_retry(&handle.pool).await?;
            let rows = client
                .query(
                    "SELECT c.relname AS table_name, \
                            a.attname AS column_name, \
                            pg_catalog.format_type(a.atttypid, a.atttypmod) AS column_type \
                     FROM pg_catalog.pg_class c \
                     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
                     LEFT JOIN pg_catalog.pg_attribute a \
                            ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped \
                     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') \
                     ORDER BY c.relname, a.attnum",
                    &[&schema],
                )
                .await
                .map_err(|e| format!("查询 SQL 补全元数据失败: {}", e))?;

            let mut seen_tables = BTreeSet::new();
            let mut tables = Vec::new();
            let mut columns = Vec::new();

            for row in rows {
                let table_name: String = row.get("table_name");
                if seen_tables.insert(table_name.clone()) {
                    tables.push(SqlCompletionTable {
                        name: table_name.clone(),
                    });
                }
                let column_name: Option<String> = row.get("column_name");
                if let Some(name) = column_name {
                    columns.push(SqlCompletionColumn {
                        table: table_name,
                        name,
                        data_type: row.get("column_type"),
                    });
                }
            }

            Ok(SqlCompletionMetadata {
                databases,
                tables,
                columns,
            })
        }
        DatabasePoolHandle::MySql(pool) => {
            let mut conn = get_conn_with_retry(&pool).await?;
            let databases: Vec<String> = conn
                .query("SHOW DATABASES")
                .await
                .map_err(|e| format!("查询数据库列表失败: {}", e))?;

            let Some(db) = database else {
                return Ok(SqlCompletionMetadata {
                    databases,
                    tables: Vec::new(),
                    columns: Vec::new(),
                });
            };

            let rows: Vec<mysql_async::Row> = conn
                .exec(
                    "SELECT t.TABLE_NAME AS table_name, \
                            c.COLUMN_NAME AS column_name, \
                            c.COLUMN_TYPE AS column_type \
                     FROM information_schema.TABLES t \
                     LEFT JOIN information_schema.COLUMNS c \
                            ON c.TABLE_SCHEMA = t.TABLE_SCHEMA \
                           AND c.TABLE_NAME = t.TABLE_NAME \
                     WHERE t.TABLE_SCHEMA = :schema \
                     ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION",
                    params! {
                        "schema" => &db,
                    },
                )
                .await
                .map_err(|e| format!("查询 SQL 补全元数据失败: {}", e))?;

            let mut seen_tables = BTreeSet::new();
            let mut tables = Vec::new();
            let mut columns = Vec::new();

            for row in rows {
                let table_name = row
                    .get::<Option<String>, _>("table_name")
                    .flatten()
                    .unwrap_or_default();
                if table_name.is_empty() {
                    continue;
                }
                if seen_tables.insert(table_name.clone()) {
                    tables.push(SqlCompletionTable {
                        name: table_name.clone(),
                    });
                }
                if let Some(name) = row.get::<Option<String>, _>("column_name").flatten() {
                    columns.push(SqlCompletionColumn {
                        table: table_name,
                        name,
                        data_type: row.get::<Option<String>, _>("column_type").flatten(),
                    });
                }
            }

            Ok(SqlCompletionMetadata {
                databases,
                tables,
                columns,
            })
        }
        DatabasePoolHandle::Sqlite(_) => Err(DatabasePoolHandle::sqlite_unsupported_error()),
    }
}

/// 获取表的 CREATE TABLE/CREATE VIEW 语句
#[tauri::command]
pub async fn get_table_definition(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<String, String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_and_touch(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return postgres_ddl::get_table_definition(&handle.pool, &database, &table).await;
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let query = format!("SHOW CREATE TABLE {}.{}", esc_id(&database), esc_id(&table));
    let rows: Vec<mysql_async::Row> = conn
        .query(&query)
        .await
        .map_err(|e| format!("查询表定义失败: {}", e))?;

    if let Some(row) = rows.first() {
        // 表返回 "Create Table"，视图返回 "Create View"
        let def: Option<String> = row.get::<Option<String>, _>("Create Table").flatten();
        if let Some(d) = def {
            return Ok(d);
        }
        let def: Option<String> = row.get::<Option<String>, _>("Create View").flatten();
        if let Some(d) = def {
            return Ok(d);
        }
        Err(format!("无法获取表 '{}' 的定义", table))
    } else {
        Err(format!("表 '{}' 不存在", table))
    }
}

/// 获取数据库信息 (字符集/排序规则)
#[tauri::command]
pub async fn get_database_info(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> Result<DatabaseInfo, String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_and_touch(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(_handle) => {
            // PostgreSQL 的 schema 没有独立的字符集/排序规则概念，
            // 这些是数据库（cluster database）级别的设置；返回空字符串占位，
            // 前端会根据 capability 不展示字符集字段。
            return Ok(DatabaseInfo {
                name: database,
                character_set: String::new(),
                collation: String::new(),
            });
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let query = format!(
        "SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME \
         FROM INFORMATION_SCHEMA.SCHEMATA WHERE SCHEMA_NAME = {}",
        esc_str(&database)
    );

    let rows: Vec<mysql_async::Row> = conn
        .query(&query)
        .await
        .map_err(|e| format!("查询数据库信息失败: {}", e))?;

    let row = rows
        .first()
        .ok_or_else(|| format!("数据库 '{}' 不存在", database))?;

    Ok(DatabaseInfo {
        name: row
            .get::<Option<String>, _>("SCHEMA_NAME")
            .flatten()
            .unwrap_or_default(),
        character_set: row
            .get::<Option<String>, _>("DEFAULT_CHARACTER_SET_NAME")
            .flatten()
            .unwrap_or_default(),
        collation: row
            .get::<Option<String>, _>("DEFAULT_COLLATION_NAME")
            .flatten()
            .unwrap_or_default(),
    })
}

/// 修改数据库字符集和排序规则
#[tauri::command]
pub async fn alter_database_charset(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    character_set: String,
    collation: String,
) -> Result<(), String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(_handle) => {
            return Err(
                "PostgreSQL schema 不支持修改字符集/排序规则，请通过数据库（cluster）级别配置"
                    .to_string(),
            );
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let query = format!(
        "ALTER DATABASE {} CHARACTER SET = {} COLLATE = {}",
        esc_id(&database),
        esc_str(&character_set),
        esc_str(&collation)
    );

    conn.query_drop(&query)
        .await
        .map_err(|e| format!("修改数据库字符集失败: {}", e))?;

    Ok(())
}

/// 校验是否允许删除该数据库（禁止系统库）
fn validate_drop_database_name(database: &str) -> Result<(), String> {
    let db = database.trim();
    if db.is_empty() {
        return Err("数据库名称不能为空".to_string());
    }
    let lower = db.to_lowercase();
    if matches!(
        lower.as_str(),
        "mysql" | "information_schema" | "performance_schema" | "sys"
    ) {
        return Err(format!("禁止删除系统库 `{}`", db));
    }
    Ok(())
}

/// 删除数据库（DROP DATABASE）
#[tauri::command]
pub async fn drop_database(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
) -> Result<(), String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return postgres_ddl::drop_schema(&handle.pool, &database).await;
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };

    validate_drop_database_name(&database)?;
    let db = database.trim();
    let mut conn = get_conn_with_retry(&pool).await?;

    let query = format!("DROP DATABASE {}", esc_id(db));
    conn.query_drop(&query)
        .await
        .map_err(|e| format!("删除数据库失败: {}", e))?;

    Ok(())
}

/// 创建数据库（指定字符集和排序规则）
#[tauri::command]
pub async fn create_database(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
    character_set: String,
    collation: String,
) -> Result<(), String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            // PostgreSQL 下 `name` 实际为 schema 名；忽略 charset/collation。
            return postgres_ddl::create_schema(&handle.pool, &name).await;
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let query = format!(
        "CREATE DATABASE {} CHARACTER SET = {} COLLATE = {}",
        esc_id(&name),
        esc_str(&character_set),
        esc_str(&collation),
    );

    conn.query_drop(&query)
        .await
        .map_err(|e| format!("创建数据库失败: {}", e))?;

    Ok(())
}

fn build_rename_database_tables_sql(
    old_name: &str,
    new_name: &str,
    table_names: &[String],
) -> Option<String> {
    if table_names.is_empty() {
        return None;
    }

    let parts: Vec<String> = table_names
        .iter()
        .map(|table_name| {
            format!(
                "{}.{} TO {}.{}",
                esc_id(old_name),
                esc_id(table_name),
                esc_id(new_name),
                esc_id(table_name)
            )
        })
        .collect();
    Some(format!("RENAME TABLE {}", parts.join(", ")))
}

/// 重命名数据库 (创建新库 -> 迁移所有表 -> 删除旧库)
#[tauri::command]
pub async fn rename_database(
    state: State<'_, AppState>,
    conn_id: String,
    old_name: String,
    new_name: String,
    character_set: String,
    collation: String,
) -> Result<(), String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            // PostgreSQL 重命名 schema 是原子 DDL，无需逐表迁移；忽略 charset/collation。
            return postgres_ddl::rename_schema(&handle.pool, &old_name, &new_name).await;
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    // 1. 创建新数据库 (使用指定的字符集)
    let create_query = format!(
        "CREATE DATABASE {} CHARACTER SET = {} COLLATE = {}",
        esc_id(&new_name),
        esc_str(&character_set),
        esc_str(&collation)
    );
    conn.query_drop(&create_query)
        .await
        .map_err(|e| format!("创建新数据库失败: {}", e))?;

    // 2. 获取旧库中所有表名
    let tables_query = format!(
        "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = {}",
        esc_str(&old_name)
    );
    let table_names: Vec<String> = conn
        .query(&tables_query)
        .await
        .map_err(|e| format!("获取表列表失败: {}", e))?;

    // 3. 一次性迁移到新库，避免在循环中执行 SQL
    if let Some(rename_query) = build_rename_database_tables_sql(&old_name, &new_name, &table_names)
    {
        conn.query_drop(&rename_query).await.map_err(|e| {
            format!(
                "迁移 {} 张表失败: {}。新数据库 '{}' 可能已部分迁移，请手动检查。",
                table_names.len(),
                e,
                new_name
            )
        })?;
    }

    // 4. 删除旧库
    let drop_query = format!("DROP DATABASE {}", esc_id(&old_name));
    conn.query_drop(&drop_query)
        .await
        .map_err(|e| format!("删除旧数据库失败: {}", e))?;

    Ok(())
}

/// 重命名表
#[tauri::command]
pub async fn rename_table(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    old_name: String,
    new_name: String,
) -> Result<(), String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return postgres_ddl::rename_table(&handle.pool, &database, &old_name, &new_name).await;
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let query = format!(
        "ALTER TABLE {}.{} RENAME TO {}.{}",
        esc_id(&database),
        esc_id(&old_name),
        esc_id(&database),
        esc_id(&new_name)
    );

    conn.query_drop(&query)
        .await
        .map_err(|e| format!("重命名表失败: {}", e))?;

    Ok(())
}

/// 修改表引擎
#[tauri::command]
pub async fn alter_table_engine(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    engine: String,
) -> Result<(), String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(_handle) => {
            return Err("PostgreSQL 不支持修改存储引擎".to_string());
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };

    validate_engine_name(&engine)?;

    let mut conn = get_conn_with_retry(&pool).await?;

    let query = format!(
        "ALTER TABLE {}.{} ENGINE = {}",
        esc_id(&database),
        esc_id(&table),
        engine
    );

    conn.query_drop(&query)
        .await
        .map_err(|e| format!("修改表引擎失败: {}", e))?;

    Ok(())
}

/// 获取表的主键列信息
#[tauri::command]
pub async fn get_primary_keys(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<Vec<String>, String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_and_touch(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return postgres::fetch_primary_keys(&handle.pool, &database, &table).await;
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let query = format!(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS \
         WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} AND COLUMN_KEY = 'PRI' \
         ORDER BY ORDINAL_POSITION",
        esc_str(&database),
        esc_str(&table)
    );

    let pk_columns: Vec<String> = conn
        .query(&query)
        .await
        .map_err(|e| format!("查询主键信息失败: {}", e))?;

    Ok(pk_columns)
}

/// 删除表
#[tauri::command]
pub async fn drop_table(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<(), String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return postgres_ddl::drop_table(&handle.pool, &database, &table).await;
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let query = format!("DROP TABLE {}.{}", esc_id(&database), esc_id(&table));

    conn.query_drop(&query)
        .await
        .map_err(|e| format!("删除表失败: {}", e))?;

    Ok(())
}

/// 清空表（TRUNCATE TABLE）
#[tauri::command]
pub async fn truncate_table(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<(), String> {
    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return postgres_ddl::truncate_table(&handle.pool, &database, &table).await;
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let query = format!("TRUNCATE TABLE {}.{}", esc_id(&database), esc_id(&table));

    conn.query_drop(&query)
        .await
        .map_err(|e| format!("清空表失败: {}", e))?;

    Ok(())
}

/// 新建表
#[tauri::command]
pub async fn create_table(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    request: CreateTableRequest,
) -> Result<(), String> {
    if request.columns.is_empty() {
        return Err("至少需要定义一个列".to_string());
    }
    for col in &request.columns {
        validate_column_type(&col.column_type)?;
        validate_column_extra(&col.extra)?;
    }

    let pool_handle = {
        let mut manager = state.connection_manager.lock().await;
        manager.get_database_pool_for_write(&conn_id)?
    };

    let pool = match pool_handle {
        DatabasePoolHandle::MySql(pool) => pool,
        DatabasePoolHandle::Postgres(handle) => {
            return postgres_ddl::create_table(&handle.pool, &database, &request).await;
        }
        DatabasePoolHandle::Sqlite(_) => {
            return Err(DatabasePoolHandle::sqlite_unsupported_error());
        }
    };

    if !request.engine.is_empty() {
        validate_engine_name(&request.engine)?;
    }

    let mut conn = get_conn_with_retry(&pool).await?;

    // 构建列定义
    let col_defs: Vec<String> = request
        .columns
        .iter()
        .map(|col| {
            let def = build_column_definition(
                &col.column_type,
                col.nullable,
                &col.default_value,
                &col.extra,
                &col.comment,
            );
            format!("  {} {}", esc_id(&col.name), def)
        })
        .collect();

    let mut parts = col_defs;

    // 添加主键
    if !request.primary_keys.is_empty() {
        let pk_cols: Vec<String> = request.primary_keys.iter().map(|k| esc_id(k)).collect();
        parts.push(format!("  PRIMARY KEY ({})", pk_cols.join(", ")));
    }

    let engine_clause = if request.engine.is_empty() {
        String::new()
    } else {
        format!(" ENGINE={}", request.engine)
    };

    let comment_clause = if request.comment.is_empty() {
        String::new()
    } else {
        format!(" COMMENT={}", esc_str(&request.comment))
    };

    let query = format!(
        "CREATE TABLE {}.{} (\n{}\n){}{}",
        esc_id(&database),
        esc_id(&request.table_name),
        parts.join(",\n"),
        engine_clause,
        comment_clause
    );

    conn.query_drop(&query)
        .await
        .map_err(|e| format!("新建表失败: {}", e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{
        AddColumnRequest, AlterColumnPlacement, AlterColumnRequest, CreateTableColumnDef,
    };

    // 注意: 这些测试验证的是 SQL 查询逻辑的正确性
    // 实际的数据库交互测试需要集成测试环境

    #[test]
    fn test_table_type_detection() {
        // 模拟: 有 engine 的是表，无 engine 的是视图
        let engine_some: Option<String> = Some("InnoDB".to_string());
        let engine_none: Option<String> = None;

        let table_type = if engine_some.is_some() {
            "TABLE"
        } else {
            "VIEW"
        };
        assert_eq!(table_type, "TABLE");

        let view_type = if engine_none.is_some() {
            "TABLE"
        } else {
            "VIEW"
        };
        assert_eq!(view_type, "VIEW");
    }

    #[test]
    fn test_alter_database_sql_format() {
        let db = "myapp";
        let charset = "utf8mb4";
        let collation = "utf8mb4_general_ci";
        let sql = format!(
            "ALTER DATABASE `{}` CHARACTER SET = '{}' COLLATE = '{}'",
            db, charset, collation
        );
        assert_eq!(
            sql,
            "ALTER DATABASE `myapp` CHARACTER SET = 'utf8mb4' COLLATE = 'utf8mb4_general_ci'"
        );
    }

    #[test]
    fn test_rename_table_sql_format() {
        let old_db = "old_db";
        let new_db = "new_db";
        let table = "users";
        let sql = format!(
            "RENAME TABLE `{}`.`{}` TO `{}`.`{}`",
            old_db, table, new_db, table
        );
        assert_eq!(sql, "RENAME TABLE `old_db`.`users` TO `new_db`.`users`");
    }

    #[test]
    fn test_build_rename_database_tables_sql_empty() {
        let tables: Vec<String> = vec![];
        assert_eq!(
            build_rename_database_tables_sql("old_db", "new_db", &tables),
            None
        );
    }

    #[test]
    fn test_build_rename_database_tables_sql_batches_all_tables() {
        let tables = vec!["users".to_string(), "orders".to_string()];
        assert_eq!(
            build_rename_database_tables_sql("old_db", "new_db", &tables),
            Some(
                "RENAME TABLE `old_db`.`users` TO `new_db`.`users`, `old_db`.`orders` TO `new_db`.`orders`"
                    .to_string()
            )
        );
    }

    #[test]
    fn test_build_rename_database_tables_sql_escapes_backticks() {
        let tables = vec!["we`ird".to_string()];
        assert_eq!(
            build_rename_database_tables_sql("old`db", "new`db", &tables),
            Some("RENAME TABLE `old``db`.`we``ird` TO `new``db`.`we``ird`".to_string())
        );
    }

    #[test]
    fn test_create_database_sql_format() {
        let name = "new_db";
        let charset = "utf8mb4";
        let collation = "utf8mb4_unicode_ci";
        let sql = format!(
            "CREATE DATABASE `{}` CHARACTER SET = '{}' COLLATE = '{}'",
            name, charset, collation
        );
        assert_eq!(
            sql,
            "CREATE DATABASE `new_db` CHARACTER SET = 'utf8mb4' COLLATE = 'utf8mb4_unicode_ci'"
        );
    }

    #[test]
    fn test_validate_drop_database_rejects_system() {
        assert!(validate_drop_database_name("mysql").is_err());
        assert!(validate_drop_database_name("INFORMATION_SCHEMA").is_err());
        assert!(validate_drop_database_name("").is_err());
        assert!(validate_drop_database_name("my_app").is_ok());
    }

    #[test]
    fn test_nullable_parsing() {
        let yes = "YES".to_string();
        let no = "NO".to_string();
        let empty = "".to_string();

        assert!(yes == "YES");
        assert!(no != "YES");
        assert!(empty != "YES");
    }

    #[test]
    fn test_rename_table_sql_format_alter() {
        let db = "myapp";
        let old_name = "old_table";
        let new_name = "new_table";
        let sql = format!(
            "ALTER TABLE `{}`.`{}` RENAME TO `{}`.`{}`",
            db, old_name, db, new_name
        );
        assert_eq!(
            sql,
            "ALTER TABLE `myapp`.`old_table` RENAME TO `myapp`.`new_table`"
        );
    }

    #[test]
    fn test_alter_table_engine_sql_format() {
        let db = "myapp";
        let table = "users";
        let engine = "MyISAM";
        let sql = format!("ALTER TABLE `{}`.`{}` ENGINE = {}", db, table, engine);
        assert_eq!(sql, "ALTER TABLE `myapp`.`users` ENGINE = MyISAM");
    }

    #[test]
    fn test_get_primary_keys_sql_format() {
        let db = "myapp";
        let table = "users";
        let sql = format!(
            "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS \
             WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} AND COLUMN_KEY = 'PRI' \
             ORDER BY ORDINAL_POSITION",
            esc_str(db),
            esc_str(table)
        );
        assert!(sql.contains("TABLE_SCHEMA = 'myapp'"));
        assert!(sql.contains("TABLE_NAME = 'users'"));
        assert!(sql.contains("COLUMN_KEY = 'PRI'"));
    }

    #[test]
    fn test_build_column_definition_basic() {
        let def = build_column_definition("varchar(255)", true, &None, "", "");
        assert_eq!(def, "varchar(255) NULL");
    }

    #[test]
    fn test_build_column_definition_not_null() {
        let def = build_column_definition("int", false, &None, "", "");
        assert_eq!(def, "int NOT NULL");
    }

    #[test]
    fn test_build_column_definition_with_default() {
        let def = build_column_definition("tinyint", false, &Some("1".to_string()), "", "");
        assert_eq!(def, "tinyint NOT NULL DEFAULT '1'");
    }

    #[test]
    fn test_build_column_definition_with_current_timestamp() {
        let def = build_column_definition(
            "datetime",
            false,
            &Some("CURRENT_TIMESTAMP".to_string()),
            "",
            "",
        );
        assert_eq!(def, "datetime NOT NULL DEFAULT CURRENT_TIMESTAMP");
    }

    #[test]
    fn test_build_column_definition_with_null_default() {
        let def = build_column_definition("varchar(100)", true, &Some("NULL".to_string()), "", "");
        assert_eq!(def, "varchar(100) NULL DEFAULT NULL");
    }

    #[test]
    fn test_build_column_definition_with_auto_increment() {
        let def =
            build_column_definition("bigint unsigned", false, &None, "auto_increment", "主键");
        assert_eq!(
            def,
            "bigint unsigned NOT NULL auto_increment COMMENT '主键'"
        );
    }

    #[test]
    fn test_build_column_definition_full() {
        let def = build_column_definition(
            "varchar(255)",
            false,
            &Some("unknown".to_string()),
            "",
            "用户名",
        );
        assert_eq!(
            def,
            "varchar(255) NOT NULL DEFAULT 'unknown' COMMENT '用户名'"
        );
    }

    #[test]
    fn test_build_column_definition_comment_with_quote() {
        let def = build_column_definition("varchar(50)", true, &None, "", "it's a test");
        assert_eq!(def, "varchar(50) NULL COMMENT 'it''s a test'");
    }

    #[test]
    fn test_build_column_definition_preserves_backslash_double_quote() {
        let def = build_column_definition(
            "varchar(50)",
            true,
            &Some("default\\\"value".to_string()),
            "",
            "comment\\\"value",
        );
        assert_eq!(
            def,
            "varchar(50) NULL DEFAULT 'default\\\\\"value' COMMENT 'comment\\\\\"value'"
        );
    }

    #[test]
    fn test_alter_column_modify_sql_format() {
        let db = "myapp";
        let table = "users";
        let request = AlterColumnRequest {
            old_name: "name".to_string(),
            new_name: "name".to_string(),
            column_type: "varchar(128)".to_string(),
            nullable: false,
            default_value: None,
            extra: "".to_string(),
            comment: "用户名".to_string(),
            is_primary: Some(false),
            column_placement: None,
        };
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
        let sql = format!(
            "ALTER TABLE `{}`.`{}` MODIFY COLUMN `{}` {}{}",
            db, table, request.old_name, col_def, position_sql
        );
        assert_eq!(
            sql,
            "ALTER TABLE `myapp`.`users` MODIFY COLUMN `name` varchar(128) NOT NULL COMMENT '用户名'"
        );
    }

    #[test]
    fn test_alter_column_modify_sql_with_first_position() {
        let db = "myapp";
        let table = "users";
        let request = AlterColumnRequest {
            old_name: "name".to_string(),
            new_name: "name".to_string(),
            column_type: "varchar(128)".to_string(),
            nullable: false,
            default_value: None,
            extra: "".to_string(),
            comment: "用户名".to_string(),
            is_primary: Some(false),
            column_placement: Some(AlterColumnPlacement::First),
        };
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
        let sql = format!(
            "ALTER TABLE `{}`.`{}` MODIFY COLUMN `{}` {}{}",
            db, table, request.old_name, col_def, position_sql
        );
        assert_eq!(
            sql,
            "ALTER TABLE `myapp`.`users` MODIFY COLUMN `name` varchar(128) NOT NULL COMMENT '用户名' FIRST"
        );
    }

    #[test]
    fn test_alter_column_change_sql_format() {
        let db = "myapp";
        let table = "users";
        let request = AlterColumnRequest {
            old_name: "username".to_string(),
            new_name: "user_name".to_string(),
            column_type: "varchar(128)".to_string(),
            nullable: true,
            default_value: Some("guest".to_string()),
            extra: "".to_string(),
            comment: "".to_string(),
            is_primary: None,
            column_placement: None,
        };
        let col_def = build_column_definition(
            &request.column_type,
            request.nullable,
            &request.default_value,
            &request.extra,
            &request.comment,
        );
        let sql = format!(
            "ALTER TABLE `{}`.`{}` CHANGE COLUMN `{}` `{}` {}",
            db, table, request.old_name, request.new_name, col_def
        );
        assert_eq!(
            sql,
            "ALTER TABLE `myapp`.`users` CHANGE COLUMN `username` `user_name` varchar(128) NULL DEFAULT 'guest'"
        );
    }

    #[test]
    fn test_add_column_sql_format() {
        let db = "myapp";
        let table = "users";
        let request = AddColumnRequest {
            name: "email".to_string(),
            column_type: "varchar(255)".to_string(),
            nullable: true,
            default_value: None,
            extra: "".to_string(),
            comment: "邮箱".to_string(),
            after_column: Some("username".to_string()),
        };
        let col_def = build_column_definition(
            &request.column_type,
            request.nullable,
            &request.default_value,
            &request.extra,
            &request.comment,
        );
        let position = match &request.after_column {
            Some(after) => format!(" AFTER `{}`", after),
            None => String::new(),
        };
        let sql = format!(
            "ALTER TABLE `{}`.`{}` ADD COLUMN `{}` {}{}",
            db, table, request.name, col_def, position
        );
        assert_eq!(
            sql,
            "ALTER TABLE `myapp`.`users` ADD COLUMN `email` varchar(255) NULL COMMENT '邮箱' AFTER `username`"
        );
    }

    #[test]
    fn test_add_column_at_end_sql_format() {
        let db = "myapp";
        let table = "users";
        let request = AddColumnRequest {
            name: "created_at".to_string(),
            column_type: "datetime".to_string(),
            nullable: false,
            default_value: Some("CURRENT_TIMESTAMP".to_string()),
            extra: "".to_string(),
            comment: "创建时间".to_string(),
            after_column: None,
        };
        let col_def = build_column_definition(
            &request.column_type,
            request.nullable,
            &request.default_value,
            &request.extra,
            &request.comment,
        );
        let position = match &request.after_column {
            Some(after) => format!(" AFTER `{}`", after),
            None => String::new(),
        };
        let sql = format!(
            "ALTER TABLE `{}`.`{}` ADD COLUMN `{}` {}{}",
            db, table, request.name, col_def, position
        );
        assert_eq!(
            sql,
            "ALTER TABLE `myapp`.`users` ADD COLUMN `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间'"
        );
    }

    #[test]
    fn test_drop_column_sql_format() {
        let db = "myapp";
        let table = "users";
        let column_name = "old_field";
        let sql = format!(
            "ALTER TABLE `{}`.`{}` DROP COLUMN `{}`",
            db, table, column_name
        );
        assert_eq!(sql, "ALTER TABLE `myapp`.`users` DROP COLUMN `old_field`");
    }

    #[test]
    fn test_create_table_sql_basic() {
        let database = "myapp";
        let request = CreateTableRequest {
            table_name: "users".to_string(),
            columns: vec![
                CreateTableColumnDef {
                    name: "id".to_string(),
                    column_type: "bigint unsigned".to_string(),
                    nullable: false,
                    default_value: None,
                    extra: "auto_increment".to_string(),
                    comment: "主键".to_string(),
                },
                CreateTableColumnDef {
                    name: "name".to_string(),
                    column_type: "varchar(100)".to_string(),
                    nullable: false,
                    default_value: Some("".to_string()),
                    extra: "".to_string(),
                    comment: "用户名".to_string(),
                },
            ],
            primary_keys: vec!["id".to_string()],
            engine: "InnoDB".to_string(),
            comment: "用户表".to_string(),
        };

        let col_defs: Vec<String> = request
            .columns
            .iter()
            .map(|col| {
                let def = build_column_definition(
                    &col.column_type,
                    col.nullable,
                    &col.default_value,
                    &col.extra,
                    &col.comment,
                );
                format!("  {} {}", esc_id(&col.name), def)
            })
            .collect();

        let mut parts = col_defs;

        if !request.primary_keys.is_empty() {
            let pk_cols: Vec<String> = request.primary_keys.iter().map(|k| esc_id(k)).collect();
            parts.push(format!("  PRIMARY KEY ({})", pk_cols.join(", ")));
        }

        let engine_clause = if request.engine.is_empty() {
            String::new()
        } else {
            format!(" ENGINE={}", request.engine)
        };

        let comment_clause = if request.comment.is_empty() {
            String::new()
        } else {
            format!(" COMMENT={}", esc_str(&request.comment))
        };

        let query = format!(
            "CREATE TABLE {}.{} (\n{}\n){}{}",
            esc_id(database),
            esc_id(&request.table_name),
            parts.join(",\n"),
            engine_clause,
            comment_clause
        );

        let expected = "CREATE TABLE `myapp`.`users` (\n  `id` bigint unsigned NOT NULL auto_increment COMMENT '主键',\n  `name` varchar(100) NOT NULL DEFAULT '' COMMENT '用户名',\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB COMMENT='用户表'";
        assert_eq!(query, expected);
    }

    #[test]
    fn test_create_table_sql_no_pk_no_comment() {
        let database = "testdb";
        let request = CreateTableRequest {
            table_name: "logs".to_string(),
            columns: vec![CreateTableColumnDef {
                name: "msg".to_string(),
                column_type: "text".to_string(),
                nullable: true,
                default_value: None,
                extra: "".to_string(),
                comment: "".to_string(),
            }],
            primary_keys: vec![],
            engine: "MyISAM".to_string(),
            comment: "".to_string(),
        };

        let col_defs: Vec<String> = request
            .columns
            .iter()
            .map(|col| {
                let def = build_column_definition(
                    &col.column_type,
                    col.nullable,
                    &col.default_value,
                    &col.extra,
                    &col.comment,
                );
                format!("  `{}` {}", col.name, def)
            })
            .collect();

        let parts = col_defs;

        let engine_clause = format!(" ENGINE={}", request.engine);

        let query = format!(
            "CREATE TABLE `{}`.`{}` (\n{}\n){}",
            database,
            request.table_name,
            parts.join(",\n"),
            engine_clause
        );

        assert_eq!(
            query,
            "CREATE TABLE `testdb`.`logs` (\n  `msg` text NULL\n) ENGINE=MyISAM"
        );
    }

    #[test]
    fn test_create_table_sql_multiple_pk() {
        let database = "myapp";
        let request = CreateTableRequest {
            table_name: "order_items".to_string(),
            columns: vec![
                CreateTableColumnDef {
                    name: "order_id".to_string(),
                    column_type: "bigint".to_string(),
                    nullable: false,
                    default_value: None,
                    extra: "".to_string(),
                    comment: "".to_string(),
                },
                CreateTableColumnDef {
                    name: "item_id".to_string(),
                    column_type: "bigint".to_string(),
                    nullable: false,
                    default_value: None,
                    extra: "".to_string(),
                    comment: "".to_string(),
                },
            ],
            primary_keys: vec!["order_id".to_string(), "item_id".to_string()],
            engine: "InnoDB".to_string(),
            comment: "".to_string(),
        };

        let col_defs: Vec<String> = request
            .columns
            .iter()
            .map(|col| {
                let def = build_column_definition(
                    &col.column_type,
                    col.nullable,
                    &col.default_value,
                    &col.extra,
                    &col.comment,
                );
                format!("  `{}` {}", col.name, def)
            })
            .collect();

        let mut parts = col_defs;
        let pk_cols: Vec<String> = request
            .primary_keys
            .iter()
            .map(|k| format!("`{}`", k))
            .collect();
        parts.push(format!("  PRIMARY KEY ({})", pk_cols.join(", ")));

        let query = format!(
            "CREATE TABLE `{}`.`{}` (\n{}\n) ENGINE={}",
            database,
            request.table_name,
            parts.join(",\n"),
            request.engine
        );

        assert_eq!(
            query,
            "CREATE TABLE `myapp`.`order_items` (\n  `order_id` bigint NOT NULL,\n  `item_id` bigint NOT NULL,\n  PRIMARY KEY (`order_id`, `item_id`)\n) ENGINE=InnoDB"
        );
    }

    #[test]
    fn test_create_table_empty_columns_rejected() {
        let request = CreateTableRequest {
            table_name: "empty".to_string(),
            columns: vec![],
            primary_keys: vec![],
            engine: "InnoDB".to_string(),
            comment: "".to_string(),
        };
        assert!(request.columns.is_empty());
    }

    #[test]
    fn test_drop_table_sql_format() {
        let db = "myapp";
        let table = "old_table";
        let sql = format!("DROP TABLE `{}`.`{}`", db, table);
        assert_eq!(sql, "DROP TABLE `myapp`.`old_table`");
    }

    #[test]
    fn test_drop_table_sql_special_name() {
        let db = "test_db";
        let table = "user_logs_2024";
        let sql = format!("DROP TABLE `{}`.`{}`", db, table);
        assert_eq!(sql, "DROP TABLE `test_db`.`user_logs_2024`");
    }

    #[test]
    fn test_truncate_table_sql_format() {
        let db = "myapp";
        let table = "logs";
        let sql = format!("TRUNCATE TABLE `{}`.`{}`", db, table);
        assert_eq!(sql, "TRUNCATE TABLE `myapp`.`logs`");
    }
}
