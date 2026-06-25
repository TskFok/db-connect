# Release Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `npm run release` so the current branch can bump the app version, commit and push it, then let GitHub Actions create a public multi-platform Tauri release.

**Architecture:** Keep local release concerns in a focused Node ESM module plus CLI entrypoint. Keep remote packaging in a dedicated GitHub Actions workflow that only runs for `发布 vX.Y.Z` commits and uses `tauri-apps/tauri-action` to create the tag, Release, and bundle assets. README documents the operator workflow and failure expectations.

**Tech Stack:** Node.js ESM, npm scripts, Git CLI, GitHub Actions, Tauri 2, `tauri-apps/tauri-action`.

---

### Task 1: Release Version Logic Tests

**Files:**
- Create: `scripts/release-utils.mjs`
- Create: `scripts/release-utils.node-test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/release-utils.node-test.mjs`:

```js
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  bumpVersion,
  parseReleaseArgs,
  updateAppVersionFallback,
} from "./release-utils.mjs";

test("parseReleaseArgs defaults to patch", () => {
  assert.deepEqual(parseReleaseArgs([]), { dryRun: false, bump: "patch" });
});

test("parseReleaseArgs supports dry-run before bump", () => {
  assert.deepEqual(parseReleaseArgs(["--dry-run", "minor"]), {
    dryRun: true,
    bump: "minor",
  });
});

test("bumpVersion increments patch by default", () => {
  assert.equal(bumpVersion("0.1.0", "patch"), "0.1.1");
});

test("bumpVersion increments minor and resets patch", () => {
  assert.equal(bumpVersion("0.1.9", "minor"), "0.2.0");
});

test("bumpVersion increments major and resets minor and patch", () => {
  assert.equal(bumpVersion("0.9.9", "major"), "1.0.0");
});

test("bumpVersion accepts a greater explicit version", () => {
  assert.equal(bumpVersion("0.9.9", "1.2.3"), "1.2.3");
});

test("bumpVersion rejects explicit versions that do not increase", () => {
  assert.throws(
    () => bumpVersion("1.2.3", "1.2.3"),
    /must be greater than current version/
  );
});

test("bumpVersion rejects invalid bump arguments", () => {
  assert.throws(() => bumpVersion("1.2.3", "latest"), /Invalid release bump/);
});

test("updateAppVersionFallback replaces the fallback string", () => {
  const source = `declare const __APP_VERSION__: string | undefined;

export function getAppVersion(): string {
  return typeof __APP_VERSION__ === "string" && __APP_VERSION__.length > 0
    ? __APP_VERSION__
    : "0.1.0";
}
`;

  assert.equal(
    updateAppVersionFallback(source, "0.2.0"),
    `declare const __APP_VERSION__: string | undefined;

export function getAppVersion(): string {
  return typeof __APP_VERSION__ === "string" && __APP_VERSION__.length > 0
    ? __APP_VERSION__
    : "0.2.0";
}
`
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/release-utils.node-test.mjs`

Expected: FAIL because `scripts/release-utils.mjs` does not exist yet.

- [ ] **Step 3: Implement version helpers**

Create `scripts/release-utils.mjs`:

```js
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseReleaseArgs(args) {
  let dryRun = false;
  const rest = [];

  for (const arg of args) {
    if (arg === "--dry-run") {
      dryRun = true;
    } else {
      rest.push(arg);
    }
  }

  if (rest.length > 1) {
    throw new Error("Usage: npm run release -- [--dry-run] [patch|minor|major|X.Y.Z]");
  }

  return { dryRun, bump: rest[0] ?? "patch" };
}

export function bumpVersion(currentVersion, bump) {
  const current = parseSemver(currentVersion, "current version");

  if (bump === "patch") {
    return formatSemver(current.major, current.minor, current.patch + 1);
  }

  if (bump === "minor") {
    return formatSemver(current.major, current.minor + 1, 0);
  }

  if (bump === "major") {
    return formatSemver(current.major + 1, 0, 0);
  }

  if (SEMVER_RE.test(bump)) {
    const next = parseSemver(bump, "explicit version");
    if (compareSemver(next, current) <= 0) {
      throw new Error(`Release version ${bump} must be greater than current version ${currentVersion}.`);
    }
    return bump;
  }

  throw new Error("Invalid release bump. Use patch, minor, major, or X.Y.Z.");
}

export function updateAppVersionFallback(source, nextVersion) {
  const fallbackRe = /: "(\d+\.\d+\.\d+)";\n\}/;
  if (!fallbackRe.test(source)) {
    throw new Error("Could not find app version fallback in src/appVersion.ts.");
  }
  return source.replace(fallbackRe, `: "${nextVersion}";\n}`);
}

function parseSemver(version, label) {
  const match = SEMVER_RE.exec(version);
  if (!match) {
    throw new Error(`Invalid ${label}: ${version}. Expected X.Y.Z.`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function formatSemver(major, minor, patch) {
  return `${major}.${minor}.${patch}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/release-utils.node-test.mjs`

Expected: PASS for all release utility tests.

### Task 2: Local Release CLI

**Files:**
- Create: `scripts/release.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the CLI entrypoint**

