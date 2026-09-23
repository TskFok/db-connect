import type { SqlCompletionForeignKeyResult } from "../types";
import type { SqlCompletionCacheKey } from "./sqlCompletionTypes";
import type { SqlCompletionInvalidation } from "./sqlCompletionInvalidation";

const TTL_MS = 60_000;
const MAX_COMPLETED_ENTRIES = 8;

/** 外键可能跨 schema，因此结构变更会清理整个连接的关系快照。 */
export function affectsSqlCompletionForeignKeys(
  event: SqlCompletionInvalidation,
  key: SqlCompletionCacheKey
): boolean {
  return (
    event.connId === key.connId &&
    (event.reason === "schema-change" ||
      event.reason === "disconnect" ||
      event.database === undefined ||
      event.database === key.database)
  );
}

export function createSqlCompletionForeignKeyCache(
  source: {
    getSqlCompletionForeignKeys(
      connId: string,
      database: string | null
    ): Promise<SqlCompletionForeignKeyResult>;
  },
  now: () => number = Date.now
) {
  type Entry = {
    key: SqlCompletionCacheKey;
    result?: SqlCompletionForeignKeyResult;
    expiresAt?: number;
    pending?: Promise<SqlCompletionForeignKeyResult>;
  };
  const entries = new Map<string, Entry>();
  const completed = new Map<string, Entry>();
  const cacheId = (key: SqlCompletionCacheKey) =>
    JSON.stringify([
      key.connId,
      key.database,
      key.dialect,
      key.connectionRevision,
    ]);

  function peek(key: SqlCompletionCacheKey) {
    const id = cacheId(key);
    const entry = completed.get(id);
    if (!entry) return undefined;
    if (now() >= entry.expiresAt!) {
      completed.delete(id);
      if (entries.get(id) === entry) entries.delete(id);
      return undefined;
    }
    completed.delete(id);
    completed.set(id, entry);
    return entry.result;
  }

  return {
    peek,
    get(key: SqlCompletionCacheKey): Promise<SqlCompletionForeignKeyResult> {
      const id = cacheId(key);
      const cached = peek(key);
      if (cached) return Promise.resolve(cached);
      const pending = entries.get(id)?.pending;
      if (pending) return pending;
      // entry 身份充当代数，失效/淘汰后旧请求无法复活条目。
      const entry: Entry = { key };
      entries.set(id, entry);
      let load: Promise<SqlCompletionForeignKeyResult>;
      try {
        load = source.getSqlCompletionForeignKeys(key.connId, key.database);
      } catch (error) {
        load = Promise.reject(error);
      }
      const request = load
        .then((result) => {
          if (entries.get(id) === entry) {
            entry.result = result;
            entry.expiresAt = now() + TTL_MS;
            completed.set(id, entry);
            while (completed.size > MAX_COMPLETED_ENTRIES) {
              const oldest = completed.keys().next().value!;
              completed.delete(oldest);
              entries.delete(oldest);
            }
          }
          return result;
        })
        .finally(() => {
          if (entries.get(id) === entry) {
            entry.pending = undefined;
            if (!entry.result) entries.delete(id);
          }
        });
      entry.pending = request;
      return request;
    },
    invalidate(event: SqlCompletionInvalidation) {
      for (const [id, entry] of entries) {
        if (!affectsSqlCompletionForeignKeys(event, entry.key)) continue;
        entries.delete(id);
        completed.delete(id);
      }
    },
  };
}
