import type { SqlSchema } from "./sqlCompletion";
import type {
  SqlCompletionCacheKey,
  SqlMetadataIndex,
} from "./sqlCompletionTypes";
import { buildSqlMetadataIndex } from "./sqlCompletionMetadataIndex";
import type { SqlCompletionInvalidation } from "./sqlCompletionInvalidation";

const TTL_MS = 60_000;
const MAX_COMPLETED_ENTRIES = 8;

function cacheId(key: SqlCompletionCacheKey): string {
  return JSON.stringify([
    key.connId,
    key.database,
    key.dialect,
    key.connectionRevision,
  ]);
}

export function createSqlCompletionCache(
  loader: (key: SqlCompletionCacheKey) => Promise<SqlSchema>,
  now: () => number = Date.now
): {
  get(key: SqlCompletionCacheKey): Promise<SqlMetadataIndex>;
  peek(key: SqlCompletionCacheKey): SqlMetadataIndex | undefined;
  invalidate(event: SqlCompletionInvalidation): void;
} {
  const generations = new Map<string, number>();
  const keys = new Map<string, SqlCompletionCacheKey>();
  const completed = new Map<
    string,
    { index: SqlMetadataIndex; expiresAt: number }
  >();
  const inFlight = new Map<string, Promise<SqlMetadataIndex>>();

  function readCompleted(id: string): SqlMetadataIndex | undefined {
    const entry = completed.get(id);
    if (!entry) return undefined;
    if (now() >= entry.expiresAt) {
      completed.delete(id);
      return undefined;
    }
    // Map 的插入顺序就是最近访问顺序。
    completed.delete(id);
    completed.set(id, entry);
    return entry.index;
  }

  return {
    get(key) {
      const id = cacheId(key);
      const cached = readCompleted(id);
      if (cached) return Promise.resolve(cached);
      const pending = inFlight.get(id);
      if (pending) return pending;

      keys.set(id, key);
      const generation = generations.get(id) ?? 0;
      generations.set(id, generation);
      const request = Promise.resolve()
        .then(() => loader(key))
        .then((schema) => {
          const index = buildSqlMetadataIndex(schema, key);
          if (
            generations.get(id) === generation &&
            inFlight.get(id) === request
          ) {
            completed.set(id, { index, expiresAt: now() + TTL_MS });
            while (completed.size > MAX_COMPLETED_ENTRIES) {
              const oldest = completed.keys().next().value;
              if (oldest === undefined) break;
              completed.delete(oldest);
            }
          }
          return index;
        })
        .finally(() => {
          if (inFlight.get(id) === request) inFlight.delete(id);
        });
      inFlight.set(id, request);
      return request;
    },
    peek(key) {
      return readCompleted(cacheId(key));
    },
    invalidate(event) {
      for (const [id, key] of keys) {
        if (key.connId !== event.connId) continue;
        if (
          event.reason !== "disconnect" &&
          event.database !== undefined &&
          key.database !== event.database
        )
          continue;
        generations.set(id, (generations.get(id) ?? 0) + 1);
        completed.delete(id);
        inFlight.delete(id);
      }
    },
  };
}
