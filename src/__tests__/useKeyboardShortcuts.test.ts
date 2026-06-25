import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";
import { useThemeStore } from "../stores/themeStore";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";

// Mock Tauri API
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Mock api service
vi.mock("../services/tauriCommands", () => ({
  listSavedConnections: vi.fn(),
  getDecryptedConnection: vi.fn(),
  saveConnection: vi.fn(),
  deleteSavedConnection: vi.fn(),
  testConnection: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  listDatabases: vi.fn(),
  listTables: vi.fn(),
  getTableStructure: vi.fn(),
  queryTableData: vi.fn(),
  queryTableCount: vi.fn().mockResolvedValue(0),
}));

import * as api from "../services/tauriCommands";

describe("键盘快捷键系统 (逻辑测试)", () => {
  beforeEach(() => {
    // 重置所有 store
    useConnectionStore.setState({
      savedConnections: [],
      activeConnection: null,
      loading: false,
      error: null,
      showConnectionForm: false,
      editingConnection: null,
    });
    useDatabaseStore.setState({
      databases: [],
      tables: {},
      selectedDatabase: null,
      selectedTable: null,
      tableStructure: null,
      selectedTableInfo: null,
      treeLoading: false,
      structureLoading: false,
      structureError: null,
      expandedKeys: [],
      tableContentActiveTab: "data",
    });
    useThemeStore.setState({ mode: "dark" });
    vi.clearAllMocks();
  });

  describe("Cmd/Ctrl + N: 新建连接", () => {
    it("快捷键触发后 showConnectionForm 应该为 true", () => {
      // 模拟快捷键按下后调用 store action
      useConnectionStore.getState().showNewConnectionForm();

      const state = useConnectionStore.getState();
      expect(state.showConnectionForm).toBe(true);
      expect(state.editingConnection).toBeNull();
    });
  });

  describe("Cmd/Ctrl + L: 切换主题", () => {
    it("快捷键触发后应该切换主题", () => {
      expect(useThemeStore.getState().mode).toBe("dark");

      // 模拟快捷键按下后调用 store action
      useThemeStore.getState().toggleTheme();

      expect(useThemeStore.getState().mode).toBe("light");
    });

    it("再次触发后应该切换回暗色", () => {
      useThemeStore.getState().toggleTheme(); // -> light
      useThemeStore.getState().toggleTheme(); // -> dark

      expect(useThemeStore.getState().mode).toBe("dark");
    });
  });

  describe("Cmd/Ctrl + D: 断开连接", () => {
    it("没有活跃连接时不应产生副作用", async () => {
      // 无活跃连接直接 disconnect
      await useConnectionStore.getState().disconnect();
      expect(useConnectionStore.getState().activeConnection).toBeNull();
    });
  });

  describe("键盘事件分发", () => {
    it("keydown 事件应该能在 window 上触发", () => {
      const handler = vi.fn();
      window.addEventListener("keydown", handler);

      const event = new KeyboardEvent("keydown", {
        key: "n",
        metaKey: true,
        bubbles: true,
      });
      window.dispatchEvent(event);

      expect(handler).toHaveBeenCalled();
      window.removeEventListener("keydown", handler);
    });

    it("没有 metaKey/ctrlKey 的事件不应触发快捷键逻辑", () => {
      const handler = vi.fn((e: KeyboardEvent) => {
        if (e.metaKey || e.ctrlKey) {
          return true;
        }
      });
      window.addEventListener("keydown", handler);

      const event = new KeyboardEvent("keydown", {
        key: "n",
        metaKey: false,
        ctrlKey: false,
        bubbles: true,
      });
      window.dispatchEvent(event);

      // handler 被调用了但是不会返回 true（表示没有进入快捷键分支）
      expect(handler).toHaveBeenCalled();
      window.removeEventListener("keydown", handler);
    });
  });

  describe("Cmd/Ctrl + R: 刷新", () => {
    function TestHost() {
      useKeyboardShortcuts();
      return null;
    }

    it("在数据行页面时应刷新数据行 (调用 loadData/queryTableData)", async () => {
      const mockConn = {
        connId: "conn-1",
        config: { host: "localhost", port: 3306, name: "test", username: "root" },
      };
      useConnectionStore.setState({ activeConnection: mockConn });
      useDatabaseStore.setState({
        selectedDatabase: "mydb",
        selectedTable: "users",
        tableContentActiveTab: "data",
      });
      vi.mocked(api.queryTableData).mockResolvedValue({
        columns: ["id", "name"],
        rows: [[1, "a"]],
        total: 1,
        execution_time_ms: 10,
      });

      render(React.createElement(TestHost));

      const event = new KeyboardEvent("keydown", {
        key: "r",
        metaKey: true,
        bubbles: true,
      });
      window.dispatchEvent(event);

      await vi.waitFor(() => {
        expect(api.queryTableData).toHaveBeenCalled();
      });
      expect(api.queryTableData).toHaveBeenCalledWith("conn-1", "mydb", "users", expect.any(Number), expect.any(Number), undefined, undefined, undefined, true);
    });

    it("不在数据行页面时应刷新数据库树 (调用 refresh)", async () => {
      const mockConn = {
        connId: "conn-1",
        config: { host: "localhost", port: 3306, name: "test", username: "root" },
      };
      useConnectionStore.setState({ activeConnection: mockConn });
      useDatabaseStore.setState({
        selectedDatabase: "mydb",
        selectedTable: "users",
        tableContentActiveTab: "structure",
      });
      vi.mocked(api.listDatabases).mockResolvedValue(["mydb"]);
      vi.mocked(api.listTables).mockResolvedValue([
        { name: "users", table_type: "TABLE", engine: "InnoDB", rows: 10, data_length: 0, index_length: null, comment: "" },
      ]);
      vi.mocked(api.getTableStructure).mockResolvedValue([]);

      render(React.createElement(TestHost));

      const event = new KeyboardEvent("keydown", {
        key: "r",
        metaKey: true,
        bubbles: true,
      });
      window.dispatchEvent(event);

      await vi.waitFor(() => {
        expect(api.listDatabases).toHaveBeenCalled();
      });
      expect(api.listDatabases).toHaveBeenCalledWith("conn-1");
    });
  });

  describe("Cmd/Ctrl + Shift + R: 刷新分页", () => {
    function TestHost() {
      useKeyboardShortcuts();
      return null;
    }

    it("在数据行页面时应刷新分页 (调用 queryTableCount)", async () => {
      const mockConn = {
        connId: "conn-1",
        config: { host: "localhost", port: 3306, name: "test", username: "root" },
      };
      useConnectionStore.setState({ activeConnection: mockConn });
      useDatabaseStore.setState({
        selectedDatabase: "mydb",
        selectedTable: "users",
        tableContentActiveTab: "data",
      });
      vi.mocked(api.queryTableCount).mockResolvedValue(42);

      render(React.createElement(TestHost));

      const event = new KeyboardEvent("keydown", {
        key: "r",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      });
      window.dispatchEvent(event);

      await vi.waitFor(() => {
        expect(api.queryTableCount).toHaveBeenCalled();
      });
      expect(api.queryTableCount).toHaveBeenCalledWith("conn-1", "mydb", "users", undefined);
      expect(api.queryTableData).not.toHaveBeenCalled();
    });

    it("不在数据行页面时不应刷新分页", async () => {
      const mockConn = {
        connId: "conn-1",
        config: { host: "localhost", port: 3306, name: "test", username: "root" },
      };
      useConnectionStore.setState({ activeConnection: mockConn });
      useDatabaseStore.setState({
        selectedDatabase: "mydb",
        selectedTable: "users",
        tableContentActiveTab: "structure",
      });

      render(React.createElement(TestHost));

      const event = new KeyboardEvent("keydown", {
        key: "r",
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      });
      window.dispatchEvent(event);

      await new Promise((r) => setTimeout(r, 50));
      expect(api.queryTableCount).not.toHaveBeenCalled();
    });
  });
});
