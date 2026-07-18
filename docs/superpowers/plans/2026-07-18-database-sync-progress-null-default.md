# 数据库结构同步进度与 NULL 默认值展示实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为数据库结构同步提供覆盖校验、逐条 DDL 执行和刷新对比的实时进度，并把字段快照中的 NULL 默认值明确显示为 `NULL`。

**Architecture:** 后端继续使用现有无状态两阶段同步命令，通过带计划指纹的 Tauri 事件旁路上报进度；纯执行器用同步回调报告真实成功语句数。前端父弹窗负责监听、过滤和清理事件，预览弹窗只负责把进度模型渲染为阶段文案和进度条；默认值修复保留在现有纯格式化函数中。

**Tech Stack:** Rust、Tokio、Tauri 2 事件、React 18、TypeScript、Ant Design 5、Vitest、React Testing Library、Cargo test。

## Global Constraints

- 事件名固定为 `database-sync-progress`。
- 进度阶段固定为 `validating | executing | refreshing`。
- 事件只包含计划指纹、阶段和计数，不包含 SQL、连接配置或凭据。
- 事件监听或发送失败不得导致结构同步失败。
- 不支持取消、暂停、恢复或后端任务轮询。
- 不改变同步 SQL、操作排序、删除保护、指纹校验和首个失败停止语义。
- `default_value === null` 显示为字面量 `NULL`，不改变快照模型。
- 禁止在循环遍历中查询 SQL。
- 所有提交使用 Conventional Commits，英文 type 加简体中文描述。
- 默认在当前分支修改，不新建分支。

## File Structure

- `src/utils/databaseCompare.ts`：保留数据库对比字段值格式化职责，修正 NULL 默认值文本。
- `src/__tests__/databaseCompare.test.ts`：覆盖 NULL 和非空默认值的展示回归。
- `src-tauri/src/models/types.rs`：定义可序列化的同步进度阶段和事件负载。
- `src-tauri/src/commands/database_sync.rs`：发送阶段事件，并让纯逐语句执行器报告真实完成数。
- `src/types/index.ts`：定义前端同步进度契约。
- `src/utils/databaseSyncProgress.ts`：新增进度百分比和阶段文案纯函数。
- `src/__tests__/databaseSyncProgress.test.ts`：覆盖百分比边界和三阶段文案。
- `src/components/databaseCompare/DatabaseSyncPreviewModal.tsx`：渲染进度条和可访问状态文本。
- `src/components/databaseCompare/DatabaseCompareModal.css`：提供进度区布局和不确定进度动画。
- `src/__tests__/DatabaseSyncPreviewModal.test.tsx`：覆盖校验、执行、刷新和退化视图。
- `src/components/databaseCompare/DatabaseCompareModal.tsx`：注册、过滤和释放 Tauri 进度监听。
- `src/__tests__/DatabaseCompareModal.test.tsx`：覆盖监听时序、计划过滤和清理。

---

### Task 1: 修复 NULL 默认值展示

**Files:**
- Modify: `src/utils/databaseCompare.ts:50-60`
- Test: `src/__tests__/databaseCompare.test.ts:47-83`

**Interfaces:**
- Consumes: `ColumnSnapshot.default_value: string | null`。
- Produces: `formatColumnSideValues(column, side): string` 在默认值为 `null` 时输出 `默认值=NULL`。

- [ ] **Step 1: 写入失败回归测试**

把单侧字段断言改为明确要求 NULL，并补充非空默认表达式保持原样：

```ts
it("格式化单侧字段时输出七项完整属性并明确展示 NULL 默认值", () => {
  const column: ColumnDiff = {
    name: "email",
    status: "target_only",
    changed_fields: [],
    source: null,
    target: {
      ordinal_position: 2,
      column_type: "varchar(255)",
      nullable: true,
      default_value: null,
      primary_key: false,
      extra: "",
      comment: "",
    },
  };

  expect(formatColumnSideValues(column, "source")).toBe("");
  expect(formatColumnSideValues(column, "target")).toBe(
    "字段顺序=2；字段类型=varchar(255)；允许为空=是；默认值=NULL；主键=否；额外属性=；注释="
  );

  const expressionColumn: ColumnDiff = {
    ...column,
    target: {
      ...column.target!,
      default_value: "CURRENT_TIMESTAMP",
    },
  };
  expect(formatColumnSideValues(expressionColumn, "target")).toContain(
    "默认值=CURRENT_TIMESTAMP"
  );
});
```

