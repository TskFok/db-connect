import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 使用生产 Zustand store 的独立 V8 进程基准；不连接数据库，不包含 React/WebView。
// 每个样本独立进程，避免先前样本的峰值 RSS 与字符串保留污染后续结果。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};

if (process.argv.includes("--worker")) {
  assert.equal(typeof globalThis.gc, "function", "基准需要 --expose-gc");
  const { useDatabaseStore, cache } = await import(
    pathToFileURL(option("--bundle")).href
  );
  const tabs = Number(option("--tabs", "1"));
  const protectAll = process.argv.includes("--protect-all");
  const warm = process.argv.includes("--warm");
  const releases = [];
  const connId = "synthetic-memory-benchmark";
  const rowCount = 10_000;
  const columnCount = 20;
  const cellBytes = 48;
  const columns = Array.from({ length: columnCount }, (_, i) => `c${i}`);
  const collect = () => {
    globalThis.gc();
    globalThis.gc();
  };
  const receiveResult = (ordinal, protect) => {
    useDatabaseStore.getState().openSqlTab(connId, "-- 合成结果内存夹具");
    const tabId = useDatabaseStore.getState().openTabs.at(-1).id;
    // Buffer 解码得到独立、已展平的字符串，避免共享同一填充字符串低估实际存活堆。
    const rows = Array.from({ length: rowCount }, (_, row) =>
      Array.from({ length: columnCount }, (_, column) =>
        Buffer.from(
          `${ordinal}:${row}:${column}`.padEnd(cellBytes, "x")
        ).toString()
      )
    );
    const result = {
      result_type: "select",
      columns,
      rows,
      affected_rows: null,
      message: "合成结果",
      execution_time_ms: 1,
    };
    useDatabaseStore
      .getState()
      .setSqlTabResult(
        connId,
        tabId,
        result,
        null,
        ["-- 合成结果内存夹具"],
        [{ sql: "-- 合成结果内存夹具", result, error: null }]
      );
    const key =
      useDatabaseStore.getState().sqlTabResults[tabId].statementResults[0]
        .cacheKey;
    if (protect && cache && key) releases.push(cache.pin(key));
  };
  useDatabaseStore.getState().switchToConnection(connId);
  if (warm) {
    receiveResult(-1, false);
    useDatabaseStore.getState().reset();
    useDatabaseStore.getState().switchToConnection(connId);
  }
  collect();
  const emptyHeapBytes = process.memoryUsage().heapUsed;
  for (let i = 0; i < tabs; i++) receiveResult(i, protectAll);
  collect();
  const heapBytes = process.memoryUsage().heapUsed;
  const rssBytes = process.memoryUsage().rss;
  const state = cache?.enforce() ?? null;
  const residentTabs = (() => {
    const results = Object.values(useDatabaseStore.getState().sqlTabResults);
    assert.equal(results.length, tabs, "所有合成标签必须有独立身份");
    return results.filter(
      (entry) => entry.statementResults[0].retention !== "evicted"
    ).length;
  })();
  // 夹具全部是固定长度 ASCII；公式与紧凑列名数组、行矩阵字节完全等价。
  const resultBytes =
    JSON.stringify(columns).length +
    2 +
    rowCount * (2 + columnCount * (cellBytes + 2) + columnCount - 1) +
    rowCount -
    1;
  if (cache) {
    assert.equal(state.retainedBytes, residentTabs * resultBytes);
    assert.equal(
      state.overBudget,
      protectAll && tabs * resultBytes > 128 * 1024 * 1024
    );
    if (!protectAll) assert.ok(state.retainedBytes <= 128 * 1024 * 1024);
    else assert.equal(residentTabs, tabs);
  }
  for (const release of releases) release();
  const afterRelease = cache?.enforce() ?? null;
  if (afterRelease) assert.ok(afterRelease.retainedBytes <= 128 * 1024 * 1024);
  collect();
  const heapAfterReleaseBytes = process.memoryUsage().heapUsed;
  console.log(
    JSON.stringify({
      tabs,
      warm,
      protectAll,
      rowCount,
      columnCount,
      cellBytes,
      resultBytes,
      emptyHeapBytes,
      heapBytes,
      heapDeltaBytes: heapBytes - emptyHeapBytes,
      rssBytes,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      residentTabs,
      registeredBytes: state?.retainedBytes ?? null,
      residentPayloadBytes: residentTabs * resultBytes,
      overBudget: state?.overBudget ?? null,
      afterRelease,
      heapAfterReleaseBytes,
    })
  );
} else {
  const { rolldown } = await import("rolldown");
  const ref = option("--ref", "working-tree");
  const samples = Number(option("--samples", "3"));
  assert.ok(Number.isInteger(samples) && samples > 0 && samples <= 20);
  const scratch = mkdtempSync(join(tmpdir(), "db-connect-result-memory-"));
  const output = resolve(option("--output", join(scratch, "result.json")));
  const readSource = (path) =>
    ref === "working-tree"
      ? readFileSync(join(root, path), "utf8")
      : execFileSync("git", ["show", `${ref}:${path}`], {
          cwd: root,
          encoding: "utf8",
        });
  let hasCache = existsSync(join(root, "src/utils/resultCacheBudget.ts"));
  if (ref !== "working-tree") {
    execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: root,
    });
    try {
      execFileSync(
        "git",
        ["cat-file", "-e", `${ref}:src/utils/resultCacheBudget.ts`],
        {
          cwd: root,
          stdio: "ignore",
        }
      );
      hasCache = true;
    } catch {
      hasCache = false;
    }
  }
  const entry = join(root, "src/__result_memory_benchmark_virtual__.ts");
  const bundle = join(scratch, "store.mjs");
  const build = await rolldown({
    input: entry,
    platform: "node",
    plugins: [
      {
        name: "result-memory-production-store",
        resolveId(source) {
          if (source === entry) return entry;
        },
        load(id) {
          if (id === entry)
            return `
          export { useDatabaseStore } from "./stores/databaseStore";
          ${
            hasCache
              ? 'export { resultCacheController as cache } from "./utils/resultCacheBudget";'
              : "export const cache = null;"
          }
        `;
          if (id.startsWith(join(root, "src/")))
            return readSource(relative(root, id));
        },
      },
    ],
  });
  await build.write({ file: bundle, format: "esm" });
  await build.close();
  const measurements = [];
  const scenarios = [
    ...[false, true].flatMap((warm) =>
      [1, 10, 30].map((tabs) => ({ tabs, warm, protectAll: false }))
    ),
    ...(hasCache ? [{ tabs: 30, warm: true, protectAll: true }] : []),
  ];
  for (const scenario of scenarios) {
    for (let sample = 0; sample < samples; sample++) {
      const args = [
        "--expose-gc",
        fileURLToPath(import.meta.url),
        "--worker",
        "--bundle",
        bundle,
        "--tabs",
        String(scenario.tabs),
        ...(scenario.warm ? ["--warm"] : []),
        ...(scenario.protectAll ? ["--protect-all"] : []),
      ];
      measurements.push({
        sample: sample + 1,
        ...JSON.parse(
          execFileSync(process.execPath, args, {
            cwd: root,
            encoding: "utf8",
            timeout: 120_000,
          })
        ),
      });
    }
    console.error(
      `已测量 ${ref}：${scenario.tabs} 标签，${scenario.warm ? "热" : "冷"}，全部保护=${scenario.protectAll}`
    );
  }
  writeFileSync(
    output,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        ref,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        samples,
        scope:
          "生产 Zustand SQL 结果 store 的独立 Node/V8 进程；不含 React、WebView、Rust、IPC 或数据库",
        measurements,
      },
      null,
      2
    ) + "\n"
  );
  console.log(output);
}
