export type SqlCompletionInvalidation = {
  connId: string;
  database?: string | null;
  reason: "schema-change" | "refresh" | "disconnect";
};

type Listener = (event: SqlCompletionInvalidation) => void;

const listeners = new Set<Listener>();
const connectionRevisions = new Map<string, number>();

type MetadataRevision = {
  connection: number;
  any: number;
  databases: Map<string, number>;
};
const metadataRevisions = new Map<string, MetadataRevision>();

/** 仅维护代次；目录结果仍由连接 store 持有。 */
export function invalidateMetadataRequestScope(
  connId: string,
  database?: string
): void {
  const revision = metadataRevisions.get(connId) ?? {
    connection: 0,
    any: 0,
    databases: new Map<string, number>(),
  };
  revision.any++;
  if (database === undefined) {
    revision.connection++;
    revision.databases.clear();
  } else {
    revision.databases.set(
      database,
      (revision.databases.get(database) ?? 0) + 1
    );
  }
  metadataRevisions.set(connId, revision);
}

/** 未指定数据库时捕捉整个连接；指定集合时只受交集失效影响。 */
export function getMetadataRequestGeneration(
  connId: string,
  databases?: readonly string[]
): string {
  const revision = metadataRevisions.get(connId);
  return JSON.stringify(
    databases === undefined
      ? [revision?.connection ?? 0, revision?.any ?? 0]
      : [
          revision?.connection ?? 0,
          databases.map((database) => revision?.databases.get(database) ?? 0),
        ]
  );
}

export function invalidateSqlCompletion(
  event: SqlCompletionInvalidation
): void {
  invalidateMetadataRequestScope(event.connId, event.database ?? undefined);
  if (event.reason === "disconnect") {
    connectionRevisions.set(
      event.connId,
      getSqlCompletionConnectionRevision(event.connId) + 1
    );
  }
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("SQL 补全元数据失效通知失败:", error);
    }
  }
}

export function subscribeSqlCompletionInvalidation(
  listener: Listener
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getSqlCompletionConnectionRevision(connId: string): number {
  return connectionRevisions.get(connId) ?? 0;
}
