import { describe, expect, it } from "vitest";
import { generateSqlCompletionCandidates } from "../utils/sqlCompletionCandidates";
import { analyzeSqlCompletion } from "../utils/sqlCompletionContext";
import { buildSqlMetadataIndex } from "../utils/sqlCompletionMetadataIndex";
import { resolveSqlCompletionScopes } from "../utils/sqlCompletionScopes";

function complete(marked: string) {
  const offset = marked.indexOf("|");
  const sql = marked.replace("|", "");
  const index = buildSqlMetadataIndex(
    {
      databases: ["app"],
      tables: [{ name: "users" }],
      columns: [{ table: "users", name: "SRS_ID" }],
    },
    {
      connId: "admin-regressions",
      database: "app",
      dialect: "mysql",
      connectionRevision: 0,
    }
  );
  const base = analyzeSqlCompletion({ sql, offset, dialect: "mysql" });
  base.defaultNamespace = "app";
  const context = resolveSqlCompletionScopes({
    sql,
    offset,
    context: base,
    index,
  });
  return {
    context,
    candidates: generateSqlCompletionCandidates(context, index),
  };
}

describe("MySQL 管理语句和系统表补全回归", () => {
  it("系统表未知扩展列可能同名时业务字段必须使用限定引用", () => {
    const { candidates } = complete(
      "SELECT SRS_| FROM information_schema.COLUMNS c JOIN users u ON 1=1"
    );
    expect(candidates).toContainEqual(
      expect.objectContaining({
        label: "u.SRS_ID",
        insertText: "`u`.`SRS_ID`",
        kind: "column",
      })
    );
    expect(candidates.some((item) => item.insertText === "`SRS_ID`")).toBe(
      false
    );
  });

  it("静态公共列不足以确认 COLUMNS 星号投影的显式列列表长度", () => {
    const aliases = Array.from({ length: 21 }, (_, i) => `x${i + 1}`).join(",");
    const { context, candidates } = complete(
      `WITH c(${aliases}) AS (SELECT * FROM information_schema.COLUMNS) SELECT c.x1| FROM c`
    );
    const relation = context.scopes
      .flatMap((scope) => scope.relations)
      .find((item) => item.kind === "cte" && item.name === "c");
    expect(relation?.outputComplete).toBe(false);
    expect(candidates).toEqual([]);
  });

  it("SET 函数参数逗号后不提供系统变量名", () => {
    const { candidates } = complete("SET sql_mode = CONCAT('a', |)");
    expect(candidates.some((item) => item.insertText === "autocommit")).toBe(
      false
    );
    expect(candidates.some((item) => item.insertText === "sql_mode")).toBe(
      false
    );
  });

  it("SET 顶层逗号后仍可开始下一个变量赋值", () => {
    const { candidates } = complete(
      "SET SESSION sql_mode = CONCAT('a', 'b'), au|"
    );
    expect(candidates).toContainEqual(
      expect.objectContaining({ insertText: "autocommit", kind: "keyword" })
    );
  });
});
