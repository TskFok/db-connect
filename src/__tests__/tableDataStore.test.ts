import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTableDataStore } from "../stores/tableDataStore";

// Mock Tauri API
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Mock api service
vi.mock("../services/tauriCommands", () => ({
  queryTableData: vi.fn(),
  queryTableCount: vi.fn(),
  queryFullRows: vi.fn(),
  insertRow: vi.fn(),
  updateRow: vi.fn(),
  batchUpdateRows: vi.fn(),
  deleteRows: vi.fn(),
  executeSql: vi.fn(),
  // Phase 1 & 2 的方法也需要 mock
  listSavedConnections: vi.fn(),
  saveConnection: vi.fn(),
  deleteSavedConnection: vi.fn(),
  testConnection: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  listDatabases: vi.fn(),
  listTables: vi.fn(),
  getTableStructure: vi.fn(),
}));

import * as api from "../services/tauriCommands";

const mockApi = vi.mocked(api);

const mockQueryResult = {
  columns: ["id", "name", "email"],
  rows: [
    [1, "Alice", "alice@example.com"],
    [2, "Bob", "bob@example.com"],
  ],
  total: 100,
  execution_time_ms: 15,
};

describe("tableDataStore", () => {
  beforeEach(() => {
    useTableDataStore.getState().reset();
    vi.clearAllMocks();
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useTableDataStore.getState();
      expect(state.columns).toEqual([]);
      expect(state.rows).toEqual([]);
      expect(state.total).toBe(0);
      expect(state.page).toBe(1);
      expect(state.pageSize).toBe(50);
      expect(state.sortFields).toEqual([]);
      expect(state.whereClause).toBe("");
      expect(state.filterRows).toEqual([]);
      expect(state.dataLoading).toBe(false);
      expect(state.totalCountLoading).toBe(false);
      expect(state.totalCountStale).toBe(false);
      expect(state.dataError).toBeNull();
      expect(state.executionTime).toBeNull();
      expect(state.lastSelectColumns).toBeUndefined();
    });
  });

  describe("pendingChangesCache", () => {
    const pendingKey = 'id=1|col="name"';
    const pendingChange = {
      rowKey: 0,
      colName: "name",
      oldValue: "Alice",
      newValue: "Alicia",
      primaryKeys: { id: 1 },
    };

    function pendingApi() {
      return useTableDataStore.getState() as unknown as {
        setPendingChange: (
          connId: string,
          database: string,
          table: string,
          changeKey: string,
          change: typeof pendingChange
        ) => void;
        getPendingChangesForTable: (
          connId: string,
          database: string,
          table: string
        ) => Map<string, typeof pendingChange>;
        clearPendingChanges: (
          connId: string,
          database: string,
          table: string
        ) => void;
        removeTableFromCache: (
          connId: string,
          database: string,
          table: string
        ) => void;
      };
    }

    it("按表缓存待提交修改，切换到其他表后仍可恢复原表修改", () => {
      pendingApi().setPendingChange(
        "conn-1",
        "mydb",
        "users",
        pendingKey,
        pendingChange
      );

      useTableDataStore.getState().switchToTable("conn-1", "mydb", "orders");

      const usersPending = pendingApi().getPendingChangesForTable(
        "conn-1",
        "mydb",
        "users"
      );
      const ordersPending = pendingApi().getPendingChangesForTable(
        "conn-1",
        "mydb",
        "orders"
      );

      expect(usersPending.get(pendingKey)?.newValue).toBe("Alicia");
      expect(ordersPending.size).toBe(0);
    });

    it("关闭表缓存时同步清理该表待提交修改", () => {
      pendingApi().setPendingChange(
        "conn-1",
        "mydb",
        "users",
        pendingKey,
        pendingChange
      );

      pendingApi().removeTableFromCache("conn-1", "mydb", "users");

      expect(
        pendingApi().getPendingChangesForTable("conn-1", "mydb", "users").size
      ).toBe(0);
    });
  });

  describe("loadData", () => {
    it("应该加载表数据（无 selectColumns 时使用 SELECT *）", async () => {
      mockApi.queryTableData.mockResolvedValue({ ...mockQueryResult, total: 0 });
      mockApi.queryTableCount.mockResolvedValue(100);

      useTableDataStore.getState().loadData("conn-1", "mydb", "users");

      // loadData 为异步，数据与 count 并行请求，需等待完成
      await vi.waitFor(
        () => {
          const state = useTableDataStore.getState();
          expect(state.dataLoading).toBe(false);
          expect(state.total).toBe(100);
        },
        { timeout: 2000 }
      );

      const state = useTableDataStore.getState();
      expect(state.columns).toEqual(["id", "name", "email"]);
      expect(state.rows).toHaveLength(2);
      expect(state.total).toBe(100);
      expect(state.executionTime).toBe(15);
      expect(state.dataLoading).toBe(false);
      expect(state.dataError).toBeNull();
      expect(state.lastSelectColumns).toBeUndefined();
      expect(mockApi.queryTableData).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        1,
        50,
        undefined,
        undefined,
        undefined,
        true // skipCount
      );
      expect(mockApi.queryTableCount).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        undefined
      );
    });

    it("传入 selectColumns 时应该转发给 API", async () => {
      mockApi.queryTableData.mockResolvedValue({
        columns: ["name", "email"],
        rows: [["Alice", "alice@example.com"]],
        total: 0,
        execution_time_ms: 10,
      });
      mockApi.queryTableCount.mockResolvedValue(50);

      useTableDataStore.getState().loadData("conn-1", "mydb", "users", ["name", "email"]);

      await vi.waitFor(
        () => {
          const state = useTableDataStore.getState();
          expect(state.dataLoading).toBe(false);
          expect(state.total).toBe(50);
        },
        { timeout: 2000 }
      );

      const state = useTableDataStore.getState();
      expect(state.columns).toEqual(["name", "email"]);
      expect(state.lastSelectColumns).toEqual(["name", "email"]);
      expect(mockApi.queryTableData).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        1,
        50,
        undefined,
        undefined,
        ["name", "email"],
        true
      );
      expect(mockApi.queryTableCount).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        undefined
      );
    });

    it("加载失败时应该设置错误", async () => {
      mockApi.queryTableData.mockRejectedValue("查询失败");
      mockApi.queryTableCount.mockResolvedValue(100);

      useTableDataStore.getState().loadData("conn-1", "mydb", "users");

      await vi.waitFor(
        () => {
          const state = useTableDataStore.getState();
          expect(state.dataLoading).toBe(false);
        },
        { timeout: 2000 }
      );

      const state = useTableDataStore.getState();
      expect(state.dataError).toBe("查询失败");
      expect(state.rows).toEqual([]);
    });

    it("换页时不应重复请求 count（使用 countCache）", async () => {
      mockApi.queryTableData.mockResolvedValue({ ...mockQueryResult, total: 0 });
      mockApi.queryTableCount.mockResolvedValue(100);

      useTableDataStore.getState().loadData("conn-1", "mydb", "users");
      await vi.waitFor(
        () => {
          expect(useTableDataStore.getState().total).toBe(100);
        },
        { timeout: 2000 }
      );

      vi.clearAllMocks();
      mockApi.queryTableData.mockResolvedValue({ ...mockQueryResult, total: 0 });

      useTableDataStore.setState({ page: 2 });
      useTableDataStore.getState().loadData("conn-1", "mydb", "users");

      await vi.waitFor(
        () => {
          expect(useTableDataStore.getState().dataLoading).toBe(false);
          expect(useTableDataStore.getState().page).toBe(2);
        },
        { timeout: 2000 }
      );

      expect(mockApi.queryTableData).toHaveBeenCalledTimes(1);
      expect(mockApi.queryTableCount).not.toHaveBeenCalled();
    });

    it("refreshPagination 应强制重新请求 count 并更新缓存", async () => {
      mockApi.queryTableData.mockResolvedValue({ ...mockQueryResult, total: 0 });
      mockApi.queryTableCount.mockResolvedValue(100);

      await useTableDataStore.getState().loadData("conn-1", "mydb", "users");
      await vi.waitFor(
        () => {
          expect(useTableDataStore.getState().total).toBe(100);
        },
        { timeout: 2000 }
      );

      vi.clearAllMocks();
      mockApi.queryTableCount.mockResolvedValue(42);

      await useTableDataStore.getState().refreshPagination("conn-1", "mydb", "users");

      expect(mockApi.queryTableData).not.toHaveBeenCalled();
      expect(mockApi.queryTableCount).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        undefined
      );
      const state = useTableDataStore.getState();
      expect(state.total).toBe(42);
      expect(state.totalCountLoading).toBe(false);
      expect(state.totalCountStale).toBe(false);
      expect(state.countCache["conn-1|mydb|users|"]).toBe(42);
      expect(state.tableDataCache["conn-1|mydb|users"]?.total).toBe(42);
    });

    it("refreshPagination 应清除 totalCountStale", async () => {
      mockApi.queryTableData.mockResolvedValue({ ...mockQueryResult, total: 0 });
      mockApi.queryTableCount.mockResolvedValue(100);
      useTableDataStore.getState().loadData("conn-1", "mydb", "users");
      await vi.waitFor(
        () => expect(useTableDataStore.getState().total).toBe(100),
        { timeout: 2000 }
      );

      useTableDataStore.setState({ totalCountStale: true });
      mockApi.queryTableCount.mockResolvedValue(100);

      await useTableDataStore.getState().refreshPagination("conn-1", "mydb", "users");

      expect(useTableDataStore.getState().totalCountStale).toBe(false);
    });

    it("refreshPagination 在总行数变少时应回退到最后一页", async () => {
      mockApi.queryTableData.mockResolvedValue({ ...mockQueryResult, total: 0 });
      mockApi.queryTableCount.mockResolvedValue(100);

      await useTableDataStore.getState().loadData("conn-1", "mydb", "users");
      await vi.waitFor(
        () => {
          expect(useTableDataStore.getState().total).toBe(100);
        },
        { timeout: 2000 }
      );

      useTableDataStore.setState({ page: 5, pageSize: 20 });
      mockApi.queryTableCount.mockResolvedValue(30);

      await useTableDataStore.getState().refreshPagination("conn-1", "mydb", "users");

      expect(useTableDataStore.getState().page).toBe(2);
      expect(useTableDataStore.getState().total).toBe(30);
    });

    it("应该传递排序和筛选参数", async () => {
      mockApi.queryTableData.mockResolvedValue({ ...mockQueryResult, total: 0 });
      mockApi.queryTableCount.mockResolvedValue(100);

      useTableDataStore.setState({
        page: 2,
        pageSize: 20,
        sortFields: [{ column: "name", order: "DESC" }],
        whereClause: "id > 10",
      });

      useTableDataStore.getState().loadData("conn-1", "mydb", "users");

      await vi.waitFor(
        () => {
          expect(mockApi.queryTableData).toHaveBeenCalledWith(
            "conn-1",
            "mydb",
            "users",
            2,
            20,
            [{ column: "name", order: "DESC" }],
            "id > 10",
            undefined,
            true
          );
          expect(mockApi.queryTableCount).toHaveBeenCalledWith(
            "conn-1",
            "mydb",
            "users",
            "id > 10"
          );
        },
        { timeout: 2000 }
      );
    });

    it("首次筛选时晚返回的初始请求结果应被忽略（竞态）", async () => {
      const firstResolve = vi.fn();
      const secondResolve = vi.fn();
      const firstPromise = new Promise<typeof mockQueryResult>((resolve) => {
        firstResolve.mockImplementation((value: typeof mockQueryResult) => resolve(value));
      });
      const secondPromise = new Promise<typeof mockQueryResult>((resolve) => {
        secondResolve.mockImplementation((value: typeof mockQueryResult) => resolve(value));
      });
      let callCount = 0;
      mockApi.queryTableData.mockImplementation(() => {
        callCount += 1;
        return callCount === 1 ? firstPromise : secondPromise;
      });
      mockApi.queryTableCount.mockImplementation(() => Promise.resolve(100));

      useTableDataStore.getState().loadData("conn-1", "mydb", "users");
      useTableDataStore.getState().setWhereClause("id = 1");
      useTableDataStore.getState().loadData("conn-1", "mydb", "users");

      const filteredResult = {
        columns: ["id", "name", "email"],
        rows: [[1, "Alice", "alice@example.com"]],
        total: 0,
        execution_time_ms: 5,
      };
      secondResolve(filteredResult);

      await vi.waitFor(
        () => {
          const state = useTableDataStore.getState();
          expect(state.dataLoading).toBe(false);
          expect(state.whereClause).toBe("id = 1");
          expect(state.rows).toEqual(filteredResult.rows);
        },
        { timeout: 2000 }
      );

      firstResolve({
        columns: ["id", "name", "email"],
        rows: [
          [1, "Alice", "alice@example.com"],
          [2, "Bob", "bob@example.com"],
        ],
        total: 0,
        execution_time_ms: 10,
      });
      await Promise.resolve();
      await Promise.resolve();

      const state = useTableDataStore.getState();
      expect(state.whereClause).toBe("id = 1");
      expect(state.rows).toEqual(filteredResult.rows);
      expect(state.rows).not.toHaveLength(2);
    });
  });

  describe("分页和排序", () => {
    it("setPage 应该更新页码", () => {
      useTableDataStore.getState().setPage(3);
      expect(useTableDataStore.getState().page).toBe(3);
    });

    it("setPageSize 应该更新每页大小并重置页码", () => {
      useTableDataStore.setState({ page: 5 });
      useTableDataStore.getState().setPageSize(100);

      const state = useTableDataStore.getState();
      expect(state.pageSize).toBe(100);
      expect(state.page).toBe(1);
    });

    it("setSort 应设置单列排序并重置页码", () => {
      useTableDataStore.setState({ page: 3 });
      useTableDataStore.getState().setSort("name", "ASC");

      const state = useTableDataStore.getState();
      expect(state.sortFields).toEqual([{ column: "name", order: "ASC" }]);
      expect(state.page).toBe(1);
    });

    it("toggleSortColumn 非 additive 行为应循环 DESC→ASC→清空（主排序）", () => {
      useTableDataStore.getState().toggleSortColumn("name", false);
      expect(useTableDataStore.getState().sortFields).toEqual([
        { column: "name", order: "DESC" },
      ]);
      useTableDataStore.getState().toggleSortColumn("name", false);
      expect(useTableDataStore.getState().sortFields).toEqual([
        { column: "name", order: "ASC" },
      ]);
      useTableDataStore.getState().toggleSortColumn("name", false);
      expect(useTableDataStore.getState().sortFields).toEqual([]);
    });

    it("toggleSortColumn additive 应在末尾追加或对已存在列切换方向/移除", () => {
      useTableDataStore.getState().toggleSortColumn("name", false);
      expect(useTableDataStore.getState().sortFields).toEqual([
        { column: "name", order: "DESC" },
      ]);
      useTableDataStore.getState().toggleSortColumn("id", true);
      expect(useTableDataStore.getState().sortFields).toEqual([
        { column: "name", order: "DESC" },
        { column: "id", order: "DESC" },
      ]);
      useTableDataStore.getState().toggleSortColumn("id", true);
      expect(useTableDataStore.getState().sortFields).toEqual([
        { column: "name", order: "DESC" },
        { column: "id", order: "ASC" },
      ]);
      useTableDataStore.getState().toggleSortColumn("id", true);
      expect(useTableDataStore.getState().sortFields).toEqual([
        { column: "name", order: "DESC" },
      ]);
    });

    it("单击其他列作主排序时应覆盖多列排序", () => {
      useTableDataStore.setState({
        sortFields: [
          { column: "a", order: "ASC" },
          { column: "b", order: "DESC" },
        ],
      });
      useTableDataStore.getState().toggleSortColumn("c", false);
      expect(useTableDataStore.getState().sortFields).toEqual([
        { column: "c", order: "DESC" },
      ]);
    });

    it("removeSortField 应移除匹配列并保留顺序", () => {
      useTableDataStore.setState({
        sortFields: [
          { column: "a", order: "ASC" },
          { column: "b", order: "DESC" },
          { column: "c", order: "ASC" },
        ],
      });
      useTableDataStore.getState().removeSortField("b");
      expect(useTableDataStore.getState().sortFields).toEqual([
        { column: "a", order: "ASC" },
        { column: "c", order: "ASC" },
      ]);
      expect(useTableDataStore.getState().page).toBe(1);
    });

    it("removeSortField 对不存在的列应无操作", () => {
      useTableDataStore.setState({
        sortFields: [{ column: "x", order: "DESC" }],
        page: 3,
      });
      useTableDataStore.getState().removeSortField("none");
      expect(useTableDataStore.getState().sortFields).toEqual([
        { column: "x", order: "DESC" },
      ]);
      expect(useTableDataStore.getState().page).toBe(3);
    });

    it("shiftSortFieldPriority 应与相邻项交换并回到第 1 页", () => {
      useTableDataStore.setState({
        page: 4,
        sortFields: [
          { column: "a", order: "ASC" },
          { column: "b", order: "DESC" },
          { column: "c", order: "ASC" },
        ],
      });
      useTableDataStore.getState().shiftSortFieldPriority(1, -1);
      expect(useTableDataStore.getState().sortFields).toEqual([
        { column: "b", order: "DESC" },
        { column: "a", order: "ASC" },
        { column: "c", order: "ASC" },
      ]);
      expect(useTableDataStore.getState().page).toBe(1);
      useTableDataStore.getState().shiftSortFieldPriority(1, 1);
      expect(useTableDataStore.getState().sortFields).toEqual([
        { column: "b", order: "DESC" },
        { column: "c", order: "ASC" },
        { column: "a", order: "ASC" },
      ]);
    });

    it("shiftSortFieldPriority 边界下标应无操作", () => {
      useTableDataStore.setState({
        sortFields: [
          { column: "a", order: "ASC" },
          { column: "b", order: "DESC" },
        ],
      });
      useTableDataStore.getState().shiftSortFieldPriority(0, -1);
      useTableDataStore.getState().shiftSortFieldPriority(1, 1);
      expect(useTableDataStore.getState().sortFields).toEqual([
        { column: "a", order: "ASC" },
        { column: "b", order: "DESC" },
      ]);
    });

    it("setWhereClause 应该更新条件并重置页码", () => {
      useTableDataStore.setState({ page: 3 });
      useTableDataStore.getState().setWhereClause("status = 1");

      const state = useTableDataStore.getState();
      expect(state.whereClause).toBe("status = 1");
      expect(state.page).toBe(1);
    });

    it("setWhereClause 传入 filterRows 时应同时更新 filterRows", () => {
      const rows = [
        { column: "status", operator: "=" as const, value: "1" },
      ];
      useTableDataStore.getState().setWhereClause("status = 1", rows);

      const state = useTableDataStore.getState();
      expect(state.whereClause).toBe("status = 1");
      expect(state.filterRows).toEqual(rows);
    });

    it("setWhereClause 传入空字符串与空数组时应清空 filterRows", () => {
      useTableDataStore.setState({
        whereClause: "id > 0",
        filterRows: [{ column: "id", operator: ">" as const, value: "0" }],
      });
      useTableDataStore.getState().setWhereClause("", []);

      const state = useTableDataStore.getState();
      expect(state.whereClause).toBe("");
      expect(state.filterRows).toEqual([]);
    });
  });

  describe("updateCell", () => {
    it("更新成功后应该重新加载数据", async () => {
      mockApi.updateRow.mockResolvedValue(1);
      mockApi.queryTableData.mockResolvedValue(mockQueryResult);

      await useTableDataStore.getState().updateCell(
        "conn-1",
        "mydb",
        "users",
        { id: 1 },
        { name: "Alice Updated" }
      );

      expect(mockApi.updateRow).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        { id: 1 },
        { name: "Alice Updated" }
      );
      expect(mockApi.queryTableData).toHaveBeenCalled();
      expect(useTableDataStore.getState().dataLoading).toBe(false);
    });

    it("更新成功后应跳过 COUNT 并标记总数可能已过期", async () => {
      mockApi.updateRow.mockResolvedValue(1);
      mockApi.queryTableData.mockResolvedValue({ ...mockQueryResult, total: 0 });
      mockApi.queryTableCount.mockResolvedValue(100);
      useTableDataStore.getState().loadData("conn-1", "mydb", "users");
      await vi.waitFor(
        () => expect(useTableDataStore.getState().dataLoading).toBe(false),
        { timeout: 2000 }
      );
      expect(useTableDataStore.getState().totalCountStale).toBe(false);

      mockApi.queryTableData.mockResolvedValue({
        ...mockQueryResult,
        total: 999,
        execution_time_ms: 8,
      });

      await useTableDataStore.getState().updateCell(
        "conn-1",
        "mydb",
        "users",
        { id: 1 },
        { name: "Alice Updated" }
      );

      const lastCall =
        mockApi.queryTableData.mock.calls[mockApi.queryTableData.mock.calls.length - 1]!;
      expect(lastCall[8]).toBe(true);
      const state = useTableDataStore.getState();
      expect(state.totalCountStale).toBe(true);
      expect(state.total).toBe(100);
      expect(state.countCache["conn-1|mydb|users|"]).toBeUndefined();
    });

    it("更新成功后重新加载应保留 lastSelectColumns", async () => {
      mockApi.updateRow.mockResolvedValue(1);
      mockApi.queryTableData.mockResolvedValue({
        columns: ["name", "id"],
        rows: [["Alice Updated", 1]],
        total: 1,
        execution_time_ms: 5,
      });

      // 先用 selectColumns 加载一次，设置 lastSelectColumns
      useTableDataStore.setState({ lastSelectColumns: ["name"] });

      await useTableDataStore.getState().updateCell(
        "conn-1",
        "mydb",
        "users",
        { id: 1 },
        { name: "Alice Updated" }
      );

      // 重新加载时应传递 lastSelectColumns
      const lastCall = mockApi.queryTableData.mock.calls[mockApi.queryTableData.mock.calls.length - 1];
      expect(lastCall[7]).toEqual(["name"]);
    });

    it("更新失败时应该设置错误", async () => {
      mockApi.updateRow.mockRejectedValue("更新失败");

      await useTableDataStore.getState().updateCell(
        "conn-1",
        "mydb",
        "users",
        { id: 1 },
        { name: "test" }
      );

      expect(useTableDataStore.getState().dataError).toBe("更新失败");
    });

    it("更新进行中切换到其它表后，reload 应写入源表缓存且不覆盖当前表视图", async () => {
      let resolveUpdate!: (value: number | PromiseLike<number>) => void;
      mockApi.updateRow.mockImplementation(
        () =>
          new Promise<number>((resolve) => {
            resolveUpdate = resolve;
          })
      );
      const updatedUsersResult = {
        columns: ["id", "name", "email"],
        rows: [
          [1, "Alice Updated", "alice@example.com"],
          [2, "Bob", "bob@example.com"],
        ],
        total: 100,
        execution_time_ms: 5,
      };

      mockApi.queryTableData.mockResolvedValue({ ...mockQueryResult, total: 0 });
      mockApi.queryTableCount.mockResolvedValue(100);
      useTableDataStore.getState().loadData("conn-1", "mydb", "users");
      await vi.waitFor(
        () => expect(useTableDataStore.getState().dataLoading).toBe(false),
        { timeout: 2000 }
      );

      const updatePromise = useTableDataStore.getState().updateCell(
        "conn-1",
        "mydb",
        "users",
        { id: 1 },
        { name: "Alice Updated" }
      );

      useTableDataStore.getState().switchToTable("conn-1", "mydb", "posts");
      mockApi.queryTableData.mockResolvedValue({
        columns: ["id", "title"],
        rows: [[1, "Hello"]],
        total: 0,
        execution_time_ms: 3,
      });
      mockApi.queryTableCount.mockResolvedValue(5);
      useTableDataStore.getState().loadData("conn-1", "mydb", "posts");
      await vi.waitFor(
        () => expect(useTableDataStore.getState().dataLoading).toBe(false),
        { timeout: 2000 }
      );

      mockApi.queryTableData.mockResolvedValue(updatedUsersResult);
      resolveUpdate!(1);

      await updatePromise;

      const state = useTableDataStore.getState();
      expect(state.activeTableKey).toBe("conn-1|mydb|posts");
      expect(state.columns).toEqual(["id", "title"]);
      expect(state.rows).toEqual([[1, "Hello"]]);
      const usersSnap = state.tableDataCache["conn-1|mydb|users"];
      expect(usersSnap).toBeDefined();
      expect(usersSnap!.rows[0][1]).toBe("Alice Updated");

      const reloadCalls = mockApi.queryTableData.mock.calls.filter((c) => c[2] === "users");
      expect(reloadCalls.length).toBeGreaterThan(0);
      const usersReload = reloadCalls[reloadCalls.length - 1]!;
      expect(usersReload[3]).toBe(1);
      expect(usersReload[4]).toBe(50);
    });
  });

  describe("batchUpdateCells", () => {
    it("批量更新成功后应调用 batchUpdateRows 并重新加载数据", async () => {
      mockApi.batchUpdateRows.mockResolvedValue(2);
      mockApi.queryTableData.mockResolvedValue(mockQueryResult);

      const rows = [
        { primaryKeys: { id: 1 }, updates: { name: "A" } },
        { primaryKeys: { id: 2 }, updates: { name: "B" } },
      ];
      await useTableDataStore
        .getState()
        .batchUpdateCells("conn-1", "mydb", "users", rows);

      expect(mockApi.batchUpdateRows).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        rows
      );
      expect(mockApi.queryTableData).toHaveBeenCalled();
      // 重新加载应跳过 COUNT（第 9 个参数为 true）
      const lastCall =
        mockApi.queryTableData.mock.calls[
          mockApi.queryTableData.mock.calls.length - 1
        ]!;
      expect(lastCall[8]).toBe(true);
      expect(useTableDataStore.getState().dataLoading).toBe(false);
    });

    it("批量更新失败（整批回滚）时应设置错误并向上抛出", async () => {
      mockApi.batchUpdateRows.mockRejectedValue("批量更新失败，已回滚（未提交任何修改）: x");

      await expect(
        useTableDataStore
          .getState()
          .batchUpdateCells("conn-1", "mydb", "users", [
            { primaryKeys: { id: 1 }, updates: { name: "A" } },
          ])
      ).rejects.toBeDefined();

      expect(useTableDataStore.getState().dataError).toContain("已回滚");
    });
  });

  describe("insertRow", () => {
    it("插入成功后应该重新加载数据", async () => {
      mockApi.insertRow.mockResolvedValue(1);
      mockApi.queryTableData.mockResolvedValue(mockQueryResult);

      await useTableDataStore.getState().insertRow(
        "conn-1",
        "mydb",
        "users",
        { name: "Charlie", email: "charlie@example.com" }
      );

      expect(mockApi.insertRow).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        { name: "Charlie", email: "charlie@example.com" }
      );
      expect(mockApi.queryTableData).toHaveBeenCalled();
      expect(
        mockApi.queryTableData.mock.calls[mockApi.queryTableData.mock.calls.length - 1]![8]
      ).toBe(true);
      expect(useTableDataStore.getState().totalCountStale).toBe(true);
    });
  });

  describe("deleteRows", () => {
    it("删除成功后应该重新加载数据", async () => {
      mockApi.deleteRows.mockResolvedValue(2);
      mockApi.queryTableData.mockResolvedValue(mockQueryResult);

      await useTableDataStore.getState().deleteRows(
        "conn-1",
        "mydb",
        "users",
        [{ id: 1 }, { id: 2 }]
      );

      expect(mockApi.deleteRows).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        [{ id: 1 }, { id: 2 }]
      );
      expect(mockApi.queryTableData).toHaveBeenCalled();
      expect(
        mockApi.queryTableData.mock.calls[mockApi.queryTableData.mock.calls.length - 1]![8]
      ).toBe(true);
      expect(useTableDataStore.getState().totalCountStale).toBe(true);
    });
  });

  describe("多表切换缓存", () => {
    it("switchToTable 无缓存时应返回 false 并重置为初始状态", () => {
      const fromCache = useTableDataStore.getState().switchToTable("conn-1", "mydb", "users");
      expect(fromCache).toBe(false);
      const state = useTableDataStore.getState();
      expect(state.columns).toEqual([]);
      expect(state.rows).toEqual([]);
      expect(state.activeTableKey).toBe("conn-1|mydb|users");
    });

    it("switchToTable 有缓存时应恢复数据并返回 true", async () => {
      mockApi.queryTableData.mockResolvedValue({ ...mockQueryResult, total: 0 });
      mockApi.queryTableCount.mockResolvedValue(100);
      useTableDataStore.getState().loadData("conn-1", "mydb", "users");
      await vi.waitFor(
        () => expect(useTableDataStore.getState().rows).toHaveLength(2),
        { timeout: 2000 }
      );

      useTableDataStore.getState().switchToTable("conn-1", "mydb", "posts");
      const postsResult = {
        columns: ["id", "title"],
        rows: [[1, "Hello"]],
        total: 1,
        execution_time_ms: 3,
      };
      mockApi.queryTableData.mockResolvedValue({ ...postsResult, total: 0 });
      mockApi.queryTableCount.mockResolvedValue(1);
      useTableDataStore.getState().loadData("conn-1", "mydb", "posts");

      vi.clearAllMocks();
      const fromCache = useTableDataStore.getState().switchToTable("conn-1", "mydb", "users");
      expect(fromCache).toBe(true);
      const state = useTableDataStore.getState();
      expect(state.columns).toEqual(["id", "name", "email"]);
      expect(state.rows).toHaveLength(2);
      expect(state.total).toBe(100);
      expect(mockApi.queryTableData).not.toHaveBeenCalled();
    });

    it("switchToTable 有缓存时应恢复 whereClause 与 filterRows", async () => {
      mockApi.queryTableData.mockResolvedValue({ ...mockQueryResult, total: 0 });
      mockApi.queryTableCount.mockResolvedValue(100);
      useTableDataStore.getState().loadData("conn-1", "mydb", "users");
      await vi.waitFor(
        () => expect(useTableDataStore.getState().dataLoading).toBe(false),
        { timeout: 2000 }
      );

      const filterRows = [
        { column: "status", operator: "=" as const, value: "1" },
      ];
      useTableDataStore.getState().setWhereClause("status = 1", filterRows);

      useTableDataStore.getState().switchToTable("conn-1", "mydb", "posts");
      const postsResult = {
        columns: ["id", "title"],
        rows: [[1, "Hello"]],
        total: 1,
        execution_time_ms: 3,
      };
      mockApi.queryTableData.mockResolvedValue({ ...postsResult, total: 0 });
      mockApi.queryTableCount.mockResolvedValue(1);
      useTableDataStore.getState().loadData("conn-1", "mydb", "posts");
      await vi.waitFor(
        () => expect(useTableDataStore.getState().dataLoading).toBe(false),
        { timeout: 2000 }
      );

      vi.clearAllMocks();
      const fromCache = useTableDataStore.getState().switchToTable("conn-1", "mydb", "users");
      expect(fromCache).toBe(true);
      const state = useTableDataStore.getState();
      expect(state.whereClause).toBe("status = 1");
      expect(state.filterRows).toEqual(filterRows);
    });

    it("switchToTable 从缓存恢复后 setWhereClause 应正常更新 _filterTrigger", async () => {
      mockApi.queryTableData.mockResolvedValue({ ...mockQueryResult, total: 0 });
      mockApi.queryTableCount.mockResolvedValue(100);
      useTableDataStore.getState().loadData("conn-1", "mydb", "users");
      await vi.waitFor(
        () => expect(useTableDataStore.getState().dataLoading).toBe(false),
        { timeout: 2000 }
      );

      useTableDataStore.getState().switchToTable("conn-1", "mydb", "posts");
      mockApi.queryTableData.mockResolvedValue({
        columns: ["id", "title"],
        rows: [[1, "Hello"]],
        total: 0,
        execution_time_ms: 3,
      });
      mockApi.queryTableCount.mockResolvedValue(1);
      useTableDataStore.getState().loadData("conn-1", "mydb", "posts");
      await vi.waitFor(
        () => expect(useTableDataStore.getState().dataLoading).toBe(false),
        { timeout: 2000 }
      );

      const fromCache = useTableDataStore.getState().switchToTable("conn-1", "mydb", "users");
      expect(fromCache).toBe(true);

      const triggerBefore = useTableDataStore.getState()._filterTrigger;
      useTableDataStore.getState().setWhereClause("`id` > 5");

      const stateAfter = useTableDataStore.getState();
      expect(stateAfter.whereClause).toBe("`id` > 5");
      expect(stateAfter.page).toBe(1);
      expect(stateAfter._filterTrigger).toBe(triggerBefore + 1);
    });

    it("switchToTable 恢复相同默认状态后 setWhereClause 仍应递增 _filterTrigger", async () => {
      mockApi.queryTableData.mockResolvedValue({ ...mockQueryResult, total: 0 });
      mockApi.queryTableCount.mockResolvedValue(100);
      useTableDataStore.getState().loadData("conn-1", "mydb", "users");
      await vi.waitFor(
        () => expect(useTableDataStore.getState().dataLoading).toBe(false),
        { timeout: 2000 }
      );

      useTableDataStore.getState().switchToTable("conn-1", "mydb", "posts");
      mockApi.queryTableData.mockResolvedValue({
        columns: ["id", "title"],
        rows: [[1, "Hello"]],
        total: 0,
        execution_time_ms: 3,
      });
      mockApi.queryTableCount.mockResolvedValue(1);
      useTableDataStore.getState().loadData("conn-1", "mydb", "posts");
      await vi.waitFor(
        () => expect(useTableDataStore.getState().dataLoading).toBe(false),
        { timeout: 2000 }
      );

      // 两张表都是默认状态 (page=1, whereClause="")，switchToTable 不会改变这些值
      const fromCache = useTableDataStore.getState().switchToTable("conn-1", "mydb", "users");
      expect(fromCache).toBe(true);
      expect(useTableDataStore.getState().whereClause).toBe("");
      expect(useTableDataStore.getState().page).toBe(1);

      // setWhereClause 必须正常工作
      const triggerBefore = useTableDataStore.getState()._filterTrigger;
      useTableDataStore.getState().setWhereClause("`status` = 1");

      const stateAfter = useTableDataStore.getState();
      expect(stateAfter.whereClause).toBe("`status` = 1");
      expect(stateAfter._filterTrigger).toBe(triggerBefore + 1);
      expect(stateAfter.page).toBe(1);
    });

    it("removeTableFromCache 应移除指定表的缓存", async () => {
      mockApi.queryTableData.mockResolvedValue({ ...mockQueryResult, total: 0 });
      mockApi.queryTableCount.mockResolvedValue(100);
      useTableDataStore.getState().loadData("conn-1", "mydb", "users");
      await vi.waitFor(
        () => expect(useTableDataStore.getState().dataLoading).toBe(false),
        { timeout: 2000 }
      );

      useTableDataStore.getState().removeTableFromCache("conn-1", "mydb", "users");
      const state = useTableDataStore.getState();
      expect(state.tableDataCache["conn-1|mydb|users"]).toBeUndefined();
      expect(state.activeTableKey).toBeNull();
      expect(state.columns).toEqual([]);
    });
  });

  describe("afterTableDataCleared", () => {
    it("清除其它表的 count / 行缓存且不发 query", async () => {
      mockApi.queryTableData.mockResolvedValue(mockQueryResult);
      mockApi.queryTableCount.mockResolvedValue(100);
      useTableDataStore.getState().loadData("conn-1", "mydb", "users");
      await vi.waitFor(
        () => expect(useTableDataStore.getState().dataLoading).toBe(false),
        { timeout: 2000 }
      );
      const usersCountKeys = Object.keys(
        useTableDataStore.getState().countCache
      ).filter((k) => k.startsWith("conn-1|mydb|users|"));
      expect(usersCountKeys.length).toBeGreaterThan(0);
      expect(
        useTableDataStore.getState().tableDataCache["conn-1|mydb|users"]
      ).toBeDefined();

      const callN = mockApi.queryTableData.mock.calls.length;
      useTableDataStore.getState().afterTableDataCleared("conn-1", "mydb", "posts");

      expect(mockApi.queryTableData.mock.calls.length).toBe(callN);
      expect(
        Object.keys(useTableDataStore.getState().countCache).some((k) =>
          k.startsWith("conn-1|mydb|users|")
        )
      ).toBe(true);
      expect(
        useTableDataStore.getState().tableDataCache["conn-1|mydb|users"]
      ).toBeDefined();
    });

    it("应移除被清空表自身的快照缓存", async () => {
      mockApi.queryTableData.mockResolvedValue(mockQueryResult);
      mockApi.queryTableCount.mockResolvedValue(100);
      useTableDataStore.getState().loadData("conn-1", "mydb", "users");
      await vi.waitFor(
        () => expect(useTableDataStore.getState().dataLoading).toBe(false),
        { timeout: 2000 }
      );
      expect(
        useTableDataStore.getState().tableDataCache["conn-1|mydb|users"]
      ).toBeDefined();

      useTableDataStore.setState({ activeTableKey: "conn-1|mydb|other" });
      useTableDataStore.getState().afterTableDataCleared("conn-1", "mydb", "users");

      expect(
        useTableDataStore.getState().tableDataCache["conn-1|mydb|users"]
      ).toBeUndefined();
    });

    it("当前激活表应重新 loadData", async () => {
      mockApi.queryTableData.mockResolvedValue(mockQueryResult);
      mockApi.queryTableCount.mockResolvedValue(100);
      useTableDataStore.getState().loadData("conn-1", "mydb", "users");
      await vi.waitFor(
        () => expect(useTableDataStore.getState().dataLoading).toBe(false),
        { timeout: 2000 }
      );
      const prevN = mockApi.queryTableData.mock.calls.length;

      mockApi.queryTableData.mockResolvedValue({
        ...mockQueryResult,
        rows: [],
        total: 0,
      });
      mockApi.queryTableCount.mockResolvedValue(0);

      useTableDataStore.getState().afterTableDataCleared("conn-1", "mydb", "users");

      await vi.waitFor(() => {
        expect(mockApi.queryTableData.mock.calls.length).toBeGreaterThan(prevN);
      });
    });
  });

  describe("reset", () => {
    it("应该重置所有状态", () => {
      useTableDataStore.setState({
        columns: ["id"],
        rows: [[1]],
        total: 10,
        page: 3,
        sortFields: [{ column: "id", order: "ASC" }],
        dataError: "error",
        lastSelectColumns: ["id", "name"],
      });

      useTableDataStore.getState().reset();

      const state = useTableDataStore.getState();
      expect(state.columns).toEqual([]);
      expect(state.rows).toEqual([]);
      expect(state.total).toBe(0);
      expect(state.page).toBe(1);
      expect(state.sortFields).toEqual([]);
      expect(state.dataError).toBeNull();
      expect(state.lastSelectColumns).toBeUndefined();
    });
  });

  describe("removeConnectionCache", () => {
    it("只清理指定连接缓存并保留其他连接数据", () => {
      useTableDataStore.setState({
        activeTableKey: "conn-2|db2|posts",
        tableDataCache: {
          "conn-1|db1|users": {
            columns: ["id"],
            rows: [[1]],
            total: 1,
            page: 1,
            pageSize: 50,
            sortFields: [],
            whereClause: "",
            filterRows: [],
            dataError: null,
            executionTime: 5,
            lastSelectColumns: undefined,
          },
          "conn-2|db2|posts": {
            columns: ["id"],
            rows: [[2]],
            total: 1,
            page: 1,
            pageSize: 50,
            sortFields: [],
            whereClause: "",
            filterRows: [],
            dataError: null,
            executionTime: 6,
            lastSelectColumns: undefined,
          },
        },
        countCache: {
          "conn-1|db1|users|": 1,
          "conn-2|db2|posts|": 1,
        },
      });

      useTableDataStore.getState().removeConnectionCache("conn-1");

      const state = useTableDataStore.getState();
      expect(state.tableDataCache["conn-1|db1|users"]).toBeUndefined();
      expect(state.countCache["conn-1|db1|users|"]).toBeUndefined();
      expect(state.tableDataCache["conn-2|db2|posts"]).toBeDefined();
      expect(state.countCache["conn-2|db2|posts|"]).toBe(1);
      expect(state.activeTableKey).toBe("conn-2|db2|posts");
    });
  });
});
