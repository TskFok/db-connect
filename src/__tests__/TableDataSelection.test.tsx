import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { TableData } from "../components/table/TableData";
import { resetTableSlotHeightModuleCacheForTests } from "../components/table/tableDataUtils";
import { TableContent } from "../components/table/TableContent";
import { useConnectionStore } from "../stores/connectionStore";
import { emptyConnState, useDatabaseStore } from "../stores/databaseStore";
import { useTableDataStore } from "../stores/tableDataStore";
import { useTableColumnSettingsStore } from "../stores/tableColumnSettingsStore";
import * as api from "../services/tauriCommands";

vi.mock("../services/tauriCommands", () => ({
  queryTableData: vi.fn(),
  queryTableCount: vi.fn(),
  queryFullRows: vi.fn(),
  insertRow: vi.fn(),
  updateRow: vi.fn(),
  batchUpdateRows: vi.fn(),
  deleteRows: vi.fn(),
  listDatabases: vi.fn(),
  listTables: vi.fn(),
  getTableStructure: vi.fn(),
  getDatabaseInfo: vi.fn(),
  executeSql: vi.fn(),
  alterDatabaseCharset: vi.fn(),
  createDatabase: vi.fn(),
  dropDatabase: vi.fn(),
  renameDatabase: vi.fn(),
  renameTable: vi.fn(),
  alterTableEngine: vi.fn(),
  alterColumn: vi.fn(),
  addColumn: vi.fn(),
  dropColumn: vi.fn(),
  createTable: vi.fn(),
  dropTable: vi.fn(),
  truncateTable: vi.fn(),
  getPrimaryKeys: vi.fn(),
  listSavedConnections: vi.fn(),
  saveConnection: vi.fn(),
  deleteSavedConnection: vi.fn(),
  testConnection: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  getTableColumnSettings: vi.fn(),
  saveTableColumnSettings: vi.fn(),
  deleteTableColumnSettings: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));

import { writeText } from "@tauri-apps/plugin-clipboard-manager";

const mockApi = vi.mocked(api);
const mockedWriteText = vi.mocked(writeText);

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
  {
    name: "name",
    column_type: "varchar(255)",
    nullable: true,
    key: "",
    default_value: null,
    extra: "",
    comment: "",
  },
];

const postsStructure = [
  {
    name: "id",
    column_type: "bigint",
    nullable: false,
    key: "PRI",
    default_value: null,
    extra: "",
    comment: "",
  },
  {
    name: "title",
    column_type: "varchar(255)",
    nullable: true,
    key: "",
    default_value: null,
    extra: "",
    comment: "",
  },
];

const commentsStructure = [
  {
    name: "content",
    column_type: "text",
    nullable: true,
    key: "",
    default_value: null,
    extra: "",
    comment: "",
  },
  {
    name: "category",
    column_type: "varchar(32)",
    nullable: true,
    key: "",
    default_value: null,
    extra: "",
    comment: "",
  },
];

const usersSnapshot = {
  columns: ["id", "name"],
  rows: [
    [1, "Alice"],
    [2, "Bob"],
  ],
  total: 2,
  page: 1,
  pageSize: 50,
  sortFields: [],
  whereClause: "",
  filterRows: [],
  dataError: null,
  executionTime: 10,
  lastSelectColumns: undefined,
};

const postsSnapshot = {
  columns: ["id", "title"],
  rows: [
    [1, "Post A"],
    [2, "Post B"],
  ],
  total: 2,
  page: 1,
  pageSize: 50,
  sortFields: [],
  whereClause: "",
  filterRows: [],
  dataError: null,
  executionTime: 12,
  lastSelectColumns: undefined,
};

const commentsSnapshot = {
  columns: ["content", "category"],
  rows: [
    ["Comment A", "audit"],
    ["Comment B", "event"],
  ],
  total: 2,
  page: 1,
  pageSize: 50,
  sortFields: [],
  whereClause: "",
  filterRows: [],
  dataError: null,
  executionTime: 14,
  lastSelectColumns: undefined,
};

function switchToTable(
  table: "users" | "posts" | "comments",
  structure: typeof usersStructure | typeof postsStructure | typeof commentsStructure
) {
  useDatabaseStore.setState({
    selectedTable: table,
    tableStructure: structure,
    selectedTableInfo: {
      name: table,
      table_type: "TABLE",
      engine: "InnoDB",
      rows: 2,
      data_length: 0, index_length: null,
      comment: "",
    },
  });
}

