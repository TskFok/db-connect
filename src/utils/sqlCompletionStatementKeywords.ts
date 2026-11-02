import type { SqlDialect } from "./sqlCompletion";
import type { SqlToken } from "./sqlCompletionTypes";

// 固定前缀只覆盖对象类型之前的语法，不将对象名、表达式或子查询纳入命令匹配。
const DDL_OBJECTS: Record<SqlDialect, readonly string[]> = {
  mysql: [
    "DATABASE",
    "TABLE",
    "VIEW",
    "INDEX",
    "TRIGGER",
    "PROCEDURE",
    "FUNCTION",
  ],
  postgres: [
    "DATABASE",
    "SCHEMA",
    "TABLE",
    "VIEW",
    "MATERIALIZED VIEW",
    "INDEX",
    "SEQUENCE",
    "TYPE",
    "FUNCTION",
    "PROCEDURE",
    "TRIGGER",
  ],
  sqlite: ["TABLE", "VIEW", "INDEX", "TRIGGER"],
  sqlserver: [
    "DATABASE",
    "SCHEMA",
    "TABLE",
    "VIEW",
    "INDEX",
    "SEQUENCE",
    "PROCEDURE",
    "FUNCTION",
    "TRIGGER",
  ],
  clickhouse: [
    "DATABASE",
    "TABLE",
    "VIEW",
    "MATERIALIZED VIEW",
    "DICTIONARY",
    "FUNCTION",
  ],
};

const EXTRA_PREFIXES: Record<SqlDialect, readonly string[]> = {
  mysql: [
    "CREATE TEMPORARY TABLE",
    "CREATE UNIQUE INDEX",
    "CREATE OR REPLACE VIEW",
    "TRUNCATE TABLE",
    "RENAME TABLE",
    "DESCRIBE",
    "DESC",
    "USE",
  ],
  postgres: [
    "CREATE TEMP TABLE",
    "CREATE TEMPORARY TABLE",
    "CREATE UNLOGGED TABLE",
    "CREATE UNIQUE INDEX",
    "CREATE OR REPLACE VIEW",
    "CREATE OR REPLACE FUNCTION",
    "TRUNCATE TABLE",
    "ANALYZE",
    "VACUUM",
    "REINDEX",
    "SHOW",
    "SET",
    "RESET",
    "BEGIN",
    "BEGIN TRANSACTION",
    "START TRANSACTION",
    "COMMIT",
    "ROLLBACK",
    "ROLLBACK TO SAVEPOINT",
    "SAVEPOINT",
    "RELEASE SAVEPOINT",
  ],
  sqlite: [
    "CREATE TEMP TABLE",
    "CREATE TEMPORARY TABLE",
    "CREATE TEMP VIEW",
    "CREATE TEMP TRIGGER",
    "CREATE UNIQUE INDEX",
    "PRAGMA",
    "VACUUM",
    "ANALYZE",
    "REINDEX",
    "ATTACH DATABASE",
    "DETACH DATABASE",
    "BEGIN",
    "BEGIN TRANSACTION",
    "BEGIN DEFERRED",
    "BEGIN IMMEDIATE",
    "BEGIN EXCLUSIVE",
    "COMMIT",
    "END",
    "ROLLBACK",
    "ROLLBACK TO SAVEPOINT",
    "SAVEPOINT",
    "RELEASE SAVEPOINT",
  ],
  sqlserver: [
    "CREATE UNIQUE INDEX",
    "CREATE OR ALTER VIEW",
    "CREATE OR ALTER PROCEDURE",
    "CREATE OR ALTER FUNCTION",
    "CREATE OR ALTER TRIGGER",
    "TRUNCATE TABLE",
    "USE",
    "EXEC",
    "EXECUTE",
    "BEGIN TRANSACTION",
    "COMMIT",
    "COMMIT TRANSACTION",
    "ROLLBACK",
    "ROLLBACK TRANSACTION",
    "SAVE TRANSACTION",
    "SET SHOWPLAN_TEXT",
    "SET SHOWPLAN_XML",
  ],
  clickhouse: [
    "CREATE TEMPORARY TABLE",
    "SHOW DATABASES",
    "SHOW TABLES",
    "SHOW CREATE TABLE",
    "SHOW CREATE DATABASE",
    "DESCRIBE TABLE",
    "DESC TABLE",
    "USE",
    "SET",
    "OPTIMIZE TABLE",
    "TRUNCATE TABLE",
    "RENAME TABLE",
    "SYSTEM",
    "KILL QUERY",
    "CHECK TABLE",
    "EXISTS TABLE",
    "ATTACH TABLE",
    "DETACH TABLE",
  ],
};

