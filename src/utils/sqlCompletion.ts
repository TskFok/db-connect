/**
 * SQL 编辑器自动补全
 * 提供 MySQL 关键词、数据库、表名、列名的补全建议
 */

import type * as Monaco from "monaco-editor";

/** 常用 MySQL 关键词 (按类别分组, 用于补全) */
export const MYSQL_KEYWORDS = [
  // DML
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  // 子句
  "FROM",
  "WHERE",
  "ORDER BY",
  "GROUP BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "INTO",
  "VALUES",
  "SET",
  // JOIN
  "JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "OUTER JOIN",
  "CROSS JOIN",
  "ON",
  "USING",
  // DDL
  "CREATE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "RENAME",
  "TABLE",
  "DATABASE",
  "INDEX",
  "VIEW",
  "TRIGGER",
  "PROCEDURE",
  "FUNCTION",
  // 类型/约束
  "NULL",
  "NOT NULL",
  "DEFAULT",
  "AUTO_INCREMENT",
  "PRIMARY KEY",
  "UNIQUE",
  "FOREIGN KEY",
  "REFERENCES",
  "CONSTRAINT",
  "CHAR",
  "VARCHAR",
  "TEXT",
  "INT",
  "BIGINT",
  "SMALLINT",
  "TINYINT",
  "DECIMAL",
  "FLOAT",
  "DOUBLE",
  "DATE",
  "DATETIME",
  "TIMESTAMP",
  "BLOB",
  // 其他
  "AS",
  "AND",
  "OR",
  "NOT",
  "IN",
  "EXISTS",
  "BETWEEN",
  "LIKE",
  "IS",
  "DISTINCT",
  "ALL",
  "UNION",
  "EXPLAIN",
  "DESCRIBE",
  "DESC",
  "SHOW",
  "USE",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "IF",
  "NULLIF",
  "COALESCE",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "ASC",
  "DESC",
  "ENGINE",
  "CHARSET",
  "COLLATE",
  "COMMENT",
  "ADD",
  "MODIFY",
  "CHANGE",
  "COLUMN",
  "AFTER",
  "FIRST",
  "IF NOT EXISTS",
  "IF EXISTS",
];

/** 在 MySQL 关键词基础上补充 PostgreSQL 常用关键词（用于补全） */
export const POSTGRES_KEYWORDS = [
  ...MYSQL_KEYWORDS.filter(
    // 去掉 MySQL 专属关键词，避免在 PostgreSQL 下误导
    (kw) =>
      ![
        "ENGINE",
        "CHARSET",
        "AUTO_INCREMENT",
        "MODIFY",
        "CHANGE",
        "DESCRIBE",
        "USE",
        "SHOW",
      ].includes(kw)
  ),
  // PostgreSQL 专属/常用
  "RETURNING",
  "ILIKE",
  "SIMILAR TO",
  "OFFSET",
  "FETCH",
  "WITH",
  "RECURSIVE",
  "SERIAL",
  "BIGSERIAL",
  "BOOLEAN",
  "TEXT",
  "JSONB",
  "JSON",
  "UUID",
  "NUMERIC",
  "REAL",
  "TIMESTAMPTZ",
  "INTERVAL",
  "ARRAY",
  "USING",
  "ANALYZE",
  "VACUUM",
  "SCHEMA",
  "SEQUENCE",
  "MATERIALIZED VIEW",
  "ON CONFLICT",
  "DO NOTHING",
  "DO UPDATE",
];

/** SQLite 常用关键词（用于补全） */
export const SQLITE_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "ALTER",
  "DROP",
  "TABLE",
  "VIEW",
  "INDEX",
  "TRIGGER",
  "PRAGMA",
  "EXPLAIN",
  "QUERY PLAN",
  "WITH",
  "RETURNING",
  "ON CONFLICT",
  "VACUUM",
  "ATTACH",
  "DETACH",
];

/** SQL Server 常用关键词（用于补全） */
export const SQLSERVER_KEYWORDS = [
  ...MYSQL_KEYWORDS.filter(
    (kw) =>
      ![
        "AUTO_INCREMENT",
        "CHANGE",
        "CHARSET",
        "DESCRIBE",
        "ENGINE",
        "FIRST",
        "IF",
        "MODIFY",
        "REPLACE",
        "USE",
      ].includes(kw)
  ),
  "TOP",
  "OFFSET",
  "FETCH",
  "FETCH NEXT",
  "ROW",
  "ROWS",
  "WITH",
  "MERGE",
  "OUTPUT",
  "NVARCHAR",
  "NCHAR",
  "BIT",
  "MONEY",
  "UNIQUEIDENTIFIER",
  "DATETIME2",
  "DATETIMEOFFSET",
  "SYSNAME",
  "GO",
  "SET SHOWPLAN_TEXT",
  "SET SHOWPLAN_XML",
];

/** SQL 方言：决定标识符引用方式与关键词集合 */
export type SqlDialect = "mysql" | "postgres" | "sqlite" | "sqlserver";

export interface SqlCompletionOptions {
  /** 数据库方言，默认 mysql */
  dialect?: SqlDialect;
}

