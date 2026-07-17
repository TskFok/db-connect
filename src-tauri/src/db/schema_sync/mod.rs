use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::db::schema_compare::TableSnapshot;
use crate::models::types::{
    DatabaseSyncBlocker, DatabaseSyncOperation, DatabaseSyncOperationKind, DatabaseSyncPlanSummary,
    DatabaseSyncPreview, DatabaseSyncRequest, DatabaseSyncRisk, DatabaseSyncSkippedItem,
};

pub(crate) mod mysql;
pub(crate) mod postgres;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) enum ColumnSyncMetadata {
    MySql {
        generation_expression: String,
        primary_key_ordinal: Option<u32>,
    },
    Postgres {
        identity_generation: String,
        generated_kind: String,
        generation_expression: Option<String>,
        default_expression: Option<String>,
        is_user_defined: bool,
        type_schema: String,
        type_name: String,
        primary_key_ordinal: Option<u32>,
    },
    #[allow(dead_code, reason = "将在后续 SQLite 同步方言中使用")]
    Sqlite { hidden: i64 },
    #[allow(dead_code, reason = "将在后续 SQL Server 同步方言中使用")]
    SqlServer {
        is_identity: bool,
        computed_definition: Option<String>,
        is_user_defined: bool,
        type_schema: String,
        type_name: String,
    },
    #[allow(dead_code, reason = "将在后续 ClickHouse 同步方言中使用")]
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
    #[allow(dead_code, reason = "将在后续 SQLite 同步方言中使用")]
    Sqlite {
        create_sql: String,
        columns: BTreeMap<String, ColumnSyncMetadata>,
    },
    #[allow(dead_code, reason = "将在后续 SQL Server 同步方言中使用")]
    SqlServer {
        table_comment: String,
        primary_key_constraint: Option<String>,
        columns: BTreeMap<String, ColumnSyncMetadata>,
    },
    #[allow(dead_code, reason = "将在后续 ClickHouse 同步方言中使用")]
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
#[allow(dead_code, reason = "将在后续方言快照加载中构造")]
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

#[allow(dead_code, reason = "暂仅由后续命令尚未接入的计划收口调用")]
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
#[allow(dead_code, reason = "暂仅由后续命令尚未接入的计划收口构造")]
struct FingerprintPayload<'a> {
    request: &'a DatabaseSyncRequest,
    source_tables: BTreeMap<&'a str, (TableSnapshot, Option<&'a TableSyncMetadata>)>,
    target_tables: BTreeMap<&'a str, (TableSnapshot, Option<&'a TableSyncMetadata>)>,
    operations: &'a [DatabaseSyncOperation],
    skipped_items: &'a [DatabaseSyncSkippedItem],
    blockers: &'a [DatabaseSyncBlocker],
}

#[allow(dead_code, reason = "暂仅由后续命令尚未接入的计划收口调用")]
fn fingerprint_tables<'a>(
    snapshot: &'a SyncSchemaSnapshot,
    selected: &[String],
) -> BTreeMap<&'a str, (TableSnapshot, Option<&'a TableSyncMetadata>)> {
    snapshot
        .tables
        .iter()
        .filter(|table| selected.binary_search(&table.name).is_ok())
        .map(|table| {
            let mut canonical_table = table.clone();
            canonical_table.columns.sort_by(|left, right| {
                left.1
                    .ordinal_position
                    .cmp(&right.1.ordinal_position)
                    .then_with(|| left.0.cmp(&right.0))
            });
            (
                table.name.as_str(),
                (canonical_table, snapshot.metadata.get(&table.name)),
            )
        })
        .collect()
}

