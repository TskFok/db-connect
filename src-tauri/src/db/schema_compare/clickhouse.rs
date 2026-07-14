use crate::db::clickhouse::{deserialize_u64, fetch_json_each_rows};
use crate::models::types::ColumnSnapshot;
use clickhouse_rs::Client;
use serde::Deserialize;

use super::{rows_to_tables, SnapshotRow, TableSnapshot};

pub(crate) fn snapshot_sql() -> &'static str {
    "SELECT tables.name AS table_name, columns.name AS column_name, \
            columns.position AS ordinal_position, columns.type AS column_type, \
            startsWith(columns.type, 'Nullable(') AS nullable, \
            if(columns.default_kind = '', NULL, columns.default_expression) AS default_value, \
            columns.is_in_primary_key AS primary_key, \
            lower(columns.default_kind) AS extra, columns.comment AS comment \
     FROM system.tables AS tables \
     JOIN system.columns AS columns \
       ON columns.database = tables.database AND columns.table = tables.name \
     WHERE tables.database = ? \
       AND tables.engine NOT IN ('View', 'MaterializedView', 'LiveView', 'WindowView') \
     ORDER BY tables.name, columns.position, columns.name"
}

#[derive(Debug, Deserialize)]
struct ClickHouseSnapshotRow {
    table_name: String,
    column_name: String,
    #[serde(deserialize_with = "deserialize_u64")]
    ordinal_position: u64,
    column_type: String,
    nullable: u8,
    default_value: Option<String>,
    primary_key: u8,
    extra: String,
    comment: String,
}

pub(crate) async fn load_snapshot(
    client: &Client,
    database: &str,
) -> Result<Vec<TableSnapshot>, String> {
    let rows: Vec<ClickHouseSnapshotRow> = fetch_json_each_rows(
        client.query(snapshot_sql()).bind(database),
        "查询 ClickHouse 对比元数据失败",
    )
    .await?;
    let mapped = rows
        .into_iter()
        .map(|row| SnapshotRow {
            table_name: row.table_name,
            column_name: row.column_name,
            details: ColumnSnapshot {
                ordinal_position: u32::try_from(row.ordinal_position).unwrap_or_default(),
                column_type: row.column_type,
                nullable: row.nullable != 0,
                default_value: row.default_value,
                primary_key: row.primary_key != 0,
                extra: row.extra,
                comment: row.comment,
            },
        })
        .collect();
    Ok(rows_to_tables(mapped))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clickhouse_snapshot_query_joins_tables_and_columns_once() {
        let sql = snapshot_sql();
        assert!(sql.contains("FROM system.tables AS tables"));
        assert!(sql.contains("JOIN system.columns AS columns"));
        assert!(sql.contains("tables.database = ?"));
        assert!(sql.contains("NOT IN ('View', 'MaterializedView', 'LiveView', 'WindowView')"));
    }
}
