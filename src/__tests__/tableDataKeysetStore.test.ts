import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTableDataStore } from "../stores/tableDataStore";
import * as api from "../services/tauriCommands";
import type { TablePageResult } from "../types";

vi.mock("../services/tauriCommands", () => ({
  queryTableData: vi.fn(),
  queryTableCount: vi.fn(),
  updateRow: vi.fn(),
  batchUpdateRows: vi.fn(),
  insertRow: vi.fn(),
  deleteRows: vi.fn(),
}));

const mockApi = vi.mocked(api);
const state = () => useTableDataStore.getState();
const tableArgs = ["conn", "db", "users"] as const;

function result(page: number, prefix = "users"): TablePageResult {
  return {
    columns: ["id"],
    rows: [[page * 50]],
    total: 0,
    execution_time_ms: 1,
    pagination: {
      mode: "offset",
      sort_column: "id",
      sort_order: "ASC",
      next_cursor: `${prefix}-after-${page}`,
      previous_cursor: page > 1 ? `${prefix}-before-${page}` : null,
    },
    executed_sql: `page ${page} of ${prefix}`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function load(page = 1, selectColumns?: string[]) {
  mockApi.queryTableData.mockResolvedValueOnce(result(page));
  await state().loadData(...tableArgs, selectColumns);
  await vi.waitFor(() => expect(state().dataLoading).toBe(false));
}

function lastNavigation() {
  return mockApi.queryTableData.mock.lastCall?.[9];
}

describe("表数据游标导航状态", () => {
  beforeEach(() => {
    state().reset();
    vi.resetAllMocks();
    mockApi.queryTableCount.mockResolvedValue(1000);
    mockApi.updateRow.mockResolvedValue(1);
    mockApi.batchUpdateRows.mockResolvedValue(1);
    mockApi.insertRow.mockResolvedValue(1);
    mockApi.deleteRows.mockResolvedValue(1);
  });

  it("成功页原子保存行、首尾游标和实际 SQL，下一页及上一页使用对应边界", async () => {
    await load();
    expect(state().pagination?.next_cursor).toBe("users-after-1");
    expect(state().executedSql).toBe("page 1 of users");

    state().setPage(2, "next");
    await load(2);
    expect(lastNavigation()).toEqual({
      direction: "next",
      cursor: "users-after-1",
    });
    expect(state().rows).toEqual([[100]]);

    state().setPage(1, "previous");
    await load();
    expect(lastNavigation()).toEqual({
      direction: "previous",
      cursor: "users-before-2",
    });
    expect(state().rows).toEqual([[50]]);
    expect(mockApi.queryTableCount).toHaveBeenCalledTimes(1);
  });

  it("普通跳页始终 OFFSET，成功跳页后继续下一页使用新边界", async () => {
    await load();
    state().setPage(2);
    await load(2);
    expect(lastNavigation()).toBeUndefined();
    state().setPage(20);
    await load(20);
    expect(lastNavigation()).toBeUndefined();
    state().setPage(21, "next");
    await load(21);
    expect(lastNavigation()).toEqual({
      direction: "next",
      cursor: "users-after-20",
    });
  });

  it("同页刷新和显示隐藏列只重载当前页，不重复消费导航", async () => {
    await load();
    state().setPage(2, "next");
    await load(2);
    await load(2);
    expect(lastNavigation()).toBeUndefined();
    expect(state().page).toBe(2);

    state().setPage(3, "next");
    await load(3, ["id", "name"]);
    expect(lastNavigation()).toBeUndefined();
  });

  it("快速连续改页不能将旧行游标用于尚未加载的新页", async () => {
    await load();
    state().setPage(2, "next");
    state().setPage(3, "next");
    await load(3);
    expect(lastNavigation()).toBeUndefined();
  });

  it("迟到的翻页响应不能覆盖新页的行和游标", async () => {
    await load();
    const stale = deferred<TablePageResult>();
    mockApi.queryTableData.mockReturnValueOnce(stale.promise);
    state().setPage(2, "next");
    void state().loadData(...tableArgs);
    expect(lastNavigation()).toEqual({
      direction: "next",
      cursor: "users-after-1",
    });
    state().setPage(3, "next");
    await load(3);
    expect(lastNavigation()).toBeUndefined();
    stale.resolve(result(2));
    await Promise.resolve();
    expect(state().rows).toEqual([[150]]);
    expect(state().pagination?.next_cursor).toBe("users-after-3");
    expect(state().executedSql).toBe("page 3 of users");
  });

  it("失败重试重建目标页 OFFSET，后续导航使用重试成功页", async () => {
    await load();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApi.queryTableData.mockRejectedValueOnce("网络错误");
    state().setPage(2, "next");
    await state().loadData(...tableArgs);
    await vi.waitFor(() => expect(state().dataError).toBe("网络错误"));
    expect(state().rows).toEqual([[50]]);
    await load(2);
    expect(lastNavigation()).toBeUndefined();
    state().setPage(3, "next");
    await load(3);
    expect(lastNavigation()).toEqual({
      direction: "next",
      cursor: "users-after-2",
    });
    errorLog.mockRestore();
  });

  it.each([
    ["页大小", () => state().setPageSize(25)],
    ["排序", () => state().setSort("id", "DESC")],
    ["追加排序", () => state().toggleSortColumn("id", true)],
    ["筛选", () => state().setWhereClause("id > 10")],
    ["相同筛选重查", () => state().setWhereClause("")],
  ])("%s 变化即清理游标，并丢弃变化前的在途响应", async (_label, change) => {
    await load();
    const stale = deferred<TablePageResult>();
    mockApi.queryTableData.mockReturnValueOnce(stale.promise);
    state().setPage(2, "next");
    void state().loadData(...tableArgs);
    change();
    expect(state().pagination).toBeNull();
    stale.resolve(result(2));
    await Promise.resolve();
    expect(state().pagination).toBeNull();
    expect(state().rows).toEqual([[50]]);
    state().setPage(2, "next");
    await load(2);
    expect(lastNavigation()).toBeUndefined();
  });

  it("切表恢复成功页游标，同时隔离旧表在途响应", async () => {
    await load();
    state().setPage(2, "next");
    await load(2);
    state().switchToTable("conn", "db", "posts");
    mockApi.queryTableData.mockResolvedValueOnce(result(1, "posts"));
    await state().loadData("conn", "db", "posts");
    const stale = deferred<TablePageResult>();
    mockApi.queryTableData.mockReturnValueOnce(stale.promise);
    state().setPage(2, "next");
    void state().loadData("conn", "db", "posts");
    expect(state().switchToTable(...tableArgs)).toBe(true);
    expect(state().executedSql).toBe("page 2 of users");
    stale.resolve(result(2, "posts"));
    await Promise.resolve();
    expect(state().rows).toEqual([[100]]);
    expect(state().pagination?.next_cursor).toBe("users-after-2");
    state().setPage(3, "next");
    await load(3);
    expect(lastNavigation()).toEqual({
      direction: "next",
      cursor: "users-after-2",
    });
  });

  it("翻页未完成便切表时，切回恢复成功页码和数据", async () => {
    await load();
    const pending = deferred<TablePageResult>();
    mockApi.queryTableData.mockReturnValueOnce(pending.promise);
    state().setPage(2, "next");
    void state().loadData(...tableArgs);
    state().switchToTable("conn", "db", "posts");
    state().switchToTable(...tableArgs);
    expect(state().page).toBe(1);
    expect(state().rows).toEqual([[50]]);
    state().setPage(2, "next");
    await load(2);
    expect(lastNavigation()).toEqual({
      direction: "next",
      cursor: "users-after-1",
    });
    pending.resolve(result(2, "stale"));
    await Promise.resolve();
    expect(state().executedSql).toBe("page 2 of users");
  });

  it.each(["update", "batch", "insert", "delete"] as const)(
    "%s 写后使用 OFFSET 重建边界",
    async (operation) => {
      await load();
      state().setPage(2, "next");
      await load(2);
      mockApi.queryTableData.mockResolvedValueOnce(result(2, "updated"));
      if (operation === "update")
        await state().updateCell(...tableArgs, { id: 100 }, { id: 101 });
      if (operation === "batch")
        await state().batchUpdateCells(...tableArgs, [
          { primaryKeys: { id: 100 }, updates: { id: 101 } },
        ]);
      if (operation === "insert")
        await state().insertRow(...tableArgs, { id: 101 });
      if (operation === "delete")
        await state().deleteRows(...tableArgs, [{ id: 100 }]);
      expect(lastNavigation()).toBeUndefined();
      expect(state().pagination?.next_cursor).toBe("updated-after-2");
      expect(state().executedSql).toBe("page 2 of updated");
      expect(state().totalCountStale).toBe(true);
      state().setPage(3, "next");
      await load(3);
      expect(lastNavigation()).toEqual({
        direction: "next",
        cursor: "updated-after-2",
      });
    }
  );

  it("后台 CRUD 重载迟到时不能覆盖切回后新请求的游标", async () => {
    await load();
    state().switchToTable("conn", "db", "posts");
    const stale = deferred<TablePageResult>();
    mockApi.queryTableData.mockReturnValueOnce(stale.promise);
    const update = state().updateCell(...tableArgs, { id: 50 }, { id: 51 });
    await vi.waitFor(() =>
      expect(mockApi.queryTableData).toHaveBeenCalledTimes(2)
    );
    state().switchToTable(...tableArgs);
    state().setPage(2);
    await load(2);
    stale.resolve(result(1, "stale"));
    await update;
    expect(state().rows).toEqual([[100]]);
    expect(state().pagination?.next_cursor).toBe("users-after-2");
  });

  it("关闭后台表后 CRUD 迟到响应不能恢复已删除快照", async () => {
    await load();
    state().switchToTable("conn", "db", "posts");
    const stale = deferred<TablePageResult>();
    mockApi.queryTableData.mockReturnValueOnce(stale.promise);
    const update = state().updateCell(...tableArgs, { id: 50 }, { id: 51 });
    await vi.waitFor(() =>
      expect(mockApi.queryTableData).toHaveBeenCalledTimes(2)
    );
    state().removeTableFromCache(...tableArgs);
    stale.resolve(result(1, "stale"));
    await update;
    expect(state().tableDataCache["conn|db|users"]).toBeUndefined();
  });

  it("重置后迟到响应不能重新写入游标和缓存", async () => {
    const stale = deferred<TablePageResult>();
    mockApi.queryTableData.mockReturnValueOnce(stale.promise);
    void state().loadData(...tableArgs);
    state().reset();
    stale.resolve(result(1));
    await Promise.resolve();
    expect(state().rows).toEqual([]);
    expect(state().pagination).toBeNull();
    expect(state().tableDataCache).toEqual({});
  });

  it("刷新分页缩页与 TRUNCATE 清理游标，重新获取边界", async () => {
    state().setPage(20);
    await load(20);
    mockApi.queryTableCount.mockResolvedValueOnce(30);
    await state().refreshPagination(...tableArgs);
    expect(state().page).toBe(1);
    expect(state().pagination).toBeNull();
    await load();
    state().setPage(2, "next");
    mockApi.queryTableData.mockResolvedValueOnce({
      ...result(1),
      rows: [],
      pagination: null,
    });
    state().afterTableDataCleared(...tableArgs);
    await vi.waitFor(() => expect(state().dataLoading).toBe(false));
    expect(lastNavigation()).toBeUndefined();
    expect(state().pagination).toBeNull();
  });

  it("旧筛选的 COUNT 迟到不能污染新筛选的快照总数", async () => {
    await load();
    const stale = deferred<number>();
    mockApi.queryTableCount.mockReturnValueOnce(stale.promise);
    const refresh = state().refreshPagination(...tableArgs);
    state().setWhereClause("id > 900");
    mockApi.queryTableCount.mockResolvedValueOnce(100);
    await load();
    expect(state().total).toBe(100);
    stale.resolve(1000);
    await refresh;
    expect(state().total).toBe(100);
    expect(state().tableDataCache["conn|db|users"].total).toBe(100);
    state().switchToTable("conn", "db", "posts");
    state().switchToTable(...tableArgs);
    expect(state().total).toBe(100);
  });

  it("旧筛选 COUNT 失败不终止新筛选的计数加载状态", async () => {
    await load();
    const stale = deferred<number>();
    const current = deferred<number>();
    mockApi.queryTableCount.mockReturnValueOnce(stale.promise);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const refresh = state().refreshPagination(...tableArgs);
    const rejected = expect(refresh).rejects.toBe("旧计数失败");
    state().setWhereClause("id > 900");
    mockApi.queryTableCount.mockReturnValueOnce(current.promise);
    await load();
    expect(state().totalCountLoading).toBe(true);
    stale.reject("旧计数失败");
    await rejected;
    expect(state().totalCountLoading).toBe(true);
    current.resolve(100);
    await Promise.resolve();
    expect(state().total).toBe(100);
    expect(state().totalCountLoading).toBe(false);
    errorLog.mockRestore();
  });

  it("无可用边界的表保持无导航的 OFFSET 请求", async () => {
    mockApi.queryTableData.mockResolvedValue({
      ...result(1),
      pagination: null,
    });
    await state().loadData(...tableArgs);
    state().setPage(2, "next");
    await state().loadData(...tableArgs);
    expect(lastNavigation()).toBeUndefined();
  });
});
