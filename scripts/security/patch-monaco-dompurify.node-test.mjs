import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";

const root = new URL("../../", import.meta.url);
const scriptPath = "scripts/security/patch-monaco-dompurify.mjs";
const monacoPath =
  "node_modules/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js";
const sourcePath = "node_modules/dompurify/dist/purify.es.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "db-connect-sanitizer-"));
  for (const file of [
    scriptPath,
    monacoPath,
    sourcePath,
    "node_modules/monaco-editor/package.json",
    "node_modules/dompurify/package.json",
  ]) {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await copyFile(new URL(file, root), join(directory, file));
  }
  return directory;
}

function run(directory) {
  return spawnSync(process.execPath, [join(directory, scriptPath)], {
    encoding: "utf8",
  });
}

test("重复准备不会改变已应用的独立清洗模块", async () => {
  const directory = await fixture();
  try {
    const installed = await readFile(join(directory, monacoPath), "utf8");
    assert.equal(run(directory).status, 0);
    assert.equal(run(directory).status, 0);
    assert.equal(
      await readFile(join(directory, monacoPath), "utf8"),
      installed
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("拒绝静默覆盖未知 Monaco 清洗器源码", async () => {
  const directory = await fixture();
  try {
    await writeFile(join(directory, monacoPath), "unknown source");
    const result = run(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /拒绝覆盖未知源码/);
    assert.equal(
      await readFile(join(directory, monacoPath), "utf8"),
      "unknown source"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("依赖升级改变嵌入契约时要求重新审查补丁", async () => {
  const directory = await fixture();
  try {
    await writeFile(
      join(directory, "node_modules/monaco-editor/package.json"),
      JSON.stringify({ version: "0.57.0" })
    );
    const result = run(directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /版本改变，请重新审查/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
