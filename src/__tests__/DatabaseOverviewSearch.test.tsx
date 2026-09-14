import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseOverview } from "../components/database/DatabaseOverview";
import { useConnectionStore } from "../stores/connectionStore";
import { emptyConnState, useDatabaseStore } from "../stores/databaseStore";
import type { TableInfo } from "../types";

vi.mock("../services/tauriCommands", () => ({
  isConnectionGloballyReadOnly: vi.fn().mockResolvedValue(false),
  getTableStructure: vi.fn().mockResolvedValue([]),
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
  {
    name: "orders",
    table_type: "BASE TABLE",
    engine: "InnoDB",
    rows: 1,
    data_length: 1024,
    index_length: 0,
    comment: "订单表",
  },
];

function activateConnection(connId: string) {
  useConnectionStore.setState({
    activeConnection: {
      connId,
      config: {
        id: connId,
        name: connId,
        host: "localhost",
        port: 3306,
        username: "root",
        database_type: "mysql",
      },
    },
    activeConnId: connId,
  });
  useDatabaseStore.getState().switchToConnection(connId);
}

function searchTables(keyword: string) {
  fireEvent.keyDown(window, { key: "f", ctrlKey: true });
  fireEvent.change(screen.getByPlaceholderText("搜索表名或注释..."), {
    target: { value: keyword },
  });
}

describe("数据库表搜索状态", () => {
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
    useDatabaseStore.setState({
      connectionStates: Object.fromEntries(
        ["conn-1", "conn-2"].map((connId) => [
          connId,
          {
            ...emptyConnState(),
            databases: ["app_db", "other_db"],
            tables: { app_db: tables, other_db: tables },
            selectedDatabase: "app_db",
            viewMode: "overview",
          },
        ])
      ),
    });
    activateConnection("conn-1");
  });

  it("搜索后点击数据表，返回概览时保留关键词与筛选结果", async () => {
    const overview = render(<DatabaseOverview />);
    searchTables("用户");
    expect(screen.queryByText("orders")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByText("users"));
    });
    expect(useDatabaseStore.getState().selectedTable).toBe("users");
    expect(useDatabaseStore.getState().viewMode).toBe("tab");

    // App 进入数据表页时会卸载概览，返回数据库后重新挂载。
    overview.unmount();
    await act(async () => {
      await useDatabaseStore.getState().selectDatabase("conn-1", "app_db");
    });
    render(<DatabaseOverview />);

    const restoredSearch = screen.queryByPlaceholderText("搜索表名或注释...");
    expect(restoredSearch).toBeInTheDocument();
    expect(restoredSearch).toHaveValue("用户");
    expect(screen.getByText("users")).toBeInTheDocument();
    expect(screen.queryByText("orders")).not.toBeInTheDocument();
  });

  it("不同数据库分别保留搜索内容", async () => {
    render(<DatabaseOverview />);
    searchTables("users");

    await act(async () => {
      await useDatabaseStore.getState().selectDatabase("conn-1", "other_db");
    });
    expect(
      screen.queryByPlaceholderText("搜索表名或注释...")
    ).not.toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
    searchTables("orders");

    await act(async () => {
      await useDatabaseStore.getState().selectDatabase("conn-1", "app_db");
    });
    expect(screen.getByPlaceholderText("搜索表名或注释...")).toHaveValue(
      "users"
    );
    expect(screen.queryByText("orders")).not.toBeInTheDocument();
  });

  it("相同数据库名在不同连接中分别保留搜索内容", () => {
    render(<DatabaseOverview />);
    searchTables("users");

    act(() => activateConnection("conn-2"));
    expect(
      screen.queryByPlaceholderText("搜索表名或注释...")
    ).not.toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
    searchTables("orders");

    act(() => activateConnection("conn-1"));
    expect(screen.getByPlaceholderText("搜索表名或注释...")).toHaveValue(
      "users"
    );
    expect(screen.queryByText("orders")).not.toBeInTheDocument();
  });

  it("主动关闭搜索后不再恢复旧关键词", () => {
    const overview = render(<DatabaseOverview />);
    searchTables("users");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByText("orders")).toBeInTheDocument();

    overview.unmount();
    render(<DatabaseOverview />);
    expect(
      screen.queryByPlaceholderText("搜索表名或注释...")
    ).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(screen.getByPlaceholderText("搜索表名或注释...")).toHaveValue("");
  });
});
