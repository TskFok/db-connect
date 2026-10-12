import { afterEach, describe, expect, it, vi } from "vitest";
import { unzipSync, strFromU8 } from "fflate";

describe("Excel Worker 消息协议", () => {
  afterEach(() => vi.unstubAllGlobals());
  async function scope() {
    const worker = {
      onmessage: null as null | ((event: MessageEvent) => Promise<void>),
      postMessage: vi.fn(),
    };
    vi.stubGlobal("self", worker);
    vi.resetModules();
    await import("../workers/excelExport.worker");
    return worker;
  }
  it("真实编码后使用 transfer list 返回 buffer，保留消息 ID", async () => {
    const worker = await scope();
    await worker.onmessage!({
      data: {
        id: "job-1",
        sheets: [{ sheet: "导出", data: [["id"], [9007199254740993n]] }],
      },
    } as MessageEvent);
    const [response, transfer] = worker.postMessage.mock.calls[0];
    expect(response.id).toBe("job-1");
    expect(response.buffer).toBeInstanceOf(ArrayBuffer);
    expect(transfer).toEqual([response.buffer]);
    expect(transfer[0]).toBe(response.buffer);
    const files = unzipSync(new Uint8Array(response.buffer));
    expect(strFromU8(files["xl/sharedStrings.xml"])).toContain(
      "9007199254740993"
    );
  });
  it("编码异常返回对应 ID 与错误，不发送成功产物", async () => {
    const worker = await scope();
    await worker.onmessage!({
      data: {
        id: "failed",
        sheets: [{ sheet: "error", data: [[new Date(NaN)]] }],
      },
    } as MessageEvent);
    const [response] = worker.postMessage.mock.calls[0];
    expect(response.id).toBe("failed");
    expect(response.error).toBeTruthy();
    expect(response.buffer).toBeUndefined();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
  });
});
