import { build } from "vite";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, URL, URLSearchParams } from "node:url";
import { Buffer } from "node:buffer";
import { setInterval, clearInterval } from "node:timers";
import { performance } from "node:perf_hooks";

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runDirectory = resolve(process.argv[2]);
const outputPath = resolve(process.argv[3]);
const baselineRef =
  process.env.EXCEL_WEBVIEW_BASELINE_REF ??
  "a2e2f5d1867a66a79da59001ea43d4df562a8569";
const repetitions = Number(process.env.EXCEL_WEBVIEW_REPETITIONS ?? 3);
const port = Number(process.env.EXCEL_WEBVIEW_PORT ?? 14289);
const baselineCommit = execFileSync(
  "git",
  ["rev-parse", "--verify", `${baselineRef}^{commit}`],
  { cwd: repo, encoding: "utf8" }
).trim();
let baselineSource = execFileSync(
  "git",
  ["show", `${baselineCommit}:src/utils/excelExport.ts`],
  { cwd: repo, encoding: "utf8" }
);
// 只剔除依赖 Tauri 的未调用接口，保留该版本的实际值归一化/Blob/Base64 实现。
baselineSource = baselineSource
  .replace(/^import .*;\n/gm, "")
  .replace(/^export \{[^\n]+\} from [^\n]+;\n/gm, "");
baselineSource = baselineSource.slice(
  0,
  baselineSource.indexOf("export async function saveExcelWithDialog")
);
baselineSource += "\nexport { uint8ArrayToBase64, blobToArrayBuffer };\n";
if (!baselineSource.includes("function uint8ArrayToBase64"))
  throw new Error(
    "Baseline commit does not contain the old Base64 implementation"
  );
const security = JSON.parse(
  await readFile(join(repo, "src-tauri/tauri.conf.json"), "utf8")
).app.security;
const dist = join(runDirectory, "dist");
await build({
  configFile: join(repo, "vite.config.ts"),
  root: repo,
  plugins: [
    {
      name: "excel-baseline",
      resolveId(id) {
        if (id === "virtual:excel-export-baseline")
          return "\0excel-export-baseline.ts";
      },
      load(id) {
        if (id === "\0excel-export-baseline.ts") return baselineSource;
      },
    },
  ],
  build: {
    outDir: dist,
    emptyOutDir: true,
    rollupOptions: {
      input: join(repo, "scripts/performance/excel-export-webview.html"),
    },
  },
});
let activeChild;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    response.setHeader("Content-Security-Policy", security.csp);
    if (url.pathname === "/save" && request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const decodeStart = performance.now();
      const bytes =
        url.searchParams.get("mode") === "baseline"
          ? Buffer.from(JSON.parse(body.toString("utf8")).base64, "base64")
          : body;
      const decodeMs = performance.now() - decodeStart;
      const writeStart = performance.now();
      // Unicode/空格临时路径；重复案例覆盖同一已存在文件。
      await writeFile(join(runDirectory, "合成 导出.xlsx"), bytes);
      const diskWriteMs = performance.now() - writeStart;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          channel: "loopback HTTP surrogate; not Tauri IPC",
          requestBodyBytes: body.byteLength,
          decodedBytes: bytes.byteLength,
          decodeMs,
          diskWriteMs,
          fsync: false,
        })
      );
      return;
    }
    const path = resolve(dist, `.${url.pathname}`);
    if (!path.startsWith(`${dist}/`) || !existsSync(path)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.setHeader(
      "Content-Type",
      path.endsWith(".html")
        ? "text/html; charset=utf-8"
        : path.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : "application/octet-stream"
    );
    response.end(await readFile(path));
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

async function processes() {
  const { stdout } = await exec("ps", ["-axo", "pid=,rss=,comm="]);
  return stdout
    .trim()
    .split("\n")
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      return match
        ? {
            pid: Number(match[1]),
            rssBytes: Number(match[2]) * 1024,
            command: match[3],
          }
        : null;
    })
    .filter(Boolean);
}
async function runCase(parameters, index) {
  const initial = await processes();
  const previousPids = new Set(initial.map((item) => item.pid));
  const query = new URLSearchParams(
    Object.entries(parameters).map(([key, value]) => [key, String(value)])
  );
  const casePath = join(runDirectory, `case-${index}.json`);
  let phase = "setup";
  const samples = [];
  let sampling = false;
  const child = spawn(
    join(runDirectory, "excel-export-webview"),
    [
      `http://127.0.0.1:${port}/scripts/performance/excel-export-webview.html?${query}`,
      casePath,
    ],
    { stdio: ["ignore", "pipe", "inherit"] }
  );
  activeChild = child;
  child.stdout.on("data", (data) => {
    for (const line of data.toString().split("\n"))
      if (line.startsWith("PHASE:")) phase = line.slice(6).trim();
  });
  const sample = async () => {
    if (sampling) return;
    sampling = true;
    try {
      const startedAt = performance.now();
      const samplePhase = phase;
      const all = await processes();
      const webContent = all.filter(
        (item) =>
          !previousPids.has(item.pid) &&
          item.command.includes("com.apple.WebKit.WebContent")
      );
      const native = all.find((item) => item.pid === child.pid);
      samples.push({
        phase: samplePhase,
        timestampMs: startedAt,
        nativeRSSBytes: native?.rssBytes ?? 0,
        candidateWebContentRSSBytes: webContent.reduce(
          (sum, item) => sum + item.rssBytes,
          0
        ),
        candidateWebContentPids: webContent.map((item) => item.pid),
      });
    } finally {
      sampling = false;
    }
  };
  const timer = setInterval(sample, 50);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("exit", resolve);
      child.once("error", reject);
    });
    if (code !== 0)
      throw new Error(
        `Native benchmark failed: ${JSON.stringify(parameters)} (exit ${code})`
      );
    const result = JSON.parse(await readFile(casePath, "utf8"));
    const measured = samples.filter(
      (item) => item.phase === "measure" || item.phase === "clone-hold"
    );
    const heldClone = samples.filter((item) => item.phase === "clone-hold");
    result.memory = {
      method:
        "ps RSS sampled every 50ms; only newly appearing WebKit.WebContent PIDs are candidates; attribution is heuristic and samples are a lower bound on peak, not JS heap or allocation bytes",
      candidateWebContentPids: [
        ...new Set(measured.flatMap((item) => item.candidateWebContentPids)),
      ],
      measuredSampleCount: measured.length,
      initialCandidateWebContentRSSBytes:
        measured[0]?.candidateWebContentRSSBytes ?? null,
      sampledPeakCandidateWebContentRSSBytes: measured.length
        ? Math.max(...measured.map((item) => item.candidateWebContentRSSBytes))
        : null,
      sampledPeakNativeHarnessRSSBytes: measured.length
        ? Math.max(...measured.map((item) => item.nativeRSSBytes))
        : null,
      sampledPeakCloneHoldWebContentRSSBytes: heldClone.length
        ? Math.max(...heldClone.map((item) => item.candidateWebContentRSSBytes))
        : null,
      samples,
    };
    console.error(
      `Completed ${JSON.stringify(parameters)}: ${result.exportBeforeWriteMs?.toFixed(1) ?? "smoke"} ms`
    );
    return result;
  } finally {
    clearInterval(timer);
    if (child.exitCode === null) child.kill();
    activeChild = undefined;
  }
}