- [ ] **Step 2: 运行测试并确认因旧空白展示失败**

Run: `npm test -- src/__tests__/databaseCompare.test.ts`

Expected: FAIL，实际字符串包含 `默认值=`，不包含 `默认值=NULL`。

- [ ] **Step 3: 写入最小格式化修复**

将 `formatSnapshotValue` 改为：

```ts
function formatSnapshotValue(
  snapshot: ColumnSnapshot,
  field: ColumnChangedField
): string {
  const value = snapshot[field];
  if (field === "default_value" && value === null) return "NULL";
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}
```

- [ ] **Step 4: 运行目标测试并确认通过**

Run: `npm test -- src/__tests__/databaseCompare.test.ts`

Expected: PASS，全部 `databaseCompare` 测试通过。

- [ ] **Step 5: 提交 NULL 展示修复**

```bash
git add src/utils/databaseCompare.ts src/__tests__/databaseCompare.test.ts
git commit -m "fix: 修复 NULL 默认值展示"
```

---

### Task 2: 后端上报真实结构同步进度

**Files:**
- Modify: `src-tauri/src/models/types.rs:90-155`
- Modify: `src-tauri/src/commands/database_sync.rs:1-170`
- Modify: `src-tauri/src/commands/database_sync.rs:499-625`
- Test: `src-tauri/src/commands/database_sync.rs:827-885`
- Test: `src-tauri/src/models/types.rs` 的现有 `tests` 模块

**Interfaces:**
- Consumes: 现有 `ExecuteDatabaseSyncRequest.plan_fingerprint` 和 `DatabaseSyncOperation.sql`。
- Produces: `DatabaseSyncProgressPhase::{Validating, Executing, Refreshing}`、`DatabaseSyncProgress { plan_fingerprint, phase, current, total }`、事件 `database-sync-progress`。
- Produces: `execute_operations_with_progress(operations, execute, on_progress)`；回调签名为 `FnMut(usize, usize)`，第一次回调是 `(0, total)`，之后只在 SQL 成功时回调。

- [ ] **Step 1: 写入负载序列化失败测试**

在 `src-tauri/src/models/types.rs` 的测试模块增加：

```rust
#[test]
fn database_sync_progress_serializes_with_snake_case_phase() {
    let progress = DatabaseSyncProgress {
        plan_fingerprint: "fingerprint".to_string(),
        phase: DatabaseSyncProgressPhase::Refreshing,
        current: 3,
        total: 3,
    };

    assert_eq!(
        serde_json::to_value(progress).unwrap(),
        serde_json::json!({
            "plan_fingerprint": "fingerprint",
            "phase": "refreshing",
            "current": 3,
            "total": 3
        })
    );
}
```

- [ ] **Step 2: 写入逐语句进度失败测试**

在 `src-tauri/src/commands/database_sync.rs` 的测试模块增加：

```rust
#[tokio::test]
async fn execution_progress_reports_initial_total_and_only_successful_statements() {
    let operations = vec![
        operation("op-0001", vec!["SQL 1"]),
        operation("op-0002", vec!["SQL 2", "SQL 3"]),
        operation("op-0003", vec!["SQL 4"]),
    ];
    let progress = Arc::new(Mutex::new(Vec::new()));
    let progress_for_callback = progress.clone();

    let result = execute_operations_with_progress(
        &operations,
        |sql| {
            let sql = sql.to_string();
            async move {
                if sql == "SQL 3" {
                    Err("模拟失败".to_string())
                } else {
                    Ok(())
                }
            }
        },
        move |current, total| {
            progress_for_callback.lock().unwrap().push((current, total));
        },
    )
    .await;

    assert_eq!(*progress.lock().unwrap(), vec![(0, 4), (1, 4), (2, 4)]);
    assert_eq!(
        result.status,
        DatabaseSyncExecutionStatus::PartiallySucceeded
    );
    assert_eq!(result.completed_statements.len(), 2);
}
```

