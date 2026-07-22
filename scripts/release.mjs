import * as nodeFs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  getConsistentVersion,
  parseReleaseArgs,
  resolveTargetVersion,
  updateVersionContents,
  VERSION_PATHS,
} from "./release-core.mjs";

const FILES = { ...VERSION_PATHS };
const VERSION_FILES = Object.values(FILES);

export function systemExecute(command, args, { cwd, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? (result.stderr || result.stdout || "").trim() : "";
    throw new Error(
      `${command} ${args.join(" ")} 执行失败${detail ? `：${detail}` : ""}`,
    );
  }
  return capture ? result.stdout.trim() : "";
}

function readContents(cwd, fileSystem) {
  return Object.fromEntries(
    Object.entries(FILES).map(([key, relativePath]) => [
      key,
      fileSystem.readFileSync(path.join(cwd, relativePath), "utf8"),
    ]),
  );
}

function writeContents(cwd, fileSystem, contents) {
  for (const [key, relativePath] of Object.entries(FILES)) {
    fileSystem.writeFileSync(path.join(cwd, relativePath), contents[key], "utf8");
  }
}

function ensureBranchSynchronized(cwd, branch, execute) {
  const run = (command, args, capture = false) =>
    execute(command, args, { cwd, capture });
  run("git", [
    "fetch",
    "--no-tags",
    "origin",
    `refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ]);
  const sync = run(
    "git",
    ["rev-list", "--left-right", "--count", `HEAD...origin/${branch}`],
    true,
  );
  if (!/^0\s+0$/.test(sync)) {
    throw new Error(`当前分支与 origin/${branch} 未完全同步：${sync}`);
  }
}

function repositoryPreflight(cwd, execute) {
  const run = (command, args, capture = false) =>
    execute(command, args, { cwd, capture });
  if (run("git", ["status", "--porcelain"], true) !== "") {
    throw new Error("工作区不干净，请先提交或暂存现有修改");
  }
  const branch = run("git", ["branch", "--show-current"], true);
  if (!branch) throw new Error("当前处于 detached HEAD，不能发布");
  run("git", ["remote", "get-url", "origin"], true);
  ensureBranchSynchronized(cwd, branch, execute);
  return branch;
}

function ensureNewTag(tag, cwd, execute) {
  const local = execute("git", ["tag", "--list", tag], { cwd, capture: true });
  const remote = execute(
    "git",
    ["ls-remote", "--tags", "origin", `refs/tags/${tag}`],
    {
      cwd,
      capture: true,
    },
  );
  if (local || remote) {
    throw new Error(`标签 ${tag} 已存在；重发当前版本请使用 --current`);
  }
}

export function resolveNpmCommand(
  args,
  {
    platform = process.platform,
    nodePath = process.execPath,
    npmExecPath = process.env.npm_execpath,
  } = {},
) {
  if (platform !== "win32") return { command: "npm", args };
  if (!npmExecPath) {
    throw new Error("Windows 下无法定位 npm 入口：缺少 npm_execpath");
  }
  const extension = path.win32.extname(npmExecPath).toLowerCase();
  if ([".js", ".cjs", ".mjs"].includes(extension)) {
    return { command: nodePath, args: [npmExecPath, ...args] };
  }
  if ([".exe", ".com"].includes(extension)) {
    return { command: npmExecPath, args };
  }
  throw new Error(
    `Windows 下不能安全执行 npm 入口 ${npmExecPath}：仅支持 .js/.cjs/.mjs 或 .exe/.com`,
  );
}

function runNpm(cwd, execute, args, runtime) {
  const invocation = resolveNpmCommand(args, runtime);
  execute(invocation.command, invocation.args, { cwd });
}

function runChecks(cwd, execute, runtime) {
  runNpm(cwd, execute, ["test"], runtime);
  runNpm(cwd, execute, ["run", "build"], runtime);
  execute("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml"], {
    cwd,
  });
}

export function runRelease({
  args,
  cwd = process.cwd(),
  execute = systemExecute,
  fileSystem = nodeFs,
  output = console,
  runtime,
}) {
  const request = parseReleaseArgs(args);
  const original = readContents(cwd, fileSystem);
  const current = getConsistentVersion(original);
  const version = resolveTargetVersion(request, current);
  const tag = `v${version}`;
  const branch = repositoryPreflight(cwd, execute);
  if (request.mode !== "current") ensureNewTag(tag, cwd, execute);

  output.log(`准备发布 ${tag}，开始本地校验……`);
  runChecks(cwd, execute, runtime);

  if (request.mode === "current") {
    ensureBranchSynchronized(cwd, branch, execute);
    execute("git", ["tag", "-f", "-a", tag, "-m", `发布 ${tag}`], { cwd });
    execute("git", ["push", "--force", "origin", `refs/tags/${tag}`], { cwd });
    output.log(`${tag} 已重新推送，GitHub Actions 将重新构建 Release。`);
    return { mode: request.mode, version };
  }

  let wroteFiles = false;
  let stagedFiles = false;
  let committed = false;
  try {
    const updated = updateVersionContents(original, version);
    wroteFiles = true;
    writeContents(cwd, fileSystem, updated);
    execute(
      "cargo",
      [
        "metadata",
        "--manifest-path",
        "src-tauri/Cargo.toml",
        "--format-version",
        "1",
        "--no-deps",
      ],
      { cwd, capture: true },
    );
    const synchronized = readContents(cwd, fileSystem);
    if (getConsistentVersion(synchronized) !== version) {
      throw new Error("Cargo 锁文件未同步到目标版本");
    }
    execute("git", ["add", "--", ...VERSION_FILES], { cwd });
    stagedFiles = true;
    execute("git", ["commit", "-m", `发布：${tag}`], { cwd });
    committed = true;
  } catch (error) {
    if (!committed) {
      if (stagedFiles) {
        try {
          execute("git", ["restore", "--staged", "--", ...VERSION_FILES], {
            cwd,
          });
        } catch {
          output.error("无法自动撤销版本文件的暂存，请检查 git status。");
        }
      }
      if (wroteFiles) writeContents(cwd, fileSystem, original);
    }
    throw error;
  }
  try {
    execute("git", ["push", "origin", branch], { cwd });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}；请先推送提交后执行 npm run release -- --current`,
    );
  }
  execute("git", ["tag", "-a", tag, "-m", `发布 ${tag}`], { cwd });
  try {
    execute("git", ["push", "origin", `refs/tags/${tag}`], { cwd });
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}；请执行 npm run release -- --current 重试`,
    );
  }
  output.log(`${tag} 已推送，GitHub Actions 将构建并发布 Release。`);
  return { mode: request.mode, version };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    runRelease({ args: process.argv.slice(2) });
  } catch (error) {
    console.error(
      `发布失败：${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