function commandPrefixes(dialect: SqlDialect): string[][] {
  const objects = DDL_OBJECTS[dialect];
  // ALTER INDEX/TRIGGER 等方言差异较大，仅列通用且确实支持的类型。
  const alterObjects =
    dialect === "sqlite"
      ? ["TABLE"]
      : dialect === "clickhouse"
        ? ["TABLE", "DATABASE"]
        : dialect === "mysql"
          ? ["DATABASE", "TABLE", "VIEW", "PROCEDURE", "FUNCTION"]
          : objects;
  return [
    ...objects.map((object) => `CREATE ${object}`),
    ...alterObjects.map((object) => `ALTER ${object}`),
    ...objects.map((object) => `DROP ${object}`),
    ...EXTRA_PREFIXES[dialect],
  ].map((prefix) => prefix.split(" "));
}

export function getSqlStatementStartKeywords(dialect: SqlDialect): string[] {
  const result = new Set([
    "SELECT",
    "INSERT INTO",
    "UPDATE",
    "DELETE FROM",
    "WITH",
  ]);
  if (dialect !== "sqlserver") result.add("EXPLAIN");
  if (dialect === "mysql" || dialect === "sqlite") result.add("REPLACE INTO");
  if (dialect === "postgres" || dialect === "sqlserver")
    result.add("MERGE INTO");
  for (const command of commandPrefixes(dialect)) {
    result.add(command[0]);
    result.add(command.join(" "));
  }
  return [...result];
}

function unquotedWord(token: SqlToken | undefined): string | undefined {
  if (!token || token.quoted || !["identifier", "keyword"].includes(token.kind))
    return undefined;
  return token.text.toUpperCase();
}

function queryStarts(dialect: SqlDialect): string[] {
  return dialect === "clickhouse"
    ? ["SELECT", "WITH"]
    : [
        "SELECT",
        "INSERT",
        "UPDATE",
        "DELETE",
        "WITH",
        ...(dialect === "postgres" ? ["MERGE"] : []),
      ];
}

function explainKeywords(
  words: readonly string[],
  dialect: SqlDialect
): string[] {
  const starts = queryStarts(dialect);
  const options = words.slice(1);
  if (dialect === "sqlite") {
    if (!options.length) return [...starts, "QUERY", "QUERY PLAN"];
    if (options.join(" ") === "QUERY") return ["PLAN"];
    return options.join(" ") === "QUERY PLAN" ? starts : [];
  }
  if (dialect === "mysql") {
    if (!options.length) return [...starts, "ANALYZE", "FORMAT"];
    if (options[0] === "FORMAT") {
      if (options.length === 1) return ["="];
      if (options.length === 2 && options[1] === "=")
        return ["TRADITIONAL", "JSON", "TREE"];
      return starts;
    }
    return options[0] === "ANALYZE" ? starts : [];
  }
  if (dialect === "postgres") {
    if (!options.length) return [...starts, "ANALYZE", "VERBOSE"];
    if (options[options.length - 1] === "FORMAT")
      return ["TEXT", "XML", "JSON", "YAML"];
    if (options[0] === "(" && options[options.length - 1] !== ")")
      return [
        "ANALYZE",
        "VERBOSE",
        "COSTS",
        "SETTINGS",
        "BUFFERS",
        "WAL",
        "TIMING",
        "SUMMARY",
        "FORMAT",
        "TRUE",
        "FALSE",
      ];
    return [
      ...starts,
      ...(!options.includes("ANALYZE") ? ["ANALYZE"] : []),
      ...(!options.includes("VERBOSE") ? ["VERBOSE"] : []),
    ];
  }
  return !options.length
    ? [...starts, "AST", "SYNTAX", "QUERY TREE", "PLAN", "PIPELINE", "ESTIMATE"]
    : options.join(" ") === "QUERY"
      ? ["TREE"]
      : starts;
}

