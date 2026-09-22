import { Profiler } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseTree } from "../components/database/DatabaseTree";
import { TableTabsBar } from "../components/table/TableTabsBar";
import { SqlEditor } from "../components/sql/SqlEditor";
import { useConnectionStore } from "../stores/connectionStore";
import { emptyConnState, useDatabaseStore } from "../stores/databaseStore";
import * as api from "../services/tauriCommands";

vi.mock("../services/tauriCommands");
vi.mock("../utils/monacoSetup", () => ({ setupMonacoEditor: () => undefined }));
vi.mock("../utils/sqlCompletionSchema", () => ({
  loadSqlCompletionSchema: vi.fn().mockResolvedValue({
    databases: [],
    tables: [],
    columns: [],
  }),
}));
vi.mock("@monaco-editor/react", () => ({
  default: ({
    value,
    onChange,
  }: {
    value?: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="SQL 内容"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

const connection = {
  connId: "conn-1",
  config: {
    id: "profile-1",
    name: "测试连接",
    host: "localhost",
    port: 3306,
    username: "root",
    database_type: "mysql" as const,
  },
};

describe("SQL 编辑的订阅隔离", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConnectionStore.setState({
      activeConnection: connection,
      activeConnId: connection.connId,
      activeConnections: { [connection.connId]: connection },
    });
    useDatabaseStore.getState().reset();
    useDatabaseStore.setState({
      connectionStates: {
        "conn-1": {
          ...emptyConnState(),
          databases: ["app"],
          selectedDatabase: "app",
          openTabs: [
            { type: "sql", id: "sql-a" },
            { type: "sql", id: "sql-b" },
          ],
          sqlTabContents: { "sql-a": "SELECT 1", "sql-b": "SELECT 2" },
        },
      },
    });
    useDatabaseStore.getState().switchToConnection("conn-1");
    vi.mocked(api.getSessionInfoCached).mockResolvedValue({
      version: "8.0.30",
      hostname: "localhost",
      server_read_only: false,
      grant_write_capable: true,
      max_execution_time_ms: 0,
      time_zone: "SYSTEM",
      database: "app",
      connection_id: 1,
    });
  });

  it.each([
    ["数据库树", DatabaseTree],
    ["标签栏", TableTabsBar],
  ] as const)("编辑 SQL 时%s不产生额外提交", async (_name, Component) => {
    const onRender = vi.fn();
    render(
      <Profiler id="navigation" onRender={onRender}>
        <Component />
      </Profiler>
    );
    await act(async () => {});
    onRender.mockClear();

    act(() => {
      useDatabaseStore
        .getState()
        .setSqlTabContent("conn-1", "sql-a", "SELECT 123");
    });

    expect(onRender).not.toHaveBeenCalled();
    expect(useDatabaseStore.getState().sqlTabContents["sql-a"]).toBe(
      "SELECT 123"
    );
  });

  it("输入 A 标签只更新 A，B 的内容和渲染保持稳定", async () => {
    const onRenderB = vi.fn();
    render(
      <>
        <SqlEditor tabId="sql-a" />
        <Profiler id="editor-b" onRender={onRenderB}>
          <SqlEditor tabId="sql-b" />
        </Profiler>
      </>
    );
    await act(async () => {});
    onRenderB.mockClear();

    fireEvent.change(screen.getAllByRole("textbox", { name: "SQL 内容" })[0], {
      target: { value: "SELECT 123" },
    });

    expect(screen.getAllByRole("textbox", { name: "SQL 内容" })[0]).toHaveValue(
      "SELECT 123"
    );
    expect(screen.getAllByRole("textbox", { name: "SQL 内容" })[1]).toHaveValue(
      "SELECT 2"
    );
    expect(onRenderB).not.toHaveBeenCalled();
  });

  it("更新后台连接草稿不会覆盖当前连接的内容，切换后可恢复", () => {
    useDatabaseStore.setState((s) => ({
      connectionStates: {
        ...s.connectionStates,
        "conn-2": {
          ...emptyConnState(),
          openTabs: [{ type: "sql", id: "sql-background" }],
          sqlTabContents: { "sql-background": "SELECT 3" },
        },
      },
    }));

    useDatabaseStore
      .getState()
      .setSqlTabContent("conn-2", "sql-background", "SELECT 456");
    expect(useDatabaseStore.getState().sqlTabContents["sql-a"]).toBe(
      "SELECT 1"
    );
    useDatabaseStore.getState().switchToConnection("conn-2");
    expect(useDatabaseStore.getState().sqlTabContents["sql-background"]).toBe(
      "SELECT 456"
    );
    useDatabaseStore.getState().switchToConnection("conn-1");
    expect(useDatabaseStore.getState().sqlTabContents["sql-a"]).toBe(
      "SELECT 1"
    );
  });
});
