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
const store = () => useDatabaseStore.getState();
const changeOtherTable = () =>
  store().addColumn("owner", "app", "B", {} as never);
beforeEach(() => {
  vi.resetAllMocks();
  store().reset();
  useDatabaseStore.setState({
    connectionStates: {
      owner: {
        ...emptyConnState(),
        databases: ["app"],
        tables: { app: [table("A"), table("B")] },
        tableStructures: { "app|A": [column("cached")] },
      },
    },
  });
  store().switchToConnection("owner");
  mockApi.createTable.mockResolvedValue(undefined);
  mockApi.addColumn.mockResolvedValue(undefined);
  mockApi.invalidateTableMetadataCache.mockResolvedValue(undefined);
  mockApi.listDatabases.mockResolvedValue(["app"]);
  mockApi.listTablesBatch.mockResolvedValue([
    { database: "app", tables: [table("A"), table("B")] },
  ]);
  mockApi.getTableStructure.mockResolvedValue([column("other")]);
});

function catalogReader(kind: "refresh" | "loadTables") {
  const reads: ReturnType<typeof deferred<TableInfo[]>>[] = [];
  const load = () => {
    const read = deferred<TableInfo[]>();
    reads.push(read);
    return read.promise;
  };
  if (kind === "refresh")
    mockApi.listTablesBatch.mockImplementation(async () => [
      { database: "app", tables: await load() },
    ]);
  else mockApi.listTables.mockImplementation(load);
  return {
    reads,
    start: () =>
      kind === "refresh"
        ? store().refresh("owner")
        : store().loadTables("owner", "app"),
  };
}

describe.each(["refresh", "loadTables"] as const)("目录接管者 %s", (kind) => {
  it("接管建表读取后被异表DDL失效仍补读并提交当前目录", async () => {
    const old = deferred<TableInfo[]>();
    mockApi.listTables.mockReturnValueOnce(old.promise);
    const creating = store().createTable("owner", "app", {} as never);
    await vi.waitFor(() => expect(mockApi.listTables).toHaveBeenCalledTimes(1));
    const reader = catalogReader(kind);
    const reading = reader.start();
    await vi.waitFor(() => expect(reader.reads).toHaveLength(1));
    await changeOtherTable();
    reader.reads[0].resolve([table("stale")]);
    await vi.waitFor(() => expect(reader.reads).toHaveLength(2));
    reader.reads[1].resolve([table("created"), table("B")]);
    await reading;
    old.resolve([table("old-ddl")]);
    await creating;
    expect(store().tables.app.map((value) => value.name)).toEqual([
      "created",
      "B",
    ]);
    expect(mockApi.createTable).toHaveBeenCalledTimes(1);
  });
  it("补读再次失效会清缓存、提供刷新提示且没有第三次查询", async () => {
    const reader = catalogReader(kind);
    const reading = reader.start();
    const outcome = reading.then(
      () => undefined,
      (error: Error) => error
    );
    await vi.waitFor(() => expect(reader.reads).toHaveLength(1));
    await changeOtherTable();
    reader.reads[0].resolve([table("stale")]);
    await vi.waitFor(() => expect(reader.reads).toHaveLength(2));
    await changeOtherTable();
    reader.reads[1].resolve([table("also-stale")]);
    const error = await outcome;
    expect(store().tables.app).toBeUndefined();
    expect(error?.message).toMatch(/元数据.*再次变化.*刷新/);
    expect(store().structureError).toBeNull();
    expect(reader.reads).toHaveLength(2);
    expect(store().treeLoading).toBe(false);
  });
  it.each(["newer", "disconnect"] as const)(
    "补读等待时%s保护仍有效",
    async (action) => {
      const reader = catalogReader(kind);
      const reading = reader.start();
      await vi.waitFor(() => expect(reader.reads).toHaveLength(1));
      await changeOtherTable();
      reader.reads[0].resolve([table("stale")]);
      await vi.waitFor(() => expect(reader.reads).toHaveLength(2));
      if (action === "newer") {
        const newer = reader.start();
        await vi.waitFor(() => expect(reader.reads).toHaveLength(3));
        reader.reads[2].resolve([table("newer")]);
        await newer;
      } else store().removeConnectionState("owner");
      reader.reads[1].resolve([table("old-retry")]);
      await reading;
      if (action === "newer")
        expect(store().tables.app.map((value) => value.name)).toEqual([
          "newer",
        ]);
      else expect(store().connectionStates.owner).toBeUndefined();
      expect(reader.reads).toHaveLength(action === "newer" ? 3 : 2);
    }
  );
});

