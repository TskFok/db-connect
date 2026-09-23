import { describe, expect, it } from "vitest";
import type { SqlDialect, SqlSchema } from "../utils/sqlCompletion";
import { analyzeSqlCompletion } from "../utils/sqlCompletionContext";
import { resolveSqlCompletionScopes } from "../utils/sqlCompletionScopes";
import { buildSqlMetadataIndex } from "../utils/sqlCompletionMetadataIndex";
import {
  completionKey,
  completionSchema,
} from "./fixtures/sqlCompletionFixtures";

function resolve(
  marked: string,
  dialect: SqlDialect = "postgres",
  schema: SqlSchema = completionSchema,
  namespace: string | null = "app"
) {
  const offset = marked.indexOf("|") < 0 ? marked.length : marked.indexOf("|");
  const sql = marked.replace("|", "");
  const base = analyzeSqlCompletion({ sql, offset, dialect });
  base.defaultNamespace = namespace;
  const index = buildSqlMetadataIndex(schema, { ...completionKey, dialect });
  const context = resolveSqlCompletionScopes({
    sql,
    offset,
    context: base,
    index,
  });
  return {
    context,
    active: context.scopes.find((s) => s.id === context.scopeId)!,
    base,
    sql,
    offset,
    index,
  };
}

describe("SQL 查询作用域合成", () => {
  it("按依赖顺序推导 CTE 并应用显式输出列名", () => {
    const { active } = resolve(
      "WITH base AS (SELECT id AS k FROM users), renamed(v) AS (SELECT k FROM base) SELECT r.| FROM renamed r"
    );
    expect(active.relations[0]).toMatchObject({
      kind: "cte",
      alias: "r",
      outputComplete: true,
      outputColumns: [{ name: "v" }],
    });
    expect(active.ctes?.map((c) => c.name)).toEqual(["base", "renamed"]);
  });
  it("CTE 本体只看见之前的定义，不能访问外层 FROM", () => {
    const { active } = resolve(
      "WITH base AS (SELECT | FROM users), later AS (SELECT id FROM orders) SELECT * FROM base b"
    );
    expect(active.ctes?.map((c) => c.name)).not.toContain("later");
    expect(active.canCorrelate).toBe(false);
    expect(active.visibleParentRelationIds).toEqual([]);
    const previous = resolve(
      "WITH base AS (SELECT id FROM users), later AS (SELECT | FROM base) SELECT * FROM later"
    ).active;
    expect(previous.ctes?.map((c) => c.name)).toContain("base");
    expect(previous.relations[0].outputComplete).toBe(true);
  });
  it("CTE 遮蔽物理同名表，内层 CTE 遮蔽外层且不泄漏", () => {
    const { active, context } = resolve(
      "WITH users AS (SELECT user_id AS outer_id FROM orders) SELECT | FROM users u WHERE EXISTS (WITH users AS (SELECT name AS inner_name FROM users) SELECT * FROM users)"
    );
    expect(active.relations[0].outputColumns?.map((c) => c.name)).toEqual([
      "outer_id",
    ]);
    const nested = context.scopes.find(
      (s) =>
        s.parentId === active.id && s.relations.some((r) => r.name === "users")
    )!;
    expect(nested.ctes?.filter((c) => c.name === "users")).toHaveLength(1);
    expect(nested.relations[0].outputColumns?.map((c) => c.name)).toEqual([
      "inner_name",
    ]);
  });
  it("非递归 CTE 本体能绑定外层同名 CTE 或真实表", () => {
    const inner = resolve(
      "WITH c AS (SELECT id AS outer_id FROM users) SELECT * FROM (WITH c AS (SELECT outer_id FROM c) SELECT c.| FROM c) d"
    );
    expect(inner.active.relations[0]).toMatchObject({
      outputComplete: true,
      outputColumns: [{ name: "outer_id" }],
    });
    expect(
      resolve("WITH users AS (SELECT id FROM users) SELECT users.| FROM users")
        .active.relations[0]
    ).toMatchObject({ outputComplete: true, outputColumns: [{ name: "id" }] });
  });
  it("每次 CTE 和物理 FROM 引用都有不同 id", () => {
    for (const sql of [
      "SELECT | FROM users a JOIN users b ON a.id=b.id",
      "WITH c AS (SELECT id FROM users) SELECT | FROM c a JOIN c b ON a.id=b.id",
    ]) {
      const { active } = resolve(sql);
      expect(new Set(active.relations.map((r) => r.id)).size).toBe(2);
    }
  });
  it("派生列列表覆盖输出名且不匹配时保持未知", () => {
    expect(
      resolve("SELECT d.| FROM (SELECT id FROM users) d(k)").active.relations[0]
    ).toMatchObject({ outputComplete: true, outputColumns: [{ name: "k" }] });
    expect(
      resolve("SELECT d.| FROM (SELECT id FROM users) d(a,b)").active
        .relations[0].outputComplete
    ).toBe(false);
    expect(
      resolve("WITH c(k) AS (SELECT * FROM missing) SELECT c.| FROM c").active
        .relations[0].outputComplete
    ).toBe(false);
  });
  it("WHERE/SELECT 相关子查询可见父 FROM，普通派生表隔离", () => {
    const expression = resolve(
      "SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.|)"
    );
    const parent = expression.context.scopes.find(
      (s) => s.id === expression.active.parentId
    )!;
    expect(expression.active).toMatchObject({
      canCorrelate: true,
      visibleParentRelationIds: parent.relations.map((r) => r.id),
    });
    expect(expression.context.clause).toBe("where");
    expect(expression.context.slot).toBe("column");
    const derived = resolve(
      "SELECT * FROM users u, (SELECT u.| FROM orders) d"
    );
    expect(derived.active).toMatchObject({
      canCorrelate: false,
      visibleParentRelationIds: [],
    });
  });
  it("ON 内相关查询只能访问该 JOIN 之前和当前关系", () => {
    const { active, context } = resolve(
      "SELECT * FROM users u JOIN orders o ON EXISTS (SELECT |) JOIN users future ON future.id=u.id"
    );
    const parent = context.scopes.find((s) => s.id === active.parentId)!;
    expect(active.visibleParentRelationIds).toEqual(
      parent.relations.slice(0, 2).map((r) => r.id)
    );
  });
  it.each<SqlDialect>([
    "postgres",
    "mysql",
    "sqlite",
    "sqlserver",
    "clickhouse",
  ])("%s LATERAL 仅 PostgreSQL 开放左侧关系", (dialect) => {
    const { active, context } = resolve(
      "SELECT * FROM users u, LATERAL (SELECT u.|) d, orders o",
      dialect
    );
    const parent = context.scopes.find((s) => s.id === active.parentId)!;
    expect(active.canCorrelate).toBe(dialect === "postgres");
    expect(active.visibleParentRelationIds).toEqual(
      dialect === "postgres" ? [parent.relations[0].id] : []
    );
  });
  it("在内层 ON 重算 JOIN id，完整保留一期替换范围", () => {
    const { context, active, base } = resolve(
      "SELECT * FROM users u JOIN orders o ON EXISTS (SELECT * FROM users a JOIN orders b ON b.us|)"
    );
    expect(context.join).toEqual({
      leftRelationIds: [active.relations[0].id],
      rightRelationId: active.relations[1].id,
    });
    expect(context.clause).toBe("on");
    expect(context.slot).toBe("joinCondition");
    expect(context.edit).toEqual(base.edit);
    expect(context.qualifierParts).toEqual(["b"]);
  });
  it("显式异 namespace 和未知默认 namespace 不回退当前库", () => {
    expect(
      resolve("SELECT * FROM other.users x WHERE x.|").active.relations[0]
        .outputColumns
    ).toBeUndefined();
    expect(
      resolve("SELECT * FROM app.users x WHERE x.|").active.relations[0]
        .outputComplete
    ).toBe(true);
    expect(
      resolve("SELECT * FROM APP.users x WHERE x.|").active.relations[0]
        .outputComplete
    ).toBe(true);
    expect(
      resolve('SELECT * FROM "APP".users x WHERE x.|').active.relations[0]
        .outputColumns
    ).toBeUndefined();
    expect(
      resolve(
        "SELECT * FROM app.users x WHERE x.|",
        "postgres",
        completionSchema,
        null
      ).active.relations[0].outputColumns
    ).toBeUndefined();
  });
  it("PostgreSQL 引用名称与未引用名称各自匹配", () => {
    const schema = {
      databases: ["app"],
      tables: [{ name: "Mixed" }, { name: "mixed" }],
      columns: [
        { table: "Mixed", name: "K" },
        { table: "mixed", name: "k" },
      ],
    };
    expect(
      resolve(
        'SELECT | FROM "Mixed"',
        "postgres",
        schema
      ).active.relations[0].outputColumns?.map((c) => c.name)
    ).toEqual(["K"]);
    expect(
      resolve(
        "SELECT | FROM Mixed",
        "postgres",
        schema
      ).active.relations[0].outputColumns?.map((c) => c.name)
    ).toEqual(["k"]);
  });
  it("集合分支独立且输出用第一分支名称", () => {
    const { active } = resolve(
      "SELECT d.| FROM (SELECT id AS first FROM users UNION ALL SELECT id AS second FROM orders) d"
    );
    expect(active.relations[0]).toMatchObject({
      outputComplete: true,
      outputColumns: [{ name: "first" }],
    });
    const branch = resolve(
      "SELECT id FROM users UNION ALL SELECT | FROM orders"
    ).active;
    expect(branch.relations.map((r) => r.name)).toEqual(["orders"]);
    const compound = resolve(
      "SELECT id FROM users UNION ALL SELECT id FROM orders ORDER BY |"
    );
    expect(compound.active.relations).toEqual([]);
    expect(compound.active.projections.map((c) => c.name)).toEqual(["id"]);
    expect(compound.context.clause).toBe("orderBy");
  });
  it("递归 CTE 从显式列列表或锚点得到输出并有界终止", () => {
    expect(
      resolve(
        "WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums) SELECT nums.| FROM nums"
      ).active.relations[0]
    ).toMatchObject({ outputComplete: true, outputColumns: [{ name: "n" }] });
    expect(
      resolve(
        "WITH RECURSIVE nums AS (SELECT 1 AS n UNION ALL SELECT n+1 FROM nums) SELECT nums.| FROM nums"
      ).active.relations[0]
    ).toMatchObject({ outputComplete: true, outputColumns: [{ name: "n" }] });
    const input =
      "WITH RECURSIVE a AS (SELECT * FROM b), b AS (SELECT * FROM a) SELECT a.| FROM a";
    const first = resolve(input).context;
    expect(first).toEqual(resolve(input).context);
    expect(first.confidence).toBe("partial");
    expect(
      first.scopes.find((s) => s.id === first.scopeId)!.relations[0]
        .outputComplete
    ).toBe(false);
  });
  it("显式递归列列表不能把互相依赖或无锚点自引用标完整", () => {
    for (const sql of [
      "WITH RECURSIVE a(x) AS (SELECT x FROM b), b(y) AS (SELECT y FROM a) SELECT a.| FROM a",
      "WITH RECURSIVE nums(n) AS (SELECT n FROM nums) SELECT nums.| FROM nums",
      "WITH c(k) AS (SELECT missing FROM absent) SELECT c.| FROM c",
    ]) {
      const { active, context } = resolve(sql);
      expect(active.relations[0].outputComplete, sql).toBe(false);
      expect(context.confidence).toBe("partial");
    }
    expect(
      resolve("WITH c(k) AS (SELECT 1) SELECT c.| FROM c").active.relations[0]
    ).toMatchObject({ outputComplete: true, outputColumns: [{ name: "k" }] });
    expect(
      resolve(
        "WITH c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT c.| FROM c",
        "sqlserver"
      ).active.relations[0].outputComplete
    ).toBe(true);
  });

  it("派生输出覆盖不能掩盖未知来源", () => {
    expect(
      resolve("SELECT d.| FROM (SELECT absent FROM missing) d(k)").active
        .relations[0].outputComplete
    ).toBe(false);
  });

  it("字符串、注释与跨语句不改变补全槽位或泄漏 CTE", () => {
    expect(
      resolve("WITH c AS (SELECT id FROM users) SELECT 'c.|' FROM c").context
        .slot
    ).toBe("none");
    expect(resolve("SELECT * FROM users -- | ").context.slot).toBe("none");
    expect(
      resolve(
        "WITH c AS (SELECT id FROM users) SELECT * FROM c; SELECT | FROM orders"
      ).active.ctes
    ).toEqual([]);
  });
  it("畸形与深层 SQL 降级且不修改输入上下文", () => {
    const input = resolve(
      "SELECT * FROM users u WHERE EXISTS (SELECT | FROM orders o"
    );
    expect(input.context.confidence).not.toBe("high");
    expect(input.context.scopes).not.toBe(input.base.scopes);
    const deep =
      "SELECT * FROM (".repeat(35) + "SELECT | FROM users" + ") d".repeat(35);
    expect(resolve(deep).context.confidence).toBe("partial");
  });
});
