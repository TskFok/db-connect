import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  getConsistentVersion,
  parseReleaseArgs,
  resolveTargetVersion,
  updateVersionContents,
} from "./release-core.mjs";
import { runRelease } from "./release.mjs";

describe("发布参数", () => {
  it("无参数时递增补丁号", () => {
    assert.equal(resolveTargetVersion(parseReleaseArgs([]), "0.1.9"), "0.1.10");
  });

  it("接受更高的显式稳定版本", () => {
    assert.equal(
      resolveTargetVersion(parseReleaseArgs(["1.2.3"]), "0.1.9"),
      "1.2.3",
    );
  });

  it("精确比较超出安全整数范围的版本段", () => {
    assert.equal(
      resolveTargetVersion(
        parseReleaseArgs(["1.0.9007199254740993"]),
        "1.0.9007199254740992",
      ),
      "1.0.9007199254740993",
    );
  });

  it("精确递增超出安全整数范围的补丁号", () => {
    assert.equal(
      resolveTargetVersion(parseReleaseArgs([]), "1.0.9007199254740992"),
      "1.0.9007199254740993",
    );
  });

  it("current 模式沿用当前版本", () => {
    assert.equal(
      resolveTargetVersion(parseReleaseArgs(["--current"]), "0.1.9"),
      "0.1.9",
    );
  });

  for (const version of ["v1.2.3", "1.2", "1.2.3-beta.1", "01.2.3"]) {
    it(`拒绝非法版本 ${version}`, () => {
      assert.throws(() => parseReleaseArgs([version]), /稳定 SemVer/);
    });
  }

  it("拒绝 current 与其他参数组合", () => {
    assert.throws(
      () => parseReleaseArgs(["--current", "1.2.3"]),
      /不能与其他参数组合/,
    );
  });

  for (const version of ["0.1.9", "0.1.8"]) {
    it(`拒绝相同或更低版本 ${version}`, () => {
      assert.throws(
        () => resolveTargetVersion(parseReleaseArgs([version]), "0.1.9"),
        /必须高于/,
      );
    });
  }
});

const manifests = {
  packageJson: '{\n  "name": "db-connect",\n  "version": "0.1.0"\n}\n',
  packageLock: `{
  "name": "db-connect",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "packages": {
    "": {
      "name": "db-connect",
      "version": "0.1.0"
    }
  }
}
`,
  tauriConfig: '{\n  "productName": "DB Connect",\n  "version": "0.1.0"\n}\n',
  cargoToml: '[package]\nname = "db-connect"\nversion = "0.1.0"\nedition = "2021"\n',
  cargoLock: '[[package]]\nname = "db-connect"\nversion = "0.1.0"\ndependencies = []\n',
  appVersion: `declare const __APP_VERSION__: string | undefined;

export function getAppVersion(): string {
  return typeof __APP_VERSION__ === "string" && __APP_VERSION__.length > 0
    ? __APP_VERSION__
    : "0.1.0";
}
`,
};

describe("版本清单", () => {
  it("读取六个一致的版本源", () => {
    assert.equal(getConsistentVersion(manifests), "0.1.0");
  });

  it("报告不一致的文件和值", () => {
    const inconsistent = {
      ...manifests,
      tauriConfig: manifests.tauriConfig.replace("0.1.0", "0.2.0"),
    };
    assert.throws(
      () => getConsistentVersion(inconsistent),
      /src-tauri\/tauri\.conf\.json=0\.2\.0/,
    );
  });

  it("更新六个版本源的版本字段", () => {
    const updated = updateVersionContents(manifests, "0.1.1");
    assert.match(updated.packageJson, /"version": "0\.1\.1"/);
    assert.match(updated.packageLock, /"version": "0\.1\.1"/);
    assert.match(updated.tauriConfig, /"version": "0\.1\.1"/);
    assert.match(updated.cargoToml, /version = "0\.1\.1"/);
    assert.match(updated.cargoLock, /version = "0\.1\.1"/);
    assert.match(updated.appVersion, /: "0\.1\.1";\n\}/);
    assert.equal(getConsistentVersion(updated), "0.1.1");
  });

  it("Cargo.lock 存在同名远程依赖时只更新本地根包", () => {
    const cargoLock = `[[package]]
name = "db-connect"
version = "9.9.9"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "db-connect"
version = "0.1.0"
dependencies = []
`;

    const updated = updateVersionContents({ ...manifests, cargoLock }, "0.1.1");
    assert.match(updated.cargoLock, /version = "9\.9\.9"/);
    assert.match(updated.cargoLock, /version = "0\.1\.1"/);
  });

  it("只更新顶层 JSON 版本字段", () => {
    const nestedVersionFirst = {
      ...manifests,
      packageJson:
        '{\n  "metadata": {\n    "version": "9.9.9"\n  },\n  "version": "0.1.0"\n}\n',
    };

    assert.equal(
      updateVersionContents(nestedVersionFirst, "0.1.1").packageJson,
      '{\n  "metadata": {\n    "version": "9.9.9"\n  },\n  "version": "0.1.1"\n}\n',
    );
  });
});

