import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../services/tauriCommands";
import { emptyConnState, useDatabaseStore } from "../stores/databaseStore";
import type { ColumnInfo, TableInfo } from "../types";
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
  useDatabaseStore.setState({
    connectionStates: {
      A: {
        ...emptyConnState(),
        databases: ["app"],
        tables: { app: [table("B")] },
        tableStructures: {
          "app|A": [column("cached-a")],
          "app|B": [column("cached-b")],
        },
      },
      B: {
        ...emptyConnState(),
        databases: ["app"],
        tables: { app: [table("cached")] },
      },
    },
  });
  useDatabaseStore.getState().switchToConnection("A");
  mockApi.createTable.mockResolvedValue(undefined);
  mockApi.addColumn.mockResolvedValue(undefined);
  mockApi.invalidateTableMetadataCache.mockResolvedValue(undefined);
  mockApi.listDatabases.mockResolvedValue(["app"]);
});
describe("FR1 受控补读与资源所有者", () => {
  it("建表目录被其它表加列失效后补读一次，不接纳旧目录", async () => {
    const old = deferred<TableInfo[]>();
    mockApi.listTables
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([table("A"), table("B")]);
    mockApi.getTableStructure.mockResolvedValue([column("new-b")]);
    const creating = useDatabaseStore
      .getState()
      .createTable("A", "app", {} as never);
    await vi.waitFor(() => expect(mockApi.listTables).toHaveBeenCalledTimes(1));
    await useDatabaseStore.getState().addColumn("A", "app", "B", {} as never);
    old.resolve([table("stale")]);
    await creating;
    expect(mockApi.listTables).toHaveBeenCalledTimes(2);
    expect(useDatabaseStore.getState().tables.app.map((t) => t.name)).toEqual([
      "A",
      "B",
    ]);
  });
  it("改名的目录与新表名结构分别归属，后续加列不能令改名目录丢失", async () => {
    const old = deferred<TableInfo[]>();
    mockApi.renameTable.mockResolvedValue(undefined);
    mockApi.listTables
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([table("renamed")]);
    mockApi.getTableStructure.mockResolvedValue([column("new-column")]);
    const renaming = useDatabaseStore
      .getState()
      .renameTable("A", "app", "B", "renamed");
    await vi.waitFor(() => expect(mockApi.listTables).toHaveBeenCalledTimes(1));
    await useDatabaseStore
      .getState()
      .addColumn("A", "app", "renamed", {} as never);
    old.resolve([table("stale")]);
    await renaming;
    expect(useDatabaseStore.getState().tables.app.map((t) => t.name)).toEqual([
      "renamed",
    ]);
    expect(
      useDatabaseStore.getState().connectionStates.A.tableStructures[
        "app|renamed"
      ]
    ).toEqual([column("new-column")]);
    expect(mockApi.getTableStructure).toHaveBeenCalledTimes(1);
  });
  it("异表加列交错时各自结构都能更新，旧结构不直接提交", async () => {
    const old = deferred<ColumnInfo[]>();
    mockApi.getTableStructure
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce([column("new-b")])
      .mockResolvedValueOnce([column("new-a")]);
    const a = useDatabaseStore
      .getState()
      .addColumn("A", "app", "A", {} as never);
    await vi.waitFor(() =>
      expect(mockApi.getTableStructure).toHaveBeenCalledTimes(1)
    );
    await useDatabaseStore.getState().addColumn("A", "app", "B", {} as never);
    old.resolve([column("stale-a")]);
    await a;
    expect(mockApi.getTableStructure).toHaveBeenCalledTimes(3);
    expect(
      useDatabaseStore.getState().connectionStates.A.tableStructures
    ).toMatchObject({ "app|A": [column("new-a")], "app|B": [column("new-b")] });
  });
  it("补读再次被其它DDL失效时明确报错、移除旧结构且不第三次查询", async () => {
    const old = deferred<ColumnInfo[]>();
    const retry = deferred<ColumnInfo[]>();
    mockApi.getTableStructure.mockImplementation(async (_conn, _db, name) =>
      name === "A"
        ? mockApi.getTableStructure.mock.calls.filter((call) => call[2] === "A")
            .length === 1
          ? old.promise
          : retry.promise
        : [column(name)]
    );
    const a = useDatabaseStore
      .getState()
      .addColumn("A", "app", "A", {} as never);
    await vi.waitFor(() =>
      expect(mockApi.getTableStructure).toHaveBeenCalledTimes(1)
    );
    await useDatabaseStore.getState().addColumn("A", "app", "B", {} as never);
    old.resolve([column("stale-a")]);
    await vi.waitFor(() =>
      expect(
        mockApi.getTableStructure.mock.calls.filter((call) => call[2] === "A")
      ).toHaveLength(2)
    );
    await useDatabaseStore.getState().addColumn("A", "app", "C", {} as never);
    retry.resolve([column("also-stale")]);
    await expect(a).rejects.toThrow(/重试|刷新/);
    expect(
      mockApi.getTableStructure.mock.calls.filter((call) => call[2] === "A")
    ).toHaveLength(2);
    expect(
      useDatabaseStore.getState().connectionStates.A.tableStructures["app|A"]
    ).toBeUndefined();
  });
  it.each(["refresh", "loadTables"] as const)(
    "%s 接管目录时旧DDL不得补读或覆盖新目录",
    async (newer) => {
      const old = deferred<TableInfo[]>();
      mockApi.listTables
        .mockReturnValueOnce(old.promise)
        .mockResolvedValue([table("newer")]);
      mockApi.listTablesBatch.mockResolvedValue([
        { database: "app", tables: [table("newer")] },
      ]);
      const creating = useDatabaseStore
        .getState()
        .createTable("A", "app", {} as never);
      await vi.waitFor(() =>
        expect(mockApi.listTables).toHaveBeenCalledTimes(1)
      );
      if (newer === "refresh") await useDatabaseStore.getState().refresh("A");
      else await useDatabaseStore.getState().loadTables("A", "app");
      old.resolve([table("stale")]);
      await creating;
      expect(mockApi.listTables).toHaveBeenCalledTimes(
        newer === "refresh" ? 1 : 2
      );
      expect(useDatabaseStore.getState().tables.app.map((t) => t.name)).toEqual(
        ["newer"]
      );
    }
  );
  it("已经开始的补读被更新刷新接管后不得回填", async () => {
    const old = deferred<TableInfo[]>();
    const retry = deferred<TableInfo[]>();
    mockApi.listTables
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(retry.promise);
    mockApi.getTableStructure.mockResolvedValue([column("new-b")]);
    mockApi.listTablesBatch.mockResolvedValue([
      { database: "app", tables: [table("from-refresh")] },
    ]);
    const creating = useDatabaseStore
      .getState()
      .createTable("A", "app", {} as never);
    await vi.waitFor(() => expect(mockApi.listTables).toHaveBeenCalledTimes(1));
    await useDatabaseStore.getState().addColumn("A", "app", "B", {} as never);
    old.resolve([table("stale")]);
    await vi.waitFor(() => expect(mockApi.listTables).toHaveBeenCalledTimes(2));
    await useDatabaseStore.getState().refresh("A");
    retry.resolve([table("retry-stale")]);
    await creating;
    expect(useDatabaseStore.getState().tables.app.map((t) => t.name)).toEqual([
      "from-refresh",
    ]);
    expect(mockApi.listTables).toHaveBeenCalledTimes(2);
  });
  it("补读等待期间断线不重建连接，也不继续重试", async () => {
    const old = deferred<TableInfo[]>();
    const retry = deferred<TableInfo[]>();
    mockApi.listTables
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(retry.promise);
    mockApi.getTableStructure.mockResolvedValue([]);
    const creating = useDatabaseStore
      .getState()
      .createTable("A", "app", {} as never);
    await vi.waitFor(() => expect(mockApi.listTables).toHaveBeenCalledTimes(1));
    await useDatabaseStore.getState().addColumn("A", "app", "B", {} as never);
    old.resolve([]);
    await vi.waitFor(() => expect(mockApi.listTables).toHaveBeenCalledTimes(2));
    useDatabaseStore.getState().removeConnectionState("A");
    retry.resolve([]);
    await creating;
    expect(useDatabaseStore.getState().connectionStates.A).toBeUndefined();
    expect(mockApi.listTables).toHaveBeenCalledTimes(2);
  });
});
describe("FR2 loading 按活动连接投影", () => {
  it.each(["treeLoading", "structureLoading"] as const)(
    "%s 切缓存连接、后台完成和切回都按owner投影",
    async (kind) => {
      const pending = deferred<never[]>();
      mockApi.listTables.mockReturnValue(pending.promise);
      mockApi.getTableStructure.mockReturnValue(pending.promise);
      const a =
        kind === "treeLoading"
          ? useDatabaseStore.getState().loadTables("A", "app")
          : useDatabaseStore.getState().selectTable("A", "app", "other");
      expect(useDatabaseStore.getState()[kind]).toBe(true);
      useDatabaseStore.getState().switchToConnection("B");
      expect(useDatabaseStore.getState()[kind]).toBe(false);
      useDatabaseStore.getState().switchToConnection("A");
      expect(useDatabaseStore.getState()[kind]).toBe(true);
      useDatabaseStore.getState().switchToConnection("B");
      pending.resolve([]);
      await a;
      expect(useDatabaseStore.getState()[kind]).toBe(false);
      useDatabaseStore.getState().switchToConnection("A");
      expect(useDatabaseStore.getState()[kind]).toBe(false);
    }
  );
  it.each(["treeLoading", "structureLoading"] as const)(
    "%s 断线后清理并切到缓存连接不残留",
    async (kind) => {
      const pending = deferred<never[]>();
      mockApi.listTables.mockReturnValue(pending.promise);
      mockApi.getTableStructure.mockReturnValue(pending.promise);
      const a =
        kind === "treeLoading"
          ? useDatabaseStore.getState().loadTables("A", "app")
          : useDatabaseStore.getState().selectTable("A", "app", "other");
      useDatabaseStore.getState().removeConnectionState("A");
      expect(useDatabaseStore.getState()[kind]).toBe(false);
      useDatabaseStore.getState().switchToConnection("B");
      pending.resolve([]);
      await a;
      expect(useDatabaseStore.getState()[kind]).toBe(false);
    }
  );
  it.each(["treeLoading", "structureLoading"] as const)(
    "%s 旧连接完成不清除B自身新请求",
    async (kind) => {
      const old = deferred<never[]>();
      const fresh = deferred<never[]>();
      mockApi.listTables
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(fresh.promise);
      mockApi.getTableStructure
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(fresh.promise);
      const a =
        kind === "treeLoading"
          ? useDatabaseStore.getState().loadTables("A", "app")
          : useDatabaseStore.getState().selectTable("A", "app", "other");
      useDatabaseStore.getState().switchToConnection("B");
      const b =
        kind === "treeLoading"
          ? useDatabaseStore.getState().loadTables("B", "app")
          : useDatabaseStore.getState().selectTable("B", "app", "other");
      old.resolve([]);
      await a;
      expect(useDatabaseStore.getState()[kind]).toBe(true);
      fresh.resolve([]);
      await b;
      expect(useDatabaseStore.getState()[kind]).toBe(false);
    }
  );
});
