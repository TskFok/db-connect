import { createHash, randomUUID } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { chmod, copyFile, cp, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const markerName = ".db-connect-performance.json";
const command = process.argv[2];
const json = (value) => JSON.stringify(value, null, 2) + "\n";
function checked(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: repo, encoding: "utf8", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${cmd} 退出 ${result.status}: ${result.stderr ?? ""}`);
  return result.stdout;
}
async function sourceFingerprint() {
  const tracked = checked("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "src", "src-tauri", "public", "index.html", "vite.config.ts", "package.json", "package-lock.json", "scripts/performance/desktop-app.mjs", "scripts/performance/desktop-entry.tsx", "scripts/performance/desktop-frontend-build.mjs", "scripts/performance/desktop-tauri-invoke.mjs"])
    .split("\0").filter(Boolean);
  const hash = createHash("sha256");
  for (const path of [...new Set(tracked)].filter((path) => !path.startsWith("src-tauri/target/")).sort()) {
    hash.update(path).update("\0").update(await readFile(join(repo, path))).update("\0");
  }
  return hash.digest("hex");
}
async function loadRun(path) {
  if (!path) throw new Error("需要 prepare 输出的绝对验收目录");
  const root = await realpath(path);
  const marker = JSON.parse(await readFile(join(root, markerName), "utf8"));
  const compact = marker.run_id.replaceAll("-", "");
  if (resolve(path) !== root || dirname(root) !== await realpath(tmpdir())
    || basename(root) !== `db-connect-desktop-${compact}`
    || marker.identifier !== `com.tskfok.dbconnect.performance.${compact}`
    || marker.repo !== repo) throw new Error("验收目录身份或规范路径不匹配");
  return { root, marker };
}
if (command === "prepare") {
  const run_id = randomUUID();
  const compact = run_id.replaceAll("-", "");
  const root = join(await realpath(tmpdir()), `db-connect-desktop-${compact}`);
  const identifier = `com.tskfok.dbconnect.performance.${compact}`;
  await mkdir(root, { mode: 0o700 });
  const fixture = join(root, "synthetic.sqlite3");
  // 只执行一次 executescript；列名/表达式生成循环不查询数据库。
  const columns = Array.from({ length: 194 }, (_, i) => `field_${String(i + 1).padStart(3, "0")} TEXT`).join(",");
  const values = Array.from({ length: 194 }, (_, i) => `'synthetic_' || n || '_${i + 1}'`).join(",");
  const ddl = `CREATE TABLE synthetic_wide (id INTEGER PRIMARY KEY, label TEXT, exact_integer INTEGER, occurred_at TEXT, nullable TEXT, binary_value BLOB, ${columns});
WITH RECURSIVE rows(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM rows WHERE n<10000)
INSERT INTO synthetic_wide SELECT n, '合成 中文 🙂 ' || n, 9007199254740993, '2026-10-15T01:02:03Z', NULL, X'00FF10', ${values} FROM rows;
CREATE TABLE synthetic_small AS SELECT id,label,exact_integer,occurred_at,nullable,binary_value FROM synthetic_wide WHERE id <= 20;`;
  checked("python3", ["-c", "import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.executescript(sys.stdin.read()); db.close()", fixture], { input: ddl });
  await chmod(fixture, 0o600);
  const productName = `DB Connect Performance ${compact.slice(0, 8)}`;
  const binaryName = `db-connect-performance-${compact.slice(0, 8)}`;
  const original = JSON.parse(await readFile(join(repo, "src-tauri/tauri.conf.json"), "utf8"));
  const config = {
    productName, mainBinaryName: binaryName, identifier,
    build: {
      frontendDist: join(root, "frontend"),
      beforeBuildCommand: "node scripts/performance/desktop-frontend-build.mjs",
    },
    app: {
      windows: [{ ...original.app.windows[0], title: productName, label: "main",
        dataDirectory: `performance-${compact}` }],
      security: original.app.security,
    },
    bundle: { active: true, targets: ["app"] },
  };
  const marker = { run_id, identifier, repo, fixture, productName, binaryName, configPath: join(root, "tauri.performance.json"),
    evidencePath: join(root, "desktop-observations.json"), gitHead: checked("git", ["rev-parse", "HEAD"]).trim(),
    sourceFingerprint: await sourceFingerprint(), createdAt: new Date().toISOString(), fixtureShape: { rows: 10000, columns: 200 } };
  await writeFile(join(root, markerName), json(marker), { mode: 0o600 });
  await writeFile(marker.configPath, json(config), { mode: 0o600 });
  console.log(json({ root, identifier, appName: productName, next: `node scripts/performance/desktop-app.mjs build '${root}'` }));
} else if (command === "build") {
  const { root, marker } = await loadRun(process.argv[3]);
  if (process.platform !== "darwin") throw new Error("当前入口只为本机 macOS 提供 .app；其他平台需单独验收");
  const fingerprint = await sourceFingerprint();
  if (fingerprint !== marker.sourceFingerprint) throw new Error("prepare 后源码已改变；请重新 prepare，保留旧目录作为历史");
  const mode = process.argv[4] === "--release" ? "release" : "debug";
  const args = [join(repo, "node_modules/@tauri-apps/cli/tauri.js"), "build", "--bundles", "app", "--features", "performance-desktop", "--config", marker.configPath];
  if (mode === "debug") args.push("--debug");
  const env = { ...process.env, CARGO_NET_OFFLINE: "true", DB_CONNECT_PERFORMANCE_MANIFEST: join(root, markerName) };
  checked(process.execPath, args, { env, stdio: "inherit" });
  if (fingerprint !== await sourceFingerprint()) throw new Error("构建期间源码改变；拒绝登记为当前源码产物");
  const builtBundle = join(repo, "src-tauri/target", mode, "bundle/macos", `${marker.productName}.app`);
  const appPath = join(root, `${marker.productName}.app`);
  await cp(builtBundle, appPath, { recursive: true, errorOnExist: true, force: false });
  const executable = join(appPath, "Contents/MacOS", marker.binaryName);
  const build = { appPath, executable, mode, sourceFingerprint: fingerprint, gitHead: marker.gitHead,
    binarySha256: createHash("sha256").update(await readFile(executable)).digest("hex"),
    productionCsp: JSON.parse(await readFile(marker.configPath, "utf8")).app.security.csp,
    builtAt: new Date().toISOString(), feature: "performance-desktop", instrumentation: "React profiling build; AppInner layout effects; native trusted input; no DOM commit duration claim" };
  await writeFile(join(root, "build.json"), json(build), { mode: 0o600 });
  await copyFile(join(root, markerName), join(root, "build-source.json"));
  console.log(json({ ...build, next: `node scripts/performance/desktop-app.mjs launch '${root}'` }));
} else if (command === "launch") {
  const { root, marker } = await loadRun(process.argv[3]);
  const build = JSON.parse(await readFile(join(root, "build.json"), "utf8"));
  if (build.sourceFingerprint !== await sourceFingerprint()) throw new Error("源码已改变，请使用新的 prepare/build 产物");
  if (build.binarySha256 !== createHash("sha256").update(await readFile(build.executable)).digest("hex")) throw new Error("验收可执行文件哈希不匹配");
  if (!build.appPath.startsWith(root + "/") || basename(build.appPath) !== `${marker.productName}.app`) throw new Error("不允许启动目录外应用");
  // 直接执行独立 .app 内唯一命名的 exe，保留精确 PID；不使用 open 的旧应用复用行为。
  const child = spawn(build.executable, [], { env: { ...process.env, DB_CONNECT_PERFORMANCE_DIR: root, DB_CONNECT_PERFORMANCE_RUN_ID: marker.run_id }, stdio: "inherit" });
  await writeFile(join(root, "launch.json"), json({ pid: child.pid, appPath: build.appPath, executable: build.executable, launchedAt: new Date().toISOString() }), { mode: 0o600 });
  child.on("exit", (code) => { process.exitCode = code ?? 1; });
} else {
  console.log("完整当前源码 Tauri 隔离验收（不安装依赖、不启动旧应用）：\n  prepare\n  build <prepare返回的目录> [--release]\n  launch <prepare返回的目录>\n默认 debug，正式性能采样须明确构建模式；本脚本不把GUI/指标自动记为通过。");
}
