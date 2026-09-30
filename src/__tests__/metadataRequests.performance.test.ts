/**
 * 受控 IPC 替身微基准；没有 Tauri 进程、数据库、网络或 SQL。
 * 复现：npm test -- src/__tests__/metadataRequests.performance.test.ts
 * 只对调用次数设断言，p95 不作为跨环境门禁。
 */
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listTablesBatch } from "../services/tauriCommands";
import { emptyConnState, useDatabaseStore } from "../stores/databaseStore";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const samples = 30;
function p95(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
}
describe("元数据请求受控替身测量", () => {
  it.each([1, 10, 100])("%i 个目录刷新：一次目录 IPC", async (count) => {
    const connId = `benchmark-${count}`;
    const databases = Array.from({ length: count }, (_, index) => `db${index}`);
    const timings: number[] = [];
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(async (command, args) => {
      if (command === "list_databases") return databases;
      if (command === "list_tables_batch")
        return (args as { databases: string[] }).databases.map((database) => ({
          database,
          tables: [],
        }));
      if (command === "invalidate_table_metadata_cache") return;
      throw new Error(`未预期的调用：${command}`);
    });
    useDatabaseStore.setState({
      activeConnId: connId,
      connectionStates: {
        [connId]: {
          ...emptyConnState(),
          tables: Object.fromEntries(
            databases.map((database) => [database, []])
          ),
        },
      },
    });
    for (let sample = -5; sample < samples; sample++) {
      invokeMock.mockClear();
      const start = performance.now();
      await useDatabaseStore.getState().refresh(connId);
      const elapsed = performance.now() - start;
      expect(
        invokeMock.mock.calls.filter(
          ([command]) => command === "list_tables_batch"
        )
      ).toHaveLength(1);
      expect(invokeMock).toHaveBeenCalledTimes(3);
      if (sample >= 0) timings.push(elapsed);
    }
    process.stdout.write(
      `${JSON.stringify({ fixture: "empty-catalog-immediate-ipc-double", databases: count, samples, warmup: 5, catalogIpc: 1, totalRefreshIpc: 3, p95Ms: p95(timings) })}\n`
    );
  });
  it("20 个同键并发调用共享一次目录 IPC", async () => {
    const invokeMock = vi.mocked(invoke);
    invokeMock.mockImplementation(async () => [
      { database: "app", tables: [] },
    ]);
    const timings: number[] = [];
    for (let sample = -5; sample < samples; sample++) {
      invokeMock.mockClear();
      const start = performance.now();
      await Promise.all(
        Array.from({ length: 20 }, () =>
          listTablesBatch("concurrent-measure", ["app"])
        )
      );
      const elapsed = performance.now() - start;
      expect(invokeMock).toHaveBeenCalledTimes(1);
      if (sample >= 0) timings.push(elapsed);
    }
    process.stdout.write(
      `${JSON.stringify({ fixture: "same-key-immediate-ipc-double", concurrency: 20, samples, warmup: 5, catalogIpc: 1, coalescedRequests: 19, p95Ms: p95(timings) })}\n`
    );
  });
});
