import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SqlEditor } from "../components/sql/SqlEditor";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";
import type { SqlExecuteResult } from "../types";

vi.mock("../services/tauriCommands", () => ({
  getSessionInfoCached: vi.fn().mockResolvedValue({
    version: "8.0.30",
    hostname: "localhost",
    server_read_only: false,
    grant_write_capable: true,
    max_execution_time_ms: 0,
    time_zone: "SYSTEM",
    database: "app",
    connection_id: 1,
  }),
}));

vi.mock("../utils/monacoSetup", () => ({
  setupMonacoEditor: () => undefined,
}));

vi.mock("../utils/sqlCompletionSchema", () => ({
  loadSqlCompletionSchema: vi
    .fn()
    .mockResolvedValue({ databases: [], tables: [], columns: [] }),
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

function openSqlTabWithResult(result: SqlExecuteResult): string {
  useDatabaseStore.getState().openSqlTab(connection.connId, "SELECT * FROM t");
  const tab = useDatabaseStore
    .getState()
    .openTabs.find((item) => item.type === "sql");
  if (!tab || tab.type !== "sql") throw new Error("SQL 标签页创建失败");
  useDatabaseStore
    .getState()
    .setSqlTabResult(connection.connId, tab.id, result, null, []);
  return tab.id;
}

function selectResult(
  rows: unknown[][],
  columns = ["value"]
): SqlExecuteResult {
  return {
    result_type: "select",
    columns,
    rows,
    affected_rows: null,
    message: `返回 ${rows.length} 行`,
    execution_time_ms: 1,
  };
}

describe("SqlEditor 查询结果分页", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    useConnectionStore.setState({
      activeConnection: connection,
      activeConnId: connection.connId,
      activeConnections: { [connection.connId]: connection },
    });
    useDatabaseStore.getState().reset();
    useDatabaseStore.getState().switchToConnection(connection.connId);
  });

  it("首屏只读取和转换当前页的行", () => {
    const rows = Array.from({ length: 101 }, (_, index) => [`row-${index}`]);
    Object.defineProperty(rows, 100, {
      configurable: true,
      get() {
        throw new Error("首屏不应读取第二页行");
      },
    });
    const tabId = openSqlTabWithResult(selectResult(rows));

    expect(() => render(<SqlEditor tabId={tabId} />)).not.toThrow();
    expect(screen.getByText("共 101 行")).toBeInTheDocument();
  });

  it("切到末页后收到新结果时复位到第一页", async () => {
    const tabId = openSqlTabWithResult(
      selectResult(Array.from({ length: 101 }, (_, index) => [`old-${index}`]))
    );
    const { container } = render(<SqlEditor tabId={tabId} />);

    const nextButton = container.querySelector<HTMLButtonElement>(
      ".ant-pagination-next button"
    );
    expect(nextButton).not.toBeNull();
    fireEvent.click(nextButton!);
    expect(await screen.findByText("old-100")).toBeInTheDocument();

    act(() => {
      useDatabaseStore
        .getState()
        .setSqlTabResult(
          connection.connId,
          tabId,
          selectResult(
            Array.from({ length: 101 }, (_, index) => [`new-${index}`])
          ),
          null,
          []
        );
    });

    await waitFor(() => {
      expect(screen.getByText("new-0")).toBeInTheDocument();
    });
    expect(screen.queryByText("new-100")).not.toBeInTheDocument();
  });

  it("末页切换每页行数时将页码限制在新的有效范围", async () => {
    const tabId = openSqlTabWithResult(
      selectResult(Array.from({ length: 101 }, (_, index) => [`row-${index}`]))
    );
    const { container } = render(<SqlEditor tabId={tabId} />);
    const nextButton = container.querySelector<HTMLButtonElement>(
      ".ant-pagination-next button"
    );
    fireEvent.click(nextButton!);
    expect(await screen.findByText("row-100")).toBeInTheDocument();

    const sizeChanger = container.querySelector<HTMLElement>(
      ".ant-pagination-options-size-changer .ant-select-selector"
    );
    expect(sizeChanger).not.toBeNull();
    fireEvent.mouseDown(sizeChanger!);
    fireEvent.click(await screen.findByText(/200\s*\/\s*(页|page)/));

    await waitFor(() => {
      expect(
        container.querySelector(".ant-pagination-item-active")
      ).toHaveTextContent("1");
    });
    expect(screen.getByText("row-0")).toBeInTheDocument();
    expect(screen.getByText("共 101 行")).toBeInTheDocument();
  });

  it("重复列名和 _key 列不会覆盖单元格或行键", () => {
    const tabId = openSqlTabWithResult(
      selectResult(
        [["first", "second", "payload-key"]],
        ["value", "value", "_key"]
      )
    );

    render(<SqlEditor tabId={tabId} />);

    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
    expect(screen.getByText("payload-key")).toBeInTheDocument();
  });
});
