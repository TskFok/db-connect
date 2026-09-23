import { queryFullRows } from "../../services/tauriCommands";

export interface DeferredFieldValue {
  __deferred_field: true;
  preview: string;
  byte_length: number;
  kind: "text" | "binary";
}

export function isDeferredField(value: unknown): value is DeferredFieldValue {
  if (!value || typeof value !== "object") return false;
  const field = value as Partial<DeferredFieldValue>;
  return (
    field.__deferred_field === true &&
    typeof field.preview === "string" &&
    typeof field.byte_length === "number" &&
    (field.kind === "text" || field.kind === "binary")
  );
}

export interface FullRowsContext {
  connId: string;
  database: string;
  table: string;
  primaryKeyColumns: string[];
  /** 仅 MySQL 表浏览使用预览标记；其他数据库可能存有同形 JSON 对象。 */
  databaseType?: string;
}

export async function fetchCompleteRows(
  context: FullRowsContext,
  rows: Record<string, unknown>[],
  selectColumns?: string[]
): Promise<{ columns: string[]; rows: Record<string, unknown>[] }> {
  if (rows.length === 0) return { columns: selectColumns ?? [], rows: [] };
  const { connId, database, table, primaryKeyColumns } = context;
  const keyOf = (row: Record<string, unknown>) => {
    if (
      primaryKeyColumns.length === 0 ||
      primaryKeyColumns.some(
        (key) =>
          row[key] === undefined ||
          row[key] === null ||
          typeof row[key] === "object"
      )
    )
      throw new Error("无法获取完整主键，请刷新表结构后重试");
    // 使用数组编码，避免字符串主键中的分隔符产生碰撞。
    return JSON.stringify(primaryKeyColumns.map((key) => row[key]));
  };
  const requestedKeys = rows.map(keyOf);
  const primaryKeys = rows.map((row) =>
    Object.fromEntries(primaryKeyColumns.map((key) => [key, row[key]]))
  );
  const args = [
    connId,
    database,
    table,
    primaryKeyColumns[0],
    primaryKeyColumns.length === 1
      ? rows.map((row) => row[primaryKeyColumns[0]])
      : [],
  ] as const;
  const compoundKeys = primaryKeyColumns.length > 1 ? primaryKeys : undefined;
  const result = selectColumns
    ? await queryFullRows(...args, compoundKeys, selectColumns)
    : compoundKeys
      ? await queryFullRows(...args, compoundKeys)
      : await queryFullRows(...args);
  const completeByKey = new Map<string, Record<string, unknown>>();
  for (const values of result.rows) {
    const record = Object.fromEntries(
      result.columns.map((column, i) => [column, values[i]])
    );
    const key = keyOf(record);
    if (completeByKey.has(key))
      throw new Error("完整主键匹配到多行，已停止读取");
    completeByKey.set(key, record);
  }
  const merged = rows.map((row, i) => {
    const complete = completeByKey.get(requestedKeys[i]);
    if (!complete) throw new Error("数据行已不存在或主键已变化，请刷新后重试");
    for (const column of selectColumns ?? result.columns) {
      if (
        !Object.prototype.hasOwnProperty.call(complete, column) ||
        complete[column] === undefined ||
        ((context.databaseType ?? "mysql") === "mysql" &&
          isDeferredField(complete[column]))
      ) {
        throw new Error(`字段 ${column} 未返回完整值，已停止操作`);
      }
    }
    return { ...row, ...complete };
  });
  return { columns: result.columns, rows: merged };
}

export async function hydrateDeferredRows(
  context: FullRowsContext,
  rows: Record<string, unknown>[],
  columns: string[]
): Promise<Record<string, unknown>[]> {
  const deferredColumns = columns.filter((column) =>
    rows.some((row) => isDeferredField(row[column]))
  );
  if (deferredColumns.length === 0) return rows;
  const deferredRows = rows.filter((row) =>
    deferredColumns.some((column) => isDeferredField(row[column]))
  );
  const complete = await fetchCompleteRows(
    context,
    deferredRows,
    deferredColumns
  );
  const replacements = new Map(
    deferredRows.map((row, i) => [row, complete.rows[i]])
  );
  return rows.map((row) => {
    const loaded = replacements.get(row);
    if (!loaded) return row;
    const merged = { ...row };
    for (const column of deferredColumns) {
      if (isDeferredField(row[column])) merged[column] = loaded[column];
    }
    return merged;
  });
}
