import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, loadConfigFromFile, mergeConfig } from "vite";
import { instrumentDesktopInvoke } from "./desktop-tauri-invoke.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const markerPath = process.env.DB_CONNECT_PERFORMANCE_MANIFEST;
if (!markerPath) throw new Error("缺少专用验收 manifest，禁止普通构建使用该入口");
const marker = JSON.parse(await readFile(markerPath, "utf8"));
const original = await loadConfigFromFile({ command: "build", mode: "production" }, join(repo, "vite.config.ts"));
const observedLoaders = ["/src/App.tsx", "/src/components/database/DatabaseOverview.tsx", "/src/components/table/TableContent.tsx", "/src/components/sql/SqlEditorLazy.tsx"];
const expected = { htmlEntry: 1, appRoot: 1, appTreeProfiler: 1, tableProfiler: 1, editorProfiler: 1, exportPrepare: 1, lazyImports: 10, apiInvoke: 1 };
const transforms = Object.fromEntries(Object.keys(expected).map((key) => [key, 0]));
let entryInitialized = false;
function replaceRequired(source, search, replacement, key) {
  const matches = source.match(typeof search === "string" ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : search);
  if (matches?.length !== 1) throw new Error(`验收插桩 ${key} 必须恰好匹配一次，实际 ${matches?.length ?? 0}`);
  transforms[key]++;
  return source.replace(search, replacement);
}
await build(mergeConfig(original.config, {
  configFile: false, root: repo,
  define: { __DESKTOP_PERFORMANCE__: JSON.stringify(marker) },
  // 只对独立产物启用 React profiling；普通生产包保持原构建。
  resolve: { alias: [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }] },
  build: { outDir: join(dirname(markerPath), "frontend"), emptyOutDir: true, target: "es2022" },
  plugins: [{
    name: "desktop-performance-only",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        return replaceRequired(html, '/src/main.tsx', '/scripts/performance/desktop-entry.tsx', "htmlEntry");
      },
    },
    transform(source, id) {
      const path = id.split("?")[0].replaceAll("\\", "/");
      if (path.endsWith("/node_modules/@tauri-apps/api/core.js")) {
        source = instrumentDesktopInvoke(source);
        transforms.apiInvoke++;
      }
      if (observedLoaders.some((suffix) => path.endsWith(suffix))) {
        source = source.replace(/import\((['"])([^'"]+)\1\)/g, (match, _quote, module) => {
          transforms.lazyImports++;
          return `globalThis.__desktopLazy(${JSON.stringify(module)}, () => ${match})`;
        });
      }
      if (path.endsWith("/src/App.tsx")) {
        source = 'import { useLayoutEffect as desktopLayoutEffect, Profiler as DesktopProfiler } from "react";\n' + source;
        source = replaceRequired(source, "function AppInner() {", "function AppInner() { desktopLayoutEffect(() => { globalThis.__desktopMetrics.appRootCommits++; });", "appRoot");
        for (const [name, key] of [["TableContent", "tableProfiler"], ["SqlEditor", "editorProfiler"]]) {
          source = replaceRequired(source, new RegExp(`<${name}\\b[^>]*\\/>`, "g"), (match) =>
            `<DesktopProfiler id=${JSON.stringify(name)} onRender={globalThis.__desktopProfiler}>${match}</DesktopProfiler>`, key);
        }
      }
      if (path.endsWith("/src/main.tsx")) {
        source = replaceRequired(source, "<App />", '<React.Profiler id="AppTree" onRender={globalThis.__desktopProfiler}><App /></React.Profiler>', "appTreeProfiler");
      }
      if (path.endsWith("/src/utils/excelExport.ts")) {
        source = replaceRequired(source, "prepared = await prepare();", "globalThis.__desktopMetrics.exportPrepareCalls++; prepared = await prepare();", "exportPrepare");
      }
      return { code: source, map: null };
    },
    generateBundle(_options, bundle) {
      for (const [key, count] of Object.entries(expected)) {
        if (transforms[key] !== count) throw new Error(`验收插桩 ${key} 缺失或重复：${transforms[key]} / ${count}`);
      }
      const chunks = Object.values(bundle).filter((item) => item.type === "chunk");
      const entry = chunks.find((chunk) => Object.keys(chunk.modules).some((id) => id.replaceAll("\\", "/").endsWith("/scripts/performance/desktop-entry.tsx")));
      entryInitialized = !!entry && ["Metrics", "Lazy", "Profiler"].every((name) => new RegExp(`globalThis\\.__desktop${name}\\s*=`).test(entry.code));
      if (!entryInitialized) throw new Error("验收入口未进入真实产物，或全局观测初始化被遗漏；拒绝构建");
      const combined = chunks.map((chunk) => chunk.code).join("\n");
      if (!combined.includes(".appRootCommits++") || !combined.includes(".exportPrepareCalls++")) {
        throw new Error("真实产物缺少根提交或导出 prepare 插桩；拒绝构建");
      }
      if (!combined.includes("隔离入口未初始化 IPC 观测，拒绝调用")) {
        throw new Error("真实产物缺少公开 Tauri API invoke 观测守卫；拒绝构建");
      }
    },
  }],
}));
await writeFile(join(dirname(markerPath), "frontend-instrumentation.json"), JSON.stringify({ entryInitialized, transforms, expected }, null, 2) + "\n");
