import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useTableDataStore } from "../stores/tableDataStore";
import type { TablePageResult } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const state = () => useTableDataStore.getState();
const tableArgs = ["conn", "db", "users"] as const;
const invokeMock = vi.mocked(invoke);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const firstPage: TablePageResult = {
  columns: ["id"],
  rows: [[1]],
  total: 0,
  execution_time_ms: 10,
  pagination: {
    mode: "offset",
    sort_column: "id",
    sort_order: "ASC",
    next_cursor: "after-1",
    previous_cursor: null,
  },
  executed_sql: "SELECT id FROM users LIMIT 50",
};

async function seedLoadedPage() {
  invokeMock.mockImplementation(async (command) => {
    if (command === "query_table_data") return firstPage;
    if (command === "query_table_count") return 100;
    if (command === "cancel_table_query") return true;
    throw new Error(`Unexpected command: ${command}`);
  });
  await state().loadData(...tableArgs);
  await vi.waitFor(() => expect(state().totalCountLoading).toBe(false));
  invokeMock.mockClear();
}

describe("表数据加载中断", () => {
  beforeEach(() => {
    state().reset();
    vi.resetAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("缺少 randomUUID 的运行环境仍可加载，并为数据和计数分配不同标识", async () => {
    vi.stubGlobal("crypto", {});
    await seedLoadedPage();
    expect(state().rows).toEqual([[1]]);
    invokeMock.mockImplementation(() => new Promise(() => {}));
    useTableDataStore.setState({ countCache: {} });
    await state().loadData(...tableArgs);
    const requests = invokeMock.mock.calls.map(
      ([, args]) => args as Record<string, unknown>
    );
    expect(requests[0].executionId).toEqual(expect.any(String));
    expect(requests[1].executionId).not.toBe(requests[0].executionId);
  });

  it("同时中断数据和总数请求，迟到响应不写入行或缓存", async () => {
    const data = deferred<TablePageResult>();
    const count = deferred<number>();
    const cancellation = deferred<boolean>();
    invokeMock.mockImplementation((command) => {
      if (command === "query_table_data") return data.promise;
      if (command === "query_table_count") return count.promise;
      if (command === "cancel_table_query") return cancellation.promise;
      throw new Error(`Unexpected command: ${command}`);
    });
    await state().loadData(...tableArgs);
    expect(state().canCancelLoad).toBe(true);

    const cancel = state().cancelLoad();
    expect(state().dataLoading).toBe(false);
    expect(state().totalCountLoading).toBe(false);
    expect(state().canCancelLoad).toBe(false);
    const requests = invokeMock.mock.calls
      .slice(0, 2)
      .map(([, args]) => args as Record<string, unknown>);
    expect(requests[0].executionId).toEqual(expect.any(String));
    expect(requests[1].executionId).not.toBe(requests[0].executionId);
    expect(invokeMock.mock.calls.slice(2)).toEqual(
      requests.map(({ executionId }) => [
        "cancel_table_query",
        { connId: "conn", executionId },
      ])
    );

    data.resolve(firstPage);
    count.resolve(100);
    cancellation.resolve(true);
    await cancel;
    expect(state().rows).toEqual([]);
    expect(state().total).toBe(0);
    expect(state().tableDataCache).toEqual({});
    expect(state().countCache).toEqual({});
    expect(state().dataError).toBeNull();
  });

  it("翻页中断恢复上次成功页及其游标，允许重新加载", async () => {
    await seedLoadedPage();
    const data = deferred<TablePageResult>();
    invokeMock.mockImplementation(async (command) =>
      command === "query_table_data" ? data.promise : true
    );
    state().setPage(2, "next");
    await state().loadData(...tableArgs);
    await state().cancelLoad();
    expect(state().page).toBe(1);
    expect(state().rows).toEqual([[1]]);
    expect(state().pagination?.next_cursor).toBe("after-1");
    expect(state().executedSql).toBe(firstPage.executed_sql);

    invokeMock.mockResolvedValueOnce({ ...firstPage, rows: [[51]] });
    state().setPage(2, "next");
    await state().loadData(...tableArgs);
    await vi.waitFor(() => expect(state().rows).toEqual([[51]]));
    data.resolve({ ...firstPage, rows: [[999]] });
    await Promise.resolve();
    expect(state().rows).toEqual([[51]]);
    expect(state().page).toBe(2);
  });

  it("数据已返回时仅中断总数，保留新行并标记总数待刷新", async () => {
    const count = deferred<number>();
    invokeMock.mockImplementation(async (command) => {
      if (command === "query_table_data") return firstPage;
      if (command === "query_table_count") return count.promise;
      return true;
    });
    await state().loadData(...tableArgs);
    await vi.waitFor(() => expect(state().dataLoading).toBe(false));
    expect(state().canCancelLoad).toBe(true);
    await state().cancelLoad();
    expect(state().rows).toEqual([[1]]);
    expect(state().totalCountStale).toBe(true);
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === "cancel_table_query"
      )
    ).toHaveLength(1);
    count.resolve(100);
    await Promise.resolve();
    expect(state().total).toBe(0);
  });

  it("中断单独刷新分页不提示成功，迟到总数不会触发缩页", async () => {
    await seedLoadedPage();
    const count = deferred<number>();
    invokeMock.mockImplementation(async (command) =>
      command === "query_table_count" ? count.promise : true
    );
    state().setPage(2);
    const refresh = state().refreshPagination(...tableArgs);
    expect(state().canCancelLoad).toBe(true);
    await state().cancelLoad();
    count.resolve(1);
    expect(await refresh).toBe(false);
    expect(state().page).toBe(2);
    expect(state().total).toBe(100);
    expect(state().countCache["conn|db|users|"]).toBe(100);
  });

  it("刷新数据成功但计数被中断时，切表恢复保留最后已知总数", async () => {
    await seedLoadedPage();
    const count = deferred<number>();
    useTableDataStore.setState({ countCache: {} });
    invokeMock.mockImplementation(async (command) => {
      if (command === "query_table_data") return { ...firstPage, rows: [[2]] };
      if (command === "query_table_count") return count.promise;
      return true;
    });
    await state().loadData(...tableArgs);
    await vi.waitFor(() => expect(state().rows).toEqual([[2]]));
    await state().cancelLoad();
    expect(state().tableDataCache["conn|db|users"].total).toBe(100);
    state().switchToTable("conn", "db", "posts");
    state().switchToTable(...tableArgs);
    expect(state().total).toBe(100);
    expect(state().rows).toEqual([[2]]);
    count.resolve(1);
  });

  it("取消的失败响应不显示加载错误，也不影响后续请求的状态", async () => {
    const oldData = deferred<TablePageResult>();
    const oldCount = deferred<number>();
    invokeMock.mockImplementation(async (command) => {
      if (command === "query_table_data") return oldData.promise;
      if (command === "query_table_count") return oldCount.promise;
      return true;
    });
    await state().loadData(...tableArgs);
    await state().cancelLoad();
    const newData = deferred<TablePageResult>();
    invokeMock.mockImplementation(async (command) =>
      command === "query_table_data" ? newData.promise : 100
    );
    await state().loadData(...tableArgs);
    oldData.reject("查询已取消");
    oldCount.reject("统计已取消");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state().dataLoading).toBe(true);
    expect(state().canCancelLoad).toBe(true);
    expect(state().dataError).toBeNull();
    newData.resolve(firstPage);
    await vi.waitFor(() => expect(state().canCancelLoad).toBe(false));
  });

  it("后端取消失败仍退出加载，并向调用方报告原因", async () => {
    invokeMock.mockImplementation((command) =>
      command === "cancel_table_query"
        ? Promise.reject("取消权限不足")
        : new Promise(() => {})
    );
    await state().loadData(...tableArgs);
    await expect(state().cancelLoad()).rejects.toThrow("取消权限不足");
    expect(state().dataLoading).toBe(false);
    expect(state().totalCountLoading).toBe(false);
    expect(state().dataError).toBeNull();
  });

  it("切到其他表后不向旧表发送取消请求", async () => {
    invokeMock.mockImplementation(() => new Promise(() => {}));
    await state().loadData(...tableArgs);
    state().switchToTable("conn", "db", "posts");
    expect(state().canCancelLoad).toBe(false);
    await state().cancelLoad();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("中断覆盖同表较早的计数请求，迟到计数不能改写恢复的页面", async () => {
    await seedLoadedPage();
    const count = deferred<number>();
    const data = deferred<TablePageResult>();
    invokeMock.mockImplementation(async (command) => {
      if (command === "query_table_count") return count.promise;
      if (command === "query_table_data") return data.promise;
      return true;
    });
    const refresh = state().refreshPagination(...tableArgs);
    await state().loadData(...tableArgs);
    await state().cancelLoad();
    count.resolve(1);
    data.resolve(firstPage);
    expect(await refresh).toBe(false);
    expect(state().total).toBe(100);
  });

  it("筛选中断恢复旧筛选的总数，不使用新筛选先返回的计数", async () => {
    await seedLoadedPage();
    const data = deferred<TablePageResult>();
    invokeMock.mockImplementation(async (command) => {
      if (command === "query_table_data") return data.promise;
      if (command === "query_table_count") return 2;
      return true;
    });
    state().setWhereClause("id > 90");
    await state().loadData(...tableArgs);
    await vi.waitFor(() => expect(state().total).toBe(2));
    await state().cancelLoad();
    expect(state().whereClause).toBe("");
    expect(state().total).toBe(100);
    expect(state().rows).toEqual([[1]]);
    data.resolve(firstPage);
  });

  it("写入与计数并行时不允许中断写入状态", async () => {
    await seedLoadedPage();
    const count = deferred<number>();
    const write = deferred<number>();
    invokeMock.mockImplementation(async (command) => {
      if (command === "query_table_count") return count.promise;
      if (command === "insert_row") return write.promise;
      if (command === "query_table_data") return firstPage;
      throw new Error(`Unexpected command: ${command}`);
    });
    const refresh = state().refreshPagination(...tableArgs);
    const insert = state().insertRow(...tableArgs, { id: 2 });
    expect(state().canCancelLoad).toBe(false);
    await state().cancelLoad();
    expect(state().dataLoading).toBe(true);
    count.resolve(100);
    await refresh;
    expect(state().canCancelLoad).toBe(false);
    write.resolve(1);
    await insert;
    expect(state().dataLoading).toBe(false);
  });
});
