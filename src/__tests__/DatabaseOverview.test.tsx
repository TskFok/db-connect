import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
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
  isConnectionGloballyReadOnly: vi.fn().mockResolvedValue(false),
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

describe("DatabaseOverview 表头列宽调节", () => {
  beforeEach(() => {
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
