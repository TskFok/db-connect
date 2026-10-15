import assert from "node:assert/strict";
import inspector from "node:inspector";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir, cpus, totalmem, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 仅测 V8 托管堆累计分配：不是 heapUsed、抽样分配或全进程分配。
// 默认拒绝正式测量；--calibrate-only 只跑小型方法探针，--run 才跑固定夹具。
const self = fileURLToPath(import.meta.url);
const root = resolve(dirname(self), "../..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scriptSha256 = hash(readFileSync(self));

async function capture(boundary, name) {
  const session = new inspector.Session();
  session.connect();
  const post = (method, params = {}) =>
    new Promise((resolvePost, reject) => {
      session.post(method, params, (error, value) =>
        error ? reject(error) : resolvePost(value)
      );
    });
  const chunks = [];
  session.on("HeapProfiler.addHeapSnapshotChunk", ({ params }) =>
    chunks.push(params.chunk)
  );
  let result;
  let externalBefore;
  let externalAfter;
  try {
    await post("HeapProfiler.enable");
    await post("HeapProfiler.startTrackingHeapObjects", {
      trackAllocations: true,
    });
    externalBefore = process.memoryUsage();
    result = boundary();
    externalAfter = process.memoryUsage();
    // 校准可在独立回调清空引用并 GC；累计 trace 不应随存活量下降。
    globalThis.t06AfterBoundary?.();
    await post("HeapProfiler.stopTrackingHeapObjects", {
      reportProgress: false,
    });
  } finally {
    session.disconnect();
  }
  const snapshot = JSON.parse(chunks.join(""));
  const fields = snapshot.snapshot.meta.trace_node_fields;
  const infoFields = snapshot.snapshot.meta.trace_function_info_fields;
  assert.deepEqual(fields, [
    "id",
    "function_info_index",
    "count",
    "size",
    "children",
  ]);
  const functions = [];
  for (
    let i = 0;
    i < snapshot.trace_function_infos.length;
    i += infoFields.length
  ) {
    const values = snapshot.trace_function_infos.slice(
      i,
      i + infoFields.length
    );
    const entry = Object.fromEntries(
      infoFields.map((key, index) => [key, values[index]])
    );
    entry.name = snapshot.strings[entry.name];
    entry.script_name = snapshot.strings[entry.script_name];
    functions.push(entry);
  }
  let bytes = 0;
  let count = 0;
  let boundarySeen = false;
  const accounted = [];
  const chosenIds = new Set();
  function visit(nodes, within = false, depth = 0) {
    assert.equal(nodes.length % fields.length, 0);
    for (let i = 0; i < nodes.length; i += fields.length) {
      const [id, functionIndex, directCount, directSize, children] =
        nodes.slice(i, i + fields.length);
      const currentName = functions[functionIndex].name;
      const chosen = within || currentName === name;
      if (currentName === name) boundarySeen = true;
      if (chosen) {
        assert.ok(Number.isSafeInteger(directSize) && directSize >= 0);
        // V8 的单节点累计字段可能为 unsigned；接近上限即拒绝。
        assert.ok(directSize < 0xf0000000, "单 trace 节点接近 32 位计数上限");
        bytes += directSize;
        count += directCount;
        chosenIds.add(id);
        accounted.push({ id, functionIndex, directCount, directSize, depth });
      }
      visit(children, chosen, depth + 1);
    }
  }
  visit(snapshot.trace_tree);
  const nodeFields = snapshot.snapshot.meta.node_fields;
  let liveTracedBytes = 0;
  let liveTracedNodes = 0;
  let liveCalibrationCells = 0;
  for (let i = 0; i < snapshot.nodes.length; i += nodeFields.length) {
    const type = snapshot.snapshot.meta.node_types[0][snapshot.nodes[i]];
    const nodeName =
      snapshot.strings[snapshot.nodes[i + nodeFields.indexOf("name")]];
    if (type === "object" && nodeName === "T06CalibrationCell")
      liveCalibrationCells++;
    if (
      chosenIds.has(snapshot.nodes[i + nodeFields.indexOf("trace_node_id")])
    ) {
      liveTracedBytes += snapshot.nodes[i + nodeFields.indexOf("self_size")];
      liveTracedNodes++;
    }
  }
  return {
    result,
    measurement: {
      bytes,
      count,
      boundarySeen,
      liveTracedBytes,
      liveTracedNodes,
      liveCalibrationCells,
      externalBytesBefore: externalBefore.external,
      externalBytesAfter: externalAfter.external,
      arrayBufferBytesBefore: externalBefore.arrayBuffers,
      arrayBufferBytesAfter: externalAfter.arrayBuffers,
      // 留下原始累计树与解析元信息，直接 size 为本节点自有分配，逐节点只加一次。
      rawTrace: { fields, infoFields, functions, tree: snapshot.trace_tree },
      accounted,
    },
  };
}

if (process.argv.includes("--worker")) {
  assert.equal(typeof globalThis.gc, "function");
  const variant = option("--variant");
  let captured;
  if (variant.startsWith("calibration-")) {
    const n = Number(option("--count", "500"));
    const sink = new Array(n);
    class T06CalibrationCell {
      constructor(value) {
        this.value = value;
      }
    }
    for (let i = 0; i < 100; i++) new T06CalibrationCell(-1);
    function t06CalibrationBoundary(count = n) {
      for (let i = 0; i < count; i++) sink[i] = new T06CalibrationCell(i);
    }
    t06CalibrationBoundary(Math.min(n, 10));
    sink.fill(null);
    globalThis.gc();
    globalThis.gc();
    globalThis.t06AfterBoundary = () => {
      if (variant === "calibration-dead") sink.fill(null);
      globalThis.gc({ type: "minor", execution: "sync" });
      globalThis.gc();
      globalThis.gc();
    };
    captured = await capture(t06CalibrationBoundary, "t06CalibrationBoundary");
    assert.equal(
      captured.measurement.liveCalibrationCells,
      variant === "calibration-dead" ? 0 : n
    );
    if (n === 0) assert.equal(captured.measurement.bytes, 0);
  } else if (variant === "external-buffer-control") {
    const size = Number(option("--bytes"));
    let retained;
    function t06ExternalBoundary() {
      retained = new ArrayBuffer(size);
    }
    captured = await capture(t06ExternalBoundary, "t06ExternalBoundary");
    assert.equal(retained.byteLength, size);
  } else {
    assert.ok(["before", "after"].includes(variant));
    const { createTableRowSource, legacyMaterialize } = await import(
      pathToFileURL(option("--bundle")).href
    );
    const rowCount = 10000;
    const columnCount = 200;
    const columns = Array.from({ length: columnCount }, (_, i) => `c${i}`);
    const rows = Array.from({ length: rowCount }, (_, r) =>
      Array.from({ length: columnCount }, (_, c) => r * columnCount + c)
    );
    // 与既有保留堆夹具保持同一输入、参数、10 行预热和 create(rows) 初始化边界。
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
    create(rows.slice(0, 10));
    globalThis.gc();
    globalThis.gc();
    function t06InitializationBoundary() {
      return create(rows);
    }
    captured = await capture(
      t06InitializationBoundary,
      "t06InitializationBoundary"
    );
    assert.ok(
      captured.measurement.boundarySeen && captured.measurement.bytes > 0,
      "未捕获初始化调用栈，拒绝输出零分配结果"
    );
    const retained = captured.result;
    const key =
      variant === "before"
        ? retained.at(-1)._selectionKey
        : retained.getRowKey(rowCount - 1);
    assert.equal(key, `benchmark|db|table|c0=${(rowCount - 1) * columnCount}`);
    const value =
      variant === "before" ? retained[123].c199 : retained.getCell(123, "c199");
    assert.equal(value, 123 * columnCount + 199);
  }
  const { result: _result, measurement } = captured;
  void _result;
  console.log(
    JSON.stringify({
      variant,
      pid: process.pid,
      recordedAt: new Date().toISOString(),
      node: process.version,
      versions: process.versions,
      execArgv: process.execArgv,
      ...measurement,
    })
  );
} else {
  const calibrateOnly = process.argv.includes("--calibrate-only");
  assert.ok(
    calibrateOnly || process.argv.includes("--run"),
    "请显式指定 --calibrate-only 或 --run；默认不运行正式采样"
  );
  const outputArg = option("--output");
  assert.ok(outputArg, "必须用 --output 指定证据 JSON 路径");
  const output = resolve(outputArg);
  const samples = Number(option("--samples", "3"));
  assert.ok(Number.isInteger(samples) && samples >= 3 && samples <= 10);
  const scratch = mkdtempSync(join(tmpdir(), "db-connect-t06-allocation-"));
  const runChild = (args) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ["--expose-gc", self, "--worker", ...args],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 180000,
          maxBuffer: 64 * 1024 * 1024,
        }
      )
    );
  let calibration;
  const calibrationPath = option("--calibration-file");
  if (calibrationPath) {
    const bytes = readFileSync(resolve(calibrationPath));
    calibration = JSON.parse(bytes);
    assert.equal(calibration.scriptSha256, scriptSha256, "校准脚本哈希不符");
    assert.equal(calibration.environment.node, process.version);
    assert.equal(calibration.environment.v8, process.versions.v8);
    assert.equal(calibration.calibrationPassed, true);
    calibration = {
      ...calibration,
      sourceFile: resolve(calibrationPath),
      sourceFileSha256: hash(bytes),
    };
  } else {
    const results = [];
    for (let repetition = 1; repetition <= 3; repetition++) {
      for (const count of [0, 500])
        for (const mode of ["held", "dead"]) {
          results.push({
            repetition,
            countInput: count,
            ...runChild([
              "--variant",
              `calibration-${mode}`,
              "--count",
              String(count),
            ]),
          });
        }
    }
    const externalControls = [1024, 1048576].map((bytes) => ({
      requestedBytes: bytes,
      ...runChild([
        "--variant",
        "external-buffer-control",
        "--bytes",
        String(bytes),
      ]),
    }));
    for (let repetition = 1; repetition <= 3; repetition++) {
      const held = results.find(
        (r) =>
          r.repetition === repetition &&
          r.countInput === 500 &&
          r.variant === "calibration-held"
      );
      const dead = results.find(
        (r) =>
          r.repetition === repetition &&
          r.countInput === 500 &&
          r.variant === "calibration-dead"
      );
      assert.equal(held.bytes, dead.bytes, "GC 后累计字节变化，校准失败");
      assert.equal(held.count, dead.count, "GC 后累计次数变化，校准失败");
      assert.ok(dead.bytes > 0 && dead.liveCalibrationCells === 0);
    }
    assert.equal(
      externalControls[0].bytes,
      externalControls[1].bytes,
      "外部内存覆盖负对照与预期不符，需重新审计方法"
    );
    assert.ok(
      externalControls[1].arrayBufferBytesAfter -
        externalControls[1].arrayBufferBytesBefore >=
        1048576
    );
    calibration = {
      scriptSha256,
      calibrationPassed: true,
      results,
      externalControls,
    };
  }
  const evidence = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    scriptSha256,
    environment: {
      node: process.version,
      v8: process.versions.v8,
      versions: process.versions,
      platform: process.platform,
      arch: process.arch,
      kernel: release(),
      cpu: cpus()[0]?.model,
      ramBytes: totalmem(),
      macOS:
        process.platform === "darwin"
          ? execFileSync("sw_vers", ["-productVersion"], {
              encoding: "utf8",
            }).trim()
          : null,
    },
    methodology: {
      metric:
        "V8 托管堆累计分配；trackAllocations trace_tree 直接节点 size/count；包含已经 GC 的短命对象；非 sampling、非保留堆",
      boundary:
        "仅 t06InitializationBoundary 调用栈及其子栈；同步 create(rows)，矩阵、预热、Inspector 和后验检查在边界外",
      fixture: {
        rowCount: 10000,
        columnCount: 200,
        values: "r * 200 + c",
        primaryKeyColumns: ["c0"],
        warmupRows: 10,
      },
      limitations: [
        "不覆盖 ArrayBuffer 外部 backing store、原生 malloc 或整个进程分配；前后 external/arrayBuffers 是端点检查，不能排除瞬态差异",
        "追踪会改变优化、分配与 GC 行为；不报告未插桩运行时延收益",
        "调用栈归因受栈深限制；固定路径同步且浅层，未捕获边界即拒绝",
        "单 trace 节点 unsigned 累计计数需低于 2^32；近上限拒绝，无法从已回绕数值自行证明未回绕",
        "精确短命/存活一致性不等于所有引擎内部/原生路径零误差；结果作为辅助证据",
      ],
      nativeOrExternalAllocationDifferenceRuledOut: false,
      originalCriterionVerified: false,
    },
    calibration,
    calibrationPassed: calibration.calibrationPassed,
    measurements: [],
  };
  const saveEvidence = () => {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n");
  };
  if (!calibrateOnly) {
    const baselineRef = option(
      "--ref",
      "498fa79d5789b91c957120c27f77c44829d06e4c"
    );
    const git = (args) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    const baselineRevision = git([
      "rev-parse",
      "--verify",
      `${baselineRef}^{commit}`,
    ]);
    const readBaseline = (path) =>
      execFileSync("git", ["show", `${baselineRevision}:${path}`], {
        cwd: root,
        encoding: "utf8",
      });
    const oldSource = readBaseline("src/components/table/TableData.tsx");
    const match = oldSource.match(
      /const dataSource = useMemo<Record<string, unknown>\[\]>\([\s\S]*?rows\.map\(\(row, rowIdx\) => \{([\s\S]+?)\n {6}\}\)/
    );
    assert.ok(match, "无法提取固定旧版全页转换");
    const oldKeys = readBaseline("src/components/table/tableDataRowKeys.ts");
    const currentPaths = [
      "src/components/table/tableRowSource.ts",
      "src/components/table/tableDataRowKeys.ts",
    ];
    const entry = join(root, "src/__t06_allocation_virtual__.ts");
    const legacyKeys = join(root, "src/__t06_allocation_legacy_keys__.ts");
    const entrySource = `export { createTableRowSource } from "./components/table/tableRowSource"; import { buildRowSelectionKey } from "./__t06_allocation_legacy_keys__"; export function legacyMaterialize(rows, columns, primaryKeyColumns, rowSelectionScopeKey, page) { return rows.map((row, rowIdx) => {${match[1]}\n}); }`;
    const { rolldown } = await import("rolldown");
    const build = await rolldown({
      input: entry,
      platform: "node",
      plugins: [
        {
          name: "t06-readonly-baseline",
          resolveId(id) {
            if (id === entry) return entry;
            if (id === "./__t06_allocation_legacy_keys__") return legacyKeys;
          },
          load(id) {
            if (id === entry) return entrySource;
            if (id === legacyKeys) return oldKeys;
          },
        },
      ],
    });
    const bundle = join(scratch, "source.mjs");
    await build.write({ file: bundle, format: "esm" });
    await build.close();
    evidence.source = {
      currentRevision: git(["rev-parse", "HEAD"]),
      branch: git(["branch", "--show-current"]),
      baselineRevision,
      current: Object.fromEntries(
        currentPaths.map((path) => [path, hash(readFileSync(join(root, path)))])
      ),
      oldTableDataSha256: hash(oldSource),
      oldRowKeysSha256: hash(oldKeys),
      extractedConversionSha256: hash(match[1]),
      bundleSha256: hash(readFileSync(bundle)),
      bundlePath: bundle,
      rolldownVersion: JSON.parse(
        readFileSync(join(root, "node_modules/rolldown/package.json"), "utf8")
      ).version,
      sourceScopeAudit: {
        explicitExternalBufferOrNativeIOInInitialization: false,
        inspectedOperations:
          "旧路径构造普通记录、列循环赋值、主键 JSON.stringify/字符串拼接；新路径构造 Map、普通数组/对象/闭包及相同主键字符串；原始输入只有数字矩阵",
        caveat:
          "源码未显式调用 Buffer/ArrayBuffer/原生IO，不证明 V8/JIT/分配器内部原生分配相同；端点 external/arrayBuffers 也不能排除瞬态差异",
      },
    };
    saveEvidence();
    for (let repetition = 1; repetition <= samples; repetition++) {
      for (const variant of repetition % 2
        ? ["before", "after"]
        : ["after", "before"]) {
        try {
          evidence.measurements.push({
            repetition,
            ...runChild(["--variant", variant, "--bundle", bundle]),
          });
        } catch (error) {
          evidence.measurements.push({
            repetition,
            variant,
            failed: true,
            error: String(error),
            recordedAt: new Date().toISOString(),
          });
          saveEvidence();
          throw error;
        }
        saveEvidence();
      }
    }
    const median = (values) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length / 2) - 1];
    const before = median(
      evidence.measurements
        .filter((m) => m.variant === "before")
        .map((m) => m.bytes)
    );
    const after = median(
      evidence.measurements
        .filter((m) => m.variant === "after")
        .map((m) => m.bytes)
    );
    const reductionPercent = (1 - after / before) * 100;
    evidence.summary = {
      samplesPerVariant: samples,
      beforeMedianV8ManagedAllocatedBytes: before,
      afterMedianV8ManagedAllocatedBytes: after,
      v8ManagedAllocationReductionPercent: reductionPercent,
      v8ManagedHeapThresholdPassed: reductionPercent >= 70,
      originalCriterionVerified: false,
    };
  }
  saveEvidence();
  console.log(output);
}
