import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(rootDir, ".github", "release-drafter.yml");
const workflowPath = join(rootDir, ".github", "workflows", "release-drafter.yml");
const releaseWorkflowPath = join(rootDir, ".github", "workflows", "release.yml");

const COMMIT_TYPES = [
  "feat",
  "fix",
  "refactor",
  "chore",
  "ci",
  "build",
  "docs",
  "test",
];

test("release-drafter.yml parses and covers all commit types", () => {
  execFileSync("ruby", [
    "-e",
    "require 'yaml'; YAML.load_file(ARGV[0]); puts 'ok'",
    configPath,
  ]);

  const config = readFileSync(configPath, "utf8");

  for (const type of COMMIT_TYPES) {
    assert.match(config, new RegExp(`label: "${type}"`));
    assert.match(config, new RegExp(`label: "${type}"`, "g"));
    assert.match(config, new RegExp(`'/\\^${type}`));
  }

  assert.match(config, /skip-changelog/);
  assert.match(config, /多平台安装包见本 Release 附件/);
});

test("release-drafter workflow uses v7 actions", () => {
  const workflow = readFileSync(workflowPath, "utf8");

  assert.match(workflow, /release-drafter\/release-drafter@v7/);
  assert.match(workflow, /release-drafter\/release-drafter\/autolabeler@v7/);
  assert.match(workflow, /branches: \[master, main\]/);
});

test("release workflow publishes notes via Release Drafter", () => {
  const workflow = readFileSync(releaseWorkflowPath, "utf8");

  assert.match(workflow, /release-notes:/);
  assert.match(workflow, /publish: true/);
  assert.match(workflow, /node scripts\/release-notes\.mjs/);
  assert.match(workflow, /gh release edit/);
  assert.match(workflow, /generateReleaseNotes: false/);
  assert.doesNotMatch(workflow, /releaseBody:/);
});
