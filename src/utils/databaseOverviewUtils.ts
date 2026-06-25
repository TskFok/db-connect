import type { TableInfo } from "../types";
import { formatBytes } from "./formatBytes";
import { resolveListColumnWidth } from "./listTableColumns";
import { getTableTotalSize } from "./tableStorageStats";

/** 数据库表列表默认列宽 */
export const DEFAULT_TABLE_LIST_COLUMN_WIDTHS: Record<string, number> = {
  name: 200,
  table_type: 100,
  engine: 100,
  rows: 120,
  data_length: 120,
  index_length: 120,
  total_size: 120,
  comment: 240,
  action: 152,
};

/** 数据库表列表默认列顺序 */
export const DEFAULT_TABLE_LIST_COLUMN_ORDER = [
  "name",
  "table_type",
  "engine",
  "rows",
  "data_length",
  "index_length",
  "total_size",
  "comment",
  "action",
] as const;

/** 表列表单元格用于自适应列宽的纯文本 */
export function getTableListCellText(
  record: TableInfo,
  columnKey: string
): string {
  switch (columnKey) {
    case "name":
      return record.name;
    case "table_type":
      return record.table_type;
    case "engine":
      return record.engine ?? "-";
    case "rows":
      return record.rows != null ? record.rows.toLocaleString() : "-";
    case "data_length":
      return formatBytes(record.data_length);
    case "index_length":
      return formatBytes(record.index_length);
    case "total_size":
      return formatBytes(getTableTotalSize(record));
    case "comment":
      return record.comment || "-";
    case "action":
      return "收藏 清空 删除";
    default:
      return "";
  }
}

/** @deprecated 使用 resolveListColumnWidth */
export function resolveTableListColumnWidth(
  columnKey: string,
  storedWidths: Record<string, number>
): number {
  return resolveListColumnWidth(
    columnKey,
    storedWidths,
    DEFAULT_TABLE_LIST_COLUMN_WIDTHS
  );
}

/** 过滤表列表 (按表名或注释匹配) */
export function filterTables(list: TableInfo[], keyword: string): TableInfo[] {
  if (!keyword.trim()) return list;
  const lower = keyword.trim().toLowerCase();
  return list.filter(
    (t) =>
      t.name.toLowerCase().includes(lower) ||
      (t.comment && t.comment.toLowerCase().includes(lower))
  );
}
