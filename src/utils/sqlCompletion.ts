/**
 * SQL 编辑器自动补全
 * 提供 MySQL 关键词、数据库、表名、列名的补全建议
 */

import type { SqlCompletionForeignKeyResult } from "../types";
import { buildJoinCandidates } from "./sqlCompletionJoin";
import type * as Monaco from "monaco-editor";
import type {
  SqlCompletionCacheKey,
  SqlMetadataIndex,
} from "./sqlCompletionTypes";
import { analyzeSqlCompletionTokens } from "./sqlCompletionContext";
import { createSqlCompletionDocumentCache } from "./sqlCompletionDocumentCache";
import { resolveSqlCompletionScopes } from "./sqlCompletionScopes";
import { generateSqlCompletionCandidates } from "./sqlCompletionCandidates";
import { buildSqlMetadataIndex } from "./sqlCompletionMetadataIndex";

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

/** ClickHouse 常用关键词（用于补全） */
export const CLICKHOUSE_KEYWORDS = [
  "SELECT",
  "INSERT",
  "CREATE",
  "DROP",
  "ALTER",
  "SHOW",
  "DESCRIBE",
  "EXPLAIN",
  "WITH",
  "FORMAT",
  "ENGINE",
  "MERGE TREE",
  "ORDER BY",
  "PARTITION BY",
  "SAMPLE",
  "LIMIT BY",
  "FROM",
  "WHERE",
  "GROUP BY",
  "HAVING",
  "LIMIT",
  "OFFSET",
  "JOIN",
  "LEFT JOIN",
  "INNER JOIN",
  "ON",
  "USING",
  "TABLE",
  "DATABASE",
  "VIEW",
  "MATERIALIZED VIEW",
  "FUNCTION",
  "ARRAY JOIN",
  "PREWHERE",
  "FINAL",
  "SETTINGS",
  "TTL",
  "PRIMARY KEY",
  "SET",
  "OPTIMIZE",
  "TRUNCATE",
  "SYSTEM",
  "KILL QUERY",
  "INT8",
  "INT16",
  "INT32",
  "INT64",
  "UINT8",
  "UINT16",
  "UINT32",
  "UINT64",
  "FLOAT32",
  "FLOAT64",
  "DECIMAL",
  "STRING",
  "FIXEDSTRING",
  "DATE",
  "DATETIME",
  "DATETIME64",
  "UUID",
  "ARRAY",
  "TUPLE",
  "MAP",
  "NULLABLE",
  "LOWCARDINALITY",
];

/** SQL 方言：决定标识符引用方式与关键词集合 */
export type SqlDialect =
  | "mysql"
  | "postgres"
  | "sqlite"
  | "sqlserver"
  | "clickhouse";

