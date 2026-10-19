import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import ts from "typescript";
import { instrumentDesktopInvoke } from "./desktop-tauri-invoke.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
test("只读 Tauri 内部 invoke 不阻断隔离入口初始化", async () => {
  const dom = new JSDOM("<!doctype html><body><div id='root'></div></body>", { url: "https://performance.invalid", runScripts: "outside-only" });
  try {
    const internal = {};
    const backend = async () => "synthetic-result";
    Object.defineProperty(internal, "invoke", { value: backend });
    Object.defineProperty(dom.window, "__TAURI_INTERNALS__", { value: internal });
    const context = dom.getInternalVMContext();
    context.exports = {};
    context.require = () => ({ invoke: backend });
    context.Worker = class {};
    context.__DESKTOP_PERFORMANCE__ = { run_id: "synthetic-test", identifier: "test", fixture: "/synthetic", evidencePath: "/synthetic/evidence", gitHead: "test", sourceFingerprint: "test" };
    const source = await readFile(join(repo, "scripts/performance/desktop-entry.tsx"), "utf8");
    assert.ok(source.includes("// 先安装计数，再加载原始 main；"));
    const initialization = source.split("// 先安装计数，再加载原始 main；")[0];
    const compiled = ts.transpileModule(initialization, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    assert.doesNotThrow(() => vm.runInContext(compiled, context), "真实只读 invoke 描述符下入口应初始化成功");
    assert.equal(dom.window.__TAURI_INTERNALS__.invoke, backend);
    assert.equal(Object.getOwnPropertyDescriptor(internal, "invoke").writable, false);
    assert.ok(dom.window.__desktopMetrics);
    assert.ok(dom.window.document.querySelector("details"));
  } finally {
    dom.window.close();
  }
});
test("真实 Tauri API invoke 在只读内部对象上保留转发语义并计数", async () => {
  const installedCore = await readFile(join(repo, "node_modules/@tauri-apps/api/core.js"), "utf8");
  const source = instrumentDesktopInvoke(installedCore);
  const functionSource = source.match(/async function invoke\(cmd, args = \{\}, options\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(functionSource, "从实际安装的公开 API 模块提取真实 invoke 函数");
  const calls = [];
  const result = { synthetic: true };
  const failure = new Error("synthetic-backend-failure");
  const backend = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (cmd === "reject_synthetic") throw failure;
    return result;
  };
  const internal = {};
  Object.defineProperty(internal, "invoke", { value: backend });
  Object.freeze(internal);
  const metrics = { commands: {} };
  const context = vm.createContext({ window: { __TAURI_INTERNALS__: internal }, __desktopMetrics: metrics });
  const invoke = vm.runInContext(`(${functionSource})`, context);
  const args = new Uint8Array([0, 255, 127]);
  const options = { headers: { "x-db-connect-export-id": "synthetic-id" } };
  assert.equal(await invoke("query_full_rows", args, options), result);
  assert.equal(calls[0].args, args);
  assert.equal(calls[0].options, options);
  await assert.rejects(invoke("reject_synthetic"), (error) => error === failure);
  assert.deepEqual(metrics.commands, { query_full_rows: 1, reject_synthetic: 1 });
  assert.equal(calls.length, 2);
  assert.equal(internal.invoke, backend);
  delete context.__desktopMetrics;
  await assert.rejects(invoke("must_not_reach_backend"), /隔离入口未初始化 IPC 观测/);
  assert.equal(calls.length, 2);
  assert.throws(() => instrumentDesktopInvoke("async function other() {}"), /必须恰好匹配一次/);
});
test("真实生产前端产物包含隔离入口初始化和全部必需插桩", async () => {
  const root = await mkdtemp(join(tmpdir(), "db-connect-frontend-test-"));
  try {
    const manifestPath = join(root, ".db-connect-performance.json");
    await writeFile(manifestPath, JSON.stringify({ run_id: randomUUID(), identifier: "test.frontend.only", fixture: join(root, "synthetic.sqlite3"), evidencePath: join(root, "evidence.json"), gitHead: "test", sourceFingerprint: "test" }));
    execFileSync(process.execPath, ["scripts/performance/desktop-frontend-build.mjs"], {
      cwd: repo, env: { ...process.env, DB_CONNECT_PERFORMANCE_MANIFEST: manifestPath },
      stdio: "pipe", maxBuffer: 20 * 1024 * 1024,
    });
    const assets = join(root, "frontend/assets");
    const chunks = await Promise.all((await readdir(assets)).filter((path) => path.endsWith(".js")).map((path) => readFile(join(assets, path), "utf8")));
    assert.ok(chunks.some((code) => /globalThis\.__desktopMetrics\s*=/.test(code)), "必须实际打包 desktop-entry 的指标初始化");
    assert.ok(chunks.some((code) => /globalThis\.__desktopLazy\s*=/.test(code)), "必须实际打包 lazy 初始化");
    const report = JSON.parse(await readFile(join(root, "frontend-instrumentation.json"), "utf8"));
    assert.equal(report.entryInitialized, true);
    assert.equal(report.transforms.appRoot, 1);
    assert.equal(report.transforms.appTreeProfiler, 1);
    assert.equal(report.transforms.tableProfiler, 1);
    assert.equal(report.transforms.editorProfiler, 1);
    assert.equal(report.transforms.exportPrepare, 1);
    assert.equal(report.transforms.lazyImports, 10);
    assert.equal(report.transforms.apiInvoke, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
