import type { SqlCompletionContext } from "./sqlCompletionTypes";

/** 常用管理命令的固定前缀；标识符、字符串参数不参与关键词匹配。 */
const MYSQL_COMMANDS = [
  "SELECT VERSION()",
  "SELECT DATABASE()",
  "START TRANSACTION",
  "COMMIT",
  "ROLLBACK",
  "ROLLBACK TO SAVEPOINT",
  "SAVEPOINT",
  "RELEASE SAVEPOINT",
  "SET GLOBAL",
  "SET SESSION",
  "SET PERSIST",
  "ANALYZE TABLE",
  "CHECK TABLE",
  "OPTIMIZE TABLE",
  "SHOW PROCESSLIST",
  "SHOW FULL PROCESSLIST",
  "SHOW DATABASES",
  "SHOW SCHEMAS",
  "SHOW TABLES",
  "SHOW FULL TABLES",
  "SHOW COLUMNS FROM",
  "SHOW FULL COLUMNS FROM",
  "SHOW FIELDS FROM",
  "SHOW FULL FIELDS FROM",
  "SHOW INDEX FROM",
  "SHOW CREATE DATABASE",
  "SHOW CREATE TABLE",
  "SHOW CREATE VIEW",
  "SHOW CREATE TRIGGER",
  "SHOW CREATE PROCEDURE",
  "SHOW CREATE FUNCTION",
  "SHOW TABLE STATUS",
  "SHOW OPEN TABLES",
  "SHOW STATUS",
  "SHOW GLOBAL STATUS",
  "SHOW SESSION STATUS",
  "SHOW VARIABLES",
  "SHOW GLOBAL VARIABLES",
  "SHOW SESSION VARIABLES",
  "SHOW ENGINE INNODB STATUS",
  "SHOW ENGINES",
  "SHOW WARNINGS",
  "SHOW ERRORS",
  "SHOW GRANTS",
  "SHOW TRIGGERS",
  "SHOW EVENTS",
  "SHOW CHARACTER SET",
  "SHOW COLLATION",
].map((command) => command.split(" "));

const COMMAND_STARTS = new Set(
  MYSQL_COMMANDS.map((command) => command[0]).filter(
    (word) => word !== "SELECT"
  )
);
const TABLE_COMMANDS = new Set(["ANALYZE", "CHECK", "OPTIMIZE"]);
const VARIABLE_SCOPES = new Set(["GLOBAL", "SESSION", "PERSIST"]);
const COMMON_VARIABLES = [
  "autocommit",
  "sql_mode",
  "time_zone",
  "transaction_isolation",
  "transaction_read_only",
  "wait_timeout",
  "interactive_timeout",
  "lock_wait_timeout",
  "innodb_lock_wait_timeout",
  "max_execution_time",
  "group_concat_max_len",
  "foreign_key_checks",
  "unique_checks",
  "sql_safe_updates",
  "sort_buffer_size",
  "join_buffer_size",
  "tmp_table_size",
  "max_heap_table_size",
  "optimizer_switch",
  "long_query_time",
];
const GLOBAL_VARIABLES = [
  "max_connections",
  "max_connect_errors",
  "connect_timeout",
  "slow_query_log",
  "general_log",
  "read_only",
  "super_read_only",
  "event_scheduler",
  "innodb_buffer_pool_size",
];
const BOOLEAN_VARIABLES = new Set([
  "AUTOCOMMIT",
  "TRANSACTION_READ_ONLY",
  "FOREIGN_KEY_CHECKS",
  "UNIQUE_CHECKS",
  "SQL_SAFE_UPDATES",
  "SLOW_QUERY_LOG",
  "GENERAL_LOG",
  "READ_ONLY",
  "SUPER_READ_ONLY",
  "SQL_LOG_BIN",
]);

export function isSqlCommandStart(word: string): boolean {
  return COMMAND_STARTS.has(word.toUpperCase());
}

/** 维护命令的目标表复用现有元数据索引、限定符和引用规则。 */
export function sqlCommandSlot(words: readonly string[]): "keyword" | "table" {
  if (!TABLE_COMMANDS.has(words[0]) || words[1] !== "TABLE") return "keyword";
  const target = words.slice(Math.max(2, words.lastIndexOf(",") + 1));
  return target.length === 0 || (target.length === 2 && target[1] === ".")
    ? "table"
    : "keyword";
}

function variableKeywords(words: readonly string[]): string[] {
  let scope = "SESSION";
  let segment = 1;
  let depth = 0;
  for (let i = 1; i < words.length; i++) {
    if (words[i] === "(") depth++;
    else if (words[i] === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && words[i] === ",") segment = i + 1;
    else if (depth === 0 && i === segment && VARIABLE_SCOPES.has(words[i])) {
      scope = words[i];
      segment++;
    }
  }
  const assignment = words.slice(segment);
  const variables = [
    ...COMMON_VARIABLES,
    ...(scope === "SESSION" ? ["sql_log_bin"] : GLOBAL_VARIABLES),
  ];
  if (assignment.length === 0) return variables;
  if (!variables.some((name) => name.toUpperCase() === assignment[0]))
    return [];
  if (assignment.length === 1) return ["="];
  if (assignment.length === 2 && assignment[1] === "=")
    return BOOLEAN_VARIABLES.has(assignment[0])
      ? ["DEFAULT", "ON", "OFF", "TRUE", "FALSE"]
      : ["DEFAULT"];
  return [];
}

/** 同时支持整段后缀和逐词输入，光标右侧已有内容时只补当前单词。 */
export function sqlCommandKeywords(context: SqlCompletionContext): string[] {
  if (context.dialect !== "mysql" || !context.command) return [];
  const { words, hasFollowingTokens } = context.command;
  const result = new Set<string>();
  for (const command of MYSQL_COMMANDS) {
    if (!words.every((word, index) => command[index] === word)) continue;
    const remaining = command.slice(words.length);
    if (!remaining.length) continue;
    result.add(remaining[0]);
    if (!hasFollowingTokens) result.add(remaining.join(" "));
  }
  if (words[0] === "SET")
    for (const variable of variableKeywords(words)) result.add(variable);
  return [...result];
}
