import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import * as api from "../services/tauriCommands";
import { formatBytes } from "../utils/formatBytes";
import { DatabaseOverview } from "../components/database/DatabaseOverview";
import {
  DEFAULT_TABLE_LIST_COLUMN_WIDTHS,
  getTableListCellText,
  resolveTableListColumnWidth,
} from "../utils/databaseOverviewUtils";
import type { TableInfo } from "../types";
import { useDatabaseStore } from "../stores/databaseStore";
import { useConnectionStore } from "../stores/connectionStore";
import { useSettingsStore } from "../stores/settingsStore";
import { LIST_TABLE_IDS } from "../utils/listTableColumns";

vi.mock("../services/tauriCommands", () => ({
  executeSql: vi.fn(),
}));

const mockTables: TableInfo[] = [
  {
    name: "users",
    table_type: "BASE TABLE",
    engine: "InnoDB",
    rows: 100,
    data_length: 65536,
    index_length: 16384,
    comment: "用户表",
  },
];

describe("TableInfo.index_length", () => {
  it("应包含索引容量字段", () => {
    const table: TableInfo = {
      name: "users",
      table_type: "TABLE",
      engine: "InnoDB",
      rows: 100,
      data_length: 65536,
      index_length: 16384,
      comment: "",
    };
    expect(table.index_length).toBe(16384);
  });
});

describe("formatBytes re-export", () => {
  it("表列表尺寸文本与 formatBytes 使用同一实现", () => {
    const record = {
      name: "users",
      table_type: "TABLE",
      data_length: 1024,
    } as TableInfo;
    expect(getTableListCellText(record, "data_length")).toBe(formatBytes(1024));
  });
});

describe("resolveTableListColumnWidth", () => {
  it("无持久化值时使用默认列宽", () => {
    expect(resolveTableListColumnWidth("name", {})).toBe(
      DEFAULT_TABLE_LIST_COLUMN_WIDTHS.name
    );
  });

  it("持久化值优先于默认列宽", () => {
    expect(resolveTableListColumnWidth("name", { name: 320 })).toBe(320);
  });
});

