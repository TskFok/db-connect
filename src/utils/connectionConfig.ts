import type { ConnectionConfig, DatabaseType } from "../types";

export const DEFAULT_DATABASE_TYPE: DatabaseType = "mysql";

const DISABLED_SSL_MODES = new Set(["", "disabled", "none", "off"]);

export function normalizeSslMode(sslMode?: string): string {
  const normalized = sslMode?.trim().toLowerCase() ?? "";
  return DISABLED_SSL_MODES.has(normalized) ? "disabled" : normalized;
}

export function hasEnabledSsl(sslMode?: string): boolean {
  return normalizeSslMode(sslMode) !== "disabled";
}

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
