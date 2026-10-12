import {
  buildWorkbookBuffer,
  type ExcelExportSheetInput,
} from "../utils/excelWorkbook";

export interface ExcelExportRequest {
  id: string;
  sheets: ExcelExportSheetInput[];
}
export type ExcelExportResponse =
  | { id: string; buffer: ArrayBuffer }
  | { id: string; error: string };

declare const self: {
  onmessage: (event: MessageEvent<ExcelExportRequest>) => Promise<void>;
  postMessage: (
    message: ExcelExportResponse,
    transfer?: Transferable[]
  ) => void;
};

self.onmessage = async ({ data: { id, sheets } }) => {
  try {
    const buffer = await buildWorkbookBuffer(sheets);
    self.postMessage({ id, buffer }, [buffer]);
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
