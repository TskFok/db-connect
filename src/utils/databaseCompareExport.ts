import type { DatabaseCompareResult } from "../types";
import {
  formatChangedFields,
  formatColumnSideValues,
  formatSchemaDiffStatus,
} from "./databaseCompare";
import {
  buildWorkbookBase64,
  saveExcelWithDialog,
  type ExcelSheetData,
} from "./excelExport";

export function buildDatabaseCompareWorkbookSheets(
  result: DatabaseCompareResult
): ExcelSheetData[] {
  const summary: ExcelSheetData = {
    sheet: "对比摘要",
    data: [
      ["项目", "值"],
      ["数据库类型", result.database_type],
      ["源连接", result.source.connection_name],
      ["源数据库/schema", result.source.database],
      ["目标连接", result.target.connection_name],
      ["目标数据库/schema", result.target.database],
      ["对比时间", result.compared_at],
      ["仅源端表", result.summary.source_only_tables],
      ["仅目标端表", result.summary.target_only_tables],
      ["结构变化表", result.summary.changed_tables],
      ["差异字段", result.summary.different_columns],
    ],
  };

  const tables: ExcelSheetData = {
    sheet: "表差异",
    data: [
      ["表名", "差异状态"],
      ...result.tables.map((table) => [
        table.name,
        formatSchemaDiffStatus(table.status),
      ]),
    ],
  };

  const columns: ExcelSheetData = {
    sheet: "字段差异",
    data: [
      ["表名", "字段名", "差异状态", "变化属性", "源端值", "目标端值"],
      ...result.tables
        .filter((table) => table.status === "changed")
        .flatMap((table) =>
          table.columns.map((column) => [
            table.name,
            column.name,
            formatSchemaDiffStatus(column.status),
            formatChangedFields(column.changed_fields),
            formatColumnSideValues(column, "source"),
            formatColumnSideValues(column, "target"),
          ])
        ),
    ],
  };

  return [summary, tables, columns];
}

export function buildDatabaseCompareWorkbookBase64(
  result: DatabaseCompareResult
): Promise<string> {
  return buildWorkbookBase64(buildDatabaseCompareWorkbookSheets(result));
}

export async function saveDatabaseCompareWorkbook(
  result: DatabaseCompareResult
): Promise<boolean> {
  const workbookBase64 = await buildDatabaseCompareWorkbookBase64(result);
  return saveExcelWithDialog(
    `数据库对比-${result.source.database}-${result.target.database}.xlsx`,
    workbookBase64
  );
}
