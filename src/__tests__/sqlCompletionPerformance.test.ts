import { describe, expect, it, vi } from "vitest";
import type { SqlSchema } from "../utils/sqlCompletion";
import type { SqlCompletionContext } from "../utils/sqlCompletionTypes";
import { createSqlCompletionCache } from "../utils/sqlCompletionCache";
import { generateSqlCompletionCandidates } from "../utils/sqlCompletionCandidates";
import { buildSqlMetadataIndex } from "../utils/sqlCompletionMetadataIndex";
import { completionKey } from "./fixtures/sqlCompletionFixtures";

function largeSchema(): SqlSchema {
  const tables = Array.from({ length: 1_000 }, (_, i) => ({
    name: `table_${i}`,
  }));
  return {
    databases: ["app"],
    tables,
    columns: tables.flatMap((table) =>
      Array.from({ length: 50 }, (_, i) => ({
        table: table.name,
        name: `column_${i}`,
        type: "int",
      }))
    ),
  };
}
function completionContext(relationCount = 1): SqlCompletionContext {
  return {
    dialect: "mysql",
    defaultNamespace: "app",
    statement: { start: 0, end: 30 },
    scopeId: "q",
    clause: "where",
    slot: "column",
    prefix: "col",
    qualifierParts: [],
    edit: { start: 27, end: 30 },
    confidence: "high",
    excludedColumns: [],
    scopes: [
      {
        id: "q",
        canCorrelate: false,
        projections: [],
        relations: Array.from({ length: relationCount }, (_, i) => ({
          id: `q:${i}`,
          kind: "table",
          name: "table_500",
          alias: `t${i}`,
        })),
      },
    ],
  };
}

describe("SQL 补全性能与访问范围", () => {
  it("50,000 列索引只读取当前作用域的 50 列，100 次热补全不增加请求", async () => {
    const schema = largeSchema();
    const loader = vi.fn(async () => schema);
    const cache = createSqlCompletionCache(loader, () => 0);
    const index = await cache.get(completionKey);
    expect(schema.columns).toHaveLength(50_000);
    Object.defineProperty(schema, "columns", {
      get() {
        throw new Error("热补全禁止重新扫描全库字段");
      },
    });
    for (const table of schema.tables) {
      if (table.name === "table_500") continue;
      index.columnsByTable.set(
        table.name,
        new Proxy([], {
          get() {
            throw new Error(`不应读取无关表 ${table.name}`);
          },
        })
      );
    }
    const readColumns = vi.spyOn(index.columnsByTable, "get");
    const durations: number[] = [];
    for (let i = 0; i < 100; i++) {
      const started = performance.now();
      const cached = await cache.get(completionKey);
      const items = generateSqlCompletionCandidates(
        completionContext(),
        cached
      );
      durations.push(performance.now() - started);
      expect(items.filter((item) => item.kind === "column")).toHaveLength(50);
    }
    expect(loader).toHaveBeenCalledTimes(1);
    expect(readColumns).toHaveBeenCalledTimes(100);
    expect(new Set(readColumns.mock.calls.map(([table]) => table))).toEqual(
      new Set(["table_500"])
    );
    const p95 = [...durations].sort((a, b) => a - b)[
      Math.ceil(durations.length * 0.95) - 1
    ];
    console.info(
      `SQL 热缓存候选生成 p95: ${p95.toFixed(3)}ms（调优目标 <50ms；不作为 CI 墙钟门禁）`
    );
  });

  it("100 个自关联身份均保留，同名字段插入对应别名", () => {
    const index = buildSqlMetadataIndex(largeSchema(), completionKey);
    const ctx = completionContext(100);
    const columns = generateSqlCompletionCandidates(ctx, index).filter(
      (item) => item.kind === "column"
    );
    expect(columns).toHaveLength(5_000);
    expect(new Set(columns.map((item) => item.sortText)).size).toBe(5_000);
    expect(
      new Set(
        columns
          .filter((item) => item.filterText === "column_0")
          .map((item) => item.insertText)
      )
    ).toEqual(
      new Set(Array.from({ length: 100 }, (_, i) => `\`t${i}\`.\`column_0\``))
    );
    expect(
      columns.every((item) => /^`t\d+`\.`column_\d+`$/.test(item.insertText))
    ).toBe(true);
  });
});
