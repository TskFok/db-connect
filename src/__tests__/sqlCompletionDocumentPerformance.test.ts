import { describe, expect, it, vi } from "vitest";
import { createSqlCompletionDocumentCache } from "../utils/sqlCompletionDocumentCache";
import { analyzeSqlCompletionTokens } from "../utils/sqlCompletionContext";
import { resolveSqlCompletionScopes } from "../utils/sqlCompletionScopes";
import { generateSqlCompletionCandidates } from "../utils/sqlCompletionCandidates";
import { buildSqlMetadataIndex } from "../utils/sqlCompletionMetadataIndex";
import { createSqlCompletionCache } from "../utils/sqlCompletionCache";
import * as tokenizer from "../utils/sqlCompletionTokenizer";
import { completionKey } from "./fixtures/sqlCompletionFixtures";
import {
  completionDocument,
  completionLargeSchema,
  documentSizes,
} from "./fixtures/sqlCompletionDocumentFixtures";

const index = buildSqlMetadataIndex(completionLargeSchema(), completionKey);
function complete(
  cache: ReturnType<typeof createSqlCompletionDocumentCache>,
  offset: number
) {
  const syntax = cache.getStatement(offset);
  const context = analyzeSqlCompletionTokens({
    ...syntax,
    offset,
    dialect: completionKey.dialect,
  });
  return (
    generateSqlCompletionCandidates(
      resolveSqlCompletionScopes({ syntax, offset, context, index }),
      index
    )
      // sortText 的末段是源码坐标身份，不同历史前缀下只比较候选内容和排序结果。
      .map(({ label, kind, insertText, filterText, detail }) => ({
        label,
        kind,
        insertText,
        filterText,
        detail,
      }))
  );
}

describe("长文档补全确定性工作量", () => {
  it("49B/100KiB/1MiB 候选等价，同版本零额外扫描，末尾编辑不扫描历史前缀", () => {
    const scan = vi.spyOn(tokenizer, "scanSqlTokens");
    const tokenize = vi.spyOn(tokenizer, "tokenizeSql");
    let expected: ReturnType<typeof complete> | undefined;
    try {
      for (const size of documentSizes) {
        const sql = completionDocument(size);
        expect(sql.length).toBe(size);
        const cache = createSqlCompletionDocumentCache(
          sql,
          1,
          completionKey.dialect
        );
        const items = complete(cache, size);
        expect(items).toHaveLength(50);
        if (expected) expect(items).toEqual(expected);
        else expected = items;
        scan.mockClear();
        tokenize.mockClear();
        for (let i = 0; i < 100; i++)
          expect(complete(cache, size)).toEqual(items);
        expect(scan).not.toHaveBeenCalled();
        expect(tokenize).not.toHaveBeenCalled();
        expect(
          cache.applyChanges(
            [{ rangeOffset: size, rangeLength: 0, text: "u" }],
            2
          )
        ).toBe(true);
        expect(complete(cache, size + 1)).toEqual(items);
        expect(scan).toHaveBeenCalled();
        // 仅最后一条语句（含补齐空白）可以重新扫描。
        expect(
          scan.mock.calls.every(
            ([, , start]) => start >= Math.max(0, size - 110)
          )
        ).toBe(true);
        expect(tokenize).not.toHaveBeenCalled();
        cache.dispose();
      }
    } finally {
      scan.mockRestore();
      tokenize.mockRestore();
    }
  });

  it("完整计算链的 100 次热补全仍只有一次元数据加载", async () => {
    const loader = vi.fn(async () => completionLargeSchema());
    const metadata = createSqlCompletionCache(loader, () => 0);
    await metadata.get(completionKey);
    const sql = completionDocument(1024 * 1024);
    const cache = createSqlCompletionDocumentCache(
      sql,
      1,
      completionKey.dialect
    );
    for (let i = 0; i < 100; i++) {
      const latest = await metadata.get(completionKey);
      const syntax = cache.getStatement(sql.length);
      const context = analyzeSqlCompletionTokens({
        ...syntax,
        offset: sql.length,
        dialect: completionKey.dialect,
      });
      const scoped = resolveSqlCompletionScopes({
        syntax,
        context,
        offset: sql.length,
        index: latest,
      });
      expect(generateSqlCompletionCandidates(scoped, latest)).toHaveLength(50);
    }
    expect(loader).toHaveBeenCalledTimes(1);
    cache.dispose();
  });

  it("记录冷初始化、热补全、含缓存更新的末尾编辑 p50/p95，不设墙钟门禁", () => {
    const measurements: object[] = [];
    const measure = (operation: () => void) => {
      for (let i = 0; i < 5; i++) operation();
      const durations: number[] = [];
      for (let i = 0; i < 20; i++) {
        const started = performance.now();
        operation();
        durations.push(performance.now() - started);
      }
      const sorted = [...durations].sort((a, b) => a - b);
      return { p50: sorted[9], p95: sorted[18] };
    };
    for (const size of documentSizes) {
      const sql = completionDocument(size);
      let count = 0;
      const cold = measure(() => {
        const cache = createSqlCompletionDocumentCache(
          sql,
          1,
          completionKey.dialect
        );
        count = complete(cache, size).length;
        cache.dispose();
      });
      const cache = createSqlCompletionDocumentCache(
        sql,
        1,
        completionKey.dialect
      );
      const hot = measure(() => {
        count = complete(cache, size).length;
      });
      let version = 1;
      let appended = false;
      const edit = measure(() => {
        cache.applyChanges(
          [
            {
              rangeOffset: size,
              rangeLength: appended ? 1 : 0,
              text: appended ? "" : "u",
            },
          ],
          ++version
        );
        appended = !appended;
        count = complete(cache, size + Number(appended)).length;
      });
      expect(count).toBe(50);
      cache.dispose();
      measurements.push({ bytes: size, candidates: count, cold, hot, edit });
    }
    console.info(
      JSON.stringify({
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        warmups: 5,
        samples: 20,
        measurements,
      })
    );
  });
});
