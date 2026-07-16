# 数据库结构同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有数据库对比结果中增加按表选择、后端 SQL 预览、计划指纹校验和结构同步执行能力，并覆盖 MySQL/MariaDB、PostgreSQL、SQLite、SQL Server 与 ClickHouse。

**Architecture:** Rust 后端复用现有批量结构快照，增加无状态的同步计划核心和五个方言规划器；预览与执行命令都重新采集两端结构，执行命令只有在计划指纹一致时才按顺序写入目标端。React 前端只管理表级选择、删除开关、计划展示和确认，不生成或回传可执行 SQL。

**Tech Stack:** Tauri 2、Rust、Tokio、serde/serde_json、sha2、mysql_async、deadpool-postgres、deadpool-sqlite/rusqlite、bb8-tiberius、clickhouse-rs、React 18、TypeScript、Ant Design 5、Vitest、Testing Library。

## Global Constraints

- 设计基线：`docs/superpowers/specs/2026-07-16-database-sync-design.md`。
- 默认在当前 `master` 分支修改，不创建新分支。
- Git 提交必须使用 Conventional Commits，英文 type 加简体中文描述。
- 严格使用 TDD：每个行为先写失败测试并确认按预期失败，再写最小实现。
- 禁止在循环遍历中查询 SQL；每一端的字段与表级原生元数据必须使用固定次数的数据库/schema 级批量查询。
- 只允许两个不同的同类型保存连接互相同步。
- 首期只同步物理表与字段；不比较或同步索引、外键、视图、触发器、例程、事件、权限或数据。
- 前端只提交端点、选中表名、删除开关和计划指纹；不得提交或编辑实际执行 SQL。
- 删除操作默认关闭；`include_drops = false` 时后端不得产生或执行 `DROP COLUMN`/`DROP TABLE`。
- 不使用重建整表兜底方言无法安全表达的变化；必须返回阻塞项。
- 执行前重新生成计划并校验 SHA-256 指纹；指纹不一致时执行零条 DDL。
- 执行遇到首个失败立即停止，不承诺整批回滚，并返回已成功、失败和未执行语句。
- 临时同步连接不得注册到当前活动连接管理器，凭据不得进入日志、计划、指纹或前端响应。
- 宣称完成前必须运行全部 npm/Rust 测试、构建、lint 和格式检查。

---

## File Structure

### Backend

- `src-tauri/src/models/types.rs`：新增同步请求、计划、风险、阻塞项和执行结果序列化契约。
- `src-tauri/src/db/schema_compare/mod.rs`：公开后端内部可复用的单表字段差异函数，不改变现有前端契约。
- `src-tauri/src/db/schema_sync/mod.rs`：选择规范化、共享计划片段、稳定排序、计划摘要、指纹、方言分发与批量快照装配。
- `src-tauri/src/db/schema_sync/mysql.rs`：MySQL/MariaDB 表级元数据批量查询和 DDL 规划。
- `src-tauri/src/db/schema_sync/postgres.rs`：PostgreSQL 表级元数据批量查询、DDL 规划和阻塞规则。
- `src-tauri/src/db/schema_sync/sqlite.rs`：SQLite 表级元数据批量查询、原生 DDL 规划和重建阻塞规则。
- `src-tauri/src/db/schema_sync/sqlserver.rs`：SQL Server 表级元数据批量查询、DDL 规划和约束处理。
- `src-tauri/src/db/schema_sync/clickhouse.rs`：ClickHouse 引擎/键批量查询、DDL 规划和键变化阻塞规则。
- `src-tauri/src/commands/temporary_database.rs`：对比与同步共享的保存连接查找、临时连接、清理合并和凭据脱敏。
- `src-tauri/src/commands/database_compare.rs`：改为复用共享临时连接模块，行为保持不变。
- `src-tauri/src/commands/database_sync.rs`：预览、执行、结构漂移校验、逐语句执行和最新对比结果。
- `src-tauri/src/commands/mod.rs`、`src-tauri/src/db/mod.rs`、`src-tauri/src/lib.rs`：注册新模块和 Tauri 命令。

### Frontend

- `src/types/index.ts`：增加与 Rust 一致的同步契约。
- `src/services/tauriCommands.ts`：增加预览和执行封装。
- `src/utils/databaseSync.ts`：表级选择、删除资格和风险文案纯函数。
- `src/components/databaseCompare/DatabaseCompareResults.tsx`：摘要、筛选、展开、表级选择和删除开关。
- `src/components/databaseCompare/DatabaseSyncPreviewModal.tsx`：计划、SQL、阻塞项、风险确认和执行结果。
- `src/components/databaseCompare/DatabaseCompareModal.tsx`：端点/对比顶层状态以及同步子流程编排。
- `src/components/databaseCompare/DatabaseCompareModal.css`：结果选择和预览响应式样式。
- `src/__tests__/databaseSync.test.ts`：选择与展示纯函数测试。
- `src/__tests__/DatabaseCompareResults.test.tsx`：表级选择组件测试。
- `src/__tests__/DatabaseSyncPreviewModal.test.tsx`：预览确认和结果组件测试。
- `src/__tests__/DatabaseCompareModal.test.tsx`：端到端组件编排、竞态与结果刷新测试。

### Documentation

- `docs/superpowers/manual-tests/2026-07-16-database-sync-matrix.md`：五类数据库手工验收矩阵。
- `README.md`：补充数据库结构同步能力和安全边界。

---

### Task 1: 同步契约、字段差异复用与计划核心

**Files:**
- Modify: `src-tauri/src/models/types.rs:41-105`
- Modify: `src-tauri/src/db/schema_compare/mod.rs:18-240`
- Modify: `src-tauri/src/db/mod.rs:1-16`
- Create: `src-tauri/src/db/schema_sync/mod.rs`

**Interfaces:**
- Consumes: `DatabaseType`、`DatabaseCompareEndpointRequest`、`TableSnapshot`、`ColumnDiff`。
- Produces: `DatabaseSyncRequest`、`DatabaseSyncPreview`、`DatabaseSyncExecutionResult`、`TableSyncMetadata`、`PlanFragments`、`TablePlanContext`、`finalize_preview()`、`compare_table_columns()`。

- [ ] **Step 1: 写同步计划核心失败测试**

在新文件 `src-tauri/src/db/schema_sync/mod.rs` 先加入测试，`src-tauri/src/db/mod.rs` 注册 `pub mod schema_sync;`。测试明确选择去重、稳定顺序、风险汇总和指纹变化：

```rust
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
```

- [ ] **Step 2: 运行测试确认按预期失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_sync::tests -- --nocapture`

Expected: FAIL，提示 `DatabaseSyncRequest`、`PlanFragments`、`finalize_preview` 等尚不存在。

- [ ] **Step 3: 增加序列化契约和最小计划核心**

在 `src-tauri/src/models/types.rs` 的数据库对比类型后加入以下完整契约：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncRequest {
    pub source: DatabaseCompareEndpointRequest,
    pub target: DatabaseCompareEndpointRequest,
    pub selected_tables: Vec<String>,
    pub include_drops: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseSyncRisk {
    Normal,
    High,
    Destructive,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseSyncOperationKind {
    CreateTable,
    AddColumn,
    AlterColumn,
    ReplacePrimaryKey,
    DropColumn,
    DropTable,
    UpdateComment,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncOperation {
    pub id: String,
    pub table_name: String,
    pub kind: DatabaseSyncOperationKind,
    pub summary: String,
    pub risk: DatabaseSyncRisk,
    pub sql: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncSkippedItem {
    pub table_name: String,
    pub summary: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncBlocker {
    pub table_name: String,
    pub summary: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct DatabaseSyncPlanSummary {
    pub selected_tables: usize,
    pub executable_operations: usize,
    pub high_risk_operations: usize,
    pub destructive_operations: usize,
    pub skipped_items: usize,
    pub blockers: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncPreview {
    pub plan_fingerprint: String,
    pub summary: DatabaseSyncPlanSummary,
    pub operations: Vec<DatabaseSyncOperation>,
    pub skipped_items: Vec<DatabaseSyncSkippedItem>,
    pub blockers: Vec<DatabaseSyncBlocker>,
    pub can_execute: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecuteDatabaseSyncRequest {
    pub request: DatabaseSyncRequest,
    pub plan_fingerprint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncStatementSuccess {
    pub operation_id: String,
    pub statement_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncFailure {
    pub operation_id: String,
    pub statement_index: usize,
    pub error: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseSyncExecutionStatus {
    Succeeded,
    PartiallySucceeded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncExecutionResult {
    pub status: DatabaseSyncExecutionStatus,
    pub completed_statements: Vec<DatabaseSyncStatementSuccess>,
    pub failed: Option<DatabaseSyncFailure>,
    pub pending_operation_ids: Vec<String>,
    pub cleanup_errors: Vec<String>,
    pub latest_compare_result: Option<DatabaseCompareResult>,
}
```

在 `schema_compare/mod.rs` 给 `TableSnapshot` 增加 `Serialize`，并把字段比较改为可复用引用接口：

```rust
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub(crate) struct TableSnapshot {
    pub name: String,
    pub columns: Vec<(String, ColumnSnapshot)>,
}

pub(crate) fn compare_table_columns(
    source: &TableSnapshot,
    target: &TableSnapshot,
) -> Vec<ColumnDiff> {
    compare_columns(&source.columns, &target.columns)
}

fn compare_columns(
    source_columns: &[(String, ColumnSnapshot)],
    target_columns: &[(String, ColumnSnapshot)],
) -> Vec<ColumnDiff> {
    let mut columns: BTreeMap<String, (Option<ColumnSnapshot>, Option<ColumnSnapshot>)> =
        BTreeMap::new();
    for (name, details) in source_columns {
        columns.entry(name.clone()).or_default().0 = Some(details.clone());
    }
    for (name, details) in target_columns {
        columns.entry(name.clone()).or_default().1 = Some(details.clone());
    }
    build_column_differences(columns)
}
```

把现有 `compare_schema_snapshots()` 调用改为 `compare_columns(&source_columns, &target_columns)`，并将原 `compare_columns` 末尾的差异构建/排序主体抽成 `build_column_differences()`，内容保持原逻辑不变。

在 `schema_sync/mod.rs` 实现稳定计划核心：

