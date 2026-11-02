import { describe, expect, it } from "vitest";
import type { SqlDialect } from "../utils/sqlCompletion";
import {
  getSqlStatementStartKeywords,
  getSqlStatementPrefixKeywords,
} from "../utils/sqlCompletionStatementKeywords";
import { tokenizeSql } from "../utils/sqlCompletionTokenizer";

function prefix(sql: string, dialect: SqlDialect = "mysql", following = false) {
  return getSqlStatementPrefixKeywords(
    tokenizeSql(sql, dialect),
    dialect,
    following
  );
}

describe("语句入口与受控前缀关键词", () => {
  it.each<SqlDialect>([
    "mysql",
    "postgres",
    "sqlite",
    "sqlserver",
    "clickhouse",
  ])("%s 提供常用 DDL 和 CTE 入口", (dialect) => {
    expect(getSqlStatementStartKeywords(dialect)).toEqual(
      expect.arrayContaining([
        "CREATE",
        "CREATE TABLE",
        "ALTER TABLE",
        "DROP TABLE",
        "WITH",
      ])
    );
  });

  it("隔离各方言的语句入口", () => {
    expect(getSqlStatementStartKeywords("sqlite")).toEqual(
      expect.arrayContaining([
        "PRAGMA",
        "REPLACE INTO",
        "ATTACH DATABASE",
        "VACUUM",
      ])
    );
    expect(getSqlStatementStartKeywords("sqlite")).not.toContain(
      "TRUNCATE TABLE"
    );
    expect(getSqlStatementStartKeywords("postgres")).toContain(
      "CREATE MATERIALIZED VIEW"
    );
    expect(getSqlStatementStartKeywords("postgres")).not.toContain(
      "REPLACE INTO"
    );
    expect(getSqlStatementStartKeywords("sqlserver")).toContain("MERGE INTO");
    expect(getSqlStatementStartKeywords("sqlserver")).not.toContain("EXPLAIN");
    expect(getSqlStatementStartKeywords("clickhouse")).toContain(
      "OPTIMIZE TABLE"
    );
    expect(getSqlStatementStartKeywords("clickhouse")).not.toContain("BEGIN");
    expect(getSqlStatementStartKeywords("clickhouse")).not.toContain(
      "CREATE INDEX"
    );
  });

  it("DDL 前缀只补合法剩余词并在对象名参数位置停止", () => {
    expect(prefix("create")).toEqual(
      expect.arrayContaining(["TABLE", "DATABASE", "VIEW"])
    );
    expect(prefix("CREATE TEMPORARY")).toContain("TABLE");
    expect(prefix("CREATE TABLE")).toContain("IF NOT EXISTS");
    expect(prefix("DROP TABLE users")).toEqual([]);
    expect(prefix("TRUNCATE", "sqlite")).toBeUndefined();
    expect(prefix("CREATE MATERIALIZED", "postgres")).toContain("VIEW");
    expect(prefix("CREATE OR REPLACE", "postgres")).toContain("VIEW");
    expect(prefix("CREATE TABLE `SELECT`")).toEqual([]);
  });

  it("光标右边有内容时只补当前词", () => {
    expect(prefix("CREATE", "mysql", true)).toContain("TEMPORARY");
    expect(prefix("CREATE", "mysql", true)).not.toContain("TEMPORARY TABLE");
    expect(prefix("ALTER TABLE users", "mysql", true)).toContain("ADD");
    expect(prefix("ALTER TABLE users", "mysql", true)).not.toContain(
      "ADD COLUMN"
    );
    expect(prefix("CREATE TABLE users (id INT", "mysql", true)).not.toContain(
      "NOT NULL"
    );
  });

  it.each<SqlDialect>(["mysql", "postgres", "sqlite", "clickhouse"])(
    "%s 补建表存在性条件及逐词前缀",
    (dialect) => {
      expect(prefix("CREATE TABLE", dialect)).toContain("IF NOT EXISTS");
      expect(prefix("CREATE TABLE IF", dialect)).toContain("NOT EXISTS");
      expect(prefix("CREATE TABLE IF NOT", dialect)).toEqual(["EXISTS"]);
      expect(prefix("CREATE TABLE IF NOT EXISTS", dialect)).toEqual([]);
      expect(prefix("CREATE TABLE", dialect, true)).toEqual(["IF"]);
    }
  );

  it.each<SqlDialect>([
    "mysql",
    "postgres",
    "sqlite",
    "sqlserver",
    "clickhouse",
  ])("%s 补删除表存在性条件", (dialect) => {
    expect(prefix("DROP TABLE", dialect)).toContain("IF EXISTS");
    expect(prefix("DROP TABLE IF", dialect)).toEqual(["EXISTS"]);
    expect(prefix("DROP TABLE IF EXISTS", dialect)).toEqual([]);
  });

  it("存在性条件遵循 SQL Server 与 PostgreSQL 差异", () => {
    expect(prefix("CREATE TABLE", "sqlserver")).toEqual([]);
    expect(prefix("ALTER TABLE", "postgres")).toContain("IF EXISTS");
    expect(prefix("ALTER TABLE IF", "postgres")).toEqual(["EXISTS"]);
    expect(prefix("ALTER TABLE IF EXISTS users", "postgres")).toContain(
      "ADD COLUMN"
    );
    expect(prefix("ALTER TABLE", "mysql")).toEqual([]);
  });

  it("建表空列定义段提供表级约束，不污染 ClickHouse", () => {
    expect(prefix("CREATE TABLE users (")).toEqual(
      expect.arrayContaining([
        "PRIMARY KEY",
        "UNIQUE",
        "FOREIGN KEY",
        "CHECK",
        "CONSTRAINT",
      ])
    );
    expect(prefix("CREATE TABLE users (id INT,")).toContain("FOREIGN KEY");
    expect(prefix("CREATE TABLE users (", "clickhouse")).toEqual([]);
  });

  it("简单建表列定义按方言补类型和约束", () => {
    expect(prefix("CREATE TABLE users (id")).toContain("INT");
    expect(prefix("CREATE TABLE users (id", "postgres")).toContain("UUID");
    expect(prefix("CREATE TABLE users (id", "sqlserver")).toContain("NVARCHAR");
    expect(prefix("CREATE TABLE users (id", "sqlite")).toContain("INTEGER");
    expect(prefix("CREATE TABLE users (id", "clickhouse")).toContain("Int32");
    expect(prefix("CREATE TABLE users (id INT")).toContain("PRIMARY KEY");
    expect(prefix("CREATE TABLE sample (id")).toContain("INT");
    expect(prefix("CREATE TABLE sample (id INT")).toContain("PRIMARY KEY");
    expect(prefix("CREATE TABLE users (id INT, name VARCHAR(64)")).toContain(
      "NOT NULL"
    );
    expect(prefix("CREATE TABLE users (id INT DEFAULT 1")).toEqual([]);
    expect(
      prefix("CREATE TABLE users (id INT, name", "postgres")
    ).not.toContain("AUTO_INCREMENT");
  });

  it("简单改表补动作与新增列类型", () => {
    expect(prefix("ALTER TABLE app.users")).toEqual(
      expect.arrayContaining(["ADD", "DROP", "MODIFY", "CHANGE"])
    );
    expect(prefix("ALTER TABLE users", "postgres")).toContain("ALTER COLUMN");
    expect(prefix("ALTER TABLE users", "sqlite")).not.toContain("MODIFY");
    expect(prefix("ALTER TABLE users ADD COLUMN name", "postgres")).toContain(
      "TEXT"
    );
    expect(prefix("ALTER TABLE users DROP COLUMN name")).toEqual([]);
    expect(prefix("ALTER TABLE sample", "postgres")).toContain("ADD COLUMN");
    expect(prefix("ALTER TABLE users ADD", "sqlserver")).not.toContain(
      "COLUMN"
    );
  });

  it("保留现有 MySQL 管理命令的表、变量和事务补全", () => {
    for (const sql of [
      "SHOW",
      "SET",
      "ANALYZE TABLE",
      "CHECK TABLE",
      "OPTIMIZE TABLE",
      "START TRANSACTION",
      "ROLLBACK TO",
      "SAVEPOINT",
    ]) {
      expect(prefix(sql)).toBeUndefined();
    }
  });

  it("按方言补管理与事务前缀，不在参数位置输出语句入口", () => {
    expect(prefix("DESCRIBE")).toEqual([]);
    expect(prefix("USE")).toEqual([]);
    expect(prefix("BEGIN", "sqlserver")).toContain("TRANSACTION");
    expect(prefix("BEGIN", "sqlite")).toContain("IMMEDIATE");
    expect(prefix("SET SHOWPLAN_XML", "sqlserver")).toEqual(["ON", "OFF"]);
    expect(prefix("PRAGMA", "sqlite")).toEqual([]);
    expect(prefix("SHOW", "postgres")).toEqual([]);
  });

  it("EXPLAIN 选项按方言补全", () => {
    expect(prefix("EXPLAIN")).toEqual(
      expect.arrayContaining(["SELECT", "ANALYZE", "FORMAT"])
    );
    expect(prefix("EXPLAIN FORMAT =")).toEqual(
      expect.arrayContaining(["JSON", "TREE", "TRADITIONAL"])
    );
    expect(prefix("EXPLAIN QUERY", "sqlite")).toEqual(["PLAN"]);
    expect(prefix("EXPLAIN QUERY PLAN", "sqlite")).toContain("SELECT");
    expect(prefix("EXPLAIN", "sqlite")).not.toContain("ANALYZE");
    expect(prefix("EXPLAIN (", "postgres")).toContain("BUFFERS");
    expect(prefix("EXPLAIN", "clickhouse")).toContain("PIPELINE");
    expect(prefix("EXPLAIN", "clickhouse")).not.toContain("ANALYZE");
    expect(prefix("EXPLAIN", "sqlserver")).toBeUndefined();
  });

  it("WITH 只补 RECURSIVE，然后交回已有查询解析", () => {
    expect(prefix("WITH", "postgres")).toEqual(["RECURSIVE"]);
    expect(prefix("WITH", "sqlserver")).toEqual([]);
    expect(prefix("WITH", "clickhouse")).toEqual(["RECURSIVE"]);
    expect(prefix("WITH c AS (SELECT 1)")).not.toContain("INSERT INTO");
    expect(prefix("WITH RECURSIVE", "postgres")).toBeUndefined();
    expect(prefix("WITH c AS (SELECT id FROM users)", "postgres")).toContain(
      "SELECT"
    );
    expect(
      prefix("WITH c AS (SELECT id FROM users", "postgres")
    ).toBeUndefined();
    expect(
      prefix("WITH c AS (SELECT id FROM users),", "postgres")
    ).toBeUndefined();
    expect(
      prefix("WITH c AS (SELECT id FROM users) SELECT", "postgres")
    ).toBeUndefined();
  });

  it.each([
    "SELECT",
    "EXPLAIN SELECT id FROM users",
    "EXPLAIN ANALYZE SELECT",
    "CREATE TABLE dst AS SELECT",
    "CREATE VIEW v AS SELECT",
    "REPLACE INTO users",
    "MERGE INTO users",
    "INSERT INTO users SELECT",
    "UPDATE users",
    "DELETE FROM users",
    "EXPLAIN WITH c AS (SELECT 1)",
  ])("查询正文继续使用现有上下文：%s", (sql) => {
    expect(prefix(sql)).toBeUndefined();
  });

  it("不将引号标识符、字符串或未知词当语句前缀", () => {
    expect(prefix('"CREATE"', "postgres")).toBeUndefined();
    expect(prefix("`CREATE`")).toBeUndefined();
    expect(prefix("'EXPLAIN'")).toBeUndefined();
    expect(prefix("nonsense")).toBeUndefined();
    expect(prefix("")).toBeUndefined();
    expect(prefix("/* note */ CREATE")).toContain("TABLE");
  });
});
