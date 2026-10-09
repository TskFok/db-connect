import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** 去重后的未压缩产物字节；不代表下载量、冷启动时间或进程内存。 */
export async function reportInitialJs(directory) {
  const root = resolve(directory);
  const html = await readFile(resolve(root, "index.html"), "utf8");
  const manifest = JSON.parse(
    await readFile(resolve(root, ".vite/manifest.json"), "utf8")
  );
  const byFile = new Map(
    Object.entries(manifest).map(([key, value]) => [value.file, key])
  );
  const htmlFiles = new Set();
  for (const tag of html.matchAll(/<(script|link)\b([^>]*)>/gi)) {
    const attributes = new Map(
      [
        ...tag[2].matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g),
      ].map((match) => [
        match[1].toLowerCase(),
        match[2] ?? match[3] ?? match[4],
      ])
    );
    const isScript = tag[1].toLowerCase() === "script";
    if (
      isScript
        ? attributes.get("type") !== "module"
        : attributes.get("rel") !== "modulepreload"
    )
      continue;
    const url = attributes.get(isScript ? "src" : "href");
    if (!url || /^(?:[a-z]+:)?\/\//i.test(url) || /^[a-z]+:/i.test(url))
      continue;
    const file = decodeURIComponent(url.split(/[?#]/)[0]).replace(
      /^\/?(?:\.\/)?/,
      ""
    );
    if (/\.(?:m?js)$/.test(file)) htmlFiles.add(file);
  }
  const initial = new Set(htmlFiles);
  const initialKeys = new Set();
  const visitStatic = (key, files, visited) => {
    if (visited.has(key)) return;
    const chunk = manifest[key];
    if (!chunk) throw new Error(`manifest 中缺少依赖：${key}`);
    visited.add(key);
    if (/\.(?:m?js)$/.test(chunk.file)) files.add(chunk.file);
    for (const dependency of chunk.imports ?? [])
      visitStatic(dependency, files, visited);
  };
  for (const file of htmlFiles) {
    const key = byFile.get(file);
    if (key) visitStatic(key, initial, initialKeys);
  }
  const dynamic = new Set();
  const reachable = new Set(initialKeys);
  // 动态入口及其静态/动态依赖递归可达；共享初始文件只在初始集合中计数。
  const pending = [...initialKeys];
  for (let i = 0; i < pending.length; i++) {
    const chunk = manifest[pending[i]];
    for (const key of [
      ...(chunk.imports ?? []),
      ...(chunk.dynamicImports ?? []),
    ]) {
      if (reachable.has(key)) continue;
      const dependency = manifest[key];
      if (!dependency) throw new Error(`manifest 中缺少依赖：${key}`);
      reachable.add(key);
      pending.push(key);
      if (/\.(?:m?js)$/.test(dependency.file) && !initial.has(dependency.file))
        dynamic.add(dependency.file);
    }
  }
  const details = async (files) =>
    Promise.all(
      [...files].sort().map(async (file) => {
        const absolute = resolve(root, file);
        if (!absolute.startsWith(root + sep))
          throw new Error(`资源路径超出构建目录：${file}`);
        return { path: file, bytes: (await stat(absolute)).size };
      })
    );
  const [htmlReferenced, initialStatic, dynamicJs] = await Promise.all([
    details(htmlFiles),
    details(initial),
    details(dynamic),
  ]);
  const sum = (files) => files.reduce((total, file) => total + file.bytes, 0);
  return {
    htmlReferencedBytes: sum(htmlReferenced),
    initialStaticBytes: sum(initialStatic),
    dynamicJsBytes: sum(dynamicJs),
    files: { htmlReferenced, initialStatic, dynamicJs },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const result = await reportInitialJs(process.argv[2] ?? "dist");
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(
      `HTML 引用 JS：${result.htmlReferencedBytes} bytes\n初始静态闭包：${result.initialStaticBytes} bytes\n按需 JS：${result.dynamicJsBytes} bytes\n`
    );
    for (const [group, files] of Object.entries(result.files)) {
      process.stdout.write(
        `${group}\n${files.map((file) => `  ${file.path}: ${file.bytes}`).join("\n")}\n`
      );
    }
  }
}
