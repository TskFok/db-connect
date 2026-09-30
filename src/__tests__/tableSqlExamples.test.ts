import { describe, expect, it } from "vitest";
import type { ColumnInfo, DatabaseType } from "../types";
import { buildTableSqlExamples } from "../utils/tableSqlExamples";

function column(name: string, overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return {
    name,
    column_type: "varchar(255)",
    nullable: false,
    key: "",
    default_value: null,
    extra: "",
    comment: "",
    ...overrides,
  };
}

const columns = [
  column("id", { column_type: "int", key: "PRI", extra: "auto_increment" }),
  column("name"),
  column("status"),
];

function examples(
  overrides: Partial<Parameters<typeof buildTableSqlExamples>[0]> = {}
) {
  return buildTableSqlExamples({
    database: "app",
    table: "users",
    columns,
    dialect: "mysql",
    ...overrides,
  });
}

function sqlFor(id: string, result = examples()): string | undefined {
  return result.find((example) => example.id === id)?.sql.replace(/\s+/g, " ");
}

describe("buildTableSqlExamples", () => {
  it("ClickHouse 转义标识符中的反斜杠，保留原始库名、表名和列名", () => {
    const result = examples({
      dialect: "clickhouse",
      database: "app\\test",
      table: "users\\",
      columns: [column("name\\new")],
    });
    expect(sqlFor("select", result)).toBe(
      "SELECT * FROM `app\\\\test`.`users\\\\` LIMIT 100;"
    );
    expect(sqlFor("insert", result)).toBe(
      "INSERT INTO `app\\\\test`.`users\\\\` (`name\\\\new`) VALUES (<值1>);"
    );
  });

  it("根据当前表生成六类示例，并保留主键查询条件", () => {
    expect(examples().map((example) => example.id)).toEqual([
      "select",
      "filter",
      "count",
      "insert",
      "update",
      "delete",
    ]);
    expect(sqlFor("select")).toBe("SELECT * FROM `app`.`users` LIMIT 100;");
    expect(sqlFor("filter")).toBe(
      "SELECT * FROM `app`.`users` WHERE `id` = <条件值1> LIMIT 100;"
    );
    expect(sqlFor("count")).toBe(
      "SELECT COUNT(*) AS total FROM `app`.`users`;"
    );
    expect(sqlFor("insert")).toBe(
      "INSERT INTO `app`.`users` (`name`, `status`) VALUES (<值1>, <值2>);"
    );
    expect(sqlFor("update")).toBe(
      "UPDATE `app`.`users` SET `name` = <新值1>, `status` = <新值2> WHERE `id` = <条件值1>;"
    );
    expect(sqlFor("delete")).toBe(
      "DELETE FROM `app`.`users` WHERE `id` = <条件值1>;"
    );
  });

  it.each<{
    dialect: DatabaseType;
    database: string;
    table: string;
    field: string;
    select: string;
    filter: string;
  }>([
    {
      dialect: "mysql",
      database: "ap`p",
      table: "us`ers",
      field: "i`d",
      select: "SELECT * FROM `ap``p`.`us``ers` LIMIT 100;",
      filter:
        "SELECT * FROM `ap``p`.`us``ers` WHERE `i``d` = <条件值1> LIMIT 100;",
    },
    {
      dialect: "postgres",
      database: 'pub"lic',
      table: 'us"ers',
      field: 'i"d',
      select: 'SELECT * FROM "pub""lic"."us""ers" LIMIT 100;',
      filter:
        'SELECT * FROM "pub""lic"."us""ers" WHERE "i""d" = <条件值1> LIMIT 100;',
    },
    {
      dialect: "sqlite",
      database: "main",
      table: 'us"ers',
      field: 'i"d',
      select: 'SELECT * FROM "main"."us""ers" LIMIT 100;',
      filter:
        'SELECT * FROM "main"."us""ers" WHERE "i""d" = <条件值1> LIMIT 100;',
    },
    {
      dialect: "sqlserver",
      database: "db]o",
      table: "us]ers",
      field: "i]d",
      select: "SELECT TOP (100) * FROM [db]]o].[us]]ers];",
      filter:
        "SELECT TOP (100) * FROM [db]]o].[us]]ers] WHERE [i]]d] = <条件值1>;",
    },
    {
      dialect: "clickhouse",
      database: "ap`p",
      table: "us`ers",
      field: "i`d",
      select: "SELECT * FROM `ap``p`.`us``ers` LIMIT 100;",
      filter:
        "SELECT * FROM `ap``p`.`us``ers` WHERE `i``d` = <条件值1> LIMIT 100;",
    },
  ])(
    "正确处理 $dialect 的引用符与查询条数语法",
    ({ dialect, database, table, field, select, filter }) => {
      const result = examples({
        dialect,
        database,
        table,
        columns: [column(field)],
      });
      expect(sqlFor("select", result)).toBe(select);
      expect(sqlFor("filter", result)).toBe(filter);
    }
  );

  it("组合主键完整组成 WHERE，更新只修改非主键列", () => {
    const result = examples({
      columns: [
        column("tenant_id", { key: "PRI" }),
        column("id", { key: "PRI" }),
        column("name"),
      ],
    });
    expect(sqlFor("update", result)).toBe(
      "UPDATE `app`.`users` SET `name` = <新值1> WHERE `tenant_id` = <条件值1> AND `id` = <条件值2>;"
    );
    expect(sqlFor("delete", result)).toBe(
      "DELETE FROM `app`.`users` WHERE `tenant_id` = <条件值1> AND `id` = <条件值2>;"
    );
    expect(sqlFor("insert", result)).toBe(
      "INSERT INTO `app`.`users` (`tenant_id`, `id`, `name`) VALUES (<值1>, <值2>, <值3>);"
    );
  });

  it("没有主键时以首列提供可替换的条件", () => {
    const result = examples({ columns: [column("email"), column("name")] });
    expect(sqlFor("filter", result)).toContain("WHERE `email` = <条件值1>");
    expect(sqlFor("delete", result)).toContain("WHERE `email` = <条件值1>");
  });

  it("SQL Server 无主键时使用后端选定的复合唯一索引", () => {
    const result = examples({
      dialect: "sqlserver",
      columns: [
        column("name"),
        column("tenant", { key: "UNI" }),
        column("email", { key: "UNI" }),
      ],
    });
    expect(sqlFor("delete", result)).toBe(
      "DELETE FROM [app].[users] WHERE [tenant] = <条件值1> AND [email] = <条件值2>;"
    );
  });

  it("MySQL 排除生成列但不误排除 DEFAULT_GENERATED 普通列", () => {
    const result = examples({
      columns: [
        ...columns.slice(0, 2),
        column("virtual", { extra: "VIRTUAL GENERATED" }),
        column("stored", { extra: "STORED GENERATED" }),
        column("created_at", {
          extra: "DEFAULT_GENERATED",
          default_value: "CURRENT_TIMESTAMP",
        }),
      ],
    });
    expect(sqlFor("insert", result)).toBe(
      "INSERT INTO `app`.`users` (`name`, `created_at`) VALUES (<值1>, <值2>);"
    );
    expect(sqlFor("update", result)).toBe(
      "UPDATE `app`.`users` SET `name` = <新值1>, `created_at` = <新值2> WHERE `id` = <条件值1>;"
    );
  });

  it("PostgreSQL 排除 identity、生成列及序列默认值列", () => {
    const result = examples({
      dialect: "postgres",
      columns: [
        column("id", { key: "PRI", extra: "identity" }),
        column("serial_id", {
          default_value: "nextval('users_seq'::regclass)",
        }),
        column("generated", { extra: "always generated" }),
        column("name"),
      ],
    });
    expect(sqlFor("insert", result)).toBe(
      'INSERT INTO "app"."users" ("name") VALUES (<值1>);'
    );
    expect(sqlFor("update", result)).toBe(
      'UPDATE "app"."users" SET "name" = <新值1> WHERE "id" = <条件值1>;'
    );
  });

  it("SQL Server 排除 identity、computed 与 rowversion 列", () => {
    const result = examples({
      dialect: "sqlserver",
      columns: [
        column("id", { key: "PRI", extra: "identity" }),
        column("computed", { extra: "computed AS ([price] * [quantity])" }),
        column("version", { column_type: "rowversion" }),
        column("legacy_version", { column_type: "timestamp" }),
        column("name"),
      ],
    });
    expect(sqlFor("insert", result)).toBe(
      "INSERT INTO [app].[users] ([name]) VALUES (<值1>);"
    );
    expect(sqlFor("update", result)).toBe(
      "UPDATE [app].[users] SET [name] = <新值1> WHERE [id] = <条件值1>;"
    );
  });

  it("SQLite 保留未明确标记自增的 INTEGER 主键，排除明确生成列", () => {
    const result = examples({
      dialect: "sqlite",
      columns: [
        column("id", { key: "PRI", column_type: "INTEGER" }),
        column("name"),
        column("generated", { extra: "generated" }),
      ],
    });
    expect(sqlFor("insert", result)).toBe(
      'INSERT INTO "app"."users" ("id", "name") VALUES (<值1>, <值2>);'
    );
  });

  it("ClickHouse 只提供查询与插入，并排除 MATERIALIZED 和 ALIAS 列", () => {
    const result = examples({
      dialect: "clickhouse",
      columns: [
        column("id", { key: "PRI" }),
        column("derived", { default_value: "MATERIALIZED now()" }),
        column("alias", { default_value: "ALIAS id" }),
        column("name", { default_value: "DEFAULT 'unknown'" }),
      ],
    });
    expect(result.map((example) => example.id)).toEqual([
      "select",
      "filter",
      "count",
      "insert",
    ]);
    expect(sqlFor("insert", result)).toBe(
      "INSERT INTO `app`.`users` (`id`, `name`) VALUES (<值1>, <值2>);"
    );
  });

  it("视图只生成查询示例", () => {
    expect(examples({ isView: true }).map((example) => example.id)).toEqual([
      "select",
      "filter",
      "count",
    ]);
  });

  it("空结构仍提供查询和计数，不生成缺少字段的语句", () => {
    expect(examples({ columns: [] }).map((example) => example.id)).toEqual([
      "select",
      "count",
    ]);
  });

  it("没有可写列时省略插入和更新，保留带条件的删除", () => {
    const result = examples({ columns: [columns[0]] });
    expect(result.map((example) => example.id)).toEqual([
      "select",
      "filter",
      "count",
      "delete",
    ]);
    expect(sqlFor("delete", result)).toContain("WHERE `id` = <条件值1>");
  });
});
