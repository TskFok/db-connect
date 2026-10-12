// 测量 Worker 复用生产编码函数；真实生产 Worker 另有独立兼容性检查。
import { buildWorkbookBuffer } from "../../src/utils/excelWorkbook";

self.onmessage = async (event) => {
  const receivedAt = performance.timeOrigin + performance.now();
  const { id, sheets } = event.data;
  if (event.data.cloneOnly) {
    self.postMessage({ id, cloned: true, receivedAt });
    // 单独保持克隆输入，让独立 RSS 采样覆盖完整的克隆副本存活期。
    await new Promise((resolve) => setTimeout(resolve, 500));
    self.postMessage({ id, heldRows: sheets[0].data.length });
    return;
  }
  const start = performance.now();
  try {
    const buffer = await buildWorkbookBuffer(sheets);
    const encodingMs = performance.now() - start;
    self.postMessage(
      { id, buffer, receivedAt, encodingMs },
      { transfer: [buffer] }
    );
    self.postMessage({ id, detachedByteLength: buffer.byteLength });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