function releaseHarness(
  args,
  {
    branch = "main",
    failOn,
    localTag = "",
    remoteTag = "",
    runtime,
    state = {},
    status = "",
    syncResults = ["0\t0"],
  } = {},
) {
  const files = new Map([
    ["/repo/package.json", manifests.packageJson],
    ["/repo/package-lock.json", manifests.packageLock],
    ["/repo/src-tauri/tauri.conf.json", manifests.tauriConfig],
    ["/repo/src-tauri/Cargo.toml", manifests.cargoToml],
    ["/repo/src-tauri/Cargo.lock", manifests.cargoLock],
    ["/repo/src/appVersion.ts", manifests.appVersion],
  ]);
  const calls = [];
  const events = [];
  let syncResultIndex = 0;
  state.files = files;
  state.calls = calls;
  state.events = events;
  const fileSystem = {
    readFileSync: (path) => files.get(path),
    writeFileSync: (path, value) => {
      events.push(["write", path]);
      files.set(path, value);
    },
  };
  const execute = (command, commandArgs) => {
    calls.push([command, ...commandArgs]);
    events.push(["command", command, ...commandArgs]);
    const key = [command, ...commandArgs].join(" ");
    if (key === failOn) throw new Error(`模拟失败：${key}`);
    if (key === "git status --porcelain") return status;
    if (key === "git branch --show-current") return branch;
    if (key === "git remote get-url origin") {
      return "git@github.com:owner/db-connect.git";
    }
    if (key === `git rev-list --left-right --count HEAD...origin/${branch}`) {
      const result = syncResults[Math.min(syncResultIndex, syncResults.length - 1)];
      syncResultIndex += 1;
      return result;
    }
    if (key === "git tag --list v0.1.1") return localTag;
    if (key === "git ls-remote --tags origin refs/tags/v0.1.1") return remoteTag;
    return "";
  };
  const result = runRelease({
    args,
    cwd: "/repo",
    execute,
    fileSystem,
    output: { log() {}, error() {} },
    runtime,
  });
  return { calls, events, files, result };
}

