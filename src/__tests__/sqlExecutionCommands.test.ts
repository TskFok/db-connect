import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import * as api from "../services/tauriCommands";

describe("tauriCommands SQL 执行与取消", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("executeSql 不传 executionId 时 executionId 为 undefined", async () => {
    vi.mocked(invoke).mockResolvedValue({} as never);
    await api.executeSql("cid", "db", "SELECT 1");
    expect(invoke).toHaveBeenCalledWith("execute_sql", {
      connId: "cid",
      database: "db",
      sql: "SELECT 1",
      executionId: undefined,
    });
  });

  it("executeSql 透传 executionId", async () => {
    vi.mocked(invoke).mockResolvedValue({} as never);
    await api.executeSql("cid", null, "SELECT 2", "exec-123");
    expect(invoke).toHaveBeenCalledWith("execute_sql", {
      connId: "cid",
      database: null,
      sql: "SELECT 2",
      executionId: "exec-123",
    });
  });

  it("cancelQuery 调用 cancel_query 命令", async () => {
    vi.mocked(invoke).mockResolvedValue(true as never);
    const r = await api.cancelQuery("cid", "exec-123");
    expect(invoke).toHaveBeenCalledWith("cancel_query", {
      connId: "cid",
      executionId: "exec-123",
    });
    expect(r).toBe(true);
  });

  it("getSqlCompletionMetadata 调用批量补全元数据命令", async () => {
    vi.mocked(invoke).mockResolvedValue({
      databases: ["public"],
      tables: [{ name: "users" }],
      columns: [{ table: "users", name: "id", type: "integer" }],
    } as never);
    const r = await api.getSqlCompletionMetadata("cid", "public");
    expect(invoke).toHaveBeenCalledWith("get_sql_completion_metadata", {
      connId: "cid",
      database: "public",
    });
    expect(r.columns[0].name).toBe("id");
  });

  it("batchUpdateRows 调用 batch_update_rows 命令并透传行集", async () => {
    vi.mocked(invoke).mockResolvedValue(2 as never);
    const rows = [
      { primaryKeys: { id: 1 }, updates: { name: "a" } },
      { primaryKeys: { id: 2 }, updates: { name: "b" } },
    ];
    const r = await api.batchUpdateRows("cid", "db", "t", rows);
    expect(invoke).toHaveBeenCalledWith("batch_update_rows", {
      connId: "cid",
      database: "db",
      table: "t",
      rows: [
        { primary_keys: { id: 1 }, updates: { name: "a" } },
        { primary_keys: { id: 2 }, updates: { name: "b" } },
      ],
    });
    expect(r).toBe(2);
  });

  it("deleteRows 调用 delete_rows 命令并透传完整主键行集", async () => {
    vi.mocked(invoke).mockResolvedValue(2 as never);
    const r = await api.deleteRows("cid", "db", "order_items", [
      { order_id: 1, product_id: 10 },
      { order_id: 1, product_id: 11 },
    ]);
    expect(invoke).toHaveBeenCalledWith("delete_rows", {
      connId: "cid",
      database: "db",
      table: "order_items",
      primaryKeys: [
        { order_id: 1, product_id: 10 },
        { order_id: 1, product_id: 11 },
      ],
    });
    expect(r).toBe(2);
  });
});