const COLUMN_TYPES: Record<SqlDialect, readonly string[]> = {
  mysql: [
    "INT",
    "BIGINT",
    "SMALLINT",
    "TINYINT",
    "DECIMAL",
    "FLOAT",
    "DOUBLE",
    "CHAR",
    "VARCHAR",
    "TEXT",
    "BLOB",
    "DATE",
    "DATETIME",
    "TIMESTAMP",
    "BOOLEAN",
    "JSON",
  ],
  postgres: [
    "INT",
    "INTEGER",
    "BIGINT",
    "SMALLINT",
    "SERIAL",
    "BIGSERIAL",
    "NUMERIC",
    "DECIMAL",
    "REAL",
    "DOUBLE PRECISION",
    "CHAR",
    "VARCHAR",
    "TEXT",
    "BYTEA",
    "DATE",
    "TIMESTAMP",
    "TIMESTAMPTZ",
    "BOOLEAN",
    "UUID",
    "JSON",
    "JSONB",
  ],
  sqlite: ["INTEGER", "REAL", "TEXT", "BLOB", "NUMERIC"],
  sqlserver: [
    "INT",
    "BIGINT",
    "SMALLINT",
    "TINYINT",
    "BIT",
    "DECIMAL",
    "NUMERIC",
    "FLOAT",
    "REAL",
    "CHAR",
    "VARCHAR",
    "NCHAR",
    "NVARCHAR",
    "VARBINARY",
    "DATE",
    "DATETIME",
    "DATETIME2",
    "DATETIMEOFFSET",
    "UNIQUEIDENTIFIER",
  ],
  clickhouse: [
    "Int8",
    "Int16",
    "Int32",
    "Int64",
    "UInt8",
    "UInt16",
    "UInt32",
    "UInt64",
    "Float32",
    "Float64",
    "Decimal",
    "String",
    "FixedString",
    "Date",
    "DateTime",
    "DateTime64",
    "UUID",
    "Bool",
    "Nullable",
    "Array",
    "Map",
    "Tuple",
  ],
};

function columnKeywords(
  segment: readonly SqlToken[],
  dialect: SqlDialect
): string[] {
  if (!segment.length || !["identifier", "keyword"].includes(segment[0].kind))
    return [];
  if (segment.length === 1) return [...COLUMN_TYPES[dialect]];
  if (
    !COLUMN_TYPES[dialect].some(
      (type) => type.toUpperCase().split(" ")[0] === unquotedWord(segment[1])
    )
  )
    return [];
  let depth = 0;
  for (const token of segment.slice(2)) {
    if (token.text === "(") depth++;
    if (token.text === ")") depth--;
    if (
      depth === 0 &&
      ["DEFAULT", "REFERENCES", "CHECK", "AS", "COMMENT"].includes(
        unquotedWord(token) ?? ""
      )
    )
      return [];
  }
  if (depth !== 0) return [];
  const last = unquotedWord(segment[segment.length - 1]);
  if (last === "NOT") return ["NULL"];
  if (last === "PRIMARY" || last === "FOREIGN") return ["KEY"];
  return dialect === "clickhouse"
    ? ["DEFAULT", "MATERIALIZED", "ALIAS", "CODEC", "TTL", "COMMENT"]
    : [
        "NULL",
        "NOT NULL",
        "DEFAULT",
        "PRIMARY KEY",
        "UNIQUE",
        "REFERENCES",
        "CHECK",
        ...(dialect === "mysql"
          ? ["AUTO_INCREMENT", "UNSIGNED", "COMMENT"]
          : []),
        ...(dialect === "sqlserver" ? ["IDENTITY"] : []),
      ];
}

