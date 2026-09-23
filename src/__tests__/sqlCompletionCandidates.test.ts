import { describe, expect, it } from "vitest";
import type { SqlDialect, SqlSchema } from "../utils/sqlCompletion";
import type {
  RelationSymbol,
  QueryScope,
  SqlCompletionContext,
} from "../utils/sqlCompletionTypes";
import { analyzeSqlCompletion } from "../utils/sqlCompletionContext";
import { resolveSqlCompletionScopes } from "../utils/sqlCompletionScopes";
import { buildSqlMetadataIndex } from "../utils/sqlCompletionMetadataIndex";
import { generateSqlCompletionCandidates } from "../utils/sqlCompletionCandidates";
import {
  completionKey,
  completionSchema,
} from "./fixtures/sqlCompletionFixtures";

const users: RelationSymbol = {
  id: "q:1",
  kind: "table",
  name: "users",
  alias: "u",
};
const orders: RelationSymbol = {
  id: "q:2",
  kind: "table",
  name: "orders",
  alias: "o",
};
function context(
  overrides: Partial<SqlCompletionContext> = {},
  relations = [users]
): SqlCompletionContext {
  return {
    dialect: "mysql",
    defaultNamespace: "app",
    statement: { start: 0, end: 0 },
    scopeId: "q",
    clause: "where",
    slot: "column",
    prefix: "",
    qualifierParts: [],
    edit: { start: 0, end: 0 },
    scopes: [{ id: "q", relations, projections: [], canCorrelate: false }],
    confidence: "high",
    excludedColumns: [],
    ...overrides,
  };
}
function candidates(ctx = context(), schema = completionSchema) {
  return generateSqlCompletionCandidates(
    ctx,
    buildSqlMetadataIndex(schema, { ...completionKey, dialect: ctx.dialect })
  );
}
function columns(ctx = context(), schema = completionSchema) {
  return candidates(ctx, schema).filter((item) => item.kind === "column");
}

