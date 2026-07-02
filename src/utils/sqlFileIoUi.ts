import type {
  DatabaseType,
  ImportSqlFileResult,
  SqlExecuteResult,
} from "../types";
import * as api from "../services/tauriCommands";
import { normalizeDatabaseType } from "./connectionConfig";

/** 导入确认文案中是否包含备份提示（供单测断言） */
export const IMPORT_SQL_BACKUP_HINT =
  "重要：导入前建议先备份当前数据，或使用「导出当前库」保存 .sql 再操作。";

/**
 * 构建导入 SQL 文件的确认说明（纯文案，便于测试）
 */
export function buildImportSqlConfirmText(
  databaseType: DatabaseType | string | null | undefined = "mysql"
): string {
  const normalizedType = normalizeDatabaseType(databaseType);
  if (normalizedType === "sqlserver") {
    return [
      "将按 GO 批处理分隔符拆分 SQL Server 文件，并按批顺序执行（含 SELECT 时会执行并丢弃结果）。",
      "单个批次执行失败时将跳过该批并继续后续批次；结束时可查看失败条数与详情（详情条数有上限）。",
      "未显式限定 schema 的对象名仍按 SQL Server 当前用户默认 schema 执行；本应用导出的 SQL 会保留 schema 前缀。",
      "若包含 DROP、DELETE 等操作可能破坏数据，请确认文件来源可信。",
      "",
      IMPORT_SQL_BACKUP_HINT,
    ].join("\n");
  }
  return [
    "将按顺序执行文件中的语句（含 SELECT 时会执行并丢弃结果）。",
    "单条执行失败时将跳过该条并继续后续语句；结束时可查看失败条数与详情（详情条数有上限）。",
    "若包含 DROP、DELETE 等操作可能破坏数据，请确认文件来源可信。",
    "",
    IMPORT_SQL_BACKUP_HINT,
  ].join("\n");
}

export function buildImportReadOnlyWarningText(
  databaseType: DatabaseType | string | null | undefined = "mysql"
): string {
  const normalizedType = normalizeDatabaseType(databaseType);
  if (normalizedType === "postgres") {
    return "当前 PostgreSQL 会话处于只读模式，无法执行写入类导入。请切换到可写连接或调整事务只读设置。";
  }
  if (normalizedType === "sqlserver") {
    return "当前 SQL Server database 处于 READ_ONLY 或连接为只读模式，无法执行写入类导入。请切换到可写 database 或调整连接只读设置。";
  }
  return "实例处于只读（read_only / super_read_only），无法执行写入类导入。请在可写副本或主库上操作。";
}

export function buildExportSqlDescription(
  databaseType: DatabaseType | string | null | undefined = "mysql"
): string {
  const normalizedType = normalizeDatabaseType(databaseType);
  if (normalizedType === "postgres") {
    return "将生成当前 schema 的 CREATE SCHEMA、表、视图、索引、外键、触发器、函数/过程定义，及可选 INSERT；导入时可先选中目标 schema 或修改导出文件中的 search_path。";
  }
  if (normalizedType === "sqlserver") {
    return "将生成当前 schema 的 CREATE SCHEMA、表、视图、索引、外键、触发器、函数/过程定义，及可选 INSERT；脚本使用 SQL Server 的 GO 分隔模块批次，导入时请在目标 database 中执行。";
  }
  if (normalizedType === "sqlite") {
    return "将生成当前 SQLite database 的表、视图、索引、触发器定义，及可选 INSERT；导入时请选中目标 SQLite 连接后执行。";
  }
  return "将生成表/视图的 CREATE、触发器与事件定义，及可选的 INSERT；语句使用当前默认库（无 USE 源库名、INSERT 不带库前缀），导入时在左侧选中目标库即可迁入其它库名。非 mysqldump。";
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
export function isServerReadOnlyFromSqlResult(
  result: SqlExecuteResult
): boolean {
  if (
    result.result_type !== "select" ||
    !result.columns?.length ||
    !result.rows?.length
  ) {
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
