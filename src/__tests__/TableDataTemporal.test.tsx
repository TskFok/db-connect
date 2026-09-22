import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
import type { ColumnInfo } from "../types";

vi.mock("../services/tauriCommands");

const mockApi = vi.mocked(api);
const tableKey = "conn-temporal|mydb|events";
const originalDateTime = "2026-09-21 13:14:15";
const connection = {
  connId: "conn-temporal",
  config: {
    id: "saved-temporal",
    name: "日期时间测试",
    host: "localhost",
    port: 3306,
    username: "root",
  },
};
const structure: ColumnInfo[] = [
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
    name: "event_date",
    column_type: "date",
    nullable: false,
    key: "",
    default_value: null,
    extra: "",
    comment: "",
  },
  {
    name: "occurred_at",
    column_type: "datetime",
    nullable: true,
    key: "",
    default_value: null,
    extra: "",
    comment: "",
  },
];
const snapshot = {
  columns: ["id", "event_date", "occurred_at"],
  rows: [[1, "2026-09-21", originalDateTime]],
  total: 1,
  page: 1,
  pageSize: 50,
  sortFields: [],
  whereClause: "",
  filterRows: [],
  dataError: null,
  executionTime: 5,
  lastSelectColumns: undefined,
};

function getPendingChanges() {
  return useTableDataStore
    .getState()
    .getPendingChangesForTable("conn-temporal", "mydb", "events");
}

async function selectCalendarDate(
  input: HTMLElement,
  date: string,
  confirmTime = false
) {
  fireEvent.click(input);
  fireEvent.click(await screen.findByTitle(date));
  if (confirmTime) {
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
  }
}

describe("TableData 日期时间编辑", () => {
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

    mockApi.queryTableData.mockResolvedValue({
      columns: snapshot.columns,
      rows: snapshot.rows,
      total: 1,
      execution_time_ms: 5,
    });
    mockApi.queryTableCount.mockResolvedValue(1);
    mockApi.insertRow.mockResolvedValue(1);
    mockApi.batchUpdateRows.mockResolvedValue(1);

    useConnectionStore.setState({
      savedConnections: [],
      activeConnections: { "conn-temporal": connection },
      activeConnId: "conn-temporal",
      activeConnection: connection,
      loading: false,
      error: null,
      showConnectionForm: false,
      editingConnection: null,
    });
    useDatabaseStore.getState().reset();
    useDatabaseStore.setState({
      activeConnId: "conn-temporal",
      selectedDatabase: "mydb",
      selectedTable: "events",
      tableStructure: structure,
      selectedTableInfo: {
        name: "events",
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
      ...snapshot,
      activeTableKey: tableKey,
      tableDataCache: { [tableKey]: snapshot },
    });
    useTableColumnSettingsStore.setState({ settings: {} });
  });

  afterEach(() => {
    resetTableSlotHeightModuleCacheForTests();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("新增行的日期选择器将 SQL 日期字符串传给插入接口", async () => {
    vi.setSystemTime(new Date(2026, 8, 21, 13, 14, 15));
    render(<TableData />);
    fireEvent.click(screen.getByLabelText("新增行"));

    const dialog = await screen.findByRole("dialog", { name: "新增行" });
    const input = within(dialog).getByRole("textbox", { name: "event_date" });
    expect(input.closest(".ant-picker")).not.toBeNull();
    await selectCalendarDate(input, "2026-09-22");
    fireEvent.click(within(dialog).getByRole("button", { name: /插\s*入/ }));

    await waitFor(() => {
      expect(mockApi.insertRow).toHaveBeenCalledWith(
        "conn-temporal",
        "mydb",
        "events",
        { event_date: "2026-09-22" }
      );
    });
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "新增行" })
      ).not.toBeInTheDocument();
    });
  });

  it("双击日期时间单元格打开选择器，取消后不留下待提交修改", async () => {
    render(<TableData />);
    fireEvent.doubleClick(await screen.findByText(originalDateTime));

    const dialog = await screen.findByRole("dialog", {
      name: "编辑：occurred_at",
    });
    const input = within(dialog).getByRole("textbox", { name: "occurred_at" });
    expect(input.closest(".ant-picker")).not.toBeNull();
    expect(input).toHaveValue(originalDateTime);
    await selectCalendarDate(input, "2026-09-22", true);
    expect(input).toHaveValue("2026-09-22 13:14:15");
    fireEvent.click(within(dialog).getByRole("button", { name: /取\s*消/ }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(screen.getByText(originalDateTime)).toBeInTheDocument();
    expect(getPendingChanges().size).toBe(0);
    expect(mockApi.batchUpdateRows).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: /提交修改/ })
    ).not.toBeInTheDocument();
  });

  it("日期时间经单元格确认和复核选择器修改后原样提交，不发生时区转换", async () => {
    render(<TableData />);
    fireEvent.doubleClick(await screen.findByText(originalDateTime));

    const editDialog = await screen.findByRole("dialog", {
      name: "编辑：occurred_at",
    });
    await selectCalendarDate(
      within(editDialog).getByRole("textbox", { name: "occurred_at" }),
      "2026-09-22",
      true
    );
    fireEvent.click(
      within(editDialog).getByRole("button", { name: /确\s*定/ })
    );

    await waitFor(() => {
      expect(Array.from(getPendingChanges().values())).toEqual([
        expect.objectContaining({
          colName: "occurred_at",
          oldValue: "2026-09-21 13:14:15",
          newValue: "2026-09-22 13:14:15",
          primaryKeys: { id: 1 },
        }),
      ]);
    });
    expect(mockApi.batchUpdateRows).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /提交修改/ }));

    const reviewDialog = await screen.findByRole("dialog", {
      name: /确认提交修改/,
    });
    const reviewInput = within(reviewDialog).getByRole("textbox", {
      name: "occurred_at",
    });
    expect(reviewInput.closest(".ant-picker")).not.toBeNull();
    expect(reviewInput).toHaveValue("2026-09-22 13:14:15");
    await selectCalendarDate(reviewInput, "2026-09-23", true);
    fireEvent.click(
      within(reviewDialog).getByRole("button", { name: "全部提交" })
    );

    await waitFor(() => {
      expect(mockApi.batchUpdateRows).toHaveBeenCalledWith(
        "conn-temporal",
        "mydb",
        "events",
        [
          {
            primaryKeys: { id: 1 },
            updates: { occurred_at: "2026-09-23 13:14:15" },
          },
        ]
      );
      expect(getPendingChanges().size).toBe(0);
    });
  });
});
