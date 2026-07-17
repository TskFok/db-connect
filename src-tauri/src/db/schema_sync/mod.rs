use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::db::connection::DatabasePoolHandle;
use crate::db::schema_compare::{compare_table_columns, load_schema_snapshot, TableSnapshot};
use crate::models::types::{
    DatabaseSyncBlocker, DatabaseSyncOperation, DatabaseSyncOperationKind, DatabaseSyncPlanSummary,
    DatabaseSyncPreview, DatabaseSyncRequest, DatabaseSyncRisk, DatabaseSyncSkippedItem,
    DatabaseType,
};

pub(crate) mod clickhouse;
pub(crate) mod mysql;
pub(crate) mod postgres;
pub(crate) mod sqlite;
pub(crate) mod sqlserver;

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
    Sqlite {
        hidden: i64,
    },
    #[allow(dead_code, reason = "将在后续 SQL Server 同步方言中使用")]
    SqlServer {
        is_identity: bool,
        identity_seed: Option<String>,
        identity_increment: Option<String>,
        computed_definition: Option<String>,
        default_expression: Option<String>,
        default_constraint_name: Option<String>,
        default_constraint_is_system_named: Option<bool>,
        is_user_defined: bool,
        type_schema: String,
        type_name: String,
        primary_key_ordinal: Option<u32>,
        is_hidden: bool,
        generated_always_type: i32,
        is_sparse: bool,
        is_column_set: bool,
        is_filestream: bool,
        is_rowguidcol: bool,
        is_masked: bool,
        encryption_type: Option<i32>,
    },
    ClickHouse {
        default_kind: String,
        default_expression: String,
        compression_codec: String,
        ttl_expression: String,
        unsupported_clauses: Vec<String>,
        is_in_partition_key: bool,
        is_in_sorting_key: bool,
        is_in_primary_key: bool,
        is_in_sampling_key: bool,
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
    #[allow(dead_code, reason = "将在后续 SQL Server 同步方言中使用")]
    SqlServer {
        table_comment: String,
        primary_key_constraint: Option<String>,
        temporal_type: i32,
        is_memory_optimized: bool,
        is_node: bool,
        is_edge: bool,
        is_filetable: bool,
        columns: BTreeMap<String, ColumnSyncMetadata>,
    },
    ClickHouse {
        engine: String,
        engine_full: String,
        create_table_query: String,
        sorting_key: String,
        partition_key: String,
        primary_key: String,
        sampling_key: String,
        table_ttl: String,
        settings: String,
        unsupported_definitions: Vec<String>,
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

#[allow(dead_code, reason = "将在后续数据库同步命令中调用")]
pub(crate) async fn load_sync_schema_snapshot(
    pool: DatabasePoolHandle,
    database: &str,
) -> Result<SyncSchemaSnapshot, String> {
    let tables = load_schema_snapshot(pool.clone(), database).await?;
    let metadata = match pool {
        DatabasePoolHandle::MySql(pool) => mysql::load_metadata(&pool, database).await?,
        DatabasePoolHandle::Postgres(handle) => {
            postgres::load_metadata(&handle.pool, database).await?
        }
        DatabasePoolHandle::Sqlite(handle) => sqlite::load_metadata(&handle.pool, database).await?,
        DatabasePoolHandle::SqlServer(handle) => {
            sqlserver::load_metadata(&handle.pool, database).await?
        }
        DatabasePoolHandle::ClickHouse(handle) => {
            clickhouse::load_metadata(&handle.client, database).await?
        }
    };
    Ok(SyncSchemaSnapshot { tables, metadata })
}

fn database_type_name(database_type: DatabaseType) -> &'static str {
    match database_type {
        DatabaseType::MySql => "MySQL",
        DatabaseType::Postgres => "PostgreSQL",
        DatabaseType::Sqlite => "SQLite",
        DatabaseType::SqlServer => "SQL Server",
        DatabaseType::ClickHouse => "ClickHouse",
    }
}

fn metadata_matches_database_type(
    database_type: DatabaseType,
    metadata: &TableSyncMetadata,
) -> bool {
    matches!(
        (database_type, metadata),
        (DatabaseType::MySql, TableSyncMetadata::MySql { .. })
            | (DatabaseType::Postgres, TableSyncMetadata::Postgres { .. })
            | (DatabaseType::Sqlite, TableSyncMetadata::Sqlite { .. })
            | (DatabaseType::SqlServer, TableSyncMetadata::SqlServer { .. })
            | (
                DatabaseType::ClickHouse,
                TableSyncMetadata::ClickHouse { .. }
            )
    )
}

fn column_metadata_matches_database_type(
    database_type: DatabaseType,
    metadata: &ColumnSyncMetadata,
) -> bool {
    matches!(
        (database_type, metadata),
        (DatabaseType::MySql, ColumnSyncMetadata::MySql { .. })
            | (DatabaseType::Postgres, ColumnSyncMetadata::Postgres { .. })
            | (DatabaseType::Sqlite, ColumnSyncMetadata::Sqlite { .. })
            | (
                DatabaseType::SqlServer,
                ColumnSyncMetadata::SqlServer { .. }
            )
            | (
                DatabaseType::ClickHouse,
                ColumnSyncMetadata::ClickHouse { .. }
            )
    )
}

fn metadata_columns(metadata: &TableSyncMetadata) -> &BTreeMap<String, ColumnSyncMetadata> {
    match metadata {
        TableSyncMetadata::MySql { columns, .. }
        | TableSyncMetadata::Postgres { columns, .. }
        | TableSyncMetadata::Sqlite { columns, .. }
        | TableSyncMetadata::SqlServer { columns, .. }
        | TableSyncMetadata::ClickHouse { columns, .. } => columns,
    }
}

fn validate_snapshot_metadata(
    database_type: DatabaseType,
    endpoint: &str,
    snapshot: &SyncSchemaSnapshot,
) -> Result<(), String> {
    for (table_name, metadata) in &snapshot.metadata {
        if !metadata_matches_database_type(database_type, metadata) {
            return Err(format!(
                "{endpoint}表 {table_name} 的原生元数据与 {} 方言不兼容",
                database_type_name(database_type)
            ));
        }
        if let Some((column_name, _)) = metadata_columns(metadata)
            .iter()
            .find(|(_, metadata)| !column_metadata_matches_database_type(database_type, metadata))
        {
            return Err(format!(
                "{endpoint}表 {table_name} 字段 {column_name} 的原生元数据与 {} 方言不兼容",
                database_type_name(database_type)
            ));
        }
    }
    Ok(())
}

fn block_unhandled_table_metadata_differences(
    database_type: DatabaseType,
    table_name: &str,
    source: Option<&TableSyncMetadata>,
    target: Option<&TableSyncMetadata>,
    plan: &mut PlanFragments,
) {
    match (database_type, source, target) {
        (
            DatabaseType::MySql,
            Some(TableSyncMetadata::MySql {
                engine: source_engine,
                comment: source_comment,
                ..
            }),
            Some(TableSyncMetadata::MySql {
                engine: target_engine,
                comment: target_comment,
                ..
            }),
        ) => {
            if source_engine != target_engine {
                plan.block(
                    table_name,
                    &format!("无法同步表 {table_name} 的存储引擎"),
                    "MySQL 存储引擎原生元数据差异未被当前方言计划器支持",
                );
            }
            if source_comment != target_comment {
                plan.block(
                    table_name,
                    &format!("无法同步表 {table_name} 的表注释"),
                    "MySQL 表注释原生元数据差异未被当前方言计划器支持",
                );
            }
        }
        (
            DatabaseType::Postgres,
            Some(TableSyncMetadata::Postgres {
                table_comment: source_comment,
                ..
            }),
            Some(TableSyncMetadata::Postgres {
                table_comment: target_comment,
                ..
            }),
        ) if source_comment != target_comment => plan.block(
            table_name,
            &format!("无法同步表 {table_name} 的表注释"),
            "PostgreSQL 表注释原生元数据差异未被当前方言计划器支持",
        ),
        _ => {}
    }
}

#[allow(dead_code, reason = "将在后续数据库同步命令中调用")]
pub(crate) fn build_database_sync_preview(
    database_type: DatabaseType,
    request: &DatabaseSyncRequest,
    source: &SyncSchemaSnapshot,
    target: &SyncSchemaSnapshot,
) -> Result<DatabaseSyncPreview, String> {
    let selected = normalize_selected_tables(&request.selected_tables)?;
    validate_snapshot_metadata(database_type, "源端", source)?;
    validate_snapshot_metadata(database_type, "目标端", target)?;

    let source_tables = source
        .tables
        .iter()
        .map(|table| (table.name.as_str(), table))
        .collect::<BTreeMap<_, _>>();
    let target_tables = target
        .tables
        .iter()
        .map(|table| (table.name.as_str(), table))
        .collect::<BTreeMap<_, _>>();
    let mut fragments = PlanFragments::default();
    for table_name in &selected {
        let source_table = source_tables.get(table_name.as_str()).copied();
        let target_table = target_tables.get(table_name.as_str()).copied();
        if source_table.is_none() && target_table.is_none() {
            return Err(format!("所选表 {table_name} 已不存在，请重新对比"));
        }

        let source_metadata = source.metadata.get(table_name);
        let target_metadata = target.metadata.get(table_name);
        let public_difference = match (source_table, target_table) {
            (Some(source_table), Some(target_table)) => {
                !compare_table_columns(source_table, target_table).is_empty()
            }
            _ => true,
        };
        let native_difference = source_metadata != target_metadata;
        if !public_difference && !native_difference {
            return Err(format!("所选表 {table_name} 已不存在差异，请重新对比"));
        }

        let context = TablePlanContext {
            target_database: &request.target.database,
            source: source_table,
            target: target_table,
            source_metadata,
            target_metadata,
            include_drops: request.include_drops,
        };
        let mut table_plan = match database_type {
            DatabaseType::MySql => mysql::plan_table(context),
            DatabaseType::Postgres => postgres::plan_table(context),
            DatabaseType::Sqlite => sqlite::plan_table(context),
            DatabaseType::SqlServer => sqlserver::plan_table(context),
            DatabaseType::ClickHouse => clickhouse::plan_table(context),
        };
        block_unhandled_table_metadata_differences(
            database_type,
            table_name,
            source_metadata,
            target_metadata,
            &mut table_plan,
        );
        if !public_difference
            && native_difference
            && table_plan.operations.is_empty()
            && table_plan.skipped_items.is_empty()
            && table_plan.blockers.is_empty()
        {
            table_plan.block(
                table_name,
                &format!("无法规划表 {table_name} 的原生元数据变更"),
                &format!(
                    "{} 方言未能安全表达检测到的原生元数据差异",
                    database_type_name(database_type)
                ),
            );
        }
        fragments.operations.append(&mut table_plan.operations);
        fragments
            .skipped_items
            .append(&mut table_plan.skipped_items);
        fragments.blockers.append(&mut table_plan.blockers);
    }

    finalize_preview(request, source, target, fragments)
}

pub(crate) fn normalize_selected_tables(values: &[String]) -> Result<Vec<String>, String> {
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
        DatabaseSyncRequest, DatabaseSyncRisk, DatabaseType,
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

    fn mysql_metadata(
        generation_expression: &str,
        engine: &str,
    ) -> BTreeMap<String, TableSyncMetadata> {
        BTreeMap::from([(
            "users".to_string(),
            TableSyncMetadata::MySql {
                engine: engine.to_string(),
                comment: String::new(),
                columns: BTreeMap::from([(
                    "id".to_string(),
                    ColumnSyncMetadata::MySql {
                        generation_expression: generation_expression.to_string(),
                        primary_key_ordinal: Some(1),
                    },
                )]),
            },
        )])
    }

    fn native_metadata(database_type: DatabaseType) -> TableSyncMetadata {
        match database_type {
            DatabaseType::MySql => mysql_metadata("", "InnoDB")
                .remove("users")
                .expect("MySQL 测试元数据必须存在"),
            DatabaseType::Postgres => TableSyncMetadata::Postgres {
                relkind: "r".to_string(),
                table_comment: String::new(),
                primary_key_constraint: Some("users_pkey".to_string()),
                columns: BTreeMap::from([(
                    "id".to_string(),
                    ColumnSyncMetadata::Postgres {
                        identity_generation: String::new(),
                        generated_kind: "NEVER".to_string(),
                        generation_expression: None,
                        default_expression: None,
                        is_user_defined: false,
                        type_schema: "pg_catalog".to_string(),
                        type_name: "int8".to_string(),
                        primary_key_ordinal: Some(1),
                    },
                )]),
            },
            DatabaseType::Sqlite => TableSyncMetadata::Sqlite {
                create_sql: "CREATE TABLE users (id bigint PRIMARY KEY)".to_string(),
                columns: BTreeMap::from([(
                    "id".to_string(),
                    ColumnSyncMetadata::Sqlite { hidden: 0 },
                )]),
            },
            DatabaseType::SqlServer => TableSyncMetadata::SqlServer {
                table_comment: String::new(),
                primary_key_constraint: Some("PK_users".to_string()),
                temporal_type: 0,
                is_memory_optimized: false,
                is_node: false,
                is_edge: false,
                is_filetable: false,
                columns: BTreeMap::from([(
                    "id".to_string(),
                    ColumnSyncMetadata::SqlServer {
                        is_identity: false,
                        identity_seed: None,
                        identity_increment: None,
                        computed_definition: None,
                        default_expression: None,
                        default_constraint_name: None,
                        default_constraint_is_system_named: None,
                        is_user_defined: false,
                        type_schema: "sys".to_string(),
                        type_name: "bigint".to_string(),
                        primary_key_ordinal: Some(1),
                        is_hidden: false,
                        generated_always_type: 0,
                        is_sparse: false,
                        is_column_set: false,
                        is_filestream: false,
                        is_rowguidcol: false,
                        is_masked: false,
                        encryption_type: None,
                    },
                )]),
            },
            DatabaseType::ClickHouse => TableSyncMetadata::ClickHouse {
                engine: "MergeTree".to_string(),
                engine_full: "MergeTree ORDER BY id".to_string(),
                create_table_query: "CREATE TABLE users (id Int64) ENGINE = MergeTree ORDER BY id"
                    .to_string(),
                sorting_key: "id".to_string(),
                partition_key: String::new(),
                primary_key: "id".to_string(),
                sampling_key: String::new(),
                table_ttl: String::new(),
                settings: String::new(),
                unsupported_definitions: Vec::new(),
                comment: String::new(),
                columns: BTreeMap::from([(
                    "id".to_string(),
                    ColumnSyncMetadata::ClickHouse {
                        default_kind: String::new(),
                        default_expression: String::new(),
                        compression_codec: String::new(),
                        ttl_expression: String::new(),
                        unsupported_clauses: Vec::new(),
                        is_in_partition_key: false,
                        is_in_sorting_key: true,
                        is_in_primary_key: true,
                        is_in_sampling_key: false,
                    },
                )]),
            },
        }
    }

    #[test]
    fn build_preview_rejects_selected_table_that_is_no_longer_different() {
        for database_type in [
            DatabaseType::MySql,
            DatabaseType::Postgres,
            DatabaseType::Sqlite,
            DatabaseType::SqlServer,
            DatabaseType::ClickHouse,
        ] {
            let error = build_database_sync_preview(
                database_type,
                &request(vec!["users"], false),
                &snapshot(vec![table("users", "bigint")]),
                &snapshot(vec![table("users", "bigint")]),
            )
            .unwrap_err();

            assert_eq!(error, "所选表 users 已不存在差异，请重新对比");
        }
    }

    #[test]
    fn delete_disabled_preview_contains_skipped_item_and_no_drop_sql() {
        let preview = build_database_sync_preview(
            DatabaseType::MySql,
            &request(vec!["legacy"], false),
            &snapshot(Vec::new()),
            &snapshot(vec![table("legacy", "bigint")]),
        )
        .unwrap();

        assert!(!preview.can_execute);
        assert!(preview.operations.is_empty());
        assert_eq!(preview.skipped_items.len(), 1);
        assert!(preview
            .operations
            .iter()
            .flat_map(|operation| &operation.sql)
            .all(|sql| !sql.to_ascii_uppercase().contains("DROP")));
    }

    #[test]
    fn build_preview_dispatches_metadata_only_difference_to_mysql_planner() {
        let mut source_table = table("users", "bigint");
        source_table.columns[0].1.extra = "STORED GENERATED".to_string();
        let target_table = source_table.clone();
        let source = SyncSchemaSnapshot {
            tables: vec![source_table],
            metadata: mysql_metadata("price * quantity", "InnoDB"),
        };
        let target = SyncSchemaSnapshot {
            tables: vec![target_table],
            metadata: mysql_metadata("price + quantity", "InnoDB"),
        };

        let preview = build_database_sync_preview(
            DatabaseType::MySql,
            &request(vec!["users"], false),
            &source,
            &target,
        )
        .unwrap();

        assert!(preview.can_execute);
        assert_eq!(preview.operations.len(), 1);
        assert!(preview.operations[0].sql.iter().any(|sql| sql
            .contains("MODIFY COLUMN `id` bigint GENERATED ALWAYS AS (price * quantity) STORED")));
    }

    #[test]
    fn build_preview_surfaces_unplanned_native_metadata_difference_as_blocker() {
        let source = SyncSchemaSnapshot {
            tables: vec![table("users", "bigint")],
            metadata: mysql_metadata("", "InnoDB"),
        };
        let target = SyncSchemaSnapshot {
            tables: vec![table("users", "bigint")],
            metadata: mysql_metadata("", "MyISAM"),
        };

        let preview = build_database_sync_preview(
            DatabaseType::MySql,
            &request(vec!["users"], false),
            &source,
            &target,
        )
        .unwrap();

        assert!(!preview.can_execute);
        assert!(preview.operations.is_empty());
        assert_eq!(preview.blockers.len(), 1);
        assert_eq!(preview.blockers[0].table_name, "users");
        assert!(preview.blockers[0].reason.contains("原生元数据差异"));
    }

    #[test]
    fn build_preview_blocks_partial_plan_when_public_and_unhandled_native_changes_coexist() {
        let mut source_table = table("users", "bigint");
        source_table.columns.push((
            "name".to_string(),
            ColumnSnapshot {
                ordinal_position: 2,
                column_type: "varchar(100)".to_string(),
                nullable: true,
                default_value: None,
                primary_key: false,
                extra: String::new(),
                comment: String::new(),
            },
        ));
        let mut source_mysql_metadata = mysql_metadata("", "InnoDB");
        let TableSyncMetadata::MySql { columns, .. } = source_mysql_metadata
            .get_mut("users")
            .expect("MySQL 测试元数据必须存在")
        else {
            unreachable!("MySQL 测试元数据必须是 MySql 变体");
        };
        columns.insert(
            "name".to_string(),
            ColumnSyncMetadata::MySql {
                generation_expression: String::new(),
                primary_key_ordinal: None,
            },
        );

        let mysql_preview = build_database_sync_preview(
            DatabaseType::MySql,
            &request(vec!["users"], false),
            &SyncSchemaSnapshot {
                tables: vec![source_table.clone()],
                metadata: source_mysql_metadata,
            },
            &SyncSchemaSnapshot {
                tables: vec![table("users", "bigint")],
                metadata: mysql_metadata("", "MyISAM"),
            },
        )
        .unwrap();

        assert!(!mysql_preview.operations.is_empty());
        assert!(!mysql_preview.can_execute);
        assert!(mysql_preview
            .blockers
            .iter()
            .any(|blocker| blocker.reason.contains("存储引擎")));

        let mut source_postgres_metadata = native_metadata(DatabaseType::Postgres);
        let TableSyncMetadata::Postgres {
            table_comment,
            columns,
            ..
        } = &mut source_postgres_metadata
        else {
            unreachable!("PostgreSQL 测试元数据必须是 Postgres 变体");
        };
        *table_comment = "源端用户表".to_string();
        columns.insert(
            "name".to_string(),
            ColumnSyncMetadata::Postgres {
                identity_generation: String::new(),
                generated_kind: "NEVER".to_string(),
                generation_expression: None,
                default_expression: None,
                is_user_defined: false,
                type_schema: "pg_catalog".to_string(),
                type_name: "varchar".to_string(),
                primary_key_ordinal: None,
            },
        );
        let postgres_preview = build_database_sync_preview(
            DatabaseType::Postgres,
            &request(vec!["users"], false),
            &SyncSchemaSnapshot {
                tables: vec![source_table],
                metadata: BTreeMap::from([("users".to_string(), source_postgres_metadata)]),
            },
            &SyncSchemaSnapshot {
                tables: vec![table("users", "bigint")],
                metadata: BTreeMap::from([(
                    "users".to_string(),
                    native_metadata(DatabaseType::Postgres),
                )]),
            },
        )
        .unwrap();

        assert!(!postgres_preview.operations.is_empty());
        assert!(!postgres_preview.can_execute);
        assert!(postgres_preview
            .blockers
            .iter()
            .any(|blocker| blocker.reason.contains("表注释")));
    }

    #[test]
    fn build_preview_rejects_metadata_incompatible_with_database_type() {
        let source = SyncSchemaSnapshot {
            tables: vec![table("users", "bigint")],
            metadata: BTreeMap::from([(
                "users".to_string(),
                TableSyncMetadata::Postgres {
                    relkind: "r".to_string(),
                    table_comment: String::new(),
                    primary_key_constraint: None,
                    columns: BTreeMap::new(),
                },
            )]),
        };

        let error = build_database_sync_preview(
            DatabaseType::MySql,
            &request(vec!["users"], false),
            &source,
            &snapshot(Vec::new()),
        )
        .unwrap_err();

        assert_eq!(error, "源端表 users 的原生元数据与 MySQL 方言不兼容");
    }

    #[test]
    fn build_preview_rejects_incompatible_source_and_target_column_metadata() {
        for endpoint in ["源端", "目标端"] {
            let incompatible = SyncSchemaSnapshot {
                tables: vec![table("users", "bigint")],
                metadata: BTreeMap::from([(
                    "users".to_string(),
                    TableSyncMetadata::MySql {
                        engine: "InnoDB".to_string(),
                        comment: String::new(),
                        columns: BTreeMap::from([(
                            "id".to_string(),
                            ColumnSyncMetadata::Postgres {
                                identity_generation: String::new(),
                                generated_kind: "NEVER".to_string(),
                                generation_expression: None,
                                default_expression: None,
                                is_user_defined: false,
                                type_schema: "pg_catalog".to_string(),
                                type_name: "int8".to_string(),
                                primary_key_ordinal: Some(1),
                            },
                        )]),
                    },
                )]),
            };
            let compatible = SyncSchemaSnapshot {
                tables: Vec::new(),
                metadata: BTreeMap::new(),
            };
            let (source, target) = if endpoint == "源端" {
                (&incompatible, &compatible)
            } else {
                (&compatible, &incompatible)
            };

            let error = build_database_sync_preview(
                DatabaseType::MySql,
                &request(vec!["users"], false),
                source,
                target,
            )
            .unwrap_err();

            assert_eq!(
                error,
                format!("{endpoint}表 users 字段 id 的原生元数据与 MySQL 方言不兼容")
            );
        }
    }

    #[test]
    fn build_preview_dispatches_source_only_table_to_every_dialect() {
        let cases = [
            (DatabaseType::MySql, "`app_copy`.`users`"),
            (DatabaseType::Postgres, "\"app_copy\".\"users\""),
            (DatabaseType::Sqlite, "\"app_copy\".\"users\""),
            (DatabaseType::SqlServer, "[app_copy].[users]"),
            (DatabaseType::ClickHouse, "`app_copy`.`users`"),
        ];
        for (database_type, qualified_table) in cases {
            let source = SyncSchemaSnapshot {
                tables: vec![table("users", "bigint")],
                metadata: BTreeMap::from([("users".to_string(), native_metadata(database_type))]),
            };

            let preview = build_database_sync_preview(
                database_type,
                &request(vec!["users"], false),
                &source,
                &snapshot(Vec::new()),
            )
            .unwrap();

            assert_eq!(preview.operations.len(), 1, "{database_type:?}");
            assert_eq!(
                preview.operations[0].kind,
                DatabaseSyncOperationKind::CreateTable,
                "{database_type:?}"
            );
            assert!(
                preview.operations[0]
                    .sql
                    .iter()
                    .any(|sql| sql.contains(qualified_table)),
                "{database_type:?} 未生成预期限定表名: {:?}",
                preview.operations[0].sql
            );
        }
    }

    #[test]
    fn build_preview_fingerprint_changes_with_native_metadata() {
        let mut source_table = table("users", "bigint");
        source_table.columns[0].1.extra = "STORED GENERATED".to_string();
        let target_table = source_table.clone();
        let target = SyncSchemaSnapshot {
            tables: vec![target_table],
            metadata: mysql_metadata("price + quantity", "InnoDB"),
        };
        let preview = |expression| {
            build_database_sync_preview(
                DatabaseType::MySql,
                &request(vec!["users"], false),
                &SyncSchemaSnapshot {
                    tables: vec![source_table.clone()],
                    metadata: mysql_metadata(expression, "InnoDB"),
                },
                &target,
            )
            .unwrap()
        };

        assert_ne!(
            preview("price * quantity").plan_fingerprint,
            preview("price - quantity").plan_fingerprint
        );
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
