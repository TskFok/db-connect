import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDatabaseStore } from "../stores/databaseStore";
import type { ColumnInfo, TableInfo } from "../types";
import * as api from "../services/tauriCommands";

vi.mock("../services/tauriCommands", () => ({
  listTables: vi.fn(),
  getTableStructure: vi.fn(),
}));

const columns: ColumnInfo[] = [
  {
    name: "id",
    column_type: "integer",
    nullable: false,
    key: "PRI",
    default_value: null,
    extra: "",
    comment: "",
  },
];
const view: TableInfo = {
  name: "summary",
  table_type: "VIEW",
  engine: null,
  rows: null,
  data_length: null,
  index_length: null,
  comment: "统计视图",
};
const users: TableInfo = { ...view, name: "users", table_type: "TABLE" };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("批量表标签按需加载", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    useDatabaseStore.getState().reset();
    useDatabaseStore.getState().switchToConnection("pg-1");
    vi.mocked(api.listTables).mockResolvedValue([users, view]);
    vi.mocked(api.getTableStructure).mockResolvedValue(columns);
  });

  it("批量建立去重标签并保留 SQL 草稿，不执行查询，激活最后一项且暂不展开未加载 schema", () => {
    const store = useDatabaseStore.getState();
    store.openSqlTab("pg-1", "SELECT 42");
    const sqlTab = useDatabaseStore.getState().openTabs[0];
    store.openTableTabs("pg-1", [{ database: "public", table: "users" }]);
    store.openTableTabs("pg-1", [
      { database: "public", table: "users" },
      { database: "reports", table: "summary" },
      { database: "public", table: "users" },
    ]);

    const state = useDatabaseStore.getState();
    expect(state.openTabs).toEqual([
      sqlTab,
      { type: "table", database: "public", table: "users" },
      { type: "table", database: "reports", table: "summary" },
    ]);
    expect(Object.values(state.sqlTabContents)).toEqual(["SELECT 42"]);
    expect(state.activeTabIndex).toBe(1);
    expect(state.selectedDatabase).toBe("public");
    expect(state.selectedTable).toBe("users");
    expect(state.selectedTableInfo).toBeNull();
    expect(state.tableStructure).toBeNull();
    expect(state.expandedKeys).toEqual([]);
    expect(api.listTables).not.toHaveBeenCalled();
    expect(api.getTableStructure).not.toHaveBeenCalled();
  });

  it("只加载当前激活表并识别 VIEW，重复激活复用缓存", async () => {
    const store = useDatabaseStore.getState();
    store.openTableTabs("pg-1", [
      { database: "public", table: "users" },
      { database: "reports", table: "summary" },
    ]);
    await store.ensureTableMetadata("pg-1", "public", "users");
    expect(api.listTables).not.toHaveBeenCalled();
    await store.ensureTableMetadata("pg-1", "reports", "summary");

    const state = useDatabaseStore.getState();
    expect(state.selectedTableInfo).toEqual(view);
    expect(state.tableStructure).toEqual(columns);
    expect(state.expandedKeys).toEqual(["db:reports"]);
    expect(api.listTables).toHaveBeenCalledWith("pg-1", "reports");
    expect(api.getTableStructure).toHaveBeenCalledWith(
      "pg-1",
      "reports",
      "summary"
    );
    store.switchTab("pg-1", 0);
    store.switchTab("pg-1", 1);
    await store.ensureTableMetadata("pg-1", "reports", "summary");
    expect(api.listTables).toHaveBeenCalledTimes(1);
    expect(api.getTableStructure).toHaveBeenCalledTimes(1);
  });

  it("同一激活标签的并发加载只发起一组查询", async () => {
    const pending = deferred<TableInfo[]>();
    vi.mocked(api.listTables).mockReturnValue(pending.promise);
    const store = useDatabaseStore.getState();
    store.openTableTabs("pg-1", [{ database: "reports", table: "summary" }]);
    const first = store.ensureTableMetadata("pg-1", "reports", "summary");
    const second = store.ensureTableMetadata("pg-1", "reports", "summary");
    pending.resolve([view]);
    await Promise.all([first, second]);
    expect(useDatabaseStore.getState().selectedTableInfo?.table_type).toBe(
      "VIEW"
    );
    expect(api.listTables).toHaveBeenCalledTimes(1);
    expect(api.getTableStructure).toHaveBeenCalledTimes(1);
  });

  it("加载表列表期间切换连接不会继续查询结构或污染新连接", async () => {
    const pending = deferred<TableInfo[]>();
    vi.mocked(api.listTables).mockReturnValue(pending.promise);
    const store = useDatabaseStore.getState();
    store.openTableTabs("pg-1", [{ database: "reports", table: "summary" }]);
    const loading = store.ensureTableMetadata("pg-1", "reports", "summary");
    store.switchToConnection("pg-2");
    store.openTableTabs("pg-2", [{ database: "public", table: "users" }]);
    pending.resolve([view]);
    await loading;
    expect(api.getTableStructure).not.toHaveBeenCalled();
    expect(useDatabaseStore.getState().activeConnId).toBe("pg-2");
    expect(useDatabaseStore.getState().selectedTable).toBe("users");
    expect(useDatabaseStore.getState().selectedTableInfo).toBeNull();
  });

  it("结构请求返回时只缓存原表，不覆盖后来激活的表", async () => {
    const pending = deferred<ColumnInfo[]>();
    vi.mocked(api.getTableStructure).mockReturnValue(pending.promise);
    const store = useDatabaseStore.getState();
    store.openTableTabs("pg-1", [
      { database: "public", table: "users" },
      { database: "reports", table: "summary" },
    ]);
    const loading = store.ensureTableMetadata("pg-1", "reports", "summary");
    await vi.waitFor(() =>
      expect(api.getTableStructure).toHaveBeenCalledTimes(1)
    );
    store.switchTab("pg-1", 0);
    pending.resolve(columns);
    await loading;
    const state = useDatabaseStore.getState();
    expect(state.selectedTable).toBe("users");
    expect(state.tableStructure).toBeNull();
    expect(state.selectedTableInfo).toBeNull();
    expect(
      state.connectionStates["pg-1"].tableStructures["reports|summary"]
    ).toEqual(columns);
  });

  it.each(["close", "disconnect"] as const)(
    "%s 后迟到的结构请求不会恢复标签或连接",
    async (action) => {
      const pending = deferred<ColumnInfo[]>();
      vi.mocked(api.getTableStructure).mockReturnValue(pending.promise);
      const store = useDatabaseStore.getState();
      store.openTableTabs("pg-1", [{ database: "reports", table: "summary" }]);
      const loading = store.ensureTableMetadata("pg-1", "reports", "summary");
      await vi.waitFor(() =>
        expect(api.getTableStructure).toHaveBeenCalledTimes(1)
      );
      if (action === "close") store.closeTab("pg-1", 0);
      else store.removeConnectionState("pg-1");
      pending.resolve(columns);
      await loading;
      const state = useDatabaseStore.getState();
      expect(state.openTabs).toEqual([]);
      expect(state.selectedTable).toBeNull();
      expect(
        state.connectionStates["pg-1"]?.tableStructures["reports|summary"]
      ).toBeUndefined();
      if (action === "disconnect")
        expect(state.connectionStates["pg-1"]).toBeUndefined();
    }
  );

  it.each([false, true])(
    "加载结构期间刷新表列表保留新增表和新元数据（已有列表=%s）",
    async (cached) => {
      const pending = deferred<ColumnInfo[]>();
      vi.mocked(api.listTables).mockResolvedValue([view]);
      vi.mocked(api.getTableStructure).mockReturnValue(pending.promise);
      const store = useDatabaseStore.getState();
      if (cached) await store.loadTables("pg-1", "reports");
      store.openTableTabs("pg-1", [{ database: "reports", table: "summary" }]);
      const loading = store.ensureTableMetadata("pg-1", "reports", "summary");
      await vi.waitFor(() =>
        expect(api.getTableStructure).toHaveBeenCalledTimes(1)
      );
      vi.mocked(api.listTables).mockResolvedValue([
        { ...view, comment: "刷新后的注释" },
        users,
      ]);
      await store.loadTables("pg-1", "reports");
      pending.resolve(columns);
      await loading;
      expect(
        useDatabaseStore.getState().tables.reports.map((item) => item.name)
      ).toEqual(["summary", "users"]);
      expect(useDatabaseStore.getState().selectedTableInfo?.comment).toBe(
        "刷新后的注释"
      );
    }
  );

  it("迟到的结构响应不覆盖期间已经刷新的列缓存", async () => {
    const pending = deferred<ColumnInfo[]>();
    vi.mocked(api.getTableStructure).mockReturnValue(pending.promise);
    const store = useDatabaseStore.getState();
    store.openTableTabs("pg-1", [{ database: "public", table: "users" }]);
    const loading = store.ensureTableMetadata("pg-1", "public", "users");
    await vi.waitFor(() =>
      expect(api.getTableStructure).toHaveBeenCalledTimes(1)
    );
    const updatedColumns = [
      ...columns,
      { ...columns[0], name: "new_column", key: "" },
    ];
    useDatabaseStore.setState((current) => ({
      connectionStates: {
        ...current.connectionStates,
        "pg-1": {
          ...current.connectionStates["pg-1"],
          tableStructures: { "public|users": updatedColumns },
        },
      },
      tableStructure: updatedColumns,
    }));
    pending.resolve(columns);
    await loading;
    expect(
      useDatabaseStore.getState().tableStructure?.map((column) => column.name)
    ).toEqual(["id", "new_column"]);
    expect(
      useDatabaseStore.getState().connectionStates["pg-1"].tableStructures[
        "public|users"
      ]
    ).toEqual(updatedColumns);
  });

  it("不存在的收藏表返回错误，不虚构 TABLE，后续显式重试可成功", async () => {
    vi.mocked(api.listTables).mockResolvedValueOnce([]);
    const store = useDatabaseStore.getState();
    store.openTableTabs("pg-1", [{ database: "reports", table: "summary" }]);
    await expect(
      store.ensureTableMetadata("pg-1", "reports", "summary")
    ).rejects.toThrow(/summary/);
    expect(useDatabaseStore.getState().selectedTableInfo).toBeNull();
    expect(api.getTableStructure).not.toHaveBeenCalled();
    await store.ensureTableMetadata("pg-1", "reports", "summary");
    expect(useDatabaseStore.getState().selectedTableInfo?.table_type).toBe(
      "VIEW"
    );
  });
});
