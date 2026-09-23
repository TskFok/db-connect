import { describe, expect, it } from "vitest";
import { parseSqlQueryBlocks } from "../utils/sqlCompletionScopeParser";
import type { SqlDialect } from "../utils/sqlCompletion";

const parse = (sql: string, dialect: SqlDialect = "postgres") =>
  parseSqlQueryBlocks(sql, { start: 0, end: sql.length }, dialect);

describe("parseSqlQueryBlocks", () => {
  it("解析 CTE、派生表和表达式子查询的独立边界", () => {
    const sql =
      "WITH c(x) AS (SELECT u.id FROM users u) SELECT d.x FROM (SELECT x FROM c) d WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = d.x)";
    const blocks = parse(sql);
    expect(blocks).toHaveLength(4);
    const root = blocks.find((b) => b.kind === "statement")!;
    const derived = blocks.find((b) => b.kind === "derived")!;
    const cte = blocks.find((b) => b.kind === "cte")!;
    const expression = blocks.find((b) => b.kind === "expression")!;
    expect(root.range).toEqual({ start: 0, end: sql.length });
    expect(root.ctes[0]).toMatchObject({
      name: "c",
      columnAliases: [{ name: "x", quoted: false }],
      bodyScopeId: cte.id,
      recursive: false,
    });
    expect([cte.parentId, derived.parentId, expression.parentId]).toEqual([
      root.id,
      root.id,
      root.id,
    ]);
    expect(root.from[0]).toMatchObject({
      kind: "derived",
      alias: "d",
      bodyScopeId: derived.id,
    });
    expect(derived.from[0]).toMatchObject({ kind: "cte", name: "c" });
    expect(sql.slice(derived.range.start, derived.range.end)).toBe(
      "SELECT x FROM c"
    );
    expect(root.range.start).toBeLessThan(sql.indexOf("d.x"));
    const refs = blocks.flatMap((b) => b.from);
    expect(new Set(refs.map((r) => r.id)).size).toBe(refs.length);
  });

  it("忽略字符串和注释中的结构词，保持 UTF-16 偏移", () => {
    const sql = "SELECT '😀 -- FROM' /* JOIN (SELECT x) */ FROM users";
    const blocks = parse(sql);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].from).toHaveLength(1);
    expect(blocks[0].from[0]).toMatchObject({
      name: "users",
      declarationStart: sql.indexOf("users"),
      id: `relation:${sql.indexOf("users")}`,
    });
  });

  it.each([
    [
      "postgres",
      'SELECT * FROM "other"."Case" AS "Alias"',
      "other",
      "Case",
      "Alias",
    ],
    [
      "sqlserver",
      "SELECT * FROM [other].[Case] [Alias]",
      "other",
      "Case",
      "Alias",
    ],
    ["mysql", "SELECT * FROM `other`.`Case` `Alias`", "other", "Case", "Alias"],
  ] as const)(
    "保留 %s 引用名及 namespace",
    (dialect, sql, namespace, name, alias) => {
      expect(parse(sql, dialect)[0].from[0]).toMatchObject({
        namespace,
        name,
        alias,
        nameQuoted: true,
        namespaceQuoted: true,
        aliasQuoted: true,
      });
    }
  );

  it("自连接拥有不同关系 id", () => {
    const from = parse("SELECT * FROM users a JOIN users b ON a.id = b.id")[0]
      .from;
    expect(from.map((r) => [r.name, r.alias])).toEqual([
      ["users", "a"],
      ["users", "b"],
    ]);
    expect(from[0].id).not.toBe(from[1].id);
  });

  it("集合分支独立，尾部 ORDER BY 属于 compound", () => {
    const blocks = parse(
      "SELECT id FROM users UNION ALL SELECT id FROM orders ORDER BY id"
    );
    const root = blocks.find((b) => b.kind === "compound")!;
    const branches = root.setBranchIds!.map(
      (id) => blocks.find((b) => b.id === id)!
    );
    expect(branches.map((b) => b.from[0].name)).toEqual(["users", "orders"]);
    expect(branches.map((b) => b.parentId)).toEqual([root.id, root.id]);
    expect(root.clauses.map((c) => c.name)).toEqual(["orderBy"]);
    expect(
      branches.every((b) => b.clauses.every((c) => c.name !== "orderBy"))
    ).toBe(true);
    expect(root.from).toEqual([]);
  });

  it("解析 LATERAL 和派生表显式列名列表", () => {
    const blocks = parse(
      "SELECT * FROM users u, LATERAL (SELECT u.id) d(renamed)"
    );
    expect(blocks[0].from[1]).toMatchObject({
      kind: "derived",
      lateral: true,
      alias: "d",
      columnAliases: [{ name: "renamed", quoted: false }],
    });
    expect(blocks.find((b) => b.kind === "lateral")?.parentId).toBe(
      blocks[0].id
    );
  });

  it("SQL Server 表 hint 不是 CTE 或别名", () => {
    const block = parse(
      "SELECT * FROM users WITH (NOLOCK) JOIN orders o ON o.id = users.id",
      "sqlserver"
    )[0];
    expect(block.ctes).toEqual([]);
    expect(block.from.map((r) => r.name)).toEqual(["users", "orders"]);
  });

  it.each([
    ["postgres", "SELECT * FROM (SELECT * FROM hidden"],
    ["postgres", "SELECT * FROM UNNEST(items) AS hidden"],
    ["postgres", "SELECT DISTINCT ON (id) id FROM users"],
    ["sqlserver", "SELECT * FROM users CROSS APPLY (SELECT * FROM hidden) d"],
    ["sqlserver", "SELECT * FROM users PIVOT (MAX(id) FOR x IN (y)) p"],
    ["clickhouse", "SELECT * FROM users ARRAY JOIN hidden"],
    ["clickhouse", "SELECT * FROM users FINAL"],
    ["clickhouse", "SELECT * FROM users PREWHERE id > 0"],
    ["clickhouse", "WITH 1 AS scalar SELECT * FROM users"],
  ] as const)("%s 不支持语法不产生猜测关系: %s", (dialect, sql) => {
    const root = parse(sql, dialect)[0];
    expect(root.unsupported).toBeTruthy();
    expect(root.from).toEqual([]);
  });

  it("只扫描指定语句范围", () => {
    const sql = "SELECT * FROM hidden; SELECT * FROM users";
    const blocks = parseSqlQueryBlocks(
      sql,
      { start: 21, end: sql.length },
      "postgres"
    );
    expect(blocks[0].from.map((r) => r.name)).toEqual(["users"]);
  });

  it("范围外未闭合字符串不能吞掉当前语句，token 偏移保持绝对坐标", () => {
    const sql = "'broken SELECT id FROM users";
    const blocks = parseSqlQueryBlocks(
      sql,
      { start: 8, end: sql.length },
      "postgres"
    );
    expect(blocks[0]?.from[0]).toMatchObject({
      name: "users",
      declarationStart: 23,
    });
    expect(blocks[0]?.selectItems[0][0].start).toBe(15);
  });

  it.each(["NATURAL JOIN orders", "JOIN orders USING (id)"])(
    "标记合并列的 JOIN 而保留明确关系: %s",
    (join) => {
      const block = parse(`SELECT * FROM users ${join}`)[0];
      expect(block.joinsMergeColumns).toBe(true);
      expect(block.from.map((r) => r.name)).toEqual(["users", "orders"]);
      expect(block.unsupported).toBeUndefined();
    }
  );

  it("投影逗号只按当前查询深度分隔并去除 DISTINCT", () => {
    const block = parse(
      "SELECT DISTINCT coalesce(a, b) AS c, u.id FROM users u"
    )[0];
    expect(
      block.selectItems.map((item) => item.map((token) => token.text))
    ).toEqual([
      ["coalesce", "(", "a", ",", "b", ")", "AS", "c"],
      ["u", ".", "id"],
    ]);
  });

  it("派生集合查询将 bodyScopeId 指向 compound", () => {
    const blocks = parse(
      "SELECT d.id FROM (SELECT id FROM users UNION SELECT id FROM orders) d"
    );
    const compound = blocks.find((b) => b.kind === "compound")!;
    expect(blocks[0].from[0].bodyScopeId).toBe(compound.id);
    expect(compound.parentId).toBe(blocks[0].id);
    expect(compound.setBranchIds).toHaveLength(2);
  });

  it("PostgreSQL 未引用名称匹配引用的小写 CTE，异 namespace 仍为物理表", () => {
    const block = parse(
      'WITH "users" AS (SELECT 1 AS id) SELECT * FROM USERS, other.users'
    )[0];
    expect(
      block.from.map((ref) => [ref.kind, ref.name, ref.namespace])
    ).toEqual([
      ["cte", "USERS", undefined],
      ["table", "users", "other"],
    ]);
  });

  it("CTE 标识符分类沿用方言大小写语义", () => {
    expect(
      parse('WITH "Äu" AS (SELECT 1 AS id) SELECT * FROM ÄU')[0].from[0].kind
    ).toBe("cte");
    expect(
      parse(
        "WITH Mixed AS (SELECT 1 AS id) SELECT * FROM mixed",
        "clickhouse"
      )[0].from[0].kind
    ).toBe("table");
  });

  it("非查询 DML 交由一期处理", () => {
    expect(parse("UPDATE users SET id = 1")).toEqual([]);
    expect(parse("INSERT INTO users SELECT * FROM orders")).toEqual([]);
  });

  it("保留未完成的空投影项，避免将残缺 SELECT 标为完整", () => {
    expect(
      parse("SELECT id AS renamed, FROM users")[0].selectItems.map((item) =>
        item.map((token) => token.text)
      )
    ).toEqual([["id", "AS", "renamed"], []]);
    expect(parse("SELECT")[0].selectItems).toEqual([[]]);
    expect(parse("SELECT , id FROM users")[0].selectItems[0]).toEqual([]);
  });

  it("SQL Server 无 RECURSIVE 关键字的 CTE 允许递归自引用", () => {
    const blocks = parse(
      "WITH c AS (SELECT 1 AS n UNION ALL SELECT n+1 FROM c) SELECT * FROM c",
      "sqlserver"
    );
    expect(blocks[0].ctes[0]).toMatchObject({ name: "c", recursive: true });
    const body = blocks.find(
      (block) => block.id === blocks[0].ctes[0].bodyScopeId
    )!;
    expect(body.kind).toBe("compound");
    expect(
      blocks.find((block) => block.id === body.setBranchIds![1])?.from[0].kind
    ).toBe("cte");
  });

  it.each(["ON o.id=u.id", "USING (id)"])(
    "%s 后的逗号关系仍属于 FROM",
    (condition) => {
      const block = parse(
        `SELECT * FROM users u JOIN orders o ${condition}, users extra`
      )[0];
      expect(block.from.map((ref) => ref.alias)).toEqual(["u", "o", "extra"]);
    }
  );

  it("不支持投影保留明确 AS 项供局部推导", () => {
    const block = parse(
      "SELECT u.* APPLY(toString), 1 AS k FROM users u",
      "clickhouse"
    )[0];
    expect(block.unsupported).toBeDefined();
    expect(
      block.selectItems.map((item) => item.map((token) => token.text))
    ).toEqual([
      ["u", ".", "*", "APPLY", "(", "toString", ")"],
      ["1", "AS", "k"],
    ]);
    expect(block.from).toEqual([]);
  });

  it("超过 32 层括号时有限降级", () => {
    const sql =
      "SELECT * FROM " +
      "(SELECT * FROM ".repeat(40) +
      "users" +
      ") d".repeat(40);
    const blocks = parse(sql);
    expect(blocks.length).toBeLessThanOrEqual(33);
    expect(blocks.some((b) => !!b.unsupported)).toBe(true);
    expect(blocks.flatMap((b) => b.from)).toEqual([]);
  });
});
