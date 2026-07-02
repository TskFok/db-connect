import type { ConnectionConfig } from "../types";
import { normalizeDatabaseType } from "./connectionConfig";

export function favoriteConnectionKey(config: ConnectionConfig): string {
  const id = config.id?.trim();
  if (id) return id;

  const databaseType = normalizeDatabaseType(config.database_type);
  return `session:${databaseType}|${config.host}|${config.port}|${config.username}|${config.database ?? ""}`;
}