```rust
use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::db::schema_compare::TableSnapshot;
use crate::models::types::{
    DatabaseSyncBlocker, DatabaseSyncOperation, DatabaseSyncOperationKind,
    DatabaseSyncPlanSummary, DatabaseSyncPreview, DatabaseSyncRequest, DatabaseSyncRisk,
    DatabaseSyncSkippedItem,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) enum ColumnSyncMetadata {
    MySql { generation_expression: String },
    Postgres {
        identity_generation: String,
        generated_kind: String,
        generation_expression: Option<String>,
    },
    Sqlite { hidden: i64 },
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
    source_tables: BTreeMap<
        &'a str,
        (&'a TableSnapshot, Option<&'a TableSyncMetadata>),
    >,
    target_tables: BTreeMap<
        &'a str,
        (&'a TableSnapshot, Option<&'a TableSyncMetadata>),
    >,
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
        a.table_name.cmp(&b.table_name).then_with(|| a.summary.cmp(&b.summary))
    });
    fragments.blockers.sort_by(|a, b| {
        a.table_name.cmp(&b.table_name).then_with(|| a.summary.cmp(&b.summary))
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
    let bytes = serde_json::to_vec(&payload)
        .map_err(|error| format!("生成同步计划指纹失败: {error}"))?;
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
```

- [ ] **Step 4: 运行计划核心与现有对比测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_ -- --nocapture`

Expected: PASS；同步核心测试通过，现有数据库对比算法测试无回归。

- [ ] **Step 5: 提交同步契约与核心**

```bash
git add src-tauri/src/models/types.rs src-tauri/src/db/mod.rs src-tauri/src/db/schema_compare/mod.rs src-tauri/src/db/schema_sync/mod.rs
git commit -m "feat: 增加数据库同步计划核心"
```

---

### Task 2: MySQL/MariaDB 同步方言

**Files:**
- Create: `src-tauri/src/db/schema_sync/mysql.rs`
- Modify: `src-tauri/src/db/schema_sync/mod.rs`

**Interfaces:**
- Consumes: `TablePlanContext`、`TableSyncMetadata::MySql`、`PlanFragments`、`compare_table_columns()`、`primary_key_columns()`。
- Produces: `mysql::metadata_sql()`、`mysql::load_metadata()`、`mysql::plan_table()`。

- [ ] **Step 1: 写 MySQL 失败测试**

在 `schema_sync/mysql.rs` 增加测试，覆盖单次表元数据查询、建表、字段顺序、主键与删除保护：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema_sync::TableSyncMetadata;
    use crate::models::types::ColumnSnapshot;

    fn table(name: &str, columns: Vec<(&str, u32, &str, bool)>) -> TableSnapshot {
        TableSnapshot {
            name: name.to_string(),
            columns: columns
                .into_iter()
                .map(|(name, position, column_type, primary_key)| {
                    (
                        name.to_string(),
                        ColumnSnapshot {
                            ordinal_position: position,
                            column_type: column_type.to_string(),
                            nullable: false,
                            default_value: None,
                            primary_key,
                            extra: String::new(),
                            comment: String::new(),
                        },
                    )
                })
                .collect(),
        }
    }

    #[test]
    fn metadata_query_loads_all_base_tables_once() {
        let sql = metadata_sql();
        assert!(sql.contains("information_schema.TABLES"));
        assert!(sql.contains("information_schema.COLUMNS"));
        assert!(sql.contains("GENERATION_EXPRESSION"));
        assert!(sql.contains("TABLE_SCHEMA = :schema"));
        assert!(sql.contains("TABLE_TYPE = 'BASE TABLE'"));
        assert!(!sql.contains(":table"));
    }

    #[test]
    fn plans_create_modify_primary_key_and_protected_drop() {
        let source = table(
            "users",
            vec![("id", 1, "bigint", true), ("email", 2, "varchar(255)", false)],
        );
        let target = table("users", vec![("id", 1, "int", false), ("legacy", 2, "text", false)]);
        let metadata = TableSyncMetadata::MySql {
            engine: "InnoDB".to_string(),
            comment: "用户".to_string(),
            columns: BTreeMap::new(),
        };
        let protected = plan_table(TablePlanContext {
            target_database: "app_copy",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&metadata),
            target_metadata: None,
            include_drops: false,
        });
        assert!(protected.operations.iter().any(|item| item.sql.iter().any(|sql| sql.contains("MODIFY COLUMN `id` bigint"))));
        assert!(protected.operations.iter().any(|item| item.sql.iter().any(|sql| sql.contains("ADD COLUMN `email` varchar(255)"))));
        assert!(protected.operations.iter().any(|item| item.sql.iter().any(|sql| sql.contains("ADD PRIMARY KEY (`id`)"))));
        assert!(!protected.operations.iter().flat_map(|item| &item.sql).any(|sql| sql.contains("DROP COLUMN `legacy`")));
        assert_eq!(protected.skipped_items.len(), 1);
    }
}
```

- [ ] **Step 2: 运行 MySQL 测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_sync::mysql::tests -- --nocapture`

Expected: FAIL，提示 `metadata_sql`、`load_metadata`、`plan_table` 不存在。

- [ ] **Step 3: 实现 MySQL 批量元数据和计划器**

实现固定一次元数据查询：

```rust
pub(crate) fn metadata_sql() -> &'static str {
    "SELECT tables.TABLE_NAME AS table_name, COALESCE(tables.ENGINE, '') AS engine, \
            tables.TABLE_COMMENT AS comment, columns.COLUMN_NAME AS column_name, \
            COALESCE(columns.GENERATION_EXPRESSION, '') AS generation_expression \
     FROM information_schema.TABLES tables \
     JOIN information_schema.COLUMNS columns \
       ON columns.TABLE_SCHEMA = tables.TABLE_SCHEMA \
      AND columns.TABLE_NAME = tables.TABLE_NAME \
     WHERE tables.TABLE_SCHEMA = :schema AND tables.TABLE_TYPE = 'BASE TABLE' \
     ORDER BY tables.TABLE_NAME, columns.ORDINAL_POSITION"
}

pub(crate) async fn load_metadata(
    pool: &mysql_async::Pool,
    schema: &str,
) -> Result<BTreeMap<String, TableSyncMetadata>, String> {
    let mut conn = get_conn_with_retry(pool).await?;
    let rows: Vec<mysql_async::Row> = conn
        .exec(metadata_sql(), mysql_async::params! { "schema" => schema })
        .await
        .map_err(|error| format!("查询 MySQL 同步表元数据失败: {error}"))?;
    let mut metadata = BTreeMap::new();
    for row in rows {
        let table_name = row.get::<String, _>("table_name").unwrap_or_default();
        let column_name = row.get::<String, _>("column_name").unwrap_or_default();
        let generation_expression = row
            .get::<String, _>("generation_expression")
            .unwrap_or_default();
        let entry = metadata
            .entry(table_name)
            .or_insert_with(|| TableSyncMetadata::MySql {
                engine: row.get::<String, _>("engine").unwrap_or_default(),
                comment: row.get::<String, _>("comment").unwrap_or_default(),
                columns: BTreeMap::new(),
            });
        let TableSyncMetadata::MySql { columns, .. } = entry else {
            unreachable!("MySQL 元数据映射只能创建 MySql 变体");
        };
        columns.insert(
            column_name,
            ColumnSyncMetadata::MySql { generation_expression },
        );
    }
    Ok(metadata)
}
```

在同文件实现以下明确规则：

```rust
pub(crate) fn plan_table(context: TablePlanContext<'_>) -> PlanFragments {
    let mut plan = PlanFragments::default();
    match (context.source, context.target) {
        (Some(source), None) => plan_create_table(&mut plan, &context, source),
        (None, Some(target)) => {
            if context.include_drops {
                plan.operation(
                    OperationPhase::DropTable,
                    &target.name,
                    DatabaseSyncOperationKind::DropTable,
                    DatabaseSyncRisk::Destructive,
                    &format!("删除目标端独有表 {}", target.name),
                    vec![format!(
                        "DROP TABLE {}.{}",
                        esc_id(context.target_database),
                        esc_id(&target.name)
                    )],
                );
            } else {
                plan.skip(&target.name, "跳过删除目标端独有表", "未开启包含删除操作");
            }
        }
        (Some(source), Some(target)) => plan_changed_table(&mut plan, &context, source, target),
        (None, None) => plan.block("", "无法规划同步", "表在源端和目标端都不存在"),
    }
    plan
}
```

`plan_create_table()` 使用 `build_column_definition()`、`primary_key_columns()` 和 `TableSyncMetadata::MySql` 生成目标库限定的 `CREATE TABLE`；`plan_changed_table()` 使用 `compare_table_columns()`：

- 源端独有字段生成 `ADD COLUMN`，按源端位置附加 `FIRST`/`AFTER`。
- 同名变化字段使用源端完整定义生成 `MODIFY COLUMN`，字段顺序变化同样附加位置子句。
- 目标端独有字段仅在 `include_drops` 为真时生成 `DROP COLUMN`，否则加入跳过项。
- 整张表的源/目标主键数组不同只生成一个 `DROP PRIMARY KEY`/`ADD PRIMARY KEY` 操作，不调用现有会逐表查询主键的命令函数。
- `validate_column_type()` 或 `validate_column_extra()` 失败时加入阻塞项，不输出该 SQL；生成列必须从 `ColumnSyncMetadata::MySql.generation_expression` 无损生成，表达式缺失时阻塞。

在 `schema_sync/mod.rs` 注册 `pub(crate) mod mysql;`。

- [ ] **Step 4: 运行 MySQL 与计划核心测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_sync:: -- --nocapture`

Expected: PASS；删除关闭时没有任何删除 SQL，操作按阶段稳定排序。

- [ ] **Step 5: 提交 MySQL/MariaDB 方言**

```bash
git add src-tauri/src/db/schema_sync/mod.rs src-tauri/src/db/schema_sync/mysql.rs
git commit -m "feat: 增加 MySQL 数据库同步方言"
```

---

### Task 3: PostgreSQL 同步方言

**Files:**
- Create: `src-tauri/src/db/schema_sync/postgres.rs`
- Modify: `src-tauri/src/db/schema_sync/mod.rs`

**Interfaces:**
- Consumes: `postgres_ddl` 的 create/add/alter/drop/primary-key builder、`TableSyncMetadata::Postgres`。
- Produces: `postgres::metadata_sql()`、`postgres::load_metadata()`、`postgres::plan_table()`。

- [ ] **Step 1: 写 PostgreSQL 失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_query_loads_table_kind_comment_and_primary_constraint_once() {
        let sql = metadata_sql();
        assert!(sql.contains("pg_catalog.pg_class"));
        assert!(sql.contains("pg_catalog.pg_constraint"));
        assert!(sql.contains("information_schema.columns"));
        assert!(sql.contains("generation_expression"));
        assert!(sql.contains("ns.nspname = $1"));
        assert!(sql.contains("cls.relkind IN ('r', 'p')"));
        assert!(!sql.contains("cls.relname = $2"));
    }

    #[test]
    fn ordinal_change_is_blocked_without_rebuilding_table() {
        let source = test_table("users", 2, "text", "");
        let target = test_table("users", 1, "text", "");
        let metadata = TableSyncMetadata::Postgres {
            relkind: "r".to_string(),
            table_comment: String::new(),
            primary_key_constraint: None,
            columns: BTreeMap::new(),
        };
        let plan = plan_table(TablePlanContext {
            target_database: "public",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&metadata),
            target_metadata: Some(&metadata),
            include_drops: false,
        });
        assert!(plan.operations.is_empty());
        assert_eq!(plan.blockers[0].reason, "PostgreSQL 不支持安全调整字段物理顺序");
    }
}
```

`test_table()` 在测试模块中构造仅含一个字段的 `TableSnapshot`，字段 `ordinal_position`、`column_type` 和 `extra` 使用传入值，其余属性使用非空、非主键、无默认值和空注释。

- [ ] **Step 2: 运行 PostgreSQL 测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_sync::postgres::tests -- --nocapture`

