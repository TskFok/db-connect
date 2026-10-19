import { readFile, writeFile, mkdir, rm, readdir, copyFile } from "node:fs/promises";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { release as osRelease } from "node:os";
import { verifyExcelWorkbook } from "./excel-export-validation.mjs";
import { setInterval, clearInterval, setTimeout, clearTimeout } from "node:timers";
import { createHash } from "node:crypto";

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runDirectory = resolve(process.argv[2]);
const outputPath = resolve(process.argv[3]);
const repetitions = Number(process.env.EXCEL_TAURI_REPETITIONS ?? 20);
const warmups = Number(process.env.EXCEL_TAURI_WARMUPS ?? 5);
const cargoProfile = process.env.EXCEL_TAURI_PROFILE ?? "debug";
if (!Number.isInteger(repetitions) || repetitions < 1) throw new Error("重复次数必须为正整数");
if (!Number.isInteger(warmups) || warmups < 0) throw new Error("预热次数必须为非负整数");
if (!["debug", "release"].includes(cargoProfile)) throw new Error("EXCEL_TAURI_PROFILE 仅支持 debug/release");
const exampleName = `excel_export_probe_${process.pid}`;
const examplePath = join(repo, "src-tauri/examples", `${exampleName}.rs`);
const assetsPath = join(runDirectory, "assets");
const configPath = join(runDirectory, "tauri.conf.json");
const casePath = join(runDirectory, "case.json");
const sourceConfig = JSON.parse(await readFile(join(repo, "src-tauri/tauri.conf.json"), "utf8"));
const cargoLock = await readFile(join(repo, "src-tauri/Cargo.lock"), "utf8");
const tauriVersion = cargoLock.match(/^name = "tauri"\nversion = "([^"]+)"/m)?.[1];
if (!tauriVersion) throw new Error("无法从 Cargo.lock 识别 Tauri 版本");
const productionWorkerNames = (await readdir(join(repo, "dist/assets"))).filter((name) => /^excelExport\.worker-.*\.js$/.test(name));
if (productionWorkerNames.length !== 1) throw new Error("需要唯一的本次生产构建 Excel Worker 产物，请先 npm run build");
const productionWorkerPath = join(repo, "dist/assets", productionWorkerNames[0]);
const productionWorkerSha256 = createHash("sha256").update(await readFile(productionWorkerPath)).digest("hex");

