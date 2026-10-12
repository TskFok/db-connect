import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportExcelWithDialog } from "../utils/excelExport";
import { save } from "@tauri-apps/plugin-dialog";
import {
  cancelBinaryExport,
  prepareBinaryExport,
  writeBinaryExport,
} from "../services/tauriCommands";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn() }));
vi.mock("../services/tauriCommands", () => ({
  prepareBinaryExport: vi.fn(),
  writeBinaryExport: vi.fn(),
  cancelBinaryExport: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class ExportWorker {
  static instances: ExportWorker[] = [];
  static throwOnPost = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  request?: { id: string; sheets: unknown };
  terminate = vi.fn();
  constructor() {
    ExportWorker.instances.push(this);
  }
  postMessage(request: { id: string; sheets: unknown }) {
    if (ExportWorker.throwOnPost)
      throw new DOMException("无法克隆", "DataCloneError");
    this.request = request;
  }
  reply(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
  complete() {
    this.reply({
      id: this.request!.id,
      buffer: new Uint8Array([0, 255]).buffer,
    });
  }
}
const sheets = [{ sheet: "数据", data: [["id"], [1]] }];
function prepared() {
  return { sheets, release: vi.fn() };
}
async function currentWorker() {
  await vi.waitFor(() => expect(ExportWorker.instances).toHaveLength(1));
  return ExportWorker.instances[0];
}

describe("Excel 路径优先和资源生命周期", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    ExportWorker.instances = [];
    ExportWorker.throwOnPost = false;
    vi.stubGlobal("Worker", ExportWorker);
    vi.mocked(save).mockResolvedValue("/tmp/中文 空格.xlsx");
    vi.mocked(prepareBinaryExport).mockResolvedValue("export-id");
    vi.mocked(writeBinaryExport).mockResolvedValue(undefined);
    vi.mocked(cancelBinaryExport).mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("取消保存时零准备、零 Worker、零登记与写入", async () => {
    vi.mocked(save).mockResolvedValue(null);
    const prepare = vi.fn();
    expect(await exportExcelWithDialog("a.xlsx", prepare)).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(ExportWorker.instances).toHaveLength(0);
    expect(prepareBinaryExport).not.toHaveBeenCalled();
    expect(writeBinaryExport).not.toHaveBeenCalled();
  });

  it("已取消和对话框期间取消均不读取快照", async () => {
    const abort = new AbortController();
    abort.abort();
    const prepare = vi.fn();
    expect(await exportExcelWithDialog("a", prepare, abort.signal)).toBe(false);
    expect(save).not.toHaveBeenCalled();
    const dialog = deferred<string>();
    vi.mocked(save).mockReturnValue(dialog.promise);
    const waiting = new AbortController();
    const task = exportExcelWithDialog("b", prepare, waiting.signal);
    waiting.abort();
    dialog.resolve("/tmp/out.xlsx");
    expect(await task).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(ExportWorker.instances).toHaveLength(0);
  });

  it("原生对话框异常不会遗留忙状态", async () => {
    vi.mocked(save).mockRejectedValueOnce(new Error("对话框失败"));
    await expect(exportExcelWithDialog("a", vi.fn())).rejects.toThrow(
      "对话框失败"
    );
    vi.mocked(save).mockResolvedValue(null);
    expect(await exportExcelWithDialog("a", vi.fn())).toBe(false);
  });

  it("无法创建 Worker 时释放快照且不登记路径", async () => {
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("Worker 被阻止");
        }
      }
    );
    const snapshot = prepared();
    await expect(
      exportExcelWithDialog("a", async () => snapshot)
    ).rejects.toThrow("Worker 被阻止");
    expect(snapshot.release).toHaveBeenCalledTimes(1);
    expect(prepareBinaryExport).not.toHaveBeenCalled();
    vi.mocked(save).mockResolvedValue(null);
    expect(await exportExcelWithDialog("a", vi.fn())).toBe(false);
  });

  it("先选路径、准备一次、编码完成后才登记，原始二进制写入并释放", async () => {
    const dialog = deferred<string>();
    vi.mocked(save).mockReturnValue(dialog.promise);
    const snapshot = prepared();
    const prepare = vi.fn().mockResolvedValue(snapshot);
    const task = exportExcelWithDialog("a.xlsx", prepare);
    expect(prepare).not.toHaveBeenCalled();
    dialog.resolve("C:\\中文 空格\\数据.xlsx");
    const worker = await currentWorker();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(worker.request!.sheets).toBe(sheets);
    expect(prepareBinaryExport).not.toHaveBeenCalled();
    worker.complete();
    expect(await task).toBe(true);
    expect(prepareBinaryExport).toHaveBeenCalledWith(
      "C:\\中文 空格\\数据.xlsx"
    );
    expect(writeBinaryExport).toHaveBeenCalledWith(
      "export-id",
      new Uint8Array([0, 255]).buffer
    );
    expect(snapshot.release).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(cancelBinaryExport).not.toHaveBeenCalled();
  });

  it("准备失败不启动 Worker 或写入，失败后可以重试", async () => {
    await expect(
      exportExcelWithDialog("a", async () => {
        throw new Error("完整字段失败");
      })
    ).rejects.toThrow("完整字段失败");
    expect(ExportWorker.instances).toHaveLength(0);
    expect(prepareBinaryExport).not.toHaveBeenCalled();
    vi.mocked(save).mockResolvedValue(null);
    expect(await exportExcelWithDialog("a", vi.fn())).toBe(false);
  });

  it("跨入口导出互斥覆盖保存对话框等待期", async () => {
    const dialog = deferred<null>();
    vi.mocked(save).mockReturnValue(dialog.promise);
    const first = exportExcelWithDialog("a", vi.fn());
    await expect(exportExcelWithDialog("b", vi.fn())).rejects.toThrow(
      "已有导出任务正在进行"
    );
    expect(save).toHaveBeenCalledTimes(1);
    dialog.resolve(null);
    await first;
    vi.mocked(save).mockResolvedValue(null);
    expect(await exportExcelWithDialog("b", vi.fn())).toBe(false);
  });

  it("编码取消会终止 Worker 并释放租约，迟到消息和错误 ID 不写盘", async () => {
    const snapshot = prepared();
    const abort = new AbortController();
    const task = exportExcelWithDialog("a", async () => snapshot, abort.signal);
    const worker = await currentWorker();
    worker.reply({ id: "other", buffer: new ArrayBuffer(2) });
    expect(prepareBinaryExport).not.toHaveBeenCalled();
    const lateHandler = worker.onmessage!;
    abort.abort();
    expect(await task).toBe(false);
    lateHandler({
      data: { id: worker.request!.id, buffer: new ArrayBuffer(2) },
    } as MessageEvent);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(snapshot.release).toHaveBeenCalledTimes(1);
    expect(prepareBinaryExport).not.toHaveBeenCalled();
    expect(writeBinaryExport).not.toHaveBeenCalled();
  });

  it("准备途中取消仍等待迟到快照并释放租约", async () => {
    const preparation = deferred<ReturnType<typeof prepared>>();
    const abort = new AbortController();
    const prepare = vi.fn().mockReturnValue(preparation.promise);
    const task = exportExcelWithDialog("a", prepare, abort.signal);
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    abort.abort();
    const snapshot = prepared();
    preparation.resolve(snapshot);
    expect(await task).toBe(false);
    expect(snapshot.release).toHaveBeenCalledTimes(1);
    expect(ExportWorker.instances).toHaveLength(0);
  });

  it("登记期间取消会取消一次性 ID 并禁止写盘", async () => {
    const registration = deferred<string>();
    vi.mocked(prepareBinaryExport).mockReturnValue(registration.promise);
    const abort = new AbortController();
    const snapshot = prepared();
    const task = exportExcelWithDialog("a", async () => snapshot, abort.signal);
    (await currentWorker()).complete();
    await vi.waitFor(() =>
      expect(prepareBinaryExport).toHaveBeenCalledTimes(1)
    );
    abort.abort();
    registration.resolve("late-id");
    expect(await task).toBe(false);
    expect(cancelBinaryExport).toHaveBeenCalledWith("late-id");
    expect(writeBinaryExport).not.toHaveBeenCalled();
    expect(snapshot.release).toHaveBeenCalledTimes(1);
  });

  it("写盘已开始后取消仍等待真实结果，不声称已经撤销", async () => {
    const writing = deferred<void>();
    vi.mocked(writeBinaryExport).mockReturnValue(writing.promise);
    const abort = new AbortController();
    const snapshot = prepared();
    const task = exportExcelWithDialog("a", async () => snapshot, abort.signal);
    (await currentWorker()).complete();
    await vi.waitFor(() => expect(writeBinaryExport).toHaveBeenCalledTimes(1));
    abort.abort();
    expect(snapshot.release).not.toHaveBeenCalled();
    writing.resolve();
    expect(await task).toBe(true);
    expect(cancelBinaryExport).not.toHaveBeenCalled();
    expect(snapshot.release).toHaveBeenCalledTimes(1);
  });

  it.each(["encode", "error", "messageerror", "clone"])(
    "%s 失败释放 Worker 和租约，之后可重试",
    async (failure) => {
      const snapshot = prepared();
      if (failure === "clone") ExportWorker.throwOnPost = true;
      const task = exportExcelWithDialog("a", async () => snapshot);
      const assertion = expect(task).rejects.toBeTruthy();
      const worker = await currentWorker();
      if (failure === "encode")
        worker.reply({ id: worker.request!.id, error: "编码失败" });
      if (failure === "error")
        worker.onerror?.({
          message: "运行失败",
          preventDefault() {},
        } as ErrorEvent);
      if (failure === "messageerror") worker.onmessageerror?.();
      await assertion;
      expect(snapshot.release).toHaveBeenCalledTimes(1);
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(prepareBinaryExport).not.toHaveBeenCalled();
      vi.mocked(save).mockResolvedValue(null);
      expect(await exportExcelWithDialog("a", vi.fn())).toBe(false);
    }
  );

  it("写盘失败向上传递且尝试清理未领取登记", async () => {
    vi.mocked(writeBinaryExport).mockRejectedValue(new Error("磁盘写入失败"));
    // 后端已领取 ID 时取消可返回未知 ID，不覆盖原始写盘错误。
    vi.mocked(cancelBinaryExport).mockRejectedValue(new Error("未知 ID"));
    const snapshot = prepared();
    const task = exportExcelWithDialog("a", async () => snapshot);
    const assertion = expect(task).rejects.toThrow("磁盘写入失败");
    (await currentWorker()).complete();
    await assertion;
    expect(cancelBinaryExport).toHaveBeenCalledWith("export-id");
    expect(snapshot.release).toHaveBeenCalledTimes(1);
  });
});
