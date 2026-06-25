import type { ConnectionConfig } from "../types";
import { normalizeDatabaseType } from "./connectionConfig";

/**
 * 为「已保存 SQL」生成与连接绑定的键。
 * 优先使用已保存连接的 `id`（稳定）；否则用主机/账号/隧道等不含密码的指纹。
 */
export function savedSqlConnectionKey(config: ConnectionConfig): string {
  const id = config.id?.trim();
  if (id) return `profile:${id}`;

  const databaseType = normalizeDatabaseType(config.database_type);
  const ssl = `${config.ssl_mode ?? ""}|${config.ssl_ca_path ?? ""}|${config.ssl_pkcs12_path ?? ""}|${config.ssl_tls_hostname ?? ""}`;
  const adv = `${config.client_charset ?? ""}|${JSON.stringify(config.session_init_commands ?? [])}|${config.read_only === true}|${config.skip_dangerous_sql_confirm === true}`;
  const ssh = config.ssh
    ? `ssh:${config.ssh.host}|${config.ssh.port}|${config.ssh.username}`
    : "direct";
  return `session:${databaseType}|${config.host}|${config.port}|${config.username}|${config.database ?? ""}|${ssl}|${adv}|${ssh}`;
}

/** 用于列表展示的连接名称 */
export function savedSqlConnectionLabel(config: ConnectionConfig): string {
  const name = config.name?.trim();
  if (name) return name;
  return `${config.host}:${config.port}`;
}

/** 「已保存 SQL」仅展示当前连接：须存在且一致的 connectionKey */
export function filterSavedSqlByConnectionKey<T extends { connectionKey?: string }>(
  items: T[],
  connectionKey: string
): T[] {
  if (!connectionKey) return [];
  return items.filter(
    (item) => item.connectionKey != null && item.connectionKey === connectionKey
  );
}
