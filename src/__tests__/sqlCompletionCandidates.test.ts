import { describe, expect, it } from "vitest";
import type { SqlDialect, SqlSchema } from "../utils/sqlCompletion";
import type {
  RelationSymbol,
  SqlCompletionContext,
} from "../utils/sqlCompletionTypes";
import { analyzeSqlCompletion } from "../utils/sqlCompletionContext";
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
        join: { leftRelationIds: [users.id], rightRelationId: orders.id },
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
