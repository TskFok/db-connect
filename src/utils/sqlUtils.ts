/**
 * 将多条 SQL 语句拆分为单条（按分号分隔，考虑引号、-- 与 # 行注释、块注释内的分号）
 */
export function splitSqlStatements(sql: string): string[] {
  const trimmed = sql.trim();
  if (!trimmed) return [];
  const result: string[] = [];
  let current = "";
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  while (i < trimmed.length) {
    const c = trimmed[i];
    if (inLineComment) {
      current += c;
      if (c === "\n") inLineComment = false;
      i++;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && trimmed[i + 1] === "/") {
        current += "*/";
        inBlockComment = false;
        i += 2;
      } else {
        current += c;
        i++;
      }
      continue;
    }
    if (escaped) {
      current += c;
      escaped = false;
      i++;
      continue;
    }
    if (c === "\\" && (inSingle || inDouble)) {
      escaped = true;
      current += c;
      i++;
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick) {
      if (c === "-" && trimmed[i + 1] === "-") {
        current += "--";
        inLineComment = true;
        i += 2;
        continue;
      }
      if (c === "#") {
        current += c;
        inLineComment = true;
        i++;
        continue;
      }
      if (c === "/" && trimmed[i + 1] === "*") {
        current += "/*";
        inBlockComment = true;
        i += 2;
        continue;
      }
      if (c === "'") {
        inSingle = true;
        current += c;
        i++;
        continue;
      }
      if (c === '"') {
        inDouble = true;
        current += c;
        i++;
        continue;
      }
      if (c === "`") {
        inBacktick = true;
        current += c;
        i++;
        continue;
      }
      if (c === ";") {
        const stmt = current.trim();
        if (stmt) result.push(stmt);
        current = "";
        i++;
        continue;
      }
    } else {
      if (c === "'" && inSingle) inSingle = false;
      if (c === '"' && inDouble) inDouble = false;
      if (c === "`" && inBacktick) inBacktick = false;
    }
    current += c;
    i++;
  }
  const last = current.trim();
  if (last) result.push(last);
  return result;
}

/** 超过该条数时，SQL 编辑器结果区使用摘要 + 可折叠列表，避免海量 DOM */
export const BULK_EXECUTED_SQL_UI_THRESHOLD = 20;

/** 批量模式下折叠面板内最多渲染的条数（其余提示用户在编辑器中查看） */
export const BULK_EXECUTED_SQL_PREVIEW_CAP = 200;

export interface ExecutedSqlPreview {
  total: number;
  visibleSlice: string[];
  hiddenCount: number;
  isBulk: boolean;
}

/**
 * 计算已执行 SQL 列表的展示摘要（批量执行时仅切片 + 计数）
 */
export function getExecutedSqlPreview(
  list: string[],
  threshold: number,
  previewCap: number
): ExecutedSqlPreview {
  const total = list.length;
  if (total === 0) {
    return { total: 0, visibleSlice: [], hiddenCount: 0, isBulk: false };
  }
  const isBulk = total > threshold;
  if (!isBulk) {
    return { total, visibleSlice: list.slice(), hiddenCount: 0, isBulk: false };
  }
  const cap = Math.max(0, Math.floor(previewCap));
  const visibleSlice = list.slice(0, cap);
  const hiddenCount = total - visibleSlice.length;
  return { total, visibleSlice, hiddenCount, isBulk: true };
}

/** 转义 SQL 字符串中的单引号和反斜杠，确保 MySQL 默认字符串模式下字面量可保真 */
export function escapeSqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "''");
}

/** 转义 MySQL 标识符（数据库名、表名、列名）中的反引号并包裹 */
export function escapeIdentifier(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

/** 将值格式化为 SQL 中的字面量 */
export function formatSqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${escapeSqlString(String(value))}'`;
}

/**
 * 生成 INSERT 语句
 * @param tableName 表名
 * @param allColumns 所有列名
 * @param rows 行数据 (object 格式)
 * @param excludeColumns 需要排除的列 (主键列)
 */
export function generateInsertStatements(
  tableName: string,
  allColumns: string[],
  rows: Record<string, unknown>[],
  excludeColumns: string[] = []
): string {
  const cols = allColumns.filter((c) => !excludeColumns.includes(c));
  if (cols.length === 0) return "";

  const colsPart = cols.map((c) => escapeIdentifier(c)).join(", ");

  const statements = rows.map((row) => {
    const values = cols.map((col) => formatSqlValue(row[col]));
    return `INSERT INTO ${escapeIdentifier(tableName)} (${colsPart}) VALUES (${values.join(", ")});`;
  });

  return statements.join("\n");
}

/** JSON.stringify 的 replacer：避免 BigInt 导致序列化抛错 */
function jsonSerializeReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  return value;
}

/**
 * 将多行数据按指定列导出为 JSON 数组字符串（每行一个对象，键顺序与 columnKeys 一致）
 */
export function rowsToJsonArrayString(
  rows: Record<string, unknown>[],
  columnKeys: string[]
): string {
  if (columnKeys.length === 0) return "[]";
  const arr = rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (const k of columnKeys) {
      obj[k] = row[k];
    }
    return obj;
  });
  return JSON.stringify(arr, jsonSerializeReplacer, 2);
}

/** 生成主键的稳定字符串 key，用于按行分组 */
function primaryKeysToRowKey(primaryKeys: Record<string, unknown>): string {
  return Object.entries(primaryKeys)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("|");
}

/**
 * 根据待提交修改生成 UPDATE 语句（每行一条 SQL，多列合并到 SET 子句）
 * @param database 数据库名
 * @param table 表名
 * @param changes 待提交修改列表，每项包含 primaryKeys、colName、newValue
 */
export function generateUpdateStatements(
  database: string,
  table: string,
  changes: Array<{
    primaryKeys: Record<string, unknown>;
    colName: string;
    newValue: unknown;
  }>
): string {
  const tableRef = `${escapeIdentifier(database)}.${escapeIdentifier(table)}`;
  const byRow = new Map<
    string,
    Array<{ colName: string; newValue: unknown }>
  >();
  for (const change of changes) {
    if (Object.keys(change.primaryKeys).length === 0) continue;
    const key = primaryKeysToRowKey(change.primaryKeys);
    const list = byRow.get(key) ?? [];
    list.push({ colName: change.colName, newValue: change.newValue });
    byRow.set(key, list);
  }
  const primaryKeysByKey = new Map<string, Record<string, unknown>>();
  for (const change of changes) {
    if (Object.keys(change.primaryKeys).length === 0) continue;
    const key = primaryKeysToRowKey(change.primaryKeys);
    if (!primaryKeysByKey.has(key))
      primaryKeysByKey.set(key, change.primaryKeys);
  }
  return Array.from(byRow.entries())
    .map(([rowKey, cols]) => {
      const primaryKeys = primaryKeysByKey.get(rowKey)!;
      const whereClause = Object.entries(primaryKeys)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${escapeIdentifier(k)} = ${formatSqlValue(v)}`)
        .join(" AND ");
      const setClause = cols
        .map(
          (c) =>
            `${escapeIdentifier(c.colName)} = ${formatSqlValue(c.newValue)}`
        )
        .join(", ");
      return `UPDATE ${tableRef} SET ${setClause} WHERE ${whereClause};`;
    })
    .join("\n");
}
