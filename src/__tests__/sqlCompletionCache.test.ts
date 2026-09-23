import { describe, expect, it, vi } from "vitest";
import type { SqlSchema } from "../utils/sqlCompletion";
import type { SqlCompletionCacheKey } from "../utils/sqlCompletionTypes";
import { createSqlCompletionCache } from "../utils/sqlCompletionCache";
import {
  getSqlCompletionConnectionRevision,
  invalidateSqlCompletion,
  subscribeSqlCompletionInvalidation,
} from "../utils/sqlCompletionInvalidation";

const schema = (name: string): SqlSchema => ({
  databases: ["app"],
  tables: [{ name }],
  columns: [{ table: name, name: "id", type: "int" }],
});
const key = (
  database: string | null,
  connId = "conn-1"
): SqlCompletionCacheKey => ({
  connId,
  database,
  dialect: "mysql",
  connectionRevision: 0,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

describe("SQL 补全元数据缓存", () => {
  it("同一 key 的并发请求共用一次加载和同一索引", async () => {
    const loader = vi.fn().mockResolvedValue(schema("users"));
    const cache = createSqlCompletionCache(loader, () => 0);
    const [a, b] = await Promise.all([
      cache.get(key("app")),
      cache.get(key("app")),
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(cache.peek(key("app"))).toBe(a);
    expect(a.tablesByName.get("users")).toEqual({ name: "users" });
  });

  it("60 秒后重新加载，过期项不能 peek", async () => {
    let now = 0;
    const loader = vi.fn().mockResolvedValue(schema("users"));
    const cache = createSqlCompletionCache(loader, () => now);
    const first = await cache.get(key("app"));
    now = 59_999;
    expect(await cache.get(key("app"))).toBe(first);
    now = 60_000;
    expect(cache.peek(key("app"))).toBeUndefined();
    expect(await cache.get(key("app"))).not.toBe(first);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("仅保留最近使用的 8 个已完成命名空间", async () => {
    const loader = vi
      .fn()
      .mockImplementation(async (k: SqlCompletionCacheKey) =>
        schema(k.database ?? "list")
      );
    const cache = createSqlCompletionCache(loader, () => 0);
    for (let i = 0; i < 8; i++) await cache.get(key(`db-${i}`));
    cache.peek(key("db-0"));
    await cache.get(key("db-8"));
    expect(cache.peek(key("db-0"))).toBeDefined();
    expect(cache.peek(key("db-1"))).toBeUndefined();
    expect(loader).toHaveBeenCalledTimes(9);
  });

  it("null 只失效库列表，undefined 失效连接下全部条目", async () => {
    const cache = createSqlCompletionCache(
      async () => schema("users"),
      () => 0
    );
    await Promise.all([
      cache.get(key(null)),
      cache.get(key("app")),
      cache.get(key("other", "conn-2")),
    ]);
    cache.invalidate({ connId: "conn-1", database: null, reason: "refresh" });
    expect(cache.peek(key(null))).toBeUndefined();
    expect(cache.peek(key("app"))).toBeDefined();
    cache.invalidate({ connId: "conn-1", reason: "disconnect" });
    expect(cache.peek(key("app"))).toBeUndefined();
    expect(cache.peek(key("other", "conn-2"))).toBeDefined();
  });

  it("不同连接 revision 使用不同缓存条目", async () => {
    const loader = vi.fn().mockResolvedValue(schema("users"));
    const cache = createSqlCompletionCache(loader, () => 0);
    const before = await cache.get(key("app"));
    const afterKey = { ...key("app"), connectionRevision: 1 };
    const after = await cache.get(afterKey);
    expect(after).not.toBe(before);
    expect(after.key.connectionRevision).toBe(1);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("失效前的成功响应不能回写或删除新请求", async () => {
    const old = deferred<SqlSchema>();
    const fresh = deferred<SqlSchema>();
    const loader = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    const cache = createSqlCompletionCache(loader, () => 0);
    const oldRequest = cache.get(key("app"));
    cache.invalidate({
      connId: "conn-1",
      database: "app",
      reason: "schema-change",
    });
    const freshRequest = cache.get(key("app"));
    old.resolve(schema("old"));
    expect((await oldRequest).schema.tables[0].name).toBe("old");
    expect(cache.peek(key("app"))).toBeUndefined();
    const joinedRequest = cache.get(key("app"));
    fresh.resolve(schema("fresh"));
    expect(await joinedRequest).toBe(await freshRequest);
    expect(cache.peek(key("app"))?.schema.tables[0].name).toBe("fresh");
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("失效前的失败仅清理自己的在途请求", async () => {
    const old = deferred<SqlSchema>();
    const fresh = deferred<SqlSchema>();
    const loader = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(fresh.promise);
    const cache = createSqlCompletionCache(loader, () => 0);
    const oldRequest = cache.get(key("app"));
    cache.invalidate({ connId: "conn-1", database: "app", reason: "refresh" });
    const freshRequest = cache.get(key("app"));
    old.reject(new Error("old failed"));
    await expect(oldRequest).rejects.toThrow("old failed");
    const joinedRequest = cache.get(key("app"));
    fresh.resolve(schema("fresh"));
    expect(await joinedRequest).toBe(await freshRequest);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("LRU 淘汰期间失效的在途响应不能回写", async () => {
    const old = deferred<SqlSchema>();
    let slowLoads = 0;
    const loader = vi.fn((requestKey: SqlCompletionCacheKey) =>
      requestKey.database === "slow" && slowLoads++ === 0
        ? old.promise
        : Promise.resolve(schema(requestKey.database ?? "list"))
    );
    const cache = createSqlCompletionCache(loader, () => 0);
    const oldRequest = cache.get(key("slow"));
    for (let i = 0; i < 8; i++) await cache.get(key(`db-${i}`));
    cache.invalidate({ connId: "conn-1", database: "slow", reason: "refresh" });
    const fresh = await cache.get(key("slow"));
    old.resolve(schema("old"));
    await oldRequest;
    expect(cache.peek(key("slow"))).toBe(fresh);
    expect(cache.peek(key("db-0"))).toBeUndefined();
  });

  it("一个 key 加载失败不清空另一个 key，失败 key 可重试", async () => {
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(schema("users"));
    const cache = createSqlCompletionCache(loader, () => 0);
    await expect(cache.get(key("bad"))).rejects.toThrow("offline");
    const good = await cache.get(key("good"));
    expect(cache.peek(key("good"))).toBe(good);
    await cache.get(key("bad"));
    expect(cache.peek(key("good"))).toBe(good);
  });

  it("连接断开提升 revision 并通知订阅者，退订后停止通知", () => {
    const connId = "revision-test";
    const before = getSqlCompletionConnectionRevision(connId);
    const listener = vi.fn();
    const unsubscribe = subscribeSqlCompletionInvalidation(listener);
    invalidateSqlCompletion({
      connId,
      database: "app",
      reason: "schema-change",
    });
    expect(getSqlCompletionConnectionRevision(connId)).toBe(before);
    invalidateSqlCompletion({ connId, reason: "disconnect" });
    expect(getSqlCompletionConnectionRevision(connId)).toBe(before + 1);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    invalidateSqlCompletion({ connId, reason: "disconnect" });
    expect(getSqlCompletionConnectionRevision(connId)).toBe(before + 2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("一个订阅者抛错不影响后续订阅者和断开流程", () => {
    const faulty = () => {
      throw new Error("listener failed");
    };
    const listener = vi.fn();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unsubscribeFaulty = subscribeSqlCompletionInvalidation(faulty);
    const unsubscribeListener = subscribeSqlCompletionInvalidation(listener);
    try {
      expect(() =>
        invalidateSqlCompletion({
          connId: "listener-error",
          reason: "disconnect",
        })
      ).not.toThrow();
      expect(listener).toHaveBeenCalledOnce();
    } finally {
      unsubscribeFaulty();
      unsubscribeListener();
      log.mockRestore();
    }
  });
});
