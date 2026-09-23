import { describe, expect, it } from "vitest";
import { analyzeSqlCompletion } from "../utils/sqlCompletionContext";
import type { SqlDialect } from "../utils/sqlCompletion";

function context(marked: string, dialect: SqlDialect = "mysql") {
  const offset = marked.indexOf("|");
  return analyzeSqlCompletion({
    sql: marked.replace("|", ""),
    offset,
    dialect,
  });
}
function relations(marked: string, dialect: SqlDialect = "mysql") {
  const result = context(marked, dialect);
  return result.scopes.find((s) => s.id === result.scopeId)!.relations;
}

describe("SQL completion context", () => {
  it("uses FROM after cursor and preserves explicit/implicit aliases", () => {
    expect(context("SELECT | FROM users u").slot).toBe("column");
    expect(relations("SELECT | FROM users u, orders AS o")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "users", alias: "u", kind: "table" }),
        expect.objectContaining({ name: "orders", alias: "o", kind: "table" }),
      ])
    );
    expect(relations("SELECT * FROM users WHERE |")[0].alias).toBeUndefined();
  });
  it("isolates statements and nested query scopes", () => {
    expect(
      relations("SELECT * FROM users; SELECT * FROM orders WHERE |").map(
        (r) => r.name
      )
    ).toEqual(["orders"]);
    expect(
      relations(
        "SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o) AND |"
      ).map((r) => r.name)
    ).toEqual(["users"]);
    expect(
      relations(
        "SELECT * FROM users u WHERE EXISTS (SELECT | FROM orders o)"
      ).map((r) => r.name)
    ).toEqual(["orders"]);
    expect(
      context(
        "SELECT * FROM users WHERE EXISTS (SELECT | FROM orders)"
      ).scopes.every((s) => !s.canCorrelate)
    ).toBe(true);
  });
  it.each([
    ["SELECT * FROM |", "from", "table"],
    ["SELECT * FROM users u |", "from", "continuation"],
    ["SELECT * FROM users u WHERE |", "where", "column"],
    ["SELECT * FROM users WHERE id |", "where", "keyword"],
    ["SELECT * FROM users WHERE id = |", "where", "column"],
    ["SELECT * FROM users JOIN orders ON |", "on", "joinCondition"],
    ["UPDATE users SET |", "set", "columnList"],
    ["UPDATE users SET name = |", "set", "column"],
    ["UPDATE users SET name |", "set", "keyword"],
    ["INSERT INTO users (|)", "insertColumns", "columnList"],
    ["DELETE FROM users WHERE |", "where", "column"],
    ["SELECT * FROM users GROUP /* note */ BY |", "groupBy", "column"],
    ["SELECT * FROM users ORDER BY |", "orderBy", "column"],
    ["SELECT coalesce(lower(|), '') FROM users", "select", "column"],
  ])("classifies %s", (sql, clause, slot) => {
    expect(context(sql)).toMatchObject({ clause, slot });
  });
  it("extracts qualifier, prefix and replacement range", () => {
    const sql = "SELECT * FROM users u WHERE u.na|me";
    expect(context(sql)).toMatchObject({
      prefix: "na",
      qualifierParts: ["u"],
      edit: { start: sql.indexOf("na|"), end: sql.length - 1 },
    });
    expect(
      context('SELECT * FROM "Users" "U" WHERE "U"."na|me"', "postgres")
    ).toMatchObject({
      prefix: "na",
      qualifierParts: ["U"],
      qualifierQuoted: [true],
    });
    expect(context("SELECT * FROM users u WHERE u.|")).toMatchObject({
      prefix: "",
      qualifierParts: ["u"],
    });
    expect(
      relations('SELECT | FROM "Db"."Users" AS "U"', "postgres")[0]
    ).toMatchObject({
      namespace: "Db",
      name: "Users",
      alias: "U",
      nameQuoted: true,
    });
  });
  it("excludes existing INSERT columns and SET assignment targets", () => {
    expect(context("INSERT INTO users (id, |, name)").excludedColumns).toEqual([
      "id",
      "name",
    ]);
    expect(
      context("UPDATE users SET name = concat('a', 'b'), |, age = 2")
        .excludedColumns
    ).toEqual(["name", "age"]);
    expect(
      context("UPDATE users SET name = |, age = 2").excludedColumns
    ).toEqual([]);
  });
  it("limits ON visibility to relations already introduced", () => {
    const value = context(
      "SELECT * FROM users u JOIN orders o ON | LEFT JOIN items i ON i.id = o.id"
    );
    const visible = value.scopes.find((s) => s.id === value.scopeId)!.relations;
    expect(visible.map((r) => r.alias)).toEqual(["u", "o"]);
    expect(value.join).toEqual({
      leftRelationIds: [visible[0].id],
      rightRelationId: visible[1].id,
      conditionState: "empty",
    });
    const self = relations("SELECT | FROM users u JOIN users v ON u.id = v.id");
    expect(self[0].id).not.toBe(self[1].id);
  });
  it("keeps unknown relations without guessing derived or CTE output", () => {
    expect(relations("SELECT | FROM unknown_table")[0].name).toBe(
      "unknown_table"
    );
    expect(
      relations("SELECT | FROM (SELECT id FROM users) users")[0]
    ).toMatchObject({ kind: "derived", alias: "users" });
    expect(
      relations("WITH users AS (SELECT id FROM orders) SELECT | FROM users")[0]
        .kind
    ).toBe("cte");
    expect(
      relations("SELECT | FROM server.db.users", "sqlserver").some(
        (r) => r.kind === "table"
      )
    ).toBe(false);
    expect(
      relations("SELECT | FROM remote('host', db, users)", "clickhouse").some(
        (r) => r.kind === "table"
      )
    ).toBe(false);
  });
  it("suppresses comments and strings while retaining incomplete identifiers", () => {
    expect(context("SELECT 'hello |world' FROM users").slot).toBe("none");
    expect(context("SELECT /* | */ id FROM users").slot).toBe("none");
    expect(context("SELECT -- | comment\n id FROM users").slot).toBe("none");
    expect(context('SELECT "na|', "postgres")).toMatchObject({
      prefix: "na",
      confidence: "partial",
    });
    expect(
      context('SELECT * FROM "users" WHERE |', "mysql").scopes[0].relations
    ).toEqual([]);
  });
  it("isolates GO batches and retains current namespace", () => {
    expect(
      relations(
        "SELECT * FROM users\r\nGO\r\nSELECT * FROM dbo.orders WHERE |",
        "sqlserver"
      )[0]
    ).toMatchObject({ name: "orders", namespace: "dbo" });
  });
});