Expected: FAIL，提示 PostgreSQL 同步方言函数不存在。

- [ ] **Step 3: 实现 PostgreSQL 批量元数据和计划器**

元数据 SQL 必须一次返回所有物理表：

```rust
pub(crate) fn metadata_sql() -> &'static str {
    "SELECT cls.relname AS table_name, cls.relkind::text AS relkind, \
            COALESCE(pg_catalog.obj_description(cls.oid, 'pg_class'), '') AS table_comment, \
            primary_constraint.conname AS primary_key_constraint, cols.column_name, \
            COALESCE(cols.identity_generation, '') AS identity_generation, \
            cols.is_generated AS generated_kind, cols.generation_expression \
     FROM pg_catalog.pg_class cls \
     JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace \
     JOIN information_schema.columns cols \
       ON cols.table_schema = ns.nspname AND cols.table_name = cls.relname \
     LEFT JOIN pg_catalog.pg_constraint primary_constraint \
       ON primary_constraint.conrelid = cls.oid AND primary_constraint.contype = 'p' \
     WHERE ns.nspname = $1 AND cls.relkind IN ('r', 'p') \
     ORDER BY cls.relname, cols.ordinal_position"
}
```

`load_metadata()` 使用 `get_client_with_retry()` 与一次 `query(metadata_sql(), &[&schema])`，按 `table_name` 分组为 `TableSyncMetadata::Postgres`，并把每行的 `identity_generation`、`generated_kind`、`generation_expression` 写入对应 `ColumnSyncMetadata::Postgres`；不得为单表或单字段追加查询。

`plan_table()` 规则必须完整实现：

- 普通源端独有表：把 `TableSnapshot` 转成 `CreateTableRequest`，复用 `postgres_ddl::build_create_table_sqls()`；`create_sql` 和 `after_sqls` 合并为一个 `CreateTable` 操作的有序 SQL。
- `relkind = "p"` 的源端独有分区表：返回“PostgreSQL 分区表创建需要完整分区定义”的阻塞项。
- 源端独有字段只有在其源端位置位于目标端现有字段之后时才能复用 `build_add_column_sqls()`；插入中间位置返回顺序阻塞项。
- `changed_fields` 包含 `ordinal_position` 时阻塞。
- identity/generated 的结构化列元数据不一致时阻塞；创建 identity/generated 字段仅在 builder 能用完整 `identity_generation`/`generation_expression` 无损表达时生成，否则阻塞。
- 其他同名字段变化把目标端 `ColumnSnapshot` 映射成 `ColumnInfo`、源端映射成 `AlterColumnRequest`，复用 `build_alter_column_sqls()`。
- 主键数组变化时复用 `build_primary_key_change_sqls()`，当前约束名来自目标端 `TableSyncMetadata::Postgres`。
- 目标端独有字段/表遵守统一删除开关。

在 `schema_sync/mod.rs` 注册 `pub(crate) mod postgres;`。

- [ ] **Step 4: 运行 PostgreSQL 和既有 DDL 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml postgres -- --nocapture`

Expected: PASS；字段顺序和不完整分区表产生阻塞项，普通 DDL 与现有 builder 测试通过。

- [ ] **Step 5: 提交 PostgreSQL 方言**

```bash
git add src-tauri/src/db/schema_sync/mod.rs src-tauri/src/db/schema_sync/postgres.rs
git commit -m "feat: 增加 PostgreSQL 数据库同步方言"
```

---

### Task 4: SQLite 同步方言

**Files:**
- Create: `src-tauri/src/db/schema_sync/sqlite.rs`
- Modify: `src-tauri/src/db/schema_sync/mod.rs`

**Interfaces:**
- Consumes: `sqlite::build_create_table_sql()`、`sqlite::build_add_column_sql()`、`TableSyncMetadata::Sqlite`。
- Produces: `sqlite::metadata_sql()`、`sqlite::load_metadata()`、`sqlite::plan_table()`。

- [ ] **Step 1: 写 SQLite 失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_query_reads_sqlite_schema_once() {
        let sql = metadata_sql("main");
        assert!(sql.contains("\"main\".sqlite_schema"));
        assert!(sql.contains("objects.type = 'table'"));
        assert!(sql.contains("lower(objects.name) NOT GLOB 'sqlite_*'"));
        assert!(sql.contains("pragma_table_xinfo(objects.name"));
    }

    #[test]
    fn modifying_existing_column_is_blocked_instead_of_rebuilding() {
        let source = test_table("users", "text", false);
        let target = test_table("users", "integer", false);
        let metadata = TableSyncMetadata::Sqlite {
            create_sql: "CREATE TABLE users (name TEXT NOT NULL)".to_string(),
            columns: BTreeMap::new(),
        };
        let plan = plan_table(TablePlanContext {
            target_database: "main",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&metadata),
            target_metadata: Some(&metadata),
            include_drops: true,
        });
        assert!(plan.operations.is_empty());
        assert!(plan.blockers[0].reason.contains("不重建表"));
    }
}
```

`test_table()` 构造单字段 `TableSnapshot`；第三个参数控制 `extra` 是否为 `generated`。

- [ ] **Step 2: 运行 SQLite 测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_sync::sqlite::tests -- --nocapture`

Expected: FAIL，提示 SQLite 同步方言函数不存在。

- [ ] **Step 3: 实现 SQLite 原生能力计划器**

```rust
pub(crate) fn metadata_sql(schema: &str) -> String {
    format!(
        "SELECT objects.name AS table_name, COALESCE(objects.sql, '') AS create_sql, \
                columns.name AS column_name, columns.hidden \
         FROM {}.sqlite_schema objects \
         JOIN pragma_table_xinfo(objects.name, {}) columns \
         WHERE objects.type = 'table' AND lower(objects.name) NOT GLOB 'sqlite_*' \
         ORDER BY objects.name, columns.cid",
        sqlite_id(schema),
        sqlite_str(schema)
    )
}
```

`load_metadata()` 只执行上面一条 SQL，按表分组为 `TableSyncMetadata::Sqlite`，并把 `hidden` 写入每列的 `ColumnSyncMetadata::Sqlite`。`plan_table()` 必须执行以下规则：

- 源端独有普通表：字段 `extra` 为空且不含无法表达的 generated/auto_increment 组合时，把快照映射成 `CreateTableRequest` 并复用 `build_create_table_sql()`。
- `hidden != 0` 的 generated 字段、自增声明无法由结构化值无损重建时返回阻塞项，不直接执行 `create_sql`，避免带入外键或其他排除对象。
- 源端独有字段只有在末尾新增且 `extra` 为空时复用 `build_add_column_sql()`；中间插入、主键字段、generated 字段返回阻塞项。
- 目标端独有字段在删除开启时使用 `ALTER TABLE <schema>.<table> DROP COLUMN <column>`；关闭时加入跳过项。
- 任意已有字段的类型、可空、默认值、主键、extra、注释或顺序变化都返回“SQLite 首期不重建表修改已有字段”的阻塞项。
- 目标端独有表只在删除开启时生成 `DROP TABLE`。

在 `schema_sync/mod.rs` 注册 `pub(crate) mod sqlite;`。

- [ ] **Step 4: 运行 SQLite 方言与临时库测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sqlite -- --nocapture`

Expected: PASS；SQLite 修改已有字段明确阻塞，现有建表/增删字段与批量对比测试无回归。

- [ ] **Step 5: 提交 SQLite 方言**

```bash
git add src-tauri/src/db/schema_sync/mod.rs src-tauri/src/db/schema_sync/sqlite.rs
git commit -m "feat: 增加 SQLite 数据库同步方言"
```

---

### Task 5: SQL Server 同步方言

**Files:**
- Create: `src-tauri/src/db/schema_sync/sqlserver.rs`
- Modify: `src-tauri/src/db/schema_sync/mod.rs`

**Interfaces:**
- Consumes: `sqlserver_ddl` create/add/alter/drop builder、`TableSyncMetadata::SqlServer`。
- Produces: `sqlserver::metadata_sql()`、`sqlserver::load_metadata()`、`sqlserver::plan_table()`。

- [ ] **Step 1: 写 SQL Server 失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_query_reads_comments_and_primary_constraints_once() {
        let sql = metadata_sql("dbo");
        assert!(sql.contains("FROM sys.tables tables"));
        assert!(sql.contains("JOIN sys.columns columns"));
        assert!(sql.contains("LEFT JOIN sys.computed_columns"));
        assert!(sql.contains("LEFT JOIN sys.key_constraints"));
        assert!(sql.contains("schemas.name = N'dbo'"));
        assert!(!sql.contains("tables.name ="));
    }

    #[test]
    fn identity_or_ordinal_change_is_blocked() {
        let source = test_table("users", 2, "identity");
        let target = test_table("users", 1, "");
        let metadata = TableSyncMetadata::SqlServer {
            table_comment: String::new(),
            primary_key_constraint: None,
            columns: BTreeMap::new(),
        };
        let plan = plan_table(TablePlanContext {
            target_database: "dbo",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&metadata),
            target_metadata: Some(&metadata),
            include_drops: false,
        });
        assert!(plan.operations.is_empty());
        assert!(!plan.blockers.is_empty());
    }
}
```

- [ ] **Step 2: 运行 SQL Server 测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_sync::sqlserver::tests -- --nocapture`

Expected: FAIL，提示 SQL Server 同步方言函数不存在。

- [ ] **Step 3: 实现 SQL Server 批量元数据和计划器**

`metadata_sql(schema)` 一次查询 `sys.tables`、`sys.schemas`、`sys.columns`、`sys.types`、`sys.computed_columns`、`sys.key_constraints` 和表级 `MS_Description`，返回表名、表注释、主键约束名、字段名、`is_identity`、computed definition、`is_user_defined`、类型 schema 与类型名。`load_metadata()` 按表分组为 `TableSyncMetadata::SqlServer`，并把字段原生值写入 `ColumnSyncMetadata::SqlServer`。使用现有 `sqlserver_str()` 生成 schema 字面值，不拼接未经转义的输入，也不得按表检查用户定义类型。