describe("TableData 行勾选隔离", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();

    if (!("ResizeObserver" in globalThis)) {
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observe() {}
          disconnect() {}
        }
      );
    }

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
      const style = elt instanceof HTMLElement ? elt.style : ({} as CSSStyleDeclaration);
      return {
        ...style,
        getPropertyValue: vi.fn(() => ""),
      } as CSSStyleDeclaration;
    });

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
        rows: 2,
        data_length: 0, index_length: null,
        comment: "",
      },
      tableContentActiveTab: "data",
    });

    useTableDataStore.getState().reset();
    useTableDataStore.setState({
      activeTableKey: "conn-1|mydb|users",
      tableDataCache: {
        "conn-1|mydb|users": usersSnapshot,
        "conn-1|mydb|posts": postsSnapshot,
        "conn-1|mydb|comments": commentsSnapshot,
      },
      rowSelectionCache: {},
      countCache: {},
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
    });

    useTableColumnSettingsStore.setState({ settings: {} });

    // 筛选“保存并应用”会触发一次 loadData -> queryTableData；这里提供一个稳定的 mock，避免未处理 promise
    mockApi.queryTableData.mockImplementation(async (...args: unknown[]) => {
      const table =
        typeof args[0] === "object" && args[0] !== null
          ? (args[0] as { table?: string }).table
          : (args[2] as string | undefined);
      if (table === "users") return usersSnapshot as never;
      if (table === "posts") return postsSnapshot as never;
      if (table === "comments") return commentsSnapshot as never;
      return usersSnapshot as never;
    });
    mockApi.queryTableCount.mockResolvedValue(2 as never);
    mockApi.batchUpdateRows.mockResolvedValue(1 as never);
  });

  afterEach(() => {
    resetTableSlotHeightModuleCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("切换到其他表标签时不应保留前一个表的勾选，切回后应恢复原勾选", async () => {
    const { container } = render(<TableData />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    const getBodyCheckboxes = () =>
      Array.from(
        container.querySelectorAll(".virtual-data-table-row .ant-checkbox-input")
      ) as HTMLInputElement[];

    await waitFor(() => {
      expect(getBodyCheckboxes().length).toBeGreaterThan(0);
    });

    fireEvent.click(getBodyCheckboxes()[0]!);

    await waitFor(() => {
      expect(screen.getByLabelText("删除选中的 1 行")).toBeInTheDocument();
    });

    act(() => switchToTable("posts", postsStructure));

    await waitFor(() => {
      expect(screen.getByText("Post A")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.queryByLabelText("删除选中的 1 行")).not.toBeInTheDocument();
    });

    expect(getBodyCheckboxes().every((checkbox) => !checkbox.checked)).toBe(true);

    act(() => switchToTable("users", usersStructure));

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByLabelText("删除选中的 1 行")).toBeInTheDocument();
    });

    expect(getBodyCheckboxes()[0]?.checked).toBe(true);
  });

  it("切换到其他表标签后再切回，应恢复原表未提交的单元格修改", async () => {
    render(<TableData />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    fireEvent.doubleClick(screen.getByText("Alice"));
    const input = await screen.findByDisplayValue("Alice");
    fireEvent.change(input, { target: { value: "Alicia" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(screen.getByText("Alicia")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /提交修改/ })).toBeInTheDocument();
    });

    act(() => switchToTable("posts", postsStructure));

    await waitFor(() => {
      expect(screen.getByText("Post A")).toBeInTheDocument();
      expect(screen.queryByText("Alicia")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        useTableDataStore
          .getState()
          .getPendingChangesForTable("conn-1", "mydb", "users").size
      ).toBe(1);
      expect(
        useTableDataStore
          .getState()
          .getPendingChangesForTable("conn-1", "mydb", "posts").size
      ).toBe(0);
    });

    act(() => switchToTable("users", usersStructure));

    await waitFor(() => {
      expect(
        useTableDataStore
          .getState()
          .getPendingChangesForTable("conn-1", "mydb", "users").size
      ).toBe(1);
      expect(screen.getByText("Alicia")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /提交修改/ })).toBeInTheDocument();
    });
  });

  it("当前表已有筛选条件时，切换到其他表标签后再切回仍应保留未提交修改", async () => {
    const filteredRows = [
      { column: "id", operator: "=" as const, value: "1", enabled: true },
    ];
    const filteredUsersSnapshot = {
      ...usersSnapshot,
      total: 1,
      whereClause: "`id` = 1",
      filterRows: filteredRows,
    };
    useTableDataStore.setState((s) => {
      const tableDataCache = { ...s.tableDataCache };
      delete tableDataCache["conn-1|mydb|posts"];
      return {
        tableDataCache: {
          ...tableDataCache,
          "conn-1|mydb|users": filteredUsersSnapshot,
        },
        columns: filteredUsersSnapshot.columns,
        rows: filteredUsersSnapshot.rows,
        total: filteredUsersSnapshot.total,
        whereClause: filteredUsersSnapshot.whereClause,
        filterRows: filteredUsersSnapshot.filterRows,
      };
    });

    let view = render(<TableData />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.getByLabelText("查看筛选后的查询 SQL")).toBeInTheDocument();
    });

    fireEvent.doubleClick(screen.getByText("Alice"));
    const input = await screen.findByDisplayValue("Alice");
    fireEvent.change(input, { target: { value: "Alicia" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(screen.getByText("Alicia")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /提交修改/ })).toBeInTheDocument();
    });

    act(() => switchToTable("posts", postsStructure));
    view.unmount();
    view = render(<TableData />);

    await waitFor(() => {
      expect(screen.getByText("Post A")).toBeInTheDocument();
      expect(screen.queryByText("Alicia")).not.toBeInTheDocument();
    });

    act(() => switchToTable("users", usersStructure));
    view.unmount();
    view = render(<TableData />);

    await waitFor(() => {
      expect(screen.getByLabelText("查看筛选后的查询 SQL")).toBeInTheDocument();
      expect(screen.getByText("Alicia")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /提交修改/ })).toBeInTheDocument();
    });
    view.unmount();
  });

  it("通过顶部表标签切换时，筛选状态下仍应恢复未提交修改", async () => {
    const filteredRows = [
      { column: "id", operator: "=" as const, value: "1", enabled: true },
    ];
    const filteredUsersSnapshot = {
      ...usersSnapshot,
      total: 1,
      whereClause: "`id` = 1",
      filterRows: filteredRows,
    };
    const tableInfos = {
      "mydb|users": {
        name: "users",
        table_type: "TABLE" as const,
        engine: "InnoDB",
        rows: 2,
        data_length: 0, index_length: null,
        comment: "",
      },
      "mydb|posts": {
        name: "posts",
        table_type: "TABLE" as const,
        engine: "InnoDB",
        rows: 2,
        data_length: 0, index_length: null,
        comment: "",
      },
    };

    useDatabaseStore.setState({
      connectionStates: {
        "conn-1": {
          ...emptyConnState(),
          tables: {
            mydb: [
              tableInfos["mydb|users"],
              tableInfos["mydb|posts"],
            ],
          },
          openTabs: [
            { type: "table", database: "mydb", table: "users" },
            { type: "table", database: "mydb", table: "posts" },
          ],
          openTables: [
            { database: "mydb", table: "users" },
            { database: "mydb", table: "posts" },
          ],
          activeTabIndex: 0,
          activeTableTabIndex: 0,
          tableStructures: {
            "mydb|users": usersStructure,
            "mydb|posts": postsStructure,
          },
          tableInfos,
          selectedDatabase: "mydb",
          selectedTable: "users",
          tableStructure: usersStructure,
          selectedTableInfo: tableInfos["mydb|users"],
        },
      },
      openTabs: [
        { type: "table", database: "mydb", table: "users" },
        { type: "table", database: "mydb", table: "posts" },
      ],
      openTables: [
        { database: "mydb", table: "users" },
        { database: "mydb", table: "posts" },
      ],
      activeTabIndex: 0,
      activeTableTabIndex: 0,
      tableInfos,
    });
    useTableDataStore.setState({
      activeTableKey: "conn-1|mydb|users",
      tableDataCache: {
        "conn-1|mydb|users": filteredUsersSnapshot,
        "conn-1|mydb|posts": postsSnapshot,
      },
      columns: filteredUsersSnapshot.columns,
      rows: filteredUsersSnapshot.rows,
      total: filteredUsersSnapshot.total,
      page: filteredUsersSnapshot.page,
      pageSize: filteredUsersSnapshot.pageSize,
      sortFields: filteredUsersSnapshot.sortFields,
      whereClause: filteredUsersSnapshot.whereClause,
      filterRows: filteredUsersSnapshot.filterRows,
      _filterTrigger: 1,
    });

    render(<TableContent />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.getByLabelText("查看筛选后的查询 SQL")).toBeInTheDocument();
    });

    fireEvent.doubleClick(screen.getByText("Alice"));
    const input = await screen.findByDisplayValue("Alice");
    fireEvent.change(input, { target: { value: "Alicia" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(screen.getByText("Alicia")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /提交修改/ })).toBeInTheDocument();
      expect(
        useTableDataStore
          .getState()
          .getPendingChangesForTable("conn-1", "mydb", "users").size
      ).toBe(1);
    });

    act(() => {
      useDatabaseStore.getState().switchTab("conn-1", 1);
    });

    await waitFor(() => {
      expect(screen.getByText("Post A")).toBeInTheDocument();
      expect(screen.queryByText("Alicia")).not.toBeInTheDocument();
      expect(
        useTableDataStore
          .getState()
          .getPendingChangesForTable("conn-1", "mydb", "users").size
      ).toBe(1);
    });

    act(() => {
      useDatabaseStore.getState().switchTab("conn-1", 0);
    });

    await waitFor(() => {
      expect(screen.getByLabelText("查看筛选后的查询 SQL")).toBeInTheDocument();
      expect(
        useTableDataStore
          .getState()
          .getPendingChangesForTable("conn-1", "mydb", "users").size
      ).toBe(1);
      expect(screen.getByText("Alicia")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /提交修改/ })).toBeInTheDocument();
    });
  });

  it("单元格仍在编辑中时直接切换表标签，也应保留输入中的修改", async () => {
    render(<TableData />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    fireEvent.doubleClick(screen.getByText("Alice"));
    const input = await screen.findByDisplayValue("Alice");
    fireEvent.change(input, { target: { value: "Alicia" } });

    act(() => switchToTable("posts", postsStructure));

    await waitFor(() => {
      expect(screen.getByText("Post A")).toBeInTheDocument();
      expect(screen.queryByText("Alicia")).not.toBeInTheDocument();
    });

    act(() => switchToTable("users", usersStructure));

    await waitFor(() => {
      expect(screen.getByText("Alicia")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /提交修改/ })).toBeInTheDocument();
    });
  });

  it("提交成功后应清空当前表待提交修改缓存", async () => {
    render(<TableData />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    fireEvent.doubleClick(screen.getByText("Alice"));
    const input = await screen.findByDisplayValue("Alice");
    fireEvent.change(input, { target: { value: "Alicia" } });
    fireEvent.blur(input);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /提交修改/ })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: /提交修改/ }));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toHaveTextContent("Alicia");
    });

    fireEvent.click(screen.getByRole("button", { name: "全部提交" }));

    await waitFor(() => {
      expect(mockApi.batchUpdateRows).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        [{ primaryKeys: { id: 1 }, updates: { name: "Alicia" } }]
      );
      expect(screen.queryByRole("button", { name: /提交修改/ })).not.toBeInTheDocument();
    });

    expect(
      useTableDataStore
        .getState()
        .getPendingChangesForTable("conn-1", "mydb", "users").size
    ).toBe(0);
  });

  it("经过表C和组件重挂载后，切回表A仍应恢复原勾选", async () => {
    let view = render(<TableData />);

    const getBodyCheckboxes = () =>
      Array.from(
        view.container.querySelectorAll(".virtual-data-table-row .ant-checkbox-input")
      ) as HTMLInputElement[];

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(getBodyCheckboxes().length).toBeGreaterThan(0);
    });

    fireEvent.click(getBodyCheckboxes()[0]!);

    await waitFor(() => {
      expect(screen.getByLabelText("删除选中的 1 行")).toBeInTheDocument();
    });

    act(() => switchToTable("posts", postsStructure));
    await waitFor(() => {
      expect(screen.getByText("Post A")).toBeInTheDocument();
    });

    view.unmount();
    view = render(<TableData />);

    await waitFor(() => {
      expect(screen.getByText("Post A")).toBeInTheDocument();
    });

    act(() => switchToTable("comments", commentsStructure));
    await waitFor(() => {
      expect(screen.getByText("Comment A")).toBeInTheDocument();
    });

    view.unmount();
    view = render(<TableData />);

    await waitFor(() => {
      expect(screen.getByText("Comment A")).toBeInTheDocument();
    });

    act(() => switchToTable("users", usersStructure));
    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
      expect(screen.getByLabelText("删除选中的 1 行")).toBeInTheDocument();
    });
    expect(screen.queryByText("Comment A")).not.toBeInTheDocument();

    const restoredCheckboxes = Array.from(
      view.container.querySelectorAll(".virtual-data-table-row .ant-checkbox-input")
    ) as HTMLInputElement[];
    expect(restoredCheckboxes[0]?.checked).toBe(true);
  });

  it("数据表格高度可拖拽改变并持久化到 localStorage，双击 resize bar 重置", async () => {
    const { container } = render(<TableData />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    const resizeBar = container.querySelector(
      ".table-data-resize-bar"
    ) as HTMLElement;
    expect(resizeBar).toBeTruthy();

    // 拖拽：mousedown -> document mousemove(+120px) -> document mouseup
    fireEvent.mouseDown(resizeBar, { clientY: 100 });
    fireEvent(
      document,
      new MouseEvent("mousemove", { clientY: 220, bubbles: true })
    );
    fireEvent(
      document,
      new MouseEvent("mouseup", { clientY: 220, bubbles: true })
    );

    await waitFor(() => {
      const stored = localStorage.getItem("mysqlc:table-height-px");
      expect(stored).not.toBeNull();
      expect(Number.parseInt(stored!, 10)).toBeGreaterThanOrEqual(200);
    });

    // 拖拽后表格容器获得显式 height（手动模式）
    const tableContainer = container.querySelector(
      ".table-data-container"
    ) as HTMLElement;
    expect(tableContainer.style.height).not.toBe("");

    // 双击 resize bar 应重置为自动撑满（清除存储 + 容器去掉显式高度）
    fireEvent.doubleClick(resizeBar);
    await waitFor(() => {
      expect(localStorage.getItem("mysqlc:table-height-px")).toBeNull();
    });
    expect(tableContainer.style.height).toBe("");
  });

  it("筛选入口在列设置旁边：点击图标弹出筛选面板，保存后应用筛选", async () => {
    render(<TableData />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    // 打开筛选弹窗
    fireEvent.click(screen.getByLabelText("筛选"));

    await waitFor(() => {
      expect(screen.getByText("添加条件")).toBeInTheDocument();
      expect(screen.getByText("保存并应用")).toBeInTheDocument();
    });

    // 不做修改直接保存：也应关闭弹窗（应用空筛选等价于不筛选）
    fireEvent.click(screen.getByText("保存并应用"));

    await waitFor(() => {
      expect(screen.queryByText("保存并应用")).not.toBeInTheDocument();
    });
  });

  it("新增行弹窗应固定高度，并让表单内容单独滚动", async () => {
    render(<TableData />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByLabelText("新增行"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toHaveTextContent("新增行");
    });

    const dialogContent = document.querySelector(".ant-modal-content") as HTMLElement | null;
    const dialogBody = document.querySelector(".ant-modal-body") as HTMLElement | null;

    expect(dialogContent).not.toBeNull();
    expect(dialogBody).not.toBeNull();
    expect(dialogContent?.style.display).toBe("flex");
    expect(dialogContent?.style.flexDirection).toBe("column");
    expect(dialogContent?.style.height).toBe("calc(100vh - 48px)");
    expect(dialogContent?.style.maxHeight).toBe("720px");
    expect(dialogBody?.style.flex).toBe("1 1 auto");
    expect(dialogBody?.style.minHeight).toBe("0");
    expect(dialogBody?.style.overflowY).toBe("auto");
  });

  it("有筛选条件时：查询 SQL 不在表格上方内联展示，可通过旁侧图标弹窗查看并复制", async () => {
    const filteredUsersSnapshot = {
      ...usersSnapshot,
      whereClause: "`id` = 1",
    };
    useTableDataStore.setState((s) => ({
      tableDataCache: {
        ...s.tableDataCache,
        "conn-1|mydb|users": filteredUsersSnapshot,
      },
      whereClause: "`id` = 1",
    }));

    render(<TableData />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    expect(document.querySelector('[title="当前查询 SQL"]')).toBeNull();

    fireEvent.click(screen.getByLabelText("查看筛选后的查询 SQL"));

    await waitFor(() => {
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveTextContent("WHERE `id` = 1");
      expect(dialog).toHaveTextContent("mydb");
      expect(dialog).toHaveTextContent("users");
    });

    mockedWriteText.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "复制 SQL" }));

    await waitFor(() => {
      expect(mockedWriteText).toHaveBeenCalledWith(
        expect.stringContaining("WHERE `id` = 1")
      );
    });
  });

  it("点击表头复制按钮可复制对应字段名", async () => {
    render(<TableData />);

    await waitFor(() => {
      expect(screen.getByText("Alice")).toBeInTheDocument();
    });

    mockedWriteText.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "复制字段名 name" }));

    await waitFor(() => {
      expect(mockedWriteText).toHaveBeenCalledWith("name");
    });
  });
});
