import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  act,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { TableData } from "../components/table/TableData";
import { resetTableSlotHeightModuleCacheForTests } from "../components/table/tableDataUtils";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";
import { useTableDataStore } from "../stores/tableDataStore";
import { useTableColumnSettingsStore } from "../stores/tableColumnSettingsStore";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as api from "../services/tauriCommands";

vi.mock("../services/tauriCommands", () => ({
  queryTableData: vi.fn(),
  queryTableCount: vi.fn(),
  queryFullRows: vi.fn(),
  insertRow: vi.fn(),
  updateRow: vi.fn(),
  deleteRows: vi.fn(),
  getTableColumnSettings: vi.fn(),
  saveTableColumnSettings: vi.fn(),
  deleteTableColumnSettings: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

const mockActiveConnection = {
  connId: "conn-1",
  config: {
    id: "saved-conn-1",
    name: "测试连接",
    host: "localhost",
    port: 3306,
    username: "root",
  },
};

const usersStructure = [
  {
    name: "id",
    column_type: "bigint",
    nullable: false,
    key: "PRI",
    default_value: null,
    extra: "",
    comment: "",
  },
];

const usersSnapshot = {
  columns: ["id"],
  rows: [[1]],
  total: 100,
  page: 1,
  pageSize: 50,
  sortFields: [],
  whereClause: "",
  filterRows: [],
  dataError: null,
  executionTime: 10,
  lastSelectColumns: undefined,
};

function seedStores(
  overrides: Partial<ReturnType<typeof useTableDataStore.getState>> = {}
) {
  useConnectionStore.setState({
    savedConnections: [],
    activeConnections: { "conn-1": mockActiveConnection },
    activeConnId: "conn-1",
    activeConnection: mockActiveConnection,
    loading: false,
    error: null,
    showConnectionForm: false,
    editingConnection: null,
  });

  useDatabaseStore.getState().reset();
  useDatabaseStore.setState({
    activeConnId: "conn-1",
    selectedDatabase: "mydb",
    selectedTable: "users",
    tableStructure: usersStructure,
    selectedTableInfo: {
      name: "users",
      table_type: "TABLE",
      engine: "InnoDB",
      rows: 1,
      data_length: 0,
      index_length: null,
      comment: "",
    },
    tableContentActiveTab: "data",
  });

  useTableDataStore.getState().reset();
  useTableDataStore.setState({
    activeTableKey: "conn-1|mydb|users",
    tableDataCache: { "conn-1|mydb|users": usersSnapshot },
    rowSelectionCache: {},
    countCache: { "conn-1|mydb|users|": 100 },
    columns: usersSnapshot.columns,
    rows: usersSnapshot.rows,
    total: usersSnapshot.total,
    page: usersSnapshot.page,
    pageSize: usersSnapshot.pageSize,
    sortFields: usersSnapshot.sortFields,
    whereClause: usersSnapshot.whereClause,
    filterRows: usersSnapshot.filterRows,
    dataLoading: false,
    totalCountLoading: false,
    totalCountStale: false,
    dataError: usersSnapshot.dataError,
    executionTime: usersSnapshot.executionTime,
    lastSelectColumns: usersSnapshot.lastSelectColumns,
    _filterTrigger: 0,
    ...overrides,
  });

  useTableColumnSettingsStore.setState({ settings: {} });
}

describe("TableData 分页栏", () => {
  const resizeObserverBeforeTest = globalThis.ResizeObserver;
  const originalSetPage = useTableDataStore.getState().setPage;

  beforeEach(() => {
    vi.clearAllMocks();
    useTableDataStore.setState({ setPage: originalSetPage });
    localStorage.clear();

    globalThis.ResizeObserver = class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
      constructor(_cb: ResizeObserverCallback) {}
    } as unknown as typeof ResizeObserver;

    if (!window.matchMedia) {
      vi.stubGlobal("matchMedia", () => ({
        matches: false,
        media: "",
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
    }

    vi.spyOn(window, "getComputedStyle").mockImplementation((elt: Element) => {
      const style =
        elt instanceof HTMLElement ? elt.style : ({} as CSSStyleDeclaration);
      return {
        ...style,
        getPropertyValue: vi.fn(() => ""),
      } as CSSStyleDeclaration;
    });
  });

  afterEach(() => {
    useTableDataStore.setState({ setPage: originalSetPage });
    globalThis.ResizeObserver = resizeObserverBeforeTest;
    resetTableSlotHeightModuleCacheForTests();
    vi.restoreAllMocks();
  });

  it("totalCountStale 时应显示总数可能已变化提示", () => {
    seedStores({
      totalCountStale: true,
      tableDataCache: {
        "conn-1|mydb|users": { ...usersSnapshot, totalCountStale: true },
      },
    });
    render(<TableData />);
    expect(
      screen.getByText("总数可能已变化，点击刷新分页更新")
    ).toBeInTheDocument();
  });

  it("totalCountLoading 时应显示正在统计行数", async () => {
    seedStores();
    render(<TableData />);
    await act(async () => {
      useTableDataStore.setState({ totalCountLoading: true });
    });
    expect(screen.getByText("正在统计行数…")).toBeInTheDocument();
  });

  it("上一页和下一页标记导航方向，数字页跳转保持 OFFSET", () => {
    const setPage = vi.fn();
    const snapshot = { ...usersSnapshot, page: 2, total: 500 };
    seedStores({
      page: 2,
      total: 500,
      setPage,
      tableDataCache: { "conn-1|mydb|users": snapshot },
    });
    const { container } = render(<TableData />);
    fireEvent.click(container.querySelector(".ant-pagination-next")!);
    expect(setPage).toHaveBeenLastCalledWith(3, "next");
    fireEvent.keyDown(container.querySelector(".ant-pagination-prev")!, {
      key: "Enter",
      keyCode: 13,
    });
    expect(setPage).toHaveBeenLastCalledWith(1, "previous");
    fireEvent.click(container.querySelector(".ant-pagination-item-3")!);
    expect(setPage).toHaveBeenLastCalledWith(3);

    const jumpInput = container.querySelector(
      ".ant-pagination-options-quick-jumper input"
    )!;
    fireEvent.change(jumpInput, { target: { value: "3" } });
    fireEvent.keyUp(jumpInput, { key: "Enter", keyCode: 13 });
    expect(setPage).toHaveBeenLastCalledWith(3);
  });

  it("加载期间禁用翻页，避免新页码使用旧边界", async () => {
    const setPage = vi.fn();
    seedStores({ setPage });
    const { container } = render(<TableData />);
    await act(async () => useTableDataStore.setState({ dataLoading: true }));
    fireEvent.click(container.querySelector(".ant-pagination-next")!);
    expect(setPage).not.toHaveBeenCalled();
  });

  it("真实 Store 串联前进、后退和跳页后的继续翻页", async () => {
    seedStores({ total: 150, countCache: { "conn-1|mydb|users|": 150 } });
    vi.mocked(api.queryTableData).mockImplementation(async (...args) => {
      const requestedPage = args[3];
      return {
        columns: ["id"],
        rows: Array.from({ length: 50 }, (_, i) => [
          (requestedPage - 1) * 50 + i + 1,
        ]),
        total: 0,
        execution_time_ms: 1,
        pagination: {
          mode: args[9] ? "keyset" : "offset",
          sort_column: "id",
          sort_order: "ASC",
          next_cursor: `page${requestedPage}-after`,
          previous_cursor: `page${requestedPage}-before`,
        },
        executed_sql: `SELECT * FROM users ORDER BY id LIMIT 50 OFFSET ${(requestedPage - 1) * 50}`,
      };
    });
    await act(async () => {
      await useTableDataStore.getState().loadData("conn-1", "mydb", "users");
    });
    const { container } = render(<TableData />);

    fireEvent.click(container.querySelector(".ant-pagination-next")!);
    await waitFor(() =>
      expect(useTableDataStore.getState().rows[0]).toEqual([51])
    );
    expect(vi.mocked(api.queryTableData).mock.lastCall?.[9]).toEqual({
      direction: "next",
      cursor: "page1-after",
    });

    fireEvent.click(container.querySelector(".ant-pagination-prev")!);
    await waitFor(() =>
      expect(useTableDataStore.getState().rows[0]).toEqual([1])
    );
    expect(vi.mocked(api.queryTableData).mock.lastCall?.[9]).toEqual({
      direction: "previous",
      cursor: "page2-before",
    });

    fireEvent.click(container.querySelector(".ant-pagination-item-2")!);
    await waitFor(() =>
      expect(useTableDataStore.getState().rows[0]).toEqual([51])
    );
    expect(vi.mocked(api.queryTableData).mock.lastCall?.[9]).toBeUndefined();

    fireEvent.click(container.querySelector(".ant-pagination-next")!);
    await waitFor(() =>
      expect(useTableDataStore.getState().rows[0]).toEqual([101])
    );
    expect(vi.mocked(api.queryTableData).mock.lastCall?.[9]).toEqual({
      direction: "next",
      cursor: "page2-after",
    });
    expect(useTableDataStore.getState().page).toBe(3);
    expect(api.queryTableCount).not.toHaveBeenCalled();
  });

  it("无筛选时也能查看并复制后端返回的实际游标 SQL", async () => {
    const executedSql =
      "SELECT * FROM `mydb`.`users` WHERE `id` > 9007199254740993 ORDER BY `id` ASC LIMIT 50";
    seedStores({
      executedSql,
      tableDataCache: {
        "conn-1|mydb|users": { ...usersSnapshot, executedSql },
      },
    });
    render(<TableData />);
    fireEvent.click(screen.getByLabelText("查看当前查询 SQL"));
    expect(screen.getByRole("dialog")).toHaveTextContent(executedSql);
    fireEvent.click(screen.getByRole("button", { name: "复制 SQL" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(executedSql));
  });

  it("筛选徽标应预留完整轮廓所需的纵向偏移", () => {
    const filterRows = [{ column: "id", operator: "=" as const, value: "1" }];
    const filteredSnapshot = {
      ...usersSnapshot,
      whereClause: "`id` = 1",
      filterRows,
    };
    seedStores({
      whereClause: filteredSnapshot.whereClause,
      filterRows,
      tableDataCache: { "conn-1|mydb|users": filteredSnapshot },
    });

    const { container } = render(<TableData />);
    const indicator = container.querySelector(
      ".table-data-filter-badge .ant-badge-count"
    );

    expect(indicator).toBeInTheDocument();
    expect((indicator as HTMLElement).style.marginTop).toBe("8px");
  });

  it("提交修改徽标应预留完整轮廓所需的纵向偏移", () => {
    seedStores({
      pendingChangesCache: {
        "conn-1|mydb|users": {
          'id=1|col="name"': {
            rowKey: 0,
            colName: "name",
            oldValue: "Alice",
            newValue: "Alicia",
            primaryKeys: { id: 1 },
          },
        },
      },
    });

    render(<TableData />);
    const submitButton = screen.getByRole("button", { name: /提交修改/ });
    const indicator = submitButton
      .closest(".ant-badge")
      ?.querySelector(".ant-badge-count");

    expect(indicator).toBeInTheDocument();
    expect((indicator as HTMLElement).style.marginTop).toBe("8px");
  });
});