try {
  const smoke = await runCase({ mode: "smoke" }, "smoke");
  const cases = [];
  const fixtures = [
    { rows: 10000, columns: 8, wide: false },
    { rows: 100000, columns: 8, wide: false },
    { rows: 10000, columns: 32, wide: true },
  ];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const fixture of fixtures) {
      // 交替顺序减少固定先后顺序偏差；每次使用新的独立 WKWebView 进程。
      for (const mode of repetition % 2 === 0
        ? ["baseline", "worker"]
        : ["worker", "baseline"]) {
        cases.push({
          repetition: repetition + 1,
          ...(await runCase({ ...fixture, mode }, cases.length)),
        });
      }
      cases.push({
        repetition: repetition + 1,
        ...(await runCase({ ...fixture, mode: "clone" }, cases.length)),
      });
    }
  }
  for (const fixture of fixtures) {
    const matching = cases.filter(
      (item) =>
        item.content &&
        item.rowCount === fixture.rows &&
        item.columnCount === fixture.columns
    );
    const expected = JSON.stringify(matching[0].content);
    if (!matching.every((item) => JSON.stringify(item.content) === expected))
      throw new Error(`Workbook XML mismatch: ${JSON.stringify(fixture)}`);
  }
  const result = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    baselineCommit,
    repetitions,
    environment: {
      cpu: execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], {
        encoding: "utf8",
      }).trim(),
      ramBytes: Number(
        execFileSync("sysctl", ["-n", "hw.memsize"], { encoding: "utf8" })
      ),
      csp: security.csp,
      viteMode: "production",
      runDirectory,
    },
    methodology: {
      fixturePreparation:
        "Synthetic rows allocated before measured export; baseline preparation normalizes every cell, worker preparation copies only outer matrix",
      inputArrivalMs:
        "From immediately before postMessage to handler entry using performance.timeOrigin + performance.now; includes cold Worker startup, serialization, dispatch and deserialization; not isolated clone CPU",
      encodingMs:
        "Measured inside dedicated instrumentation Worker using production buildWorkbookBuffer; includes normalization and encoding. Production worker checked independently by smoke test; cold static imports are included in inputArrivalMs.",
      baselineEncoding:
        "Same installed write-excel-file/universal toBlob path; normalization, blobToArrayBuffer and Base64 helper taken from fixed Git baseline",
      responsiveness:
        "10ms timer gaps include scheduling and background effects; not measured long-task duration when WebKit longtask API unavailable",
      contentEquality:
        "All xl/**/*.xml SHA-256 and workbook XML compared across baseline/worker/repetitions, including shared strings/styles; variable ZIP metadata ignored",
      fileWrite:
        "Actual temporary-file write via Node loopback HTTP, without fsync; surrogate transport is explicitly not Tauri IPC or Rust write performance",
    },
    smoke,
    cases,
    contentEqualityPassed: true,
    unmeasured: [
      "Full Tauri custom-protocol Worker/CSP integration",
      "Tauri IPC timings and Rust process RSS",
      "Isolated structured-clone CPU/peak heap bytes",
      "Exact transient peak RSS between samples",
      "Actual main-thread longest task when WebKit longtask API is unsupported",
      "Native user input, dialog cancel, application/window closure during export",
      "Windows/Linux desktop compatibility",
      "Disk failure and no-write-permission native path",
    ],
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Wrote ${outputPath}`);
} finally {
  activeChild?.kill();
  server.close();
}
