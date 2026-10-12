import { unzipSync, strFromU8 } from "fflate";
// 该虚拟模块由 runner 从固定 Git 提交提取，避免基线随当前代码变化。
// @ts-expect-error Vite runner 提供此只读虚拟模块
import * as baseline from "virtual:excel-export-baseline";
const { cellValueForXlsx, uint8ArrayToBase64, blobToArrayBuffer } = baseline;

type Sheet = { sheet: string; data: readonly (readonly unknown[])[] };
declare global {
  interface Window {
    webkit: {
      messageHandlers: { benchmark: { postMessage: (value: unknown) => void } };
    };
  }
}
const params = new URLSearchParams(location.search);
const post = (value: unknown) =>
  window.webkit.messageHandlers.benchmark.postMessage(value);
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const absoluteNow = () => performance.timeOrigin + performance.now();
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const cspViolations: string[] = [];
document.addEventListener("securitypolicyviolation", (event) =>
  cspViolations.push(`${event.violatedDirective}: ${event.blockedURI}`)
);

function fixture(rows: number, columns: number, wide: boolean) {
  const headers = Array.from({ length: columns }, (_, c) => `字段_${c}`);
  const data = Array.from({ length: rows }, (_, r) =>
    Array.from({ length: columns }, (_, c) => {
      if (wide && c >= 8)
        return `宽字段_${r}_${c}_` + "Unicode 中文 😀 ab<&>".repeat(12);
      switch (c % 8) {
        case 0:
          return r;
        case 1:
          return `行_${r}_中文😀<&>`;
        case 2:
          return null;
        case 3:
          return r % 2 === 0;
        case 4:
          return 9007199254740993n + BigInt(r);
        case 5:
          return new Date(Date.UTC(2026, 0, 1, 0, 0, r % 60));
        case 6:
          return r / 10;
        default:
          return `文本_${r}`;
      }
    })
  );
  return { headers, data };
}

async function checkContent(buffer: ArrayBuffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const worksheetFiles = Object.keys(files)
    .filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path))
    .sort();
  const hashes = [];
  for (const path of worksheetFiles) {
    const bytes = files[path];
    const xml = strFromU8(bytes);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      bytes as Uint8Array<ArrayBuffer>
    );
    hashes.push({
      path,
      rows: (xml.match(/<row\b/g) ?? []).length,
      cells: (xml.match(/<c\b/g) ?? []).length,
      sha256: Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0")
      ).join(""),
    });
  }
  const workbook = strFromU8(files["xl/workbook.xml"]);
  const supportingXML = [];
  for (const path of Object.keys(files)
    .filter(
      (path) =>
        path.startsWith("xl/") &&
        path.endsWith(".xml") &&
        !worksheetFiles.includes(path)
    )
    .sort()) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      files[path] as Uint8Array<ArrayBuffer>
    );
    supportingXML.push({
      path,
      sha256: Array.from(new Uint8Array(digest), (b) =>
        b.toString(16).padStart(2, "0")
      ).join(""),
    });
  }
  assert(worksheetFiles.length > 0, "XLSX 必须包含工作表");
  return { worksheets: hashes, workbookXML: workbook, supportingXML };
}

async function productionSmoke() {
  const worker = new Worker(
    new URL("../../src/workers/excelExport.worker.ts", import.meta.url),
    { type: "module" }
  );
  const sheets: Sheet[] = [
    {
      sheet: "中文",
      data: [
        ["空值", "大整数", "日期", "布尔", "文本"],
        [
          null,
          9007199254740993n,
          new Date("2026-01-02T03:04:05Z"),
          true,
          "中文😀<&>\n下一行",
        ],
      ],
    },
    { sheet: "第二张", data: [["字段"], ["多工作表"]] },
  ];
  try {
    const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
      worker.onerror = (event) => reject(new Error(event.message));
      worker.onmessageerror = () =>
        reject(new Error("生产 Worker messageerror"));
      worker.onmessage = (event) => {
        if (event.data.id !== "production-smoke") return;
        if (event.data.error) reject(new Error(event.data.error));
        else resolve(event.data.buffer);
      };
      worker.postMessage({ id: "production-smoke", sheets });
    });
    assert(buffer instanceof ArrayBuffer, "生产 Worker 必须返回 ArrayBuffer");
    const content = await checkContent(buffer);
    assert(content.worksheets.length === 2, "生产 Worker 必须返回两个工作表");
    const files = unzipSync(new Uint8Array(buffer));
    const allXML = Object.entries(files)
      .filter(([name]) => name.endsWith(".xml"))
      .map(([, bytes]) => strFromU8(bytes))
      .join("\n");
    for (const expected of [
      "9007199254740993",
      "2026-01-02T03:04:05.000Z",
      "中文😀",
      "下一行",
      "多工作表",
    ]) {
      assert(allXML.includes(expected), `生产 Worker 内容缺失：${expected}`);
    }
    return {
      passed: true,
      byteLength: buffer.byteLength,
      content,
      cspViolations,
    };
  } finally {
    worker.terminate();
  }
}

