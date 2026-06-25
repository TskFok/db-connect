import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SavedSqlDropdown } from "../components/database/SavedSqlDropdown";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";
import { useSavedSqlStore } from "../stores/savedSqlStore";
import type { SavedSql } from "../stores/savedSqlStore";

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
}));

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

function makeItem(profileKey: string, sql: string): SavedSql {
  return {
    id: "saved-1",
    name: "条目一",
    sql,
    createdAt: Date.now(),
    connectionKey: `profile:${profileKey}`,
    connectionLabel: "测试连接",
  };
}

describe("SavedSqlDropdown", () => {
  describe("侧边栏", () => {
    beforeEach(() => {
      useConnectionStore.setState({
        activeConnections: { "conn-1": mockActiveConnection },
        activeConnId: "conn-1",
        activeConnection: mockActiveConnection,
      });
      useSavedSqlStore.setState({ list: [] });
      useDatabaseStore.getState().reset();
      useDatabaseStore.getState().switchToConnection("conn-1");
    });

    it("无连接时不渲染", () => {
      useConnectionStore.setState({ activeConnection: null });
      const { container } = render(<SavedSqlDropdown />);
      expect(container.firstChild).toBeNull();
    });

    it("点击展开下拉并显示面板标题与搜索框", () => {
      render(<SavedSqlDropdown />);
      fireEvent.click(screen.getByRole("button", { name: /已保存的 SQL/ }));
      expect(screen.getByText("已保存的 SQL")).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/搜索名称或 SQL/)).toBeInTheDocument();
    });

    it("有保存项时在列表中显示名称", () => {
      useSavedSqlStore.setState({ list: [makeItem("conn-1", "SELECT 1")] });
      render(<SavedSqlDropdown />);
      fireEvent.click(screen.getByRole("button", { name: /已保存的 SQL/ }));
      expect(screen.getByText("条目一")).toBeInTheDocument();
    });

    it("侧边栏点击加载后仍处于展开状态并新开 SQL 标签", () => {
      useSavedSqlStore.setState({ list: [makeItem("conn-1", "SELECT 42")] });
      render(<SavedSqlDropdown />);
      fireEvent.click(screen.getByRole("button", { name: /已保存的 SQL/ }));
      fireEvent.click(screen.getByRole("button", { name: "加载已保存的 SQL" }));
      expect(screen.getByPlaceholderText(/搜索名称或 SQL/)).toBeInTheDocument();
      expect(useDatabaseStore.getState().openTabs.some((t) => t.type === "sql")).toBe(true);
    });
  });

  describe("内嵌编辑器", () => {
    beforeEach(() => {
      useConnectionStore.setState({
        activeConnections: { "conn-1": mockActiveConnection },
        activeConnId: "conn-1",
        activeConnection: mockActiveConnection,
      });
      useSavedSqlStore.setState({ list: [makeItem("conn-1", "SELECT * FROM t")] });
    });

    it("未连接时禁用触发按钮", () => {
      useConnectionStore.setState({
        activeConnection: null,
        activeConnections: {},
        activeConnId: null,
      });

      render(
        <SavedSqlDropdown
          variant="embedded"
          setEditorSql={vi.fn()}
          requestExecute={vi.fn()}
        />
      );
      const btn = screen.getByRole("button", { name: /已保存的 SQL/ });
      expect(btn.hasAttribute("disabled")).toBe(true);
    });

    it("加载已保存项时调用 setEditorSql", () => {
      const setSql = vi.fn();
      render(
        <SavedSqlDropdown
          variant="embedded"
          setEditorSql={setSql}
          requestExecute={vi.fn()}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: /已保存的 SQL/ }));
      fireEvent.click(screen.getByRole("button", { name: "加载已保存的 SQL" }));
      expect(setSql).toHaveBeenCalledWith("SELECT * FROM t");
    });

    it("加载并运行时调用 setEditorSql 与 requestExecute", () => {
      vi.useFakeTimers();
      try {
        const setSql = vi.fn();
        const run = vi.fn();
        render(
          <SavedSqlDropdown
            variant="embedded"
            setEditorSql={setSql}
            requestExecute={run}
          />
        );
        fireEvent.click(screen.getByRole("button", { name: /已保存的 SQL/ }));
        fireEvent.click(screen.getByRole("button", { name: "加载并运行已保存的 SQL" }));
        expect(setSql).toHaveBeenCalledWith("SELECT * FROM t");
        vi.advanceTimersByTime(100);
        expect(run).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