`plan_table()` 规则：

- 源端独有普通表映射成 `CreateTableRequest`，复用 `build_create_table_sqls()`。
- 源端独有字段只有在目标末尾新增且不要求调整顺序时复用 `build_add_column_sqls()`。
- 字段顺序变化、结构化 `identity`/computed definition 变化返回阻塞项。
- 普通类型、可空、默认值和注释变化把快照转换成 `ColumnInfo`/`AlterColumnRequest`，复用 `build_alter_column_sqls()`。
- 主键数组变化时，使用元数据中的目标主键约束名生成 `DROP CONSTRAINT`，再用稳定且安全的 `PK_<table>` 约束名生成 `ADD CONSTRAINT ... PRIMARY KEY`；所有标识符使用 `sqlserver_id()`。
- 目标端独有字段复用 `build_drop_column_sql()`，且仅在删除开启时生成。
- 用户定义类型出现在源端时，首期无法用当前 schema 快照证明目标端类型存在，因此返回阻塞项，不在循环中查询类型，也不生成近似基础类型。

在 `schema_sync/mod.rs` 注册 `pub(crate) mod sqlserver;`。

- [ ] **Step 4: 运行 SQL Server 方言与既有 DDL 测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml sqlserver -- --nocapture`

Expected: PASS；identity/字段顺序阻塞，普通字段和主键 SQL 使用目标 schema 限定。

- [ ] **Step 5: 提交 SQL Server 方言**

```bash
git add src-tauri/src/db/schema_sync/mod.rs src-tauri/src/db/schema_sync/sqlserver.rs
git commit -m "feat: 增加 SQL Server 数据库同步方言"
```

---

### Task 6: ClickHouse 同步方言

**Files:**
- Create: `src-tauri/src/db/schema_sync/clickhouse.rs`
- Modify: `src-tauri/src/db/schema_sync/mod.rs`

**Interfaces:**
- Consumes: `clickhouse::fetch_json_each_rows()`、`clickhouse_id()`、`clickhouse_table_ref()`、`TableSyncMetadata::ClickHouse`。
- Produces: `clickhouse::metadata_sql()`、`clickhouse::load_metadata()`、`clickhouse::plan_table()`。

- [ ] **Step 1: 写 ClickHouse 失败测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_query_loads_engine_and_key_expressions_once() {
        let sql = metadata_sql();
        assert!(sql.contains("FROM system.tables"));
        assert!(sql.contains("JOIN system.columns"));
        assert!(sql.contains("engine_full"));
        assert!(sql.contains("default_expression"));
        assert!(sql.contains("sorting_key"));
        assert!(sql.contains("partition_key"));
        assert!(sql.contains("primary_key"));
        assert!(sql.contains("database = ?"));
        assert!(!sql.contains("name = ?"));
    }

    #[test]
    fn primary_key_membership_change_is_blocked() {
        let source = test_table("events", true, "");
        let target = test_table("events", false, "");
        let metadata = TableSyncMetadata::ClickHouse {
            engine_full: "MergeTree".to_string(),
            sorting_key: "id".to_string(),
            partition_key: String::new(),
            primary_key: "id".to_string(),
            comment: String::new(),
            columns: BTreeMap::new(),
        };
        let plan = plan_table(TablePlanContext {
            target_database: "analytics_copy",
            source: Some(&source),
            target: Some(&target),
            source_metadata: Some(&metadata),
            target_metadata: Some(&metadata),
            include_drops: false,
        });
        assert!(plan.operations.is_empty());
        assert_eq!(plan.blockers[0].reason, "ClickHouse 首期不修改主键或排序键表达式");
    }
}
```

`test_table()` 构造 `id UInt64` 单字段表，第二个参数写入 `primary_key`，第三个参数写入 `extra`。

- [ ] **Step 2: 运行 ClickHouse 测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_sync::clickhouse::tests -- --nocapture`

Expected: FAIL，提示 ClickHouse 同步方言函数不存在。

- [ ] **Step 3: 实现 ClickHouse 元数据和计划器**

```rust
pub(crate) fn metadata_sql() -> &'static str {
    "SELECT tables.name AS table_name, tables.engine_full, tables.sorting_key, \
            tables.partition_key, tables.primary_key, tables.comment, \
            columns.name AS column_name, columns.default_kind, columns.default_expression \
     FROM system.tables tables \
     JOIN system.columns columns \
       ON columns.database = tables.database AND columns.table = tables.name \
     WHERE tables.database = ? \
       AND tables.engine NOT IN ('View', 'MaterializedView', 'LiveView', 'WindowView') \
     ORDER BY tables.name, columns.position"
}

#[derive(Debug, serde::Deserialize)]
struct ClickHouseTableMetadataRow {
    table_name: String,
    engine_full: String,
    sorting_key: String,
    partition_key: String,
    primary_key: String,
    comment: String,
    column_name: String,
    default_kind: String,
    default_expression: String,
}
```

`load_metadata()` 使用一次 `fetch_json_each_rows(client.query(metadata_sql()).bind(database), "查询 ClickHouse 同步表元数据失败")`，按表分组为 `TableSyncMetadata::ClickHouse`，并把每列 `default_kind`/`default_expression` 写入 `ColumnSyncMetadata::ClickHouse`。

计划器必须实现以下 SQL 形态：

```rust
fn add_column_sql(database: &str, table: &str, name: &str, definition: &str) -> String {
    format!(
        "ALTER TABLE {} ADD COLUMN {} {}",
        clickhouse_table_ref(database, table),
        clickhouse_id(name),
        definition
    )
}

fn modify_column_sql(database: &str, table: &str, name: &str, definition: &str) -> String {
    format!(
        "ALTER TABLE {} MODIFY COLUMN {} {}",
        clickhouse_table_ref(database, table),
        clickhouse_id(name),
        definition
    )
}

fn drop_column_sql(database: &str, table: &str, name: &str) -> String {
    format!(
        "ALTER TABLE {} DROP COLUMN {}",
        clickhouse_table_ref(database, table),
        clickhouse_id(name)
    )
}
```

字段定义由源端 `column_type` 和结构化 `ColumnSyncMetadata::ClickHouse` 生成：空 `default_kind` 不带子句；`DEFAULT`、`MATERIALIZED`、`ALIAS` 分别输出关键字与 `default_expression`；未知 kind 或表达式缺失返回阻塞项。注释使用 `COMMENT <escaped literal>`。

源端独有表使用源端 `engine_full`，并在非空时附加 `PARTITION BY`、`PRIMARY KEY`、`ORDER BY` 与 `COMMENT`。同名表字段增删改使用 ClickHouse `ALTER TABLE`；主键成员变化、引擎/排序键差异和无法安全表达的 extra 返回阻塞项。字段顺序变化通过 `FIRST`/`AFTER` 附加到新增或修改字段定义。目标端独有表遵守删除开关。

在 `schema_sync/mod.rs` 注册 `pub(crate) mod clickhouse;`。

- [ ] **Step 4: 运行 ClickHouse 方言与快照测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml clickhouse -- --nocapture`

Expected: PASS；键变化阻塞，普通字段 DDL 使用目标数据库限定名。

- [ ] **Step 5: 提交 ClickHouse 方言**

```bash
git add src-tauri/src/db/schema_sync/mod.rs src-tauri/src/db/schema_sync/clickhouse.rs
git commit -m "feat: 增加 ClickHouse 数据库同步方言"
```

---

### Task 7: 五类方言分发与完整计划生成

**Files:**
- Modify: `src-tauri/src/db/schema_sync/mod.rs`

**Interfaces:**
- Consumes: `load_schema_snapshot()`、五个 `load_metadata()`、五个 `plan_table()`。
- Produces: `load_sync_schema_snapshot()`、`build_database_sync_preview()`。

- [ ] **Step 1: 写分发与选择校验失败测试**

```rust
#[test]
fn build_preview_rejects_selected_table_that_is_no_longer_different() {
    let request = request(vec!["users"], false);
    let source = SyncSchemaSnapshot {
        tables: vec![table("users", "bigint")],
        metadata: BTreeMap::new(),
    };
    let target = SyncSchemaSnapshot {
        tables: vec![table("users", "bigint")],
        metadata: BTreeMap::new(),
    };

    let error = build_database_sync_preview(DatabaseType::MySql, &request, &source, &target)
        .unwrap_err();

    assert_eq!(error, "所选表 users 已不存在差异，请重新对比");
}

#[test]
fn delete_disabled_preview_contains_skipped_item_and_no_drop_sql() {
    let request = request(vec!["legacy"], false);
    let source = SyncSchemaSnapshot { tables: vec![], metadata: BTreeMap::new() };
    let target = SyncSchemaSnapshot {
        tables: vec![table("legacy", "bigint")],
        metadata: BTreeMap::new(),
    };
    let preview = build_database_sync_preview(DatabaseType::MySql, &request, &source, &target)
        .unwrap();
    assert!(!preview.can_execute);
    assert!(preview.operations.is_empty());
    assert_eq!(preview.skipped_items.len(), 1);
}
```

- [ ] **Step 2: 运行分发测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_sync::tests -- --nocapture`

Expected: FAIL，提示 `build_database_sync_preview` 尚不存在。

- [ ] **Step 3: 实现批量快照装配和方言分发**

```rust
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
        DatabasePoolHandle::Sqlite(handle) => {
            sqlite::load_metadata(&handle.pool, database).await?
        }
        DatabasePoolHandle::SqlServer(handle) => {
            sqlserver::load_metadata(&handle.pool, database).await?
        }
        DatabasePoolHandle::ClickHouse(handle) => {
            clickhouse::load_metadata(&handle.client, database).await?
        }
    };
    Ok(SyncSchemaSnapshot { tables, metadata })
}
```

实现 `build_database_sync_preview()`：

```rust
pub(crate) fn build_database_sync_preview(
    database_type: DatabaseType,
    request: &DatabaseSyncRequest,
    source: &SyncSchemaSnapshot,
    target: &SyncSchemaSnapshot,
) -> Result<DatabaseSyncPreview, String> {
    let selected = normalize_selected_tables(&request.selected_tables)?;
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
        if let (Some(source_table), Some(target_table)) = (source_table, target_table) {
            if compare_table_columns(source_table, target_table).is_empty() {
                return Err(format!("所选表 {table_name} 已不存在差异，请重新对比"));
            }
        }
        let context = TablePlanContext {
            target_database: &request.target.database,
            source: source_table,
            target: target_table,
            source_metadata: source.metadata.get(table_name),
            target_metadata: target.metadata.get(table_name),
            include_drops: request.include_drops,
        };
        let mut table_plan = match database_type {
            DatabaseType::MySql => mysql::plan_table(context),
            DatabaseType::Postgres => postgres::plan_table(context),
            DatabaseType::Sqlite => sqlite::plan_table(context),
            DatabaseType::SqlServer => sqlserver::plan_table(context),
            DatabaseType::ClickHouse => clickhouse::plan_table(context),
        };
        fragments.operations.append(&mut table_plan.operations);
        fragments.skipped_items.append(&mut table_plan.skipped_items);
        fragments.blockers.append(&mut table_plan.blockers);
    }
    finalize_preview(request, source, target, fragments)
}
```

在 `load_sync_schema_snapshot()` 上方导入 `DatabasePoolHandle` 和现有 `load_schema_snapshot()`。确认 `DatabasePoolHandle` 继续派生 `Clone`；不得在所选表循环内发出元数据查询。

- [ ] **Step 4: 运行全部同步计划测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_sync:: -- --nocapture`

