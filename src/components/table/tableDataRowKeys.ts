// 表数据行的稳定标识与选择键构建（纯函数，便于复用与单测）。

/**
 * 构建一行的选择键：
 * - 有完整主键时用「作用域|主键」，跨分页/排序仍稳定；
 * - 否则退化为「作用域|page|row」位置键。
 */
export function buildRowSelectionKey(
  scopeKey: string,
  primaryKeyColumns: string[],
  record: Record<string, unknown>,
  rowKey: number,
  page: number
): string {
  const hasAllPrimaryKeyValues =
    primaryKeyColumns.length > 0 &&
    primaryKeyColumns.every(
      (pk) =>
        Object.prototype.hasOwnProperty.call(record, pk) &&
        record[pk] !== undefined
    );

  if (scopeKey && hasAllPrimaryKeyValues) {
    const pkKey = primaryKeyColumns
      .map((pk) => `${pk}=${JSON.stringify(record[pk])}`)
      .join("|");
    return `${scopeKey}|${pkKey}`;
  }
  if (scopeKey) {
    return `${scopeKey}|page=${page}|row=${rowKey}`;
  }
  return `page=${page}|row=${rowKey}`;
}

/** 将主键集合规范化为与键顺序无关的稳定字符串（用于按行合并待提交修改）。 */
export function primaryKeysToStableRowKey(
  primaryKeys: Record<string, unknown>
): string {
  return Object.entries(primaryKeys)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join("|");
}

/** 构建单元格级待提交修改的键（行主键 + 列名）。 */
export function buildPendingChangeKey(
  primaryKeys: Record<string, unknown>,
  colName: string
): string {
  return `${primaryKeysToStableRowKey(primaryKeys)}|col=${JSON.stringify(colName)}`;
}

/** 从一行记录中抽取主键列的值。 */
export function getRecordPrimaryKeys(
  record: Record<string, unknown>,
  primaryKeyColumns: string[]
): Record<string, unknown> {
  const pks: Record<string, unknown> = {};
  for (const pk of primaryKeyColumns) {
    pks[pk] = record[pk];
  }
  return pks;
}

/** 从选中行中提取完整主键对象；主键缺失的行会被跳过，避免构造无法唯一定位的写请求。 */
export function collectSelectedPrimaryKeyRows(
  rows: Record<string, unknown>[],
  primaryKeyColumns: string[],
  selectedRowKeys: ReadonlySet<string>
): Record<string, unknown>[] {
  if (primaryKeyColumns.length === 0 || selectedRowKeys.size === 0) {
    return [];
  }
  return rows
    .filter((row) => selectedRowKeys.has(String(row._selectionKey)))
    .map((row) => getRecordPrimaryKeys(row, primaryKeyColumns))
    .filter((primaryKeys) =>
      primaryKeyColumns.every(
        (pk) =>
          Object.prototype.hasOwnProperty.call(primaryKeys, pk) &&
          primaryKeys[pk] !== undefined
      )
    );
}

/** 比较两组选择键是否完全一致（顺序敏感）。 */
export function sameRowSelectionKeys(
  a: readonly string[],
  b: readonly string[]
): boolean {
  if (a.length !== b.length) return false;
  return a.every((key, idx) => key === b[idx]);
}
