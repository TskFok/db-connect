import { describe, expect, it, vi } from "vitest";
import type { SqlCompletionForeignKeyResult } from "../types";
import { createSqlCompletionForeignKeyCache } from "../utils/sqlCompletionForeignKeyCache";

const key = {
  connId: "c1",
  database: "sales",
  dialect: "postgres" as const,
  connectionRevision: 0,
};
const ready: SqlCompletionForeignKeyResult = {
  status: "ready",
  foreignKeys: [],
};
function setup() {
  let time = 0;
  const source = {
    getSqlCompletionForeignKeys: vi.fn().mockResolvedValue(ready),
  };
  const cache = createSqlCompletionForeignKeyCache(source, () => time);
  return {
    cache,
    source,
    setTime: (value: number) => {
      time = value;
    },
  };
}

describe("SQL 补全外键快照", () => {
  it("相同键在途请求合并，四字段不同则独立加载", async () => {
    const { cache, source } = setup();
    await Promise.all([cache.get(key), cache.get(key)]);
    expect(source.getSqlCompletionForeignKeys).toHaveBeenCalledTimes(1);
    for (const next of [
      { ...key, database: "auth" },
      { ...key, connectionRevision: 1 },
      { ...key, connId: "c2" },
      { ...key, dialect: "mysql" as const },
    ])
      await cache.get(next);
    expect(source.getSqlCompletionForeignKeys).toHaveBeenCalledTimes(5);
    expect(source.getSqlCompletionForeignKeys).toHaveBeenCalledWith(
      "c1",
      "sales"
    );
  });

  it("59 秒命中，60 秒失效并重载", async () => {
    const { cache, source, setTime } = setup();
    await cache.get(key);
    setTime(59_000);
    expect(cache.peek(key)).toEqual(ready);
    await cache.get(key);
    expect(source.getSqlCompletionForeignKeys).toHaveBeenCalledTimes(1);
    setTime(60_000);
    expect(cache.peek(key)).toBeUndefined();
    await cache.get(key);
    expect(source.getSqlCompletionForeignKeys).toHaveBeenCalledTimes(2);
  });

  it("最多保留八个已完成项，读取会更新 LRU 顺序", async () => {
    const { cache } = setup();
    const keys = Array.from({ length: 9 }, (_, n) => ({
      ...key,
      database: `db${n}`,
    }));
    for (const next of keys.slice(0, 8)) await cache.get(next);
    cache.peek(keys[0]);
    await cache.get(keys[8]);
    expect(cache.peek(keys[1])).toBeUndefined();
    expect(cache.peek(keys[0])).toEqual(ready);
    expect(cache.peek(keys[8])).toEqual(ready);
  });

  it("失效前的慢请求不能覆盖同键的新快照", async () => {
    const { cache, source } = setup();
    let resolve!: (value: SqlCompletionForeignKeyResult) => void;
    source.getSqlCompletionForeignKeys.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      })
    );
    const first = cache.get(key);
    const second = cache.get(key);
    expect(source.getSqlCompletionForeignKeys).toHaveBeenCalledTimes(1);
    cache.invalidate({
      connId: "c1",
      database: "sales",
      reason: "schema-change",
    });
    await cache.get(key);
    resolve({ status: "unsupported", foreignKeys: [] });
    await Promise.all([first, second]);
    expect(cache.peek(key)).toEqual(ready);
    expect(source.getSqlCompletionForeignKeys).toHaveBeenCalledTimes(2);
  });

  it("unsupported 可缓存，失败不缓存且可重试", async () => {
    const { cache, source } = setup();
    source.getSqlCompletionForeignKeys.mockRejectedValueOnce(
      new Error("denied")
    );
    await expect(cache.get(key)).rejects.toThrow("denied");
    expect(cache.peek(key)).toBeUndefined();
    source.getSqlCompletionForeignKeys.mockResolvedValue({
      status: "unsupported",
      foreignKeys: [],
    });
    await cache.get(key);
    expect(cache.peek(key)).toEqual({ status: "unsupported", foreignKeys: [] });
    await cache.get(key);
    expect(source.getSqlCompletionForeignKeys).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      { connId: "c1", database: "sales", reason: "refresh" as const },
      [false, true, true],
    ],
    [
      { connId: "c1", database: null, reason: "refresh" as const },
      [true, true, false],
    ],
    [{ connId: "c1", reason: "refresh" as const }, [false, false, false]],
    [
      { connId: "c1", database: "sales", reason: "schema-change" as const },
      [false, false, false],
    ],
    [
      { connId: "c1", database: "sales", reason: "disconnect" as const },
      [false, false, false],
    ],
  ])(
    "按失效事件清理 namespace，schema-change 覆盖跨 schema 关系 %j",
    async (event, expected) => {
      const { cache } = setup();
      const keys = [
        key,
        { ...key, database: "auth" },
        { ...key, database: null },
      ];
      await Promise.all(keys.map((k) => cache.get(k)));
      await cache.get({ ...key, connId: "c2" });
      cache.invalidate(event);
      expect(keys.map((k) => !!cache.peek(k))).toEqual(expected);
      expect(cache.peek({ ...key, connId: "c2" })).toEqual(ready);
    }
  );
});
