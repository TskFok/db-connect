import writeXlsxFile from "write-excel-file/universal";
import { assertCsvRowWithinLimit } from "./csvExport";

export interface ExcelExportSheetInput {
  sheet: string;
  data: readonly (readonly unknown[])[];
}

/** 兼容现有已经格式化的多工作表输入。 */
export interface ExcelSheetData {
  sheet: string;
  data: (string | number | boolean)[][];
}

/** Excel 工作表名非法字符，最长 31。 */
export function sanitizeExcelSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, "_").slice(0, 31);
  return cleaned.length > 0 ? cleaned : "Sheet1";
}

export function cellValueForXlsx(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number")
    return Number.isFinite(value) ? value : String(value);
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  // jsdom 的 Blob 没有 arrayBuffer；浏览器及 Worker 使用上面的原生路径。
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result);
      else reject(new Error("FileReader 未返回 ArrayBuffer"));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("FileReader 读取失败"));
    reader.readAsArrayBuffer(blob);
  });
}

/** 纯编码入口：值转换和规范化矩阵均在调用此函数的 Worker 中分配。 */
export async function buildWorkbookBuffer(
  sheets: ExcelExportSheetInput[]
): Promise<ArrayBuffer> {
  for (const sheet of sheets)
    assertCsvRowWithinLimit(Math.max(0, sheet.data.length - 1));
  const workbook = writeXlsxFile(
    sheets.map(({ sheet, data }) => ({
      sheet: sanitizeExcelSheetName(sheet),
      data: data.map((row) => row.map(cellValueForXlsx)),
    }))
  );
  return blobToArrayBuffer(await workbook.toBlob());
}
