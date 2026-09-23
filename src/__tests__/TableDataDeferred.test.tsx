import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { TableData } from "../components/table/TableData";
import { resetTableSlotHeightModuleCacheForTests } from "../components/table/tableDataUtils";
import * as api from "../services/tauriCommands";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";
import { useTableDataStore } from "../stores/tableDataStore";
import { useTableColumnSettingsStore } from "../stores/tableColumnSettingsStore";
import * as excelExport from "../utils/excelExport";

vi.mock("../services/tauriCommands");
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../utils/excelExport", () => ({
  assertCsvRowWithinLimit: vi.fn(),
  buildQueryResultWorkbookBase64: vi.fn().mockResolvedValue("xlsx-base64"),
  saveExcelWithDialog: vi.fn().mockResolvedValue(true),
}));

import { writeText } from "@tauri-apps/plugin-clipboard-manager";

const mockApi = vi.mocked(api);
const mockedWriteText = vi.mocked(writeText);
const mockedBuildWorkbook = vi.mocked(
  excelExport.buildQueryResultWorkbookBase64
);

const connId = "conn-deferred";
const database = "mydb";
const table = "articles";
const tableKey = `${connId}|${database}|${table}`;

const fullBody1 = `${"第一行完整正文".repeat(30)}-ONE`;
const fullBody2 = `${"第二行完整正文".repeat(30)}-TWO`;
const previewBody1 = "第一行预览…";
const previewBody2 = "第二行预览…";

const deferredBody1 = {
  __deferred_field: true as const,
  preview: previewBody1,
  byte_length: 8192,
  kind: "text" as const,
};
const deferredBody2 = {
  __deferred_field: true as const,
  preview: previewBody2,
  byte_length: 8192,
  kind: "text" as const,
};

const structure = [
  {
    name: "id",
    column_type: "bigint",
    nullable: false,
    key: "PRI",
    default_value: null,
    extra: "auto_increment",
    comment: "",
  },
  {
    name: "body",
    column_type: "longtext",
    nullable: true,
    key: "",
    default_value: null,
    extra: "",
    comment: "",
  },
  {
    name: "title",
    column_type: "varchar(255)",
    nullable: false,
    key: "",
    default_value: null,
    extra: "",
    comment: "",
  },
];

const snapshot = {
  columns: ["id", "body", "title"],
  rows: [
    [1, deferredBody1, "标题一"],
    [2, deferredBody2, "标题二"],
  ],
  total: 2,
  page: 1,
  pageSize: 50,
  sortFields: [],
  whereClause: "",
  filterRows: [],
  dataError: null,
  executionTime: 5,
  lastSelectColumns: undefined,
};

function fullRowsResult(rows: unknown[][]) {
  return {
    columns: ["id", "body"],
    rows,
    total: rows.length,
    execution_time_ms: 3,
  };
}

function getPendingChanges() {
  return useTableDataStore
    .getState()
    .getPendingChangesForTable(connId, database, table);
}

async function selectRows(container: HTMLElement, count: number) {
  await screen.findByText(previewBody1);
  const checkboxes = Array.from(
    container.querySelectorAll(".virtual-data-table-row .ant-checkbox-input")
  ) as HTMLInputElement[];
  expect(checkboxes.length).toBeGreaterThanOrEqual(count);
  for (let index = 0; index < count; index += 1) {
    fireEvent.click(checkboxes[index]!);
  }
}

