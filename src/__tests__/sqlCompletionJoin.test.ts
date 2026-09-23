import { describe, expect, it } from "vitest";
import type { SqlCompletionForeignKey } from "../types";
import type {
  SqlCompletionContext,
  RelationSymbol,
} from "../utils/sqlCompletionTypes";
import { buildJoinCandidates } from "../utils/sqlCompletionJoin";
import { analyzeSqlCompletion } from "../utils/sqlCompletionContext";
import { resolveSqlCompletionScopes } from "../utils/sqlCompletionScopes";
import { buildSqlMetadataIndex } from "../utils/sqlCompletionMetadataIndex";

const fk: SqlCompletionForeignKey = {
  id: "sales.orders/fk_customer",
  constraintName: "fk_customer",
  tableNamespace: "sales",
  tableName: "orders",
  columns: ["customer_id"],
  referencedNamespace: "sales",
  referencedTable: "customers",
  referencedColumns: ["id"],
};

function context(
  left: RelationSymbol,
  right: RelationSymbol,
  patch: Partial<SqlCompletionContext> = {}
): SqlCompletionContext {
  return {
    dialect: "postgres",
    defaultNamespace: "sales",
    statement: { start: 0, end: 1 },
    scopeId: "q1",
    clause: "on",
    slot: "joinCondition",
    prefix: "",
    qualifierParts: [],
    edit: { start: 1, end: 1 },
    scopes: [
      {
        id: "q1",
        canCorrelate: false,
        projections: [],
        relations: [left, right],
      },
    ],
    confidence: "high",
    join: {
      leftRelationIds: [left.id],
      rightRelationId: right.id,
      conditionState: "empty",
    },
    excludedColumns: [],
    ...patch,
  };
}
const orders: RelationSymbol = {
  id: "r1",
  kind: "table",
  name: "orders",
  alias: "o",
  namespace: "sales",
};
const customers: RelationSymbol = {
  id: "r2",
  kind: "table",
  name: "customers",
  alias: "c",
  namespace: "sales",
};
const insertions = (
  ctx: SqlCompletionContext,
  keys: SqlCompletionForeignKey[]
) => buildJoinCandidates(ctx, keys).map((candidate) => candidate.insertText);