Create `scripts/release.mjs`:

```js
#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bumpVersion,
  parseReleaseArgs,
  updateAppVersionFallback,
} from "./release-utils.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const paths = {
  packageJson: join(rootDir, "package.json"),
  packageLock: join(rootDir, "package-lock.json"),
  tauriConfig: join(rootDir, "src-tauri", "tauri.conf.json"),
  cargoToml: join(rootDir, "src-tauri", "Cargo.toml"),
  appVersion: join(rootDir, "src", "appVersion.ts"),
};

async function main() {
  const { dryRun, bump } = parseReleaseArgs(process.argv.slice(2));
  const branch = git(["branch", "--show-current"]).trim();
  if (!branch) {
    throw new Error("Release must run on a named Git branch.");
  }

  ensureCleanWorktree();
  ensureOriginExists();

  const packageJson = await readJson(paths.packageJson);
  const currentVersion = packageJson.version;
  const nextVersion = bumpVersion(currentVersion, bump);

  const nextFiles = await buildNextFiles(nextVersion);
  await verifyVersionConsistency(nextFiles, nextVersion);

  if (dryRun) {
    console.log(`Dry run: ${currentVersion} -> ${nextVersion}`);
    return;
  }

  await writeNextFiles(nextFiles);
  git(["add", "package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src/appVersion.ts"]);
  git(["commit", "-m", `发布 v${nextVersion}`]);
  git(["push", "origin", branch]);

  console.log(`Released v${nextVersion}. GitHub Actions will publish the Release after the push completes.`);
}

async function buildNextFiles(nextVersion) {
  const packageJson = await readJson(paths.packageJson);
  packageJson.version = nextVersion;

  const packageLock = await readJson(paths.packageLock);
  packageLock.version = nextVersion;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = nextVersion;
  }

  const tauriConfig = await readJson(paths.tauriConfig);
  tauriConfig.version = nextVersion;

  const cargoToml = await readFile(paths.cargoToml, "utf8");
  const nextCargoToml = cargoToml.replace(
    /^version = "\d+\.\d+\.\d+"$/m,
    `version = "${nextVersion}"`
  );
  if (nextCargoToml === cargoToml) {
    throw new Error("Could not update package version in src-tauri/Cargo.toml.");
  }

  const appVersion = await readFile(paths.appVersion, "utf8");

  return {
    packageJson,
    packageLock,
    tauriConfig,
    cargoToml: nextCargoToml,
    appVersion: updateAppVersionFallback(appVersion, nextVersion),
  };
}

async function verifyVersionConsistency(files, expectedVersion) {
  const cargoVersion = /^version = "(\d+\.\d+\.\d+)"$/m.exec(files.cargoToml)?.[1];
  const appVersion = /: "(\d+\.\d+\.\d+)";\n\}/.exec(files.appVersion)?.[1];
  const versions = [
    files.packageJson.version,
    files.packageLock.version,
    files.packageLock.packages?.[""]?.version,
    files.tauriConfig.version,
    cargoVersion,
    appVersion,
  ];

  if (versions.some((version) => version !== expectedVersion)) {
    throw new Error(`Version consistency check failed. Expected every file to use ${expectedVersion}.`);
  }
}

async function writeNextFiles(files) {
  await writeJson(paths.packageJson, files.packageJson);
  await writeJson(paths.packageLock, files.packageLock);
  await writeJson(paths.tauriConfig, files.tauriConfig);
  await writeFile(paths.cargoToml, files.cargoToml);
  await writeFile(paths.appVersion, files.appVersion);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureCleanWorktree() {
  const status = git(["status", "--porcelain"]);
  if (status.trim()) {
    throw new Error("Release requires a clean worktree. Commit or stash existing changes first.");
  }
}

function ensureOriginExists() {
  git(["remote", "get-url", "origin"]);
}

function git(args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
```

- [ ] **Step 2: Add npm scripts**

Modify `package.json` scripts:

```json
"release": "node scripts/release.mjs",
"test:release": "node --test scripts/release-utils.node-test.mjs"
```

- [ ] **Step 3: Run release dry-run**

