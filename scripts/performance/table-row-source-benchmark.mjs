import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

// 独立 V8 子进程测量转换新增保留堆；不包含 React、WebView、SQL 或 IPC。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};

if (process.argv.includes("--worker")) {
  assert.equal(typeof globalThis.gc, "function", "基准需要 --expose-gc");
  const { createTableRowSource, legacyMaterialize } = await import(
    pathToFileURL(option("--bundle")).href
  );
  const rowCount = Number(option("--rows"));
  const columnCount = Number(option("--columns"));
  const variant = option("--variant");
  const columns = Array.from({ length: columnCount }, (_, i) => `c${i}`);
  const rows = Array.from({ length: rowCount }, (_, r) =>
    Array.from({ length: columnCount }, (_, c) => r * columnCount + c)
  );
  const create = (matrix) =>
    variant === "before"
      ? legacyMaterialize(matrix, columns, ["c0"], "benchmark|db|table", 1)
      : createTableRowSource({
          rows: matrix,
          columns,
          primaryKeyColumns: ["c0"],
          scopeKey: "benchmark|db|table",
          page: 1,
        });
  const collect = () => {
    globalThis.gc();
    globalThis.gc();
  };
  // 两种实现都先以小夹具预热，不保留预热结果。
  create(rows.slice(0, 10));
  collect();
  const baselineHeapBytes = process.memoryUsage().heapUsed;
  const start = performance.now();
  const retained = create(rows);
  const initializationMs = performance.now() - start;
  collect();
  const retainedHeapBytes = process.memoryUsage().heapUsed;
  // 保持结果可达并校验原始行身份，避免 GC 把转换结果视为死亡。
  const key =
    variant === "before"
      ? retained.at(-1)._selectionKey
      : retained.getRowKey(rowCount - 1);
  assert.equal(key, `benchmark|db|table|c0=${(rowCount - 1) * columnCount}`);
  let primaryKeyReads = 0;
  let nonPrimaryKeyReads = 0;
  const countedRows = rows.map(
    (row) =>
      new Proxy(row, {
        get(target, property, receiver) {
          if (/^\d+$/.test(String(property))) {
            if (property === "0") primaryKeyReads++;
            else nonPrimaryKeyReads++;
          }
          return Reflect.get(target, property, receiver);
        },
      })
  );
  const counted = create(countedRows);
  const initializationNonPrimaryKeyReads = nonPrimaryKeyReads;
  // 固定窗口：20 行 × 10 列，其中 c0 为主键。
  for (let r = 0; r < Math.min(20, rowCount); r++) {
    for (let c = 0; c < Math.min(10, columnCount); c++) {
      const value =
        variant === "before"
          ? counted[r][columns[c]]
          : counted.getCell(r, columns[c]);
      assert.equal(value, r * columnCount + c);
    }
  }
  console.log(
    JSON.stringify({
      variant,
      rowCount,
      columnCount,
      initializationMs,
      baselineHeapBytes,
      retainedHeapBytes,
      addedRetainedHeapBytes: retainedHeapBytes - baselineHeapBytes,
      primaryKeyReads,
      initializationNonPrimaryKeyReads,
      fixedViewportAdditionalNonPrimaryKeyReads:
        nonPrimaryKeyReads - initializationNonPrimaryKeyReads,
    })
  );
} else {
  const samples = Number(option("--samples", "20"));
  assert.ok(Number.isInteger(samples) && samples >= 3 && samples <= 100);
  const scratch = mkdtempSync(join(tmpdir(), "db-connect-table-row-source-"));
  const output = resolve(
    option(
      "--output",
      join(root, "docs/performance/table-row-source-2026-10-08.json")
    )
  );
  const baselineRef = option(
    "--ref",
    "498fa79d5789b91c957120c27f77c44829d06e4c"
  );
  const baselineRevision = execFileSync(
    "git",
    ["rev-parse", "--verify", `${baselineRef}^{commit}`],
    { cwd: root, encoding: "utf8" }
  ).trim();
  const readBaseline = (path) =>
    execFileSync("git", ["show", `${baselineRevision}:${path}`], {
      cwd: root,
      encoding: "utf8",
    });
  const oldSource = readBaseline("src/components/table/TableData.tsx");
  const match = oldSource.match(
    /const dataSource = useMemo<Record<string, unknown>\[\]>\([\s\S]*?rows\.map\(\(row, rowIdx\) => \{([\s\S]+?)\n {6}\}\)/
  );
  assert.ok(
    match,
    `无法提取 ${baselineRevision} TableData 的旧全页转换，请检查 --ref 基准来源`
  );
  const entry = join(root, "src/__table_row_source_benchmark_virtual__.ts");
  const legacyKeys = join(root, "src/__legacy_row_keys__.ts");
  const bundle = join(scratch, "source.mjs");
  const { rolldown } = await import("rolldown");
  const build = await rolldown({
    input: entry,
    platform: "node",
    plugins: [
      {
        name: "table-row-source-production-benchmark",
        resolveId(id) {
          if (id === entry || id === "./__legacy_row_keys__")
            return id === entry ? entry : legacyKeys;
        },
        load(id) {
          if (id === entry)
            return `
          export { createTableRowSource } from "./components/table/tableRowSource";
          import { buildRowSelectionKey } from "./__legacy_row_keys__";
          export function legacyMaterialize(rows, columns, primaryKeyColumns, rowSelectionScopeKey, page) {
            return rows.map((row, rowIdx) => {${match[1]}\n});
          }
        `;
          if (id === legacyKeys)
            return readBaseline("src/components/table/tableDataRowKeys.ts");
        },
      },
    ],
  });
  await build.write({ file: bundle, format: "esm" });
  await build.close();
  const measurements = [];
  const summaries = [];
  const percentile = (values, fraction) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
  for (const rowCount of [100, 1000, 10000]) {
    for (const columnCount of [20, 200]) {
      const scenario = [];
      for (const variant of ["before", "after"]) {
        for (let sample = 1; sample <= samples; sample++) {
          const measured = JSON.parse(
            execFileSync(
              process.execPath,
              [
                "--expose-gc",
                fileURLToPath(import.meta.url),
                "--worker",
                "--bundle",
                bundle,
                "--rows",
                String(rowCount),
                "--columns",
                String(columnCount),
                "--variant",
                variant,
              ],
              { cwd: root, encoding: "utf8", timeout: 60000 }
            )
          );
          scenario.push({ sample, ...measured });
        }
      }
      measurements.push(...scenario);
      const summary = { rowCount, columnCount };
      for (const variant of ["before", "after"]) {
        const values = scenario.filter((item) => item.variant === variant);
        summary[variant] = {
          initializationP95Ms: percentile(
            values.map((item) => item.initializationMs),
            0.95
          ),
          addedRetainedHeapMedianBytes: percentile(
            values.map((item) => item.addedRetainedHeapBytes),
            0.5
          ),
          initializationNonPrimaryKeyReads:
            values[0].initializationNonPrimaryKeyReads,
          fixedViewportAdditionalNonPrimaryKeyReads:
            values[0].fixedViewportAdditionalNonPrimaryKeyReads,
        };
      }
      summary.addedRetainedHeapReductionPercent =
        (1 -
          summary.after.addedRetainedHeapMedianBytes /
            summary.before.addedRetainedHeapMedianBytes) *
        100;
      summaries.push(summary);
      console.error(
        `已测量 ${rowCount}×${columnCount}，新增保留堆下降 ${summary.addedRetainedHeapReductionPercent.toFixed(2)}%`
      );
    }
  }
  const target = summaries.find(
    (item) => item.rowCount === 10000 && item.columnCount === 200
  );
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        baselineRevision,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        samplesPerVariantPerScenario: samples,
        scope: `真实生产行源与 git ${baselineRevision} TableData 旧全页转换的独立 Node/V8 进程。合成数字矩阵；p95 是单次初始化，堆是在原矩阵已驻留后两次 GC 的新增保留堆；不是全部分配量、峰值内存或 WebView/换页/切回/滚动延迟。getter读取在另外一份代理矩阵上测量，未计入时间与保留堆。`,
        target: {
          requiredAddedRetainedHeapReductionPercent: 70,
          actualAddedRetainedHeapReductionPercent:
            target.addedRetainedHeapReductionPercent,
          passed: target.addedRetainedHeapReductionPercent >= 70,
        },
        summaries,
        measurements,
      },
      null,
      2
    ) + "\n"
  );
  console.log(output);
  assert.ok(
    target.addedRetainedHeapReductionPercent >= 70,
    "10000×200 新增保留堆下降未达 70%"
  );
}
