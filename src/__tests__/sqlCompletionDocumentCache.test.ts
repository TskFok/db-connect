import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqlCompletionDocumentCache } from "../utils/sqlCompletionDocumentCache";
import * as tokenizer from "../utils/sqlCompletionTokenizer";
import * as parser from "../utils/sqlCompletionScopeParser";
import type { SqlDialect } from "../utils/sqlCompletion";

function verify(
  text: string,
  cache: ReturnType<typeof createSqlCompletionDocumentCache>,
  dialect: SqlDialect
) {
  const all = tokenizer.tokenizeSql(text, dialect);
  for (let offset = 0; offset <= text.length; offset++) {
    const statement = tokenizer.findSqlStatement(all, offset, text.length);
    const tokens = all.filter(
      (t) => t.start >= statement.start && t.end <= statement.end
    );
    expect(cache.getStatement(offset)).toEqual({
      statement,
      tokens,
      blocks: parser.parseSqlQueryBlocksFromTokens(tokens, statement, dialect),
    });
  }
}

describe("SQL completion document cache", () => {
  afterEach(() => vi.restoreAllMocks());
  it("preserves lone UTF-16 surrogates while owning cached token text", () => {
    const text = "SELECT '\ud800😀\udfff'; SELECT 2";
    const cache = createSqlCompletionDocumentCache(text, 1, "postgres");
    verify(text, cache, "postgres");
    const offset = text.indexOf("😀") + 1;
    expect(
      cache.applyChanges([{ rangeOffset: offset, rangeLength: 1, text: "" }], 2)
    ).toBe(true);
    verify(text.slice(0, offset) + text.slice(offset + 1), cache, "postgres");
  });
  it.each([
    {
      dialect: "postgres" as const,
      text: "SELECT /* outer /* inner */ still comment */ id; SELECT 2",
      needle: "*/ id",
      replacement: "id",
    },
    {
      dialect: "postgres" as const,
      text: "SELECT $tag$first;\nsecond$tag$; SELECT 2",
      needle: "$tag$;",
      replacement: ";",
    },
    {
      dialect: "mysql" as const,
      text: "SELECT 'first\nsecond\\\"'; SELECT 2",
      needle: "';",
      replacement: ";",
    },
    {
      dialect: "mysql" as const,
      text: "SELECT 1 -- comment;\n; SELECT 2",
      needle: "-- ",
      replacement: "--x",
    },
  ])(
    "rescans unclosed lexical regions through the end ($dialect)",
    ({ dialect, text, needle, replacement }) => {
      const cache = createSqlCompletionDocumentCache(text, 1, dialect);
      const offset = text.indexOf(needle);
      cache.applyChanges(
        [
          {
            rangeOffset: offset,
            rangeLength: needle.length,
            text: replacement,
          },
        ],
        2
      );
      verify(
        text.slice(0, offset) +
          replacement +
          text.slice(offset + needle.length),
        cache,
        dialect
      );
      cache.applyChanges(
        [
          {
            rangeOffset: offset,
            rangeLength: replacement.length,
            text: needle,
          },
        ],
        3
      );
      verify(text, cache, dialect);
    }
  );
  it.each([
    "mysql",
    "postgres",
    "sqlserver",
    "sqlite",
    "clickhouse",
  ] as SqlDialect[])(
    "matches full parsing after lexical edits for %s",
    (dialect) => {
      let text =
        "SELECT '中文😀'; SELECT x FROM users;\nGO\nSELECT $tag$a;b$tag$; SELECT 2; GO\nSELECT 3";
      const cache = createSqlCompletionDocumentCache(text, 1, dialect);
      verify(text, cache, dialect);
      const edits = [
        { rangeOffset: 8, rangeLength: 0, text: "'" },
        { rangeOffset: 8, rangeLength: 1, text: "" },
        { rangeOffset: 0, rangeLength: 0, text: "/* outer /* inner */" },
        { rangeOffset: 0, rangeLength: 20, text: "" },
        { rangeOffset: 5, rangeLength: 0, text: "-- x\n'跨\n行\\';" },
      ];
      let version = 1;
      for (const edit of edits) {
        text =
          text.slice(0, edit.rangeOffset) +
          edit.text +
          text.slice(edit.rangeOffset + edit.rangeLength);
        expect(cache.applyChanges([edit], ++version)).toBe(true);
        verify(text, cache, dialect);
      }
    }
  );
  it.each([
    "mysql",
    "postgres",
    "sqlserver",
    "sqlite",
    "clickhouse",
  ] as SqlDialect[])(
    "matches deterministic editing histories for %s",
    (dialect) => {
      let text =
        "WITH c AS (SELECT '😀' AS 中文) SELECT * FROM c; SELECT 2;\nGO\nSELECT 3";
      const cache = createSqlCompletionDocumentCache(text, 1, dialect);
      const inserts = [
        ";",
        "'",
        '"',
        "/*",
        "*/",
        "--",
        " ",
        "\n",
        "$tag$",
        "中文",
        "😀",
        "\\",
        "GO",
        "[",
        "]",
        "`",
      ];
      let seed = 727;
      const random = (max: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % max;
      };
      for (let version = 2; version <= 45; version++) {
        const offset = random(text.length + 1);
        const length = Math.min(random(4), text.length - offset);
        const inserted = inserts[random(inserts.length)];
        expect(
          cache.applyChanges(
            [{ rangeOffset: offset, rangeLength: length, text: inserted }],
            version
          )
        ).toBe(true);
        text = text.slice(0, offset) + inserted + text.slice(offset + length);
        verify(text, cache, dialect);
      }
    }
  );
  it("preserves GO boundaries when edits alter its trailing line or follow a semicolon", () => {
    for (const initial of [
      "SELECT 1; GO\nSELECT 2",
      "SELECT 1\nGO\nSELECT 2",
      "GO  \r\nSELECT 3",
    ]) {
      for (let offset = 0; offset <= initial.length; offset++) {
        for (const inserted of ["x", ";", "\n", "", "'", "/*"]) {
          const cache = createSqlCompletionDocumentCache(
            initial,
            1,
            "sqlserver"
          );
          const length = offset < initial.length ? 1 : 0;
          cache.applyChanges(
            [{ rangeOffset: offset, rangeLength: length, text: inserted }],
            2
          );
          verify(
            initial.slice(0, offset) +
              inserted +
              initial.slice(offset + length),
            cache,
            "sqlserver"
          );
        }
      }
    }
  });
  it("reuses shifted query syntax and stops scanning at an aligned suffix", () => {
    const initial =
      "SELECT a; WITH c AS (SELECT id FROM users) SELECT c.id FROM c; SELECT z";
    const cache = createSqlCompletionDocumentCache(initial, 1, "postgres");
    cache.getStatement(initial.indexOf("WITH"));
    const parse = vi.spyOn(parser, "parseSqlQueryBlocksFromTokens");
    const original = tokenizer.scanSqlTokens;
    const scan = vi.spyOn(tokenizer, "scanSqlTokens");
    const emitted: number[] = [];
    scan.mockImplementation((text, dialect, start, callback) =>
      original(text, dialect, start, (token) => {
        emitted.push(token.end);
        return callback(token);
      })
    );
    cache.applyChanges(
      [{ rangeOffset: 7, rangeLength: 1, text: "long_column" }],
      2
    );
    expect(Math.max(...emitted)).toBe(initial.indexOf(";") + 1 + 10);
    const text = initial.slice(0, 7) + "long_column" + initial.slice(8);
    const offset = text.indexOf("WITH");
    const statement = tokenizer.findSqlStatement(
      tokenizer.tokenizeSql(text, "postgres"),
      offset,
      text.length
    );
    const expected = parser.parseSqlQueryBlocks(text, statement, "postgres");
    parse.mockClear();
    expect(cache.getStatement(offset).blocks).toEqual(expected);
    expect(parse).not.toHaveBeenCalled();
    scan.mockRestore();
    parse.mockRestore();
  });
  it("handles simultaneous old-coordinate edits, splits, merges and undo", () => {
    let text = "SELECT a; SELECT b; SELECT c";
    const cache = createSqlCompletionDocumentCache(text, 1, "postgres");
    const edits = [
      { rangeOffset: 8, rangeLength: 1, text: "" },
      { rangeOffset: 25, rangeLength: 1, text: ";中文😀" },
    ];
    expect(cache.applyChanges(edits, 2)).toBe(true);
    for (const e of [...edits].reverse())
      text =
        text.slice(0, e.rangeOffset) +
        e.text +
        text.slice(e.rangeOffset + e.rangeLength);
    verify(text, cache, "postgres");
    cache.reset("SELECT a; SELECT b; SELECT c", 3, "postgres");
    verify("SELECT a; SELECT b; SELECT c", cache, "postgres");
    expect(
      cache.applyChanges([{ rangeOffset: 999, rangeLength: 0, text: "x" }], 4)
    ).toBe(false);
    expect(cache.applyChanges([], 5)).toBe(false);
    expect(
      cache.applyChanges(
        [
          { rangeOffset: 1, rangeLength: 4, text: "" },
          { rangeOffset: 2, rangeLength: 0, text: "x" },
        ],
        4
      )
    ).toBe(false);
    cache.dispose();
    expect(() => cache.getStatement(0)).toThrow();
  });
  it("rescans only the final statements of a 1MiB document", () => {
    const text =
      "SELECT abcdefghijklmnopqrstuvwxyz FROM historical_tbl;".repeat(19783) +
      "SELECT tail";
    const cache = createSqlCompletionDocumentCache(text, 1, "postgres");
    const scan = vi.spyOn(tokenizer, "scanSqlTokens");
    cache.applyChanges(
      [{ rangeOffset: text.length, rangeLength: 0, text: "x" }],
      2
    );
    expect(scan).toHaveBeenCalledTimes(1);
    expect(scan.mock.calls[0][2]).toBe(text.length - "SELECT tail".length);
    const tokens = cache.getStatement(text.length + 1).tokens;
    expect(tokens[tokens.length - 1]?.text).toBe("tailx");
    scan.mockRestore();
  });
  it("keeps at most 32 parsed statements and reuses unaffected syntax", () => {
    const text = Array.from({ length: 34 }, (_, i) => `SELECT c${i};`).join("");
    const cache = createSqlCompletionDocumentCache(text, 1, "postgres");
    const parse = vi.spyOn(parser, "parseSqlQueryBlocksFromTokens");
    for (let i = 0; i < 34; i++)
      cache.getStatement(text.indexOf(`SELECT c${i};`));
    expect(parse).toHaveBeenCalledTimes(34);
    cache.getStatement(0);
    expect(parse).toHaveBeenCalledTimes(35);
    cache.applyChanges(
      [{ rangeOffset: text.length, rangeLength: 0, text: "SELECT z" }],
      2
    );
    cache.getStatement(0);
    expect(parse).toHaveBeenCalledTimes(35);
    cache.reset(text, 3, "postgres");
    cache.getStatement(0);
    expect(parse).toHaveBeenCalledTimes(36);
    parse.mockRestore();
  });
});
