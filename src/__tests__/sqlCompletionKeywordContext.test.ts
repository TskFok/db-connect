import { describe, expect, it } from "vitest";
import type { SqlDialect } from "../utils/sqlCompletion";
import { getSqlQueryPrefixKeywords } from "../utils/sqlCompletionKeywordContext";
import { tokenizeSql } from "../utils/sqlCompletionTokenizer";

function keywords(sql: string, dialect: SqlDialect = "postgres") {
  return getSqlQueryPrefixKeywords(tokenizeSql(sql, dialect), dialect);
}

const postgresWhenKeywords = [
  "THEN",
  "=",
  "<>",
  "<",
  ">",
  "<=",
  ">=",
  "IN",
  "NOT IN",
  "LIKE",
  "IS NULL",
  "IS NOT NULL",
  "BETWEEN",
  "AND",
  "OR",
  "ILIKE",
];

describe("查询中的局部关键词上下文", () => {
  it.each<SqlDialect>([
    "postgres",
    "mysql",
    "sqlite",
    "sqlserver",
    "clickhouse",
  ])("%s CASE 条件完成后同时保留运算词和 THEN", (dialect) => {
    for (const sql of ["SELECT CASE WHEN id = 1", "SELECT CASE WHEN id"]) {
      const result = keywords(sql, dialect);
      expect(result).toEqual(
        expect.arrayContaining(["THEN", "AND", "OR", "LIKE", "IN", "IS NULL"])
      );
      expect(result).not.toContain("FROM");
      expect(result).not.toContain("UNION");
      expect(result?.includes("ILIKE")).toBe(dialect === "postgres");
    }
  });

  it.each([
    "SELECT * FROM t WHERE id BETWEEN 1",
    "SELECT * FROM t WHERE id NOT BETWEEN 1",
    "SELECT * FROM t WHERE id BETWEEN coalesce(a, 1)",
    "SELECT * FROM t WHERE id BETWEEN 1 AND 2 AND x BETWEEN 3",
    "SELECT CASE WHEN id BETWEEN 1",
  ])("%s 的 BETWEEN 下界后仅续写 AND", (sql) => {
    expect(keywords(sql)).toEqual(["AND"]);
  });

  it.each([
    "SELECT CASE WHEN id THEN",
    "SELECT CASE WHEN id THEN value ELSE",
    "SELECT CASE WHEN id THEN coalesce(",
    "SELECT * FROM t WHERE id BETWEEN",
    "SELECT * FROM t WHERE id BETWEEN 1 +",
    "SELECT * FROM t WHERE id BETWEEN 1 AND",
    "SELECT f(id BETWEEN 1",
  ])("%s 保持未完成值表达式的名称补全", (sql) => {
    expect(keywords(sql)).toBeUndefined();
  });
  it.each([
    ["SELECT CASE", ["WHEN"]],
    ["SELECT CASE status", ["WHEN"]],
    ["SELECT CASE WHEN status = 1", postgresWhenKeywords],
    ["SELECT CASE WHEN status IS NOT NULL", postgresWhenKeywords],
    ["SELECT CASE WHEN status BETWEEN 1 AND 5", postgresWhenKeywords],
    ["SELECT CASE WHEN status = 1 THEN 'yes'", ["WHEN", "ELSE", "END"]],
    ["SELECT CASE WHEN status = 1 THEN NULL", ["WHEN", "ELSE", "END"]],
    ["SELECT CASE WHEN status = 1 THEN 2 ELSE 3", ["END"]],
    ["SELECT CASE WHEN a THEN CASE", ["WHEN"]],
    ["SELECT CASE WHEN a THEN CASE WHEN b THEN 1 END", ["WHEN", "ELSE", "END"]],
    ["SELECT CASE WHEN CASE WHEN a THEN 1 END = 1", postgresWhenKeywords],
    ["SELECT coalesce(CASE WHEN a THEN 1", ["WHEN", "ELSE", "END"]],
    ["SELECT CASE WHEN coalesce(a, 0) = 1", postgresWhenKeywords],
    ['SELECT CASE WHEN "END" = 1 THEN "WHEN"', ["WHEN", "ELSE", "END"]],
    ["SELECT CASE /* THEN */ WHEN a THEN 'ELSE'", ["WHEN", "ELSE", "END"]],
  ])("%s 续写 CASE 关键词", (sql, expected) => {
    expect(keywords(sql)).toEqual(expected);
  });

  it.each([
    "SELECT CASE WHEN",
    "SELECT CASE a +",
    "SELECT CASE WHEN a =",
    "SELECT CASE WHEN a BETWEEN 1 AND",
    "SELECT CASE WHEN a IS NOT",
    "SELECT CASE WHEN a THEN",
    "SELECT CASE WHEN a THEN b +",
    "SELECT CASE WHEN a THEN b.",
    "SELECT CASE WHEN a THEN coalesce(",
    "SELECT CASE WHEN a THEN b ELSE",
    "SELECT CASE WHEN a THEN b ELSE c +",
    "SELECT CASE WHEN a THEN 1 END",
    "SELECT coalesce(",
    "SELECT coalesce(a, GROUP",
    "SELECT LEFT(name, 1)",
    "SELECT RIGHT(name, 1)",
    "SELECT f(GROUP)",
    'SELECT "GROUP"',
    "SELECT 'GROUP'",
    "SELECT t.GROUP",
    "SELECT CASE WHEN a THEN 'unfinished",
    'SELECT CASE WHEN a THEN "unfinished',
  ])("%s 保留表达式或原有上下文", (sql) => {
    expect(keywords(sql)).toBeUndefined();
  });

  it.each([
    ["SELECT a FROM t GROUP", ["BY"]],
    ["SELECT a FROM t ORDER", ["BY"]],
    ["SELECT a FROM t LEFT", ["JOIN", "OUTER JOIN"]],
    ["SELECT a FROM t RIGHT", ["JOIN", "OUTER JOIN"]],
    ["SELECT a FROM t FULL", ["JOIN", "OUTER JOIN"]],
    ["SELECT a FROM t LEFT OUTER", ["JOIN"]],
    ["SELECT a FROM t RIGHT OUTER", ["JOIN"]],
    ["SELECT a FROM t FULL OUTER", ["JOIN"]],
    ["SELECT a FROM t INNER", ["JOIN"]],
    ["SELECT a FROM t CROSS", ["JOIN"]],
    ["SELECT a FROM t UNION", ["SELECT", "ALL SELECT"]],
    ["SELECT a FROM t UNION ALL", ["SELECT"]],
    ["SELECT a FROM t UNION DISTINCT", ["SELECT"]],
    ["SELECT a FROM t INTERSECT", ["SELECT"]],
    ["SELECT a FROM t EXCEPT", ["SELECT"]],
  ])("%s 仅提供当前复合关键词的后半部分", (sql, expected) => {
    expect(keywords(sql)).toEqual(expected);
  });

  it("MySQL 不续写 FULL JOIN", () => {
    expect(keywords("SELECT a FROM t FULL", "mysql")).toEqual([]);
  });

  it.each([
    "SELECT a FROM t GROUP BY",
    "SELECT a FROM t ORDER BY",
    "SELECT a FROM t LEFT JOIN",
    "SELECT a FROM t LEFT OUTER JOIN",
    "SELECT a FROM t UNION SELECT",
    "SELECT a FROM t UNION ALL SELECT",
    "SELECT a FROM t WHERE",
    "SELECT a FROM t WHERE a =",
    "SELECT a FROM t WHERE a = 1",
  ])("%s 完成复合词后交回列和表补全", (sql) => {
    expect(keywords(sql)).toBeUndefined();
  });

  it.each<SqlDialect>(["postgres", "mysql", "sqlite", "clickhouse"])(
    "%s LIMIT 数值后仅续写 OFFSET，完成后不回退",
    (dialect) => {
      expect(keywords("SELECT a FROM t LIMIT 10", dialect)).toEqual(["OFFSET"]);
      expect(keywords("SELECT a FROM t LIMIT", dialect)).toEqual([]);
      expect(keywords("SELECT a FROM t LIMIT 10 OFFSET", dialect)).toEqual([]);
      const expected = dialect === "postgres" ? ["ROWS"] : [];
      expect(keywords("SELECT a FROM t LIMIT 10 OFFSET 5", dialect)).toEqual(
        expected
      );
    }
  );

  it.each<SqlDialect>(["postgres", "sqlserver"])(
    "%s OFFSET/FETCH 逐词续写",
    (dialect) => {
      expect(keywords("SELECT a FROM t ORDER BY a OFFSET 5", dialect)).toEqual([
        "ROWS",
      ]);
      expect(
        keywords("SELECT a FROM t ORDER BY a OFFSET 5 ROWS", dialect)
      ).toEqual(["FETCH NEXT", "FETCH FIRST"]);
      expect(
        keywords("SELECT a FROM t ORDER BY a OFFSET 5 ROWS FETCH", dialect)
      ).toEqual(["NEXT", "FIRST"]);
      expect(
        keywords("SELECT a FROM t ORDER BY a OFFSET 5 ROWS FETCH NEXT", dialect)
      ).toEqual([]);
      expect(
        keywords(
          "SELECT a FROM t ORDER BY a OFFSET 5 ROWS FETCH NEXT 10",
          dialect
        )
      ).toEqual(["ROWS ONLY"]);
      expect(
        keywords(
          "SELECT a FROM t ORDER BY a OFFSET 5 ROWS FETCH NEXT 10 ROWS",
          dialect
        )
      ).toEqual(["ONLY"]);
      expect(
        keywords(
          "SELECT a FROM t ORDER BY a OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY",
          dialect
        )
      ).toEqual([]);
    }
  );

  it.each([
    "SELECT a FROM t LIMIT 5, 10",
    "SELECT a FROM t LIMIT 10 +",
    "SELECT a FROM t LIMIT 10 + 5",
    "SELECT a FROM t OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY",
  ])("%s 无法确认或已完成的分页不泄露普通子句候选", (sql) => {
    expect(keywords(sql, "mysql")).toEqual([]);
  });

  it("函数、引用名称和字符串中的分页词不触发续写", () => {
    expect(keywords("SELECT f(LIMIT 5")).toBeUndefined();
    expect(keywords('SELECT "LIMIT", 5')).toBeUndefined();
    expect(keywords("SELECT 'LIMIT', 5")).toBeUndefined();
    expect(keywords("SELECT t.LIMIT, 5")).toBeUndefined();
  });
});
