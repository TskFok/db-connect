// 仅由 desktop-frontend-build.mjs 作为独立产物入口；普通 index/main 不引用。
import type { ProfilerOnRenderCallback } from "react";
import { invoke } from "@tauri-apps/api/core";

declare const __DESKTOP_PERFORMANCE__: {
  run_id: string;
  identifier: string;
  fixture: string;
  evidencePath: string;
  gitHead: string;
  sourceFingerprint: string;
};
const manifest = __DESKTOP_PERFORMANCE__;
const started = performance.now();
const metrics = {
  appRootCommits: 0,
  storageWrites: 0,
  settingsKeyWrites: 0,
  sidebarWidthValueChanges: 0,
  exportPrepareCalls: 0,
  workerCreated: 0,
  excelWorkerCreated: 0,
  commands: {} as Record<string, number>,
  profile: [] as { id: string; phase: string; actualDurationMs: number; atMs: number }[],
  lazy: [] as { module: string; outcome: string; atMs: number }[],
  drags: [] as Record<string, unknown>[],
  checkpoints: [] as Record<string, unknown>[],
  cspViolations: [] as { directive: string; blockedScheme: string }[],
};
declare global {
  var __desktopMetrics: typeof metrics;
  var __desktopProfiler: ProfilerOnRenderCallback;
  var __desktopLazy: <T>(module: string, loader: () => Promise<T>) => Promise<T>;
}
globalThis.__desktopMetrics = metrics;
globalThis.__desktopProfiler = (id, phase, actualDuration) => {
  metrics.profile.push({ id, phase, actualDurationMs: actualDuration, atMs: performance.now() - started });
};
let lazyFailure = "";
globalThis.__desktopLazy = async (module, loader) => {
  metrics.lazy.push({ module, outcome: "requested", atMs: performance.now() - started });
  // 便于在真实入口看到加载提示；这是测试插桩延迟，不是加载性能样本。
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (module === lazyFailure) {
    lazyFailure = "";
    metrics.lazy.push({ module, outcome: "injected-failure", atMs: performance.now() - started });
    throw new Error("performance 构建受控懒加载失败");
  }
  const value = await loader();
  metrics.lazy.push({ module, outcome: "loaded", atMs: performance.now() - started });
  return value;
};
const NativeWorker = window.Worker;
window.Worker = class extends NativeWorker {
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    metrics.workerCreated++;
    if (String(url).includes("excelExport.worker")) metrics.excelWorkerCreated++;
  }
};
const originalSetItem = Storage.prototype.setItem;
let previousSettings = localStorage.getItem("db-connect-settings");
Storage.prototype.setItem = function (key, value) {
  if (this === localStorage) {
    metrics.storageWrites++;
    if (key === "db-connect-settings") {
      metrics.settingsKeyWrites++;
      const width = (text: string | null) => {
        try { return text ? JSON.parse(text).state?.sidebarWidth : undefined; } catch { return undefined; }
      };
      if (width(previousSettings) !== width(value)) metrics.sidebarWidthValueChanges++;
      previousSettings = value;
    }
  }
  return originalSetItem.call(this, key, value);
};
window.addEventListener("securitypolicyviolation", (event) => {
  metrics.cspViolations.push({ directive: event.effectiveDirective, blockedScheme: event.blockedURI.split(":")[0] });
});
const snapshot = () => ({
  appRootCommits: metrics.appRootCommits,
  storageWrites: metrics.storageWrites,
  settingsKeyWrites: metrics.settingsKeyWrites,
  sidebarWidthValueChanges: metrics.sidebarWidthValueChanges,
  exportPrepareCalls: metrics.exportPrepareCalls,
  excelWorkerCreated: metrics.excelWorkerCreated,
  queryFullRows: metrics.commands.query_full_rows ?? 0,
  registrations: metrics.commands.prepare_binary_export ?? 0,
  profiles: metrics.profile.length,
});
let drag: {
  before: ReturnType<typeof snapshot>;
  started: number;
  startWidth: number;
  trustedMoves: number;
  frames: number;
  changedFrames: number;
  lastWidth: number;
  raf: number;
} | undefined;
const sidebarWidth = () => document.querySelector(".app-resizable-sider")?.getBoundingClientRect().width ?? 0;
document.addEventListener("mousedown", (event) => {
  if (!event.isTrusted || !(event.target instanceof Element) || !event.target.closest(".app-sider-resize-handle")) return;
  const width = sidebarWidth();
  drag = { before: snapshot(), started: performance.now(), startWidth: width, trustedMoves: 0, frames: 0, changedFrames: 0, lastWidth: width, raf: 0 };
  const current = drag;
  const tick = () => {
    if (drag !== current) return;
    current.frames++;
    const next = sidebarWidth();
    if (next !== current.lastWidth) current.changedFrames++;
    current.lastWidth = next;
    current.raf = requestAnimationFrame(tick);
  };
  current.raf = requestAnimationFrame(tick);
}, true);
window.addEventListener("mousemove", (event) => { if (drag && event.isTrusted) drag.trustedMoves++; }, true);
function finishDrag(reason: string) {
  const current = drag;
  if (!current) return;
  drag = undefined;
  cancelAnimationFrame(current.raf);
  const previewEnd = snapshot();
  const elapsedMs = performance.now() - current.started;
  // capture 发生于 React/生产 hook 松手监听之前；稍后快照覆盖最终提交/持久化。
  setTimeout(() => {
    const after = snapshot();
    metrics.drags.push({
      reason, nativeTrustedInput: true, elapsedMs, trustedMoves: current.trustedMoves,
      previewRafFrames: current.frames, observedWidthChangeFrames: current.changedFrames,
      initialWidth: current.startWidth, finalWidth: sidebarWidth(),
      appRootCommitsBeforeRelease: previewEnd.appRootCommits - current.before.appRootCommits,
      appRootCommitsIncludingRelease: after.appRootCommits - current.before.appRootCommits,
      settingsKeyWritesBeforeRelease: previewEnd.settingsKeyWrites - current.before.settingsKeyWrites,
      settingsKeyWritesIncludingRelease: after.settingsKeyWrites - current.before.settingsKeyWrites,
      sidebarWidthValueChangesIncludingRelease: after.sidebarWidthValueChanges - current.before.sidebarWidthValueChanges,
      subtreeProfile: metrics.profile.slice(current.before.profiles),
    });
    status.textContent = `已记录 ${metrics.drags.length} 次真实拖动；末次 ${elapsedMs.toFixed(0)}ms`;
  }, 120);
}
window.addEventListener("mouseup", (event) => { if (event.isTrusted) finishDrag("mouseup"); }, true);
window.addEventListener("blur", () => finishDrag("blur"), true);