describe("ON 条件状态", () => {
  it.each([
    ["SELECT * FROM orders o JOIN customers c ON |", "empty"],
    ["SELECT * FROM orders o JOIN customers c ON cus|", "prefix"],
    [
      "SELECT * FROM orders o JOIN customers c ON o.customer_id = c.id|",
      "expression",
    ],
    ["SELECT * FROM orders o JOIN customers c ON (o.id|", "expression"],
    ["SELECT * FROM orders o JOIN customers c ON o.id AND |", "expression"],
    ["SELECT * FROM orders o JOIN customers c ON cus| = c.id", "expression"],
    [
      "SELECT * FROM orders o JOIN customers c ON o.customer_id = c.|id",
      "expression",
    ],
  ] as const)("%s → %s", (sql, state) => {
    expect(context(sql).join?.conditionState).toBe(state);
  });
});

describe("conservative SQL binding edges", () => {
  it("normalizes excluded PostgreSQL names according to quoting", () => {
    expect(
      context('INSERT INTO users (ID, "Name", |)', "postgres").excludedColumns
    ).toEqual(["id", "Name"]);
    expect(
      context('UPDATE users SET NAME = 1, "Age" = 2, |', "postgres")
        .excludedColumns
    ).toEqual(["name", "Age"]);
  });
  it("does not bind unsupported relation modifiers as physical tables", () => {
    expect(
      relations("SELECT | FROM ONLY users", "postgres").some(
        (r) => r.kind === "table"
      )
    ).toBe(false);
    expect(
      relations(
        "SELECT | FROM LATERAL (SELECT * FROM users) users",
        "postgres"
      ).some((r) => r.kind === "table")
    ).toBe(false);
  });
  it("avoids leaking union branch relations at table and expression positions", () => {
    expect(
      relations("SELECT id FROM users UNION SELECT | FROM orders")
    ).toEqual([]);
    expect(
      relations("SELECT id FROM users UNION SELECT * FROM orders |")
    ).toEqual([]);
  });
  it("continues after completed expressions in SET", () => {
    expect(context("UPDATE users SET name = 'x' |").slot).toBe("keyword");
    expect(context("UPDATE users SET name = 'x', |").slot).toBe("columnList");
  });
  it("does not bind a relation target that is still being typed", () => {
    expect(context("SELECT * FROM us|ers").slot).toBe("table");
    expect(context("SELECT * FROM db.us|ers").slot).toBe("table");
  });
  it("does not throw at an unclosed parenthesis or empty statement", () => {
    expect(context("SELECT * FROM (SELECT | FROM orders").slot).toBe("column");
    expect(context("|").slot).toBe("keyword");
  });
});

