/**
 * 判断是否需在 SQL 编辑器执行前额外确认的语句（与 Popconfirm 独立的一轮确认）。
 * 仅做前缀级判断，不解析复杂语法。
 */
export function isDangerousSqlStatement(sql: string): boolean {
  const u = sql.trim().toUpperCase();
  if (u.startsWith("TRUNCATE")) return true;
  if (u.startsWith("DROP DATABASE")) return true;
  if (u.startsWith("DROP SCHEMA")) return true;
  return false;
}

export function listDangerousSqlStatements(statements: string[]): string[] {
  return statements.filter(isDangerousSqlStatement);
}
