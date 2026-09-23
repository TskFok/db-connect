import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import * as api from "../services/tauriCommands";
import { createSqlCompletionCache } from "../utils/sqlCompletionCache";
import {
  getSqlCompletionConnectionRevision,
  subscribeSqlCompletionInvalidation,
} from "../utils/sqlCompletionInvalidation";
import { buildSqlMetadataIndex } from "../utils/sqlCompletionMetadataIndex";
import { loadSqlCompletionSchema } from "../utils/sqlCompletionSchema";
import { sqlCompletionKeyId, type SqlDialect } from "../utils/sqlCompletion";
import type { SqlCompletionCacheKey } from "../utils/sqlCompletionTypes";

const cache = createSqlCompletionCache((key) =>
  loadSqlCompletionSchema(api, key.connId, key.database, key.dialect)
);
// 模块级唯一订阅先清缓存，再由各编辑器更新自己的绑定。
const unsubscribe = subscribeSqlCompletionInvalidation((event) =>
  cache.invalidate(event)
);
if (import.meta.hot) import.meta.hot.dispose(unsubscribe);

/** 只为当前 key 预取；切换时同步返回新 key 的安全快照。 */
export function useSqlCompletionMetadata(
  connId: string,
  database: string | null,
  dialect: SqlDialect
) {
  const [revision, bumpRevision] = useReducer((n: number) => n + 1, 0);
  const [, renderSnapshot] = useReducer((n: number) => n + 1, 0);
  const connectionRevision = getSqlCompletionConnectionRevision(connId);
  const key = useMemo<SqlCompletionCacheKey>(
    () => ({
      connId,
      database: connId ? database : null,
      dialect,
      connectionRevision,
    }),
    [connId, database, dialect, connectionRevision]
  );
  const keyId = sqlCompletionKeyId(key);
  const empty = useMemo(
    () =>
      buildSqlMetadataIndex({ databases: [], tables: [], columns: [] }, key),
    [key]
  );
  const active = useRef({ keyId, revision, mounted: true });
  active.current = { keyId, revision, mounted: true };
  const pending = useRef<{
    id: string;
    revision: number;
    promise: Promise<boolean>;
  }>();
  const failure = useRef<{ id: string; until: number }>();
  const requestRefresh = useCallback((): Promise<boolean> => {
    if (!key.connId || cache.peek(key)) return Promise.resolve(false);
    if (pending.current?.id === keyId && pending.current.revision === revision)
      return pending.current.promise;
    if (failure.current?.id === keyId && failure.current.until > Date.now())
      return Promise.resolve(false);
    const isCurrent = () =>
      active.current.mounted &&
      active.current.keyId === keyId &&
      active.current.revision === revision;
    const promise = cache
      .get(key)
      .then(
        () => {
          if (!isCurrent()) return false;
          renderSnapshot();
          return !!cache.peek(key);
        },
        () => {
          if (isCurrent()) {
            // 失败不弹提示，短暂退避避免每次按键重发同一个请求。
            failure.current = { id: keyId, until: Date.now() + 5_000 };
            renderSnapshot();
          }
          return false;
        }
      )
      .finally(() => {
        if (pending.current?.promise === promise) pending.current = undefined;
      });
    pending.current = { id: keyId, revision, promise };
    return promise;
  }, [key, keyId, revision]);

  useEffect(() => {
    const stop = subscribeSqlCompletionInvalidation((event) => {
      if (
        event.connId !== key.connId ||
        (event.database !== undefined && event.database !== key.database)
      )
        return;
      failure.current = undefined;
      // 同一事件回调期间即使旧请求完成也不能更新 UI。
      active.current.revision++;
      bumpRevision();
    });
    return stop;
  }, [key]);
  useEffect(() => {
    active.current.mounted = true;
    void requestRefresh();
    return () => {
      active.current.mounted = false;
    };
  }, [requestRefresh]);

  return useMemo(
    () => ({
      key,
      revision,
      // getter 在 Monaco 回调中始终读取同 key 的最新缓存，包括 TTL 与显式失效。
      get index() {
        return cache.peek(key) ?? empty;
      },
      requestRefresh,
    }),
    [key, revision, empty, requestRefresh]
  );
}