it("keeps operator prefixes in keyword slots after a complete operand", () => {
  expect(context("SELECT * FROM users WHERE id LI|").slot).toBe("keyword");
  expect(context("SELECT * FROM users WHERE id = na|").slot).toBe("column");
  expect(context("SELECT * FROM users u WHERE u.na|").slot).toBe("column");
  expect(context("SELECT * FROM users ORDER BY id DE|").slot).toBe("keyword");
});

it("keeps subsequent comma-separated relation prefixes in the table slot", () => {
  expect(context("SELECT * FROM users u, ord|").slot).toBe("table");
  expect(context("SELECT * FROM users u, ord|ers o").slot).toBe("table");
  expect(context("SELECT * FROM users u, orders o |").slot).toBe(
    "continuation"
  );
});

it("excludes only SET assignment targets, not RHS or WHERE comparisons", () => {
  expect(
    context("UPDATE users SET active = age = 2, | WHERE id = 1").excludedColumns
  ).toEqual(["active"]);
  expect(context("UPDATE users SET | WHERE id = 1").excludedColumns).toEqual(
    []
  );
});

describe("review regressions: nested WITH and INSERT SELECT", () => {
  it("registers nested CTE names without binding a same-named physical table", () => {
    const sql =
      "SELECT * FROM (WITH users AS (SELECT id FROM orders) SELECT | FROM users) d";
    expect(relations(sql, "postgres")).toEqual([
      expect.objectContaining({ name: "users", kind: "cte" }),
    ]);
    expect(
      relations(
        "SELECT * FROM (WITH users AS (SELECT | FROM orders) SELECT id FROM users) d",
        "postgres"
      )
    ).toEqual([expect.objectContaining({ name: "orders", kind: "table" })]);
    expect(
      relations(
        "SELECT | FROM users WHERE EXISTS (WITH users AS (SELECT id FROM orders) SELECT id FROM users)",
        "postgres"
      )
    ).toEqual([expect.objectContaining({ name: "users", kind: "table" })]);
  });
  it("limits INSERT column lists to the insertion target", () => {
    expect(
      relations("INSERT INTO users (|) SELECT id, user_id FROM orders").map(
        (r) => r.name
      )
    ).toEqual(["users"]);
    expect(
      context("INSERT INTO users (|) SELECT id, user_id FROM orders").slot
    ).toBe("columnList");
  });
  it("isolates INSERT SELECT source relations from the insertion target", () => {
    expect(
      relations("INSERT INTO users (id) SELECT | FROM orders").map(
        (r) => r.name
      )
    ).toEqual(["orders"]);
    expect(
      relations("INSERT INTO users SELECT * FROM orders WHERE |").map(
        (r) => r.name
      )
    ).toEqual(["orders"]);
    expect(relations("INSERT INTO users SELECT |")).toEqual([]);
    expect(
      relations("INSERT INTO users SELECT | FROM users").map((r) => r.name)
    ).toEqual(["users"]);
    expect(
      relations(
        "INSERT INTO users SELECT * FROM orders o JOIN items i ON |"
      ).map((r) => r.name)
    ).toEqual(["orders", "items"]);
  });
  it("distinguishes postfix NOT operators from unary NOT expressions", () => {
    expect(context("SELECT * FROM users WHERE id NOT |").slot).toBe("keyword");
    expect(context("SELECT * FROM users WHERE id NOT LI|").slot).toBe(
      "keyword"
    );
    expect(context("SELECT * FROM users WHERE NOT |").slot).toBe("column");
    expect(context("SELECT * FROM users WHERE id = 1 AND NOT |").slot).toBe(
      "column"
    );
  });
});

it("marks compound operator continuations without changing unary NOT", () => {
  expect(context("SELECT * FROM users WHERE id NOT |")).toMatchObject({
    slot: "keyword",
    operator: "NOT",
  });
  expect(context("SELECT * FROM users WHERE id IS |")).toMatchObject({
    slot: "keyword",
    operator: "IS",
  });
  expect(context("SELECT * FROM users WHERE id IS NOT |")).toMatchObject({
    slot: "keyword",
    operator: "IS NOT",
  });
  expect(context("SELECT * FROM users WHERE NOT |").operator).toBeUndefined();
  expect(context("UPDATE users SET active = id IS |")).toMatchObject({
    slot: "keyword",
    operator: "IS",
  });
});

it("registers a WITH clause belonging to an INSERT SELECT source", () => {
  expect(
    relations(
      "INSERT INTO users WITH orders AS (SELECT id FROM items) SELECT | FROM orders",
      "postgres"
    )
  ).toEqual([expect.objectContaining({ name: "orders", kind: "cte" })]);
});