Expected: PASS；五类方言、指纹和选择校验测试全部通过。

- [ ] **Step 5: 提交方言分发**

```bash
git add src-tauri/src/db/schema_sync/mod.rs
git commit -m "feat: 组装数据库同步计划"
```

---

### Task 8: 抽取共享临时数据库端点

**Files:**
- Create: `src-tauri/src/commands/temporary_database.rs`
- Modify: `src-tauri/src/commands/database_compare.rs:1-165`
- Modify: `src-tauri/src/commands/mod.rs:1-18`

**Interfaces:**
- Consumes: `ConnectionManager::prepare_connection()`、`ConnectionConfig`、`DatabasePoolHandle`。
- Produces: `TemporaryDatabaseConnection`、`find_saved_connection()`、`validate_endpoint_configs()`、`redact_error_text()`、清理合并函数。

- [ ] **Step 1: 写共享安全辅助测试**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{ConnectionConfig, DatabaseType};

    #[test]
    fn validation_rejects_same_connection_and_read_only_target() {
        let source = config("same", DatabaseType::MySql, false);
        let same_target = config("same", DatabaseType::MySql, false);
        assert_eq!(
            validate_endpoint_configs(&source, &same_target).unwrap_err(),
            "源端和目标端不能使用同一个保存连接"
        );
        let target = config("target", DatabaseType::MySql, true);
        assert_eq!(
            validate_sync_target(&target).unwrap_err(),
            "目标端保存连接配置为只读，不能执行数据库同步"
        );
    }

    #[test]
    fn redaction_removes_database_ssh_and_certificate_passwords() {
        let saved = vec![config_with_secrets("db-pass", "ssh-pass", "cert-pass")];
        let redacted = redact_error_text(
            "db-pass / ssh-pass / cert-pass".to_string(),
            &saved,
        );
        assert_eq!(redacted, "•••••••• / •••••••• / ••••••••");
    }
}
```

测试辅助 `config()` 和 `config_with_secrets()` 使用现有 `ConnectionConfig` 全字段构造方式；`config()` 的第三个参数写入 `read_only`。

- [ ] **Step 2: 运行共享辅助测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml temporary_database::tests -- --nocapture`

Expected: FAIL，提示共享模块或函数不存在。

- [ ] **Step 3: 移动现有临时连接和安全逻辑**

把 `database_compare.rs` 中以下逻辑原样移动并改为 `pub(crate)`：

```rust
pub(crate) struct TemporaryDatabaseConnection {
    active: ActiveConnection,
}

impl TemporaryDatabaseConnection {
    pub(crate) async fn open(config: ConnectionConfig) -> Result<Self, String> {
        let (_, active) = ConnectionManager::prepare_connection(config).await?;
        Ok(Self { active })
    }

    pub(crate) fn pool_handle(&self) -> DatabasePoolHandle {
        self.active.database.pool_handle()
    }

    pub(crate) async fn close(self) -> Result<(), String> {
        run_cleanup_with_timeout(
            self.active.database.disconnect(),
            TEMPORARY_CONNECTION_CLOSE_TIMEOUT,
        )
        .await
    }
}

pub(crate) fn validate_sync_target(target: &ConnectionConfig) -> Result<(), String> {
    if target.read_only == Some(true) {
        Err("目标端保存连接配置为只读，不能执行数据库同步".to_string())
    } else {
        Ok(())
    }
}

pub(crate) fn redact_error_text(
    mut error: String,
    saved: &[ConnectionConfig],
) -> String {
    let mut secrets = saved
        .iter()
        .flat_map(|config| {
            [
                config.password.as_deref(),
                config.ssh.as_ref().and_then(|ssh| ssh.password.as_deref()),
                config.ssl_pkcs12_password.as_deref(),
            ]
        })
        .flatten()
        .filter(|secret| !secret.is_empty() && *secret != PASSWORD_REDACTED)
        .collect::<Vec<_>>();
    secrets.sort_unstable_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    secrets.dedup();
    for secret in secrets {
        error = error.replace(secret, PASSWORD_REDACTED);
    }
    error
}
```

同时移动并公开：`find_saved_connection()`、`validate_endpoint_configs()`、`temporary_connection_error()`、`merge_operation_and_cleanup()`、`merge_single_operation_and_cleanup()`。错误文案保持现有对比测试预期；超时文案改为通用“释放临时数据库连接超时”。

`database_compare.rs` 改为导入这些函数并将 `TemporaryConnection` 重命名为 `TemporaryDatabaseConnection`。`commands/mod.rs` 注册 `pub mod temporary_database;`。

- [ ] **Step 4: 运行共享辅助和全部对比命令测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml temporary_database::tests -- --nocapture`

Expected: PASS，共享临时连接的校验和清理测试通过。

Run: `cargo test --manifest-path src-tauri/Cargo.toml database_compare::tests -- --nocapture`

Expected: PASS；现有数据库对比错误、清理和凭据脱敏行为无回归。

- [ ] **Step 5: 提交共享临时端点**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/commands/temporary_database.rs src-tauri/src/commands/database_compare.rs
git commit -m "refactor: 复用临时数据库连接安全逻辑"
```

---

### Task 9: 数据库同步预览命令

**Files:**
- Create: `src-tauri/src/commands/database_sync.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs:1-105`

**Interfaces:**
- Consumes: `load_saved_connections_internal()`、共享临时连接、`list_databases_for_compare()`、`load_sync_schema_snapshot()`、`build_database_sync_preview()`。
- Produces: Tauri 命令 `preview_database_sync(app, request)`。

- [ ] **Step 1: 写预览命令边界失败测试**

在 `database_sync.rs` 增加纯配置测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::DatabaseType;

    #[test]
    fn resolve_sync_configs_rejects_read_only_target() {
        let saved = vec![
            config("source", DatabaseType::Postgres, false),
            config("target", DatabaseType::Postgres, true),
        ];
        let error = resolve_sync_configs(&saved, &request(vec!["users"], false)).unwrap_err();
        assert_eq!(error, "目标端保存连接配置为只读，不能执行数据库同步");
    }

    #[test]
    fn endpoint_error_mentions_side_connection_and_database() {
        let error = selected_database_error("目标端", "测试库", "app_copy", "无权限");
        assert_eq!(
            error,
            "目标端连接「测试库」读取数据库/schema「app_copy」失败: 无权限"
        );
    }
}
```

- [ ] **Step 2: 运行预览命令测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml database_sync::tests -- --nocapture`

Expected: FAIL，提示 `database_sync`、`resolve_sync_configs` 等不存在。

- [ ] **Step 3: 实现预览命令并注册 Tauri handler**

实现以下入口和纯配置解析：

```rust
#[tauri::command]
pub async fn preview_database_sync(
    app: AppHandle,
    request: DatabaseSyncRequest,
) -> Result<DatabaseSyncPreview, String> {
    let saved = load_saved_connections_internal(&app)
        .map_err(|error| redact_error_text(error, &[]))?;
    let result = preview_database_sync_with_saved(&saved, &request).await;
    result.map_err(|error| redact_error_text(error, &saved))
}

fn resolve_sync_configs(
    saved: &[ConnectionConfig],
    request: &DatabaseSyncRequest,
) -> Result<(ConnectionConfig, ConnectionConfig), String> {
    let source = find_saved_connection(saved, &request.source.saved_connection_id, "源端")?;
    let target = find_saved_connection(saved, &request.target.saved_connection_id, "目标端")?;
    validate_endpoint_configs(&source, &target)?;
    validate_sync_target(&target)?;
    Ok((source, target))
}
```

`preview_database_sync_with_saved()` 必须：

1. 并行打开两侧 `TemporaryDatabaseConnection`。
2. 对每端调用一次 `list_databases_for_compare()`，确认选择仍存在。
3. 并行调用 `load_sync_schema_snapshot()`。
4. 使用源端数据库类型调用 `build_database_sync_preview()`。
5. 无论成功或失败都关闭两侧连接，并复用 `merge_operation_and_cleanup()`。

在 `commands/mod.rs` 注册 `pub mod database_sync;`，在 `lib.rs` 的 `use commands` 和 `generate_handler!` 中加入 `database_sync::preview_database_sync`。

- [ ] **Step 4: 运行预览命令与模块编译测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml database_sync::tests -- --nocapture`

Expected: PASS，预览命令测试通过。

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_sync:: -- --nocapture`

Expected: PASS；预览命令只读路径编译，配置和方言计划测试通过。

- [ ] **Step 5: 提交同步预览命令**

```bash
git add src-tauri/src/commands/database_sync.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat: 增加数据库同步预览命令"
```

---

### Task 10: 指纹校验、逐语句执行与部分结果

**Files:**
- Modify: `src-tauri/src/commands/database_sync.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `ExecuteDatabaseSyncRequest`、`DatabaseSyncPreview`、`DatabasePoolHandle`、`compare_schema_snapshots()`。
- Produces: `execute_operations_with()`、`execute_sync_statement()`、Tauri 命令 `execute_database_sync(app, input)`。

- [ ] **Step 1: 写首个失败停止和指纹漂移失败测试**

```rust
#[tokio::test]
async fn execution_stops_at_first_failed_statement_and_reports_pending_operations() {
    let operations = vec![
        operation("op-0001", vec!["SQL 1"]),
        operation("op-0002", vec!["SQL 2", "SQL 3"]),
        operation("op-0003", vec!["SQL 4"]),
    ];
    let seen = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let seen_for_execute = seen.clone();
    let result = execute_operations_with(&operations, move |sql| {
        let seen = seen_for_execute.clone();
        let sql = sql.to_string();
        async move {
            seen.lock().await.push(sql.clone());
            if sql == "SQL 3" { Err("模拟失败".to_string()) } else { Ok(()) }
        }
    })
    .await;

    assert_eq!(*seen.lock().await, vec!["SQL 1", "SQL 2", "SQL 3"]);
    assert_eq!(result.status, DatabaseSyncExecutionStatus::PartiallySucceeded);
    assert_eq!(result.completed_statements.len(), 2);
    assert_eq!(result.failed.unwrap().operation_id, "op-0002");
    assert_eq!(result.pending_operation_ids, vec!["op-0002", "op-0003"]);
}

