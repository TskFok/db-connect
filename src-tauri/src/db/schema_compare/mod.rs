use std::collections::BTreeMap;

use crate::models::types::{
    ColumnDiff, ColumnSnapshot, CompareEndpointInfo, DatabaseCompareResult, DatabaseCompareSummary,
    DatabaseType, SchemaDiffStatus, TableDiff,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SnapshotRow {
    pub table_name: String,
    pub column_name: String,
    pub details: ColumnSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TableSnapshot {
    pub name: String,
    pub columns: Vec<(String, ColumnSnapshot)>,
}

pub(crate) fn rows_to_tables(rows: Vec<SnapshotRow>) -> Vec<TableSnapshot> {
    let mut tables: BTreeMap<String, Vec<(String, ColumnSnapshot)>> = BTreeMap::new();
    for row in rows {
        tables
            .entry(row.table_name)
            .or_default()
            .push((row.column_name, row.details));
    }
    tables
        .into_iter()
        .map(|(name, mut columns)| {
            columns.sort_by(|a, b| {
                a.1.ordinal_position
                    .cmp(&b.1.ordinal_position)
                    .then_with(|| a.0.cmp(&b.0))
            });
            TableSnapshot { name, columns }
        })
        .collect()
}

fn changed_fields(source: &ColumnSnapshot, target: &ColumnSnapshot) -> Vec<String> {
    let checks = [
        (
            "ordinal_position",
            source.ordinal_position != target.ordinal_position,
        ),
        ("column_type", source.column_type != target.column_type),
        ("nullable", source.nullable != target.nullable),
        (
            "default_value",
            source.default_value != target.default_value,
        ),
        ("primary_key", source.primary_key != target.primary_key),
        ("extra", source.extra != target.extra),
        ("comment", source.comment != target.comment),
    ];
    checks
        .into_iter()
        .filter_map(|(name, changed)| changed.then(|| name.to_string()))
        .collect()
}

pub(crate) fn compare_schema_snapshots(
    database_type: DatabaseType,
    source: CompareEndpointInfo,
    target: CompareEndpointInfo,
    compared_at: String,
    source_tables: Vec<TableSnapshot>,
    target_tables: Vec<TableSnapshot>,
) -> DatabaseCompareResult {
    let mut tables: BTreeMap<
        String,
        (
            Option<Vec<(String, ColumnSnapshot)>>,
            Option<Vec<(String, ColumnSnapshot)>>,
        ),
    > = BTreeMap::new();

    for table in source_tables {
        tables.entry(table.name).or_default().0 = Some(table.columns);
    }
    for table in target_tables {
        tables.entry(table.name).or_default().1 = Some(table.columns);
    }

    let mut summary = DatabaseCompareSummary::default();
    let mut table_diffs = Vec::new();

    for (name, (source_columns, target_columns)) in tables {
        match (source_columns, target_columns) {
            (Some(_), None) => {
                summary.source_only_tables += 1;
                table_diffs.push(TableDiff {
                    name,
                    status: SchemaDiffStatus::SourceOnly,
                    columns: Vec::new(),
                });
            }
            (None, Some(_)) => {
                summary.target_only_tables += 1;
                table_diffs.push(TableDiff {
                    name,
                    status: SchemaDiffStatus::TargetOnly,
                    columns: Vec::new(),
                });
            }
            (Some(source_columns), Some(target_columns)) => {
                let columns = compare_columns(source_columns, target_columns);
                if !columns.is_empty() {
                    summary.changed_tables += 1;
                    summary.different_columns += columns.len();
                    table_diffs.push(TableDiff {
                        name,
                        status: SchemaDiffStatus::Changed,
                        columns,
                    });
                }
            }
            (None, None) => unreachable!("表必须至少存在于一侧"),
        }
    }

    DatabaseCompareResult {
        database_type,
        source,
        target,
        compared_at,
        summary,
        tables: table_diffs,
    }
}

fn compare_columns(
    source_columns: Vec<(String, ColumnSnapshot)>,
    target_columns: Vec<(String, ColumnSnapshot)>,
) -> Vec<ColumnDiff> {
    let mut columns: BTreeMap<String, (Option<ColumnSnapshot>, Option<ColumnSnapshot>)> =
        BTreeMap::new();

    for (name, details) in source_columns {
        columns.entry(name).or_default().0 = Some(details);
    }
    for (name, details) in target_columns {
        columns.entry(name).or_default().1 = Some(details);
    }

    let mut differences = columns
        .into_iter()
        .filter_map(|(name, (source, target))| match (&source, &target) {
            (Some(source_details), Some(target_details)) => {
                let changed_fields = changed_fields(source_details, target_details);
                (!changed_fields.is_empty()).then(|| ColumnDiff {
                    name,
                    status: SchemaDiffStatus::Changed,
                    changed_fields,
                    source,
                    target,
                })
            }
            (Some(_), None) => Some(ColumnDiff {
                name,
                status: SchemaDiffStatus::SourceOnly,
                changed_fields: Vec::new(),
                source,
                target,
            }),
            (None, Some(_)) => Some(ColumnDiff {
                name,
                status: SchemaDiffStatus::TargetOnly,
                changed_fields: Vec::new(),
                source,
                target,
            }),
            (None, None) => unreachable!("字段必须至少存在于一侧"),
        })
        .collect::<Vec<_>>();

    differences.sort_by(|a, b| {
        column_position(a)
            .cmp(&column_position(b))
            .then_with(|| a.name.cmp(&b.name))
    });
    differences
}

fn column_position(column: &ColumnDiff) -> u32 {
    match (&column.source, &column.target) {
        (Some(source), Some(target)) => source.ordinal_position.min(target.ordinal_position),
        (Some(source), None) => source.ordinal_position,
        (None, Some(target)) => target.ordinal_position,
        (None, None) => unreachable!("差异字段必须至少存在于一侧"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{CompareEndpointInfo, DatabaseType};

    fn endpoint(id: &str, name: &str, database: &str) -> CompareEndpointInfo {
        CompareEndpointInfo {
            connection_id: id.to_string(),
            connection_name: name.to_string(),
            database: database.to_string(),
        }
    }

    fn row(table: &str, column: &str, position: u32, column_type: &str) -> SnapshotRow {
        SnapshotRow {
            table_name: table.to_string(),
            column_name: column.to_string(),
            details: ColumnSnapshot {
                ordinal_position: position,
                column_type: column_type.to_string(),
                nullable: false,
                default_value: None,
                primary_key: column == "id",
                extra: String::new(),
                comment: String::new(),
            },
        }
    }

    #[test]
    fn compare_reports_table_and_column_differences_in_stable_order() {
        let source = rows_to_tables(vec![
            row("users", "name", 2, "varchar(100)"),
            row("users", "id", 1, "bigint"),
            row("source_only", "id", 1, "bigint"),
        ]);
        let target = rows_to_tables(vec![
            row("target_only", "id", 1, "bigint"),
            row("users", "id", 1, "bigint"),
            row("users", "email", 2, "varchar(255)"),
        ]);

        let result = compare_schema_snapshots(
            DatabaseType::MySql,
            endpoint("source", "源端", "app"),
            endpoint("target", "目标端", "app"),
            "2026-07-14T00:00:00Z".to_string(),
            source,
            target,
        );

        assert_eq!(
            result
                .tables
                .iter()
                .map(|table| table.name.as_str())
                .collect::<Vec<_>>(),
            vec!["source_only", "target_only", "users"]
        );
        assert_eq!(result.summary.source_only_tables, 1);
        assert_eq!(result.summary.target_only_tables, 1);
        assert_eq!(result.summary.changed_tables, 1);
        assert_eq!(result.summary.different_columns, 2);
        assert_eq!(result.tables[2].columns[0].name, "email");
        assert_eq!(result.tables[2].columns[1].name, "name");
    }

    #[test]
    fn compare_omits_identical_tables_and_lists_all_changed_fields() {
        let base = row("users", "id", 1, "bigint");
        let mut changed = base.clone();
        changed.details = ColumnSnapshot {
            ordinal_position: 2,
            column_type: "int".to_string(),
            nullable: true,
            default_value: Some("0".to_string()),
            primary_key: false,
            extra: "identity".to_string(),
            comment: "新注释".to_string(),
        };

        let result = compare_schema_snapshots(
            DatabaseType::MySql,
            endpoint("source", "源端", "app"),
            endpoint("target", "目标端", "app"),
            "2026-07-14T00:00:00Z".to_string(),
            rows_to_tables(vec![base]),
            rows_to_tables(vec![changed]),
        );

        assert_eq!(result.tables.len(), 1);
        assert_eq!(
            result.tables[0].columns[0].changed_fields,
            vec![
                "ordinal_position",
                "column_type",
                "nullable",
                "default_value",
                "primary_key",
                "extra",
                "comment"
            ]
        );

        let identical = compare_schema_snapshots(
            DatabaseType::MySql,
            endpoint("source", "源端", "app"),
            endpoint("target", "目标端", "app"),
            "2026-07-14T00:00:00Z".to_string(),
            rows_to_tables(vec![row("same", "id", 1, "bigint")]),
            rows_to_tables(vec![row("same", "id", 1, "bigint")]),
        );
        assert!(identical.tables.is_empty());
    }
}
