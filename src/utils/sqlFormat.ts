import { format, type FormatOptionsWithLanguage } from "sql-formatter";
import type { SqlDialect } from "./sqlCompletion";

/** sql-formatter 支持的语言标识 */
export type SqlFormatterLanguage = FormatOptionsWithLanguage["language"];

/** 将编辑器方言映射为 sql-formatter 语言 */
export function sqlDialectToFormatterLanguage(
  dialect: SqlDialect
): SqlFormatterLanguage {
  switch (dialect) {
    case "postgres":
      return "postgresql";
    case "sqlite":
      return "sqlite";
    case "sqlserver":
      return "transactsql";
    case "clickhouse":
      return "clickhouse";
    case "mysql":
    default:
      return "mysql";
  }
}

export interface FormatSqlOptions {
  dialect?: SqlDialect;
  /** 缩进空格数，默认 2 */
  tabWidth?: number;
}

/**
 * 美化 SQL 文本；无法解析时抛出错误，由调用方提示用户。
 */
export function formatSql(sql: string, options: FormatSqlOptions = {}): string {
  const trimmed = sql.trim();
  if (!trimmed) return sql;

  const { dialect = "mysql", tabWidth = 2 } = options;
  return format(trimmed, {
    language: sqlDialectToFormatterLanguage(dialect),
    tabWidth,
    keywordCase: "upper",
  });
}
