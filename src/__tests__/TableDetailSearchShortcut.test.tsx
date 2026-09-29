import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseOverview } from "../components/database/DatabaseOverview";
import { TableContent } from "../components/table/TableContent";
import { useConnectionStore } from "../stores/connectionStore";
import { emptyConnState, useDatabaseStore } from "../stores/databaseStore";
import type { TableInfo } from "../types";

vi.mock("../services/tauriCommands", () => ({
  isConnectionGloballyReadOnly: vi.fn().mockResolvedValue(false),
  getTableStructure: vi.fn().mockResolvedValue([]),
  listTables: vi.fn().mockResolvedValue([]),
}));

vi.mock("../components/table/TableData", () => ({
  TableData: () => <div data-testid="mock-table-data" />,
}));

vi.mock("../components/table/TableStructure", () => ({
  TableStructure: () => <div data-testid="mock-structure" />,
}));

vi.mock("../components/index/IndexList", () => ({
  IndexList: () => <div />,
}));

vi.mock("../components/trigger/TriggerList", () => ({
  TriggerList: () => <div />,
}));

vi.mock("../components/database/CreateTableSql", () => ({
  CreateTableSql: () => <div />,
}));

vi.mock("../components/foreignKey/ForeignKeyList", () => ({
  ForeignKeyList: () => <div />,
}));

vi.mock("../components/sql/SqlEditorLazy", () => ({
  SqlEditor: () => <div />,
}));

const tables: TableInfo[] = [
  {
    name: "users",
    table_type: "BASE TABLE",
    engine: "InnoDB",
    rows: 1,
    data_length: 1024,
    index_length: 0,
    comment: "用户表",
  },
];

function TableListOrDetail() {
  const viewMode = useDatabaseStore((s) => s.viewMode);
  if (viewMode === "overview") return <DatabaseOverview />;
  return <TableContent />;
}

describe("数据表详情页搜索快捷键", () => {
  beforeEach(() => {
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
    useDatabaseStore.getState().reset();
    const connState = {
      ...emptyConnState(),
      databases: ["app_db"],
      tables: { app_db: tables },
      selectedDatabase: "app_db",
      selectedTable: "users",
      selectedTableInfo: tables[0],
      tableStructure: [],
      viewMode: "tab" as const,
      openTabs: [
        { type: "table" as const, database: "app_db", table: "users" },
      ],
      activeTabIndex: 0,
      tableSearchByDatabase: {
        app_db: { visible: true, keyword: "用户" },
      },
    };
    useConnectionStore.setState({
      activeConnection: {
        connId: "conn-1",
        config: {
          id: "conn-1",
          name: "conn-1",
          host: "localhost",
          port: 3306,
          username: "root",
          database_type: "mysql",
        },
      },
      activeConnId: "conn-1",
    });
    useDatabaseStore.getState().switchToConnection("conn-1");
    useDatabaseStore.setState({
      connectionStates: { "conn-1": connState },
      selectedDatabase: "app_db",
      selectedTable: "users",
      selectedTableInfo: tables[0],
      tableStructure: [],
      viewMode: "tab",
      openTabs: connState.openTabs,
      activeTabIndex: 0,
    });
  });

  it("Cmd/Ctrl+F 回到数据表列表并选中已有搜索内容", () => {
    render(<TableListOrDetail />);
    expect(screen.getByTestId("mock-table-data")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "f", metaKey: true });

    expect(useDatabaseStore.getState().viewMode).toBe("overview");
    const input = screen.getByPlaceholderText(
      "搜索表名或注释..."
    ) as HTMLInputElement;
    expect(input).toHaveValue("用户");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe("用户".length);
  });
});