#[test]
fn fingerprint_mismatch_is_rejected_before_execution() {
    let error = validate_plan_fingerprint("confirmed", "current").unwrap_err();
    assert_eq!(error, "数据库结构已变化，请重新对比并预览同步计划");
}
```

同一测试模块再增加两个真实临时 SQLite 用例，路径使用 `std::env::temp_dir()` + `Uuid`，测试结束关闭连接并删除文件：

```rust
#[tokio::test]
async fn sqlite_round_trip_creates_adds_drops_and_returns_no_remaining_diff() {
    // source: users(id, name) + audit(id)
    // target: users(id, legacy) + old_table(id)
    let (saved, request, source_path, target_path) = sqlite_sync_fixture();
    let preview = preview_database_sync_with_saved(&saved, &request)
        .await
        .expect("preview");
    assert!(preview.can_execute);
    assert!(preview.summary.destructive_operations >= 2);

    let result = execute_database_sync_with_saved(
        &saved,
        ExecuteDatabaseSyncRequest {
            request,
            plan_fingerprint: preview.plan_fingerprint,
        },
    )
    .await
    .expect("execute");

    assert_eq!(result.status, DatabaseSyncExecutionStatus::Succeeded);
    assert!(result.failed.is_none());
    assert!(result
        .latest_compare_result
        .as_ref()
        .expect("latest compare")
        .tables
        .is_empty());
    remove_sqlite_fixture(source_path, target_path);
}

#[tokio::test]
async fn sqlite_drift_rejects_execution_before_any_planned_ddl() {
    let (saved, request, source_path, target_path) = sqlite_add_column_fixture();
    let preview = preview_database_sync_with_saved(&saved, &request)
        .await
        .expect("preview");
    rusqlite::Connection::open(&target_path)
        .unwrap()
        .execute_batch("ALTER TABLE users ADD COLUMN external_change TEXT")
        .unwrap();

    let error = execute_database_sync_with_saved(
        &saved,
        ExecuteDatabaseSyncRequest {
            request,
            plan_fingerprint: preview.plan_fingerprint,
        },
    )
    .await
    .unwrap_err();

    assert_eq!(error, "数据库结构已变化，请重新对比并预览同步计划");
    let columns = sqlite_column_names(&target_path, "users");
    assert!(columns.contains(&"external_change".to_string()));
    assert!(!columns.contains(&"name".to_string()));
    remove_sqlite_fixture(source_path, target_path);
}
```

`sqlite_sync_fixture()`/`sqlite_add_column_fixture()` 使用两个不同 ID 的 SQLite `ConnectionConfig`，请求两侧数据库均为 `main`；前者选中 `audit`、`old_table`、`users` 并开启删除，后者只选 `users` 且关闭删除。

- [ ] **Step 2: 运行执行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml database_sync::tests -- --nocapture`

Expected: FAIL，提示执行辅助和指纹校验不存在。

- [ ] **Step 3: 实现逐语句执行器和 Tauri 命令**

实现纯执行循环，失败后不得再调用闭包：

```rust
async fn execute_operations_with<F, Fut>(
    operations: &[DatabaseSyncOperation],
    mut execute: F,
) -> DatabaseSyncExecutionResult
where
    F: FnMut(&str) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    let mut completed = Vec::new();
    for (operation_index, operation) in operations.iter().enumerate() {
        for (statement_index, sql) in operation.sql.iter().enumerate() {
            if let Err(error) = execute(sql).await {
                return DatabaseSyncExecutionResult {
                    status: if completed.is_empty() {
                        DatabaseSyncExecutionStatus::Failed
                    } else {
                        DatabaseSyncExecutionStatus::PartiallySucceeded
                    },
                    completed_statements: completed,
                    failed: Some(DatabaseSyncFailure {
                        operation_id: operation.id.clone(),
                        statement_index,
                        error,
                    }),
                    pending_operation_ids: operations[operation_index..]
                        .iter()
                        .map(|item| item.id.clone())
                        .collect(),
                    cleanup_errors: Vec::new(),
                    latest_compare_result: None,
                };
            }
            completed.push(DatabaseSyncStatementSuccess {
                operation_id: operation.id.clone(),
                statement_index,
            });
        }
    }
    DatabaseSyncExecutionResult {
        status: DatabaseSyncExecutionStatus::Succeeded,
        completed_statements: completed,
        failed: None,
        pending_operation_ids: Vec::new(),
        cleanup_errors: Vec::new(),
        latest_compare_result: None,
    }
}

fn validate_plan_fingerprint(confirmed: &str, current: &str) -> Result<(), String> {
    if confirmed == current {
        Ok(())
    } else {
        Err("数据库结构已变化，请重新对比并预览同步计划".to_string())
    }
}
```

`execute_sync_statement(pool, sql)` 按 `DatabasePoolHandle` 分发：MySQL 使用 `get_conn_with_retry()` + `query_drop()`；PostgreSQL 使用 `get_client_with_retry()` + `batch_execute()`；SQLite 使用 `pool.get().await?.interact()` + `execute_batch()`；SQL Server 使用 `pool.get().await?.simple_query(sql).await?.into_results().await`；ClickHouse 使用 `client.query(sql).execute().await`。每个分支只执行传入的后端计划 SQL，并返回带数据库类型上下文的错误。

实现命令：

```rust
#[tauri::command]
pub async fn execute_database_sync(
    app: AppHandle,
    input: ExecuteDatabaseSyncRequest,
) -> Result<DatabaseSyncExecutionResult, String> {
    let saved = load_saved_connections_internal(&app)
        .map_err(|error| redact_error_text(error, &[]))?;
    let result = execute_database_sync_with_saved(&saved, input).await;
    redact_execution_result(result, &saved)
}
```

`execute_database_sync_with_saved()` 重复预览的连接、数据库存在和批量快照流程，重新生成计划并调用 `validate_plan_fingerprint()`。`preview.can_execute` 为假、操作为空、删除关闭但计划包含 `Destructive` 时执行零条 DDL。指纹一致后调用执行循环；全部成功时重新批量加载两端快照，调用 `compare_schema_snapshots()` 生成 `latest_compare_result`。

关闭连接后把清理错误追加到结果 `cleanup_errors`，不得丢失已成功语句。`redact_execution_result()` 同时脱敏顶层 `Err`、`failed.error` 和 `cleanup_errors`。在 `lib.rs` 注册 `database_sync::execute_database_sync`。

- [ ] **Step 4: 运行命令、执行和后端全量测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- --nocapture`

Expected: PASS；指纹漂移执行零条语句，首个失败后没有后续调用，SQLite 创建/新增/删除真实落库且成功结果携带无剩余差异的最新对比。

- [ ] **Step 5: 提交同步执行命令**

```bash
git add src-tauri/src/commands/database_sync.rs src-tauri/src/lib.rs
git commit -m "feat: 执行数据库结构同步计划"
```

---

### Task 11: 前端同步契约、命令封装与选择纯函数

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/services/tauriCommands.ts`
- Create: `src/utils/databaseSync.ts`
- Create: `src/__tests__/databaseSync.test.ts`

**Interfaces:**

```ts
export type DatabaseSyncRisk = "normal" | "high" | "destructive";
export type DatabaseSyncOperationKind =
  | "create_table"
  | "add_column"
  | "alter_column"
  | "replace_primary_key"
  | "drop_column"
  | "drop_table"
  | "update_comment";

export interface DatabaseSyncRequest {
  source: DatabaseCompareEndpointRequest;
  target: DatabaseCompareEndpointRequest;
  selected_tables: string[];
  include_drops: boolean;
}

export interface DatabaseSyncOperation {
  id: string;
  table_name: string;
  kind: DatabaseSyncOperationKind;
  summary: string;
  risk: DatabaseSyncRisk;
  sql: string[];
}

export interface DatabaseSyncSkippedItem {
  table_name: string;
  summary: string;
  reason: string;
}

export interface DatabaseSyncBlocker {
  table_name: string;
  summary: string;
  reason: string;
}

export interface DatabaseSyncPlanSummary {
  selected_tables: number;
  executable_operations: number;
  high_risk_operations: number;
  destructive_operations: number;
  skipped_items: number;
  blockers: number;
}

export interface DatabaseSyncPreview {
  plan_fingerprint: string;
  summary: DatabaseSyncPlanSummary;
  operations: DatabaseSyncOperation[];
  skipped_items: DatabaseSyncSkippedItem[];
  blockers: DatabaseSyncBlocker[];
  can_execute: boolean;
}

export interface ExecuteDatabaseSyncRequest {
  request: DatabaseSyncRequest;
  plan_fingerprint: string;
}

export interface DatabaseSyncStatementSuccess {
  operation_id: string;
  statement_index: number;
}

export interface DatabaseSyncFailure {
  operation_id: string;
  statement_index: number;
  error: string;
}

export type DatabaseSyncExecutionStatus =
  | "succeeded"
  | "partially_succeeded"
  | "failed";

export interface DatabaseSyncExecutionResult {
  status: DatabaseSyncExecutionStatus;
  completed_statements: DatabaseSyncStatementSuccess[];
  failed: DatabaseSyncFailure | null;
  pending_operation_ids: string[];
  cleanup_errors: string[];
  latest_compare_result: DatabaseCompareResult | null;
}
```

服务层只暴露：

```ts
export const previewDatabaseSync = (request: DatabaseSyncRequest) =>
  invoke<DatabaseSyncPreview>("preview_database_sync", { request });

export const executeDatabaseSync = (input: ExecuteDatabaseSyncRequest) =>
  invoke<DatabaseSyncExecutionResult>("execute_database_sync", { input });
```

- [ ] **Step 1: 写表级选择纯函数失败测试**

```ts
import { describe, expect, it } from "vitest";
import {
  eligibleSyncTableNames,
  normalizeSyncSelection,
  selectAllSyncTables,
  toggleSyncTable,
} from "../utils/databaseSync";

const tables = [
  { name: "changed", status: "changed", columns: [] },
  { name: "new_table", status: "source_only", columns: [] },
  { name: "old_table", status: "target_only", columns: [] },
] as TableDiff[];

describe("databaseSync selection", () => {
  it("删除关闭时排除目标端独有表", () => {
    expect(eligibleSyncTableNames(tables, false)).toEqual(["changed", "new_table"]);
  });

  it("删除开启时目标端独有表可选", () => {
    expect(selectAllSyncTables(tables, true)).toEqual([
      "changed",
      "new_table",
      "old_table",
    ]);
  });

  it("开关删除后清理失效选择，并保持未显示筛选项", () => {
    const selected = ["changed", "old_table"];
    expect(normalizeSyncSelection(selected, tables, false)).toEqual(["changed"]);
    expect(toggleSyncTable(selected, "new_table", true)).toEqual([
      "changed",
      "new_table",
      "old_table",
    ]);
  });
});
```