Run: `npm run release -- --dry-run patch`

Expected: output includes `Dry run: 0.1.0 -> 0.1.1` and `git status --short` remains empty except for implementation files.

### Task 3: GitHub Release Workflow

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Add release workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    branches: [master, main]

permissions:
  contents: write

env:
  CARGO_TERM_COLOR: always

jobs:
  preflight:
    name: Release preflight
    if: ${{ startsWith(github.event.head_commit.message, '发布 v') }}
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.version.outputs.version }}
      tag: ${{ steps.version.outputs.tag }}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Read release version
        id: version
        shell: bash
        run: |
          version="$(node -p "require('./package.json').version")"
          echo "version=$version" >> "$GITHUB_OUTPUT"
          echo "tag=v$version" >> "$GITHUB_OUTPUT"

      - name: Check duplicate release
        shell: bash
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          RELEASE_TAG: ${{ steps.version.outputs.tag }}
        run: |
          if git ls-remote --exit-code --tags origin "refs/tags/${RELEASE_TAG}" >/dev/null 2>&1; then
            echo "Tag ${RELEASE_TAG} already exists."
            exit 1
          fi
          if gh release view "${RELEASE_TAG}" >/dev/null 2>&1; then
            echo "Release ${RELEASE_TAG} already exists."
            exit 1
          fi

  publish:
    name: Build and publish (${{ matrix.platform }})
    needs: preflight
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
            args: --target aarch64-apple-darwin
            rustTargets: aarch64-apple-darwin,x86_64-apple-darwin
          - platform: macos-latest
            args: --target x86_64-apple-darwin
            rustTargets: aarch64-apple-darwin,x86_64-apple-darwin
          - platform: ubuntu-22.04
            args: ""
            rustTargets: ""
          - platform: windows-latest
            args: ""
            rustTargets: ""

    runs-on: ${{ matrix.platform }}

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Install Linux dependencies (Tauri / WebKitGTK)
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            build-essential \
            curl \
            wget \
            file \
            libxdo-dev \
            libssl-dev \
            libayatana-appindicator3-dev \
            librsvg2-dev \
            patchelf

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm

      - name: Install npm dependencies
        run: npm ci

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.rustTargets }}

      - name: Rust cache
        uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri
          shared-key: tauri-release-${{ matrix.platform }}-${{ matrix.args }}

      - name: Publish Tauri bundles
        uses: tauri-apps/tauri-action@v1
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          VITE_GITHUB_ISSUE_REPO: ${{ vars.VITE_GITHUB_ISSUE_REPO }}
        with:
          tagName: v__VERSION__
          releaseName: MySQL Connect v__VERSION__
          releaseBody: 多平台安装包见本 Release 附件。
          releaseDraft: false
          prerelease: false
          generateReleaseNotes: true
          args: ${{ matrix.args }}
```

- [ ] **Step 2: Validate workflow syntax locally**

Run: `ruby -e "require 'yaml'; YAML.load_file('.github/workflows/release.yml'); puts 'release workflow yaml ok'"`

Expected: prints `release workflow yaml ok`.

### Task 4: README Release Documentation

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update packaging section**

In README under `### 打包`, add a release subsection:

````md
### 发布到 GitHub Releases

```bash
# 默认发布 patch 版本，例如 0.1.0 -> 0.1.1
npm run release

# 指定升级方式
npm run release -- minor
npm run release -- major
npm run release -- 1.2.3
```

发布脚本会要求当前工作区干净，随后同步更新 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `src/appVersion.ts` 的版本号，创建中文提交 `发布 vX.Y.Z`，并推送当前分支。推送后 GitHub Actions 会创建 `vX.Y.Z` tag，构建 macOS / Windows / Linux 安装包，并公开发布到 GitHub Releases。

可先运行 dry-run 检查下一个版本号，不写文件、不提交、不推送：

```bash
npm run release -- --dry-run patch
```
````

- [ ] **Step 2: Run Markdown sanity check**

Run: `rg -n "发布到 GitHub Releases|npm run release" README.md`

Expected: output shows the new release documentation lines.

### Task 5: Full Verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run release utility tests**

Run: `npm run test:release`

Expected: all `scripts/release-utils.node-test.mjs` tests pass.

- [ ] **Step 2: Run release dry-run**

Run: `npm run release -- --dry-run patch`

Expected: output includes the current version and next patch version; no version files are changed.

- [ ] **Step 3: Run frontend build**

Run: `npm run build`

Expected: TypeScript and Vite build complete successfully.

- [ ] **Step 4: Inspect final diff**

Run: `git status --short && git diff --stat`

Expected: only release automation files, `package.json`, and README are changed.