// 仅复用真实 CSP；独立页面、应用标识、无痕 WebView 和最小 AppState 隔离用户配置。
const configuration = {
  productName: "DB Connect Excel IPC Benchmark", version: "0.0.0", identifier: "com.dbconnect.excel-ipc-benchmark",
  build: { frontendDist: assetsPath },
  app: { windows: [], withGlobalTauri: true, security: sourceConfig.app.security },
  bundle: { active: false, icon: [join(repo, "src-tauri/icons/32x32.png")] },
};
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Excel 二进制 IPC 基准</title><body><p>正在验证临时文件中的合成数据。</p><script src="benchmark.js"></script></body></html>`;
const benchmark = String.raw`
const invoke = window.__TAURI__.core.invoke;
const cspViolations = [];
window.addEventListener("securitypolicyviolation", (event) => cspViolations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI }));
function assert(value, message) { if (!value) throw new Error(message); }
async function rejected(action) { try { await action(); return null; } catch (error) { return String(error); } }
async function workerSmoke(path) {
  const worker = new Worker("excel-export.worker.js", { type: "module" });
  let timeout;
  try {
    const buffer = await new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("真实 Tauri Worker 运行超时")), 30000);
      worker.onerror = (event) => reject(new Error(event.message || "真实 Tauri Worker 运行失败"));
      worker.onmessage = ({ data }) => {
        if (data.id !== "native-smoke") return;
        if (data.error) reject(new Error(data.error)); else resolve(data.buffer);
      };
      worker.postMessage({ id: "native-smoke", sheets: [
        { sheet: "真实:导出", data: [["文本", "日期", "整数", "布尔", "空值"], ["中文🙂<&", new Date("2026-09-30T01:02:03.000Z"), 9007199254740993n, true, null], ["末行🙂", new Date("2000-01-01T00:00:00.000Z"), -9007199254740993n, false, null]] },
        { sheet: "明细", data: [["名称"], ["第二表"]] },
      ] });
    });
    assert(buffer instanceof ArrayBuffer, "生产 Worker 必须返回 ArrayBuffer");
    const bytes = new Uint8Array(buffer);
    assert(bytes[0] === 0x50 && bytes[1] === 0x4b, "生产 Worker 必须返回 XLSX ZIP");
    const exportId = await invoke("prepare_binary_export", { path });
    await invoke("write_binary_export", buffer, { headers: { "x-db-connect-export-id": exportId } });
    return { byteLength: buffer.byteLength, protocol: location.protocol, arrayBufferReceived: true, writtenThroughProductionCommand: true };
  } finally { clearTimeout(timeout); worker.terminate(); }
}
async function run() {
  const config = await invoke("benchmark_config");
  const worker = await workerSmoke(config.workerPath);
  const cases = [];
  const diskCases = [];
  for (const byteLength of [1048576, 10485760]) {
    const bytes = new Uint8Array(byteLength);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index & 255;
    for (let sampleIndex = 0; sampleIndex < config.warmups + config.repetitions; sampleIndex++) {
      const isWarmup = sampleIndex < config.warmups;
      const iteration = isWarmup ? sampleIndex + 1 : sampleIndex - config.warmups + 1;
      const exportId = await invoke("prepare_binary_export", { path: config.path });
      await invoke("benchmark_phase", { phase: isWarmup ? "warmup" : "measure" });
      const started = performance.now();
      const rustProcessingMs = await invoke("benchmark_write", bytes.buffer, { headers: { "x-db-connect-export-id": exportId } });
      const roundTripMs = performance.now() - started;
      await invoke("benchmark_phase", { phase: "verify" });
      await invoke("benchmark_verify", { length: byteLength });
      if (!isWarmup) cases.push({ byteLength, iteration, roundTripMs, rustProcessingMs, ipcWaitingAndOverheadMs: roundTripMs - rustProcessingMs });
      assert(await rejected(() => invoke("benchmark_write", bytes.buffer, { headers: { "x-db-connect-export-id": exportId } })), "重复 ID 写入必须失败");
    }
  }
  const cancelled = await invoke("prepare_binary_export", { path: config.path });
  await invoke("cancel_binary_export", { exportId: cancelled });
  assert(await rejected(() => invoke("benchmark_write", new ArrayBuffer(0), { headers: { "x-db-connect-export-id": cancelled } })), "已取消 ID 必须拒绝写入");
  await invoke("benchmark_verify", { length: 10485760 });
  const bad = await invoke("prepare_binary_export", { path: config.missingParentPath });
  const missingDirectoryError = await rejected(() => invoke("benchmark_write", new ArrayBuffer(0), { headers: { "x-db-connect-export-id": bad } }));
  assert(missingDirectoryError?.includes("写入文件失败"), "目录不存在必须返回写入错误");
  assert(await rejected(() => invoke("cancel_binary_export", { exportId: bad })), "失败写入必须清理登记");
  const readOnly = await invoke("prepare_binary_export", { path: config.readOnlyPath });
  const permissionError = await rejected(() => invoke("benchmark_write", Uint8Array.of(255).buffer, { headers: { "x-db-connect-export-id": readOnly } }));
  assert(permissionError?.includes("写入文件失败"), "只读文件必须返回写入错误");
  assert(await rejected(() => invoke("cancel_binary_export", { exportId: readOnly })), "权限失败必须清理登记");
  const overwrite = await invoke("prepare_binary_export", { path: config.path });
  await invoke("benchmark_write", Uint8Array.from({ length: 17 }, (_, index) => index).buffer, { headers: { "x-db-connect-export-id": overwrite } });
  await invoke("benchmark_verify", { length: 17 });
  await invoke("benchmark_phase", { phase: "disk-benchmark" });
  for (const byteLength of [1048576, 10485760]) {
    for (let sampleIndex = 0; sampleIndex < config.warmups + config.repetitions; sampleIndex++) {
      const isWarmup = sampleIndex < config.warmups;
      const iteration = isWarmup ? sampleIndex + 1 : sampleIndex - config.warmups + 1;
      const fsWriteMs = await invoke("benchmark_disk_write", { length: byteLength });
      if (!isWarmup) diskCases.push({ byteLength, iteration, fsWriteMs });
    }
  }
  assert(cspViolations.length === 0, "真实 Tauri 页面出现 CSP 违规");
  return { cases, diskCases, worker, cspViolations, validations: { unicodeAndSpacePath: true, rawZeroAndFFBytes: true, repeatedIdRejected: true, cancelledIdRejected: true, cancelledWritePreservesFile: true, ioFailureReportedAndRegistrationCleared: true, permissionFailureReportedAndRegistrationCleared: true, overwriteTruncates: true }, errors: { missingDirectoryError, permissionError }, userAgent: navigator.userAgent };
}
run().then((result) => invoke("benchmark_finish", { result })).catch((error) => invoke("benchmark_finish", { result: { error: String(error), stack: error?.stack } }));
`;

async function runCommand(command, args, options = {}) {
  const child = spawn(command, args, { cwd: repo, stdio: "inherit", ...options });
  const code = await new Promise((resolveExit, reject) => { child.once("exit", resolveExit); child.once("error", reject); });
  if (code !== 0) throw new Error(`${command} 退出码 ${code}`);
}

async function processes() {
  const { stdout } = await exec("ps", ["-axo", "pid=,rss=,comm="]);
  return stdout.trim().split("\n").map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match ? { pid: Number(match[1]), rssBytes: Number(match[2]) * 1024, command: match[3] } : null;
  }).filter(Boolean);
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
async function sourceIdentity() {
  // 覆盖独立 example 的 Rust 命令、生产 Worker 的全部前端输入、依赖锁及生成器。
  const paths = new Set([
    "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "src-tauri/build.rs", "src-tauri/tauri.conf.json",
    "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json",
    "scripts/performance/excel-export-tauri.mjs", "scripts/performance/excel-export-tauri.rs",
    "scripts/performance/excel-export-tauri.sh", "scripts/performance/excel-export-validation.mjs",
  ]);
  for (const directory of ["src", "src-tauri/src"]) {
    const visit = async (relative) => {
      for (const entry of await readdir(join(repo, relative), { withFileTypes: true })) {
        const path = `${relative}/${entry.name}`;
        if (entry.isDirectory()) await visit(path); else if (entry.isFile()) paths.add(path);
      }
    };
    await visit(directory);
  }
  const files = [];
  for (const path of [...paths].sort()) files.push({ path, sha256: sha256(await readFile(join(repo, path))) });
  return { manifestSha256: sha256(JSON.stringify(files)), files };
}
function summary(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const percentile = (fraction) => ordered[Math.ceil(ordered.length * fraction) - 1] ?? null;
  return { count: ordered.length, p50: percentile(0.5), p95: percentile(0.95) };
}

let activeChild;
let exampleCreated = false;
try {
  await mkdir(assetsPath, { recursive: true });
  await mkdir(dirname(examplePath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(configuration, null, 2)}\n`);
  await writeFile(join(assetsPath, "index.html"), page);
  await writeFile(join(assetsPath, "benchmark.js"), benchmark);
  await copyFile(productionWorkerPath, join(assetsPath, "excel-export.worker.js"));
  await writeFile(join(runDirectory, "只读 文件.bin"), new Uint8Array([0, 1, 2]), { mode: 0o400, flag: "wx" });
  const source = (await readFile(join(repo, "scripts/performance/excel-export-tauri.rs"), "utf8")).replace("__BENCHMARK_CONFIG_PATH__", configPath);
  await writeFile(examplePath, source, { flag: "wx" });
  exampleCreated = true;
  const sourcesBeforeBuild = await sourceIdentity();
  const buildArguments = ["build", "--offline", "--manifest-path", "src-tauri/Cargo.toml", "--example", exampleName, ...(cargoProfile === "release" ? ["--release"] : [])];
  await runCommand("cargo", buildArguments);
  const sourcesAfterBuild = await sourceIdentity();
  if (sourcesBeforeBuild.manifestSha256 !== sourcesAfterBuild.manifestSha256) throw new Error("构建期间源码变化，请在工作区稳定后重跑以保留可信产物身份");
  const binaryPath = join(repo, "src-tauri/target", cargoProfile, "examples", exampleName);
  const binarySha256 = sha256(await readFile(binaryPath));
  const previousPids = new Set((await processes()).map((item) => item.pid));
  const samples = [];
  let phase = "setup";
  let sampling = false;
  let sampleError;
  const child = spawn(binaryPath, [runDirectory, casePath, String(warmups), String(repetitions)], { stdio: ["ignore", "pipe", "inherit"] });
  activeChild = child;
  child.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n")) if (line.startsWith("PHASE:")) phase = line.slice(6).trim();
  });
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const sampledPhase = phase;
      const timestampMs = performance.now();
      const all = await processes();
      const webContent = all.filter((item) => !previousPids.has(item.pid) && item.command.includes("com.apple.WebKit.WebContent"));
      samples.push({ phase: sampledPhase, timestampMs, rustProcessRSSBytes: all.find((item) => item.pid === child.pid)?.rssBytes ?? 0, candidateWebContentRSSBytes: webContent.reduce((sum, item) => sum + item.rssBytes, 0), candidateWebContentPids: webContent.map((item) => item.pid) });
    } catch (error) { sampleError = String(error); } finally { sampling = false; }
  };
  const timer = setInterval(sample, 20);
  const timeout = setTimeout(() => child.kill(), 120000);
  try {
    const code = await new Promise((resolveExit, reject) => { child.once("exit", resolveExit); child.once("error", reject); });
    if (code !== 0) throw new Error(`真实 Tauri 基准失败，退出码 ${code}；详情 ${casePath}`);
  } finally { clearInterval(timer); clearTimeout(timeout); }
  const result = JSON.parse(await readFile(casePath, "utf8"));
  if (result.error) throw new Error(result.error);
  const readOnlyBytes = await readFile(join(runDirectory, "只读 文件.bin"));
  if (readOnlyBytes.length !== 3 || !readOnlyBytes.every((value, index) => value === index)) throw new Error("权限失败后只读文件内容发生改变");
  result.validations.permissionFailurePreservesFile = true;
  const workbookBytes = await readFile(join(runDirectory, "真实 Worker 导出.xlsx"));
  if (workbookBytes.byteLength !== result.worker.byteLength) throw new Error("生产 Worker 与真实落盘长度不一致");
  const workbookValidation = verifyExcelWorkbook(workbookBytes);
  result.worker = { ...result.worker, productionAsset: productionWorkerNames[0], productionAssetSha256: productionWorkerSha256, workbookSha256: sha256(workbookBytes), workbookValidation };
  const measured = samples.filter((item) => item.phase === "measure");
  const report = {
    schemaVersion: 2, recordedAt: new Date().toISOString(), warmups, repetitions, ...result,
    artifactIdentity: { kind: "isolated-tauri-example", mainApplication: false, gitHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(), gitStatus: execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim(), sources: sourcesBeforeBuild, generatedRustSha256: sha256(source), generatedConfigSha256: sha256(await readFile(configPath)), benchmarkPageSha256: sha256(benchmark), binaryPath, binarySha256, buildCommand: ["cargo", ...buildArguments] },
    latencySummary: [1048576, 10485760].map((byteLength) => ({ byteLength, roundTripMs: summary(result.cases.filter((item) => item.byteLength === byteLength).map((item) => item.roundTripMs)), rustProcessingMs: summary(result.cases.filter((item) => item.byteLength === byteLength).map((item) => item.rustProcessingMs)), ipcWaitingAndOverheadMs: summary(result.cases.filter((item) => item.byteLength === byteLength).map((item) => item.ipcWaitingAndOverheadMs)), fsWriteMs: summary(result.diskCases.filter((item) => item.byteLength === byteLength).map((item) => item.fsWriteMs)) })),
    environment: { platform: process.platform, arch: process.arch, cargoProfile, osRelease: osRelease(), node: process.version, buildEnvironment: { SDKROOT: process.env.SDKROOT ?? null, RUSTFLAGS: process.env.RUSTFLAGS ?? null, CARGO_BUILD_TARGET: process.env.CARGO_BUILD_TARGET ?? null, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? null }, tauriVersion, csp: sourceConfig.app.security.csp, runDirectory, rustc: execFileSync("rustc", ["--version"], { encoding: "utf8" }).trim() },
    methodology: {
      transport: "真实 Tauri WKWebView 原始 ArrayBuffer IPC；包装命令直接调用生产 file_io::write_binary_export",
      fixture: "1 MiB/10 MiB 固定合成字节，index mod 256；每种大小按 warmups 预热、repetitions 正式采样，复用缓冲区并覆盖同一中文/空格临时路径",
      rustProcessingMs: "Rust Instant 包围真实生产命令，含请求校验、登记领取、Vec 克隆、spawn_blocking 排队和 fs::write；无 fsync，不是隔离的纯写盘耗时",
      ipcWaitingAndOverheadMs: "前端 performance.now 调用往返持续时间减 Rust 处理持续时间；包含调度、传输及响应处理，不跨进程相减时间戳",
      diskMicrobenchmark: "独立微基准：预先分配填充同尺寸 Vec，在 spawn_blocking 内用 Instant 仅包围同一 std::fs::write API，覆盖另一临时文件；不含排队/分配、不含 fsync，不是生产命令内部阶段拆解",
      percentiles: "每种字节数分别统计；nearest-rank，p50=排序后ceil(n×0.5)，p95=ceil(n×0.95)；全部正式样本保留于 cases/diskCases，预热不入统计",
      isolation: "独立临时 Context、最小 AppState、无痕 WebView；不启动主应用、不加载连接管理器或用户数据库配置",
    },
    memory: { method: "ps 每 20ms 采样；Rust PID 来自本次 spawn，仅给采样最大 RSS；候选 WebContent 通过新 PID 识别且未经归属确认，候选汇总仅为未归属观察的采样下界，不能作为本应用 WebContent 内存或瞬时峰值结论；不是 JS 堆/全部分配字节", samplingError: sampleError ?? null, measuredSampleCount: measured.length, sampledPeakRustProcessRSSBytes: measured.length ? Math.max(...measured.map((item) => item.rustProcessRSSBytes)) : null, sampledPeakCandidateWebContentRSSBytes: measured.length ? Math.max(...measured.map((item) => item.candidateWebContentRSSBytes)) : null, samples },
    unmeasured: ["完整主应用交互/窗口关闭", "Windows/Linux 实机", "生产命令内部纯写盘阶段和 fsync", "磁盘满和物理磁盘故障", "采样间瞬时峰值与精确 WebContent 进程归属", ...(cargoProfile === "debug" ? ["Release 构建性能"] : []), "完整主应用 Release 性能（本次仅独立 example）", "1万/10万行宽字段的完整导出阶段测量", "Worker 输入克隆及保持期内存"],
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
} finally {
  if (activeChild && activeChild.exitCode === null) activeChild.kill();
  if (exampleCreated) await rm(examplePath, { force: true });
}
