import type { ConnectionConfig, DatabaseType } from "../types";

export const DEFAULT_DATABASE_TYPE: DatabaseType = "mysql";

export function normalizeDatabaseType(
  value: DatabaseType | string | null | undefined
): DatabaseType {
  if (value === "postgres") return "postgres";
  if (value === "sqlite") return "sqlite";
  if (value === "sqlserver") return "sqlserver";
  if (value === "clickhouse") return "clickhouse";
  return DEFAULT_DATABASE_TYPE;
}

export function normalizeConnectionConfig<T extends ConnectionConfig>(
  config: T
): T & { database_type: DatabaseType } {
  return {
    ...config,
    database_type: normalizeDatabaseType(config.database_type),
  };
}

export function defaultPortForDatabaseType(type: DatabaseType): number {
  if (type === "postgres") return 5432;
  if (type === "sqlite") return 0;
  if (type === "sqlserver") return 1433;
  if (type === "clickhouse") return 8123;
  return 3306;
}
