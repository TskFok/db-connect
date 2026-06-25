import { save } from "@tauri-apps/plugin-dialog";
import { writeBinaryFile } from "../services/tauriCommands";

export { assertCsvRowWithinLimit, CSV_EXPORT_MAX_ROWS } from "./csvExport";

/** Excel 工作表名非法字符，最长 31 */
export function sanitizeExcelSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, "_").slice(0, 31);
  return cleaned.length > 0 ? cleaned : "Sheet1";
}

export function cellValueForXlsx(value: unknown): string | number | boolean {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return String(value);
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, sub as unknown as number[]);
  }
  return btoa(binary);
}

function workbookWriteBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes =
    buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return uint8ArrayToBase64(bytes);
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === "function") {
    try {
      return await blob.arrayBuffer();
    } catch {
      /* jsdom 等环境可能不支持，回退 FileReader */
    }
  }
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

/** 生成 xlsx 的 Base64（供 `writeBinaryFile` 写入） */
export async function buildQueryResultWorkbookBase64(
  columns: string[],
  rows: unknown[][],
  sheetName: string
): Promise<string> {
  const sheetData: (string | number | boolean)[][] = [
    columns,
    ...rows.map((row) => row.map(cellValueForXlsx)),
  ];
  // 动态导入：仅在导出时加载；write-excel-file 不依赖 eval，兼容 Tauri CSP
  const writeXlsxFile = (await import("write-excel-file/universal")).default;
  const blob = await (
    await writeXlsxFile(sheetData, {
      sheet: sanitizeExcelSheetName(sheetName),
    })
  ).toBlob();
  const buf = await blobToArrayBuffer(blob);
  return workbookWriteBufferToBase64(buf);
}

/**
 * 弹出系统保存对话框并写入 xlsx。用户取消时返回 false。
 */
export async function saveExcelWithDialog(
  suggestedFileName: string,
  workbookBase64: string
): Promise<boolean> {
  const path = await save({
    defaultPath: suggestedFileName,
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (path == null) return false;
  await writeBinaryFile(path, workbookBase64);
  return true;
}
