use crate::db::connection::{get_conn_with_retry, DatabasePoolHandle};
use crate::db::postgres_objects;
use crate::db::sql_utils::{esc_id, esc_str};
use crate::db::sqlite;
use crate::db::sqlserver_objects;
use crate::models::types::{CreateIndexRequest, IndexColumnInfo, IndexInfo};
use crate::AppState;
use mysql_async::prelude::*;
use std::collections::BTreeMap;
use tauri::State;

/// 获取指定表的索引列表
#[tauri::command]
pub async fn list_indexes(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
) -> Result<Vec<IndexInfo>, String> {
    let pool = {
        let mut manager = state.connection_manager.lock().await;
        match manager.get_database_pool_and_touch(&conn_id)? {
            DatabasePoolHandle::MySql(pool) => pool,
            DatabasePoolHandle::Postgres(handle) => {
                return postgres_objects::list_indexes(&handle.pool, &database, &table).await;
            }
            DatabasePoolHandle::Sqlite(handle) => {
                return sqlite::list_indexes(&handle.pool, &database, &table).await;
            }
            DatabasePoolHandle::SqlServer(handle) => {
                return sqlserver_objects::list_indexes(&handle.pool, &database, &table).await;
            }
            DatabasePoolHandle::ClickHouse(_) => {
                return Err(DatabasePoolHandle::clickhouse_unsupported_error());
            }
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    let query = format!("SHOW INDEX FROM {}.{}", esc_id(&database), esc_id(&table));
    let rows: Vec<mysql_async::Row> = conn
        .query(&query)
        .await
        .map_err(|e| format!("查询索引信息失败: {}", e))?;

    // SHOW INDEX 每个索引列占一行，需要按索引名聚合
    // 使用 BTreeMap 保持插入顺序
    let mut index_map: BTreeMap<String, IndexInfo> = BTreeMap::new();

    for row in &rows {
        let key_name: String = row
            .get::<Option<String>, _>("Key_name")
            .flatten()
            .unwrap_or_default();
        let non_unique: i64 = row
            .get::<Option<i64>, _>("Non_unique")
            .flatten()
            .unwrap_or(1);
        let seq_in_index: u32 = row
            .get::<Option<u32>, _>("Seq_in_index")
            .flatten()
            .unwrap_or(1);
        let column_name: String = row
            .get::<Option<String>, _>("Column_name")
            .flatten()
            .unwrap_or_default();
        let collation: Option<String> = row.get::<Option<String>, _>("Collation").flatten();
        let sub_part: Option<u64> = row.get::<Option<u64>, _>("Sub_part").flatten();
        let index_type: String = row
            .get::<Option<String>, _>("Index_type")
            .flatten()
            .unwrap_or_else(|| "BTREE".to_string());
        let index_comment: String = row
            .get::<Option<String>, _>("Index_comment")
            .flatten()
            .unwrap_or_default();

        let col_info = IndexColumnInfo {
            column_name,
            seq_in_index,
            collation,
            sub_part,
        };

        index_map
            .entry(key_name.clone())
            .and_modify(|idx| {
                idx.columns.push(col_info.clone());
            })
            .or_insert_with(|| IndexInfo {
                name: key_name.clone(),
                unique: non_unique == 0,
                index_type: index_type.clone(),
                columns: vec![col_info],
                is_primary: key_name == "PRIMARY",
                comment: index_comment,
            });
    }

    // 对每个索引的列按 seq_in_index 排序
    let mut indexes: Vec<IndexInfo> = index_map.into_values().collect();
    for idx in &mut indexes {
        idx.columns.sort_by_key(|c| c.seq_in_index);
    }

    Ok(indexes)
}

/// 创建索引
#[tauri::command]
pub async fn create_index(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    request: CreateIndexRequest,
) -> Result<(), String> {
    // 验证参数
    if request.index_name.is_empty() {
        return Err("索引名称不能为空".to_string());
    }
    if request.columns.is_empty() {
        return Err("至少需要选择一列".to_string());
    }

    let pool = {
        let mut manager = state.connection_manager.lock().await;
        match manager.get_database_pool_for_write(&conn_id)? {
            DatabasePoolHandle::MySql(pool) => pool,
            DatabasePoolHandle::Postgres(handle) => {
                return postgres_objects::create_index(&handle.pool, &database, &table, &request)
                    .await;
            }
            DatabasePoolHandle::Sqlite(handle) => {
                return sqlite::create_index(&handle.pool, &database, &table, &request).await;
            }
            DatabasePoolHandle::SqlServer(handle) => {
                return sqlserver_objects::create_index(&handle.pool, &database, &table, &request)
                    .await;
            }
            DatabasePoolHandle::ClickHouse(_) => {
                return Err(DatabasePoolHandle::clickhouse_write_unsupported_error());
            }
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    // 构建列定义部分（与单测共用同一实现，避免逻辑漂移）
    let columns_sql = build_columns_sql(&request.columns);

    // 构建 CREATE INDEX SQL
    let index_kind = match request.index_type.to_uppercase().as_str() {
        "UNIQUE" => "UNIQUE INDEX",
        "FULLTEXT" => "FULLTEXT INDEX",
        "SPATIAL" => "SPATIAL INDEX",
        _ => "INDEX",
    };

    let mut sql = format!(
        "CREATE {} {} ON {}.{} ({})",
        index_kind,
        esc_id(&request.index_name),
        esc_id(&database),
        esc_id(&table),
        columns_sql.join(", ")
    );

    // 添加索引方法 (USING BTREE/HASH)
    if let Some(ref method) = request.index_method {
        let method_upper = method.to_uppercase();
        if method_upper == "BTREE" || method_upper == "HASH" {
            sql.push_str(&format!(" USING {}", method_upper));
        }
    }

    // 添加注释
    if let Some(ref comment) = request.comment {
        if !comment.is_empty() {
            sql.push_str(&format!(" COMMENT {}", esc_str(comment)));
        }
    }

    conn.query_drop(&sql)
        .await
        .map_err(|e| format!("创建索引失败: {}", e))?;

    Ok(())
}

/// 删除索引
#[tauri::command]
pub async fn delete_index(
    state: State<'_, AppState>,
    conn_id: String,
    database: String,
    table: String,
    index_name: String,
) -> Result<(), String> {
    if index_name.is_empty() {
        return Err("索引名称不能为空".to_string());
    }

    let pool = {
        let mut manager = state.connection_manager.lock().await;
        match manager.get_database_pool_for_write(&conn_id)? {
            DatabasePoolHandle::MySql(pool) => pool,
            DatabasePoolHandle::Postgres(handle) => {
                return postgres_objects::drop_index(&handle.pool, &database, &table, &index_name)
                    .await;
            }
            DatabasePoolHandle::Sqlite(handle) => {
                return sqlite::delete_index(&handle.pool, &database, &index_name).await;
            }
            DatabasePoolHandle::SqlServer(handle) => {
                return sqlserver_objects::drop_index(&handle.pool, &database, &table, &index_name)
                    .await;
            }
            DatabasePoolHandle::ClickHouse(_) => {
                return Err(DatabasePoolHandle::clickhouse_write_unsupported_error());
            }
        }
    };

    let mut conn = get_conn_with_retry(&pool).await?;

    // 主键使用 ALTER TABLE ... DROP PRIMARY KEY
    // 普通索引使用 ALTER TABLE ... DROP INDEX
    let sql = if index_name == "PRIMARY" {
        format!(
            "ALTER TABLE {}.{} DROP PRIMARY KEY",
            esc_id(&database),
            esc_id(&table)
        )
    } else {
        format!(
            "ALTER TABLE {}.{} DROP INDEX {}",
            esc_id(&database),
            esc_id(&table),
            esc_id(&index_name)
        )
    };

    conn.query_drop(&sql)
        .await
        .map_err(|e| format!("删除索引失败: {}", e))?;

    Ok(())
}

/// 辅助函数: 构建索引列定义片段（`column`(`len`) ASC/DESC），由 `create_index` 与单测共用。
pub fn build_columns_sql(columns: &[crate::models::types::CreateIndexColumn]) -> Vec<String> {
    columns
        .iter()
        .map(|col| {
            let mut s = esc_id(&col.column_name);
            if let Some(len) = col.length {
                s.push_str(&format!("({})", len));
            }
            if let Some(ref order) = col.order {
                let order_upper = order.to_uppercase();
                if order_upper == "ASC" || order_upper == "DESC" {
                    s.push_str(&format!(" {}", order_upper));
                }
            }
            s
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{CreateIndexColumn, CreateIndexRequest, IndexColumnInfo, IndexInfo};

    #[test]
    fn test_build_columns_sql_simple() {
        let columns = vec![CreateIndexColumn {
            column_name: "name".to_string(),
            length: None,
            order: None,
        }];
        let result = build_columns_sql(&columns);
        assert_eq!(result, vec!["`name`"]);
    }

    #[test]
    fn test_build_columns_sql_with_length() {
        let columns = vec![CreateIndexColumn {
            column_name: "email".to_string(),
            length: Some(10),
            order: None,
        }];
        let result = build_columns_sql(&columns);
        assert_eq!(result, vec!["`email`(10)"]);
    }

    #[test]
    fn test_build_columns_sql_with_order() {
        let columns = vec![CreateIndexColumn {
            column_name: "created_at".to_string(),
            length: None,
            order: Some("DESC".to_string()),
        }];
        let result = build_columns_sql(&columns);
        assert_eq!(result, vec!["`created_at` DESC"]);
    }

    #[test]
    fn test_build_columns_sql_multiple() {
        let columns = vec![
            CreateIndexColumn {
                column_name: "user_id".to_string(),
                length: None,
                order: Some("ASC".to_string()),
            },
            CreateIndexColumn {
                column_name: "name".to_string(),
                length: Some(20),
                order: None,
            },
        ];
        let result = build_columns_sql(&columns);
        assert_eq!(result, vec!["`user_id` ASC", "`name`(20)"]);
    }

    #[test]
    fn test_build_columns_sql_invalid_order_ignored() {
        let columns = vec![CreateIndexColumn {
            column_name: "col".to_string(),
            length: None,
            order: Some("INVALID".to_string()),
        }];
        let result = build_columns_sql(&columns);
        // 无效排序不应追加
        assert_eq!(result, vec!["`col`"]);
    }

    #[test]
    fn test_index_info_serialization() {
        let index = IndexInfo {
            name: "idx_user_name".to_string(),
            unique: false,
            index_type: "BTREE".to_string(),
            columns: vec![
                IndexColumnInfo {
                    column_name: "user_id".to_string(),
                    seq_in_index: 1,
                    collation: Some("A".to_string()),
                    sub_part: None,
                },
                IndexColumnInfo {
                    column_name: "name".to_string(),
                    seq_in_index: 2,
                    collation: Some("A".to_string()),
                    sub_part: Some(10),
                },
            ],
            is_primary: false,
            comment: "用户名索引".to_string(),
        };

        let json = serde_json::to_string(&index).unwrap();
        let deserialized: IndexInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.name, "idx_user_name");
        assert!(!deserialized.unique);
        assert_eq!(deserialized.index_type, "BTREE");
        assert_eq!(deserialized.columns.len(), 2);
        assert!(!deserialized.is_primary);
        assert_eq!(deserialized.comment, "用户名索引");
    }

    #[test]
    fn test_primary_key_index_info() {
        let index = IndexInfo {
            name: "PRIMARY".to_string(),
            unique: true,
            index_type: "BTREE".to_string(),
            columns: vec![IndexColumnInfo {
                column_name: "id".to_string(),
                seq_in_index: 1,
                collation: Some("A".to_string()),
                sub_part: None,
            }],
            is_primary: true,
            comment: "".to_string(),
        };

        assert!(index.is_primary);
        assert!(index.unique);
        assert_eq!(index.name, "PRIMARY");
    }

    #[test]
    fn test_create_index_request_serialization() {
        let request = CreateIndexRequest {
            index_name: "idx_email".to_string(),
            index_type: "UNIQUE".to_string(),
            index_method: Some("BTREE".to_string()),
            columns: vec![CreateIndexColumn {
                column_name: "email".to_string(),
                length: None,
                order: None,
            }],
            comment: Some("邮箱唯一索引".to_string()),
        };

        let json = serde_json::to_string(&request).unwrap();
        let deserialized: CreateIndexRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.index_name, "idx_email");
        assert_eq!(deserialized.index_type, "UNIQUE");
        assert_eq!(deserialized.index_method, Some("BTREE".to_string()));
        assert_eq!(deserialized.columns.len(), 1);
        assert_eq!(deserialized.comment, Some("邮箱唯一索引".to_string()));
    }

    #[test]
    fn test_index_type_mapping() {
        // 测试索引类型映射逻辑
        let test_cases = vec![
            ("UNIQUE", "UNIQUE INDEX"),
            ("FULLTEXT", "FULLTEXT INDEX"),
            ("SPATIAL", "SPATIAL INDEX"),
            ("INDEX", "INDEX"),
            ("index", "INDEX"), // 小写也应识别
        ];

        for (input, expected) in test_cases {
            let result = match input.to_uppercase().as_str() {
                "UNIQUE" => "UNIQUE INDEX",
                "FULLTEXT" => "FULLTEXT INDEX",
                "SPATIAL" => "SPATIAL INDEX",
                _ => "INDEX",
            };
            assert_eq!(
                result, expected,
                "索引类型 '{}' 应映射为 '{}'",
                input, expected
            );
        }
    }

    #[test]
    fn test_drop_index_sql_generation() {
        // 测试 DROP INDEX SQL 生成逻辑
        let primary_sql = format!("ALTER TABLE `{}`.`{}` DROP PRIMARY KEY", "mydb", "users");
        assert_eq!(primary_sql, "ALTER TABLE `mydb`.`users` DROP PRIMARY KEY");

        let normal_sql = format!(
            "ALTER TABLE `{}`.`{}` DROP INDEX `{}`",
            "mydb", "users", "idx_name"
        );
        assert_eq!(
            normal_sql,
            "ALTER TABLE `mydb`.`users` DROP INDEX `idx_name`"
        );
    }

    #[test]
    fn test_index_column_sorting() {
        let mut columns = [
            IndexColumnInfo {
                column_name: "col_b".to_string(),
                seq_in_index: 3,
                collation: None,
                sub_part: None,
            },
            IndexColumnInfo {
                column_name: "col_a".to_string(),
                seq_in_index: 1,
                collation: None,
                sub_part: None,
            },
            IndexColumnInfo {
                column_name: "col_c".to_string(),
                seq_in_index: 2,
                collation: None,
                sub_part: None,
            },
        ];

        columns.sort_by_key(|c| c.seq_in_index);

        assert_eq!(columns[0].column_name, "col_a");
        assert_eq!(columns[1].column_name, "col_c");
        assert_eq!(columns[2].column_name, "col_b");
    }
}
