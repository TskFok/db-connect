import { describe, expect, it } from "vitest";
import { findSqlStatement, tokenizeSql } from "../utils/sqlCompletionTokenizer";

describe("SQL completion tokenizer", () => {
  it("preserves statement whitespace and ignores quoted semicolons", () => {
    const sql = "SELECT 'a;b'; SELECT * FROM users WHERE ";
    expect(
      findSqlStatement(tokenizeSql(sql, "mysql"), sql.length, sql.length)
    ).toEqual({ start: sql.indexOf(" SELECT *"), end: sql.length });
    expect(
      tokenizeSql('SELECT "user;name" FROM users', "postgres").filter(
        (t) => t.text === ";"
      )
    ).toHaveLength(0);
    expect(
      tokenizeSql("SELECT $$a;b$$; SELECT 1", "postgres").filter(
        (t) => t.text === ";"
      )
    ).toHaveLength(1);
  });
  it("keeps escaped, incomplete and Unicode tokens at UTF-16 offsets", () => {
    const sql = "SELECT 'it''s😀'; `a``b` [a]]b] 中文";
    for (const token of tokenizeSql(sql, "sqlserver"))
      expect(sql.slice(token.start, token.end)).toBe(token.text);
    expect(tokenizeSql("`a``b", "mysql")[0]).toMatchObject({
      kind: "identifier",
      quoted: true,
      end: 5,
    });
    expect(tokenizeSql("[a]]b]", "sqlserver")[0]).toMatchObject({
      kind: "identifier",
      text: "[a]]b]",
    });
    expect(tokenizeSql("'unfinished", "postgres")[0].kind).toBe("string");
    expect(tokenizeSql("/* unfinished", "mysql")[0].kind).toBe("comment");
    expect(tokenizeSql("", "mysql")).toEqual([]);
    expect(findSqlStatement([], 0, 0)).toEqual({ start: 0, end: 0 });
  });
  it("recognizes dialect-specific comments and dollar strings", () => {
    expect(
      tokenizeSql("--x\r\n# y", "mysql")
        .filter((t) => t.kind === "comment")
        .map((t) => t.text)
    ).toEqual(["# y"]);
    expect(tokenizeSql("-- x\r\nSELECT 1", "mysql")[0].kind).toBe("comment");
    expect(tokenizeSql("# x", "postgres")[0].kind).not.toBe("comment");
    expect(
      tokenizeSql("$tag$a;😀$tag$;", "postgres").map((t) => t.kind)
    ).toEqual(["string", "punctuation"]);
    expect(tokenizeSql('"users"', "mysql")[0].kind).toBe("string");
  });
  it("treats standalone SQL Server GO as a batch boundary", () => {
    const sql = "SELECT 'GO'\r\nGO\r\n SELECT * FROM orders";
    const tokens = tokenizeSql(sql, "sqlserver");
    expect(findSqlStatement(tokens, sql.length, sql.length).start).toBe(
      sql.indexOf("\r\n SELECT")
    );
    expect(
      tokenizeSql("SELECT go FROM go", "sqlserver").filter(
        (t) => t.kind === "punctuation" && t.text.toUpperCase() === "GO"
      )
    ).toHaveLength(0);
    const semi = "SELECT 1; SELECT 2";
    expect(
      findSqlStatement(tokenizeSql(semi, "mysql"), 9, semi.length).start
    ).toBe(9);
  });
});