- [ ] **Step 3: 运行 Rust 目标测试并确认缺少契约与执行器**

Run: `cargo test --manifest-path src-tauri/Cargo.toml database_sync_progress_serializes_with_snake_case_phase`

Expected: FAIL，找不到 `DatabaseSyncProgress` 与 `DatabaseSyncProgressPhase`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml execution_progress_reports_initial_total_and_only_successful_statements`

Expected: FAIL，找不到 `execute_operations_with_progress`。

- [ ] **Step 4: 定义 Rust 事件契约**

在同步模型旁增加：

```rust
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DatabaseSyncProgressPhase {
    Validating,
    Executing,
    Refreshing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseSyncProgress {
    pub plan_fingerprint: String,
    pub phase: DatabaseSyncProgressPhase,
    pub current: usize,
    pub total: usize,
}
```

- [ ] **Step 5: 抽取带回调的纯逐语句执行器**

用以下两个函数替换当前 `execute_operations_with` 实现，保留旧包装器避免无进度测试和调用方重复传空回调：

```rust
async fn execute_operations_with<F, Fut>(
    operations: &[DatabaseSyncOperation],
    execute: F,
) -> DatabaseSyncExecutionResult
where
    F: FnMut(&str) -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    execute_operations_with_progress(operations, execute, |_current, _total| {}).await
}

