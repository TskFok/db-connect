import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { TableData } from "../components/table/TableData";
import { resetTableSlotHeightModuleCacheForTests } from "../components/table/tableDataUtils";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";
import { useTableDataStore } from "../stores/tableDataStore";
import { useTableColumnSettingsStore } from "../stores/tableColumnSettingsStore";

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

function seedStores(overrides: Partial<ReturnType<typeof useTableDataStore.getState>> = {}) {
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

  beforeEach(() => {
    vi.clearAllMocks();
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
      const style = elt instanceof HTMLElement ? elt.style : ({} as CSSStyleDeclaration);
      return {
        ...style,
        getPropertyValue: vi.fn(() => ""),
      } as CSSStyleDeclaration;
    });
  });

  afterEach(() => {
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
    expect(screen.getByText("总数可能已变化，点击刷新分页更新")).toBeInTheDocument();
  });

  it("totalCountLoading 时应显示正在统计行数", async () => {
    seedStores();
    render(<TableData />);
    await act(async () => {
      useTableDataStore.setState({ totalCountLoading: true });
    });
    expect(screen.getByText("正在统计行数…")).toBeInTheDocument();
  });
});