/** 按方言返回关键词列表 */
export function getSqlKeywords(dialect: SqlDialect = "mysql"): string[] {
  if (dialect === "postgres") return POSTGRES_KEYWORDS;
  if (dialect === "sqlite") return SQLITE_KEYWORDS;
  if (dialect === "sqlserver") return SQLSERVER_KEYWORDS;
  if (dialect === "clickhouse") return CLICKHOUSE_KEYWORDS;
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

/** SQL 源文本名称与 catalog 名称分开处理，避免把 PostgreSQL 别名 U 引用成 "U"。 */
export function quoteSqlReference(
  name: string,
  quoted: boolean,
  dialect: SqlDialect
): string {
  const semanticName =
    dialect === "postgres" && !quoted
      ? name.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
      : name;
  return quoteIdentifier(semanticName, dialect);
}

export interface SqlCompletionBinding {
  key: SqlCompletionCacheKey;
  index?: SqlMetadataIndex;
  revision: number;
  sessionId?: string;
  /** 由编辑器的显式补全动作开启，Monaco triggerKind 无法区分快速建议。 */
  allowJoinRecommendations?: boolean;
  foreignKeys?: {
    key: SqlCompletionCacheKey;
    result: SqlCompletionForeignKeyResult;
  };
  /** 可选守卫供编辑器在异步预取完成后刷新现有菜单。 */
  requestRefresh?: (isCurrent?: () => boolean) => void;
}

export function sqlCompletionKeyId(key: SqlCompletionCacheKey): string {
  return JSON.stringify([
    key.connId,
    key.database,
    key.dialect,
    key.connectionRevision,
  ]);
}

/** 每个 provider 只响应其绑定的模型；候选生成不等待网络。 */
export function registerSqlCompletionProvider(
  monaco: typeof Monaco,
  modelUri: string,
  getBinding: () => SqlCompletionBinding | undefined
): Monaco.IDisposable {
  let disposed = false;
  let requestSequence = 0;
  type Document = {
    model: Monaco.editor.ITextModel;
    cache: ReturnType<typeof createSqlCompletionDocumentCache>;
    version: number;
    dialect: SqlDialect;
    subscriptions: Monaco.IDisposable[];
  };
  let document: Document | undefined;
  const releaseDocument = () => {
    const previous = document;
    document = undefined;
    requestSequence++;
    if (!previous) return;
    for (const subscription of previous.subscriptions) subscription.dispose();
    previous.cache.dispose();
  };
  const resetDocument = (current: Document, dialect = current.dialect) => {
    current.version = current.model.getVersionId();
    current.dialect = dialect;
    current.cache.reset(current.model.getValue(), current.version, dialect);
  };
  const bindDocument = (
    model: Monaco.editor.ITextModel,
    dialect: SqlDialect
  ) => {
    if (document?.model !== model) {
      releaseDocument();
      const version = model.getVersionId();
      const current: Document = {
        model,
        cache: createSqlCompletionDocumentCache(
          model.getValue(),
          version,
          dialect
        ),
        version,
        dialect,
        subscriptions: [],
      };
      document = current;
      current.subscriptions.push(
        model.onDidChangeContent((event) => {
          if (document !== current) return;
          const version = model.getVersionId();
          // 已重建至最新模型版本时，迟到的旧事件不能再次应用旧坐标。
          if (current.version === version) return;
          if (
            event.isFlush ||
            event.versionId !== version ||
            !current.cache.applyChanges(event.changes, event.versionId)
          ) {
            resetDocument(current);
          } else current.version = event.versionId;
        }),
        model.onWillDispose(() => {
          if (document === current) releaseDocument();
        })
      );
    } else if (
      document.version !== model.getVersionId() ||
      document.dialect !== dialect
    ) {
      resetDocument(document, dialect);
    }
    return document!;
  };
  const registration = monaco.languages.registerCompletionItemProvider("sql", {
    triggerCharacters: [" ", ".", ",", "(", "\n"],
    provideCompletionItems(model, position, _completionContext, token) {
      const empty = { suggestions: [] };
      if (
        disposed ||
        token.isCancellationRequested ||
        model.isDisposed() ||
        model.uri.toString() !== modelUri
      )
        return empty;
      const binding = getBinding();
      if (!binding) {
        releaseDocument();
        return empty;
      }
      const currentDocument = bindDocument(model, binding.key.dialect);
      const sequence = ++requestSequence;
      const version = model.getVersionId();
      const revision = binding.revision;
      const sessionId = binding.sessionId;
      const keyId = sqlCompletionKeyId(binding.key);
      const isCurrent = () => {
        const current = getBinding();
        return (
          !disposed &&
          sequence === requestSequence &&
          document === currentDocument &&
          document.model === model &&
          !token.isCancellationRequested &&
          !model.isDisposed() &&
          model.getVersionId() === version &&
          current?.revision === revision &&
          current.sessionId === sessionId &&
          sqlCompletionKeyId(current.key) === keyId
        );
      };
      binding.requestRefresh?.(isCurrent);
      if (!isCurrent()) return empty;
      const offset = model.getOffsetAt(position);
      const syntax = currentDocument.cache.getStatement(offset);
      let context = analyzeSqlCompletionTokens({
        tokens: syntax.tokens,
        statement: syntax.statement,
        offset,
        dialect: binding.key.dialect,
      });
      context.defaultNamespace = binding.key.database;
      const start = model.getPositionAt(context.edit.start);
      const end = model.getPositionAt(context.edit.end);
      if (
        start.lineNumber !== end.lineNumber ||
        start.lineNumber !== position.lineNumber
      )
        return empty;
      const cachedIndex = binding.index;
      const index =
        cachedIndex && sqlCompletionKeyId(cachedIndex.key) === keyId
          ? cachedIndex
          : buildSqlMetadataIndex(
              { databases: [], tables: [], columns: [] },
              binding.key
            );
      context.defaultNamespace = index.key.database;
      context = resolveSqlCompletionScopes({ syntax, offset, context, index });
      const snapshot = binding.foreignKeys;
      const foreignKeys =
        snapshot &&
        sqlCompletionKeyId(snapshot.key) === keyId &&
        snapshot.result.status === "ready"
          ? snapshot.result.foreignKeys
          : [];
      const candidates = generateSqlCompletionCandidates(context, index);
      if (binding.allowJoinRecommendations) {
        candidates.unshift(...buildJoinCandidates(context, foreignKeys));
      }
      const kinds = monaco.languages.CompletionItemKind;
      const kindMap = {
        table: kinds.Class,
        column: kinds.Field,
        keyword: kinds.Keyword,
        function: kinds.Function,
        relation: kinds.Module,
      };
      const opener = syntax.tokens.find(
        (item) => item.start === context.edit.start
      )?.text[0];
      const quoted = opener === '"' || opener === "`" || opener === "[";
      if (!isCurrent()) return empty;
      return {
        incomplete: true,
        suggestions: candidates.map((candidate) => ({
          ...candidate,
          kind: kindMap[candidate.kind],
          // Monaco 匹配的是替换范围中的原文，开引号必须进入 filterText。
          filterText: quoted
            ? opener +
              candidate.filterText
                .split(opener === "[" ? "]" : opener)
                .join((opener === "[" ? "]" : opener).repeat(2)) +
              (opener === "[" ? "]" : opener)
            : candidate.filterText,
          range: {
            startLineNumber: start.lineNumber,
            startColumn: start.column,
            endLineNumber: end.lineNumber,
            endColumn: end.column,
          },
        })),
      };
    },
  });
  return {
    dispose() {
      disposed = true;
      releaseDocument();
      registration.dispose();
    },
  };
}
