import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DatabaseSyncExecutionResult,
  DatabaseSyncExecutionStatus,
  DatabaseSyncOperationKind,
  DatabaseSyncPreview,
  DatabaseSyncRequest,
  DatabaseSyncRisk,
  ExecuteDatabaseSyncRequest,
  TableDiff,
} from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  executeDatabaseSync,
  previewDatabaseSync,
} from "../services/tauriCommands";
import {
  eligibleSyncTableNames,
  formatSyncRisk,
  normalizeSyncSelection,
  selectAllSyncTables,
  toggleSyncTable,
} from "../utils/databaseSync";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <
    Value,
  >() => Value extends Right ? 1 : 2
    ? true
    : false;

const syncRequestKeysAreExact: Equal<
  keyof DatabaseSyncRequest,
  "source" | "target" | "selected_tables" | "include_drops"
> = true;
const executeRequestKeysAreExact: Equal<
  keyof ExecuteDatabaseSyncRequest,
  "request" | "plan_fingerprint"
> = true;
const operationKindContractIsExact: Equal<
  DatabaseSyncOperationKind,
  | "create_table"
  | "add_column"
  | "alter_column"
  | "replace_primary_key"
  | "drop_column"
  | "drop_table"
  | "update_comment"
> = true;
const executionStatusContractIsExact: Equal<
  DatabaseSyncExecutionStatus,
  "succeeded" | "partially_succeeded" | "failed"
> = true;

const tables = [
  { name: "old_table", status: "target_only", columns: [] },
  { name: "new_table", status: "source_only", columns: [] },
  { name: "changed", status: "changed", columns: [] },
] as TableDiff[];

const request = {
  source: { saved_connection_id: "source-id", database: "source_db" },
  target: { saved_connection_id: "target-id", database: "target_db" },
  selected_tables: ["changed"],
  include_drops: false,
} satisfies DatabaseSyncRequest;

const previewFixture = {
  plan_fingerprint: "a".repeat(64),
  summary: {
    selected_tables: 1,
    executable_operations: 1,
    high_risk_operations: 0,
    destructive_operations: 0,
    skipped_items: 1,
    blockers: 1,
  },
  operations: [
    {
      id: "changed:add_column:0",
      table_name: "changed",
      kind: "add_column",
      summary: "新增字段",
      risk: "normal",
      sql: ["ALTER TABLE changed ADD COLUMN name text"],
    },
  ],
  skipped_items: [
    {
      table_name: "legacy_logs",
      summary: "跳过删除表",
      reason: "删除操作未开启",
    },
  ],
  blockers: [
    {
      table_name: "changed",
      summary: "无法修改生成字段",
      reason: "目标数据库不支持安全修改",
    },
  ],
  can_execute: false,
} satisfies DatabaseSyncPreview;

const executionFixture = {
  status: "partially_succeeded",
  completed_statements: [
    { operation_id: "changed:add_column:0", statement_index: 0 },
  ],
  failed: {
    operation_id: "changed:alter_column:1",
    statement_index: 1,
    error: "执行失败",
  },
  pending_operation_ids: ["changed:alter_column:1"],
  cleanup_errors: [],
  latest_compare_result: {
    database_type: "mysql",
    source: {
      connection_id: "source-id",
      connection_name: "源连接",
      database: "source_db",
    },
    target: {
      connection_id: "target-id",
      connection_name: "目标连接",
      database: "target_db",
    },
    compared_at: "2026-07-17T10:00:00Z",
    summary: {
      source_only_tables: 0,
      target_only_tables: 0,
      changed_tables: 1,
      different_columns: 1,
    },
    tables,
  },
} satisfies DatabaseSyncExecutionResult;

describe("databaseSync selection", () => {
  it("删除关闭时排除目标端独有表", () => {
    expect(eligibleSyncTableNames(tables, false)).toEqual([
      "changed",
      "new_table",
    ]);
  });

  it("删除开启时目标端独有表可选", () => {
    expect(selectAllSyncTables(tables, true)).toEqual([
      "changed",
      "new_table",
      "old_table",
    ]);
  });

  it("开关删除后清理失效选择，并保持未显示筛选项", () => {
    const selected = ["old_table", "changed", "changed"];
    expect(normalizeSyncSelection(selected, tables, false)).toEqual([
      "changed",
    ]);
    expect(toggleSyncTable(selected, "new_table", true)).toEqual([
      "changed",
      "new_table",
      "old_table",
    ]);
  });

  it("取消单表选择时移除目标表并规范化其余选择", () => {
    expect(
      toggleSyncTable(["old_table", "changed", "old_table"], "old_table", false)
    ).toEqual(["changed"]);
  });
});

describe("databaseSync contract", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("同步枚举和展示文案与 Rust snake_case 契约一致", () => {
    const risks: DatabaseSyncRisk[] = ["normal", "high", "destructive"];
    const operationKinds: DatabaseSyncOperationKind[] = [
      "create_table",
      "add_column",
      "alter_column",
      "replace_primary_key",
      "drop_column",
      "drop_table",
      "update_comment",
    ];
    const statuses: DatabaseSyncExecutionStatus[] = [
      "succeeded",
      "partially_succeeded",
      "failed",
    ];

    expect(risks.map(formatSyncRisk)).toEqual(["普通", "高风险", "删除"]);
    expect(operationKinds).toHaveLength(7);
    expect(statuses).toHaveLength(3);
    expect(previewFixture.operations[0].table_name).toBe("changed");
    expect(previewFixture.skipped_items[0].reason).toBe("删除操作未开启");
    expect(previewFixture.blockers[0].table_name).toBe("changed");
    expect(executionFixture.completed_statements[0].statement_index).toBe(0);
    expect(executionFixture.failed?.error).toBe("执行失败");
    expect(executionFixture.latest_compare_result?.database_type).toBe("mysql");
    expect(syncRequestKeysAreExact).toBe(true);
    expect(executeRequestKeysAreExact).toBe(true);
    expect(operationKindContractIsExact).toBe(true);
    expect(executionStatusContractIsExact).toBe(true);
  });

  it("预览调用 preview_database_sync 并使用 request 外层参数", async () => {
    vi.mocked(invoke).mockResolvedValue(previewFixture);

    await expect(previewDatabaseSync(request)).resolves.toBe(previewFixture);
    expect(invoke).toHaveBeenCalledWith("preview_database_sync", { request });
  });

  it("执行调用 execute_database_sync，仅传同一请求和指纹", async () => {
    const input = {
      request,
      plan_fingerprint: previewFixture.plan_fingerprint,
    } satisfies ExecuteDatabaseSyncRequest;
    vi.mocked(invoke).mockResolvedValue(executionFixture);

    await expect(executeDatabaseSync(input)).resolves.toBe(executionFixture);
    expect(invoke).toHaveBeenCalledWith("execute_database_sync", { input });
    expect(Object.keys(input).sort()).toEqual(["plan_fingerprint", "request"]);
    expect(JSON.stringify(input)).not.toContain('"sql"');
  });
});