describe("真实外键 JOIN 候选", () => {
  it("分析器经作用域到候选的完整路径跳过 CTE 左表并匹配跨 schema FK", () => {
    const marked =
      "WITH x AS (SELECT user_id FROM orders) SELECT * FROM x JOIN sales.orders o ON x.user_id=o.user_id JOIN auth.users u ON |";
    const offset = marked.indexOf("|");
    const sql = marked.replace("|", "");
    const base = analyzeSqlCompletion({ sql, offset, dialect: "postgres" });
    base.defaultNamespace = "sales";
    const index = buildSqlMetadataIndex(
      {
        databases: ["sales"],
        tables: [{ name: "orders" }],
        columns: [{ table: "orders", name: "user_id" }],
      },
      {
        connId: "c1",
        database: "sales",
        dialect: "postgres",
        connectionRevision: 0,
      }
    );
    const resolved = resolveSqlCompletionScopes({
      sql,
      offset,
      context: base,
      index,
    });
    const cross: SqlCompletionForeignKey = {
      id: "sales.orders/fk_user",
      constraintName: "fk_user",
      tableNamespace: "sales",
      tableName: "orders",
      columns: ["user_id"],
      referencedNamespace: "auth",
      referencedTable: "users",
      referencedColumns: ["id"],
    };
    expect(insertions(resolved, [cross])).toEqual(['"o"."user_id" = "u"."id"']);
  });
  it("按子列和父列生成条件，反向 JOIN 保持左侧先写", () => {
    expect(insertions(context(orders, customers), [fk])).toEqual([
      '"o"."customer_id" = "c"."id"',
    ]);
    expect(insertions(context(customers, orders), [fk])).toEqual([
      '"c"."id" = "o"."customer_id"',
    ]);
  });
  it("复合列按序号配对并为每条约束保留独立候选", () => {
    const composite = {
      ...fk,
      id: "fk_composite",
      constraintName: "fk_composite",
      columns: ["customer_id", "tenant_id"],
      referencedColumns: ["id", "tenant_id"],
    };
    expect(insertions(context(orders, customers), [composite])).toEqual([
      '("o"."customer_id" = "c"."id" AND "o"."tenant_id" = "c"."tenant_id")',
    ]);
    const candidates = buildJoinCandidates(context(orders, customers), [
      fk,
      {
        ...fk,
        id: "fk_billing",
        constraintName: "fk_billing",
        columns: ["billing_customer_id"],
      },
    ]);
    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.detail).join(" ")).toContain(
      "fk_billing"
    );
  });
  it("自关联保留两个方向和子表角色，无别名时拒绝", () => {
    const self = {
      ...fk,
      id: "employee_manager",
      tableName: "employees",
      referencedTable: "employees",
      columns: ["manager_id"],
    };
    const e: RelationSymbol = { ...orders, name: "employees", alias: "e" };
    const m: RelationSymbol = { ...customers, name: "employees", alias: "m" };
    const candidates = buildJoinCandidates(context(e, m), [self]);
    expect(candidates.map((candidate) => candidate.insertText)).toEqual([
      '"e"."manager_id" = "m"."id"',
      '"e"."id" = "m"."manager_id"',
    ]);
    expect(candidates[0].detail).toContain("e");
    expect(candidates[1].detail).toContain("m");
    expect(
      insertions(
        context({ ...e, alias: undefined }, { ...m, alias: undefined }),
        [self]
      )
    ).toEqual([]);
  });
  it("按完整 namespace 匹配，缺省 namespace 仅接受唯一实体", () => {
    expect(
      insertions(context({ ...orders, namespace: "archive" }, customers), [fk])
    ).toEqual([]);
    expect(
      insertions(
        context(
          { ...orders, namespace: undefined },
          { ...customers, namespace: undefined }
        ),
        [fk]
      )
    ).toHaveLength(1);
    const noDefault = context({ ...orders, namespace: undefined }, customers, {
      defaultNamespace: null,
    });
    expect(insertions(noDefault, [fk])).toHaveLength(1);
    expect(
      insertions(noDefault, [
        fk,
        { ...fk, id: "other", tableNamespace: "archive" },
      ])
    ).toEqual([]);
  });
  it("PG 引用名称精确匹配且未引用名称折叠小写", () => {
    const mixed = {
      ...fk,
      id: "mixed",
      tableName: "Orders",
      columns: ["CustomerID"],
    };
    const lower = { ...fk, id: "lower" };
    expect(
      insertions(
        context({ ...orders, name: "Orders", nameQuoted: true }, customers),
        [mixed, lower]
      )
    ).toEqual(['"o"."CustomerID" = "c"."id"']);
    expect(
      insertions(
        context({ ...orders, name: "Orders", nameQuoted: false }, customers),
        [mixed, lower]
      )
    ).toEqual(['"o"."customer_id" = "c"."id"']);
    expect(
      insertions(
        context(
          { ...orders, alias: "O", aliasQuoted: false },
          { ...customers, alias: "C", aliasQuoted: false }
        ),
        [fk]
      )
    ).toEqual(['"o"."customer_id" = "c"."id"']);
    expect(
      insertions(
        context(
          { ...orders, alias: "O", aliasQuoted: true },
          { ...customers, alias: "C", aliasQuoted: true }
        ),
        [fk]
      )
    ).toEqual(['"O"."customer_id" = "C"."id"']);
  });
  it.each(["mysql", "sqlserver"] as const)(
    "%s 大小写规则未知时拒绝折叠歧义",
    (dialect) => {
      const ambiguous = { ...fk, id: "mixed", tableName: "Orders" };
      expect(
        insertions(context(orders, customers, { dialect }), [fk, ambiguous])
      ).toEqual([]);
    }
  );
  it("SQLite 大小写不敏感名称仅在唯一命中时匹配", () => {
    const mixed = {
      ...fk,
      id: "mixed",
      tableName: "Orders",
      referencedTable: "Customers",
    };
    expect(
      insertions(context(orders, customers, { dialect: "sqlite" }), [mixed])
    ).toEqual(['"o"."customer_id" = "c"."id"']);
    expect(
      insertions(context(orders, customers, { dialect: "sqlite" }), [mixed, fk])
    ).toEqual([]);
  });
  it("拒绝非物理表、未知实例、已有表达式、低置信度和坏元数据", () => {
    const base = context(orders, customers);
    expect(
      insertions(context({ ...orders, kind: "cte" }, customers), [fk])
    ).toEqual([]);
    expect(
      insertions(context({ ...orders, kind: "derived" }, customers), [fk])
    ).toEqual([]);
    expect(
      insertions(
        context(orders, customers, {
          join: { ...base.join!, rightRelationId: "missing" },
        }),
        [fk]
      )
    ).toEqual([]);
    expect(
      insertions(context(orders, customers, { confidence: "partial" }), [fk])
    ).toEqual([]);
    expect(
      insertions(context(orders, customers, { slot: "column" }), [fk])
    ).toEqual([]);
    expect(
      insertions(
        context(orders, customers, {
          join: { ...base.join!, conditionState: "expression" },
        }),
        [fk]
      )
    ).toEqual([]);
    expect(insertions(base, [{ ...fk, referencedColumns: [] }])).toEqual([]);
    expect(
      insertions(
        context(orders, customers, { excludedColumns: ["customer_id"] }),
        [fk]
      )
    ).toHaveLength(1);
  });
  it("两个无别名同名表即使分属不同 schema 也拒绝歧义引用", () => {
    const cross = {
      ...fk,
      referencedNamespace: "archive",
      referencedTable: "orders",
      referencedColumns: ["id"],
    };
    expect(
      insertions(
        context(
          { ...orders, alias: undefined },
          {
            ...customers,
            name: "orders",
            namespace: "archive",
            alias: undefined,
          }
        ),
        [cross]
      )
    ).toEqual([]);
  });
  it("同一约束身份出现冲突元数据时拒绝候选", () => {
    expect(
      insertions(context(orders, customers), [
        fk,
        { ...fk, constraintName: "another" },
      ])
    ).toEqual([]);
  });
  it("标签展示约束且详情说明子父表和列对", () => {
    const candidate = buildJoinCandidates(context(orders, customers), [fk])[0];
    expect(candidate.label).toContain("fk_customer");
    expect(candidate.detail).toContain("orders.customer_id");
    expect(candidate.detail).toContain("customers.id");
  });
  it("多个左表只匹配真实关系，并稳定去重", () => {
    const unrelated: RelationSymbol = {
      id: "r0",
      kind: "table",
      name: "products",
      alias: "p",
      namespace: "sales",
    };
    const base = context(orders, customers);
    const multi = context(orders, customers, {
      scopes: [
        { ...base.scopes[0], relations: [unrelated, orders, customers] },
      ],
      join: {
        leftRelationIds: [unrelated.id, orders.id, orders.id],
        rightRelationId: customers.id,
        conditionState: "empty",
      },
    });
    expect(insertions(multi, [fk, fk])).toEqual([
      '"o"."customer_id" = "c"."id"',
    ]);
  });
});