function monitorMainThread() {
  const gaps: number[] = [];
  const longTasks: number[] = [];
  let previous = performance.now();
  const interval = setInterval(() => {
    const now = performance.now();
    gaps.push(now - previous);
    previous = now;
  }, 10);
  const available =
    PerformanceObserver.supportedEntryTypes.includes("longtask");
  const observer = available
    ? new PerformanceObserver((list) => {
        longTasks.push(...list.getEntries().map((entry) => entry.duration));
      })
    : null;
  observer?.observe({ type: "longtask", buffered: false });
  return async () => {
    await sleep(30);
    clearInterval(interval);
    observer?.disconnect();
    return {
      longTaskAPIAvailable: available,
      longestMainThreadTaskMs: available ? Math.max(0, ...longTasks) : null,
      maxTimerGapMs: Math.max(0, ...gaps),
      timerGapOver50msCount: gaps.filter((ms) => ms > 50).length,
      timerSamples: gaps.length,
    };
  };
}

async function measuredWorker(sheets: Sheet[]) {
  const started = performance.now();
  const worker = new Worker(
    new URL("./excel-export-measure.worker.ts", import.meta.url),
    { type: "module" }
  );
  const createdAt = performance.now();
  try {
    return await new Promise<{
      buffer: ArrayBuffer;
      workerCreationMs: number;
      postMessageSyncMs: number;
      inputArrivalMs: number;
      encodingMs: number;
      responseTransferAndDeliveryMs: number;
      totalMs: number;
      detachedByteLength: number;
    }>((resolve, reject) => {
      let result:
        | { buffer: ArrayBuffer; receivedAt: number; encodingMs: number }
        | undefined;
      let detachedByteLength: number | undefined;
      let responseReceivedAt = 0;
      let postMessageSyncMs = 0;
      const sentAt = absoluteNow();
      const finish = () => {
        if (!result || detachedByteLength === undefined) return;
        resolve({
          buffer: result.buffer,
          workerCreationMs: createdAt - started,
          postMessageSyncMs,
          inputArrivalMs: result.receivedAt - sentAt,
          encodingMs: result.encodingMs,
          responseTransferAndDeliveryMs:
            responseReceivedAt - result.receivedAt - result.encodingMs,
          totalMs: performance.now() - started,
          detachedByteLength,
        });
      };
      worker.onerror = (event) => reject(new Error(event.message));
      worker.onmessageerror = () =>
        reject(new Error("测量 Worker messageerror"));
      worker.onmessage = (event) => {
        if (event.data.error) reject(new Error(event.data.error));
        else if (event.data.buffer) {
          result = event.data;
          responseReceivedAt = absoluteNow();
        } else detachedByteLength = event.data.detachedByteLength;
        finish();
      };
      const postStart = performance.now();
      worker.postMessage({ id: "measured", sheets });
      postMessageSyncMs = performance.now() - postStart;
    });
  } finally {
    worker.terminate();
  }
}

async function measuredClone(sheets: Sheet[]) {
  const worker = new Worker(
    new URL("./excel-export-measure.worker.ts", import.meta.url),
    { type: "module" }
  );
  try {
    return await new Promise<{
      postMessageSyncMs: number;
      inputArrivalMs: number;
      heldRows: number;
    }>((resolve, reject) => {
      const sentAt = absoluteNow();
      let postMessageSyncMs = 0;
      let inputArrivalMs = 0;
      worker.onerror = (event) => reject(new Error(event.message));
      worker.onmessage = (event) => {
        if (event.data.cloned) {
          inputArrivalMs = event.data.receivedAt - sentAt;
          post({ type: "phase", phase: "clone-hold" });
        } else
          resolve({
            postMessageSyncMs,
            inputArrivalMs,
            heldRows: event.data.heldRows,
          });
      };
      const start = performance.now();
      worker.postMessage({ id: "clone-only", sheets, cloneOnly: true });
      postMessageSyncMs = performance.now() - start;
    });
  } finally {
    worker.terminate();
  }
}

