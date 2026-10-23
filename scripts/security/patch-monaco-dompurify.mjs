import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { URL } from "node:url";

const root = new URL("../../", import.meta.url);
const monacoPath = new URL(
  "node_modules/monaco-editor/esm/vs/base/browser/dompurify/dompurify.js",
  root
);
const upstreamPath = new URL("node_modules/dompurify/dist/purify.es.mjs", root);
const monacoPackage = JSON.parse(
  await readFile(
    new URL("node_modules/monaco-editor/package.json", root),
    "utf8"
  )
);
const purifyPackage = JSON.parse(
  await readFile(new URL("node_modules/dompurify/package.json", root), "utf8")
);

// Monaco 0.55.1 内嵌 DOMPurify 3.2.7，不受 npm overrides 影响。
// 整份替换 ESM 入口，保留上游许可证及独立实例，避免与 Mermaid 共享 hooks。
// 更新版本时必须重新审查嵌入路径、原始文件哈希和清洗回归测试。
const originalHash =
  "9b2835fc7de5bd37faff156e83bf060067577a1f09c6620d9f37d5fa5e5970b1";
if (monacoPackage.version !== "0.55.1" || purifyPackage.version !== "3.4.17") {
  throw new Error("Monaco / DOMPurify 版本改变，请重新审查内嵌清洗器安全补丁");
}

const [installed, upstream] = await Promise.all([
  readFile(monacoPath, "utf8"),
  readFile(upstreamPath, "utf8"),
]);
// 原 source map 不位于 Monaco 目录，移除该注释，保留源代码及许可证原文。
const replacement = upstream.replace(/^\/\/# sourceMappingURL=.*$/m, "");
if (installed !== replacement) {
  const installedHash = createHash("sha256").update(installed).digest("hex");
  if (installedHash !== originalHash) {
    throw new Error("Monaco 内嵌 DOMPurify 内容不符合预期，拒绝覆盖未知源码");
  }
  await writeFile(monacoPath, replacement);
  console.log("已将 Monaco ESM 内嵌 DOMPurify 更新为 3.4.17（独立实例）");
}