- [ ] **Step 2: 运行前端纯函数测试确认失败**

Run: `npm test -- src/__tests__/databaseSync.test.ts`

Expected: FAIL，提示 `databaseSync` 模块或同步类型不存在。

- [ ] **Step 3: 实现类型、命令封装和纯函数**

```ts
export function eligibleSyncTableNames(
  tables: TableDiff[],
  includeDrops: boolean,
): string[] {
  return tables
    .filter((table) => includeDrops || table.status !== "target_only")
    .map((table) => table.name)
    .sort((left, right) => left.localeCompare(right));
}

export function normalizeSyncSelection(
  selected: string[],
  tables: TableDiff[],
  includeDrops: boolean,
): string[] {
  const eligible = new Set(eligibleSyncTableNames(tables, includeDrops));
  return [...new Set(selected)].filter((name) => eligible.has(name)).sort();
}

export function toggleSyncTable(
  selected: string[],
  tableName: string,
  checked: boolean,
): string[] {
  const next = new Set(selected);
  checked ? next.add(tableName) : next.delete(tableName);
  return [...next].sort();
}

export const selectAllSyncTables = eligibleSyncTableNames;
```

另实现 `formatSyncRisk(risk)`，分别返回“普通 / 高风险 / 删除”。所有字段名与 Rust `serde(rename_all = "snake_case")` 输出保持一致。

- [ ] **Step 4: 运行纯函数和 TypeScript 构建测试**

Run: `npm test -- src/__tests__/databaseSync.test.ts`

Expected: PASS。

Run: `npm run build`

Expected: PASS，前后端同步契约无 TypeScript 错误。

- [ ] **Step 5: 提交前端契约**

```bash
git add src/types/index.ts src/services/tauriCommands.ts src/utils/databaseSync.ts src/__tests__/databaseSync.test.ts
git commit -m "feat: 增加数据库同步前端契约"
```

---

### Task 12: 抽取可选择的数据库对比结果组件

**Files:**
- Create: `src/components/databaseCompare/DatabaseCompareResults.tsx`
- Modify: `src/components/databaseCompare/DatabaseCompareModal.tsx`
- Modify: `src/components/databaseCompare/DatabaseCompareModal.css`
- Create: `src/__tests__/DatabaseCompareResults.test.tsx`
- Modify: `src/__tests__/DatabaseCompareModal.test.tsx`

**Interfaces:**

```ts
interface DatabaseCompareResultsProps {
  result: DatabaseCompareResult;
  disabled: boolean;
  selectedTableNames: string[];
  includeDrops: boolean;
  onSelectionChange: (tableNames: string[]) => void;
  onIncludeDropsChange: (checked: boolean) => void;
}
```

组件内部保留现有摘要、搜索、状态筛选、差异字段展开和详情列；父组件只管理跨步骤必须持久化的选择与删除开关。

- [ ] **Step 1: 写结果选择组件失败测试**

```tsx
it("筛选后点击全选仍选择全部符合条件的表", async () => {
  const onSelectionChange = vi.fn();
  render(
    <DatabaseCompareResults
      result={compareResult}
      disabled={false}
      selectedTableNames={[]}
      includeDrops={false}
      onSelectionChange={onSelectionChange}
      onIncludeDropsChange={vi.fn()}
    />,
  );

  await userEvent.type(screen.getByPlaceholderText("搜索表名"), "users");
  await userEvent.click(screen.getByRole("checkbox", { name: "选择全部可同步表" }));
  expect(onSelectionChange).toHaveBeenCalledWith(["orders", "users"]);
});

it("删除默认关闭且目标端独有表不可选", () => {
  renderResults();
  expect(screen.getByRole("switch", { name: "允许删除目标端结构" })).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: "选择 old_logs" })).toBeDisabled();
});

it("结果变化时重置组件内搜索和状态筛选", async () => {
  const { rerender } = renderResults();
  await userEvent.type(screen.getByPlaceholderText("搜索表名"), "users");
  rerender(<DatabaseCompareResults {...baseProps} result={nextResult} />);
  expect(screen.getByPlaceholderText("搜索表名")).toHaveValue("");
});
```

测试 fixture 至少包含 `changed`、`source_only`、`target_only` 三类差异表。

- [ ] **Step 2: 运行组件测试确认失败**

Run: `npm test -- src/__tests__/DatabaseCompareResults.test.tsx`

Expected: FAIL，提示结果组件不存在。

- [ ] **Step 3: 抽取现有展示并增加选择行为**

使用受控 `Table` 行选择和独立的全选复选框。Ant Design 表格的内置全选只针对当前过滤后的 `dataSource`，因此工具栏全选必须始终调用完整 `result.tables`：

```tsx
const eligibleNames = eligibleSyncTableNames(result.tables, includeDrops);
const allSelected =
  eligibleNames.length > 0 &&
  eligibleNames.every((name) => selectedTableNames.includes(name));

<Checkbox
  aria-label="选择全部可同步表"
  checked={allSelected}
  indeterminate={!allSelected && selectedTableNames.length > 0}
  disabled={disabled || eligibleNames.length === 0}
  onChange={(event) =>
    onSelectionChange(event.target.checked ? eligibleNames : [])
  }
>
  全选可同步表
</Checkbox>

<Switch
  aria-label="允许删除目标端结构"
  checked={includeDrops}
  disabled={disabled}
  onChange={(checked) => {
    onIncludeDropsChange(checked);
    onSelectionChange(
      normalizeSyncSelection(selectedTableNames, result.tables, checked),
    );
  }}
/>
```

`rowSelection.getCheckboxProps` 在删除关闭时禁用目标端独有表；`rowKey="name"`，`onSelect` 使用 `toggleSyncTable()`。用 `useEffect([result])` 重置组件内部搜索和状态筛选，不清除父组件选择。

父组件先用新组件替换内联结果表，维持现有功能与测试语义不变。

- [ ] **Step 4: 运行结果组件和原对比弹窗回归测试**

Run: `npm test -- src/__tests__/DatabaseCompareResults.test.tsx src/__tests__/DatabaseCompareModal.test.tsx`

Expected: PASS；原数据库对比交互不回归，筛选不改变全局选择。

- [ ] **Step 5: 提交结果组件抽取**

```bash
git add src/components/databaseCompare/DatabaseCompareResults.tsx src/components/databaseCompare/DatabaseCompareModal.tsx src/components/databaseCompare/DatabaseCompareModal.css src/__tests__/DatabaseCompareResults.test.tsx src/__tests__/DatabaseCompareModal.test.tsx
git commit -m "refactor: 抽取数据库对比结果选择组件"
```

---

### Task 13: 同步预览、风险确认与执行结果组件

**Files:**
- Create: `src/components/databaseCompare/DatabaseSyncPreviewModal.tsx`
- Modify: `src/components/databaseCompare/DatabaseCompareModal.css`
- Create: `src/__tests__/DatabaseSyncPreviewModal.test.tsx`

**Interfaces:**

```ts
interface DatabaseSyncPreviewModalProps {
  open: boolean;
  source: CompareEndpointInfo;
  target: CompareEndpointInfo;
  preview: DatabaseSyncPreview | null;
  executionResult: DatabaseSyncExecutionResult | null;
  executing: boolean;
  onBack: () => void;
  onConfirm: () => void;
  onRecompare: () => void;
}
```

该组件只展示后端返回的 SQL，不接受 SQL 编辑，也不调用 Tauri 命令。

- [ ] **Step 1: 写预览组件失败测试**

```tsx
it("存在阻塞项时不可执行", () => {
  renderPreview({ preview: { ...safePreview, blockers: [blocker], can_execute: false } });
  expect(screen.getByText("无法自动同步")) .toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
});

it("普通计划也要求确认已检查 SQL", async () => {
  const onConfirm = vi.fn();
  renderPreview({ preview: safePreview, onConfirm });
  expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "我已检查以上 SQL，并理解已成功执行的 DDL 可能无法自动回滚",
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "确认执行" }));
  expect(onConfirm).toHaveBeenCalledOnce();
});

it("删除计划要求二次勾选确认并使用危险按钮", async () => {
  const onConfirm = vi.fn();
  renderPreview({ preview: destructivePreview, onConfirm });
  expect(screen.getByText("删除操作不可由本工具自动恢复")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认并执行删除同步" })).toBeDisabled();
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "我已检查以上 SQL，并理解已成功执行的 DDL 可能无法自动回滚",
    }),
  );
  await userEvent.click(
    screen.getByRole("button", { name: "确认并执行删除同步" }),
  );
  expect(onConfirm).toHaveBeenCalledOnce();
});

it("部分失败时同时展示成功、失败和未执行项", () => {
  renderPreview({ executionResult: partialFailure });
  expect(screen.getByText("已执行 2 条语句")) .toBeInTheDocument();
  expect(screen.getByText(/执行在第 3 条语句停止/)).toBeInTheDocument();
  expect(screen.getByText("未执行 2 个操作")) .toBeInTheDocument();
  expect(screen.getByRole("button", { name: "重新对比" })).toBeEnabled();
});
```

- [ ] **Step 2: 运行预览组件测试确认失败**

Run: `npm test -- src/__tests__/DatabaseSyncPreviewModal.test.tsx`

Expected: FAIL，提示预览组件不存在。

- [ ] **Step 3: 实现预览与结果展示**

实现要点：

- 顶部固定显示“源端 → 目标端”和目标数据库，避免方向误判。
- 每个操作显示表名、风险 Tag、说明和只读 SQL；SQL 使用 `<pre>` 并支持横向滚动。
- `blockers.length > 0` 展示错误 Alert，`skipped_items.length > 0` 展示跳过列表。
- 所有可执行计划都显示“我已检查以上 SQL，并理解已成功执行的 DDL 可能无法自动回滚”复选框；存在 `risk === "destructive"` 时追加删除不可恢复警告，并在 `open`、`preview.plan_fingerprint` 或执行结果变化时重置。
- `executing` 时禁止返回、关闭、重复执行；普通计划按钮文案“确认执行”，删除计划文案“确认并执行删除同步”。
- `partially_succeeded`/`failed` 展示已成功语句定位、失败操作/脱敏错误与未执行操作；`succeeded` 展示成功摘要和清理警告。

```tsx
const destructive =
  preview?.operations.some((operation) => operation.risk === "destructive") ?? false;
const confirmDisabled =
  executing ||
  !preview?.can_execute ||
  preview.operations.length === 0 ||
  !acknowledged;
```

- [ ] **Step 4: 运行预览组件测试**

Run: `npm test -- src/__tests__/DatabaseSyncPreviewModal.test.tsx`