describe("TableData 大字段按需加载", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    mockedWriteText.mockResolvedValue(undefined);
    mockedBuildWorkbook.mockResolvedValue("xlsx-base64");
    vi.mocked(excelExport.saveExcelWithDialog).mockResolvedValue(true);

    useConnectionStore.setState({
      savedConnections: [],
      activeConnections: {
        [connId]: {
          connId,
          config: {
            id: "saved-deferred",
            name: "延迟字段测试",
            host: "localhost",
            port: 3306,
            username: "root",
            database_type: "mysql",
          },
        },
      },
      activeConnId: connId,
      activeConnection: {
        connId,
        config: {
          id: "saved-deferred",
          name: "延迟字段测试",
          host: "localhost",
          port: 3306,
          username: "root",
          database_type: "mysql",
        },
      },
      loading: false,
      error: null,
      showConnectionForm: false,
      editingConnection: null,
    });

    useDatabaseStore.getState().reset();
    useDatabaseStore.setState({
      activeConnId: connId,
      selectedDatabase: database,
      selectedTable: table,
      tableStructure: structure,
      selectedTableInfo: {
        name: table,
        table_type: "TABLE",
        engine: "InnoDB",
        rows: 2,
        data_length: 0,
        index_length: null,
        comment: "",
      },
      tableContentActiveTab: "data",
    });

    useTableDataStore.getState().reset();
    useTableDataStore.setState({
      ...snapshot,
      activeTableKey: tableKey,
      tableDataCache: { [tableKey]: snapshot },
      rowSelectionCache: {},
      countCache: {},
      pendingChangesCache: {},
      dataLoading: false,
      totalCountLoading: false,
      totalCountStale: false,
      _filterTrigger: 0,
    });
    useTableColumnSettingsStore.setState({ settings: {} });

    mockApi.queryTableData.mockResolvedValue({
      ...snapshot,
      execution_time_ms: 5,
    });
    mockApi.queryTableCount.mockResolvedValue(2);
    mockApi.batchUpdateRows.mockResolvedValue(1);
  });

  afterEach(() => {
    resetTableSlotHeightModuleCacheForTests();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("双击延迟字段先加载完整值，修改后以完整原值记录 pending", async () => {
    mockApi.queryFullRows.mockResolvedValue(fullRowsResult([[1, fullBody1]]));
    render(<TableData />);

    fireEvent.doubleClick(await screen.findByText(previewBody1));
    const dialog = await screen.findByRole("dialog", { name: "编辑：body" });
    const input = within(dialog).getByRole("textbox");
    expect(input).toHaveValue(fullBody1);

    fireEvent.change(input, { target: { value: `${fullBody1}-已修改` } });
    fireEvent.click(within(dialog).getByRole("button", { name: /确\s*定/ }));

    await waitFor(() => {
      expect(Array.from(getPendingChanges().values())).toEqual([
        expect.objectContaining({
          colName: "body",
          oldValue: fullBody1,
          newValue: `${fullBody1}-已修改`,
          primaryKeys: { id: 1 },
        }),
      ]);
    });
    expect(mockApi.queryFullRows.mock.calls).toEqual([
      [connId, database, table, "id", [1], undefined, ["body"]],
    ]);
  });

  it("完整值加载后未修改直接确认，不产生 pending", async () => {
    mockApi.queryFullRows.mockResolvedValue(fullRowsResult([[1, fullBody1]]));
    render(<TableData />);

    fireEvent.doubleClick(await screen.findByText(previewBody1));
    const dialog = await screen.findByRole("dialog", { name: "编辑：body" });
    expect(within(dialog).getByRole("textbox")).toHaveValue(fullBody1);
    fireEvent.click(within(dialog).getByRole("button", { name: /确\s*定/ }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(getPendingChanges().size).toBe(0);
  });

  it("复制两行 JSON 只批量请求一次，剪贴板只包含完整值", async () => {
    mockApi.queryFullRows.mockResolvedValue(
      fullRowsResult([
        [1, fullBody1],
        [2, fullBody2],
      ])
    );
    const { container } = render(<TableData />);
    await selectRows(container, 2);

    fireEvent.click(screen.getByRole("button", { name: "复制为 JSON 数组" }));

    await waitFor(() => expect(mockedWriteText).toHaveBeenCalledTimes(1));
    expect(mockApi.queryFullRows).toHaveBeenCalledTimes(1);
    expect(mockApi.queryFullRows.mock.calls[0]).toEqual([
      connId,
      database,
      table,
      "id",
      [1, 2],
      undefined,
      ["body"],
    ]);
    const copied = mockedWriteText.mock.calls[0]?.[0] ?? "";
    expect(JSON.parse(copied)).toEqual([
      { id: 1, body: fullBody1, title: "标题一" },
      { id: 2, body: fullBody2, title: "标题二" },
    ]);
    expect(copied).not.toContain("__deferred_field");
    expect(copied).not.toContain(previewBody1);
    expect(copied).not.toContain(previewBody2);
  });

  it("没有隐藏列时复制 INSERT 也加载完整大字段", async () => {
    mockApi.queryFullRows.mockResolvedValue(fullRowsResult([[1, fullBody1]]));
    const { container } = render(<TableData />);
    await selectRows(container, 1);

    fireEvent.click(screen.getByRole("button", { name: "复制为 INSERT 语句" }));

    await waitFor(() => expect(mockedWriteText).toHaveBeenCalledTimes(1));
    expect(mockApi.queryFullRows).toHaveBeenCalledTimes(1);
    const copied = mockedWriteText.mock.calls[0]?.[0] ?? "";
    expect(copied).toContain(fullBody1);
    expect(copied).toContain("标题一");
    expect(copied).not.toContain("__deferred_field");
    expect(copied).not.toContain(previewBody1);
  });

  it("导出 Excel 前批量加载完整大字段并传给工作簿生成器", async () => {
    mockApi.queryFullRows.mockResolvedValue(
      fullRowsResult([
        [1, fullBody1],
        [2, fullBody2],
      ])
    );
    render(<TableData />);

    fireEvent.click(
      await screen.findByRole("button", { name: "导出本页为 Excel" })
    );

    await waitFor(() => expect(mockedBuildWorkbook).toHaveBeenCalledTimes(1));
    expect(mockApi.queryFullRows).toHaveBeenCalledTimes(1);
    expect(mockedBuildWorkbook).toHaveBeenCalledWith(
      ["id", "body", "title"],
      [
        [1, fullBody1, "标题一"],
        [2, fullBody2, "标题二"],
      ],
      "articles"
    );
  });

  it("完整值请求失败时不把标记或预览写入剪贴板", async () => {
    mockApi.queryFullRows.mockRejectedValue(new Error("完整值读取失败"));
    const { container } = render(<TableData />);
    await selectRows(container, 1);

    fireEvent.click(screen.getByRole("button", { name: "复制为 JSON 数组" }));

    await waitFor(() => {
      expect(
        screen.getByText(/复制 JSON 失败.*完整值读取失败/)
      ).toBeInTheDocument();
    });
    expect(mockApi.queryFullRows).toHaveBeenCalledTimes(1);
    expect(mockedWriteText).not.toHaveBeenCalled();
    expect(getPendingChanges().size).toBe(0);
  });

  it("刷新后才返回的完整值不写入剪贴板", async () => {
    let resolveFullRows!: (value: ReturnType<typeof fullRowsResult>) => void;
    mockApi.queryFullRows.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFullRows = resolve;
        })
    );
    const { container } = render(<TableData />);
    await selectRows(container, 1);

    fireEvent.click(screen.getByRole("button", { name: "复制为 JSON 数组" }));
    await waitFor(() => expect(mockApi.queryFullRows).toHaveBeenCalledTimes(1));

    const reloadIcon = screen.getByRole("img", { name: "reload" });
    fireEvent.click(reloadIcon.closest("button")!);
    await act(async () => {
      resolveFullRows(fullRowsResult([[1, fullBody1]]));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText(/页面已变化/)).toBeInTheDocument();
    });
    expect(mockedWriteText).not.toHaveBeenCalled();
    expect(getPendingChanges().size).toBe(0);
  });

  it("PostgreSQL 的同形 JSON 对象按真实值复制，不触发 MySQL 大字段回源", async () => {
    const postgresConnection = {
      connId,
      config: {
        id: "saved-deferred",
        name: "PostgreSQL JSON 测试",
        host: "localhost",
        port: 5432,
        username: "postgres",
        database_type: "postgres" as const,
      },
    };
    useConnectionStore.setState({
      activeConnections: { [connId]: postgresConnection },
      activeConnection: postgresConnection,
    });
    const { container } = render(<TableData />);
    await screen.findByText("标题一");
    const firstCheckbox = container.querySelector(
      ".virtual-data-table-row .ant-checkbox-input"
    ) as HTMLInputElement;
    fireEvent.click(firstCheckbox);

    fireEvent.click(screen.getByRole("button", { name: "复制为 JSON 数组" }));

    await waitFor(() => expect(mockedWriteText).toHaveBeenCalledTimes(1));
    expect(mockApi.queryFullRows).not.toHaveBeenCalled();
    expect(JSON.parse(mockedWriteText.mock.calls[0]![0])).toEqual([
      { id: 1, body: deferredBody1, title: "标题一" },
    ]);
  });
});
