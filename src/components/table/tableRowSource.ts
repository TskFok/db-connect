import { buildRowSelectionKey } from "./tableDataRowKeys";

/** 与原始页快照绑定的只读行源，业务记录仅在用户操作时物化。 */
export interface TableRowSource {
  readonly rowCount: number;
  getCell(index: number, column: string): unknown;
  getRowKey(index: number): string;
  getPrimaryKeys(index: number): Record<string, unknown>;
  materializeRows(
    indices: readonly number[],
    columns: readonly string[]
  ): Record<string, unknown>[];
}

export function createTableRowSource({
  rows,
  columns,
  primaryKeyColumns,
  scopeKey,
  page,
}: {
  rows: readonly (readonly unknown[])[];
  columns: readonly string[];
  primaryKeyColumns: readonly string[];
  scopeKey: string;
  page: number;
}): TableRowSource {
  const columnIndices = new Map(
    columns.map((column, index) => [column, index])
  );
  const primaryColumns = [...primaryKeyColumns];
  const getCell = (index: number, column: string): unknown => {
    const columnIndex = columnIndices.get(column);
    return columnIndex === undefined ? undefined : rows[index]?.[columnIndex];
  };
  const getPrimaryKeys = (index: number): Record<string, unknown> => {
    const keys: Record<string, unknown> = {};
    for (const column of primaryColumns) keys[column] = getCell(index, column);
    return keys;
  };
  // 只读主键建立稳定身份，不为每行分配完整业务记录。
  const rowKeys = rows.map((_, index) =>
    buildRowSelectionKey(
      scopeKey,
      primaryColumns,
      getPrimaryKeys(index),
      index,
      page
    )
  );
  return {
    rowCount: rows.length,
    getCell,
    getRowKey: (index) => rowKeys[index],
    getPrimaryKeys,
    materializeRows: (indices, requestedColumns) =>
      indices.map((index) => {
        const record: Record<string, unknown> = {};
        for (const column of requestedColumns) {
          // 未查询的隐藏列须保持缺失，由批量回源入口识别。
          if (columnIndices.has(column))
            record[column] = getCell(index, column);
        }
        Object.assign(record, getPrimaryKeys(index));
        record._rowKey = index;
        record._selectionKey = rowKeys[index];
        return record;
      }),
  };
}
