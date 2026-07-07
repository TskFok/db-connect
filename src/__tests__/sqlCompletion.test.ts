import { describe, it, expect } from "vitest";
import {
  CLICKHOUSE_KEYWORDS,
  MYSQL_KEYWORDS,
  POSTGRES_KEYWORDS,
  SQLSERVER_KEYWORDS,
  SQLITE_KEYWORDS,
  buildSqlSuggestions,
  getSqlKeywords,
  quoteIdentifier,
  type SqlSchema,
} from "../utils/sqlCompletion";

// 仅需 CompletionItemKind 常量即可驱动 buildSqlSuggestions
const fakeMonaco = {
  languages: {
    CompletionItemKind: {
      Keyword: 1,
      Module: 2,
      Class: 3,
      Field: 4,
    },
  },
} as unknown as typeof import("monaco-editor");

const fakeRange = {
  startLineNumber: 1,
  endLineNumber: 1,
  startColumn: 1,
  endColumn: 1,
};

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

  describe("buildSqlSuggestions", () => {
    const schema: SqlSchema = {
      databases: ["app"],
      tables: [{ name: "users" }],
      columns: [{ name: "id", table: "users", type: "int" }],
    };

    it("PostgreSQL 方言下标识符使用双引号", () => {
      const suggestions = buildSqlSuggestions(
        fakeMonaco,
        "",
        schema,
        fakeRange,
        { dialect: "postgres" }
      );
      const db = suggestions.find((s) => s.label === "app");
      const table = suggestions.find((s) => s.label === "users");
      const col = suggestions.find((s) => s.label === "users.id");
      expect(db?.insertText).toBe('"app"');
      expect(table?.insertText).toBe('"users"');
      expect(col?.insertText).toBe('"users"."id"');
      // 关键词来自 PostgreSQL 集合
      expect(suggestions.some((s) => s.label === "RETURNING")).toBe(true);
    });

    it("MySQL 方言下标识符使用反引号", () => {
      const suggestions = buildSqlSuggestions(
        fakeMonaco,
        "",
        schema,
        fakeRange,
        { dialect: "mysql" }
      );
      const db = suggestions.find((s) => s.label === "app");
      const col = suggestions.find((s) => s.label === "users.id");
      expect(db?.insertText).toBe("`app`");
      expect(col?.insertText).toBe("`users`.`id`");
    });

    it("SQLite 方言下标识符使用双引号并提供 SQLite 关键词", () => {
      const suggestions = buildSqlSuggestions(
        fakeMonaco,
        "",
        schema,
        fakeRange,
        { dialect: "sqlite" }
      );
      const db = suggestions.find((s) => s.label === "app");
      const col = suggestions.find((s) => s.label === "users.id");
      expect(db?.insertText).toBe('"app"');
      expect(col?.insertText).toBe('"users"."id"');
      expect(suggestions.some((s) => s.label === "PRAGMA")).toBe(true);
    });

    it("SQL Server 方言下标识符使用方括号并提供 SQL Server 关键词", () => {
      const suggestions = buildSqlSuggestions(
        fakeMonaco,
        "",
        schema,
        fakeRange,
        { dialect: "sqlserver" }
      );
      const db = suggestions.find((s) => s.label === "app");
      const col = suggestions.find((s) => s.label === "users.id");
      expect(db?.insertText).toBe("[app]");
      expect(col?.insertText).toBe("[users].[id]");
      expect(suggestions.some((s) => s.label === "TOP")).toBe(true);
    });

    it("ClickHouse 方言下标识符使用反引号并提供 ClickHouse 关键词", () => {
      const suggestions = buildSqlSuggestions(
        fakeMonaco,
        "",
        schema,
        fakeRange,
        { dialect: "clickhouse" }
      );
      const db = suggestions.find((s) => s.label === "app");
      const col = suggestions.find((s) => s.label === "users.id");
      expect(db?.insertText).toBe("`app`");
      expect(col?.insertText).toBe("`users`.`id`");
      expect(suggestions.some((s) => s.label === "FORMAT")).toBe(true);
    });

    it("前缀过滤大小写不敏感地匹配表名", () => {
      const suggestions = buildSqlSuggestions(
        fakeMonaco,
        "us",
        schema,
        fakeRange,
        { dialect: "postgres" }
      );
      expect(suggestions.some((s) => s.label === "users")).toBe(true);
      // 不匹配前缀的库名应被过滤
      expect(suggestions.some((s) => s.label === "app")).toBe(false);
    });
  });
});