describe("二期查询作用域候选", () => {
  const scope = (
    id: string,
    relations: RelationSymbol[] = [],
    extra: Partial<QueryScope> = {}
  ): QueryScope => ({
    id,
    relations,
    projections: [],
    canCorrelate: false,
    ...extra,
  });
  const virtual = (extra: Partial<RelationSymbol> = {}): RelationSymbol => ({
    id: "derived",
    kind: "derived",
    name: "derived",
    alias: "D",
    outputColumns: [{ name: "k" }],
    outputComplete: true,
    ...extra,
  });
  const dialects: SqlDialect[] = [
    "mysql",
    "postgres",
    "sqlite",
    "sqlserver",
    "clickhouse",
  ];
  const clauses = [
    "select",
    "where",
    "groupBy",
    "having",
    "orderBy",
    "on",
  ] as const;
  const allowed: Record<SqlDialect, readonly string[]> = {
    mysql: ["groupBy", "having", "orderBy"],
    postgres: ["groupBy", "orderBy"],
    sqlite: ["orderBy"],
    sqlserver: ["orderBy"],
    clickhouse: ["select", "where", "groupBy", "having", "orderBy"],
  };
  it.each(
    dialects.flatMap((dialect) =>
      clauses.map((clause) => ({ dialect, clause }))
    )
  )("$dialect 的 $clause 投影别名策略", ({ dialect, clause }) => {
    const ctx = context({
      dialect,
      clause,
      scopes: [
        scope("q", [users], {
          projections: [{ name: "renamed" }],
          projectionComplete: true,
        }),
      ],
    });
    expect(candidates(ctx).some((item) => item.label === "renamed")).toBe(
      allowed[dialect].includes(clause)
    );
  });
  it("逐跳应用父块可见 id，保留祖父块相关关系", () => {
    const ctx = context({
      scopeId: "inner",
      scopes: [
        scope("q", [users, { ...users, id: "hidden", alias: "hidden" }]),
        scope("middle", [orders], {
          parentId: "q",
          canCorrelate: true,
          visibleParentRelationIds: [users.id],
        }),
        scope("inner", [], {
          parentId: "middle",
          canCorrelate: true,
          visibleParentRelationIds: [orders.id],
        }),
      ],
    });
    expect(columns(ctx).map((item) => item.label)).toEqual([
      "u.id",
      "o.id",
      "u.name",
      "o.user_id",
    ]);
    expect(
      candidates({ ...ctx, qualifierParts: ["u"] }).map(
        (item) => item.insertText
      )
    ).toEqual(["`id`", "`name`"]);
  });
  it.each([false, true])(
    "没有父级 id 列表时不泄漏父级，canCorrelate=%s",
    (canCorrelate) => {
      const ctx = context({
        scopeId: "inner",
        scopes: [
          scope("q", [users]),
          scope("inner", [], { parentId: "q", canCorrelate }),
        ],
      });
      expect(columns(ctx)).toEqual([]);
    }
  );
  it("普通派生表不相关，当前块别名遮蔽父块同名别名", () => {
    const ctx = context({
      scopeId: "inner",
      scopes: [
        scope("q", [users]),
        scope("inner", [{ ...orders, alias: "u" }], {
          parentId: "q",
          canCorrelate: true,
          visibleParentRelationIds: [users.id],
        }),
      ],
    });
    expect(columns(ctx).map((item) => item.label)).toEqual([
      "u.id",
      "u.user_id",
    ]);
    ctx.scopes[1].canCorrelate = false;
    ctx.scopes[1].relations = [];
    expect(columns(ctx)).toEqual([]);
  });
  it("点号限定优先绑定别名，再绑定未取别名的关系名", () => {
    const ctx = context({ qualifierParts: ["orders"] }, [
      { ...users, alias: "orders" },
      { ...orders, alias: undefined },
    ]);
    expect(columns(ctx).map((item) => item.filterText)).toEqual(["id", "name"]);
  });
  it("JOIN 只限制当前块，相关父块仍可访问且不带入其投影别名", () => {
    const ctx = context({
      scopeId: "inner",
      clause: "on",
      slot: "joinCondition",
      join: {
        leftRelationIds: [orders.id],
        rightRelationId: "right",
        conditionState: "empty",
      },
      scopes: [
        scope("q", [users], {
          projections: [{ name: "outer_alias" }],
          projectionComplete: true,
        }),
        scope(
          "inner",
          [
            orders,
            { ...users, id: "right", alias: "r" },
            { ...users, id: "future", alias: "f" },
          ],
          {
            parentId: "q",
            canCorrelate: true,
            visibleParentRelationIds: [users.id],
          }
        ),
      ],
    });
    expect(columns(ctx).map((item) => item.label)).toContain("u.id");
    expect(columns(ctx).some((item) => item.label.startsWith("f."))).toBe(
      false
    );
    expect(candidates(ctx).some((item) => item.label === "outer_alias")).toBe(
      false
    );
  });
  it("虚拟关系必须完整，重复输出列过滤，SQL 名称按引用位插入", () => {
    expect(columns(context({}, [virtual({ outputComplete: false })]))).toEqual(
      []
    );
    expect(
      columns(context({}, [virtual({ outputComplete: undefined })]))
    ).toEqual([]);
    const relation = virtual({
      outputColumns: [{ name: "id" }, { name: "id" }, { name: "k" }],
    });
    expect(
      columns(context({ dialect: "postgres" }, [relation])).map(
        (item) => item.insertText
      )
    ).toEqual(['"d"."k"']);
    expect(
      columns(
        context({ dialect: "postgres" }, [{ ...relation, aliasQuoted: true }])
      )[0].insertText
    ).toBe('"D"."k"');
    expect(
      columns(
        context({ dialect: "postgres", qualifierParts: ["d"] }, [relation])
      )[0].insertText
    ).toBe('"k"');
    expect(
      columns(
        context({ dialect: "postgres" }, [
          virtual({ outputColumns: [{ name: "K", quoted: true }] }),
        ])
      )[0].insertText
    ).toBe('"d"."K"');
    expect(
      columns(
        context({ dialect: "postgres" }, [
          virtual({
            outputColumns: [
              {
                name: "ID",
                quoted: false,
                source: { relationId: "source", column: "ID" },
              },
            ],
          }),
        ])
      )[0].insertText
    ).toBe('"d"."ID"');
  });
  it("当前 CTE 表名遮蔽物理表，显式 namespace 仍指向物理表", () => {
    const ctx = context({
      slot: "table",
      clause: "from",
      scopes: [
        scope("q", [], {
          ctes: [
            { id: "cte", kind: "cte", name: "users" },
            { id: "extra", kind: "cte", name: "Extra" },
          ],
        }),
      ],
    });
    const items = candidates(ctx);
    expect(items.filter((item) => item.label === "users")).toHaveLength(1);
    expect(items.find((item) => item.label === "users")?.detail).toBe("CTE");
    expect(items.some((item) => item.label === "Extra")).toBe(true);
    expect(
      candidates({ ...ctx, qualifierParts: ["app"] }).find(
        (item) => item.label === "users"
      )?.detail
    ).toBe("表 / 视图");
  });
  it("投影别名冲突或重复时保留真实列，不给出歧义别名", () => {
    const ctx = context({
      dialect: "clickhouse",
      clause: "where",
      scopes: [
        scope("q", [users], {
          projections: [{ name: "id" }, { name: "dup" }, { name: "dup" }],
          projectionComplete: true,
        }),
      ],
    });
    expect(columns(ctx).map((item) => item.label)).toEqual(["u.id", "u.name"]);
    ctx.dialect = "postgres";
    ctx.clause = "groupBy";
    expect(columns(ctx).map((item) => item.label)).toEqual(["u.id", "u.name"]);
  });
  it("不完整投影仍可提供 resolver 已确认的 ClickHouse 同块别名", () => {
    const ctx = context({
      dialect: "clickhouse",
      clause: "select",
      scopes: [
        scope("q", [users], {
          projections: [{ name: "confirmed" }],
          projectionComplete: false,
        }),
      ],
    });
    expect(candidates(ctx).some((item) => item.label === "confirmed")).toBe(
      true
    );
  });
});

