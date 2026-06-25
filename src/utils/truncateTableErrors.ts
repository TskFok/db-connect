/**
 * 将 TRUNCATE TABLE 失败时的底层错误转为更易懂的说明（仍保留原文便于排障）。
 */
export function formatTruncateTableError(raw: unknown): string {
  const base = raw instanceof Error ? raw.message : String(raw);
  const hint = hintForTruncateMessage(base);
  return hint ? `${base}\n\n${hint}` : base;
}

function hintForTruncateMessage(message: string): string | null {
  const m = message.toLowerCase();
  if (
    m.includes("1701") ||
    (m.includes("cannot truncate") && m.includes("foreign")) ||
    m.includes("foreign key constraint")
  ) {
    return "提示：该表可能被其他表的外键引用，InnoDB 下通常无法 TRUNCATE。可先调整外键/子表数据，或使用 DELETE（注意事务、锁与性能）。";
  }
  if (
    m.includes("1142") ||
    (m.includes("access denied") && m.includes("drop")) ||
    m.includes("denied for user")
  ) {
    return "提示：TRUNCATE 通常需要较高权限（如 DROP 或表级维护权限），请检查当前数据库账号权限。";
  }
  if (m.includes("read-only") || m.includes("read only") || m.includes("super_read_only")) {
    return "提示：实例或会话可能处于只读模式，请切换到可写连接后再操作。";
  }
  return null;
}
