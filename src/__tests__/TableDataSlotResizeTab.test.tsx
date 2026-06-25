import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act } from "@testing-library/react";
import { TableData } from "../components/table/TableData";
import { resetTableSlotHeightModuleCacheForTests } from "../components/table/tableDataUtils";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";
import { useTableDataStore } from "../stores/tableDataStore";
import { useTableColumnSettingsStore } from "../stores/tableColumnSettingsStore";
import * as api from "../services/tauriCommands";

vi.mock("../services/tauriCommands", () => ({
  queryTableData: vi.fn(),
  queryTableCount: vi.fn(),
  queryFullRows: vi.fn(),
  insertRow: vi.fn(),
  updateRow: vi.fn(),
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

const mockApi = vi.mocked(api);

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

describe("TableData slot 高度：Tab 切换与 ResizeObserver", () => {
  const observeSpy = vi.fn();
  const disconnectSpy = vi.fn();

  const resizeObserverBeforeTest = globalThis.ResizeObserver;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();

    globalThis.ResizeObserver = class {
      observe = observeSpy;
      unobserve = vi.fn();
      disconnect = disconnectSpy;
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

    mockApi.queryTableData.mockResolvedValue(usersSnapshot as never);
    mockApi.queryTableCount.mockResolvedValue(2 as never);

    observeSpy.mockClear();
    disconnectSpy.mockClear();
  });

  afterEach(() => {
    globalThis.ResizeObserver = resizeObserverBeforeTest;
    resetTableSlotHeightModuleCacheForTests();
    vi.restoreAllMocks();
  });

  it("离开数据 Tab 时 disconnect，回到数据 Tab 时重新 observe（避免隐藏面板污染高度）", () => {
    render(<TableData />);

    expect(observeSpy).toHaveBeenCalled();

    act(() => useDatabaseStore.setState({ tableContentActiveTab: "structure" }));

    expect(disconnectSpy).toHaveBeenCalled();

    observeSpy.mockClear();
    disconnectSpy.mockClear();

    act(() => useDatabaseStore.setState({ tableContentActiveTab: "data" }));

    expect(observeSpy).toHaveBeenCalled();
  });
});
