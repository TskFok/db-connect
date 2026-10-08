// Run explicitly with: node --expose-gc scripts/performance/sql-completion-cache-memory.mjs
// This regression needs full GC, so it intentionally runs outside Vitest.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rolldown } from "rolldown";

assert.equal(typeof globalThis.gc, "function", "Run Node with --expose-gc");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scratch = mkdtempSync(join(tmpdir(), "sql-completion-cache-memory-"));
try {
  const bundle = join(scratch, "cache.mjs");
  const build = await rolldown({
    input: join(root, "src/utils/sqlCompletionDocumentCache.ts"),
    platform: "node",
  });
  await build.write({ file: bundle, format: "esm" });
  await build.close();
  const { createSqlCompletionDocumentCache: create } = await import(
    pathToFileURL(bundle).href
  );
  const statement = "SELECT abcdefghijklmnopqrstuvwxyz FROM historical_tbl;";
  const rows = 19783;
  const readings = [];
  function heap(label) {
    for (let i = 0; i < 5; i++) globalThis.gc();
    const bytes = process.memoryUsage().heapUsed;
    readings.push({
      label,
      bytes,
      mib: Math.round((bytes / 1048576) * 100) / 100,
    });
    return bytes;
  }
  const before = heap("before");
  const cache = create(statement.repeat(rows), 1, "postgres");
  const created = heap("created");
  for (let n = 0; n < 400; n++) {
    assert.ok(
      cache.applyChanges(
        [
          {
            rangeOffset: n * statement.length + 7,
            rangeLength: 26,
            text: "bcdefghijklmnopqrstuvwxyza",
          },
        ],
        n + 2
      )
    );
    // Retain only cache-owned syntax, not returned snapshots or old source text.
    if ((n + 1) % 100 === 0) heap(`edits ${n + 1}`);
  }
  const settled = heap("400 settled");
  cache.dispose();
  const disposed = heap("disposed");
  console.log(
    JSON.stringify(
      {
        node: process.version,
        v8: process.versions.v8,
        length: statement.length * rows,
        edits: 400,
        readings,
      },
      null,
      2
    )
  );
  // Wide allowance for runtime bookkeeping; a retained source per edit adds
  // roughly 408 MiB. Assertions target retention, not timing or absolute heap.
  assert.ok(
    settled - created < 16 * 1048576,
    "Old document versions remain retained after editing"
  );
  assert.ok(
    disposed - before < 8 * 1048576,
    "Disposed cache still retains its syntax storage"
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
