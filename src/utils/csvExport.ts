/**
 * 单次导出最大行数（避免超大结果集占用过多内存）。
 * 须与后端 `execute_sql` / `explain_sql` 的 `MAX_EXECUTE_SQL_SELECT_ROWS` 保持一致。
 */
export const CSV_EXPORT_MAX_ROWS = 100_000;

export function assertCsvRowWithinLimit(rowCount: number): void {
  if (rowCount > CSV_EXPORT_MAX_ROWS) {
    throw new Error(
      `行数超过导出上限 ${CSV_EXPORT_MAX_ROWS.toLocaleString()}，请缩小查询范围后重试`
    );
  }
}