Expected: PASS；所有计划都必须确认已检查 SQL，删除计划额外显示危险提示，阻塞计划不可执行。

- [ ] **Step 5: 提交预览组件**

```bash
git add src/components/databaseCompare/DatabaseSyncPreviewModal.tsx src/components/databaseCompare/DatabaseCompareModal.css src/__tests__/DatabaseSyncPreviewModal.test.tsx
git commit -m "feat: 增加数据库同步预览界面"
```

---

### Task 14: 集成数据库对比、预览与执行流程

**Files:**
- Modify: `src/components/databaseCompare/DatabaseCompareModal.tsx`
- Modify: `src/__tests__/DatabaseCompareModal.test.tsx`

**State:**

```ts
const [selectedTableNames, setSelectedTableNames] = useState<string[]>([]);
const [includeDrops, setIncludeDrops] = useState(false);
const [syncPreview, setSyncPreview] = useState<DatabaseSyncPreview | null>(null);
const [syncRequest, setSyncRequest] = useState<DatabaseSyncRequest | null>(null);
const [previewOpen, setPreviewOpen] = useState(false);
const [previewing, setPreviewing] = useState(false);
const [executing, setExecuting] = useState(false);
const [executionResult, setExecutionResult] =
  useState<DatabaseSyncExecutionResult | null>(null);
const previewRequestIdRef = useRef(0);
```

- [ ] **Step 1: 写完整交互编排失败测试**

```tsx
it("用当前对比端点、全量选择和删除开关请求预览", async () => {
  vi.mocked(previewDatabaseSync).mockResolvedValue(destructivePreview);
  renderModal();
  await finishCompare();
  await userEvent.click(screen.getByRole("switch", { name: "允许删除目标端结构" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "选择全部可同步表" }));
  await userEvent.click(screen.getByRole("button", { name: "预览同步" }));

  expect(previewDatabaseSync).toHaveBeenCalledWith({
    source: { saved_connection_id: "source-id", database: "source_db" },
    target: { saved_connection_id: "target-id", database: "target_db" },
    selected_tables: ["orders", "old_logs", "users"],
    include_drops: true,
  });
});

it("端点变化使尚未返回的预览失效", async () => {
  const deferred = createDeferred<DatabaseSyncPreview>();
  vi.mocked(previewDatabaseSync).mockReturnValue(deferred.promise);
  renderModal();
  await finishCompare();
  await userEvent.click(screen.getByRole("button", { name: "预览同步" }));
  await userEvent.selectOptions(screen.getByLabelText("源端数据库"), "other_db");
  deferred.resolve(safePreview);
  expect(screen.queryByText("同步 SQL 预览")).not.toBeInTheDocument();
});

it("执行成功后采用最新对比结果并清空同步计划", async () => {
  vi.mocked(executeDatabaseSync).mockResolvedValue(completedResult);
  renderModal();
  await openSafePreview();
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "我已检查以上 SQL，并理解已成功执行的 DDL 可能无法自动回滚",
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "确认执行" }));
  expect(executeDatabaseSync).toHaveBeenCalledWith({
    request: safeSyncRequest,
    plan_fingerprint: safePreview.plan_fingerprint,
  });
  expect(screen.getByText("数据库结构已同步")) .toBeInTheDocument();
  expect(screen.queryByText("同步 SQL 预览")).not.toBeInTheDocument();
});

it("结构漂移错误不执行旧计划并提示重新预览", async () => {
  vi.mocked(executeDatabaseSync).mockRejectedValue(
    new Error("数据库结构已变化，请重新预览同步计划"),
  );
  renderModal();
  await openSafePreview();
  await userEvent.click(
    screen.getByRole("checkbox", {
      name: "我已检查以上 SQL，并理解已成功执行的 DDL 可能无法自动回滚",
    }),
  );
  await userEvent.click(screen.getByRole("button", { name: "确认执行" }));
  expect(await screen.findByText("数据库结构已变化，请重新预览同步计划"))
    .toBeInTheDocument();
});
```

- [ ] **Step 2: 运行弹窗测试确认失败**

Run: `npm test -- src/__tests__/DatabaseCompareModal.test.tsx`

Expected: FAIL，现有弹窗没有同步状态和按钮。

- [ ] **Step 3: 实现预览请求和竞态失效**

```ts
const invalidateSyncState = () => {
  previewRequestIdRef.current += 1;
  setSelectedTableNames([]);
  setIncludeDrops(false);
  setSyncPreview(null);
  setSyncRequest(null);
  setExecutionResult(null);
  setPreviewOpen(false);
};

const handlePreviewSync = async () => {
  if (!result || selectedTableNames.length === 0) return;
  const requestId = ++previewRequestIdRef.current;
  const request: DatabaseSyncRequest = {
    source: {
      saved_connection_id: sourceConnectionId,
      database: sourceDatabase,
    },
    target: {
      saved_connection_id: targetConnectionId,
      database: targetDatabase,
    },
    selected_tables: [...selectedTableNames].sort(),
    include_drops: includeDrops,
  };
  setPreviewing(true);
  try {
    const preview = await previewDatabaseSync(request);
    if (previewRequestIdRef.current !== requestId) return;
    setSyncRequest(request);
    setSyncPreview(preview);
    setExecutionResult(null);
    setPreviewOpen(true);
  } finally {
    if (previewRequestIdRef.current === requestId) setPreviewing(false);
  }
};
```

源/目标连接或数据库改变、重新对比、弹窗关闭时都调用 `invalidateSyncState()`；比较中、预览中、执行中禁用冲突操作。预览按钮仅在有对比结果且至少选择一张有效表时启用。

- [ ] **Step 4: 实现执行和最新结果替换**

```ts
const handleExecuteSync = async () => {
  if (!syncPreview || !syncRequest) return;
  setExecuting(true);
  try {
    const execution = await executeDatabaseSync({
      request: syncRequest,
      plan_fingerprint: syncPreview.plan_fingerprint,
    });
    setExecutionResult(execution);
    if (execution.status === "succeeded") {
      if (execution.latest_compare_result) setResult(execution.latest_compare_result);
      setSelectedTableNames([]);
      setSyncRequest(null);
      setSyncPreview(null);
      setPreviewOpen(false);
      message.success("数据库结构已同步");
    }
  } catch (error) {
    message.error(normalizeTauriError(error));
  } finally {
    setExecuting(false);
  }
};
```

部分失败保持预览弹窗打开并把 `executionResult` 传给结果组件；“重新对比”关闭预览后调用现有 `handleCompare()`。在 `executing` 为真时 `Modal` 的关闭回调直接返回。

- [ ] **Step 5: 运行全部数据库对比/同步前端测试**

Run: `npm test -- src/__tests__/databaseSync.test.ts src/__tests__/DatabaseCompareResults.test.tsx src/__tests__/DatabaseSyncPreviewModal.test.tsx src/__tests__/DatabaseCompareModal.test.tsx`

Expected: PASS；预览参数、删除确认、漂移错误、部分失败、成功刷新和竞态失效均被覆盖。

- [ ] **Step 6: 提交前端集成**

```bash
git add src/components/databaseCompare/DatabaseCompareModal.tsx src/__tests__/DatabaseCompareModal.test.tsx
git commit -m "feat: 集成数据库结构同步交互"
```

---

### Task 15: 文档、手工验收矩阵与全量验证

**Files:**
- Modify: `README.md`
- Create: `docs/superpowers/manual-tests/2026-07-16-database-sync-matrix.md`

- [ ] **Step 1: 写手工验收矩阵**

矩阵必须记录环境、源端初始化 SQL、目标端初始化 SQL、选项、预期预览、执行结果和执行后重新对比结果，至少覆盖：

| 范围 | 用例 | 预期 |
|---|---|---|
| 五类数据库 | 源端独有表、末尾新增字段、普通字段变更 | 可预览并执行，重新对比无对应差异 |
| 五类数据库 | 删除关闭 | 不生成任何 DROP，目标端独有项显示跳过 |
| 五类数据库 | 删除开启 | 显示删除风险，二次确认后执行 |
| 五类数据库 | 预览后外部改结构 | 指纹不一致，执行零条 DDL |
| 五类数据库 | 中间语句制造失败 | 首错停止，返回成功、失败和未执行项 |
| SQLite | 需要重建表的已有字段变化 | 阻塞，不执行 |
| PostgreSQL | identity/generated/分区或顺序变化 | 阻塞，不执行 |
| SQL Server | identity/computed/顺序变化 | 阻塞，不执行 |
| ClickHouse | 引擎、排序键、分区键或主键表达式变化 | 阻塞，不执行 |
| 安全 | 不同数据库类型、同一保存连接、空选择、凭据错误 | 请求拒绝且错误中不泄漏凭据 |

- [ ] **Step 2: 更新 README**

在功能列表与数据库对比章节说明：表级选择/全部同步、五类数据库、首期只包含表与字段、删除默认关闭、始终先预览、漂移校验、首错停止和不承诺跨语句回滚。

- [ ] **Step 3: 运行格式和静态检查**

Run: `npm run format:check`

Expected: PASS。

Run: `npm run lint`

Expected: PASS。

Run: `npm run fmt:rust`

Expected: PASS，且不会修改文件；如修改，重新审阅并再次运行。

Run: `npm run lint:rust`

Expected: PASS，无 Clippy 警告。

- [ ] **Step 4: 运行全量测试和构建**

Run: `npm test`

Expected: PASS。

Run: `npm run test:rust`

Expected: PASS。

Run: `npm run build`

Expected: PASS，Vite/TypeScript 生产构建成功。

- [ ] **Step 5: 检查补丁完整性**

Run: `git diff --check`

Expected: 无输出，退出码 0。

Run: `git status --short`

Expected: 只包含本实施计划明确列出的功能、测试和文档文件；`task_plan.md`、`findings.md`、`progress.md` 作为本地工作记忆不提交。

实现执行到本步骤时，必须先使用 `superpowers:verification-before-completion` 技能核对所有最新命令输出，再宣称完成。

- [ ] **Step 6: 提交文档**

```bash
git add README.md docs/superpowers/manual-tests/2026-07-16-database-sync-matrix.md
git commit -m "docs: 补充数据库同步使用说明"
```

---

## Completion Criteria

- 五类数据库都通过真实方言的预览与执行路径，不用前端生成 SQL。
- 支持选择单表、多表和全部可同步表；筛选不丢失全局选择。
- 删除默认关闭，删除计划必须显式开启并二次确认。
- 任何阻塞项、空计划或指纹漂移都执行零条 DDL。
- 执行首错停止并返回可解释的部分结果，成功后重新对比。
- 元数据批量加载，不在表/字段循环中查询 SQL。
- 全量测试、构建、lint、格式检查与手工验收矩阵全部通过。
