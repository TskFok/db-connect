import { save } from "@tauri-apps/plugin-dialog";
import {
  cancelBinaryExport,
  prepareBinaryExport,
  writeBinaryExport,
} from "../services/tauriCommands";
import type { ExcelExportSheetInput } from "./excelWorkbook";
import type {
  ExcelExportRequest,
  ExcelExportResponse,
} from "../workers/excelExport.worker";

export { assertCsvRowWithinLimit, CSV_EXPORT_MAX_ROWS } from "./csvExport";
export { cellValueForXlsx, sanitizeExcelSheetName } from "./excelWorkbook";
export type { ExcelExportSheetInput, ExcelSheetData } from "./excelWorkbook";

export interface PreparedExcelExport {
  sheets: ExcelExportSheetInput[];
  release: () => void;
}

let exporting = false;
let nextJobId = 0;

function encodeInWorker(
  sheets: ExcelExportSheetInput[],
  signal?: AbortSignal
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("../workers/excelExport.worker.ts", import.meta.url),
      { type: "module" }
    );
    const id = String(++nextJobId);
    let settled = false;
    const finish = (buffer?: ArrayBuffer, error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (buffer) resolve(buffer);
      else reject(error);
    };
    const abort = () =>
      finish(undefined, new DOMException("已取消导出", "AbortError"));
    worker.onmessage = ({ data }: MessageEvent<ExcelExportResponse>) => {
      if (data.id !== id) return;
      if ("error" in data) finish(undefined, new Error(data.error));
      else if (data.buffer instanceof ArrayBuffer) finish(data.buffer);
      else finish(undefined, new Error("Excel 编码未返回二进制内容"));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(undefined, new Error(event.message || "Excel 编码失败"));
    };
    worker.onmessageerror = () =>
      finish(undefined, new Error("无法读取 Excel 编码结果"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      worker.postMessage({ id, sheets } satisfies ExcelExportRequest);
    } catch (error) {
      finish(undefined, error);
    }
  });
}

/** 先选择路径；一旦开始写入，等待真实写入结果，不将后续取消视作撤销。 */
export async function exportExcelWithDialog(
  suggestedFileName: string,
  prepare: () => Promise<PreparedExcelExport>,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) return false;
  if (exporting) throw new Error("已有导出任务正在进行");
  exporting = true;
  let prepared: PreparedExcelExport | undefined;
  let exportId: string | undefined;
  try {
    const path = await save({
      defaultPath: suggestedFileName,
      filters: [{ name: "Excel", extensions: ["xlsx"] }],
    });
    if (path == null || signal?.aborted) return false;
    // 不以 Promise.race 丢弃迟到的快照：prepare 完成后必须释放其租约。
    prepared = await prepare();
    if (signal?.aborted) return false;
    const bytes = await encodeInWorker(prepared.sheets, signal);
    if (signal?.aborted) return false;
    // 编码完成后才登记，避免编码时间消耗一次性 ID 的 TTL。
    exportId = await prepareBinaryExport(path);
    if (signal?.aborted) return false;
    await writeBinaryExport(exportId, bytes);
    exportId = undefined;
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      return false;
    throw error;
  } finally {
    try {
      if (exportId) {
        // 写入失败可能已领取 ID；取消失败不得覆盖原始错误。
        await cancelBinaryExport(exportId).catch(() => undefined);
      }
    } finally {
      try {
        prepared?.release();
      } finally {
        exporting = false;
      }
    }
  }
}