async fn execute_operations_with_progress<F, Fut, P>(
    operations: &[DatabaseSyncOperation],
    mut execute: F,
    mut on_progress: P,
) -> DatabaseSyncExecutionResult
where
    F: FnMut(&str) -> Fut,
    Fut: Future<Output = Result<(), String>>,
    P: FnMut(usize, usize),
{
    let total = operations
        .iter()
        .map(|operation| operation.sql.len())
        .sum();
    let mut completed = Vec::new();
    on_progress(0, total);

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
                    pending_operation_ids: operations[operation_index + 1..]
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
            on_progress(completed.len(), total);
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
```

- [ ] **Step 6: 接入 Tauri 阶段事件**

导入模型和 `Emitter`：

```rust
use crate::models::types::{
    CompareEndpointInfo, ConnectionConfig, DatabaseSyncExecutionResult,
    DatabaseSyncExecutionStatus, DatabaseSyncFailure, DatabaseSyncOperation,
    DatabaseSyncPreview, DatabaseSyncProgress, DatabaseSyncProgressPhase,
    DatabaseSyncRequest, DatabaseSyncRisk, DatabaseSyncStatementSuccess, DatabaseType,
    ExecuteDatabaseSyncRequest,
};
use tauri::{AppHandle, Emitter};
```

新增安全发送函数：

```rust
const DATABASE_SYNC_PROGRESS_EVENT: &str = "database-sync-progress";

fn emit_database_sync_progress(
    app: Option<&AppHandle>,
    plan_fingerprint: &str,
    phase: DatabaseSyncProgressPhase,
    current: usize,
    total: usize,
) {
    let Some(app) = app else {
        return;
    };
    let _ = app.emit(
        DATABASE_SYNC_PROGRESS_EVENT,
        DatabaseSyncProgress {
            plan_fingerprint: plan_fingerprint.to_string(),
            phase,
            current,
            total,
        },
    );
}
```

在公开命令开始时发送校验阶段，并把 `Some(app)` 传给内部执行函数：

```rust
#[tauri::command]
pub async fn execute_database_sync(
    app: AppHandle,
    input: ExecuteDatabaseSyncRequest,
) -> Result<DatabaseSyncExecutionResult, String> {
    emit_database_sync_progress(
        Some(&app),
        &input.plan_fingerprint,
        DatabaseSyncProgressPhase::Validating,
        0,
        0,
    );
    let saved =
        load_saved_connections_internal(&app).map_err(|error| redact_error_text(error, &[]))?;
    let result = execute_database_sync_with_saved(&saved, input, Some(app)).await;
    redact_execution_result(result, &saved)
}
```

把内部入口签名改为：

```rust
async fn execute_database_sync_with_saved(
    saved: &[ConnectionConfig],
    input: ExecuteDatabaseSyncRequest,
    progress_app: Option<AppHandle>,
) -> Result<DatabaseSyncExecutionResult, String>
```

把池上执行函数签名末尾增加：

```rust
progress_app: Option<AppHandle>,
```

`execute_database_sync_with_saved` 调用 `execute_database_sync_on_pools` 时把 `progress_app` 原样传入；内部测试调用 `execute_database_sync_with_saved` 时全部显式传 `None`。在 `execute_database_sync_on_pools` 通过保护校验后执行：

```rust
let target_pool_for_execute = target_pool.clone();
let progress_app_for_execute = progress_app.clone();
let progress_fingerprint = confirmed_fingerprint.to_string();
let mut result = execute_operations_with_progress(
    &preview.operations,
    move |sql| {
        let target_pool = target_pool_for_execute.clone();
        let sql = sql.to_string();
        async move { execute_sync_statement(target_pool, &sql).await }
    },
    move |current, total| {
        emit_database_sync_progress(
            progress_app_for_execute.as_ref(),
            &progress_fingerprint,
            DatabaseSyncProgressPhase::Executing,
            current,
            total,
        );
    },
)
.await;
```

仅在执行结果成功、重新读取两端结构之前发送刷新阶段：

```rust
emit_database_sync_progress(
    progress_app.as_ref(),
    confirmed_fingerprint,
    DatabaseSyncProgressPhase::Refreshing,
    result.completed_statements.len(),
    result.completed_statements.len(),
);
```

- [ ] **Step 7: 运行 Rust 目标测试和既有同步测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml database_sync_progress_serializes_with_snake_case_phase`

Expected: PASS。

Run: `cargo test --manifest-path src-tauri/Cargo.toml execution_progress_reports_initial_total_and_only_successful_statements`

Expected: PASS，进度严格为 `0/4`、`1/4`、`2/4`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::database_sync::tests`

Expected: PASS，既有同步失败、漂移、SQLite 集成和生命周期测试语义不变。

- [ ] **Step 8: 提交后端进度事件**

```bash
git add src-tauri/src/models/types.rs src-tauri/src/commands/database_sync.rs
git commit -m "feat: 上报结构同步执行进度"
```

---

### Task 3: 渲染同步阶段与进度条

**Files:**
- Modify: `src/types/index.ts:83-170`
- Create: `src/utils/databaseSyncProgress.ts`
- Create: `src/__tests__/databaseSyncProgress.test.ts`
- Modify: `src/components/databaseCompare/DatabaseSyncPreviewModal.tsx:10-42`
- Modify: `src/components/databaseCompare/DatabaseSyncPreviewModal.tsx:519-640`
- Modify: `src/components/databaseCompare/DatabaseCompareModal.css:106-122`
- Test: `src/__tests__/DatabaseSyncPreviewModal.test.tsx`

**Interfaces:**
- Consumes: 后端事件负载 `DatabaseSyncProgress`。
- Produces: `databaseSyncProgressPercent(progress): number | undefined` 和 `formatDatabaseSyncProgress(progress): string`。
- Produces: `DatabaseSyncPreviewModalProps.progress: DatabaseSyncProgress | null`。

- [ ] **Step 1: 写入进度纯函数失败测试**

创建 `src/__tests__/databaseSyncProgress.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { DatabaseSyncProgress } from "../types";
import {
  databaseSyncProgressPercent,
  formatDatabaseSyncProgress,
} from "../utils/databaseSyncProgress";

function progress(
  phase: DatabaseSyncProgress["phase"],
  current: number,
  total: number
): DatabaseSyncProgress {
  return {
    plan_fingerprint: "fingerprint",
    phase,
    current,
    total,
  };
}

describe("databaseSyncProgress", () => {
  it("校验和无事件状态使用不确定进度文案", () => {
    expect(databaseSyncProgressPercent(null)).toBeUndefined();
    expect(formatDatabaseSyncProgress(null)).toBe(
      "正在执行数据库结构同步"
    );
    expect(
      formatDatabaseSyncProgress(progress("validating", 0, 0))
    ).toBe("正在校验源端与目标端结构");
  });

  it("执行阶段按真实语句数计算并限制百分比", () => {
    expect(databaseSyncProgressPercent(progress("executing", 1, 4))).toBe(25);
    expect(databaseSyncProgressPercent(progress("executing", 5, 4))).toBe(100);
    expect(databaseSyncProgressPercent(progress("executing", 0, 0))).toBeUndefined();
    expect(formatDatabaseSyncProgress(progress("executing", 2, 4))).toBe(
      "正在执行 DDL，已完成 2 / 4 条语句"
    );
  });

  it("刷新阶段显示 DDL 已完成", () => {
    expect(databaseSyncProgressPercent(progress("refreshing", 4, 4))).toBe(100);
    expect(formatDatabaseSyncProgress(progress("refreshing", 4, 4))).toBe(
      "DDL 已执行完成，正在刷新结构对比"
    );
  });
});
```

- [ ] **Step 2: 运行纯函数测试并确认模块缺失**

Run: `npm test -- src/__tests__/databaseSyncProgress.test.ts`

Expected: FAIL，找不到 `DatabaseSyncProgress` 或 `databaseSyncProgress` 模块。

- [ ] **Step 3: 定义前端契约与纯函数**

在 `src/types/index.ts` 增加：

```ts
export type DatabaseSyncProgressPhase =
  | "validating"
  | "executing"
  | "refreshing";

export interface DatabaseSyncProgress {
  plan_fingerprint: string;
  phase: DatabaseSyncProgressPhase;
  current: number;
  total: number;
}
```

创建 `src/utils/databaseSyncProgress.ts`：

```ts
import type { DatabaseSyncProgress } from "../types";

export function databaseSyncProgressPercent(
  progress: DatabaseSyncProgress | null
): number | undefined {
  if (!progress) return undefined;
  if (progress.phase === "refreshing") return 100;
  if (progress.phase !== "executing" || progress.total <= 0) return undefined;
  return Math.min(
    100,
    Math.max(0, Math.round((progress.current / progress.total) * 100))
  );
}

export function formatDatabaseSyncProgress(
  progress: DatabaseSyncProgress | null
): string {
  if (!progress) return "正在执行数据库结构同步";
  if (progress.phase === "validating") {
    return "正在校验源端与目标端结构";
  }
  if (progress.phase === "refreshing") {
    return "DDL 已执行完成，正在刷新结构对比";
  }
  return `正在执行 DDL，已完成 ${progress.current} / ${progress.total} 条语句`;
}
```

- [ ] **Step 4: 运行纯函数测试并确认通过**

Run: `npm test -- src/__tests__/databaseSyncProgress.test.ts`

Expected: PASS，3 个测试全部通过。

- [ ] **Step 5: 写入预览弹窗失败测试**

给 `baseProps` 增加 `progress: null`，并在 `DatabaseSyncPreviewModal.test.tsx` 增加：

```tsx
it("执行中展示校验、真实语句进度和刷新阶段", () => {
  const { rerender } = renderPreview({
    executing: true,
    progress: {
      plan_fingerprint: safePreview.plan_fingerprint,
      phase: "validating",
      current: 0,
      total: 0,
    },
  });
  expect(screen.getByText("正在校验源端与目标端结构")).toBeInTheDocument();
  expect(screen.getByRole("progressbar", { name: "数据库结构同步进度" })).toBeInTheDocument();

  rerender(
    <DatabaseSyncPreviewModal
      {...baseProps}
      executing
      progress={{
        plan_fingerprint: safePreview.plan_fingerprint,
        phase: "executing",
        current: 1,
        total: 4,
      }}
    />
  );
  expect(
    screen.getByText("正在执行 DDL，已完成 1 / 4 条语句")
  ).toBeInTheDocument();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");

  rerender(
    <DatabaseSyncPreviewModal
      {...baseProps}
      executing
      progress={{
        plan_fingerprint: safePreview.plan_fingerprint,
        phase: "refreshing",
        current: 4,
        total: 4,
      }}
    />
  );
  expect(
    screen.getByText("DDL 已执行完成，正在刷新结构对比")
  ).toBeInTheDocument();
  expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
});
```

并在既有“执行中禁用返回”测试增加退化断言：

```ts
expect(screen.getByText("正在执行数据库结构同步")).toBeInTheDocument();
```

- [ ] **Step 6: 运行弹窗测试并确认缺少 progress 属性与进度条**

Run: `npm test -- src/__tests__/DatabaseSyncPreviewModal.test.tsx`

Expected: FAIL，页面不存在“数据库结构同步进度”进度条。

- [ ] **Step 7: 实现进度条组件状态**

从 Ant Design 导入 `Progress`，从类型导入 `DatabaseSyncProgress`，给 props 增加：

```ts
progress: DatabaseSyncProgress | null;
```

在组件中计算：

```ts
const progressPercent = databaseSyncProgressPercent(progress);
const progressMessage = formatDatabaseSyncProgress(progress);
```

在方向标题和执行内容之间增加；该可见区域取代执行阶段原有的隐藏状态播报，避免屏幕阅读器收到重复消息：

```tsx
{executing && (
  <section
    className={`database-sync-progress ${
      progressPercent === undefined
        ? "database-sync-progress--indeterminate"
        : ""
    }`}
    aria-label="同步执行进度"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    <Progress
      aria-label="数据库结构同步进度"
      percent={progressPercent ?? 0}
      showInfo={progressPercent !== undefined}
      status="active"
    />
    <span>{progressMessage}</span>
  </section>
)}
```

把现有隐藏状态区域限制为非执行阶段的结果播报：

```tsx
{!executing && (
  <div
    className="database-sync-live-status"
    role="status"
    aria-live="polite"
    aria-atomic="true"
  >
    {executionResult ? executionStatusMessage(executionResult) : ""}
  </div>
)}
```

- [ ] **Step 8: 增加进度布局与不确定动画**

在 `DatabaseCompareModal.css` 增加：

```css
.database-sync-progress {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-secondary);
}

