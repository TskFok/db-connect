import type { ConnectionConfig, DatabaseType } from "../types";

export const DEFAULT_DATABASE_TYPE: DatabaseType = "mysql";

export function normalizeDatabaseType(
  value: DatabaseType | string | null | undefined
): DatabaseType {
  return value === "postgres" ? "postgres" : DEFAULT_DATABASE_TYPE;
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
  return type === "postgres" ? 5432 : 3306;
}
