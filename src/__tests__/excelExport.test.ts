import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildQueryResultWorkbookBase64,
  buildWorkbookBase64,
  cellValueForXlsx,
  sanitizeExcelSheetName,
  saveExcelWithDialog,
} from "../utils/excelExport";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
}));

vi.mock("../services/tauriCommands", () => ({
  writeBinaryFile: vi.fn(),
}));

import { save } from "@tauri-apps/plugin-dialog";
import { writeBinaryFile } from "../services/tauriCommands";

const XLSX_ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

describe("excelExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sanitizeExcelSheetName 替换非法字符并截断 31 字", () => {
    expect(sanitizeExcelSheetName("a:b*c")).toBe("a_b_c");
    expect(sanitizeExcelSheetName("")).toBe("Sheet1");
    expect(sanitizeExcelSheetName("x".repeat(40)).length).toBe(31);
  });

  it("cellValueForXlsx 映射 null / 数字 / 文本", () => {
    expect(cellValueForXlsx(null)).toBe("");
    expect(cellValueForXlsx(undefined)).toBe("");
    expect(cellValueForXlsx(3.14)).toBe(3.14);
    expect(cellValueForXlsx(BigInt("9"))).toBe("9");
    expect(cellValueForXlsx(true)).toBe(true);
    expect(cellValueForXlsx("a\tb")).toBe("a\tb");
  });

  it("buildQueryResultWorkbookBase64 生成有效 xlsx（ZIP 魔数）", async () => {
    const b64 = await buildQueryResultWorkbookBase64(
      ["id", "name"],
      [
        [1, "A"],
        [2e20, "B"],
      ],
      "t1"
    );
    const bytes = base64ToBytes(b64);
    expect(Array.from(bytes.slice(0, 4))).toEqual(XLSX_ZIP_MAGIC);
  });

  it("buildWorkbookBase64 生成多工作表 xlsx", async () => {
    const b64 = await buildWorkbookBase64([
      {
        sheet: "摘要",
        data: [
          ["项目", "值"],
          ["表数", 2],
        ],
      },
      { sheet: "明细", data: [["表名"], ["users"]] },
    ]);
    const bytes = base64ToBytes(b64);

    expect(Array.from(bytes.slice(0, 4))).toEqual(XLSX_ZIP_MAGIC);
  });

  it("saveExcelWithDialog 取消时不写入", async () => {
    vi.mocked(save).mockResolvedValue(null);
    const ok = await saveExcelWithDialog("a.xlsx", "eA==");
    expect(ok).toBe(false);
    expect(writeBinaryFile).not.toHaveBeenCalled();
  });

  it("saveExcelWithDialog 选择路径后写入", async () => {
    vi.mocked(save).mockResolvedValue("/tmp/out.xlsx");
    const ok = await saveExcelWithDialog("a.xlsx", "eA==");
    expect(ok).toBe(true);
    expect(writeBinaryFile).toHaveBeenCalledWith("/tmp/out.xlsx", "eA==");
  });
});
