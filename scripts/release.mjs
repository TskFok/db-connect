#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bumpVersion,
  formatReleaseTag,
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

  if (bump === "current") {
    await releaseCurrent(dryRun);
    return;
  }

  const packageJson = await readJson(paths.packageJson);
  const currentVersion = packageJson.version;
  const nextVersion = bumpVersion(currentVersion, bump);
  const nextFiles = await buildNextFiles(nextVersion);
  verifyVersionConsistency(nextFiles, nextVersion);

  if (dryRun) {
    console.log(`Dry run: ${currentVersion} -> ${nextVersion}`);
  } else {
    const branch = currentBranch();
    ensureCleanWorktree();
    ensureOriginExists();

    await writeNextFiles(nextFiles);
    syncCargoLockfile();
    git([
      "add",
      "package.json",
      "package-lock.json",
      "src-tauri/tauri.conf.json",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
      "src/appVersion.ts",
    ]);
    git(["commit", "-m", `发布 v${nextVersion}`]);
    git(["push", "origin", branch]);
    pushReleaseTag(nextVersion);
  }

  const tag = formatReleaseTag(nextVersion);
  console.log(
    dryRun
      ? `Dry run: would push tag ${tag} to trigger GitHub Actions.`
      : `Released ${tag}. GitHub Actions will publish the Release after the tag push completes.`
  );
}

async function releaseCurrent(dryRun) {
  const versionFiles = await readVersionFiles();
  const version = versionFiles.packageJson.version;
  const tag = formatReleaseTag(version);
  verifyVersionConsistency(versionFiles, version);

  if (dryRun) {
    console.log(
      `Dry run: would force-push tag ${tag} for current version ${version}.`
    );
    return;
  }

  ensureCleanWorktree();
  ensureOriginExists();
  pushReleaseTag(version, { force: true });

  console.log(
    `Pushed tag ${tag}. GitHub Actions will publish the Release after the tag push completes.`
  );
}

async function readVersionFiles() {
  const packageJson = await readJson(paths.packageJson);
  const packageLock = await readJson(paths.packageLock);
  const tauriConfig = await readJson(paths.tauriConfig);
  const cargoToml = await readFile(paths.cargoToml, "utf8");
  const appVersion = await readFile(paths.appVersion, "utf8");

  return {
    packageJson,
    packageLock,
    tauriConfig,
    cargoToml,
    appVersion,
  };
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

function verifyVersionConsistency(files, expectedVersion) {
  const cargoVersion = /^version = "(\d+\.\d+\.\d+)"$/m.exec(
    files.cargoToml
  )?.[1];
  const appVersion = /: "(\d+\.\d+\.\d+)";\n\}/.exec(
    files.appVersion
  )?.[1];
  const versions = [
    files.packageJson.version,
    files.packageLock.version,
    files.packageLock.packages?.[""]?.version,
    files.tauriConfig.version,
    cargoVersion,
    appVersion,
  ];

  if (versions.some((version) => version !== expectedVersion)) {
    throw new Error(
      `Version consistency check failed. Expected every file to use ${expectedVersion}.`
    );
  }
}

async function writeNextFiles(files) {
  await writeJson(paths.packageJson, files.packageJson);
  await writeJson(paths.packageLock, files.packageLock);
  await writeJson(paths.tauriConfig, files.tauriConfig);
  await writeFile(paths.cargoToml, files.cargoToml);
  await writeFile(paths.appVersion, files.appVersion);
}

function syncCargoLockfile() {
  execFileSync(
    "cargo",
    ["update", "--workspace", "--offline", "--manifest-path", paths.cargoToml],
    {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function currentBranch() {
  const branch = git(["branch", "--show-current"]).trim();
  if (!branch) {
    throw new Error("Release must run on a named Git branch.");
  }
  return branch;
}

function ensureCleanWorktree() {
  const status = git(["status", "--porcelain"]);
  if (status.trim()) {
    throw new Error(
      "Release requires a clean worktree. Commit or stash existing changes first."
    );
  }
}

function ensureOriginExists() {
  git(["remote", "get-url", "origin"]);
}

function pushReleaseTag(version, { force = false } = {}) {
  const tag = formatReleaseTag(version);
  if (force) {
    git(["tag", "-f", tag]);
  } else {
    git(["tag", tag]);
  }
  const pushArgs = ["push", "origin", tag];
  if (force) {
    pushArgs.push("--force");
  }
  git(pushArgs);
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
