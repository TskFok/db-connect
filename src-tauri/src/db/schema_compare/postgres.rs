use crate::db::postgres::get_client_with_retry;
use crate::models::types::ColumnSnapshot;
use deadpool_postgres::Pool as PgPool;

use super::{rows_to_tables, SnapshotRow, TableSnapshot};

pub(crate) fn snapshot_sql() -> &'static str {
    "SELECT cls.relname AS table_name, cols.column_name, cols.ordinal_position, \
            CASE \
              WHEN cols.data_type = 'USER-DEFINED' THEN cols.udt_name \
              WHEN cols.character_maximum_length IS NOT NULL THEN cols.data_type || '(' || cols.character_maximum_length || ')' \
              WHEN cols.numeric_precision IS NOT NULL AND cols.numeric_scale IS NOT NULL THEN cols.data_type || '(' || cols.numeric_precision || ',' || cols.numeric_scale || ')' \
              WHEN cols.numeric_precision IS NOT NULL THEN cols.data_type || '(' || cols.numeric_precision || ')' \
              ELSE cols.data_type \
            END AS column_type, \
            cols.is_nullable = 'YES' AS nullable, cols.column_default, \
            pk.column_name IS NOT NULL AS primary_key, \
            trim(concat_ws(' ', \
              CASE WHEN cols.is_identity = 'YES' THEN 'identity' END, \
              CASE WHEN cols.is_generated <> 'NEVER' THEN lower(cols.is_generated) || ' generated' END \
            )) AS extra, \
            COALESCE(description.description, '') AS comment \
     FROM pg_catalog.pg_class cls \
     JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace \
     JOIN information_schema.columns cols \
       ON cols.table_schema = ns.nspname AND cols.table_name = cls.relname \
     LEFT JOIN ( \
       SELECT kcu.table_schema, kcu.table_name, kcu.column_name \
       FROM information_schema.table_constraints tc \
       JOIN information_schema.key_column_usage kcu \
         ON kcu.constraint_schema = tc.constraint_schema \
        AND kcu.constraint_name = tc.constraint_name \
        AND kcu.table_schema = tc.table_schema \
        AND kcu.table_name = tc.table_name \
       WHERE tc.constraint_type = 'PRIMARY KEY' \
     ) pk ON pk.table_schema = cols.table_schema \
         AND pk.table_name = cols.table_name AND pk.column_name = cols.column_name \
     LEFT JOIN pg_catalog.pg_attribute attr \
       ON attr.attrelid = cls.oid AND attr.attname = cols.column_name \
     LEFT JOIN pg_catalog.pg_description description \
       ON description.objoid = cls.oid AND description.objsubid = attr.attnum \
     WHERE cols.table_schema = $1 AND cls.relkind IN ('r', 'p') \
     ORDER BY cls.relname, cols.ordinal_position, cols.column_name"
}

pub(crate) async fn load_snapshot(
    pool: &PgPool,
    schema: &str,
) -> Result<Vec<TableSnapshot>, String> {
    let client = get_client_with_retry(pool).await?;
    let rows = client
        .query(snapshot_sql(), &[&schema])
        .await
        .map_err(|e| format!("查询 PostgreSQL 对比元数据失败: {}", e))?;
    let mapped = rows
        .into_iter()
        .map(|row| {
            let ordinal_position = row.get::<_, i32>("ordinal_position");
            SnapshotRow {
                table_name: row.get("table_name"),
                column_name: row.get("column_name"),
                details: ColumnSnapshot {
                    ordinal_position: u32::try_from(ordinal_position).unwrap_or_default(),
                    column_type: row.get("column_type"),
                    nullable: row.get("nullable"),
                    default_value: row.get("column_default"),
                    primary_key: row.get("primary_key"),
                    extra: row.get("extra"),
                    comment: row.get("comment"),
                },
            }
        })
        .collect();
    Ok(rows_to_tables(mapped))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn postgres_snapshot_query_reads_all_physical_table_columns_once() {
        let sql = snapshot_sql();
        assert!(sql.contains("information_schema.columns"));
        assert!(sql.contains("cls.relkind IN ('r', 'p')"));
        assert!(sql.contains("cols.table_schema = $1"));
        assert!(!sql.contains("table_name = $2"));
    }
}