.database-sync-progress > span {
  color: var(--text-secondary);
  font-size: 12px;
}

.database-sync-progress--indeterminate .ant-progress-bg {
  width: 35% !important;
  animation: database-sync-progress-indeterminate 1.4s ease-in-out infinite;
}

@keyframes database-sync-progress-indeterminate {
  from {
    transform: translateX(-120%);
  }

  to {
    transform: translateX(290%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .database-sync-progress--indeterminate .ant-progress-bg {
    width: 100% !important;
    animation: none;
    opacity: 0.45;
  }
}
```

- [ ] **Step 9: 运行进度纯函数和弹窗测试**

Run: `npm test -- src/__tests__/databaseSyncProgress.test.ts src/__tests__/DatabaseSyncPreviewModal.test.tsx`

Expected: PASS，阶段文案、25% 确定进度、100% 刷新状态和无事件退化均通过。

- [ ] **Step 10: 提交进度展示组件**

```bash
git add src/types/index.ts src/utils/databaseSyncProgress.ts src/__tests__/databaseSyncProgress.test.ts src/components/databaseCompare/DatabaseSyncPreviewModal.tsx src/components/databaseCompare/DatabaseCompareModal.css src/__tests__/DatabaseSyncPreviewModal.test.tsx
git commit -m "feat: 展示结构同步阶段进度"
```

---

### Task 4: 监听、过滤并清理同步进度事件

**Files:**
- Modify: `src/components/databaseCompare/DatabaseCompareModal.tsx:1-120`
- Modify: `src/components/databaseCompare/DatabaseCompareModal.tsx:457-525`
- Modify: `src/components/databaseCompare/DatabaseCompareModal.tsx:801-814`
- Test: `src/__tests__/DatabaseCompareModal.test.tsx`

**Interfaces:**
- Consumes: `listen<DatabaseSyncProgress>("database-sync-progress", handler)`。
- Consumes: `DatabaseSyncPreviewModalProps.progress`。
- Produces: 只接受当前 `requestId`、当前计划 identity 和相同 `plan_fingerprint` 的事件；所有结束路径调用 `UnlistenFn`。

- [ ] **Step 1: 写入监听过滤和清理失败测试**

在测试文件顶部增加可提升 mock：

```ts
const eventMocks = vi.hoisted(() => ({
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: eventMocks.listen,
}));
```

把 `DatabaseSyncProgress` 加入类型导入，并在 `beforeEach` 中设置默认监听结果：

```ts
eventMocks.listen.mockResolvedValue(vi.fn());
```

增加完整行为测试：

```tsx
it("执行前监听进度，过滤其他计划事件并在完成后清理", async () => {
  const execution = deferred<DatabaseSyncExecutionResult>();
  const unlisten = vi.fn();
  let progressHandler:
    | ((event: { payload: DatabaseSyncProgress }) => void)
    | undefined;
  eventMocks.listen.mockImplementation(async (_eventName, handler) => {
    progressHandler = handler;
    return unlisten;
  });
  vi.mocked(api.executeDatabaseSync).mockReturnValue(execution.promise);

  render(<DatabaseCompareModal open onClose={vi.fn()} />);
  await openSafePreview();
  acknowledgeSyncPlan();
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

  await waitFor(() => {
    expect(eventMocks.listen).toHaveBeenCalledWith(
      "database-sync-progress",
      expect.any(Function)
    );
  });
  await waitFor(() => expect(api.executeDatabaseSync).toHaveBeenCalledOnce());

  act(() => {
    progressHandler?.({
      payload: {
        plan_fingerprint: "other-plan",
        phase: "executing",
        current: 3,
        total: 4,
      },
    });
  });
  expect(
    screen.queryByText("正在执行 DDL，已完成 3 / 4 条语句")
  ).not.toBeInTheDocument();

  act(() => {
    progressHandler?.({
      payload: {
        plan_fingerprint: "preview-fingerprint",
        phase: "executing",
        current: 1,
        total: 4,
      },
    });
  });
  expect(
    screen.getByText("正在执行 DDL，已完成 1 / 4 条语句")
  ).toBeInTheDocument();

  await act(async () => {
    execution.resolve(sampleSucceededExecution());
    await execution.promise;
  });
  expect(unlisten).toHaveBeenCalledOnce();
  expect(await screen.findByText("同步执行结果")).toBeInTheDocument();
});
```

- [ ] **Step 2: 写入监听失败退化测试**

```tsx
it("进度监听注册失败时仍执行同步并展示退化状态", async () => {
  const execution = deferred<DatabaseSyncExecutionResult>();
  eventMocks.listen.mockRejectedValue(new Error("监听不可用"));
  vi.mocked(api.executeDatabaseSync).mockReturnValue(execution.promise);

  render(<DatabaseCompareModal open onClose={vi.fn()} />);
  await openSafePreview();
  acknowledgeSyncPlan();
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

  await waitFor(() => expect(api.executeDatabaseSync).toHaveBeenCalledOnce());
  expect(screen.getByText("正在执行数据库结构同步")).toBeInTheDocument();

  await act(async () => {
    execution.resolve(sampleSucceededExecution());
    await execution.promise;
  });
  expect(await screen.findByText("同步执行结果")).toBeInTheDocument();
});
```

- [ ] **Step 3: 运行父弹窗测试并确认尚未监听事件**

Run: `npm test -- src/__tests__/DatabaseCompareModal.test.tsx`

Expected: FAIL，`eventMocks.listen` 未被调用，实时进度文本不存在。

- [ ] **Step 4: 增加进度状态与监听清理函数**

导入事件 API 和类型：

```ts
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  DatabaseCompareResult,
  DatabaseSyncExecutionResult,
  DatabaseSyncPreview,
  DatabaseSyncProgress,
  DatabaseSyncRequest,
} from "../../types";
```

增加状态和 ref：

```ts
const [syncProgress, setSyncProgress] =
  useState<DatabaseSyncProgress | null>(null);
const syncProgressUnlistenRef = useRef<UnlistenFn | null>(null);
```

在 `clearSyncPreview` 之前增加：

```ts
const stopSyncProgressListener = useCallback(() => {
  const unlisten = syncProgressUnlistenRef.current;
  syncProgressUnlistenRef.current = null;
  unlisten?.();
}, []);

const clearSyncProgress = useCallback(() => {
  stopSyncProgressListener();
  setSyncProgress(null);
}, [stopSyncProgressListener]);

useEffect(
  () => () => {
    stopSyncProgressListener();
  },
  [stopSyncProgressListener]
);
```

让 `clearSyncPreview` 调用 `clearSyncProgress()`，并把它加入依赖数组。

- [ ] **Step 5: 在 invoke 前注册带计划过滤的监听**

在 `handleExecuteSync` 设置执行锁后先清理旧监听，再注册新监听：

```ts
clearSyncProgress();
try {
  try {
    const unlisten = await listen<DatabaseSyncProgress>(
      "database-sync-progress",
      (event) => {
        if (
          executionRequestId.current === requestId &&
          activeSyncPlanIdentity.current === identity &&
          event.payload.plan_fingerprint === planFingerprint
        ) {
          setSyncProgress(event.payload);
        }
      }
    );
    if (
      executionRequestId.current !== requestId ||
      activeSyncPlanIdentity.current !== identity
    ) {
      unlisten();
      return;
    }
    syncProgressUnlistenRef.current = unlisten;
  } catch {
    setSyncProgress(null);
  }

  const execution = await api.executeDatabaseSync({
    request: syncRequest,
    plan_fingerprint: planFingerprint,
  });
```

在现有 `finally` 第一行增加：

```ts
clearSyncProgress();
```

并把 `clearSyncProgress` 加入 `handleExecuteSync` 依赖数组。

- [ ] **Step 6: 把进度传给预览弹窗**

在 `DatabaseSyncPreviewModal` 调用中增加：

```tsx
progress={syncProgress}
```

- [ ] **Step 7: 运行父弹窗和预览弹窗测试**

Run: `npm test -- src/__tests__/DatabaseCompareModal.test.tsx src/__tests__/DatabaseSyncPreviewModal.test.tsx`

Expected: PASS；监听先于 invoke 注册，错误计划被忽略，正确计划更新 UI，完成后调用一次 unlisten，监听失败仍完成同步。

- [ ] **Step 8: 提交事件监听生命周期**

```bash
git add src/components/databaseCompare/DatabaseCompareModal.tsx src/__tests__/DatabaseCompareModal.test.tsx
git commit -m "feat: 接入结构同步实时进度"
```

---

### Task 5: 全量回归与静态检查

**Files:**
- Verify only; no production files should change unless a verification failure identifies a regression in files already listed above.

**Interfaces:**
- Consumes: Tasks 1-4 的全部提交。
- Produces: 可交付的前端与 Rust 验证证据。

- [ ] **Step 1: 运行全部前端测试**

Run: `npm test`

Expected: PASS，无失败测试和未处理异步警告。

- [ ] **Step 2: 运行前端构建**

Run: `npm run build`

Expected: PASS，TypeScript 和 Vite 构建完成。

- [ ] **Step 3: 运行前端 lint 与格式检查**

Run: `npm run lint`

Expected: PASS，无 ESLint error 或 warning。

Run: `npm run format:check`

Expected: PASS，Prettier 报告全部目标文件格式正确。

- [ ] **Step 4: 运行全部 Rust 测试**

Run: `npm run test:rust`

Expected: PASS，全部 Rust 单元与集成测试通过。

- [ ] **Step 5: 运行 Rust 格式与 Clippy**

Run: `npm run fmt:rust`

Expected: PASS，`cargo fmt --check` 无差异。

Run: `npm run lint:rust`

Expected: PASS，Clippy 在 `-D warnings` 下无错误。

- [ ] **Step 6: 检查最终差异和工作区边界**

Run: `git status --short && git diff --check HEAD~4..HEAD`

Expected: 仅保留用户原有未跟踪文件；Tasks 1-4 的提交没有空白错误，也没有把 `.planning/`、`findings.md`、`progress.md` 或 `task_plan.md` 纳入提交。
