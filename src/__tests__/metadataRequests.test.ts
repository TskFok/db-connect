import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import * as api from "../services/tauriCommands";
import {
  invalidateSqlCompletion,
  subscribeSqlCompletionInvalidation,
} from "../utils/sqlCompletionInvalidation";
import { useConnectionStore } from "../stores/connectionStore";
import type { DatabaseTableList } from "../types";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const mockInvoke = vi.mocked(invoke);
let serial = 0;
beforeEach(() => {
  vi.resetAllMocks();
  serial++;
});
const rows = (databases: string[]): DatabaseTableList[] =>
  databases.map((database) => ({ database, tables: [] }));
describe("metadata_requests", () => {
  it("相同集合只 invoke 一次且按调用者去重后的原始顺序返回", async () => {
    const request = deferred<DatabaseTableList[]>();
    mockInvoke.mockReturnValue(request.promise);
    const conn = `shared-${serial}`;
    const a = api.listTablesBatch(conn, ["b", "a", "b"]);
    const b = api.listTablesBatch(conn, ["a", "b"]);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    request.resolve(rows(["a", "b"]));
    expect(await a).toEqual(rows(["b", "a"]));
    expect(await b).toEqual(rows(["a", "b"]));
  });
  it("单库与单元素批量共享进行中请求，完成后不缓存结果", async () => {
    const request = deferred<DatabaseTableList[]>();
    mockInvoke.mockReturnValue(request.promise);
    const a = api.listTables(`single-${serial}`, "app");
    const b = api.listTablesBatch(`single-${serial}`, ["app"]);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    request.resolve(rows(["app"]));
    expect(await a).toEqual([]);
    await b;
    await api.listTables(`single-${serial}`, "app");
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });
  it("JSON 键保留分隔符、引号及大小写，不同连接互不共享", async () => {
    mockInvoke.mockImplementation(async (_command, args) =>
      rows((args as { databases: string[] }).databases)
    );
    await Promise.all([
      api.listTablesBatch(`key-${serial}`, ["a|b"]),
      api.listTablesBatch(`key-${serial}`, ["a", "b"]),
      api.listTablesBatch(`key-${serial}`, ['a"b', "A"]),
      api.listTablesBatch(`other-${serial}`, ["a|b"]),
    ]);
    expect(mockInvoke).toHaveBeenCalledTimes(4);
  });
  it("失败清理后可重试；空输入零调用，超过 256 个唯一库拒绝", async () => {
    mockInvoke
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(rows(["app"]));
    await expect(
      api.listTablesBatch(`retry-${serial}`, ["app"])
    ).rejects.toThrow("offline");
    await expect(
      api.listTablesBatch(`retry-${serial}`, ["app"])
    ).resolves.toEqual(rows(["app"]));
    expect(mockInvoke).toHaveBeenCalledTimes(2);
    mockInvoke.mockClear();
    expect(await api.listTablesBatch("empty", [])).toEqual([]);
    await expect(
      api.listTablesBatch(
        "limit",
        Array.from({ length: 257 }, (_, i) => `db${i}`)
      )
    ).rejects.toThrow("256");
    expect(mockInvoke).not.toHaveBeenCalled();
    await api.listTablesBatch("duplicates", Array(300).fill("app"));
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });
  it.each(["direct", "event"])(
    "%s 失效后旧 finally 不删除新请求，其它库请求仍复用",
    async (mode) => {
      const old = deferred<DatabaseTableList[]>();
      const fresh = deferred<DatabaseTableList[]>();
      const other = deferred<DatabaseTableList[]>();
      mockInvoke
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(other.promise)
        .mockReturnValueOnce(fresh.promise);
      const conn = `stale-${serial}`;
      const a = api.listTablesBatch(conn, ["a"]);
      const b = api.listTablesBatch(conn, ["b"]);
      if (mode === "direct") api.invalidateMetadataRequests(conn, "a");
      else
        invalidateSqlCompletion({
          connId: conn,
          database: "a",
          reason: "schema-change",
        });
      const c = api.listTablesBatch(conn, ["a"]);
      old.resolve(rows(["a"]));
      await a;
      const d = api.listTablesBatch(conn, ["a"]);
      const e = api.listTablesBatch(conn, ["b"]);
      expect(mockInvoke).toHaveBeenCalledTimes(3);
      fresh.resolve(rows(["a"]));
      other.resolve(rows(["b"]));
      await Promise.all([b, c, d, e]);
    }
  );
  it("可等待的后端失效使用表粒度参数", async () => {
    const pending = deferred<void>();
    mockInvoke.mockReturnValue(pending.promise);
    let completed = false;
    const request = api
      .invalidateTableMetadataCache("conn", "db", "table")
      .then(() => {
        completed = true;
      });
    expect(mockInvoke).toHaveBeenCalledWith("invalidate_table_metadata_cache", {
      connId: "conn",
      database: "db",
      table: "table",
    });
    expect(completed).toBe(false);
    pending.resolve();
    await request;
    expect(completed).toBe(true);
  });
});

describe("结构同步失效", () => {
  it.each(["succeeded", "partially_succeeded", "failed"])(
    "%s 只清理有成功语句的目标库连接",
    async (status) => {
      const connection = (id: string, connId: string) => ({
        connId,
        config: {
          id,
          name: id,
          host: "localhost",
          port: 3306,
          username: "test",
        },
      });
      useConnectionStore.setState({
        activeConnections: {
          source: connection("src", "source"),
          target: connection("dst", "target"),
          other: connection("other", "other"),
        },
      });
      mockInvoke.mockResolvedValue({
        status,
        completed_statements:
          status === "failed"
            ? []
            : [{ operation_id: "op", statement_index: 0 }],
        failed: null,
        pending_operation_ids: [],
        cleanup_errors: [],
        latest_compare_result: null,
      });
      const listener = vi.fn();
      const stop = subscribeSqlCompletionInvalidation(listener);
      try {
        await api.executeDatabaseSync({
          request: {
            source: { saved_connection_id: "src", database: "from" },
            target: { saved_connection_id: "dst", database: "to" },
            selected_tables: [],
            include_drops: false,
          },
          plan_fingerprint: "test",
        } as never);
        if (status === "failed") expect(listener).not.toHaveBeenCalled();
        else
          expect(listener).toHaveBeenCalledExactlyOnceWith({
            connId: "target",
            database: "to",
            reason: "schema-change",
          });
      } finally {
        stop();
      }
    }
  );
});

describe("索引修改失效", () => {
  it.each(["create", "delete"])(
    "索引 %s 仅在成功后使目标目录失效",
    async (action) => {
      const events = vi.fn();
      const stop = subscribeSqlCompletionInvalidation(events);
      const change = () =>
        action === "create"
          ? api.createIndex("index-conn", "app", "users", {} as never)
          : api.deleteIndex("index-conn", "app", "users", "PRIMARY");
      try {
        mockInvoke.mockRejectedValueOnce(new Error("DDL denied"));
        await expect(change()).rejects.toThrow("DDL denied");
        expect(events).not.toHaveBeenCalled();
        mockInvoke.mockResolvedValueOnce(undefined);
        await change();
        expect(events).toHaveBeenCalledExactlyOnceWith({
          connId: "index-conn",
          database: "app",
          reason: "schema-change",
        });
      } finally {
        stop();
      }
    }
  );
});
