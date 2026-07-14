use crate::db::sql_utils::{sqlserver_id, sqlserver_str};
use crate::db::sqlserver::{
    build_sqlserver_column_extra, format_sqlserver_column_type, normalize_sqlserver_error,
    SqlServerPool,
};
use crate::models::types::ColumnSnapshot;
use tiberius::Row;

use super::{rows_to_tables, SnapshotRow, TableSnapshot};

pub(crate) fn snapshot_sql(schema: &str) -> String {
    format!(
        "WITH primary_columns AS ( \
           SELECT index_columns.object_id, index_columns.column_id \
           FROM sys.indexes indexes \
           JOIN sys.index_columns index_columns \
             ON index_columns.object_id = indexes.object_id \
            AND index_columns.index_id = indexes.index_id \
           WHERE indexes.is_primary_key = 1 \
         ) \
         SELECT tables.name AS table_name, columns.name AS column_name, \
                columns.column_id AS ordinal_position, types.name AS type_name, \
                CAST(columns.max_length AS int) AS max_length, \
                CAST(columns.precision AS int) AS precision_value, \
                CAST(columns.scale AS int) AS scale_value, types.is_user_defined, \
                TYPE_SCHEMA_NAME(types.schema_id) AS type_schema, \
                columns.is_nullable, defaults.definition AS default_value, \
                CAST(CASE WHEN primary_columns.column_id IS NULL THEN 0 ELSE 1 END AS bit) AS primary_key, \
                columns.is_identity, computed.definition AS computed_definition, \
                COALESCE(CONVERT(nvarchar(4000), properties.value), N'') AS comment \
         FROM sys.tables tables \
         JOIN sys.schemas schemas ON schemas.schema_id = tables.schema_id \
         JOIN sys.columns columns ON columns.object_id = tables.object_id \
         JOIN sys.types types ON types.user_type_id = columns.user_type_id \
         LEFT JOIN sys.default_constraints defaults ON defaults.object_id = columns.default_object_id \
         LEFT JOIN sys.computed_columns computed \
           ON computed.object_id = columns.object_id AND computed.column_id = columns.column_id \
         LEFT JOIN primary_columns \
           ON primary_columns.object_id = columns.object_id AND primary_columns.column_id = columns.column_id \
         LEFT JOIN sys.extended_properties properties \
           ON properties.class = 1 AND properties.major_id = columns.object_id \
          AND properties.minor_id = columns.column_id AND properties.name = N'MS_Description' \
         WHERE schemas.name = N{} AND tables.is_ms_shipped = 0 \
         ORDER BY tables.name, columns.column_id, columns.name",
        sqlserver_str(schema)
    )
}

pub(crate) async fn load_snapshot(
    pool: &SqlServerPool,
    schema: &str,
) -> Result<Vec<TableSnapshot>, String> {
    let mut client = pool
        .get()
        .await
        .map_err(|e| normalize_sqlserver_error("获取连接失败", e.to_string()))?;
    let rows = client
        .simple_query(snapshot_sql(schema))
        .await
        .map_err(|e| normalize_sqlserver_error("查询对比元数据失败", e.to_string()))?
        .into_first_result()
        .await
        .map_err(|e| normalize_sqlserver_error("读取对比元数据失败", e.to_string()))?;
    let mapped = rows
        .iter()
        .map(|row| {
            let type_name = row_string(row, "type_name");
            let type_schema = row_string(row, "type_schema");
            let is_user_defined = row.get::<bool, _>("is_user_defined").unwrap_or(false);
            let ordinal_position = row.get::<i32, _>("ordinal_position").unwrap_or_default();
            SnapshotRow {
                table_name: row_string(row, "table_name"),
                column_name: row_string(row, "column_name"),
                details: ColumnSnapshot {
                    ordinal_position: u32::try_from(ordinal_position).unwrap_or_default(),
                    column_type: format_comparison_column_type(
                        &type_name,
                        &type_schema,
                        is_user_defined,
                        row.get::<i32, _>("max_length"),
                        row.get::<i32, _>("precision_value"),
                        row.get::<i32, _>("scale_value"),
                    ),
                    nullable: row.get::<bool, _>("is_nullable").unwrap_or(false),
                    default_value: row.get::<&str, _>("default_value").map(str::to_string),
                    primary_key: row.get::<bool, _>("primary_key").unwrap_or(false),
                    extra: build_sqlserver_column_extra(
                        row.get::<bool, _>("is_identity").unwrap_or(false),
                        row.get::<&str, _>("computed_definition")
                            .map(str::to_string),
                    ),
                    comment: row_string(row, "comment"),
                },
            }
        })
        .collect();
    Ok(rows_to_tables(mapped))
}

fn format_comparison_column_type(
    type_name: &str,
    type_schema: &str,
    is_user_defined: bool,
    max_length: Option<i32>,
    precision: Option<i32>,
    scale: Option<i32>,
) -> String {
    let display_name = if is_user_defined && !type_schema.is_empty() {
        format!("{}.{}", sqlserver_id(type_schema), sqlserver_id(type_name))
    } else {
        type_name.to_string()
    };
    format_sqlserver_column_type(&display_name, max_length, precision, scale, is_user_defined)
}

fn row_string(row: &Row, column: &str) -> String {
    row.get::<&str, _>(column)
        .map(str::to_string)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlserver_snapshot_query_filters_one_schema_and_physical_tables() {
        let sql = snapshot_sql("dbo");
        assert!(sql.contains("FROM sys.tables"));
        assert!(sql.contains("JOIN sys.columns"));
        assert!(sql.contains("TYPE_SCHEMA_NAME(types.schema_id) AS type_schema"));
        assert!(sql.contains("indexes.is_primary_key = 1"));
        assert!(sql.contains("schemas.name = N'dbo'"));
        assert!(!sql.contains("sys.views"));
    }

    #[test]
    fn sqlserver_user_defined_types_include_their_schema() {
        assert_eq!(
            format_comparison_column_type("Phone", "billing", true, None, None, None),
            "[billing].[Phone]"
        );
        assert_eq!(
            format_comparison_column_type("Phone", "crm", true, None, None, None),
            "[crm].[Phone]"
        );
    }
}