async function run() {
  if (params.get("mode") === "smoke")
    return { productionWorker: await productionSmoke() };
  const mode = params.get("mode")!;
  const rowCount = Number(params.get("rows"));
  const columnCount = Number(params.get("columns"));
  const input = fixture(rowCount, columnCount, params.get("wide") === "true");
  await sleep(150);
  post({ type: "phase", phase: "measure" });
  await sleep(250);
  const stopMonitor = monitorMainThread();
  await sleep(30);
  const exportStarted = performance.now();
  const prepareStarted = performance.now();
  const sheets = [
    {
      sheet: "合成导出",
      data: [
        input.headers,
        ...(mode === "baseline"
          ? input.data.map((row) => row.map(cellValueForXlsx))
          : input.data),
      ],
    },
  ];
  const preparationMs = performance.now() - prepareStarted;
  if (mode === "clone") {
    const stages = await measuredClone(sheets);
    const responsiveness = await stopMonitor();
    post({ type: "phase", phase: "complete" });
    return {
      mode,
      rowCount,
      columnCount,
      wide: params.get("wide") === "true",
      preparationMs,
      stages,
      responsiveness,
      cspViolations,
    };
  }
  let buffer: ArrayBuffer;
  let base64: string | undefined;
  let stages: Record<string, number>;
  if (mode === "baseline") {
    const importStarted = performance.now();
    const writeXlsxFile = (await import("write-excel-file/universal")).default;
    const libraryImportMs = performance.now() - importStarted;
    const encodeStarted = performance.now();
    const blob = await (await writeXlsxFile(sheets)).toBlob();
    const workbookToBlobMs = performance.now() - encodeStarted;
    const bufferStarted = performance.now();
    buffer = await blobToArrayBuffer(blob);
    const blobToArrayBufferMs = performance.now() - bufferStarted;
    const base64Started = performance.now();
    base64 = uint8ArrayToBase64(new Uint8Array(buffer));
    const base64Ms = performance.now() - base64Started;
    stages = {
      libraryImportMs,
      workbookToBlobMs,
      blobToArrayBufferMs,
      base64Ms,
      base64Characters: base64!.length,
    };
  } else {
    const encoded = await measuredWorker(sheets);
    buffer = encoded.buffer;
    assert(
      encoded.detachedByteLength === 0,
      "测量 Worker 输出 ArrayBuffer 未转移"
    );
    const { buffer: _buffer, ...timings } = encoded;
    void _buffer;
    stages = timings;
  }
  const exportBeforeWriteMs = performance.now() - exportStarted;
  const responsiveness = await stopMonitor();
  post({ type: "phase", phase: "verify-and-surrogate-write" });
  const content = await checkContent(buffer);
  assert(content.worksheets[0].rows === rowCount + 1, "导出行数与夹具不一致");
  const transferStart = performance.now();
  const response = await fetch(`/save?mode=${mode}`, {
    method: "POST",
    headers: {
      "Content-Type":
        mode === "baseline" ? "application/json" : "application/octet-stream",
    },
    body: mode === "baseline" ? JSON.stringify({ base64 }) : buffer,
  });
  assert(response.ok, "受控落盘失败");
  const surrogateWrite = await response.json();
  surrogateWrite.roundTripMs = performance.now() - transferStart;
  return {
    mode,
    rowCount,
    columnCount,
    wide: params.get("wide") === "true",
    preparationMs,
    stages,
    exportBeforeWriteMs,
    responsiveness,
    xlsxByteLength: buffer.byteLength,
    content,
    surrogateWrite,
    cspViolations,
  };
}
run()
  .then((result) =>
    post({
      type: "result",
      result: {
        ...result,
        recordedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        performanceEntryTypes: PerformanceObserver.supportedEntryTypes,
      },
    })
  )
  .catch((error) =>
    post({ type: "error", message: String(error), stack: error?.stack })
  );