describe("SQL 元数据索引与候选", () => {
  it("保留大小写不同的精确索引键", () => {
    const schema: SqlSchema = {
      databases: [],
      tables: [{ name: "Users" }, { name: "users" }],
      columns: [
        { table: "Users", name: "ID" },
        { table: "users", name: "id" },
      ],
    };
    const index = buildSqlMetadataIndex(schema, completionKey);
    expect([...index.tablesByName.keys()]).toEqual(["Users", "users"]);
    expect(index.columnsByTable.get("Users")?.map((c) => c.name)).toEqual([
      "ID",
    ]);
  });
  it("限定符只插入当前 token，保持已有引用", () => {
    const sql = "SELECT * FROM users u WHERE u.na";
    const ctx = context({
      prefix: "na",
      qualifierParts: ["u"],
      edit: { start: sql.length - 2, end: sql.length },
    });
    const items = columns(ctx);
    expect(items.map((item) => item.insertText)).toEqual(["`name`"]);
    expect(
      sql.slice(0, ctx.edit.start) +
        items[0].insertText +
        sql.slice(ctx.edit.end)
    ).toBe("SELECT * FROM users u WHERE u.`name`");
    expect(items[0].filterText).toBe("name");
  });
  it.each<SqlDialect>([
    "mysql",
    "postgres",
    "sqlite",
    "sqlserver",
    "clickhouse",
  ])("%s 使用方言引用", (dialect) => {
    const expected =
      dialect === "sqlserver"
        ? "[name]"
        : ["postgres", "sqlite"].includes(dialect)
          ? '"name"'
          : "`name`";
    expect(columns(context({ dialect, prefix: "na" }))[0].insertText).toBe(
      expected
    );
  });
  it("单表只提供当前关系字段", () => {
    expect(columns().map((item) => item.insertText)).toEqual([
      "`id`",
      "`name`",
    ]);
  });
  it("多表同名字段使用别名，无歧义字段保持裸引用", () => {
    expect(
      columns(context({}, [users, orders])).map((item) => item.insertText)
    ).toEqual(["`u`.`id`", "`o`.`id`", "`name`", "`user_id`"]);
  });
  it("自关联保留两个关系身份", () => {
    const items = columns(
      context({}, [users, { ...users, id: "q:3", alias: "manager" }])
    );
    expect(items.map((item) => item.insertText)).toEqual([
      "`u`.`id`",
      "`manager`.`id`",
      "`u`.`name`",
      "`manager`.`name`",
    ]);
    expect(new Set(items.map((item) => item.sortText)).size).toBe(4);
  });
  it("别名存在时，物理表限定符无效", () => {
    expect(candidates(context({ qualifierParts: ["users"] }))).toEqual([]);
    expect(candidates(context({ qualifierParts: ["missing"] }))).toEqual([]);
  });
  it("PostgreSQL 未引用别名仅折叠 ASCII，引用别名保留大小写", () => {
    const relations = [
      { ...users, alias: "U" },
      { ...orders, alias: "O" },
    ];
    expect(
      columns(context({ dialect: "postgres", prefix: "id" }, relations)).map(
        (i) => i.insertText
      )
    ).toEqual(['"u"."id"', '"o"."id"', '"user_id"']);
    expect(
      columns(
        context({ dialect: "postgres", prefix: "id" }, [
          { ...relations[0], aliasQuoted: true },
          relations[1],
        ])
      )[0].insertText
    ).toBe('"U"."id"');
    expect(
      columns(
        context(
          {
            dialect: "postgres",
            qualifierParts: ["U"],
            qualifierQuoted: [true],
          },
          relations
        )
      )
    ).toEqual([]);
    expect(
      columns(
        context({ dialect: "postgres", qualifierParts: ["u"] }, relations)
      )
    ).toHaveLength(2);
    expect(
      columns(
        context({ dialect: "postgres", qualifierParts: ["ä"] }, [
          { ...users, alias: "Ä" },
        ])
      )
    ).toEqual([]);
  });
  it("PostgreSQL catalog 大小写严格绑定", () => {
    const schema = {
      ...completionSchema,
      tables: [{ name: "Users" }],
      columns: [{ table: "Users", name: "ID" }],
    };
    expect(
      columns(
        context({ dialect: "postgres" }, [{ ...users, name: "Users" }]),
        schema
      )
    ).toEqual([]);
    expect(
      columns(
        context({ dialect: "postgres" }, [
          { ...users, name: "Users", nameQuoted: true },
        ]),
        schema
      )[0].insertText
    ).toBe('"ID"');
  });
  it("大小写不敏感回退只接受唯一命中，精确命中优先", () => {
    const schema = {
      ...completionSchema,
      tables: [{ name: "Users" }, { name: "users" }],
      columns: [
        { table: "Users", name: "upper" },
        { table: "users", name: "lower" },
      ],
    };
    expect(columns(context({}, [{ ...users, name: "USERS" }]), schema)).toEqual(
      []
    );
    expect(
      columns(context({}, [{ ...users, name: "Users" }]), schema).map(
        (i) => i.filterText
      )
    ).toEqual(["upper"]);
    expect(
      columns(context({}, [{ ...users, name: "USERS" }]), completionSchema)
    ).toHaveLength(2);
  });
  it("限定的 namespace 必须匹配当前元数据", () => {
    expect(columns(context({}, [{ ...users, namespace: "other" }]))).toEqual(
      []
    );
    expect(columns(context({}, [{ ...users, namespace: "app" }]))).toHaveLength(
      2
    );
    expect(
      columns(
        context({ qualifierParts: ["app", "users"] }, [
          { ...users, alias: undefined },
        ])
      )
    ).toHaveLength(2);
    expect(
      columns(
        context({ qualifierParts: ["other", "users"] }, [
          { ...users, alias: undefined },
        ])
      )
    ).toEqual([]);
    expect(columns(context({ defaultNamespace: "other" }))).toEqual([]);
  });
  it("FROM 只提示表和 namespace，未知 namespace 不扩展其他库", () => {
    expect(
      new Set(
        candidates(context({ slot: "table", clause: "from" })).map(
          (i) => i.kind
        )
      )
    ).toEqual(new Set(["table", "relation"]));
    expect(
      candidates(
        context({ slot: "table", clause: "from", qualifierParts: ["app"] })
      ).map((i) => i.kind)
    ).toEqual(["table", "table"]);
    expect(
      candidates(
        context({ slot: "table", clause: "from", qualifierParts: ["other"] })
      )
    ).toEqual([]);
  });
  it("仅当前 scope 的物理关系可见，派生关系不绑定物理同名表", () => {
    const ctx = context({
      scopes: [
        {
          id: "q",
          relations: [{ ...users, kind: "derived" }],
          projections: [],
          canCorrelate: false,
        },
        {
          id: "inner",
          parentId: "q",
          relations: [orders],
          projections: [],
          canCorrelate: false,
        },
      ],
    });
    expect(columns(ctx)).toEqual([]);
  });
  it("ON 只使用指定 JOIN 当前可见的两侧", () => {
    const ctx = context(
      {
        slot: "joinCondition",
        clause: "on",
        join: {
          leftRelationIds: [users.id],
          rightRelationId: orders.id,
          conditionState: "empty",
        },
      },
      [users, orders, { ...users, id: "future", alias: "future" }]
    );
    expect(columns(ctx)).toHaveLength(4);
    expect(columns(ctx).some((i) => i.detail?.includes("future"))).toBe(false);
  });
  it.each(["set", "insertColumns"] as const)(
    "%s 列列表排除已经写出的字段",
    (clause) => {
      expect(
        candidates(
          context({ slot: "columnList", clause, excludedColumns: ["id"] })
        ).map((i) => i.insertText)
      ).toEqual(["`name`"]);
    }
  );
  it("每个槽位使用小型允许集，未知字段仍有表达式建议", () => {
    const continuation = candidates(
      context({ slot: "continuation", clause: "from" })
    );
    expect(continuation.every((i) => i.kind === "keyword")).toBe(true);
    expect(continuation.map((i) => i.label)).toEqual(
      expect.arrayContaining(["AS", "WHERE", "JOIN"])
    );
    const expressions = candidates(context({}, []));
    expect(expressions.map((i) => i.label)).toEqual(
      expect.arrayContaining(["NULL", "COALESCE"])
    );
    expect(
      expressions.some((i) => ["CREATE", "TABLE", "VARCHAR"].includes(i.label))
    ).toBe(false);
    expect(
      candidates(context({ slot: "keyword" })).map((i) => i.label)
    ).toEqual(expect.arrayContaining(["IN", "LIKE", "IS NULL"]));
    expect(candidates(context({ slot: "none" }))).toEqual([]);
  });
  it("WHERE/ON/SET 表达式只允许标量函数，聚合函数用于投影和HAVING", () => {
    for (const clause of ["where", "on", "set", "values"] as const) {
      const labels = candidates(context({ clause })).map((i) => i.label);
      expect(labels).toContain("COALESCE");
      expect(labels).not.toContain("SUM");
    }
    expect(
      candidates(context({ clause: "select" })).map((i) => i.label)
    ).toContain("SUM");
    expect(
      candidates(context({ clause: "having" })).map((i) => i.label)
    ).toContain("COUNT");
  });
  it.each<SqlDialect>(["mysql", "sqlserver", "sqlite"])(
    "%s 引用不能掩盖未知大小写配置导致的歧义",
    (dialect) => {
      const schema = {
        ...completionSchema,
        tables: [{ name: "Users" }, { name: "users" }],
        columns: [
          { table: "Users", name: "ID" },
          { table: "users", name: "id" },
        ],
      };
      expect(
        columns(
          context({ dialect }, [{ ...users, name: "USERS", nameQuoted: true }]),
          schema
        )
      ).toEqual([]);
    }
  );
  it("ClickHouse 大小写不同的表名不猜测绑定", () => {
    expect(
      columns(context({ dialect: "clickhouse" }, [{ ...users, name: "USERS" }]))
    ).toEqual([]);
  });
  it("PostgreSQL namespace 按引用规则匹配", () => {
    expect(
      columns(
        context({ dialect: "postgres" }, [{ ...users, namespace: "APP" }])
      )
    ).toHaveLength(2);
    expect(
      columns(
        context({ dialect: "postgres" }, [
          { ...users, namespace: "APP", namespaceQuoted: true },
        ])
      )
    ).toEqual([]);
    expect(
      columns(context({ dialect: "postgres" }, [{ ...users, name: "ÜSERS" }]), {
        ...completionSchema,
        tables: [{ name: "Üsers" }],
        columns: [{ table: "Üsers", name: "Name" }],
      })[0].insertText
    ).toBe('"Name"');
  });
  it("SQL Server 三段限定符保守降级", () => {
    expect(
      candidates(
        context({
          dialect: "sqlserver",
          qualifierParts: ["app", "dbo", "users"],
        })
      )
    ).toEqual([]);
  });
  it("先匹配前缀再匹配包含，候选排序稳定", () => {
    const schema = {
      ...completionSchema,
      columns: [
        { table: "users", name: "other_name" },
        { table: "users", name: "name" },
      ],
    };
    const result = columns(context({ prefix: "na" }), schema);
    expect(result.map((i) => i.filterText)).toEqual(["name", "other_name"]);
    expect(
      [...result].sort((a, b) => a.sortText.localeCompare(b.sortText))
    ).toEqual(result);
  });
});

