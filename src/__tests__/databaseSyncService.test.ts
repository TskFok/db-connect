import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { executeDatabaseSync } from "../services/databaseSync";
import { useConnectionStore } from "../stores/connectionStore";
import type {
  ActiveConnection,
  DatabaseSyncExecutionResult,
  DatabaseSyncExecutionStatus,
  ExecuteDatabaseSyncRequest,
} from "../types";
import {
  subscribeSqlCompletionInvalidation,
  type SqlCompletionInvalidation,
} from "../utils/sqlCompletionInvalidation";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockInvoke = vi.mocked(invoke);
const input: ExecuteDatabaseSyncRequest = {
  request: {
    source: { saved_connection_id: "src", database: "from" },
    target: { saved_connection_id: "dst", database: "to" },
    selected_tables: ["users"],
    include_drops: false,
  },
  plan_fingerprint: "test",
};

function connection(id: string, connId: string): ActiveConnection {
  return {
    connId,
    config: {
      id,
      name: id,
      database_type: "mysql",
      host: "localhost",
      port: 3306,
      username: "test",
    },
  };
}

function executionResult(
  status: DatabaseSyncExecutionStatus = "succeeded",
  completedStatements = [{ operation_id: "op", statement_index: 0 }]
): DatabaseSyncExecutionResult {
  return {
    status,
    completed_statements: completedStatements,
    failed:
      status === "succeeded"
        ? null
        : { operation_id: "next", statement_index: 0, error: "DDL denied" },
    pending_operation_ids: status === "succeeded" ? [] : ["next"],
    cleanup_errors: [],
    latest_compare_result: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("数据库结构同步服务", () => {
  let previousConnections: Record<string, ActiveConnection>;
  let events: SqlCompletionInvalidation[];
  let stopListening: () => void;

  beforeEach(() => {
    vi.resetAllMocks();
    previousConnections = useConnectionStore.getState().activeConnections;
    useConnectionStore.setState({ activeConnections: {} });
    events = [];
    stopListening = subscribeSqlCompletionInvalidation((event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    stopListening();
    useConnectionStore.setState({ activeConnections: previousConnections });
  });

  it.each(["succeeded", "partially_succeeded", "failed"] as const)(
    "%s 返回成功语句时，只使目标库连接失效",
    async (status) => {
      useConnectionStore.setState({
        activeConnections: {
          source: connection("src", "source"),
          target: connection("dst", "target"),
          other: connection("other", "other"),
        },
      });
      const result = executionResult(status);
      mockInvoke.mockResolvedValue(result);

      await expect(executeDatabaseSync(input)).resolves.toBe(result);

      expect(events).toEqual([
        { connId: "target", database: "to", reason: "schema-change" },
      ]);
    }
  );

  it.each(["succeeded", "partially_succeeded", "failed"] as const)(
    "%s 没有成功语句时不通知失效",
    async (status) => {
      useConnectionStore.setState({
        activeConnections: { target: connection("dst", "target") },
      });
      mockInvoke.mockResolvedValue(executionResult(status, []));

      await executeDatabaseSync(input);

      expect(events).toEqual([]);
    }
  );

  it("同一保存配置的所有活动连接均失效，其它连接不受影响", async () => {
    useConnectionStore.setState({
      activeConnections: {
        first: connection("dst", "target-1"),
        source: connection("src", "source"),
        second: connection("dst", "target-2"),
        other: connection("other", "other"),
      },
    });
    mockInvoke.mockResolvedValue(executionResult());

    await executeDatabaseSync(input);

    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        { connId: "target-1", database: "to", reason: "schema-change" },
        { connId: "target-2", database: "to", reason: "schema-change" },
      ])
    );
  });

  it("没有打开目标配置时返回同步结果且不通知其它连接", async () => {
    useConnectionStore.setState({
      activeConnections: { source: connection("src", "source") },
    });
    const result = executionResult();
    mockInvoke.mockResolvedValue(result);

    await expect(executeDatabaseSync(input)).resolves.toBe(result);

    expect(events).toEqual([]);
  });

  it("IPC 失败原样抛出错误且不通知失效", async () => {
    useConnectionStore.setState({
      activeConnections: { target: connection("dst", "target") },
    });
    const error = new Error("数据库结构已变化");
    mockInvoke.mockRejectedValue(error);

    await expect(executeDatabaseSync(input)).rejects.toBe(error);

    expect(events).toEqual([]);
  });

  it("等待期间连接改变时，仅使完成时仍打开的目标连接失效", async () => {
    const pending = deferred<DatabaseSyncExecutionResult>();
    useConnectionStore.setState({
      activeConnections: { old: connection("dst", "old-target") },
    });
    mockInvoke.mockReturnValue(pending.promise);

    const execution = executeDatabaseSync(input);
    expect(events).toEqual([]);
    useConnectionStore.setState({
      activeConnections: {
        current: connection("dst", "new-target"),
        other: connection("other", "other"),
      },
    });
    pending.resolve(executionResult());
    await execution;

    expect(events).toEqual([
      { connId: "new-target", database: "to", reason: "schema-change" },
    ]);
  });
});
