import type { IndexInfo } from "../types";

/** 从 IndexInfo 推断索引种类 (用于 CreateIndexRequest.index_type) */
export function getIndexKind(info: IndexInfo): string {
  if (info.index_type === "FULLTEXT") return "FULLTEXT";
  if (info.index_type === "SPATIAL") return "SPATIAL";
  if (info.unique) return "UNIQUE";
  return "INDEX";
}

/** 从 IndexInfo 推断索引方法 (用于 CreateIndexRequest.index_method) */
export function getIndexMethod(info: IndexInfo): string | undefined {
  if (info.index_type === "FULLTEXT" || info.index_type === "SPATIAL") {
    return undefined;
  }
  return info.index_type; // "BTREE" or "HASH"
}

/** 将 IndexInfo.columns 转换为 IndexEditor 表单格式 */
export function indexColumnsToFormValues(
  info: IndexInfo
): { column_name: string; length: number | undefined; order: string | undefined }[] {
  return info.columns.map((col) => ({
    column_name: col.column_name,
    length: col.sub_part ?? undefined,
    order: col.collation === "D" ? "DESC" : col.collation === "A" ? "ASC" : undefined,
  }));
}
