export type SqlCompletionInvalidation = {
  connId: string;
  database?: string | null;
  reason: "schema-change" | "refresh" | "disconnect";
};

type Listener = (event: SqlCompletionInvalidation) => void;

const listeners = new Set<Listener>();
const connectionRevisions = new Map<string, number>();

export function invalidateSqlCompletion(
  event: SqlCompletionInvalidation
): void {
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
