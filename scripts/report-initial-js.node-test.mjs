import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("初始资源去重并递归静态依赖，动态闭包单独计量", async () => {
  const directory = await mkdtemp(join(tmpdir(), "initial-js-"));
  try {
    await mkdir(join(directory, ".vite"));
    await mkdir(join(directory, "assets"));
    await writeFile(
      join(directory, "index.html"),
      `
      <script type="module" src="/assets/main.js"></script>
      <link rel="modulepreload" href="./assets/shared.js">
      <link href="/assets/shared.js?v=1" rel="modulepreload">
      <script src="https://example.invalid/external.js" type="module"></script>
      <script src="ignored.js"></script>
      <link rel="stylesheet" href="assets/style.css">
    `
    );
    const manifest = {
      "index.html": {
        file: "assets/main.js",
        isEntry: true,
        imports: ["shared"],
        dynamicImports: ["feature"],
      },
      shared: { file: "assets/shared.js", imports: ["deep"] },
      deep: { file: "assets/deep.js", imports: ["shared"] },
      feature: {
        file: "assets/feature.js",
        imports: ["shared", "dynamicDependency"],
        dynamicImports: ["nested"],
      },
      dynamicDependency: { file: "assets/dependency.js" },
      nested: { file: "assets/nested.js" },
    };
    await writeFile(
      join(directory, ".vite/manifest.json"),
      JSON.stringify(manifest)
    );
    for (const [name, size] of Object.entries({
      main: 10,
      shared: 20,
      deep: 30,
      feature: 40,
      dependency: 50,
      nested: 60,
    })) {
      await writeFile(join(directory, `assets/${name}.js`), "x".repeat(size));
    }
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["scripts/report-initial-js.mjs", directory, "--json"],
        { encoding: "utf8" }
      )
    );
    assert.equal(result.htmlReferencedBytes, 30);
    assert.equal(result.initialStaticBytes, 60);
    assert.equal(result.dynamicJsBytes, 150);
    assert.deepEqual(
      result.files.htmlReferenced.map((f) => f.path),
      ["assets/main.js", "assets/shared.js"]
    );
    assert.deepEqual(
      result.files.initialStatic.map((f) => f.path),
      ["assets/deep.js", "assets/main.js", "assets/shared.js"]
    );
    assert.deepEqual(
      result.files.dynamicJs.map((f) => f.path),
      ["assets/dependency.js", "assets/feature.js", "assets/nested.js"]
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