function tableExistenceKeywords(
  tokens: readonly SqlToken[],
  dialect: SqlDialect
): string[] | undefined {
  const first = unquotedWord(tokens[0]);
  const condition =
    first === "CREATE" && dialect !== "sqlserver"
      ? ["IF", "NOT", "EXISTS"]
      : first === "DROP" || (first === "ALTER" && dialect === "postgres")
        ? ["IF", "EXISTS"]
        : undefined;
  if (!condition) return undefined;
  const table = tokens.findIndex((token) => unquotedWord(token) === "TABLE");
  if (table < 0) return undefined;
  const suffix = tokens.slice(table + 1);
  if (!suffix.every((token, index) => unquotedWord(token) === condition[index]))
    return undefined;
  const remaining = condition.slice(suffix.length);
  return remaining.length
    ? [...new Set([remaining[0], remaining.join(" ")])]
    : [];
}

/** 只识别简单表名和顶层列定义段，复杂表达式不提供推测候选。 */
function tableDefinitionKeywords(
  tokens: readonly SqlToken[],
  dialect: SqlDialect
): string[] | undefined {
  const first = unquotedWord(tokens[0]);
  if (first !== "CREATE" && first !== "ALTER") return undefined;
  const table = tokens.findIndex((token) => unquotedWord(token) === "TABLE");
  if (table < 0) return undefined;
  let at = table + 1;
  if (
    unquotedWord(tokens[at]) === "IF" &&
    unquotedWord(tokens[at + 1]) === "NOT" &&
    unquotedWord(tokens[at + 2]) === "EXISTS"
  )
    at += 3;
  else if (
    first === "ALTER" &&
    dialect === "postgres" &&
    unquotedWord(tokens[at]) === "IF" &&
    unquotedWord(tokens[at + 1]) === "EXISTS"
  )
    at += 2;
  const isName = (token: SqlToken | undefined) =>
    !!token && ["identifier", "keyword"].includes(token.kind);
  if (!isName(tokens[at])) return [];
  at++;
  while (tokens[at]?.text === "." && isName(tokens[at + 1])) at += 2;
  const tail = tokens.slice(at);
  if (first === "ALTER") {
    const actions =
      dialect === "mysql"
        ? [
            "ADD",
            "ADD COLUMN",
            "DROP",
            "DROP COLUMN",
            "MODIFY",
            "MODIFY COLUMN",
            "CHANGE",
            "CHANGE COLUMN",
            "ALTER COLUMN",
            "RENAME COLUMN",
            "RENAME TO",
          ]
        : dialect === "clickhouse"
          ? [
              "ADD COLUMN",
              "DROP COLUMN",
              "MODIFY COLUMN",
              "RENAME COLUMN",
              "ADD INDEX",
              "DROP INDEX",
            ]
          : dialect === "sqlite"
            ? ["ADD COLUMN", "DROP COLUMN", "RENAME COLUMN", "RENAME TO"]
            : dialect === "sqlserver"
              ? ["ADD", "DROP COLUMN", "ALTER COLUMN"]
              : [
                  "ADD COLUMN",
                  "DROP COLUMN",
                  "ALTER COLUMN",
                  "RENAME COLUMN",
                  "RENAME TO",
                ];
    if (!tail.length) return actions;
    if (["ADD", "MODIFY"].includes(unquotedWord(tail[0]) ?? "")) {
      const start = unquotedWord(tail[1]) === "COLUMN" ? 2 : 1;
      if (dialect === "sqlserver" && (tail.length === 1 || start === 2))
        return [];
      if (tail.length === 1) return ["COLUMN"];
      return columnKeywords(tail.slice(start), dialect);
    }
    return [];
  }
  if (tail[0]?.text !== "(") return [];
  let depth = 1;
  let start = 1;
  for (let i = 1; i < tail.length; i++) {
    if (tail[i].text === "(") depth++;
    else if (tail[i].text === ")") depth--;
    if (depth === 0) return [];
    if (depth === 1 && tail[i].text === ",") start = i + 1;
  }
  if (depth !== 1) return [];
  const segment = tail.slice(start);
  if (!segment.length)
    return dialect === "clickhouse"
      ? []
      : ["PRIMARY KEY", "UNIQUE", "FOREIGN KEY", "CHECK", "CONSTRAINT"];
  return columnKeywords(segment, dialect);
}