describe("上下文到候选的行为表", () => {
  function fromSql(
    marked: string,
    dialect: SqlDialect = "mysql",
    schema = completionSchema
  ) {
    const offset = marked.indexOf("|");
    const sql = marked.replace("|", "");
    const ctx = analyzeSqlCompletion({ sql, offset, dialect });
    ctx.defaultNamespace = "app";
    return { sql, ctx, items: candidates(ctx, schema) };
  }
  it.each([
    ["SELECT * FROM |", []],
    ["SELECT * FROM users u |", []],
    ["SELECT * FROM users u WHERE |", ["id", "name"]],
    ["SELECT * FROM users u WHERE u.na|", ["name"]],
    ["SELECT | FROM users u", ["id", "name"]],
    [
      "SELECT * FROM users u JOIN orders o ON |",
      ["id", "id", "name", "user_id"],
    ],
    ["UPDATE users SET |", ["id", "name"]],
    ["UPDATE users SET id = 1, |", ["name"]],
    ["UPDATE users SET id = |", ["id", "name"]],
    ["INSERT INTO users (|)", ["id", "name"]],
    ["INSERT INTO users (id, |)", ["name"]],
    ["SELECT * FROM users; SELECT * FROM orders WHERE |", ["id", "user_id"]],
    ["SELECT * FROM users WHERE id |", []],
    ["SELECT * FROM users GROUP BY |", ["id", "name"]],
    ["SELECT * FROM users HAVING |", ["id", "name"]],
    ["SELECT * FROM users ORDER BY |", ["id", "name"]],
    ["DELETE FROM users WHERE |", ["id", "name"]],
    ["SELECT * FROM users WHERE 'u.na|", []],
    ["SELECT * FROM users -- u.na|", []],
    ["SELECT * FROM users u WHERE missing.|", []],
    ["SELECT * FROM other.users u WHERE u.|", []],
  ])("%s", (sql, expected) => {
    expect(
      fromSql(sql)
        .items.filter((i) => i.kind === "column")
        .map((i) => i.filterText)
    ).toEqual(expected);
  });
  it.each<SqlDialect>([
    "mysql",
    "postgres",
    "sqlite",
    "sqlserver",
    "clickhouse",
  ])("%s 实际限定字段接受文本", (dialect) => {
    const { sql, ctx, items } = fromSql(
      "SELECT * FROM users u WHERE u.na|",
      dialect
    );
    const accepted =
      sql.slice(0, ctx.edit.start) +
      items[0].insertText +
      sql.slice(ctx.edit.end);
    const quoted =
      dialect === "sqlserver"
        ? "[name]"
        : ["postgres", "sqlite"].includes(dialect)
          ? '"name"'
          : "`name`";
    expect(accepted).toBe(`SELECT * FROM users u WHERE u.${quoted}`);
  });
  it("无元数据时保留合法基础建议，空表不会泄漏字段", () => {
    const empty = { databases: [], tables: [], columns: [] };
    expect(
      fromSql("SELECT * FROM users WHERE |", "mysql", empty).items.map(
        (i) => i.label
      )
    ).toContain("COALESCE");
    expect(fromSql("SELECT * FROM |", "mysql", empty).items).toEqual([]);
    expect(
      fromSql("SELECT * FROM users WHERE |", "mysql", {
        ...completionSchema,
        columns: [],
      }).items.every((i) => i.kind !== "column")
    ).toBe(true);
  });
  it("PostgreSQL 大写别名接受引用正确且现有限定符不改写", () => {
    expect(
      fromSql("SELECT * FROM users U JOIN orders O ON |", "postgres")
        .items.filter((i) => i.filterText === "id")
        .map((i) => i.insertText)
    ).toEqual(['"u"."id"', '"o"."id"']);
    expect(
      fromSql(
        'SELECT * FROM users "U" JOIN orders O ON |',
        "postgres"
      ).items.filter((i) => i.filterText === "id")[0].insertText
    ).toBe('"U"."id"');
    const { sql, ctx, items } = fromSql(
      'SELECT * FROM users "U" WHERE "U".na|',
      "postgres"
    );
    expect(
      sql.slice(0, ctx.edit.start) +
        items[0].insertText +
        sql.slice(ctx.edit.end)
    ).toBe('SELECT * FROM users "U" WHERE "U"."name"');
  });
});

