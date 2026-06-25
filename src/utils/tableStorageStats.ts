import type { TableInfo } from "../types";

/** 判定为大索引的最小索引容量（字节） */
export const LARGE_INDEX_MIN_BYTES = 10 * 1024 * 1024;

/** 索引容量 / 数据大小 ≥ 该比例时视为大索引 */
export const LARGE_INDEX_RATIO = 0.5;

/** 无数据大小统计时，判定为大索引的最小索引容量（字节） */
export const LARGE_INDEX_FALLBACK_MIN_BYTES = 1024 * 1024;

export interface TableStorageSummary {
  totalDataLength: number;
  totalIndexLength: number;
  totalSize: number;
  tableCount: number;
}

/** 表总占用（数据 + 索引）；两者均为 null 时返回 null */
export function getTableTotalSize(table: TableInfo): number | null {
  if (table.data_length === null && table.index_length === null) {
    return null;
  }
  return (table.data_length ?? 0) + (table.index_length ?? 0);
}

/** 汇总库内表/视图的存储占用 */
export function summarizeTableStorage(tables: TableInfo[]): TableStorageSummary {
  let totalDataLength = 0;
  let totalIndexLength = 0;

  for (const table of tables) {
    totalDataLength += table.data_length ?? 0;
    totalIndexLength += table.index_length ?? 0;
  }

  return {
    totalDataLength,
    totalIndexLength,
    totalSize: totalDataLength + totalIndexLength,
    tableCount: tables.length,
  };
}

/** 是否属于「大索引」表（索引膨胀或索引超过数据容量） */
export function isLargeIndexTable(table: TableInfo): boolean {
  if (table.table_type === "VIEW") return false;

  const indexSize = table.index_length ?? 0;
  if (indexSize <= 0) return false;

  const dataSize = table.data_length ?? 0;
  if (indexSize >= LARGE_INDEX_MIN_BYTES) return true;
  if (dataSize <= 0) return indexSize >= LARGE_INDEX_FALLBACK_MIN_BYTES;

  return indexSize >= dataSize || indexSize / dataSize >= LARGE_INDEX_RATIO;
}

/** 筛选大索引表 */
export function filterLargeIndexTables(tables: TableInfo[]): TableInfo[] {
  return tables.filter(isLargeIndexTable);
}

/** 按总占用排序（降序） */
export function sortTablesByTotalSize(
  tables: TableInfo[],
  order: "desc" | "asc" = "desc"
): TableInfo[] {
  const sorted = [...tables].sort((a, b) => {
    const totalA = getTableTotalSize(a) ?? -1;
    const totalB = getTableTotalSize(b) ?? -1;
    return totalA - totalB;
  });
  return order === "desc" ? sorted.reverse() : sorted;
}