describe("发布编排", () => {
  it("通过成功返回空分支名的查询给出 detached HEAD 专用提示", () => {
    const state = {};
    assert.throws(
      () => releaseHarness(["--current"], { branch: "", state }),
      /detached HEAD/,
    );
    assert.deepEqual(state.calls[1], ["git", "branch", "--show-current"]);
  });

  for (const [scenario, message, options] of [
    ["脏工作区", "工作区不干净", { status: " M package.json" }],
    [
      "缺失 origin",
      "模拟失败：git remote get-url origin",
      { failOn: "git remote get-url origin" },
    ],
    ["本地领先", "未完全同步", { syncResults: ["1\t0"] }],
    ["远端领先", "未完全同步", { syncResults: ["0\t1"] }],
    ["分叉", "未完全同步", { syncResults: ["2\t3"] }],
  ]) {
    it(`危险预检拒绝${scenario}且不产生发布副作用`, () => {
      const state = {};
      assert.throws(() => releaseHarness([], { ...options, state }), new RegExp(message));
      assert.equal(
        state.calls.some(([command]) => command === "npm" || command === "cargo"),
        false,
      );
      assert.equal(state.events.some(([type]) => type === "write"), false);
    });
  }

  it("Windows 通过 Node 和 npm_execpath 启动 npm 检查", () => {
    const runtime = {
      platform: "win32",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
    };
    const { calls } = releaseHarness([], { runtime });
    assert.deepEqual(calls.find((call) => call.includes("test")), [
      runtime.nodePath,
      runtime.npmExecPath,
      "test",
    ]);
    assert.deepEqual(calls.find((call) => call.includes("build")), [
      runtime.nodePath,
      runtime.npmExecPath,
      "run",
      "build",
    ]);
  });

  it("非 Windows 保留直接 npm 参数数组调用", () => {
    const { calls } = releaseHarness([], {
      runtime: {
        platform: "linux",
        nodePath: "/usr/bin/node",
        npmExecPath: "/opt/npm-cli.js",
      },
    });
    assert.deepEqual(
      calls.find((call) => call[0] === "npm" && call[1] === "test"),
      ["npm", "test"],
    );
    assert.deepEqual(
      calls.find((call) => call[0] === "npm" && call[1] === "run"),
      ["npm", "run", "build"],
    );
  });

  it("校验、提交并推送新版本和标签", () => {
    const { calls, result } = releaseHarness([]);
    assert.deepEqual(result, { mode: "next-patch", version: "0.1.1" });
    assert.deepEqual(
      calls.find((call) => call[0] === "npm" && call[1] === "test"),
      ["npm", "test"],
    );
    assert.deepEqual(
      calls.find((call) => call[0] === "cargo" && call[1] === "test"),
      ["cargo", "test", "--manifest-path", "src-tauri/Cargo.toml"],
    );
    assert.deepEqual(
      calls.find((call) => call[0] === "git" && call[1] === "commit"),
      ["git", "commit", "-m", "发布：v0.1.1"],
    );
    assert.deepEqual(
      calls.find((call) => call[0] === "git" && call[1] === "tag" && call[2] === "-a"),
      ["git", "tag", "-a", "v0.1.1", "-m", "发布 v0.1.1"],
    );
    assert.ok(
      calls.some(
        (call) =>
          call[0] === "git" &&
          call[1] === "push" &&
          call[2] === "origin" &&
          call[3] === "refs/tags/v0.1.1",
      ),
    );
  });

  it("current 不写版本或提交并强推当前标签", () => {
    const { calls, events, files, result } = releaseHarness(["--current"]);
    assert.deepEqual(result, { mode: "current", version: "0.1.0" });
    assert.equal(files.get("/repo/package.json"), manifests.packageJson);
    assert.equal(events.some(([type]) => type === "write"), false);
    assert.equal(calls.some((call) => call.includes("commit")), false);
    assert.deepEqual(
      calls.find((call) => call[0] === "git" && call[1] === "tag"),
      ["git", "tag", "-f", "-a", "v0.1.0", "-m", "发布 v0.1.0"],
    );
  });

  it("提交失败时撤销暂存并恢复版本文件", () => {
    const state = {};
    assert.throws(
      () => releaseHarness([], { failOn: "git commit -m 发布：v0.1.1", state }),
      /模拟失败/,
    );
    assert.ok(
      state.calls.some(
        (call) =>
          call[0] === "git" &&
          call[1] === "restore" &&
          call.includes("package.json") &&
          call.includes("src/appVersion.ts"),
      ),
    );
    assert.equal(state.files.get("/repo/package.json"), manifests.packageJson);
    assert.equal(state.files.get("/repo/src/appVersion.ts"), manifests.appVersion);
  });

  it("分支推送失败时给出 current 恢复命令", () => {
    assert.throws(
      () => releaseHarness([], { failOn: "git push origin main" }),
      /npm run release -- --current/,
    );
  });

  it("标签推送失败时给出 current 重试命令", () => {
    assert.throws(
      () => releaseHarness([], { failOn: "git push origin refs/tags/v0.1.1" }),
      /npm run release -- --current/,
    );
  });

  it("目标 Tag 已存在时拒绝且无发布副作用", () => {
    const state = {};
    assert.throws(
      () => releaseHarness([], { localTag: "v0.1.1", state }),
      /标签 v0\.1\.1 已存在/,
    );
    assert.equal(
      state.calls.some(([command]) => command === "npm" || command === "cargo"),
      false,
    );
    assert.equal(state.events.some(([type]) => type === "write"), false);
  });
});

describe("CI 工作流契约", () => {
  it("ci.yml 不再因 push 到 master/main 触发", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    assert.match(workflow, /pull_request:/);
    assert.doesNotMatch(
      workflow,
      /^on:\n(?:.*\n)*? {2}push:\n {4}branches: \[master, main\]/m,
    );
  });
});
