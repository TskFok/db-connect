import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSqlCompletionMetadata } from "../hooks/useSqlCompletionMetadata";
import { invalidateSqlCompletion } from "../utils/sqlCompletionInvalidation";
import { loadSqlCompletionSchema } from "../utils/sqlCompletionSchema";
import * as api from "../services/tauriCommands";
import type { SqlCompletionForeignKeyResult } from "../types";
import type { SqlSchema } from "../utils/sqlCompletion";

vi.mock("../utils/sqlCompletionSchema", () => ({
  loadSqlCompletionSchema: vi.fn(),
}));
vi.mock("../services/tauriCommands", () => ({
  getSqlCompletionForeignKeys: vi
    .fn()
    .mockResolvedValue({ status: "ready", foreignKeys: [] }),
}));
const schema = (name: string): SqlSchema => ({
  databases: [name],
  tables: [{ name }],
  columns: [],
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
let counter = 0;
beforeEach(() => {
  vi.clearAllMocks();
  counter++;
});

describe("SQL 编辑器元数据绑定", () => {
  it.each(["resolve", "reject"] as const)(
    "切到 B 后 A 延迟 %s 不能污染新索引",
    async (settle) => {
      const a = deferred<SqlSchema>();
      vi.mocked(loadSqlCompletionSchema).mockImplementation(
        (_source, _conn, db) =>
          db === "a" ? a.promise : Promise.resolve(schema("b"))
      );
      const { result, rerender } = renderHook(
        ({ db }) => useSqlCompletionMetadata(`switch-${counter}`, db, "mysql"),
        { initialProps: { db: "a" } }
      );
      rerender({ db: "b" });
      expect(result.current.key.database).toBe("b");
      expect(result.current.index.schema.tables).toEqual([]);
      await waitFor(() =>
        expect(result.current.index.schema.tables).toEqual([{ name: "b" }])
      );
      await act(async () => {
        if (settle === "resolve") a.resolve(schema("a"));
        else a.reject(new Error("old failure"));
      });
      expect(result.current.index.schema.tables).toEqual([{ name: "b" }]);
    }
  );
  it("多个编辑器和连续补全共享一次批量预取", async () => {
    const request = deferred<SqlSchema>();
    vi.mocked(loadSqlCompletionSchema).mockReturnValue(request.promise);
    const connId = `shared-${counter}`;
    const a = renderHook(() =>
      useSqlCompletionMetadata(connId, "app", "mysql")
    );
    const b = renderHook(() =>
      useSqlCompletionMetadata(connId, "app", "mysql")
    );
    act(() => {
      for (let i = 0; i < 100; i++) {
        void a.result.current.requestRefresh();
        void b.result.current.requestRefresh();
      }
    });
    await waitFor(() =>
      expect(loadSqlCompletionSchema).toHaveBeenCalledTimes(1)
    );
    await act(async () => request.resolve(schema("users")));
    expect(a.result.current.index).toBe(b.result.current.index);
    expect(a.result.current.index.schema.tables).toEqual([{ name: "users" }]);
  });
  it("失效立即清空旧快照并重新预取；断线后同 id 使用新 revision", async () => {
    vi.mocked(loadSqlCompletionSchema).mockResolvedValue(schema("old"));
    const connId = `invalidate-${counter}`;
    const { result } = renderHook(() =>
      useSqlCompletionMetadata(connId, "app", "postgres")
    );
    await waitFor(() =>
      expect(result.current.index.schema.tables).toEqual([{ name: "old" }])
    );
    const revision = result.current.key.connectionRevision;
    const next = deferred<SqlSchema>();
    vi.mocked(loadSqlCompletionSchema).mockReturnValue(next.promise);
    act(() => invalidateSqlCompletion({ connId, reason: "disconnect" }));
    expect(result.current.key.connectionRevision).toBe(revision + 1);
    expect(result.current.index.schema.tables).toEqual([]);
    await act(async () => next.resolve(schema("new")));
    expect(result.current.index.schema.tables).toEqual([{ name: "new" }]);
  });
  it("无连接保留方言和本地空索引，不发请求", () => {
    const { result } = renderHook(() =>
      useSqlCompletionMetadata("", "old", "sqlserver")
    );
    expect(result.current.key).toMatchObject({
      connId: "",
      database: null,
      dialect: "sqlserver",
    });
    expect(result.current.index.schema.tables).toEqual([]);
    expect(loadSqlCompletionSchema).not.toHaveBeenCalled();
  });
  it("API 失败只保留当前 key 的空快照，连续输入不重试请求", async () => {
    vi.mocked(loadSqlCompletionSchema).mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() =>
      useSqlCompletionMetadata(`failure-${counter}`, "app", "sqlite")
    );
    await act(async () => {});
    await act(async () => {
      for (let i = 0; i < 100; i++) await result.current.requestRefresh();
    });
    expect(result.current.index.schema.tables).toEqual([]);
    expect(loadSqlCompletionSchema).toHaveBeenCalledTimes(1);
  });
});

const foreignKeys: SqlCompletionForeignKeyResult = {
  status: "ready",
  foreignKeys: [
    {
      id: "sales.orders/fk_user",
      constraintName: "fk_user",
      tableNamespace: "sales",
      tableName: "orders",
      columns: ["user_id"],
      referencedNamespace: "auth",
      referencedTable: "users",
      referencedColumns: ["id"],
    },
  ],
};

describe("SQL 编辑器外键预取", () => {
  beforeEach(() => {
    vi.mocked(loadSqlCompletionSchema).mockResolvedValue(schema("orders"));
    vi.mocked(api.getSqlCompletionForeignKeys)
      .mockReset()
      .mockResolvedValue(foreignKeys);
  });
  it("多个编辑器复用快照；同一跨 schema 关系变更使两端同时失效", async () => {
    const conn = `foreign-shared-${counter}`;
    const a = renderHook(() =>
      useSqlCompletionMetadata(conn, "sales", "postgres")
    );
    const b = renderHook(() =>
      useSqlCompletionMetadata(conn, "sales", "postgres")
    );
    const c = renderHook(() =>
      useSqlCompletionMetadata(conn, "auth", "postgres")
    );
    await waitFor(() =>
      expect(a.result.current.foreignKeys?.result).toEqual(foreignKeys)
    );
    expect(b.result.current.foreignKeys?.result).toBe(
      a.result.current.foreignKeys?.result
    );
    expect(c.result.current.foreignKeys?.result).toEqual(foreignKeys);
    expect(api.getSqlCompletionForeignKeys).toHaveBeenCalledTimes(2);
    const next = deferred<SqlCompletionForeignKeyResult>();
    vi.mocked(api.getSqlCompletionForeignKeys).mockReturnValue(next.promise);
    act(() =>
      invalidateSqlCompletion({
        connId: conn,
        database: "sales",
        reason: "schema-change",
      })
    );
    expect(a.result.current.foreignKeys).toBeUndefined();
    expect(c.result.current.foreignKeys).toBeUndefined();
    await waitFor(() =>
      expect(api.getSqlCompletionForeignKeys).toHaveBeenCalledTimes(4)
    );
    await act(async () => next.resolve({ status: "ready", foreignKeys: [] }));
    expect(c.result.current.foreignKeys?.result.foreignKeys).toEqual([]);
  });
  it("切换 schema 或卸载后旧外键请求不污染新会话", async () => {
    const old = deferred<SqlCompletionForeignKeyResult>();
    vi.mocked(api.getSqlCompletionForeignKeys).mockImplementation(
      (_conn, db) =>
        db === "sales"
          ? old.promise
          : Promise.resolve({ status: "unsupported", foreignKeys: [] })
    );
    const { result, rerender, unmount } = renderHook(
      ({ db }) =>
        useSqlCompletionMetadata(`foreign-switch-${counter}`, db, "postgres"),
      { initialProps: { db: "sales" } }
    );
    rerender({ db: "auth" });
    await waitFor(() =>
      expect(result.current.foreignKeys?.result.status).toBe("unsupported")
    );
    await act(async () => old.resolve(foreignKeys));
    expect(result.current.foreignKeys?.key.database).toBe("auth");
    expect(result.current.foreignKeys?.result.status).toBe("unsupported");
    rerender({ db: "sales" });
    unmount();
  });
  it("权限失败保留普通索引，短暂退避后可重试；无 schema 不请求", async () => {
    vi.mocked(api.getSqlCompletionForeignKeys).mockRejectedValue(
      new Error("permission denied")
    );
    const { result } = renderHook(() =>
      useSqlCompletionMetadata(`foreign-fail-${counter}`, "sales", "postgres")
    );
    await waitFor(() =>
      expect(result.current.index.schema.tables).toEqual([{ name: "orders" }])
    );
    expect(result.current.foreignKeys).toBeUndefined();
    await act(async () => {
      await result.current.requestRefresh();
    });
    expect(api.getSqlCompletionForeignKeys).toHaveBeenCalledTimes(1);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_001);
    vi.mocked(api.getSqlCompletionForeignKeys).mockResolvedValue(foreignKeys);
    await act(async () => {
      await result.current.requestRefresh();
    });
    clock.mockRestore();
    expect(result.current.foreignKeys?.result).toEqual(foreignKeys);
    renderHook(() =>
      useSqlCompletionMetadata(`foreign-none-${counter}`, null, "postgres")
    );
    expect(api.getSqlCompletionForeignKeys).toHaveBeenCalledTimes(2);
  });
});

