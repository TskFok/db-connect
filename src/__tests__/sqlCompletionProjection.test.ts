import { describe, expect, it } from "vitest";
import {
  combineSqlSetProjection,
  inferSqlProjection,
} from "../utils/sqlCompletionProjection";
import { tokenizeSql } from "../utils/sqlCompletionTokenizer";
import { parseSqlQueryBlocks } from "../utils/sqlCompletionScopeParser";
import type { ColumnSymbol } from "../utils/sqlCompletionTypes";
import type { ParsedQueryBlock } from "../utils/sqlCompletionScopeParser";
import type { SqlDialect } from "../utils/sqlCompletion";

function block(
  sql: string,
  from: ParsedQueryBlock["from"],
  dialect: SqlDialect = "postgres"
): ParsedQueryBlock {
  const select = sql.indexOf("SELECT") + "SELECT".length;
  const end = sql.indexOf(" FROM ");
  const tokens = tokenizeSql(
    sql.slice(select, end < 0 ? undefined : end),
    dialect
  );
  const items: (typeof tokens)[] = [];
  let item: typeof tokens = [];
  for (const token of tokens) {
    if (token.text === ",") {
      items.push(item);
      item = [];
    } else item.push(token);
  }
  items.push(item);
  return {
    id: "query:0",
    kind: "statement",
    range: { start: 0, end: sql.length },
    selectItems: items,
    from,
    ctes: [],
    clauses: [],
  };
}

const user = {
  id: "relation:users",
  kind: "table" as const,
  declarationStart: 0,
  name: "users",
  nameQuoted: false,
  alias: "u",
  aliasQuoted: false,
  lateral: false,
};
const userColumns: ColumnSymbol[] = [
  { name: "id", source: { relationId: user.id, column: "id" } },
  { name: "name", source: { relationId: user.id, column: "name" } },
];
const order = {
  id: "relation:orders",
  kind: "table" as const,
  declarationStart: 30,
  name: "orders",
  nameQuoted: false,
  alias: "o",
  aliasQuoted: false,
  lateral: false,
};
const orderColumns: ColumnSymbol[] = [
  { name: "id", source: { relationId: order.id, column: "id" } },
  { name: "user_id", source: { relationId: order.id, column: "user_id" } },
];
const known = new Map([
  [user.id, userColumns],
  [order.id, orderColumns],
]);
const columnsOf = (id: string) => known.get(id);