describe("组合边界回归", () => {
  it("显式命名空间先排除其他库同名关系", () => {
    const sql = "SELECT * FROM app.users JOIN other.users ON app.users.";
    const ctx = analyzeSqlCompletion({
      sql,
      offset: sql.length,
      dialect: "mysql",
    });
    ctx.defaultNamespace = "app";
    expect(columns(ctx).map((item) => item.insertText)).toEqual([
      "`id`",
      "`name`",
    ]);
  });
  it.each([
    ["NOT", ["BETWEEN", "IN", "LIKE"]],
    ["IS", ["FALSE", "NULL", "TRUE"]],
    ["IS NOT", ["FALSE", "NULL", "TRUE"]],
  ] as const)("%s 后只推荐运算符的合法后半部分", (operator, expected) => {
    const sql = `SELECT * FROM users WHERE id ${operator} `;
    const ctx = analyzeSqlCompletion({
      sql,
      offset: sql.length,
      dialect: "mysql",
    });
    expect(
      candidates(ctx)
        .map((item) => item.insertText)
        .sort()
    ).toEqual(expected);
  });
});

describe("二期实际 SQL 到候选集成", () => {
  function scoped(
    marked: string,
    dialect: SqlDialect = "postgres",
    defaultNamespace: string | null = "app",
    schema = completionSchema
  ) {
    const offset = marked.indexOf("|");
    const sql = marked.replace("|", "");
    const base = analyzeSqlCompletion({ sql, offset, dialect });
    base.defaultNamespace = defaultNamespace;
    const index = buildSqlMetadataIndex(schema, { ...completionKey, dialect });
    const ctx = resolveSqlCompletionScopes({
      sql,
      offset,
      context: base,
      index,
    });
    return generateSqlCompletionCandidates(ctx, index);
  }
  const dialects: SqlDialect[] = [
    "mysql",
    "postgres",
    "sqlite",
    "sqlserver",
    "clickhouse",
  ];
  it.each(dialects)("%s 通过真实 SQL 解析限制别名跨子句", (dialect) => {
    const allowed = {
      mysql: ["GROUP BY", "HAVING", "ORDER BY"],
      postgres: ["GROUP BY", "ORDER BY"],
      sqlite: ["ORDER BY"],
      sqlserver: ["ORDER BY"],
      clickhouse: ["WHERE", "GROUP BY", "HAVING", "ORDER BY"],
    };
    for (const clause of [
      "WHERE",
      "GROUP BY",
      "HAVING",
      "ORDER BY",
      "JOIN orders o ON",
    ]) {
      expect(
        scoped(`SELECT id AS renamed FROM users ${clause} |`, dialect).some(
          (item) => item.label === "renamed"
        ),
        clause
      ).toBe(allowed[dialect].includes(clause));
    }
  });
  it.each([
    [
      "SELECT * FROM users u WHERE EXISTS (SELECT u.| FROM orders o)",
      ["id", "name"],
    ],
    ["SELECT * FROM users u, (SELECT u.|) d", []],
    ["SELECT * FROM users u, LATERAL (SELECT u.|) d, orders o", ["id", "name"]],
    ["SELECT * FROM users u, LATERAL (SELECT o.|) d, orders o", []],
    [
      "SELECT * FROM (SELECT u.*, o.* FROM users u JOIN orders o ON u.id=o.user_id) d WHERE d.|",
      ["name", "user_id"],
    ],
    ["SELECT * FROM (SELECT id AS renamed, FROM users) d WHERE d.|", []],
    ["SELECT * FROM other.users x WHERE x.|", []],
    ["SELECT * FROM users u WHERE EXISTS (SELECT 'u.|' FROM orders)", []],
    ["SELECT * FROM users u WHERE EXISTS (SELECT 1 -- u.|\n FROM orders)", []],
  ] as const)("%s 的列可见性", (sql, names) => {
    expect(
      scoped(sql)
        .filter((item) => item.kind === "column")
        .map((item) => item.filterText)
    ).toEqual(names);
  });
  it("虚拟输出与关系引用分别处理 PostgreSQL 大小写", () => {
    expect(
      scoped("SELECT * FROM (SELECT id AS K FROM users) D WHERE |").find(
        (item) => item.label === "D.k"
      )?.insertText
    ).toBe('"d"."k"');
    expect(
      scoped('SELECT * FROM (SELECT id AS K FROM users) "D" WHERE |').find(
        (item) => item.label === "D.k"
      )?.insertText
    ).toBe('"D"."k"');
    const schema = {
      ...completionSchema,
      columns: [{ table: "users", name: "ID" }],
    };
    expect(
      scoped(
        'SELECT * FROM (SELECT "ID" FROM users) d WHERE d.|',
        "postgres",
        "app",
        schema
      ).map((item) => item.insertText)
    ).toEqual(['"ID"']);
  });
  it("未知默认 namespace 不允许把显式 namespace 猜配到索引", () => {
    expect(
      scoped("SELECT * FROM app.users u WHERE u.|", "postgres", null)
    ).toEqual([]);
  });
  it("未知来源可能包含同名列，已知关系列必须限定", () => {
    expect(
      scoped("SELECT * FROM users u JOIN unknown_source z ON |")
        .filter((item) => item.kind === "column")
        .map((item) => item.insertText)
    ).toEqual(['"u"."id"', '"u"."name"']);
    expect(
      columns(context({}, [users, { ...orders, name: "unknown_source" }])).map(
        (item) => item.insertText
      )
    ).toEqual(["`u`.`id`", "`u`.`name`"]);
  });
  it("同名无别名关系的限定名不唯一时不产生列候选", () => {
    expect(
      scoped("SELECT * FROM users JOIN users ON |").filter(
        (item) => item.kind === "column"
      )
    ).toEqual([]);
    expect(scoped("SELECT * FROM users JOIN users ON users.|")).toEqual([]);
    expect(
      scoped("SELECT * FROM users a JOIN users b ON |")
        .filter((item) => item.kind === "column")
        .map((item) => item.insertText)
    ).toEqual(['"a"."id"', '"b"."id"', '"a"."name"', '"b"."name"']);
  });
  it("CTE 提示与虚拟输出来自当前词法块", () => {
    expect(
      scoped(
        "WITH recent AS (SELECT id AS uid FROM users) SELECT * FROM |"
      ).map((item) => item.label)
    ).toContain("recent");
    expect(
      scoped(
        "WITH recent AS (SELECT id AS uid FROM users) SELECT * FROM recent r WHERE r.|"
      ).map((item) => item.insertText)
    ).toEqual(['"uid"']);
    expect(
      scoped(
        "WITH recent AS (SELECT id AS uid FROM users) SELECT 1; SELECT * FROM |"
      ).map((item) => item.label)
    ).not.toContain("recent");
  });
  it("ClickHouse COLUMNS 输出不产生猜测列", () => {
    expect(
      scoped(
        "SELECT * FROM (SELECT COLUMNS('.*') FROM users) d WHERE d.|",
        "clickhouse"
      )
    ).toEqual([]);
  });
  it("ClickHouse 简单 SELECT 编辑项可用已完成项别名", () => {
    expect(
      scoped("SELECT id AS renamed, | FROM users", "clickhouse").some(
        (item) => item.label === "renamed"
      )
    ).toBe(true);
  });
  it.each([
    "SELECT COLUMNS('.*') AS renamed FROM users WHERE |",
    "SELECT row_number() OVER () AS renamed FROM users WHERE |",
  ])("ClickHouse 复杂投影不提供同块别名：%s", (sql) => {
    expect(
      scoped(sql, "clickhouse").some((item) => item.label === "renamed")
    ).toBe(false);
  });
});
