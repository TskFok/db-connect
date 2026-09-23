import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSqlCompletionMetadata } from "../hooks/useSqlCompletionMetadata";
import { invalidateSqlCompletion } from "../utils/sqlCompletionInvalidation";
import { loadSqlCompletionSchema } from "../utils/sqlCompletionSchema";
import type { SqlSchema } from "../utils/sqlCompletion";

vi.mock("../utils/sqlCompletionSchema", () => ({
  loadSqlCompletionSchema: vi.fn(),
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
