/** 与后端 sql-import-progress / sql-export-progress 事件 payload 一致 */
export type SqlIoProgressPayload = { current: number; total: number };

export function sqlIoProgressPercent(
  p: SqlIoProgressPayload | null
): number | undefined {
  if (!p || p.total <= 0) return undefined;
  return Math.min(100, Math.round((p.current / p.total) * 100));
}