describe("inferSqlProjection", () => {
  it("按来源实例绑定列引用，并保留别名和表达式的投影顺序", () => {
    const query = block("SELECT u.id AS uid, u.name, 1 AS one FROM users u", [
      user,
    ]);
    expect(inferSqlProjection(query, columnsOf, "postgres")).toEqual({
      columns: [
        {
          name: "uid",
          quoted: false,
          source: { relationId: user.id, column: "id" },
        },
        {
          name: "name",
          quoted: false,
          source: { relationId: user.id, column: "name" },
        },
        { name: "one", quoted: false },
      ],
      complete: true,
    });
  });

  it("按 FROM 顺序展开无修饰星号，且保留重复列位置", () => {
    const query = block("SELECT * FROM users u JOIN orders o", [user, order]);
    expect(inferSqlProjection(query, columnsOf, "postgres")).toEqual({
      columns: [
        { name: "id", source: { relationId: user.id, column: "id" } },
        { name: "name", source: { relationId: user.id, column: "name" } },
        { name: "id", source: { relationId: order.id, column: "id" } },
        {
          name: "user_id",
          source: { relationId: order.id, column: "user_id" },
        },
      ],
      complete: true,
    });
  });

  it("仅展开与限定符精确绑定的关系，并保留后续显式表达式别名", () => {
    const query = block("SELECT u.*, 'x' AS tag FROM users u JOIN orders o", [
      user,
      order,
    ]);
    expect(inferSqlProjection(query, columnsOf, "postgres")).toEqual({
      columns: [
        { name: "id", source: { relationId: user.id, column: "id" } },
        { name: "name", source: { relationId: user.id, column: "name" } },
        { name: "tag", quoted: false },
      ],
      complete: true,
    });
  });

  it("未知来源或不匹配的限定符使星号不完整，不借用同名物理表", () => {
    const query = block("SELECT u.*, o.* FROM users u JOIN orders o", [
      user,
      order,
    ]);
    expect(
      inferSqlProjection(
        query,
        (id) => (id === user.id ? userColumns : undefined),
        "postgres"
      )
    ).toEqual({
      columns: [
        { name: "id", source: { relationId: user.id, column: "id" } },
        { name: "name", source: { relationId: user.id, column: "name" } },
      ],
      complete: false,
    });
    expect(
      inferSqlProjection(
        block("SELECT missing.* FROM users u", [user]),
        columnsOf,
        "postgres"
      )
    ).toEqual({ columns: [], complete: false });
  });

  it("无修饰同名列有歧义时不猜来源，限定列保持实例 id", () => {
    const query = block("SELECT id, o.id FROM users u JOIN orders o", [
      user,
      order,
    ]);
    expect(inferSqlProjection(query, columnsOf, "postgres")).toEqual({
      columns: [
        {
          name: "id",
          quoted: false,
          source: { relationId: order.id, column: "id" },
        },
      ],
      complete: false,
    });
  });

  it("表达式有 AS 时记录稳定别名，未命名函数结果不伪造名字", () => {
    expect(
      inferSqlProjection(
        block("SELECT sum(x) AS total", []),
        columnsOf,
        "postgres"
      )
    ).toEqual({ columns: [{ name: "total", quoted: false }], complete: true });
    expect(
      inferSqlProjection(
        block("SELECT count(*) FROM users u", [user]),
        columnsOf,
        "postgres"
      )
    ).toEqual({ columns: [], complete: false });
  });

  it("顶层星号即使带 AS 也不能伪装成单列输出", () => {
    for (const projection of [
      "* AS fake",
      "u.* AS fake",
      "* fake",
      "u.* fake",
      "(*) AS fake",
      "(u.*) AS fake",
    ]) {
      const query = block(`SELECT ${projection}, 1 AS safe FROM users u`, [
        user,
      ]);
      expect(
        inferSqlProjection(query, columnsOf, "postgres"),
        projection
      ).toEqual({
        columns: [{ name: "safe", quoted: false }],
        complete: false,
      });
    }
    expect(
      inferSqlProjection(
        block("SELECT count(*) AS n FROM users u", [user]),
        columnsOf,
        "postgres"
      )
    ).toEqual({ columns: [{ name: "n", quoted: false }], complete: true });
  });

  it("派生表中的 u.* AS fake 不产生可供外层补全的 fake 列", () => {
    const sql = "SELECT d.| FROM (SELECT u.* AS fake FROM users u) d";
    const inner = parseSqlQueryBlocks(
      sql,
      { start: 0, end: sql.length },
      "postgres"
    ).find((query) => query.kind === "derived")!;
    const result = inferSqlProjection(
      inner,
      (id) => (id === inner.from[0].id ? userColumns : undefined),
      "postgres"
    );
    expect(result).toEqual({ columns: [], complete: false });
  });

  it("PostgreSQL 未引用别名折叠大小写，引用别名保留大小写", () => {
    const query = block('SELECT u.id AS K, u.name AS "Case" FROM users u', [
      user,
    ]);
    expect(inferSqlProjection(query, columnsOf, "postgres")).toEqual({
      columns: [
        {
          name: "k",
          quoted: false,
          source: { relationId: user.id, column: "id" },
        },
        {
          name: "Case",
          quoted: true,
          source: { relationId: user.id, column: "name" },
        },
      ],
      complete: true,
    });
  });

  it("PostgreSQL 只折叠 ASCII 大写，非 ASCII 字母保留原形", () => {
    const query = block("SELECT u.ÄK AS ÄK FROM users u", [user]);
    expect(
      inferSqlProjection(
        query,
        (id) => (id === user.id ? [{ name: "Äk" }] : undefined),
        "postgres"
      )
    ).toEqual({
      columns: [
        {
          name: "Äk",
          quoted: false,
          source: { relationId: user.id, column: "Äk" },
        },
      ],
      complete: true,
    });
  });

  it("非 PostgreSQL 列名优先精确匹配，再作唯一的大小写回退", () => {
    const query = block("SELECT u.Foo, u.BAR FROM users u", [user], "mysql");
    const source = [{ name: "Foo" }, { name: "foo" }, { name: "bar" }];
    expect(
      inferSqlProjection(
        query,
        (id) => (id === user.id ? source : undefined),
        "mysql"
      )
    ).toEqual({
      columns: [
        {
          name: "Foo",
          quoted: false,
          source: { relationId: user.id, column: "Foo" },
        },
        {
          name: "bar",
          quoted: false,
          source: { relationId: user.id, column: "bar" },
        },
      ],
      complete: true,
    });
  });

  it("目录中的大小写列名原样保留，引用标记随显式列引用传递", () => {
    const query = block('SELECT u."MiXeD" FROM users u', [user]);
    const result = inferSqlProjection(
      query,
      (id) => (id === user.id ? [{ name: "MiXeD" }] : undefined),
      "postgres"
    );
    expect(result).toEqual({
      columns: [
        {
          name: "MiXeD",
          quoted: true,
          source: { relationId: user.id, column: "MiXeD" },
        },
      ],
      complete: true,
    });
  });

  it("裸别名只在安全的尾随标识符位置生效", () => {
    const query = block("SELECT u.id uid, 1 one FROM users u", [user]);
    expect(inferSqlProjection(query, columnsOf, "postgres")).toEqual({
      columns: [
        {
          name: "uid",
          quoted: false,
          source: { relationId: user.id, column: "id" },
        },
        { name: "one", quoted: false },
      ],
      complete: true,
    });
  });

  it("IS UNKNOWN、COLLATE 和 BETWEEN 的尾部操作数不能误认成裸别名", () => {
    for (const expression of [
      "u.id IS UNKNOWN",
      "u.id COLLATE C",
      "u.id BETWEEN 1 AND bound",
    ]) {
      const result = inferSqlProjection(
        block(`SELECT ${expression} FROM users u`, [user]),
        columnsOf,
        "postgres"
      );
      expect(result, expression).toEqual({ columns: [], complete: false });
    }
  });

  it("复杂投影降级但保留明确 AS 别名供本块局部使用", () => {
    const cases = [
      "SELECT u.* APPLY(toString), 1 AS safe FROM users u",
      "SELECT COLUMNS('^metric_'), 1 AS safe FROM users u",
      "SELECT * REPLACE(name AS renamed), 1 AS safe FROM users u",
      "SELECT DISTINCT ON (id) id, 1 AS safe FROM users u",
      "SELECT sum(id) OVER (PARTITION BY name) AS windowed, 1 AS safe FROM users u",
    ];
    for (const sql of cases) {
      const result = inferSqlProjection(
        block(sql, [user]),
        columnsOf,
        "postgres"
      );
      expect(result.complete, sql).toBe(false);
      expect(
        result.columns.some((column) => column.name === "safe"),
        sql
      ).toBe(true);
    }
  });

  it("NATURAL 或 USING 合并列时无修饰星号降级，限定星号仍可展开", () => {
    const query = {
      ...block("SELECT *, u.* FROM users u JOIN orders o", [user, order]),
      joinsMergeColumns: true,
    };
    expect(inferSqlProjection(query, columnsOf, "postgres")).toEqual({
      columns: [
        { name: "id", source: { relationId: user.id, column: "id" } },
        { name: "name", source: { relationId: user.id, column: "name" } },
      ],
      complete: false,
    });
  });

  it("解析器标记 USING 后不会从原始来源猜合并后的无修饰星号", () => {
    const sql = "SELECT *, u.* FROM users u JOIN orders o USING (id)";
    const query = parseSqlQueryBlocks(
      sql,
      { start: 0, end: sql.length },
      "postgres"
    )[0];
    const source = new Map(
      query.from.map((ref) => [
        ref.id,
        ref.name === "users" ? userColumns : orderColumns,
      ])
    );
    const result = inferSqlProjection(
      query,
      (id) => source.get(id),
      "postgres"
    );
    expect(result.complete).toBe(false);
    expect(result.columns.map((column) => column.name)).toEqual(["id", "name"]);
  });
});