function withKeywords(
  tokens: readonly SqlToken[],
  dialect: SqlDialect
): string[] | undefined {
  if (tokens.length === 1) return dialect === "sqlserver" ? [] : ["RECURSIVE"];
  let depth = 0;
  let hasDefinition = false;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].text === "(") {
      if (depth === 0 && unquotedWord(tokens[i - 1]) === "AS")
        hasDefinition = true;
      depth++;
    } else if (tokens[i].text === ")") depth--;
    else if (
      depth === 0 &&
      ["SELECT", "INSERT", "UPDATE", "DELETE", "MERGE"].includes(
        unquotedWord(tokens[i]) ?? ""
      )
    )
      return undefined;
  }
  if (depth !== 0 || !hasDefinition || tokens[tokens.length - 1]?.text !== ")")
    return undefined;
  return dialect === "clickhouse"
    ? ["SELECT"]
    : [
        "SELECT",
        ...(dialect === "mysql" ? [] : ["INSERT INTO"]),
        "UPDATE",
        "DELETE FROM",
        ...(["postgres", "sqlserver"].includes(dialect) ? ["MERGE INTO"] : []),
      ];
}

/**
 * undefined 表示继续既有查询/管理命令解析；[] 表示已知命令正在接收参数。
 * 查询正文必须优先交回既有作用域解析，以保留 EXPLAIN/DDL 中的表和列补全。
 */
export function getSqlStatementPrefixKeywords(
  tokensBefore: readonly SqlToken[],
  dialect: SqlDialect,
  hasFollowingTokens: boolean
): string[] | undefined {
  const forCursor = (suggestions: string[] | undefined) =>
    suggestions && hasFollowingTokens
      ? [...new Set(suggestions.map((word) => word.split(" ")[0]))]
      : suggestions;
  const tokens = tokensBefore.filter((token) => token.kind !== "comment");
  const first = unquotedWord(tokens[0]);
  if (!first) return undefined;
  if (first === "WITH") return forCursor(withKeywords(tokens, dialect));
  const queryWords = new Set([
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "REPLACE",
    "MERGE",
    "WITH",
  ]);
  if (
    tokens.some(
      (token, index) =>
        queryWords.has(unquotedWord(token) ?? "") &&
        !(
          first === "CREATE" &&
          index === 2 &&
          unquotedWord(tokens[1]) === "OR" &&
          unquotedWord(token) === "REPLACE"
        )
    )
  )
    return undefined;
  const words = tokens.map((token) => unquotedWord(token) ?? token.text);
  if (first === "EXPLAIN") {
    if (dialect === "sqlserver") return undefined;
    return forCursor(explainKeywords(words, dialect));
  }
  // MySQL 原有 SHOW/SET/ANALYZE/事务等继续使用 sqlCompletionCommands。
  const commands = commandPrefixes(dialect);
  if (!commands.some((command) => command[0] === first)) return undefined;
  const existenceKeywords = tableExistenceKeywords(tokens, dialect);
  if (existenceKeywords !== undefined) return forCursor(existenceKeywords);
  const definitionKeywords = tableDefinitionKeywords(tokens, dialect);
  if (definitionKeywords !== undefined) return forCursor(definitionKeywords);
  if (
    dialect === "sqlserver" &&
    first === "SET" &&
    ["SHOWPLAN_TEXT", "SHOWPLAN_XML"].includes(words[1]) &&
    words.length === 2
  )
    return ["ON", "OFF"];
  const result = new Set<string>();
  for (const command of commands) {
    if (
      !words.every(
        (word, index) =>
          unquotedWord(tokens[index]) === word && command[index] === word
      )
    )
      continue;
    const remaining = command.slice(words.length);
    if (!remaining.length) continue;
    result.add(remaining[0]);
    if (!hasFollowingTokens) result.add(remaining.join(" "));
  }
  return [...result];
}
