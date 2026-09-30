export type ResultCacheKey = string;
export interface ResultCacheRegistration {
  key: ResultCacheKey;
  estimatedBytes: number;
  /** 只捕获拥有方身份；不得捕获原始行。 */
  evict: () => void;
}
export interface ResultCacheController {
  track(entry: ResultCacheRegistration): void;
  transfer(key: ResultCacheKey, evict: () => void): boolean;
  touch(key: ResultCacheKey): void;
  pin(key: ResultCacheKey): () => void;
  remove(key: ResultCacheKey): void;
  enforce(): { retainedBytes: number; overBudget: boolean };
}
export const RESULT_CACHE_BUDGET_BYTES = 128 * 1024 * 1024;

export function createResultCacheController(
  budgetBytes: number
): ResultCacheController {
  const entries = new Map<string, ResultCacheRegistration>();
  const leases = new Map<string, Set<object>>();
  let retainedBytes = 0;
  let enforcing = false;
  const enforce = () => {
    if (!enforcing) {
      enforcing = true;
      try {
        for (const [key, entry] of entries) {
          if (retainedBytes <= budgetBytes) break;
          if (leases.get(key)?.size) continue;
          entries.delete(key);
          retainedBytes -= entry.estimatedBytes;
          entry.evict();
        }
      } finally {
        enforcing = false;
      }
    }
    return { retainedBytes, overBudget: retainedBytes > budgetBytes };
  };
  return {
    track(entry) {
      const old = entries.get(entry.key);
      retainedBytes += entry.estimatedBytes - (old?.estimatedBytes ?? 0);
      entries.set(entry.key, entry);
      enforce();
    },
    transfer(key, evict) {
      const entry = entries.get(key);
      if (!entry) return false;
      entries.set(key, { ...entry, evict });
      return true;
    },
    touch(key) {
      const entry = entries.get(key);
      if (entry) {
        entries.delete(key);
        entries.set(key, entry);
      }
    },
    pin(key) {
      const token = {};
      const tokens = leases.get(key) ?? new Set<object>();
      leases.set(key, tokens);
      tokens.add(token);
      return () => {
        if (!tokens.delete(token)) return;
        if (tokens.size === 0 && leases.get(key) === tokens) leases.delete(key);
        enforce();
      };
    },
    remove(key) {
      const entry = entries.get(key);
      if (entry) retainedBytes -= entry.estimatedBytes;
      entries.delete(key);
      leases.delete(key);
    },
    enforce,
  };
}

/** JSON UTF-8 大小的软预算估算；逐个字符计数，不分配整份 JSON 字符串。 */
function stringBytes(value: string): number {
  let bytes = 2;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (
      c === 34 ||
      c === 92 ||
      c === 8 ||
      c === 9 ||
      c === 10 ||
      c === 12 ||
      c === 13
    )
      bytes += 2;
    else if (c < 32) bytes += 6;
    else if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      value.charCodeAt(i + 1) >= 0xdc00 &&
      value.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i++;
    } else if (c >= 0xd800 && c <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}
function valueBytes(value: unknown): number {
  if (value == null) return 4;
  if (typeof value === "string") return stringBytes(value);
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value).length : 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (Array.isArray(value))
    return value.reduce<number>(
      (n, v) => n + valueBytes(v),
      2 + Math.max(0, value.length - 1)
    );
  if (typeof value === "object") {
    let bytes = 2,
      count = 0;
    for (const [key, v] of Object.entries(value)) {
      if (v === undefined) continue;
      bytes += stringBytes(key) + 1 + valueBytes(v) + (count++ ? 1 : 0);
    }
    return bytes;
  }
  return 4;
}
export function estimateResultBytes(
  columns: readonly string[],
  rows: readonly unknown[][]
): number {
  return valueBytes(columns) + valueBytes(rows);
}
export const resultCacheController = createResultCacheController(
  RESULT_CACHE_BUDGET_BYTES
);
