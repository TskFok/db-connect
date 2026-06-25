import { arrayMove } from "@dnd-kit/sortable";
import type { ColumnType } from "antd/es/table";

/** 各 antd 列表在 settingsStore 中的持久化 key */
export const LIST_TABLE_IDS = {
  DATABASE_TABLE_LIST: "database-table-list",
  ROUTINE_LIST: "routine-list",
  EVENT_LIST: "event-list",
} as const;

export type ListTableId = (typeof LIST_TABLE_IDS)[keyof typeof LIST_TABLE_IDS];

/** 解析列宽：持久化值 > 默认值 > fallback */
export function resolveListColumnWidth(
  columnKey: string,
  storedWidths: Record<string, number>,
  defaultWidths: Record<string, number>,
  fallback = 120
): number {
  return (
    storedWidths[columnKey] ?? defaultWidths[columnKey] ?? fallback
  );
}

/**
 * 合并持久化列顺序与默认顺序：保留已知列的相对顺序，新增列追加在末尾。
 */
export function resolveListColumnOrder(
  defaultOrder: readonly string[],
  storedOrder?: readonly string[]
): string[] {
  if (!storedOrder || storedOrder.length === 0) {
    return [...defaultOrder];
  }
  const defaultSet = new Set(defaultOrder);
  const ordered = storedOrder.filter((key) => defaultSet.has(key));
  for (const key of defaultOrder) {
    if (!ordered.includes(key)) {
      ordered.push(key);
    }
  }
  return ordered;
}

/** 按 key 顺序重排列定义 */
export function orderColumnsByKeys<T>(
  columns: ColumnType<T>[],
  order: readonly string[]
): ColumnType<T>[] {
  const byKey = new Map<string, ColumnType<T>>();
  for (const col of columns) {
    const key = String(col.key ?? "");
    if (key) byKey.set(key, col);
  }
  return order
    .map((key) => byKey.get(key))
    .filter((col): col is ColumnType<T> => col != null);
}

/** 拖动表头后重排列 key 顺序 */
export function reorderListColumnKeys(
  order: readonly string[],
  activeId: string,
  overId: string
): string[] | null {
  const oldIndex = order.indexOf(activeId);
  const newIndex = order.indexOf(overId);
  if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) {
    return null;
  }
  return arrayMove([...order], oldIndex, newIndex);
}

/** 计算横向滚动总宽度 */
export function computeListTableScrollX(
  order: readonly string[],
  getColumnWidth: (key: string) => number
): number {
  return order.reduce((sum, key) => sum + getColumnWidth(key), 0);
}

export interface BuildListColumnsOptions {
  sortableHeaders?: boolean;
  getAutoFitWidth?: (columnKey: string) => number;
}

/**
 * 为 antd 列定义注入宽度、onHeaderCell（列宽调节 / 列顺序拖拽 / 双击自适应）。
 */
export function buildOrderedListColumns<T>(
  definitions: Record<string, ColumnType<T>>,
  order: readonly string[],
  getColumnWidth: (key: string) => number,
  handleColumnResize: (key: string) => (width: number) => void,
  options?: BuildListColumnsOptions
): ColumnType<T>[] {
  return order
    .filter((key) => definitions[key] != null)
    .map((key) => {
      const def = definitions[key]!;
      const width = getColumnWidth(key);
      const getAutoFit = options?.getAutoFitWidth;
      return {
        ...def,
        key,
        width,
        onHeaderCell: () => ({
          width,
          onResize: handleColumnResize(key),
          ...(options?.sortableHeaders
            ? { columnKey: key, sortable: true }
            : {}),
          ...(getAutoFit
            ? { onAutoFit: () => handleColumnResize(key)(getAutoFit(key)) }
            : {}),
        }),
      };
    });
}
