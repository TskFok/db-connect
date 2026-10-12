import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  prepareBinaryExport,
  writeBinaryExport,
  cancelBinaryExport,
} from "../services/tauriCommands";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
describe("Excel 二进制 IPC 边界", () => {
  beforeEach(() => vi.resetAllMocks());
  it.each(["/tmp/中文 空格.xlsx", "C:\\用户\\导出 文件.xlsx"])(
    "路径通过 JSON 原样登记：%s",
    async (path) => {
      vi.mocked(invoke).mockResolvedValue("uuid");
      expect(await prepareBinaryExport(path)).toBe("uuid");
      expect(invoke).toHaveBeenCalledWith("prepare_binary_export", { path });
    }
  );
  it("原始 ArrayBuffer 直接作为请求体，头只含 ID", async () => {
    const bytes = new Uint8Array([0, 255, 1]).buffer;
    await writeBinaryExport("ascii-id", bytes);
    expect(invoke).toHaveBeenCalledWith("write_binary_export", bytes, {
      headers: { "x-db-connect-export-id": "ascii-id" },
    });
    expect(vi.mocked(invoke).mock.calls[0][1]).toBe(bytes);
    await cancelBinaryExport("ascii-id");
    expect(invoke).toHaveBeenLastCalledWith("cancel_binary_export", {
      exportId: "ascii-id",
    });
  });
});
