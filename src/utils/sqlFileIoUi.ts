import type { DatabaseType, ImportSqlFileResult, SqlExecuteResult } from "../types";
import * as api from "../services/tauriCommands";
import { normalizeDatabaseType } from "./connectionConfig";

/** 导入确认文案中是否包含备份提示（供单测断言） */
export const IMPORT_SQL_BACKUP_HINT =
  "重要：导入前建议先备份当前数据，或使用「导出当前库」保存 .sql 再操作。";

/**
 * 构建导入 SQL 文件的确认说明（纯文案，便于测试）
 */
export function buildImportSqlConfirmText(): string {
  return [
    "将按顺序执行文件中的语句（含 SELECT 时会执行并丢弃结果）。",
    "单条执行失败时将跳过该条并继续后续语句；结束时可查看失败条数与详情（详情条数有上限）。",
    "若包含 DROP、DELETE 等操作可能破坏数据，请确认文件来源可信。",
    "",
    IMPORT_SQL_BACKUP_HINT,
  ].join("\n");
}

const IMPORT_FAILURE_LINES_IN_MODAL = 12;

/** 供导入结束后 Modal 展示失败摘要（含未列出条数说明） */
export function buildImportFailureDetailsText(r: ImportSqlFileResult): string {
  if (r.statements_failed === 0) return "";
  const show = r.failures.slice(0, IMPORT_FAILURE_LINES_IN_MODAL);
  const lines = show.map((f) => {
    const preview = f.statement_preview?.trim();
    return preview
      ? `第 ${f.statement_index} 条：${preview}\n错误：${f.error}`
      : `第 ${f.statement_index} 条：${f.error}`;
  });
  if (r.failures.length > IMPORT_FAILURE_LINES_IN_MODAL) {
    lines.push(
      `…… 还有 ${r.failures.length - IMPORT_FAILURE_LINES_IN_MODAL} 条已记录详情未展开`
    );
  }
  if (r.statements_failed > r.failures.length) {
    lines.push(
      `…… 另有 ${r.statements_failed - r.failures.length} 条失败未记录详情`
    );
  }
  return lines.join("\n");
}

function truthyReadOnly(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "number" && value !== 0) return true;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    return s === "1" || s === "true" || s === "on";
  }
  return false;
}

/**
 * 解析 `SELECT @@global.read_only`（及可选 `super_read_only`）的执行结果；无法解析时返回 false（不阻断）。
 */
export function isServerReadOnlyFromSqlResult(result: SqlExecuteResult): boolean {
  if (result.result_type !== "select" || !result.columns?.length || !result.rows?.length) {
    return false;
  }
  const cols = result.columns.map((c) => c.toLowerCase());
  const row = result.rows[0];
  for (let i = 0; i < cols.length; i++) {
    const name = cols[i];
    if (
      name === "ro" ||
      name === "sro" ||
      name.includes("read_only") ||
      name.includes("super_read_only")
    ) {
      if (truthyReadOnly(row[i])) return true;
    }
  }
  return false;
}

/** @deprecated 请使用 isServerReadOnlyFromSqlResult（read_only 常为 GLOBAL-only） */
export const isSessionReadOnlyFromSqlResult = isServerReadOnlyFromSqlResult;

/**
 * 查询 @@global.read_only / super_read_only，判断实例是否全局只读（写操作前应调用）。
 */
export async function isConnectionGloballyReadOnly(
  connId: string,
  database: string,
  databaseType: DatabaseType | string | null | undefined = "mysql"
): Promise<boolean> {
  const normalizedType = normalizeDatabaseType(databaseType);
  if (normalizedType === "postgres") {
    const roCheck = await api.executeSql(
      connId,
      database,
      "SHOW transaction_read_only"
    );
    return isServerReadOnlyFromSqlResult(roCheck);
  }
  if (normalizedType === "sqlserver") {
    const roCheck = await api.executeSql(
      connId,
      database,
      "SELECT CAST(CASE WHEN DATABASEPROPERTYEX(DB_NAME(), 'Updateability') = 'READ_ONLY' THEN 1 ELSE 0 END AS int) AS ro"
    );
    return isServerReadOnlyFromSqlResult(roCheck);
  }

  let roCheck: SqlExecuteResult;
  try {
    roCheck = await api.executeSql(
      connId,
      database,
      "SELECT @@global.read_only AS ro, @@global.super_read_only AS sro"
    );
  } catch {
    roCheck = await api.executeSql(
      connId,
      database,
      "SELECT @@global.read_only AS ro"
    );
  }
  return isServerReadOnlyFromSqlResult(roCheck);
}