const panel = document.createElement("details");
panel.open = true;
panel.style.cssText = "position:fixed;right:12px;top:8px;z-index:5000;padding:8px;background:#fff;color:#111;border:2px solid #7c3aed;border-radius:6px;max-width:440px;font:12px sans-serif";
const summary = document.createElement("summary");
summary.textContent = `隔离验收 ${manifest.run_id.slice(0, 8)}（可收起）`;
panel.append(summary);
const status = document.createElement("p");
status.textContent = "正在连接本次临时合成 SQLite…";
panel.append(status);
function button(text: string, action: () => void | Promise<void>) {
  const element = document.createElement("button");
  element.textContent = text;
  element.style.cssText = "margin:3px;padding:4px 8px";
  element.onclick = () => { void Promise.resolve(action()).catch((error) => { status.textContent = String(error); }); };
  panel.append(element);
}
let exportCheckpoint: ReturnType<typeof snapshot> | undefined;
button("开始保存框取消观察", () => {
  exportCheckpoint = snapshot();
  status.textContent = "已设观察起点；请从真实表格导出 Excel 并取消系统保存框，再保存观测";
});
button("保存观测", async () => {
  if (exportCheckpoint) {
    const after = snapshot();
    metrics.checkpoints.push({ kind: "export-cancel-window", before: exportCheckpoint, after,
      delta: Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - exportCheckpoint![key as keyof typeof after]])),
      systemCancelRequiresManualConfirmation: true });
    exportCheckpoint = undefined;
  }
  const evidence = {
    schemaVersion: 1, runId: manifest.run_id, identifier: manifest.identifier,
    gitHead: manifest.gitHead, sourceFingerprint: manifest.sourceFingerprint,
    timestamp: new Date().toISOString(), webview: navigator.userAgent,
    limitations: ["React actualDuration 是渲染耗时，不是 DOM 提交阶段耗时", "800ms 懒加载延迟属于测试插桩，不是加载性能", "App 根提交计数来自真实 AppInner useLayoutEffect", "rAF 观察帧数不是生产 hook 的精确 DOM 写入次数", "本记录不自动判定手工场景通过"],
    metrics,
  };
  await invoke("write_text_file", { path: manifest.evidencePath, contents: JSON.stringify(evidence, null, 2) });
  status.textContent = "已保存本次临时目录 desktop-observations.json";
});
const select = document.createElement("select");
for (const module of ["./components/common/ProjectIntroModal", "./components/common/ShortcutsHelpModal", "./components/databaseCompare/DatabaseCompareModal", "../index/IndexList", "../trigger/TriggerList", "../database/CreateTableSql", "../foreignKey/ForeignKeyList", "./RoutineList", "./EventList"]) {
  const option = document.createElement("option"); option.value = module; option.textContent = module.split("/").pop()!; select.append(option);
}
panel.append(document.createElement("br"), select);
button("该入口下次加载失败", () => { lazyFailure = select.value; status.textContent = "请首次打开选定真实入口，失败后关闭并重开"; });
document.body.append(panel);

// 先安装计数，再加载原始 main；App、窗口行为、IPC、数据库与导出均走生产实现。
await import("../../src/main");
const [{ useConnectionStore }, { useDatabaseStore }] = await Promise.all([
  import("../../src/stores/connectionStore"), import("../../src/stores/databaseStore"),
]);
await useConnectionStore.getState().connect({
  database_type: "sqlite", name: `合成验收 ${manifest.run_id.slice(0, 8)}`,
  host: "", port: 0, username: "", database: "main", sqlite_path: manifest.fixture,
});
const connId = useConnectionStore.getState().activeConnId;
if (!connId) throw new Error("合成 SQLite 连接失败，请检查独立应用日志");
await useDatabaseStore.getState().loadDatabases(connId, "main");
await useDatabaseStore.getState().openOrSwitchToTable(connId, "main", "synthetic_wide");
button("打开 SQL 标签", () => { useDatabaseStore.getState().openSqlTab(connId, "SELECT * FROM synthetic_wide LIMIT 1000;"); });
button("打开宽表", () => useDatabaseStore.getState().openOrSwitchToTable(connId, "main", "synthetic_wide"));
button("打开小表", () => useDatabaseStore.getState().openOrSwitchToTable(connId, "main", "synthetic_small"));
status.textContent = "已打开真实主应用；夹具 10,000 行 × 200 列，数据和密钥已隔离";
