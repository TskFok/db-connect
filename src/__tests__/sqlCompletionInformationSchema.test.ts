import { describe, expect, it } from "vitest";
import type * as Monaco from "monaco-editor";
import {
  registerSqlCompletionProvider,
  type SqlDialect,
  type SqlSchema,
} from "../utils/sqlCompletion";
import { analyzeSqlCompletion } from "../utils/sqlCompletionContext";
import { generateSqlCompletionCandidates } from "../utils/sqlCompletionCandidates";
import { buildSqlMetadataIndex } from "../utils/sqlCompletionMetadataIndex";
import { resolveSqlCompletionScopes } from "../utils/sqlCompletionScopes";
import { createSqlCompletionModel } from "./fixtures/sqlCompletionModel";

const schema: SqlSchema = {
  databases: ["app"],
  tables: [{ name: "users" }, { name: "TABLES" }],
  columns: [
    { table: "users", name: "business_id" },
    { table: "TABLES", name: "business_only" },
  ],
};

function complete(
  marked: string,
  options: {
    dialect?: SqlDialect;
    database?: string | null;
    metadata?: SqlSchema;
  } = {}
) {
  const offset = marked.indexOf("|");
  const sql = marked.replace("|", "");
  const dialect = options.dialect ?? "mysql";
  const database = options.database === undefined ? "app" : options.database;
  const index = buildSqlMetadataIndex(options.metadata ?? schema, {
    connId: "system-schema",
    database,
    dialect,
    connectionRevision: 0,
  });
  const base = analyzeSqlCompletion({ sql, offset, dialect });
  base.defaultNamespace = database;
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

const emptyMetadata: SqlSchema = { databases: [], tables: [], columns: [] };

describe("MySQL information_schema 补全", () => {
  it("业务库中可以补全 information_schema 命名空间", () => {
    const { candidates } = complete("SELECT * FROM information_sch|");
    expect(candidates).toContainEqual(
      expect.objectContaining({
        label: "information_schema",
        insertText: "`information_schema`",
        kind: "relation",
      })
    );
  });

  it.each([
    "SELECT * FROM information_schema.ta|",
    "SELECT * FROM INFORMATION_SCHEMA.ta|",
    "SELECT * FROM `information_schema`.`ta|`",
  ])("限定系统库后仅补全系统表：%s", (marked) => {
    const { candidates } = complete(marked);
    expect(candidates).toContainEqual(
      expect.objectContaining({
        label: "TABLES",
        insertText: "`TABLES`",
        kind: "table",
      })
    );
    expect(candidates.some((item) => item.label === "users")).toBe(false);
  });

  it("系统库空前缀和未知表引用均不回退业务表", () => {
    const tables = complete("SELECT * FROM information_schema.|").candidates;
    expect(tables.map((item) => item.label)).toContain("COLUMNS");
    expect(tables.map((item) => item.label)).not.toContain("users");
    for (const marked of [
      "SELECT x.| FROM information_schema.users x",
      "SELECT x.| FROM unknown_schema.TABLES x",
    ]) {
      expect(complete(marked).candidates).toEqual([]);
    }
  });

  it.each([
    "SELECT t.table_na| FROM information_schema.TABLES t",
    "SELECT tables.table_na| FROM information_schema.tables",
    "SELECT information_schema.TABLES.table_na| FROM information_schema.TABLES",
    "SELECT `t`.`table_na|` FROM `INFORMATION_SCHEMA`.`tables` AS `t`",
  ])("系统表列复用限定符和别名解析：%s", (marked) => {
    const { candidates } = complete(marked);
    expect(candidates).toContainEqual(
      expect.objectContaining({
        filterText: "TABLE_NAME",
        insertText: "`TABLE_NAME`",
        kind: "column",
      })
    );
    expect(candidates.some((item) => item.filterText === "business_only")).toBe(
      false
    );
  });

  it("静态公共列不用于推断派生表和 CTE 的完整星号输出", () => {
    for (const marked of [
      "SELECT d.table_na| FROM (SELECT * FROM information_schema.TABLES) d",
      "WITH t AS (SELECT * FROM information_schema.TABLES) SELECT t.table_na| FROM t",
    ]) {
      const { candidates, context } = complete(marked);
      expect(candidates).toEqual([]);
      const physical = context.scopes
        .flatMap((scope) => scope.relations)
        .find((relation) => relation.namespace === "information_schema");
      expect(physical?.outputComplete).toBe(false);
      expect(physical?.outputColumns?.map((column) => column.name)).toContain(
        "TABLE_NAME"
      );
    }
  });

  it.each([
    ["SCHEMATA", "schema_na", "SCHEMA_NAME"],
    ["COLUMNS", "column_na", "COLUMN_NAME"],
    ["STATISTICS", "index_na", "INDEX_NAME"],
    ["KEY_COLUMN_USAGE", "referenced_table_na", "REFERENCED_TABLE_NAME"],
    ["TABLE_CONSTRAINTS", "constraint_ty", "CONSTRAINT_TYPE"],
    ["REFERENTIAL_CONSTRAINTS", "update_ru", "UPDATE_RULE"],
    ["ROUTINES", "routine_na", "ROUTINE_NAME"],
    ["TRIGGERS", "trigger_na", "TRIGGER_NAME"],
    ["EVENTS", "event_na", "EVENT_NAME"],
    ["PROCESSLIST", "comm", "COMMAND"],
  ])("常见系统表 %s 的列不依赖业务元数据", (table, prefix, expected) => {
    const { candidates } = complete(
      `SELECT x.${prefix}| FROM information_schema.${table} x`,
      { metadata: emptyMetadata }
    );
    expect(candidates.map((item) => item.filterText)).toContain(expected);
  });

  it("默认系统库无已加载元数据时仍补全表名和裸列名", () => {
    const options = { database: "information_schema", metadata: emptyMetadata };
    expect(
      complete("SELECT * FROM ta|", options).candidates.map(
        (item) => item.label
      )
    ).toContain("TABLES");
    expect(
      complete("SELECT table_na| FROM TABLES", options).candidates.map(
        (item) => item.filterText
      )
    ).toContain("TABLE_NAME");
  });

  it("未选择业务库时仍可显式查询系统库", () => {
    const { candidates } = complete(
      "SELECT t.table_na| FROM information_schema.TABLES t",
      { database: null, metadata: emptyMetadata }
    );
    expect(candidates.map((item) => item.filterText)).toContain("TABLE_NAME");
  });

  it("已加载系统表的真实列优先于静态定义", () => {
    const { candidates } = complete("SELECT t.| FROM TABLES t", {
      database: "information_schema",
      metadata: {
        databases: ["information_schema"],
        tables: [{ name: "TABLES" }, { name: "SERVER_EXTENSION" }],
        columns: [{ table: "TABLES", name: "server_actual_column" }],
      },
    });
    expect(candidates.map((item) => item.filterText)).toEqual([
      "server_actual_column",
    ]);
  });

  it("真实系统元数据保留原始大小写和额外表", () => {
    const metadata = {
      databases: ["INFORMATION_SCHEMA"],
      tables: [{ name: "tables" }, { name: "SERVER_EXTENSION" }],
      columns: [{ table: "tables", name: "ServerActualColumn" }],
    };
    const options = { database: "INFORMATION_SCHEMA", metadata };
    expect(
      complete(
        "SELECT t.| FROM information_schema.TABLES t",
        options
      ).candidates.map((item) => item.filterText)
    ).toEqual(["ServerActualColumn"]);
    expect(
      complete("SELECT * FROM server_e|", options).candidates.map(
        (item) => item.label
      )
    ).toEqual(["SERVER_EXTENSION"]);
    expect(
      complete("SELECT * FROM information_sch|", options).candidates.map(
        (item) => item.label
      )
    ).toEqual(["INFORMATION_SCHEMA"]);
  });

  it("业务同名表继续使用业务列", () => {
    expect(
      complete("SELECT t.| FROM TABLES t").candidates.map(
        (item) => item.filterText
      )
    ).toEqual(["business_only"]);
  });

  it.each<SqlDialect>(["postgres", "sqlite", "sqlserver", "clickhouse"])(
    "%s 不启用 MySQL 内置系统库",
    (dialect) => {
      for (const marked of [
        "SELECT * FROM information_sch|",
        "SELECT * FROM information_schema.ta|",
        "SELECT t.table_na| FROM information_schema.TABLES t",
      ]) {
        expect(complete(marked, { dialect }).candidates).toEqual([]);
      }
    }
  );
});

describe("MySQL information_schema provider", () => {
  it.each([
    ["SELECT * FROM information_schema.ta|", "`TABLES`"],
    ["SELECT t.table_na| FROM information_schema.TABLES t", "`TABLE_NAME`"],
  ])("metadata index 尚未加载仍可以补全：%s", (marked, expected) => {
    const providers: Monaco.languages.CompletionItemProvider[] = [];
    const monaco = {
      languages: {
        CompletionItemKind: {
          Keyword: 1,
          Module: 2,
          Class: 3,
          Field: 4,
          Function: 5,
          Variable: 6,
        },
        registerCompletionItemProvider: (
          _language: string,
          provider: Monaco.languages.CompletionItemProvider
        ) => {
          providers.push(provider);
          return { dispose() {} };
        },
      },
    } as unknown as typeof Monaco;
    const sql = marked.replace("|", "");
    const { model } = createSqlCompletionModel(sql);
    const disposable = registerSqlCompletionProvider(monaco, "model:a", () => ({
      key: {
        connId: "unloaded",
        database: "app",
        dialect: "mysql",
        connectionRevision: 0,
      },
      revision: 0,
    }));
    try {
      const result = providers[0].provideCompletionItems(
        model,
        model.getPositionAt(marked.indexOf("|")),
        { triggerKind: 0 },
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose() {} }),
        }
      ) as Monaco.languages.CompletionList;
      expect(result.suggestions.map((item) => item.insertText)).toContain(
        expected
      );
    } finally {
      disposable.dispose();
    }
  });
});