describe("DatabaseOverview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.executeSql).mockResolvedValue({
      result_type: "select",
      columns: ["ro", "sro"],
      rows: [[0, 0]],
      affected_rows: null,
      message: "",
      execution_time_ms: 0,
    });
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

    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (): CSSStyleDeclaration =>
        ({
          getPropertyValue: () => "",
        }) as unknown as CSSStyleDeclaration
    );

    useSettingsStore.setState({
      listTableSettings: {},
      sidebarWidth: 280,
      idleTimeoutMinutes: 15,
    });
    useConnectionStore.setState({
      activeConnection: {
        connId: "conn-1",
        config: {
          id: "conn-1",
          name: "测试",
          host: "localhost",
          port: 3306,
          username: "root",
        },
      },
    });
    useDatabaseStore.setState({
      selectedDatabase: "app_db",
      tables: { app_db: mockTables },
      treeLoading: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function useSqliteConnection(readOnly = false) {
    useConnectionStore.setState({
      activeConnection: {
        connId: "sqlite-1",
        config: {
          id: "sqlite-1",
          name: "SQLite 测试",
          database_type: "sqlite",
          sqlite_path: "/tmp/test.sqlite",
          host: "",
          port: 0,
          username: "",
          read_only: readOnly,
        },
      },
    });
    useDatabaseStore.setState({
      selectedDatabase: "main",
      tables: {
        main: [{ ...mockTables[0], engine: "SQLite", table_type: "TABLE" }],
      },
    });
  }

  it("SQLite 概览确认清空后执行清空操作，不发送实例探测 SQL", async () => {
    useSqliteConnection();
    vi.mocked(api.executeSql).mockRejectedValue(
      new Error('unrecognized token: "@"')
    );
    const truncateSpy = vi
      .spyOn(useDatabaseStore.getState(), "truncateTable")
      .mockResolvedValue();
    render(<DatabaseOverview />);

    fireEvent.click(screen.getByRole("button", { name: "清空表 users" }));
    fireEvent.click(await screen.findByRole("button", { name: "清 空" }));

    await waitFor(() => {
      expect(truncateSpy).toHaveBeenCalledWith("sqlite-1", "main", "users");
    });
    expect(api.executeSql).not.toHaveBeenCalled();
    expect(await screen.findByText('表 "users" 已清空')).toBeInTheDocument();
  });

  it("清空前探测失败时显示错误且不执行清空", async () => {
    const truncateSpy = vi
      .spyOn(useDatabaseStore.getState(), "truncateTable")
      .mockResolvedValue();
    render(<DatabaseOverview />);
    await waitFor(() => expect(api.executeSql).toHaveBeenCalledTimes(1));
    vi.mocked(api.executeSql).mockRejectedValue(new Error("连接已断开"));

    fireEvent.click(screen.getByRole("button", { name: "清空表 users" }));
    fireEvent.click(await screen.findByRole("button", { name: "清 空" }));

    expect(await screen.findByText(/连接已断开/)).toBeInTheDocument();
    expect(truncateSpy).not.toHaveBeenCalled();
  });

  it("SQLite 只读连接禁用清空和导入入口", () => {
    useSqliteConnection(true);
    render(<DatabaseOverview />);

    expect(screen.getByRole("button", { name: "清空表 users" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "导入 SQL 文件" })
    ).toBeDisabled();
  });

  it("拖动表头手柄应更新持久化列宽", () => {
    const { container } = render(<DatabaseOverview />);
    const handle = container.querySelector(
      ".database-table-list .resizable-table-header-handle"
    ) as HTMLElement;
    expect(handle).toBeTruthy();

    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 160 });
    fireEvent.mouseUp(document);

    const stored =
      useSettingsStore.getState().listTableSettings[
        LIST_TABLE_IDS.DATABASE_TABLE_LIST
      ]?.columnWidths ?? {};
    const resizedKey = Object.keys(stored)[0];
    expect(resizedKey).toBeTruthy();
    expect(stored[resizedKey!]).toBeGreaterThan(
      DEFAULT_TABLE_LIST_COLUMN_WIDTHS[resizedKey!] ?? 0
    );
  });

  it("表头列顺序拖拽手柄应存在", () => {
    const { container } = render(<DatabaseOverview />);
    const dragHandles = container.querySelectorAll(
      ".database-table-list .resizable-table-header-drag"
    );
    expect(dragHandles.length).toBeGreaterThan(0);
  });

  it("表名列应启用省略显示", () => {
    render(<DatabaseOverview />);

    const nameCell = screen.getByText("users").closest(".ant-table-cell");
    expect(nameCell).not.toBeNull();
    expect(nameCell).toHaveClass("ant-table-cell-ellipsis");
  });

  it("双击表头边缘应触发自适应列宽", () => {
    const { container } = render(<DatabaseOverview />);
    const handle = container.querySelector(
      ".database-table-list .resizable-table-header-handle"
    ) as HTMLElement;
    expect(handle).toBeTruthy();

    fireEvent.doubleClick(handle);

    const stored =
      useSettingsStore.getState().listTableSettings[
        LIST_TABLE_IDS.DATABASE_TABLE_LIST
      ]?.columnWidths ?? {};
    expect(Object.keys(stored).length).toBeGreaterThan(0);
  });

  it("PostgreSQL（阶段五）schema 概览展示例程 tab，但不展示 MySQL 独有的事件 tab", () => {
    useConnectionStore.setState({
      activeConnection: {
        connId: "pg-1",
        config: {
          id: "pg-1",
          name: "PostgreSQL",
          host: "localhost",
          port: 5432,
          username: "postgres",
          database_type: "postgres",
        },
      },
    });
    useDatabaseStore.setState({
      selectedDatabase: "public",
      tables: {
        public: [
          {
            ...mockTables[0],
            engine: "PostgreSQL",
            table_type: "TABLE",
          },
        ],
      },
      treeLoading: false,
    });

    render(<DatabaseOverview />);

    expect(screen.getByRole("tab", { name: /表/ })).toBeInTheDocument();
    // 阶段五：PostgreSQL 展示例程，但无定时事件等价物
    expect(screen.getByRole("tab", { name: /例程/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /事件/ })).not.toBeInTheDocument();
    // PostgreSQL 已支持新建表与 TRUNCATE
    expect(screen.getByText("新建表")).toBeInTheDocument();
    expect(screen.getByLabelText("清空表 users")).toBeInTheDocument();
  });
});
