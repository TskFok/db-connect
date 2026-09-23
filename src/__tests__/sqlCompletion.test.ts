import { describe, it, expect, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import {
  registerSqlCompletionProvider,
  type SqlCompletionBinding,
  type SqlDialect,
} from "../utils/sqlCompletion";
import { buildSqlMetadataIndex } from "../utils/sqlCompletionMetadataIndex";
import { loadSqlCompletionSchema } from "../utils/sqlCompletionSchema";
import {
  completionKey,
  completionSchema,
} from "./fixtures/sqlCompletionFixtures";
import {
  CLICKHOUSE_KEYWORDS,
  MYSQL_KEYWORDS,
  POSTGRES_KEYWORDS,
  SQLSERVER_KEYWORDS,
  SQLITE_KEYWORDS,
  getSqlKeywords,
  quoteIdentifier,
  type SqlSchema,
} from "../utils/sqlCompletion";

describe("sqlCompletion", () => {
  describe("MYSQL_KEYWORDS", () => {
    it("应包含常用 DML 关键词", () => {
      expect(MYSQL_KEYWORDS).toContain("SELECT");
      expect(MYSQL_KEYWORDS).toContain("INSERT");
      expect(MYSQL_KEYWORDS).toContain("UPDATE");
      expect(MYSQL_KEYWORDS).toContain("DELETE");
      expect(MYSQL_KEYWORDS).toContain("FROM");
      expect(MYSQL_KEYWORDS).toContain("WHERE");
    });

    it("应包含 JOIN 相关关键词", () => {
      expect(MYSQL_KEYWORDS).toContain("JOIN");
      expect(MYSQL_KEYWORDS).toContain("LEFT JOIN");
      expect(MYSQL_KEYWORDS).toContain("INNER JOIN");
      expect(MYSQL_KEYWORDS).toContain("ON");
    });

    it("应包含 DDL 关键词", () => {
      expect(MYSQL_KEYWORDS).toContain("CREATE");
      expect(MYSQL_KEYWORDS).toContain("ALTER");
      expect(MYSQL_KEYWORDS).toContain("DROP");
      expect(MYSQL_KEYWORDS).toContain("TABLE");
    });

    it("应包含数据类型关键词", () => {
      expect(MYSQL_KEYWORDS).toContain("VARCHAR");
      expect(MYSQL_KEYWORDS).toContain("INT");
      expect(MYSQL_KEYWORDS).toContain("DECIMAL");
      expect(MYSQL_KEYWORDS).toContain("DATETIME");
    });

    it("应包含 EXPLAIN/DESCRIBE", () => {
      expect(MYSQL_KEYWORDS).toContain("EXPLAIN");
      expect(MYSQL_KEYWORDS).toContain("DESCRIBE");
      expect(MYSQL_KEYWORDS).toContain("DESC");
    });

    it("关键词数量应合理", () => {
      expect(MYSQL_KEYWORDS.length).toBeGreaterThan(50);
      expect(MYSQL_KEYWORDS.length).toBeLessThan(200);
    });
  });

  describe("SqlSchema", () => {
    it("应满足接口结构", () => {
      const schema: SqlSchema = {
        databases: ["db1", "db2"],
        tables: [{ name: "users" }, { name: "orders" }],
        columns: [
          { name: "id", table: "users", type: "int" },
          { name: "name", table: "users", type: "varchar(100)" },
          { name: "order_id", table: "orders", type: "bigint" },
        ],
      };
      expect(schema.databases).toHaveLength(2);
      expect(schema.tables).toHaveLength(2);
      expect(schema.columns).toHaveLength(3);
      expect(schema.columns[0]).toEqual({
        name: "id",
        table: "users",
        type: "int",
      });
    });
  });

  describe("POSTGRES_KEYWORDS", () => {
    it("应包含 PostgreSQL 专属关键词且去掉 MySQL 专属关键词", () => {
      expect(POSTGRES_KEYWORDS).toContain("RETURNING");
      expect(POSTGRES_KEYWORDS).toContain("ILIKE");
      expect(POSTGRES_KEYWORDS).toContain("JSONB");
      // MySQL 专属关键词不应出现，避免误导
      expect(POSTGRES_KEYWORDS).not.toContain("ENGINE");
      expect(POSTGRES_KEYWORDS).not.toContain("AUTO_INCREMENT");
    });
  });

  describe("SQLITE_KEYWORDS", () => {
    it("应包含 SQLite 常用关键词", () => {
      expect(SQLITE_KEYWORDS).toContain("PRAGMA");
      expect(SQLITE_KEYWORDS).toContain("EXPLAIN");
      expect(SQLITE_KEYWORDS).toContain("QUERY PLAN");
      expect(SQLITE_KEYWORDS).toContain("ON CONFLICT");
      expect(SQLITE_KEYWORDS).toContain("ATTACH");
      expect(SQLITE_KEYWORDS).toContain("DETACH");
    });
  });

  describe("SQLSERVER_KEYWORDS", () => {
    it("应包含 SQL Server 常用关键词且去掉 MySQL 专属关键词", () => {
      expect(SQLSERVER_KEYWORDS).toContain("TOP");
      expect(SQLSERVER_KEYWORDS).toContain("OFFSET");
      expect(SQLSERVER_KEYWORDS).toContain("FETCH NEXT");
      expect(SQLSERVER_KEYWORDS).toContain("NVARCHAR");
      expect(SQLSERVER_KEYWORDS).toContain("UNIQUEIDENTIFIER");
      expect(SQLSERVER_KEYWORDS).toContain("SYSNAME");
      expect(SQLSERVER_KEYWORDS).not.toContain("ENGINE");
      expect(SQLSERVER_KEYWORDS).not.toContain("AUTO_INCREMENT");
    });
  });

  describe("CLICKHOUSE_KEYWORDS", () => {
    it("应包含 ClickHouse 常用关键词", () => {
      expect(CLICKHOUSE_KEYWORDS).toContain("SELECT");
      expect(CLICKHOUSE_KEYWORDS).toContain("FORMAT");
      expect(CLICKHOUSE_KEYWORDS).toContain("ENGINE");
      expect(CLICKHOUSE_KEYWORDS).toContain("MERGE TREE");
      expect(CLICKHOUSE_KEYWORDS).toContain("ORDER BY");
      expect(CLICKHOUSE_KEYWORDS).toContain("PARTITION BY");
      expect(CLICKHOUSE_KEYWORDS).toContain("LIMIT BY");
    });
  });

  describe("getSqlKeywords", () => {
    it("按方言返回对应关键词集合", () => {
      expect(getSqlKeywords("mysql")).toBe(MYSQL_KEYWORDS);
      expect(getSqlKeywords("postgres")).toBe(POSTGRES_KEYWORDS);
      expect(getSqlKeywords("sqlite")).toBe(SQLITE_KEYWORDS);
      expect(getSqlKeywords("sqlserver")).toBe(SQLSERVER_KEYWORDS);
      expect(getSqlKeywords("clickhouse")).toBe(CLICKHOUSE_KEYWORDS);
      // 默认 mysql
      expect(getSqlKeywords()).toBe(MYSQL_KEYWORDS);
    });
  });

  describe("quoteIdentifier", () => {
    it("MySQL 使用反引号并转义反引号", () => {
      expect(quoteIdentifier("users", "mysql")).toBe("`users`");
      expect(quoteIdentifier("we`ird", "mysql")).toBe("`we``ird`");
    });

    it("PostgreSQL 使用双引号并转义双引号", () => {
      expect(quoteIdentifier("users", "postgres")).toBe('"users"');
      expect(quoteIdentifier('we"ird', "postgres")).toBe('"we""ird"');
    });

    it("SQLite 使用双引号并转义双引号", () => {
      expect(quoteIdentifier("users", "sqlite")).toBe('"users"');
      expect(quoteIdentifier('we"ird', "sqlite")).toBe('"we""ird"');
    });

    it("SQL Server 使用方括号并转义右方括号", () => {
      expect(quoteIdentifier("users", "sqlserver")).toBe("[users]");
      expect(quoteIdentifier("we]ird", "sqlserver")).toBe("[we]]ird]");
    });

    it("ClickHouse 使用反引号并转义反引号", () => {
      expect(quoteIdentifier("users", "clickhouse")).toBe("`users`");
      expect(quoteIdentifier("we`ird", "clickhouse")).toBe("`we``ird`");
    });
  });
});

function providerSuggestions(marked: string, binding: SqlCompletionBinding) {
  const offset = marked.indexOf("|");
  const sql = marked.replace("|", "");
  let provider!: Monaco.languages.CompletionItemProvider;
  const monaco = {
    languages: {
      CompletionItemKind: {
        Class: 1,
        Field: 2,
        Keyword: 3,
        Function: 4,
        Module: 5,
      },
      registerCompletionItemProvider: (
        _language: string,
        value: Monaco.languages.CompletionItemProvider
      ) => {
        provider = value;
        return { dispose() {} };
      },
    },
  } as unknown as typeof Monaco;
  const disposable = registerSqlCompletionProvider(
    monaco,
    "scope-test",
    () => binding
  );
  const model = {
    uri: { toString: () => "scope-test" },
    getValue: () => sql,
    getOffsetAt: () => offset,
    getPositionAt: (at: number) => ({ lineNumber: 1, column: at + 1 }),
    getVersionId: () => 1,
    isDisposed: () => false,
  } as unknown as Monaco.editor.ITextModel;
  const list = provider.provideCompletionItems(
    model,
    { lineNumber: 1, column: offset + 1 } as Monaco.Position,
    { triggerKind: 0 },
    { isCancellationRequested: false } as Monaco.CancellationToken
  ) as Monaco.languages.CompletionList;
  disposable.dispose();
  return list.suggestions;
}

describe("二期查询作用域 provider 集成", () => {
  it("重复补全共享一次批量元数据，派生表有输出且 CTE 不跨语句", async () => {
    const source = {
      getSqlCompletionMetadata: vi.fn().mockResolvedValue(completionSchema),
      getTableStructure: vi.fn(),
      executeQuery: vi.fn(),
    };
    const key = { ...completionKey, dialect: "postgres" as const };
    const schema = await loadSqlCompletionSchema(
      source,
      key.connId,
      key.database,
      key.dialect
    );
    const index = buildSqlMetadataIndex(schema, key);
    const readIndex = vi.fn(() => index);
    const binding = {
      key,
      revision: 0,
      get index() {
        return readIndex();
      },
    };
    const derived = providerSuggestions(
      "SELECT x.| FROM (SELECT id AS k FROM users) x",
      binding
    );
    expect(derived.map((item) => item.filterText)).toContain("k");
    expect(readIndex).toHaveBeenCalledTimes(1);
    const second = providerSuggestions(
      "WITH c AS (SELECT id FROM users) SELECT * FROM c; SELECT * FROM |",
      binding
    );
    expect(second.map((item) => item.label)).not.toContain("c");
    expect(second.map((item) => item.label)).toContain("users");
    expect(source.getSqlCompletionMetadata).toHaveBeenCalledTimes(1);
    expect(source.getTableStructure).not.toHaveBeenCalled();
    expect(source.executeQuery).not.toHaveBeenCalled();
  });
  it.each<SqlDialect>([
    "mysql",
    "postgres",
    "sqlite",
    "sqlserver",
    "clickhouse",
  ])("%s 的 CTE、派生表、EXISTS 与不支持形态", (dialect) => {
    const key = { ...completionKey, dialect };
    const binding = {
      key,
      revision: 0,
      index: buildSqlMetadataIndex(completionSchema, key),
    };
    const labels = (sql: string) =>
      providerSuggestions(sql, binding).map((item) => item.filterText);
    expect(
      labels("WITH c AS (SELECT id AS k FROM users) SELECT c.| FROM c")
    ).toContain("k");
    expect(labels("SELECT d.| FROM (SELECT id AS k FROM users) d")).toContain(
      "k"
    );
    expect(
      labels(
        "SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o WHERE u.|)"
      )
    ).toContain("name");
    expect(
      labels("SELECT d.| FROM (SELECT COLUMNS('x') FROM users) d")
    ).toEqual([]);
    expect(labels("SELECT * FROM other.users x WHERE x.|")).toEqual([]);
  });
});
