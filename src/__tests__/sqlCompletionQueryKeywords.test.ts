import { describe, expect, it } from "vitest";
import type { SqlDialect } from "../utils/sqlCompletion";
import { analyzeSqlCompletion } from "../utils/sqlCompletionContext";
import { generateSqlCompletionCandidates } from "../utils/sqlCompletionCandidates";
import { buildSqlMetadataIndex } from "../utils/sqlCompletionMetadataIndex";
import { resolveSqlCompletionScopes } from "../utils/sqlCompletionScopes";
import {
  completionKey,
  completionSchema,
} from "./fixtures/sqlCompletionFixtures";

function labels(marked: string, dialect: SqlDialect = "mysql") {
  const offset = marked.indexOf("|");
  const sql = marked.replace("|", "");
  const context = analyzeSqlCompletion({ sql, offset, dialect });
  context.defaultNamespace = "app";
  const index = buildSqlMetadataIndex(completionSchema, {
    ...completionKey,
    dialect,
  });
  return generateSqlCompletionCandidates(
    resolveSqlCompletionScopes({ sql, offset, context, index }),
    index
  ).map((item) => item.label);
}

describe("查询子句的关键词补全", () => {
  it.each<SqlDialect>(["postgres", "sqlite"])(
    "%s 在完整 DML 目标或表达式后提供 RETURNING",
    (dialect) => {
      for (const sql of [
        "UPDATE users SET id=1 RET|",
        "UPDATE users SET id=1 WHERE id=1 RET|",
        "DELETE FROM users RET|",
        "DELETE FROM users WHERE id=1 RET|",
        "INSERT INTO users(id) VALUES(1) RET|",
      ]) {
        expect(labels(sql, dialect), sql).toContain("RETURNING");
      }
    }
  );
  it.each<SqlDialect>(["mysql", "sqlserver", "clickhouse"])(
    "%s 不提供 RETURNING",
    (dialect) => {
      expect(labels("UPDATE users SET id=1 RET|", dialect)).not.toContain(
        "RETURNING"
      );
    }
  );
  it.each<SqlDialect>(["postgres", "sqlite"])(
    "%s 的 RETURNING 后仍提供目标字段且不混入查询续接",
    (dialect) => {
      expect(labels("UPDATE users SET id=1 RETURNING na|", dialect)).toContain(
        "users.name"
      );
      const result = labels("UPDATE users SET id=1 RETURNING name |", dialect);
      expect(result).not.toContain("FROM");
      expect(result).not.toContain("UNION");
      expect(result).not.toContain("DISTINCT");
    }
  );
  it.each<SqlDialect>([
    "mysql",
    "postgres",
    "sqlite",
    "sqlserver",
    "clickhouse",
  ])("%s 在完整表引用后提供 RIGHT JOIN", (dialect) => {
    expect(labels("SELECT * FROM users RI|", dialect)).toContain("RIGHT JOIN");
  });
  it.each<SqlDialect>(["postgres", "sqlite", "sqlserver", "clickhouse"])(
    "%s 在完整表引用后提供 FULL JOIN",
    (dialect) => {
      expect(labels("SELECT * FROM users FU|", dialect)).toContain("FULL JOIN");
    }
  );
  it("MySQL 不提供不支持的 FULL JOIN", () => {
    expect(labels("SELECT * FROM users FU|")).not.toContain("FULL JOIN");
  });
  it.each([
    ["SELECT * FROM users WHERE id = 1 GR|", "GROUP BY"],
    ["SELECT * FROM users WHERE id = 1 HA|", "HAVING"],
    ["SELECT * FROM users WHERE id = 1 OR|", "ORDER BY"],
    ["SELECT * FROM users WHERE id = 1 LI|", "LIMIT"],
    ["SELECT COUNT(*) FROM users HA|", "HAVING"],
    ["SELECT id FROM users UN|", "UNION"],
    ["SELECT id FROM users WHERE id = 1 UN|", "UNION ALL"],
    ["SELECT id FROM users GROUP BY id LI|", "LIMIT"],
    ["SELECT id FROM users HAVING COUNT(*) > 1 OR|", "ORDER BY"],
    ["SELECT * FROM users JOIN orders ON users.id=orders.user_id WH|", "WHERE"],
    [
      "SELECT * FROM users JOIN orders ON users.id=orders.user_id RI|",
      "RIGHT JOIN",
    ],
  ])("%s 提供 %s", (sql, expected) => {
    expect(labels(sql)).toContain(expected);
  });
  it("SQL Server 条件后使用 ORDER BY，且不提供 LIMIT", () => {
    expect(labels("SELECT * FROM users WHERE id=1 OR|", "sqlserver")).toContain(
      "ORDER BY"
    );
    expect(
      labels("SELECT * FROM users WHERE id=1 LI|", "sqlserver")
    ).not.toContain("LIMIT");
  });
  it.each<SqlDialect>([
    "mysql",
    "postgres",
    "sqlite",
    "sqlserver",
    "clickhouse",
  ])("%s 仅在 SELECT 开头提供 ALL/DISTINCT 修饰词", (dialect) => {
    expect(labels("SELECT AL| FROM users", dialect)).toContain("ALL");
    expect(labels("SELECT DI| FROM users", dialect)).toContain("DISTINCT");
    expect(labels("SELECT id, AL| FROM users", dialect)).not.toContain("ALL");
    expect(labels("SELECT id, DI| FROM users", dialect)).not.toContain(
      "DISTINCT"
    );
    expect(labels("SELECT DISTINCT DI| FROM users", dialect)).not.toContain(
      "DISTINCT"
    );
  });
  it("仅 SQL Server 的 SELECT 开头提供 TOP", () => {
    expect(labels("SELECT TO| FROM users", "sqlserver")).toContain("TOP");
    expect(labels("SELECT TO| FROM users", "mysql")).not.toContain("TOP");
    expect(labels("SELECT id, TO| FROM users", "sqlserver")).not.toContain(
      "TOP"
    );
  });
  it("SQL Server JOIN 目标后只提供支持的连接条件语法", () => {
    expect(labels("SELECT * FROM users JOIN orders |", "sqlserver")).toContain(
      "ON"
    );
    expect(
      labels("SELECT * FROM users JOIN orders US|", "sqlserver")
    ).not.toContain("USING");
    expect(labels("SELECT * FROM users JOIN orders US|", "postgres")).toContain(
      "USING"
    );
  });
  it("ORDER BY 的函数内部不提供排序与分页子句", () => {
    const result = labels("SELECT * FROM users ORDER BY COALESCE(id |)");
    expect(result).not.toContain("LIMIT");
    expect(result).not.toContain("OFFSET");
    expect(result).not.toContain("ASC");
  });
  it.each([
    "SELECT COALESCE(id, 0 |) FROM users",
    "SELECT * FROM users WHERE COALESCE(id |)",
    "SELECT CASE WHEN id=1 | THEN 2 END FROM users",
  ])("%s 的嵌套表达式不提供查询续接", (sql) => {
    expect(labels(sql)).not.toContain("UNION");
    expect(labels(sql)).not.toContain("GROUP BY");
    expect(labels(sql)).not.toContain("FROM");
  });
  it.each([
    "SELECT * FROM users WHERE |",
    "SELECT * FROM users WHERE id = |",
    "SELECT * FROM users WHERE u.|",
    "SELECT * FROM |",
    "UPDATE users SET id=1 WHERE id=1 |",
    "DELETE FROM users WHERE id=1 |",
  ])("%s 的名称或 DML 槽位不混入查询续接", (sql) => {
    expect(labels(sql)).not.toContain("UNION");
    expect(labels(sql)).not.toContain("GROUP BY");
  });
});