#[allow(dead_code, reason = "将在后续数据库同步命令中调用")]
pub(crate) fn finalize_preview(
    request: &DatabaseSyncRequest,
    source: &SyncSchemaSnapshot,
    target: &SyncSchemaSnapshot,
    mut fragments: PlanFragments,
) -> Result<DatabaseSyncPreview, String> {
    let selected = normalize_selected_tables(&request.selected_tables)?;
    if !request.include_drops {
        let (drop_operations, retained_operations): (Vec<_>, Vec<_>) =
            fragments.operations.into_iter().partition(|operation| {
                matches!(
                    operation.kind,
                    DatabaseSyncOperationKind::DropColumn | DatabaseSyncOperationKind::DropTable
                )
            });
        fragments.operations = retained_operations;
        fragments
            .skipped_items
            .extend(
                drop_operations
                    .into_iter()
                    .map(|operation| DatabaseSyncSkippedItem {
                        table_name: operation.table_name,
                        summary: operation.summary,
                        reason: "未开启包含删除操作".to_string(),
                    }),
            );
    }
    fragments.operations.sort_by(|left, right| {
        left.phase
            .cmp(&right.phase)
            .then_with(|| left.table_name.cmp(&right.table_name))
            .then_with(|| operation_kind_key(left.kind).cmp(operation_kind_key(right.kind)))
            .then_with(|| left.summary.cmp(&right.summary))
            .then_with(|| operation_risk_key(left.risk).cmp(&operation_risk_key(right.risk)))
            .then_with(|| left.sql.cmp(&right.sql))
    });
    fragments.skipped_items.sort_by(|a, b| {
        a.table_name
            .cmp(&b.table_name)
            .then_with(|| a.summary.cmp(&b.summary))
            .then_with(|| a.reason.cmp(&b.reason))
    });
    fragments.blockers.sort_by(|a, b| {
        a.table_name
            .cmp(&b.table_name)
            .then_with(|| a.summary.cmp(&b.summary))
            .then_with(|| a.reason.cmp(&b.reason))
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
    let source_map = fingerprint_tables(source, &selected);
    let target_map = fingerprint_tables(target, &selected);
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

#[allow(dead_code, reason = "暂仅由后续命令尚未接入的计划收口调用")]
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

#[allow(dead_code, reason = "暂仅由后续命令尚未接入的计划收口调用")]
fn operation_risk_key(risk: DatabaseSyncRisk) -> u8 {
    match risk {
        DatabaseSyncRisk::Normal => 0,
        DatabaseSyncRisk::High => 1,
        DatabaseSyncRisk::Destructive => 2,
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
                        primary_key_ordinal: Some(1),
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
                        primary_key_ordinal: Some(1),
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

    #[test]
    fn preview_rejects_blank_table_name() {
        let error = finalize_preview(
            &request(vec!["users", "   "], false),
            &snapshot(Vec::new()),
            &snapshot(Vec::new()),
            PlanFragments::default(),
        )
        .unwrap_err();

        assert_eq!(error, "同步表名不能为空");
    }

    #[test]
    fn preview_converts_drop_operations_to_skipped_when_drops_are_disabled() {
        let mut fragments = PlanFragments::default();
        fragments.operation(
            OperationPhase::DropColumn,
            "users",
            DatabaseSyncOperationKind::DropColumn,
            DatabaseSyncRisk::Destructive,
            "删除目标端字段 users.legacy",
            vec!["ALTER TABLE users DROP COLUMN legacy".to_string()],
        );
        fragments.operation(
            OperationPhase::DropTable,
            "logs",
            DatabaseSyncOperationKind::DropTable,
            DatabaseSyncRisk::Destructive,
            "删除目标端表 logs",
            vec!["DROP TABLE logs".to_string()],
        );

        let preview = finalize_preview(
            &request(vec!["users", "logs"], false),
            &snapshot(Vec::new()),
            &snapshot(Vec::new()),
            fragments,
        )
        .unwrap();

        assert!(preview.operations.is_empty());
        assert_eq!(preview.summary.executable_operations, 0);
        assert_eq!(preview.summary.destructive_operations, 0);
        assert_eq!(preview.summary.skipped_items, 2);
        assert!(preview
            .skipped_items
            .iter()
            .all(|item| item.reason == "未开启包含删除操作"));
        assert!(!preview.can_execute);
    }

    #[test]
    fn equivalent_fragments_have_stable_order_ids_and_fingerprint() {
        let mut forward = PlanFragments::default();
        forward.operation(
            OperationPhase::AlterColumn,
            "users",
            DatabaseSyncOperationKind::UpdateComment,
            DatabaseSyncRisk::Normal,
            "同步 users 字段",
            vec!["COMMENT ON COLUMN users.name IS 'name'".to_string()],
        );
        forward.operation(
            OperationPhase::AlterColumn,
            "users",
            DatabaseSyncOperationKind::AlterColumn,
            DatabaseSyncRisk::High,
            "同步 users 字段",
            vec!["ALTER TABLE users ALTER COLUMN name TYPE varchar(200)".to_string()],
        );
        forward.operation(
            OperationPhase::AlterColumn,
            "users",
            DatabaseSyncOperationKind::AlterColumn,
            DatabaseSyncRisk::Normal,
            "同步 users 字段",
            vec!["ALTER TABLE users ALTER COLUMN age TYPE bigint".to_string()],
        );
        forward.operation(
            OperationPhase::AlterColumn,
            "users",
            DatabaseSyncOperationKind::AlterColumn,
            DatabaseSyncRisk::High,
            "同步 users 字段",
            vec!["ALTER TABLE users ALTER COLUMN email TYPE varchar(320)".to_string()],
        );
        forward.skip("users", "跳过字段", "原因 B");
        forward.skip("users", "跳过字段", "原因 A");
        forward.block("users", "阻塞字段", "原因 B");
        forward.block("users", "阻塞字段", "原因 A");

        let mut reversed = forward.clone();
        reversed.operations.reverse();
        reversed.skipped_items.reverse();
        reversed.blockers.reverse();

        let sync_request = request(vec!["users"], true);
        let source = snapshot(Vec::new());
        let target = snapshot(Vec::new());
        let first = finalize_preview(&sync_request, &source, &target, forward).unwrap();
        let second = finalize_preview(&sync_request, &source, &target, reversed).unwrap();

        assert_eq!(first.operations, second.operations);
        assert_eq!(first.skipped_items, second.skipped_items);
        assert_eq!(first.blockers, second.blockers);
        assert_eq!(first.plan_fingerprint, second.plan_fingerprint);
        assert_eq!(
            first
                .operations
                .iter()
                .map(|operation| operation.kind)
                .collect::<Vec<_>>(),
            vec![
                DatabaseSyncOperationKind::AlterColumn,
                DatabaseSyncOperationKind::AlterColumn,
                DatabaseSyncOperationKind::AlterColumn,
                DatabaseSyncOperationKind::UpdateComment,
            ]
        );
        assert_eq!(
            first
                .operations
                .iter()
                .map(|operation| operation.risk)
                .collect::<Vec<_>>(),
            vec![
                DatabaseSyncRisk::Normal,
                DatabaseSyncRisk::High,
                DatabaseSyncRisk::High,
                DatabaseSyncRisk::Normal,
            ]
        );
        assert_eq!(
            first
                .operations
                .iter()
                .map(|operation| operation.id.as_str())
                .collect::<BTreeSet<_>>()
                .len(),
            first.operations.len()
        );
        assert_eq!(
            first
                .skipped_items
                .iter()
                .map(|item| item.reason.as_str())
                .collect::<Vec<_>>(),
            vec!["原因 A", "原因 B"]
        );
        assert_eq!(
            first
                .blockers
                .iter()
                .map(|item| item.reason.as_str())
                .collect::<Vec<_>>(),
            vec!["原因 A", "原因 B"]
        );
    }

    #[test]
    fn preview_fingerprint_normalizes_column_vector_order() {
        let id = (
            "id".to_string(),
            ColumnSnapshot {
                ordinal_position: 1,
                column_type: "bigint".to_string(),
                nullable: false,
                default_value: None,
                primary_key: true,
                extra: String::new(),
                comment: String::new(),
            },
        );
        let name = (
            "name".to_string(),
            ColumnSnapshot {
                ordinal_position: 2,
                column_type: "varchar(100)".to_string(),
                nullable: false,
                default_value: None,
                primary_key: false,
                extra: String::new(),
                comment: String::new(),
            },
        );
        let ordered = snapshot(vec![TableSnapshot {
            name: "users".to_string(),
            columns: vec![id.clone(), name.clone()],
        }]);
        let reordered = snapshot(vec![TableSnapshot {
            name: "users".to_string(),
            columns: vec![name, id],
        }]);
        let sync_request = request(vec!["users"], false);
        let target = snapshot(Vec::new());

        let first =
            finalize_preview(&sync_request, &ordered, &target, PlanFragments::default()).unwrap();
        let second =
            finalize_preview(&sync_request, &reordered, &target, PlanFragments::default()).unwrap();

        assert_eq!(first.plan_fingerprint, second.plan_fingerprint);
    }
}
