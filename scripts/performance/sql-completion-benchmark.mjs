import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rolldown } from "rolldown";

// 对比同一机器上的真实解析链；旧源码只读 git show，无数据库/IPC/依赖安装。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const option = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at < 0 ? fallback : process.argv[at + 1];
};
const ref = option("--ref", "working-tree");
const scratch = mkdtempSync(join(tmpdir(), "db-connect-sql-completion-"));
const output = resolve(option("--output", join(scratch, "result.json")));
let incremental = true;
if (ref !== "working-tree") {
  execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
    cwd: root,
  });
  try {
    execFileSync(
      "git",
      ["cat-file", "-e", `${ref}:src/utils/sqlCompletionDocumentCache.ts`],
      { cwd: root, stdio: "ignore" }
    );
  } catch {
    incremental = false;
  }
}
const entry = join(root, "src/__sql_completion_benchmark_virtual__.ts");
const bundle = join(scratch, "completion.mjs");
const build = await rolldown({
  input: entry,
  platform: "node",
  plugins: [
    {
      name: "sql-completion-production-chain",
      resolveId(source) {
        if (source === entry) return entry;
      },
      load(id) {
        if (id === entry)
          return `
        export { analyzeSqlCompletion${incremental ? ", analyzeSqlCompletionTokens" : ""} } from "./utils/sqlCompletionContext";
        export { resolveSqlCompletionScopes } from "./utils/sqlCompletionScopes";
        export { generateSqlCompletionCandidates } from "./utils/sqlCompletionCandidates";
        export { buildSqlMetadataIndex } from "./utils/sqlCompletionMetadataIndex";
        export { completionDocument, completionLargeSchema, documentSizes } from "./__tests__/fixtures/sqlCompletionDocumentFixtures";
        ${incremental ? 'export { createSqlCompletionDocumentCache } from "./utils/sqlCompletionDocumentCache";' : ""}
      `;
        if (ref !== "working-tree" && id.startsWith(join(root, "src/utils/"))) {
          return execFileSync("git", ["show", `${ref}:${relative(root, id)}`], {
            cwd: root,
            encoding: "utf8",
          });
        }
        if (id.startsWith(join(root, "src/"))) return readFileSync(id, "utf8");
      },
    },
  ],
});
await build.write({ file: bundle, format: "esm" });
await build.close();
const api = await import(pathToFileURL(bundle).href);
const key = {
  connId: "synthetic-benchmark",
  database: "app",
  dialect: "mysql",
  connectionRevision: 0,
};
const index = api.buildSqlMetadataIndex(api.completionLargeSchema(), key);
const create = (sql) =>
  incremental
    ? api.createSqlCompletionDocumentCache(sql, 1, key.dialect)
    : null;
let count = 0;
const complete = (cache, sql) => {
  const offset = sql.length;
  const syntax = cache?.getStatement(offset);
  const context = syntax
    ? api.analyzeSqlCompletionTokens({
        ...syntax,
        offset,
        dialect: key.dialect,
      })
    : api.analyzeSqlCompletion({ sql, offset, dialect: key.dialect });
  const scoped = api.resolveSqlCompletionScopes({
    ...(syntax ? { syntax } : { sql }),
    offset,
    context,
    index,
  });
  const candidates = api.generateSqlCompletionCandidates(scoped, index);
  count = candidates.length;
  assert.equal(count, 50);
};
const measure = (run) => {
  for (let i = 0; i < 5; i++) run();
  const durations = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    run();
    durations.push(performance.now() - start);
  }
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    p50: sorted[9],
    p95: sorted[18],
    min: sorted[0],
    max: sorted[19],
    durations,
  };
};
const measurements = [];
for (const size of api.documentSizes) {
  let sql = api.completionDocument(size);
  const cold = measure(() => {
    const cache = create(sql);
    complete(cache, sql);
    cache?.dispose();
  });
  const cache = create(sql);
  const hot = measure(() => complete(cache, sql));
  let version = 1;
  let appended = false;
  const edit = measure(() => {
    const text = appended ? "" : "u";
    if (cache)
      assert.equal(
        cache.applyChanges(
          [{ rangeOffset: size, rangeLength: appended ? 1 : 0, text }],
          ++version
        ),
        true
      );
    sql = sql.slice(0, size) + text;
    appended = !appended;
    complete(cache, sql);
  });
  cache?.dispose();
  measurements.push({ bytes: size, candidates: count, cold, hot, edit });
}
writeFileSync(
  output,
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      ref,
      incremental,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      warmups: 5,
      samples: 20,
      forcedGc: false,
      scope:
        "真实补全计算链；预建1000表/50000列索引；冷组包含文档初始化，编辑组包含缓存更新；不含Monaco/WebView/IPC/数据库",
      memory: process.memoryUsage(),
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      measurements,
    },
    null,
    2
  ) + "\n"
);
console.table(
  measurements.map(({ bytes, cold, hot, edit }) => ({
    bytes,
    coldP50: cold.p50,
    coldP95: cold.p95,
    hotP50: hot.p50,
    hotP95: hot.p95,
    editP50: edit.p50,
    editP95: edit.p95,
  }))
);
console.log(output);
