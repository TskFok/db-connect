import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SqlEditor } from "../components/sql/SqlEditor";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";

// bug 回归：运行 SQL 时切换标签（SqlEditor 卸载重挂载），执行中状态与「停止」能力不应丢失

vi.mock("../services/tauriCommands", () => ({
  listDatabases: vi.fn(),
  listTables: vi.fn(),
  getTableStructure: vi.fn(),
  getDatabaseInfo: vi.fn(),
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
  executeSql: vi.fn(),
  explainSql: vi.fn(),
  cancelQuery: vi.fn(),
  getSessionInfoCached: vi.fn().mockResolvedValue({
    version: "8.0.30",
    hostname: "localhost",
    server_read_only: false,
    grant_write_capable: true,
    max_execution_time_ms: 0,
    time_zone: "SYSTEM",
    database: null,
    connection_id: 1,
  }),
}));

vi.mock("../utils/sqlCompletionSchema", () => ({
  loadSqlCompletionSchema: vi
    .fn()
    .mockResolvedValue({ databases: [], tables: [], columns: [] }),
}));

vi.mock("../utils/monacoSetup", () => ({
  setupMonacoEditor: () => undefined,
}));

import * as api from "../services/tauriCommands";

const mockActiveConnection = {
  connId: "conn-1",
  config: {
    id: "conn-1",
    name: "测试连接",
    host: "localhost",
    port: 3306,
    username: "root",
  },
};

function openSqlTabAndGetId(): string {
  useDatabaseStore.getState().openSqlTab("conn-1", "SELECT SLEEP(10)");
  const tab = useDatabaseStore.getState().openTabs.find((t) => t.type === "sql");
  return tab?.type === "sql" ? tab.id : "";
}

describe("SqlEditor 执行中状态跨卸载保留", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionStore.setState({
      activeConnections: { "conn-1": mockActiveConnection },
      activeConnId: "conn-1",
      activeConnection: mockActiveConnection,
    });
    useDatabaseStore.getState().reset();
    useDatabaseStore.getState().switchToConnection("conn-1");
  });

  it("store 中登记执行中状态时，新挂载的编辑器应显示「停止」按钮", () => {
    const tabId = openSqlTabAndGetId();
    useDatabaseStore
      .getState()
      .setSqlTabExecution("conn-1", tabId, { executionId: "exec-1" });

    // 模拟切走再切回：全新挂载的 SqlEditor 实例
    render(<SqlEditor tabId={tabId} />);

    expect(screen.getByRole("button", { name: /停 止|停止/ })).toBeInTheDocument();
  });

  it("卸载重挂载后仍处于执行中，并能用 store 中的令牌停止查询", async () => {
    const tabId = openSqlTabAndGetId();
    useDatabaseStore
      .getState()
      .setSqlTabExecution("conn-1", tabId, { executionId: "exec-42" });
    vi.mocked(api.cancelQuery).mockResolvedValue(true);

    const first = render(<SqlEditor tabId={tabId} />);
    expect(
      screen.getByRole("button", { name: /停 止|停止/ })
    ).toBeInTheDocument();
    first.unmount();

    // 重挂载（相当于切回 SQL 标签）
    render(<SqlEditor tabId={tabId} />);
    const stopBtn = screen.getByRole("button", { name: /停 止|停止/ });
    expect(stopBtn).toBeInTheDocument();

    fireEvent.click(stopBtn);
    await waitFor(() => {
      expect(api.cancelQuery).toHaveBeenCalledWith("conn-1", "exec-42");
    });
  });

  it("执行结束（状态清除）后重挂载不再显示「停止」按钮", () => {
    const tabId = openSqlTabAndGetId();
    useDatabaseStore
      .getState()
      .setSqlTabExecution("conn-1", tabId, { executionId: "exec-1" });
    useDatabaseStore.getState().setSqlTabExecution("conn-1", tabId, null);

    render(<SqlEditor tabId={tabId} />);

    expect(
      screen.queryByRole("button", { name: /停 止|停止/ })
    ).not.toBeInTheDocument();
  });
});
