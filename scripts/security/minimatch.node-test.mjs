import assert from "node:assert/strict";
import { test } from "node:test";
import { Minimatch } from "minimatch";

test("minimatch 限制 **/.. 优化产生的模式数量（GHSA-g3hv-75wg-m249）", () => {
  assert.throws(
    () =>
      new Minimatch("**/../a/b/".repeat(6) + "file", {
        optimizationLevel: 2,
        braceExpandMax: 16,
      }),
    { name: "RangeError", message: /too many patterns/ }
  );
});

test("minimatch 保留 ESLint 和归档使用的常规路径匹配", () => {
  const sources = new Minimatch("**/*.{ts,tsx}");
  assert.equal(sources.match("src/components/SqlEditor.tsx"), true);
  assert.equal(sources.match("src/styles/app.css"), false);
  assert.equal(sources.match("node_modules/.cache/file.ts"), false);
  const files = new Minimatch("**/*", { dot: true });
  assert.equal(files.match("export/.metadata.json"), true);
});