describe("补全预取异步通知", () => {
  it("慢外键不阻塞已到达的普通表列菜单刷新", async () => {
    const slow = deferred<SqlCompletionForeignKeyResult>();
    const metadata = deferred<SqlSchema>();
    vi.mocked(api.getSqlCompletionForeignKeys).mockReturnValue(slow.promise);
    vi.mocked(loadSqlCompletionSchema).mockReturnValue(metadata.promise);
    const { result } = renderHook(() =>
      useSqlCompletionMetadata(`slow-foreign-${counter}`, "sales", "postgres")
    );
    const changed = vi.fn();
    let request!: Promise<boolean>;
    act(() => {
      request = result.current.requestRefresh(changed);
    });
    await act(async () => metadata.resolve(schema("orders")));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(result.current.foreignKeys).toBeUndefined();
    await act(async () => {
      slow.resolve(foreignKeys);
      await request;
    });
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it("同 key 切换 tab 时新会话仍能接收在途结果通知，旧会话失效", async () => {
    const slow = deferred<SqlCompletionForeignKeyResult>();
    const metadata = deferred<SqlSchema>();
    vi.mocked(api.getSqlCompletionForeignKeys).mockReturnValue(slow.promise);
    vi.mocked(loadSqlCompletionSchema).mockReturnValue(metadata.promise);
    const { result, rerender } = renderHook(
      ({ tab }) =>
        useSqlCompletionMetadata(
          `tab-foreign-${counter}`,
          "sales",
          "postgres",
          tab
        ),
      { initialProps: { tab: "a" } }
    );
    const oldChanged = vi.fn();
    act(() => {
      void result.current.requestRefresh(oldChanged);
    });
    rerender({ tab: "b" });
    const changed = vi.fn();
    act(() => {
      void result.current.requestRefresh(changed);
    });
    await act(async () => metadata.resolve(schema("orders")));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(oldChanged).not.toHaveBeenCalled();
    await act(async () => slow.resolve(foreignKeys));
    expect(changed).toHaveBeenCalledTimes(2);
    expect(oldChanged).not.toHaveBeenCalled();
  });
});