/** 按方言返回关键词列表 */
export function getSqlKeywords(dialect: SqlDialect = "mysql"): string[] {
  if (dialect === "postgres") return POSTGRES_KEYWORDS;
  if (dialect === "sqlite") return SQLITE_KEYWORDS;
  if (dialect === "sqlserver") return SQLSERVER_KEYWORDS;
  return MYSQL_KEYWORDS;
}

/** 按方言对标识符加引号：MySQL 反引号、PostgreSQL/SQLite 双引号、SQL Server 方括号 */
export function quoteIdentifier(
  name: string,
  dialect: SqlDialect = "mysql"
): string {
  if (dialect === "sqlserver") {
    return "[" + name.replace(/\]/g, "]]") + "]";
  }
  if (dialect === "postgres" || dialect === "sqlite") {
    return '"' + name.replace(/"/g, '""') + '"';
  }
  return "`" + name.replace(/`/g, "``") + "`";
}

/** 补全项类型 */
export interface SqlSchema {
  databases: string[];
  tables: { name: string; table?: string }[];
  columns: { name: string; table: string; type?: string }[];
}

/**
 * 构建补全建议（纯函数，便于单测）。
 * @param monaco Monaco 实例（仅用于 CompletionItemKind 与类型）
 * @param prefix 当前输入前缀（原样，不要求大写）
 * @param schema 数据库/表/列数据
 * @param range 替换范围
 * @param options 方言等选项
 */
export function buildSqlSuggestions(
  monaco: typeof Monaco,
  prefix: string,
  schema: SqlSchema,
  range: Monaco.IRange,
  options: SqlCompletionOptions = {}
): Monaco.languages.CompletionItem[] {
  const dialect = options.dialect ?? "mysql";
  const keywords = getSqlKeywords(dialect);
  const upperPrefix = (prefix || "").toUpperCase();
  const lowerPrefix = (prefix || "").toLowerCase();
  const keywordDetail =
    dialect === "postgres"
      ? "PostgreSQL 关键词"
      : dialect === "sqlite"
        ? "SQLite 关键词"
        : dialect === "sqlserver"
          ? "SQL Server 关键词"
          : "MySQL 关键词";
  const dbDetail =
    dialect === "postgres" || dialect === "sqlserver" ? "schema" : "数据库";

  const suggestions: Monaco.languages.CompletionItem[] = [];

  // 1. 关键词
  for (const kw of keywords) {
    if (
      !upperPrefix ||
      kw.startsWith(upperPrefix) ||
      kw.includes(upperPrefix)
    ) {
      suggestions.push({
        label: kw,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: kw,
        range,
        detail: keywordDetail,
      });
    }
  }

  // 2. 数据库 / schema
  for (const db of schema.databases) {
    if (!lowerPrefix || db.toLowerCase().startsWith(lowerPrefix)) {
      suggestions.push({
        label: db,
        kind: monaco.languages.CompletionItemKind.Module,
        insertText: quoteIdentifier(db, dialect),
        range,
        detail: dbDetail,
      });
    }
  }

  // 3. 表名
  for (const t of schema.tables) {
    const name = t.name;
    if (!lowerPrefix || name.toLowerCase().startsWith(lowerPrefix)) {
      suggestions.push({
        label: name,
        kind: monaco.languages.CompletionItemKind.Class,
        insertText: quoteIdentifier(name, dialect),
        range,
        detail: "表",
      });
    }
  }

  // 4. 列名（带表名前缀便于区分）
  for (const col of schema.columns) {
    const name = col.name;
    if (!lowerPrefix || name.toLowerCase().startsWith(lowerPrefix)) {
      suggestions.push({
        label: col.table ? `${col.table}.${name}` : name,
        kind: monaco.languages.CompletionItemKind.Field,
        insertText: col.table
          ? `${quoteIdentifier(col.table, dialect)}.${quoteIdentifier(name, dialect)}`
          : quoteIdentifier(name, dialect),
        range,
        detail: col.type ? `列 (${col.type})` : "列",
      });
    }
  }

  return suggestions;
}

/**
 * 为 SQL 编辑器注册补全提供者
 * @param monaco Monaco 实例
 * @param getSchema 获取当前 schema (数据库/表/列), 由调用方根据连接和选中的数据库提供
 * @param options 方言等选项（动态读取，支持回调返回最新方言）
 * @returns 用于注销的 disposable
 */
export function registerSqlCompletionProvider(
  monaco: typeof Monaco,
  getSchema: () => Promise<SqlSchema>,
  options: SqlCompletionOptions | (() => SqlCompletionOptions) = {}
): Monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [" ", ".", ",", "(", "\n"],
    async provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range: Monaco.IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const resolvedOptions =
        typeof options === "function" ? options() : options;

      let schema: SqlSchema = { databases: [], tables: [], columns: [] };
      try {
        schema = await getSchema();
      } catch {
        // 无连接或加载失败时仅使用关键词
      }

      return {
        suggestions: buildSqlSuggestions(
          monaco,
          word.word || "",
          schema,
          range,
          resolvedOptions
        ),
      };
    },
  });
}