describe("combineSqlSetProjection", () => {
  it("集合输出沿用首分支名称，并要求全部分支列数可确认且相等", () => {
    const first = { columns: [{ name: "first" }], complete: true };
    const second = { columns: [{ name: "second" }], complete: true };
    expect(combineSqlSetProjection([first, second])).toEqual(first);
    expect(
      combineSqlSetProjection([
        first,
        { columns: [{ name: "a" }, { name: "b" }], complete: true },
      ])
    ).toEqual({ columns: first.columns, complete: false });
    expect(
      combineSqlSetProjection([{ columns: [], complete: false }, second])
    ).toEqual({ columns: [], complete: false });
    expect(combineSqlSetProjection([])).toEqual({
      columns: [],
      complete: false,
    });
  });

  it("按解析器的集合分支顺序推导首分支名称", () => {
    const sql =
      "SELECT u.id AS first FROM users u UNION ALL SELECT o.id AS second FROM orders o";
    const blocks = parseSqlQueryBlocks(
      sql,
      { start: 0, end: sql.length },
      "postgres"
    );
    const compound = blocks.find((candidate) => candidate.kind === "compound")!;
    const branches = compound.setBranchIds!.map(
      (id) => blocks.find((candidate) => candidate.id === id)!
    );
    const byRelation = new Map(
      branches.map((branch, index) => [
        branch.from[0].id,
        [
          {
            name: "id",
            source: { relationId: branch.from[0].id, column: "id" },
          },
          ...(index === 0
            ? []
            : [
                {
                  name: "user_id",
                  source: { relationId: branch.from[0].id, column: "user_id" },
                },
              ]),
        ],
      ])
    );
    expect(
      combineSqlSetProjection(
        branches.map((branch) =>
          inferSqlProjection(branch, (id) => byRelation.get(id), "postgres")
        )
      )
    ).toEqual({
      columns: [
        {
          name: "first",
          quoted: false,
          source: { relationId: branches[0].from[0].id, column: "id" },
        },
      ],
      complete: true,
    });
  });
});
