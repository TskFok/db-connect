use crate::db::connection::get_conn_with_retry;
use crate::models::types::ColumnSnapshot;
use mysql_async::{params, prelude::Queryable, Pool};

use super::{rows_to_tables, SnapshotRow, TableSnapshot};

pub(crate) fn snapshot_sql() -> &'static str {
    "SELECT t.TABLE_NAME AS table_name, \
            c.COLUMN_NAME AS column_name, \
            c.ORDINAL_POSITION AS ordinal_position, \
            c.COLUMN_TYPE AS column_type, \
            c.IS_NULLABLE = 'YES' AS nullable, \
            c.COLUMN_DEFAULT AS default_value, \
            c.COLUMN_KEY = 'PRI' AS primary_key, \
            c.EXTRA AS extra, \
            c.COLUMN_COMMENT AS comment \
     FROM information_schema.TABLES t \
     JOIN information_schema.COLUMNS c \
       ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME \
     WHERE t.TABLE_SCHEMA = :schema \
       AND t.TABLE_TYPE = 'BASE TABLE' \
     ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION, c.COLUMN_NAME"
}

pub(crate) async fn load_snapshot(pool: &Pool, schema: &str) -> Result<Vec<TableSnapshot>, String> {
    let mut conn = get_conn_with_retry(pool).await?;
    let rows: Vec<mysql_async::Row> = conn
        .exec(snapshot_sql(), params! { "schema" => schema })
        .await
        .map_err(|e| format!("查询 MySQL 对比元数据失败: {}", e))?;
    let mapped = rows
        .into_iter()
        .map(|row| SnapshotRow {
            table_name: row.get::<String, _>("table_name").unwrap_or_default(),
            column_name: row.get::<String, _>("column_name").unwrap_or_default(),
            details: ColumnSnapshot {
                ordinal_position: row.get::<u32, _>("ordinal_position").unwrap_or_default(),
                column_type: row.get::<String, _>("column_type").unwrap_or_default(),
                nullable: row.get::<i8, _>("nullable").unwrap_or_default() != 0,
                default_value: row.get::<Option<String>, _>("default_value").flatten(),
                primary_key: row.get::<i8, _>("primary_key").unwrap_or_default() != 0,
                extra: row.get::<String, _>("extra").unwrap_or_default(),
                comment: row.get::<String, _>("comment").unwrap_or_default(),
            },
        })
        .collect();
    Ok(rows_to_tables(mapped))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_snapshot_query_reads_all_base_table_columns_once() {
        let sql = snapshot_sql();
        assert!(sql.contains("information_schema.TABLES"));
        assert!(sql.contains("information_schema.COLUMNS"));
        assert!(sql.contains("TABLE_TYPE = 'BASE TABLE'"));
        assert!(sql.contains("t.TABLE_SCHEMA = :schema"));
        assert!(!sql.contains(":table"));
    }
}
