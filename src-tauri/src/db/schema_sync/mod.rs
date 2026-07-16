use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::db::schema_compare::TableSnapshot;
use crate::models::types::{
    DatabaseSyncBlocker, DatabaseSyncOperation, DatabaseSyncOperationKind, DatabaseSyncPlanSummary,
    DatabaseSyncPreview, DatabaseSyncRequest, DatabaseSyncRisk, DatabaseSyncSkippedItem,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) enum ColumnSyncMetadata {
    MySql {
        generation_expression: String,
    },
    Postgres {
        identity_generation: String,
        generated_kind: String,
        generation_expression: Option<String>,
    },
    Sqlite {
        hidden: i64,
    },
    SqlServer {
        is_identity: bool,
        computed_definition: Option<String>,
        is_user_defined: bool,
        type_schema: String,
        type_name: String,
    },
    ClickHouse {
        default_kind: String,
        default_expression: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) enum TableSyncMetadata {
    MySql {
        engine: String,
        comment: String,
        columns: BTreeMap<String, ColumnSyncMetadata>,
    },
    Postgres {
        relkind: String,
        table_comment: String,
        primary_key_constraint: Option<String>,
        columns: BTreeMap<String, ColumnSyncMetadata>,
    },
    Sqlite {
        create_sql: String,
        columns: BTreeMap<String, ColumnSyncMetadata>,
    },
    SqlServer {
        table_comment: String,
        primary_key_constraint: Option<String>,
        columns: BTreeMap<String, ColumnSyncMetadata>,
    },
    ClickHouse {
        engine_full: String,
        sorting_key: String,
        partition_key: String,
        primary_key: String,
        comment: String,
        columns: BTreeMap<String, ColumnSyncMetadata>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct SyncSchemaSnapshot {
    pub tables: Vec<TableSnapshot>,
    pub metadata: BTreeMap<String, TableSyncMetadata>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum OperationPhase {
    CreateTable,
    AddColumn,
    AlterColumn,
    DropColumn,
    DropTable,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingOperation {
    phase: OperationPhase,
    table_name: String,
    kind: DatabaseSyncOperationKind,
    summary: String,
    risk: DatabaseSyncRisk,
    sql: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct PlanFragments {
    pub operations: Vec<PendingOperation>,
    pub skipped_items: Vec<DatabaseSyncSkippedItem>,
    pub blockers: Vec<DatabaseSyncBlocker>,
}

impl PlanFragments {
    pub fn operation(
        &mut self,
        phase: OperationPhase,
        table_name: &str,
        kind: DatabaseSyncOperationKind,
        risk: DatabaseSyncRisk,
        summary: &str,
        sql: Vec<String>,
    ) {
        self.operations.push(PendingOperation {
            phase,
            table_name: table_name.to_string(),
            kind,
            summary: summary.to_string(),
            risk,
            sql,
        });
    }

    pub fn skip(&mut self, table_name: &str, summary: &str, reason: &str) {
        self.skipped_items.push(DatabaseSyncSkippedItem {
            table_name: table_name.to_string(),
            summary: summary.to_string(),
            reason: reason.to_string(),
        });
    }

    pub fn block(&mut self, table_name: &str, summary: &str, reason: &str) {
        self.blockers.push(DatabaseSyncBlocker {
            table_name: table_name.to_string(),
            summary: summary.to_string(),
            reason: reason.to_string(),
        });
    }
}

pub(crate) struct TablePlanContext<'a> {
    pub target_database: &'a str,
    pub source: Option<&'a TableSnapshot>,
    pub target: Option<&'a TableSnapshot>,
    pub source_metadata: Option<&'a TableSyncMetadata>,
    pub target_metadata: Option<&'a TableSyncMetadata>,
    pub include_drops: bool,
}

fn normalize_selected_tables(values: &[String]) -> Result<Vec<String>, String> {
    let tables = values
        .iter()
        .map(|value| value.trim())
        .map(|value| {
            if value.is_empty() {
                Err("同步表名不能为空".to_string())
            } else {
                Ok(value.to_string())
            }
        })
        .collect::<Result<BTreeSet<_>, _>>()?
        .into_iter()
        .collect::<Vec<_>>();
    if tables.is_empty() {
        return Err("请至少选择一张差异表".to_string());
    }
    Ok(tables)
}

#[derive(Serialize)]
struct FingerprintPayload<'a> {
    request: &'a DatabaseSyncRequest,
    source_tables: BTreeMap<&'a str, (&'a TableSnapshot, Option<&'a TableSyncMetadata>)>,
    target_tables: BTreeMap<&'a str, (&'a TableSnapshot, Option<&'a TableSyncMetadata>)>,
    operations: &'a [DatabaseSyncOperation],
    skipped_items: &'a [DatabaseSyncSkippedItem],
    blockers: &'a [DatabaseSyncBlocker],
}

pub(crate) fn finalize_preview(
    request: &DatabaseSyncRequest,
    source: &SyncSchemaSnapshot,
    target: &SyncSchemaSnapshot,
    mut fragments: PlanFragments,
) -> Result<DatabaseSyncPreview, String> {
    let selected = normalize_selected_tables(&request.selected_tables)?;
    fragments.operations.sort_by(|left, right| {
        left.phase
            .cmp(&right.phase)
            .then_with(|| left.table_name.cmp(&right.table_name))
            .then_with(|| left.summary.cmp(&right.summary))
    });
    fragments.skipped_items.sort_by(|a, b| {
        a.table_name
            .cmp(&b.table_name)
            .then_with(|| a.summary.cmp(&b.summary))
    });
    fragments.blockers.sort_by(|a, b| {
        a.table_name
            .cmp(&b.table_name)
            .then_with(|| a.summary.cmp(&b.summary))
    });
    let operations = fragments
        .operations
        .into_iter()
        .enumerate()
        .map(|(index, operation)| {
            let identity = format!(
                "{}\0{}\0{}",
                index + 1,
                operation.table_name,
                operation_kind_key(operation.kind),
            );
            let suffix = format!("{:x}", Sha256::digest(identity.as_bytes()));
            DatabaseSyncOperation {
                id: format!("op-{:04}-{}", index + 1, &suffix[..12]),
                table_name: operation.table_name,
                kind: operation.kind,
                summary: operation.summary,
                risk: operation.risk,
                sql: operation.sql,
            }
        })
        .collect::<Vec<_>>();
    let summary = DatabaseSyncPlanSummary {
        selected_tables: selected.len(),
        executable_operations: operations.len(),
        high_risk_operations: operations
            .iter()
            .filter(|item| item.risk == DatabaseSyncRisk::High)
            .count(),
        destructive_operations: operations
            .iter()
            .filter(|item| item.risk == DatabaseSyncRisk::Destructive)
            .count(),
        skipped_items: fragments.skipped_items.len(),
        blockers: fragments.blockers.len(),
    };
    let source_map = source
        .tables
        .iter()
        .filter(|table| selected.binary_search(&table.name).is_ok())
        .map(|table| {
            (
                table.name.as_str(),
                (table, source.metadata.get(&table.name)),
            )
        })
        .collect();
    let target_map = target
        .tables
        .iter()
        .filter(|table| selected.binary_search(&table.name).is_ok())
        .map(|table| {
            (
                table.name.as_str(),
                (table, target.metadata.get(&table.name)),
            )
        })
        .collect();
    let mut canonical_request = request.clone();
    canonical_request.selected_tables = selected;
    let payload = FingerprintPayload {
        request: &canonical_request,
        source_tables: source_map,
        target_tables: target_map,
        operations: &operations,
        skipped_items: &fragments.skipped_items,
        blockers: &fragments.blockers,
    };
    let bytes =
        serde_json::to_vec(&payload).map_err(|error| format!("生成同步计划指纹失败: {error}"))?;
    let plan_fingerprint = format!("{:x}", Sha256::digest(bytes));
    let can_execute = !operations.is_empty() && fragments.blockers.is_empty();
    Ok(DatabaseSyncPreview {
        plan_fingerprint,
        summary,
        operations,
        skipped_items: fragments.skipped_items,
        blockers: fragments.blockers,
        can_execute,
    })
}

fn operation_kind_key(kind: DatabaseSyncOperationKind) -> &'static str {
    match kind {
        DatabaseSyncOperationKind::CreateTable => "create_table",
        DatabaseSyncOperationKind::AddColumn => "add_column",
        DatabaseSyncOperationKind::AlterColumn => "alter_column",
        DatabaseSyncOperationKind::ReplacePrimaryKey => "replace_primary_key",
        DatabaseSyncOperationKind::DropColumn => "drop_column",
        DatabaseSyncOperationKind::DropTable => "drop_table",
        DatabaseSyncOperationKind::UpdateComment => "update_comment",
    }
}

pub(crate) fn primary_key_columns(table: &TableSnapshot) -> Vec<String> {
    table
        .columns
        .iter()
        .filter(|(_, details)| details.primary_key)
        .map(|(name, _)| name.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{
        ColumnSnapshot, DatabaseCompareEndpointRequest, DatabaseSyncOperationKind,
        DatabaseSyncRequest, DatabaseSyncRisk,
    };

    fn request(selected_tables: Vec<&str>, include_drops: bool) -> DatabaseSyncRequest {
        DatabaseSyncRequest {
            source: DatabaseCompareEndpointRequest {
                saved_connection_id: "source".to_string(),
                database: "app".to_string(),
            },
            target: DatabaseCompareEndpointRequest {
                saved_connection_id: "target".to_string(),
                database: "app_copy".to_string(),
            },
            selected_tables: selected_tables.into_iter().map(str::to_string).collect(),
            include_drops,
        }
    }

    fn table(name: &str, column_type: &str) -> TableSnapshot {
        TableSnapshot {
            name: name.to_string(),
            columns: vec![(
                "id".to_string(),
                ColumnSnapshot {
                    ordinal_position: 1,
                    column_type: column_type.to_string(),
                    nullable: false,
                    default_value: None,
                    primary_key: true,
                    extra: String::new(),
                    comment: String::new(),
                },
            )],
        }
    }

    fn snapshot(tables: Vec<TableSnapshot>) -> SyncSchemaSnapshot {
        SyncSchemaSnapshot {
            tables,
            metadata: BTreeMap::new(),
        }
    }

    #[test]
    fn preview_normalizes_selection_orders_operations_and_summarizes_risk() {
        let mut fragments = PlanFragments::default();
        fragments.operation(
            OperationPhase::DropTable,
            "z_logs",
            DatabaseSyncOperationKind::DropTable,
            DatabaseSyncRisk::Destructive,
            "删除目标端表 z_logs",
            vec!["DROP TABLE `app_copy`.`z_logs`".to_string()],
        );
        fragments.operation(
            OperationPhase::CreateTable,
            "a_users",
            DatabaseSyncOperationKind::CreateTable,
            DatabaseSyncRisk::Normal,
            "创建表 a_users",
            vec!["CREATE TABLE `app_copy`.`a_users` (`id` bigint)".to_string()],
        );

        let source = snapshot(vec![table("a_users", "bigint")]);
        let target = snapshot(vec![table("z_logs", "bigint")]);
        let preview = finalize_preview(
            &request(vec!["z_logs", "a_users", "z_logs"], true),
            &source,
            &target,
            fragments,
        )
        .unwrap();

        assert_eq!(preview.summary.selected_tables, 2);
        assert_eq!(preview.summary.executable_operations, 2);
        assert_eq!(preview.summary.destructive_operations, 1);
        assert_eq!(preview.operations[0].table_name, "a_users");
        assert_eq!(preview.operations[1].table_name, "z_logs");
        assert!(preview.can_execute);
        assert_eq!(preview.plan_fingerprint.len(), 64);
    }

    #[test]
    fn preview_fingerprint_changes_when_relevant_snapshot_changes() {
        let fragments = PlanFragments::default();
        let first_source = snapshot(vec![table("users", "bigint")]);
        let second_source = snapshot(vec![table("users", "uuid")]);
        let target = snapshot(vec![table("users", "int")]);
        let first = finalize_preview(
            &request(vec!["users"], false),
            &first_source,
            &target,
            fragments.clone(),
        )
        .unwrap();
        let second = finalize_preview(
            &request(vec!["users"], false),
            &second_source,
            &target,
            fragments,
        )
        .unwrap();

        assert_ne!(first.plan_fingerprint, second.plan_fingerprint);
    }

    #[test]
    fn preview_fingerprint_is_stable_and_includes_native_column_metadata() {
        let mut first_source = snapshot(vec![table("users", "bigint")]);
        first_source.metadata.insert(
            "users".to_string(),
            TableSyncMetadata::MySql {
                engine: "InnoDB".to_string(),
                comment: String::new(),
                columns: BTreeMap::from([(
                    "id".to_string(),
                    ColumnSyncMetadata::MySql {
                        generation_expression: String::new(),
                    },
                )]),
            },
        );
        let mut changed_source = first_source.clone();
        changed_source.metadata.insert(
            "users".to_string(),
            TableSyncMetadata::MySql {
                engine: "InnoDB".to_string(),
                comment: String::new(),
                columns: BTreeMap::from([(
                    "id".to_string(),
                    ColumnSyncMetadata::MySql {
                        generation_expression: "id + 1".to_string(),
                    },
                )]),
            },
        );
        let target = snapshot(vec![table("users", "int")]);
        let first = finalize_preview(
            &request(vec!["users"], false),
            &first_source,
            &target,
            PlanFragments::default(),
        )
        .unwrap();
        let same = finalize_preview(
            &request(vec!["users"], false),
            &first_source,
            &target,
            PlanFragments::default(),
        )
        .unwrap();
        let changed = finalize_preview(
            &request(vec!["users"], false),
            &changed_source,
            &target,
            PlanFragments::default(),
        )
        .unwrap();
        assert_eq!(first.plan_fingerprint, same.plan_fingerprint);
        assert_ne!(first.plan_fingerprint, changed.plan_fingerprint);
    }

    #[test]
    fn preview_rejects_empty_selection() {
        let error = finalize_preview(
            &request(vec![], false),
            &snapshot(Vec::new()),
            &snapshot(Vec::new()),
            PlanFragments::default(),
        )
        .unwrap_err();
        assert_eq!(error, "请至少选择一张差异表");
    }
}