function structureReader(
  kind: "refresh" | "selectTable" | "ensureTableMetadata"
) {
  if (kind !== "selectTable")
    store().openTableTabs("owner", [{ database: "app", table: "A" }]);
  if (kind === "ensureTableMetadata")
    useDatabaseStore.setState((current) => ({
      connectionStates: {
        ...current.connectionStates,
        owner: { ...current.connectionStates.owner, tableStructures: {} },
      },
    }));
  const reads: ReturnType<typeof deferred<ColumnInfo[]>>[] = [];
  mockApi.getTableStructure.mockImplementation((_conn, _db, name) => {
    if (name !== "A") return Promise.resolve([column("other")]);
    const read = deferred<ColumnInfo[]>();
    reads.push(read);
    return read.promise;
  });
  return {
    reads,
    start: () =>
      kind === "refresh"
        ? store().refresh("owner")
        : store()[kind]("owner", "app", "A"),
  };
}

describe.each(["refresh", "selectTable", "ensureTableMetadata"] as const)(
  "结构接管者 %s",
  (kind) => {
    it("接管加列读取后被异表DDL失效仍补读当前结构", async () => {
      const old = deferred<ColumnInfo[]>();
      mockApi.getTableStructure.mockReturnValueOnce(old.promise);
      const mutation = store().addColumn("owner", "app", "A", {} as never);
      await vi.waitFor(() =>
        expect(mockApi.getTableStructure).toHaveBeenCalledTimes(1)
      );
      const reader = structureReader(kind);
      const reading = reader.start();
      await vi.waitFor(() => expect(reader.reads).toHaveLength(1));
      await changeOtherTable();
      reader.reads[0].resolve([column("stale")]);
      await vi.waitFor(() => expect(reader.reads).toHaveLength(2));
      reader.reads[1].resolve([column("fresh")]);
      await reading;
      old.resolve([column("old-ddl")]);
      await mutation;
      expect(store().connectionStates.owner.tableStructures["app|A"]).toEqual([
        column("fresh"),
      ]);
      expect(store().tableStructure).toEqual([column("fresh")]);
      expect(reader.reads).toHaveLength(2);
    });
    it("补读再次失效会清结构并明确提示刷新", async () => {
      const reader = structureReader(kind);
      const reading = reader.start();
      const outcome = reading.then(
        () => undefined,
        (error: Error) => error
      );
      await vi.waitFor(() => expect(reader.reads).toHaveLength(1));
      await changeOtherTable();
      reader.reads[0].resolve([column("stale")]);
      await vi.waitFor(() => expect(reader.reads).toHaveLength(2));
      await changeOtherTable();
      reader.reads[1].resolve([column("also-stale")]);
      const error = await outcome;
      expect(
        store().connectionStates.owner.tableStructures["app|A"]
      ).toBeUndefined();
      expect(error?.message ?? store().structureError).toMatch(
        /元数据.*再次变化.*刷新/
      );
      expect(reader.reads).toHaveLength(2);
    });
    it.each(["newer", "disconnect"] as const)(
      "补读期间%s不覆盖新结构或重建连接",
      async (action) => {
        const reader = structureReader(kind);
        const reading = reader.start();
        await vi.waitFor(() => expect(reader.reads).toHaveLength(1));
        await changeOtherTable();
        reader.reads[0].resolve([column("stale")]);
        await vi.waitFor(() => expect(reader.reads).toHaveLength(2));
        if (action === "newer") {
          const newer = reader.start();
          await vi.waitFor(() => expect(reader.reads).toHaveLength(3));
          reader.reads[2].resolve([column("newer")]);
          await newer;
        } else store().removeConnectionState("owner");
        reader.reads[1].resolve([column("old-retry")]);
        await reading;
        if (action === "newer")
          expect(
            store().connectionStates.owner.tableStructures["app|A"]
          ).toEqual([column("newer")]);
        else expect(store().connectionStates.owner).toBeUndefined();
      }
    );
  }
);
