import { escapeSqlString, escapeIdentifier } from "./sqlUtils";
import type { DatabaseType } from "../types";

/** 支持的 WHERE 操作符 */
export const WHERE_OPERATORS = [
  { value: "=", label: "等于 (=)" },
  { value: "!=", label: "不等于 (!=)" },
  { value: ">", label: "大于 (>)" },
  { value: ">=", label: "大于等于 (>=)" },
  { value: "<", label: "小于 (<)" },
  { value: "<=", label: "小于等于 (<=)" },
  { value: "LIKE", label: "模糊匹配 (LIKE)" },
  { value: "IN", label: "在列表中 (IN)" },
  { value: "BETWEEN", label: "介于 (BETWEEN)" },
  { value: "IS NULL", label: "为空 (IS NULL)" },
  { value: "IS NOT NULL", label: "不为空 (IS NOT NULL)" },
] as const;

export type WhereOperator = (typeof WHERE_OPERATORS)[number]["value"];
export type WhereSqlDialect = DatabaseType;

/** 需要两个值的操作符 */
export const TWO_VALUE_OPERATORS: WhereOperator[] = ["BETWEEN"];

/** 不需要值的操作符 */
export const NO_VALUE_OPERATORS: WhereOperator[] = ["IS NULL", "IS NOT NULL"];

/** 筛选配置 */
export interface WhereFilterConfig {
  column: string;
  operator: WhereOperator;
  value: string;
  value2?: string;
  /** 是否启用此筛选条件，默认 true；未启用的条件不参与 WHERE 构建 */
  enabled?: boolean;
  /**
   * 条件分组（用于 OR 支持）。
   * 规则：同一 group 内条件用 AND 连接；不同 group 之间用 OR 连接。
   * 未指定时默认归入 "1" 组，保持与历史行为一致。
   */
  group?: string;
}

/** 列名 -> MySQL column_type 的映射，用于判断是否字符串列 */
export type ColumnTypesMap = Record<string, string>;

function escapeIdentifierForDialect(
  name: string,
  dialect: WhereSqlDialect = "mysql"
): string {
  if (dialect === "postgres") {
    return `"${name.replace(/"/g, '""')}"`;
  }
  return escapeIdentifier(name);
}

function escapeStringForDialect(
  value: string,
  dialect: WhereSqlDialect = "mysql"
): string {
  if (dialect === "postgres") {
    return value.replace(/'/g, "''");
  }
  return escapeSqlString(value);
}

/**
 * 判断 MySQL 列类型是否为字符串类型（搜索时数字应格式化为字符串）
 */
/**
 * 列为字符串语义时，「值为空」表示匹配空字符串 ''（需配合 columnTypes 使用）
 * 类型未在映射中出现时视为可按字符串字面量处理空串
 */
export function columnSupportsEmptyStringValue(
  column: string,
  columnTypes?: ColumnTypesMap
): boolean {
  if (!columnTypes) return false;
  const ct = columnTypes[column];
  if (ct === undefined || ct === "") return true;
  return isStringColumnType(ct);
}

export function isStringColumnType(columnType: string): boolean {
  const lower = columnType.toLowerCase();
  const stringTypes = [
    "char",
    "varchar",
    "text",
    "tinytext",
    "mediumtext",
    "longtext",
    "json",
    "enum",
    "set",
    "binary",
    "varbinary",
  ];
  return stringTypes.some((t) => lower.startsWith(t));
}

/**
 * 安全地构建 WHERE 子句
 * @param config 筛选配置
 * @param allowedColumns 允许的列名列表 (用于防止 SQL 注入)
 * @param columnTypes 可选，列名到 MySQL column_type 的映射；字符串列搜索时数字将格式化为字符串
 */
export function buildWhereClause(
  config: WhereFilterConfig,
  allowedColumns: string[],
  columnTypes?: ColumnTypesMap,
  dialect: WhereSqlDialect = "mysql"
): string {
  const { column, operator, value } = config;

  if (!column || !operator) return "";

  // 验证列名在白名单中
  if (!allowedColumns.includes(column)) return "";

  const col = escapeIdentifierForDialect(column, dialect);
  const forceString =
    operator === "LIKE" ||
    (columnTypes && isStringColumnType(columnTypes[column] ?? ""));

  if (NO_VALUE_OPERATORS.includes(operator as WhereOperator)) {
    return `${col} ${operator}`;
  }

  if (operator === "BETWEEN") {
    const v1 = value.trim();
    const v2 = (config.value2 ?? "").trim();
    if (!v1 || !v2) return "";
    const fmt1 = formatValue(v1, forceString, dialect);
    const fmt2 = formatValue(v2, forceString, dialect);
    return `${col} BETWEEN ${fmt1} AND ${fmt2}`;
  }

  if (operator === "IN") {
    const parts = value
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (parts.length === 0) return "";
    const formatted = parts
      .map((v) => formatValue(v, forceString, dialect))
      .join(", ");
    return `${col} IN (${formatted})`;
  }

  // =, !=, >, >=, <, <=, LIKE
  const v = value.trim();
  if (!v) {
    // 空字符串：字符串列生成 = ''；LIKE 无类型信息时也允许 ''（与列类型推断一致）
    if (operator === "LIKE" || columnSupportsEmptyStringValue(column, columnTypes)) {
      return `${col} ${operator} ''`;
    }
    return "";
  }
  const formatted = formatValue(v, forceString, dialect);
  return `${col} ${operator} ${formatted}`;
}

/** 格式化单个值为 SQL 字面量；forceString 为 true 时数字也加引号（用于字符串列） */
function formatValue(
  input: string,
  forceString = false,
  dialect: WhereSqlDialect = "mysql"
): string {
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.toLowerCase() === "null") return "NULL";
  if (!forceString && /^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed;
  return `'${escapeStringForDialect(trimmed, dialect)}'`;
}

/**
 * 从多个筛选配置构建 WHERE 子句，用 AND 连接
 * @param configs 筛选配置列表
 * @param allowedColumns 允许的列名列表
 * @param columnTypes 可选，列名到 MySQL column_type 的映射
 */
export function buildWhereClauseFromFilters(
  configs: WhereFilterConfig[],
  allowedColumns: string[],
  columnTypes?: ColumnTypesMap,
  dialect: WhereSqlDialect = "mysql"
): string {
  const enabled = configs.filter((c) => c.enabled !== false);
  const groups = new Map<string, string[]>();
  for (const c of enabled) {
    const clause = buildWhereClause(c, allowedColumns, columnTypes, dialect);
    if (!clause) continue;
    const groupKey = (c.group ?? "1").trim() || "1";
    const arr = groups.get(groupKey) ?? [];
    arr.push(clause);
    groups.set(groupKey, arr);
  }
  const sortedGroups = Array.from(groups.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  if (sortedGroups.length === 0) return "";

  // 兼容历史行为：只有一个 group 时，直接用 AND 连接，不额外加括号
  if (sortedGroups.length === 1) {
    const clauses = sortedGroups[0]![1];
    return clauses.join(" AND ");
  }

  // 多 group：同组内 AND（用括号包起来），组间 OR
  const groupClauses = sortedGroups
    .map(([, clauses]) => {
      if (clauses.length === 0) return "";
      if (clauses.length === 1) return `(${clauses[0]!})`;
      return `(${clauses.join(" AND ")})`;
    })
    .filter(Boolean);
  return groupClauses.join(" OR ");
}
