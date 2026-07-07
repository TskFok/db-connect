/** 禁止删除的 MySQL 系统库名称（小写） */
export const SYSTEM_DATABASE_NAMES = new Set([
  "mysql",
  "information_schema",
  "performance_schema",
  "system",
  "sys",
]);

/** 禁止删除/重命名的 PostgreSQL 系统 schema（小写） */
export const SYSTEM_POSTGRES_SCHEMAS = new Set([
  "pg_catalog",
  "information_schema",
  "pg_toast",
]);

export function isSystemDatabase(name: string): boolean {
  const lower = name.trim().toLowerCase();
  if (SYSTEM_DATABASE_NAMES.has(lower)) return true;
  // 兼容 PostgreSQL schema：pg_* 前缀（如 pg_temp_1, pg_toast_temp_1）一律视为系统对象。
  if (SYSTEM_POSTGRES_SCHEMAS.has(lower)) return true;
  if (lower.startsWith("pg_")) return true;
  return false;
}
