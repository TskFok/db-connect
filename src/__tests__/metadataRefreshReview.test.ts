import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../services/tauriCommands";
import { emptyConnState, useDatabaseStore } from "../stores/databaseStore";
import type { ColumnInfo, DatabaseTableList, TableInfo } from "../types";
vi.mock("../services/tauriCommands");
const mockApi = vi.mocked(api);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function table(name: string): TableInfo {
  return {
    name,
    table_type: "TABLE",
    engine: null,
    rows: null,
    data_length: null,
    index_length: null,
    comment: "",
  };
}
function column(name: string): ColumnInfo {
  return {
    name,
    column_type: "int",
    nullable: false,
    key: "",
    default_value: null,
    extra: "",
    comment: "",
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  useDatabaseStore.getState().reset();
  useDatabaseStore.getState().switchToConnection("review");
  useDatabaseStore.setState({
    connectionStates: {
      review: {
        ...emptyConnState(),
        databases: ["app"],
        tables: { app: [table("old")] },
      },
    },
  });
  mockApi.invalidateTableMetadataCache.mockResolvedValue(undefined);
  mockApi.listDatabases.mockResolvedValue(["app"]);
  mockApi.listTablesBatch.mockResolvedValue([
    { database: "app", tables: [table("old")] },
  ]);
});
describe("F1 并发 DDL 的目录更新责任", () => {
  it("后成功的 DDL 读取新一代目录，先成功的旧读取不得覆盖", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const earlierRead = deferred<TableInfo[]>();
    mockApi.createTable
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    mockApi.listTables
      .mockReturnValueOnce(earlierRead.promise)
      .mockResolvedValueOnce([table("a"), table("b")]);
    const a = useDatabaseStore
      .getState()
      .createTable("review", "app", {} as never);
    const b = useDatabaseStore
      .getState()
      .createTable("review", "app", {} as never);
    second.resolve();
    await vi.waitFor(() => expect(mockApi.listTables).toHaveBeenCalledTimes(1));
    first.resolve();
    await a;
    earlierRead.resolve([table("b")]);
    await b;
    expect(mockApi.listTables).toHaveBeenCalledTimes(2);
    expect(useDatabaseStore.getState().tables.app.map((t) => t.name)).toEqual([
      "a",
      "b",
    ]);
  });
  it("DDL 在刷新期间成功仍负责更新，过期刷新释放自己的 loading", async () => {
    const ddl = deferred<void>();
    const batch = deferred<DatabaseTableList[]>();
    mockApi.createTable.mockReturnValue(ddl.promise);
    mockApi.listTables.mockResolvedValue([table("created")]);
    mockApi.listTablesBatch.mockReturnValue(batch.promise);
    const mutation = useDatabaseStore
      .getState()
      .createTable("review", "app", {} as never);
    const refresh = useDatabaseStore.getState().refresh("review");
    await vi.waitFor(() =>
      expect(mockApi.listTablesBatch).toHaveBeenCalledTimes(1)
    );
    ddl.resolve();
    await mutation;
    batch.resolve([{ database: "app", tables: [table("before")] }]);
    await refresh;
    expect(useDatabaseStore.getState().tables.app.map((t) => t.name)).toEqual([
      "created",
    ]);
    expect(useDatabaseStore.getState().treeLoading).toBe(false);
  });
  it("过期刷新不能结束新刷新拥有的 treeLoading", async () => {
    const old = deferred<DatabaseTableList[]>();
    const fresh = deferred<DatabaseTableList[]>();
    mockApi.listTablesBatch
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    const a = useDatabaseStore.getState().refresh("review");
    await vi.waitFor(() =>
      expect(mockApi.listTablesBatch).toHaveBeenCalledTimes(1)
    );
    const b = useDatabaseStore.getState().refresh("review");
    await vi.waitFor(() =>
      expect(mockApi.listTablesBatch).toHaveBeenCalledTimes(2)
    );
    old.resolve([]);
    await a;
    expect(useDatabaseStore.getState().treeLoading).toBe(true);
    fresh.resolve([]);
    await b;
    expect(useDatabaseStore.getState().treeLoading).toBe(false);
  });
});
describe("F2 刷新结构请求的身份", () => {
  it("旧刷新不能覆盖关闭后重开的同名标签结构", async () => {
    useDatabaseStore
      .getState()
      .openTableTabs("review", [{ database: "app", table: "old" }]);
    const old = deferred<ColumnInfo[]>();
    mockApi.getTableStructure
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([column("fresh")]);
    const refresh = useDatabaseStore.getState().refresh("review");
    await vi.waitFor(() =>
      expect(mockApi.getTableStructure).toHaveBeenCalledTimes(1)
    );
    useDatabaseStore.getState().closeTab("review", 0);
    await useDatabaseStore.getState().selectTable("review", "app", "old");
    old.resolve([column("stale")]);
    await refresh;
    expect(
      useDatabaseStore.getState().tableStructure?.map((c) => c.name)
    ).toEqual(["fresh"]);
    expect(
      useDatabaseStore
        .getState()
        .connectionStates.review.tableStructures["app|old"].map((c) => c.name)
    ).toEqual(["fresh"]);
  });
  it.each(["success", "failure"])(
    "旧刷新 %s 不会清理新结构读取的 loading",
    async (outcome) => {
      let resolve!: (value: DatabaseTableList[]) => void;
      let reject!: (reason: Error) => void;
      const batch = new Promise<DatabaseTableList[]>((a, b) => {
        resolve = a;
        reject = b;
      });
      const structure = deferred<ColumnInfo[]>();
      mockApi.listTablesBatch.mockReturnValue(batch);
      mockApi.getTableStructure.mockReturnValue(structure.promise);
      const refresh = useDatabaseStore.getState().refresh("review");
      await vi.waitFor(() =>
        expect(mockApi.listTablesBatch).toHaveBeenCalledTimes(1)
      );
      const opening = useDatabaseStore
        .getState()
        .selectTable("review", "app", "old");
      expect(useDatabaseStore.getState().structureLoading).toBe(true);
      if (outcome === "success") resolve([]);
      else reject(new Error("目录失败"));
      await refresh;
      expect(useDatabaseStore.getState().structureLoading).toBe(true);
      structure.resolve([column("new")]);
      await opening;
      expect(useDatabaseStore.getState().structureLoading).toBe(false);
    }
  );
});
describe("F3 过滤已经消失的历史数据库", () => {
  it("新库集合决定批量请求，移除消失目录且保留标签和草稿", async () => {
    const tabs = [
      { type: "sql" as const, id: "draft" },
      { type: "table" as const, database: "gone", table: "old" },
    ];
    useDatabaseStore.setState({
      connectionStates: {
        review: {
          ...emptyConnState(),
          databases: ["gone", "app"],
          tables: { gone: [table("old")], app: [] },
          selectedDatabase: "app",
          viewMode: "overview",
          openTabs: tabs,
          sqlTabContents: { draft: "SELECT keep_me" },
        },
      },
    });
    mockApi.listTablesBatch.mockImplementation(async (_conn, databases) => {
      if (databases.includes("gone")) throw new Error("数据库不存在");
      return [{ database: "app", tables: [table("current")] }];
    });
    await useDatabaseStore.getState().refresh("review");
    expect(mockApi.listTablesBatch).toHaveBeenCalledExactlyOnceWith("review", [
      "app",
    ]);
    const state = useDatabaseStore.getState().connectionStates.review;
    expect(state.databases).toEqual(["app"]);
    expect(state.tables).toEqual({ app: [table("current")] });
    expect(state.openTabs).toBe(tabs);
    expect(state.sqlTabContents).toEqual({ draft: "SELECT keep_me" });
    await useDatabaseStore.getState().refresh("review");
    expect(mockApi.listTablesBatch).toHaveBeenLastCalledWith("review", ["app"]);
  });
  it("现存库的批量错误不伪装空目录，也不局部提交新数据库列表", async () => {
    const previous = useDatabaseStore.getState().connectionStates.review;
    mockApi.listDatabases.mockResolvedValue(["app", "another"]);
    mockApi.listTablesBatch.mockRejectedValue(new Error("目录权限不足"));
    await useDatabaseStore.getState().refresh("review");
    expect(useDatabaseStore.getState().connectionStates.review).toBe(previous);
  });
});
