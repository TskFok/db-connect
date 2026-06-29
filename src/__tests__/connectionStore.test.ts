import { describe, it, expect, vi, beforeEach } from "vitest";
import { useConnectionStore } from "../stores/connectionStore";
import {
  defaultPortForDatabaseType,
  normalizeDatabaseType,
} from "../utils/connectionConfig";

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
  reorderConnections: vi.fn(),
  reorderConnectionGroups: vi.fn(),
  listConnectionGroups: vi.fn(),
  createConnectionGroup: vi.fn(),
  renameConnectionGroup: vi.fn(),
  deleteConnectionGroup: vi.fn(),
  setConnectionGroupCollapsed: vi.fn(),
  moveConnectionToGroup: vi.fn(),
  exportConnections: vi.fn(),
  importConnections: vi.fn(),
  testConnection: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  forceDisconnect: vi.fn(),
  pingConnection: vi.fn(),
  // connectionStore 已迁移到 cached 版本，需要同时 stub 这两个 API。
  getSessionInfo: vi.fn(),
  getSessionInfoCached: vi.fn(),
  invalidateSessionInfoCache: vi.fn(),
}));

// Mock databaseStore 和 tableDataStore (connect/disconnect/switchActive 时会调用)
const mockSelectDatabase = vi.fn();
const mockSwitchToConnection = vi.fn();
const mockRemoveConnectionState = vi.fn();
vi.mock("../stores/tableDataStore", () => ({
  useTableDataStore: {
    getState: () => ({ reset: vi.fn(), removeConnectionCache: vi.fn() }),
  },
}));
vi.mock("../stores/databaseStore", () => ({
  useDatabaseStore: {
    getState: () => ({
      connectionStates: {
        "conn-456": {
          databases: ["db1", "myapp"],
          tables: {},
          openTables: [],
          activeTableTabIndex: 0,
          openTabs: [],
          activeTabIndex: 0,
          sqlTabContents: {},
          sqlTabResults: {},
          showDatabaseOverviewWhenSqlActive: false,
          tableStructures: {},
          tableInfos: {},
          selectedDatabase: null,
          selectedTable: null,
          expandedKeys: [],
          databaseSortOrder: "asc" as const,
          tableSortOrder: "asc" as const,
          tableStructure: null,
          selectedTableInfo: null,
          databaseInfo: null,
        },
      },
      selectDatabase: mockSelectDatabase,
      switchToConnection: mockSwitchToConnection,
      removeConnectionState: mockRemoveConnectionState,
    }),
  },
}));

import * as api from "../services/tauriCommands";

const mockApi = vi.mocked(api);

const mockSessionInfo = {
  version: "8.0.0",
  hostname: "h",
  server_read_only: false,
  max_execution_time_ms: 0,
  time_zone: "SYSTEM",
  database: null as string | null,
  connection_id: 1,
  grant_write_capable: true,
};

describe("connectionStore", () => {
  beforeEach(() => {
    mockApi.getSessionInfo.mockResolvedValue({ ...mockSessionInfo });
    mockApi.getSessionInfoCached.mockResolvedValue({ ...mockSessionInfo });
    // 重置 store 状态
    useConnectionStore.setState({
      savedConnections: [],
      connectionGroups: [],
      activeConnections: {},
      activeConnId: null,
      activeConnection: null,
      loading: false,
      error: null,
      showConnectionForm: false,
      editingConnection: null,
    });
    vi.clearAllMocks();
  });

  describe("database type utilities", () => {
    it("应该识别 SQLite/SQL Server 并保留未知类型回退到 MySQL", () => {
      expect(normalizeDatabaseType("sqlite")).toBe("sqlite");
      expect(normalizeDatabaseType("sqlserver")).toBe("sqlserver");
      expect(normalizeDatabaseType("unknown")).toBe("mysql");
      expect(defaultPortForDatabaseType("sqlite")).toBe(0);
      expect(defaultPortForDatabaseType("sqlserver")).toBe(1433);
    });
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useConnectionStore.getState();
      expect(state.savedConnections).toEqual([]);
      expect(state.activeConnection).toBeNull();
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
      expect(state.showConnectionForm).toBe(false);
      expect(state.editingConnection).toBeNull();
    });
  });

  describe("loadSavedConnections", () => {
    it("应该加载已保存的连接列表", async () => {
      const mockConnections = [
        {
          id: "1",
          name: "Test",
          host: "localhost",
          port: 3306,
          username: "root",
          password: "pass",
        },
      ];
      mockApi.listSavedConnections.mockResolvedValue(mockConnections);

      await useConnectionStore.getState().loadSavedConnections();

      const state = useConnectionStore.getState();
      expect(state.savedConnections).toEqual([
        { ...mockConnections[0], database_type: "mysql" },
      ]);
      expect(state.loading).toBe(false);
      expect(state.error).toBeNull();
    });

    it("加载旧连接时应默认补齐 mysql 数据库类型", async () => {
      mockApi.listSavedConnections.mockResolvedValue([
        {
          id: "legacy",
          name: "Legacy",
          host: "localhost",
          port: 3306,
          username: "root",
        },
      ]);

      await useConnectionStore.getState().loadSavedConnections();

      expect(
        useConnectionStore.getState().savedConnections[0]?.database_type
      ).toBe("mysql");
    });

    it("加载失败时应该设置错误信息", async () => {
      mockApi.listSavedConnections.mockRejectedValue("加载失败");

      await useConnectionStore.getState().loadSavedConnections();

      const state = useConnectionStore.getState();
      expect(state.error).toBe("加载失败");
      expect(state.loading).toBe(false);
    });
  });

  describe("reorderConnectionGroups", () => {
    it("应该保存分组顺序并刷新分组列表", async () => {
      const groups = [
        { id: "group-2", name: "Stage" },
        { id: "group-1", name: "Dev" },
      ];
      mockApi.reorderConnectionGroups.mockResolvedValue(undefined);
      mockApi.listConnectionGroups.mockResolvedValue(groups);

      await useConnectionStore
        .getState()
        .reorderConnectionGroups(["group-2", "group-1"]);

      expect(mockApi.reorderConnectionGroups).toHaveBeenCalledWith([
        "group-2",
        "group-1",
      ]);
      expect(useConnectionStore.getState().connectionGroups).toEqual(groups);
      expect(useConnectionStore.getState().loading).toBe(false);
    });
  });

  describe("saveConnection", () => {
    it("应该保存连接并刷新列表", async () => {
      const config = {
        name: "New",
        host: "localhost",
        port: 3306,
        username: "root",
        password: "pass",
      };
      mockApi.saveConnection.mockResolvedValue(undefined);
      mockApi.listSavedConnections.mockResolvedValue([
        { ...config, id: "new-id" },
      ]);

      await useConnectionStore.getState().saveConnection(config);

      expect(mockApi.saveConnection).toHaveBeenCalledWith({
        ...config,
        database_type: "mysql",
      });
      const state = useConnectionStore.getState();
      expect(state.savedConnections).toHaveLength(1);
      expect(state.showConnectionForm).toBe(false);
    });

    it("编辑当前活跃连接并修改默认数据库时应更新并自动选中", async () => {
      const connId = "conn-456";
      const config = {
        id: "1",
        name: "Test",
        host: "localhost",
        port: 3306,
        username: "root",
        password: "pass",
        database: "myapp",
      };
      const conn = {
        connId,
        config: {
          id: "1",
          name: "Test",
          host: "localhost",
          port: 3306,
          username: "root",
          password: "pass",
          database: "db1",
        },
      };
      useConnectionStore.setState({
        activeConnections: { [connId]: conn },
        activeConnId: connId,
        activeConnection: conn,
      });

      mockApi.saveConnection.mockResolvedValue(undefined);
      mockApi.listSavedConnections.mockResolvedValue([config]);
      mockSelectDatabase.mockResolvedValue(undefined);

      await useConnectionStore.getState().saveConnection(config);

      const state = useConnectionStore.getState();
      expect(state.activeConnection?.config.database).toBe("myapp");
      expect(mockSelectDatabase).toHaveBeenCalledWith(connId, "myapp");
    });

    it("编辑非活跃连接时不应调用 selectDatabase", async () => {
      const config = {
        id: "2",
        name: "Other",
        host: "localhost",
        port: 3306,
        username: "root",
        password: "pass",
        database: "myapp",
      };
      const conn = {
        connId: "conn-789",
        config: {
          id: "1",
          name: "Current",
          host: "localhost",
          port: 3306,
          username: "root",
          password: "pass",
        },
      };
      useConnectionStore.setState({
        activeConnections: { "conn-789": conn },
        activeConnId: "conn-789",
        activeConnection: conn,
      });

      mockApi.saveConnection.mockResolvedValue(undefined);
      mockApi.listSavedConnections.mockResolvedValue([
        {
          id: "1",
          name: "Current",
          host: "localhost",
          port: 3306,
          username: "root",
        },
        config,
      ]);

      await useConnectionStore.getState().saveConnection(config);

      expect(mockSelectDatabase).not.toHaveBeenCalled();
    });
  });

  describe("connect", () => {
    it("应该建立连接并更新活跃连接状态", async () => {
      const config = {
        id: "1",
        name: "Test",
        host: "localhost",
        port: 3306,
        username: "root",
        password: "pass",
      };
      mockApi.getDecryptedConnection.mockResolvedValue(config);
      mockApi.connect.mockResolvedValue("conn-id-123");
      await useConnectionStore.getState().connect(config);

      expect(mockApi.getDecryptedConnection).toHaveBeenCalledWith("1");
      expect(mockApi.getSessionInfoCached).toHaveBeenCalledWith(
        "conn-id-123",
        null
      );
      const state = useConnectionStore.getState();
      expect(state.activeConnection).toEqual({
        connId: "conn-id-123",
        config: { ...config, database_type: "mysql" },
        sessionGrantWriteCapable: true,
      });
      expect(state.activeConnections["conn-id-123"]).toBeDefined();
      expect(state.activeConnId).toBe("conn-id-123");
      expect(state.loading).toBe(false);
    });

    it("连接失败时应该设置错误信息", async () => {
      const config = {
        name: "Test",
        host: "invalid",
        port: 3306,
        username: "root",
        password: "pass",
      };
      mockApi.connect.mockRejectedValue("连接失败");

      await useConnectionStore.getState().connect(config);

      // 无 id 时不会调用 getDecryptedConnection
      expect(mockApi.getDecryptedConnection).not.toHaveBeenCalled();
      const state = useConnectionStore.getState();
      expect(state.activeConnection).toBeNull();
      expect(state.error).toBe("连接失败");
    });

    it("SQLite 路径和安全选项一致时应该复用已有连接", async () => {
      const existing = {
        connId: "sqlite-conn",
        config: {
          database_type: "sqlite" as const,
          name: "Local",
          host: "",
          port: 0,
          username: "",
          sqlite_path: "/tmp/app.db",
          read_only: true,
          skip_dangerous_sql_confirm: false,
        },
        sessionGrantWriteCapable: true,
      };
      useConnectionStore.setState({
        activeConnections: { "sqlite-conn": existing },
        activeConnId: "sqlite-conn",
        activeConnection: existing,
      });

      await useConnectionStore.getState().connect({
        database_type: "sqlite",
        name: "Local Copy",
        host: "",
        port: 0,
        username: "",
        sqlite_path: "/tmp/app.db",
        read_only: true,
        skip_dangerous_sql_confirm: false,
      });

      expect(mockApi.connect).not.toHaveBeenCalled();
      expect(useConnectionStore.getState().activeConnId).toBe("sqlite-conn");
      expect(mockSwitchToConnection).toHaveBeenCalledWith("sqlite-conn");
    });

    it("SQLite 路径不同时应该建立新连接", async () => {
      const existing = {
        connId: "sqlite-conn",
        config: {
          database_type: "sqlite" as const,
          name: "Local",
          host: "",
          port: 0,
          username: "",
          sqlite_path: "/tmp/app.db",
          read_only: false,
          skip_dangerous_sql_confirm: false,
        },
        sessionGrantWriteCapable: true,
      };
      useConnectionStore.setState({
        activeConnections: { "sqlite-conn": existing },
        activeConnId: "sqlite-conn",
        activeConnection: existing,
      });
      mockApi.connect.mockResolvedValue("sqlite-conn-2");

      await useConnectionStore.getState().connect({
        database_type: "sqlite",
        name: "Other",
        host: "",
        port: 0,
        username: "",
        sqlite_path: "/tmp/other.db",
        read_only: false,
        skip_dangerous_sql_confirm: false,
      });

      expect(mockApi.connect).toHaveBeenCalledWith(
        expect.objectContaining({ sqlite_path: "/tmp/other.db" })
      );
      expect(useConnectionStore.getState().activeConnId).toBe("sqlite-conn-2");
    });
  });

  describe("disconnect", () => {
    it("应该断开连接并清除活跃状态", async () => {
      const conn = {
        connId: "conn-123",
        config: {
          id: "1",
          name: "Test",
          host: "localhost",
          port: 3306,
          username: "root",
          password: "pass",
        },
      };
      useConnectionStore.setState({
        activeConnections: { "conn-123": conn },
        activeConnId: "conn-123",
        activeConnection: conn,
      });

      mockApi.disconnect.mockResolvedValue(undefined);

      await useConnectionStore.getState().disconnect();

      const state = useConnectionStore.getState();
      expect(state.activeConnection).toBeNull();
      expect(mockApi.disconnect).toHaveBeenCalledWith("conn-123");
    });

    it("没有活跃连接时不应该调用 API", async () => {
      await useConnectionStore.getState().disconnect();
      expect(mockApi.disconnect).not.toHaveBeenCalled();
    });
  });

  describe("forceCleanupConnection", () => {
    it("强制清理时即使后端报错也应清掉前端状态", async () => {
      const conn = {
        connId: "conn-zzz",
        config: {
          id: "1",
          name: "Dead",
          host: "localhost",
          port: 3306,
          username: "root",
          password: "pass",
        },
      };
      useConnectionStore.setState({
        activeConnections: { "conn-zzz": conn },
        activeConnId: "conn-zzz",
        activeConnection: conn,
      });

      mockApi.forceDisconnect.mockRejectedValue("network died");

      await useConnectionStore.getState().forceCleanupConnection("conn-zzz");

      const state = useConnectionStore.getState();
      expect(state.activeConnection).toBeNull();
      expect(state.activeConnections["conn-zzz"]).toBeUndefined();
      expect(state.activeConnId).toBeNull();
      expect(mockApi.forceDisconnect).toHaveBeenCalledWith("conn-zzz");
      // forceCleanup 不应留下错误信息（这是它与 disconnect 的关键差异）
      expect(state.error).toBeNull();
      expect(mockRemoveConnectionState).toHaveBeenCalledWith("conn-zzz");
    });

    it("强制清理不存在的连接应静默返回", async () => {
      await useConnectionStore.getState().forceCleanupConnection("not-there");
      expect(mockApi.forceDisconnect).not.toHaveBeenCalled();
      expect(useConnectionStore.getState().error).toBeNull();
    });

    it("强制清理非活跃连接时不应改变 activeConnId", async () => {
      const active = {
        connId: "conn-a",
        config: {
          id: "1",
          name: "A",
          host: "h1",
          port: 3306,
          username: "root",
        },
      };
      const other = {
        connId: "conn-b",
        config: {
          id: "2",
          name: "B",
          host: "h2",
          port: 3306,
          username: "root",
        },
      };
      useConnectionStore.setState({
        activeConnections: { "conn-a": active, "conn-b": other },
        activeConnId: "conn-a",
        activeConnection: active,
      });

      mockApi.forceDisconnect.mockResolvedValue(undefined);

      await useConnectionStore.getState().forceCleanupConnection("conn-b");

      const state = useConnectionStore.getState();
      expect(state.activeConnId).toBe("conn-a");
      expect(state.activeConnection).toEqual(active);
      expect(state.activeConnections["conn-b"]).toBeUndefined();
    });
  });

  describe("testConnection", () => {
    it("测试成功时应该返回成功结果", async () => {
      const config = {
        name: "Test",
        host: "localhost",
        port: 3306,
        username: "root",
        password: "pass",
      };
      mockApi.testConnection.mockResolvedValue({
        success: true,
        message: "连接成功! 延迟: 15ms",
        latency_ms: 15,
      });

      const result = await useConnectionStore.getState().testConnection(config);

      expect(result.success).toBe(true);
      expect(result.message).toContain("连接成功");
    });

    it("测试失败时应该返回失败结果", async () => {
      const config = {
        name: "Test",
        host: "invalid",
        port: 3306,
        username: "root",
        password: "pass",
      };
      mockApi.testConnection.mockRejectedValue("连接超时");

      const result = await useConnectionStore.getState().testConnection(config);

      expect(result.success).toBe(false);
    });
  });

  describe("UI 状态管理", () => {
    it("showNewConnectionForm 应该显示空表单", () => {
      useConnectionStore.getState().showNewConnectionForm();

      const state = useConnectionStore.getState();
      expect(state.showConnectionForm).toBe(true);
      expect(state.editingConnection).toBeNull();
    });

    it("showEditConnectionForm 应该获取解密配置并显示编辑表单", async () => {
      const config = {
        id: "1",
        name: "Test",
        host: "localhost",
        port: 3306,
        username: "root",
        password: "pass",
      };
      mockApi.getDecryptedConnection.mockResolvedValue(config);

      await useConnectionStore.getState().showEditConnectionForm("1");

      expect(mockApi.getDecryptedConnection).toHaveBeenCalledWith("1");
      const state = useConnectionStore.getState();
      expect(state.showConnectionForm).toBe(true);
      expect(state.editingConnection).toEqual({
        ...config,
        database_type: "mysql",
      });
    });

    it("hideConnectionForm 应该关闭表单", () => {
      useConnectionStore.setState({
        showConnectionForm: true,
        editingConnection: {
          id: "1",
          name: "Test",
          host: "localhost",
          port: 3306,
          username: "root",
          password: "pass",
        },
      });

      useConnectionStore.getState().hideConnectionForm();

      const state = useConnectionStore.getState();
      expect(state.showConnectionForm).toBe(false);
      expect(state.editingConnection).toBeNull();
    });

    it("clearError 应该清除错误信息", () => {
      useConnectionStore.setState({ error: "something went wrong" });

      useConnectionStore.getState().clearError();

      expect(useConnectionStore.getState().error).toBeNull();
    });
  });

  describe("deleteSavedConnection", () => {
    it("应该删除连接并刷新列表", async () => {
      useConnectionStore.setState({
        savedConnections: [
          {
            id: "1",
            name: "Test",
            host: "localhost",
            port: 3306,
            username: "root",
            password: "pass",
          },
        ],
      });

      mockApi.deleteSavedConnection.mockResolvedValue(undefined);
      mockApi.listSavedConnections.mockResolvedValue([]);

      await useConnectionStore.getState().deleteSavedConnection("1");

      expect(mockApi.deleteSavedConnection).toHaveBeenCalledWith("1");
      expect(useConnectionStore.getState().savedConnections).toEqual([]);
    });

    it("删除当前活跃连接时应该先断开", async () => {
      const conn = {
        connId: "conn-123",
        config: {
          id: "1",
          name: "Test",
          host: "localhost",
          port: 3306,
          username: "root",
          password: "pass",
        },
      };
      useConnectionStore.setState({
        activeConnections: { "conn-123": conn },
        activeConnId: "conn-123",
        activeConnection: conn,
      });

      mockApi.disconnect.mockResolvedValue(undefined);
      mockApi.deleteSavedConnection.mockResolvedValue(undefined);
      mockApi.listSavedConnections.mockResolvedValue([]);

      await useConnectionStore.getState().deleteSavedConnection("1");

      expect(mockApi.disconnect).toHaveBeenCalledWith("conn-123");
      expect(useConnectionStore.getState().activeConnection).toBeNull();
    });
  });

  describe("reorderConnections", () => {
    it("应该按新顺序调用 API 并刷新列表", async () => {
      const reordered = [
        { id: "2", name: "B", host: "b", port: 3306, username: "root" },
        { id: "1", name: "A", host: "a", port: 3306, username: "root" },
      ];
      mockApi.reorderConnections.mockResolvedValue(undefined);
      mockApi.listSavedConnections.mockResolvedValue(reordered);

      await useConnectionStore.getState().reorderConnections(["2", "1"]);

      expect(mockApi.reorderConnections).toHaveBeenCalledWith(["2", "1"]);
      expect(useConnectionStore.getState().savedConnections).toEqual(
        reordered.map((conn) => ({ ...conn, database_type: "mysql" }))
      );
    });

    it("失败时应该设置错误信息", async () => {
      mockApi.reorderConnections.mockRejectedValue("保存失败");

      await useConnectionStore.getState().reorderConnections(["1", "2"]);

      expect(useConnectionStore.getState().error).toBe("保存失败");
    });
  });

  describe("connectionGroups", () => {
    it("删除分组后应刷新分组和连接列表", async () => {
      mockApi.deleteConnectionGroup.mockResolvedValue(undefined);
      mockApi.listConnectionGroups.mockResolvedValue([]);
      mockApi.listSavedConnections.mockResolvedValue([
        {
          id: "conn-1",
          name: "Local",
          host: "localhost",
          port: 3306,
          username: "root",
        },
      ]);

      await useConnectionStore.getState().deleteConnectionGroup("group-1");

      expect(mockApi.deleteConnectionGroup).toHaveBeenCalledWith("group-1");
      expect(useConnectionStore.getState().connectionGroups).toEqual([]);
      expect(useConnectionStore.getState().savedConnections).toHaveLength(1);
    });
  });

  describe("import/export connections", () => {
    it("导出连接时应该把路径和迁移密码传给后端并返回导出数量", async () => {
      mockApi.exportConnections.mockResolvedValue(2);

      const count = await useConnectionStore
        .getState()
        .exportConnections("/tmp/db-connect-connections.json", "迁移密码");

      expect(mockApi.exportConnections).toHaveBeenCalledWith(
        "/tmp/db-connect-connections.json",
        "迁移密码"
      );
      expect(count).toBe(2);
      expect(useConnectionStore.getState().loading).toBe(false);
    });

    it("导入连接时应该把路径和迁移密码传给后端并刷新连接和分组列表", async () => {
      const groups = [{ id: "group-1", name: "Imported" }];
      const connections = [
        {
          id: "conn-1",
          name: "Imported Local",
          host: "localhost",
          port: 3306,
          username: "root",
        },
      ];
      mockApi.importConnections.mockResolvedValue({
        imported_connections: 1,
        imported_groups: 1,
      });
      mockApi.listConnectionGroups.mockResolvedValue(groups);
      mockApi.listSavedConnections.mockResolvedValue(connections);

      const result = await useConnectionStore
        .getState()
        .importConnections("/tmp/db-connect-connections.json", "迁移密码");

      expect(mockApi.importConnections).toHaveBeenCalledWith(
        "/tmp/db-connect-connections.json",
        "迁移密码"
      );
      expect(result).toEqual({
        imported_connections: 1,
        imported_groups: 1,
      });
      expect(useConnectionStore.getState().connectionGroups).toEqual(groups);
      expect(useConnectionStore.getState().savedConnections).toEqual(
        connections.map((conn) => ({ ...conn, database_type: "mysql" }))
      );
      expect(useConnectionStore.getState().loading).toBe(false);
    });
  });

  describe("connect 与 SSL 维度", () => {
    it("同一主机用户名但 ssl_mode 不同应新建连接", async () => {
      const base = {
        name: "T",
        host: "localhost",
        port: 3306,
        username: "root",
        password: "p",
      };
      const existing = {
        connId: "conn-a",
        config: { ...base, ssl_mode: "disabled" },
      };
      useConnectionStore.setState({
        activeConnections: { "conn-a": existing },
        activeConnId: "conn-a",
        activeConnection: existing,
      });
      mockApi.connect.mockResolvedValue("conn-b");

      await useConnectionStore
        .getState()
        .connect({ ...base, ssl_mode: "required" });

      expect(mockApi.connect).toHaveBeenCalledTimes(1);
      expect(useConnectionStore.getState().activeConnId).toBe("conn-b");
    });

    it("同一主机但 read_only 不同应新建连接", async () => {
      const base = {
        name: "T",
        host: "localhost",
        port: 3306,
        username: "root",
        password: "p",
      };
      const existing = {
        connId: "conn-a",
        config: { ...base, read_only: false as boolean | undefined },
      };
      useConnectionStore.setState({
        activeConnections: { "conn-a": existing },
        activeConnId: "conn-a",
        activeConnection: existing,
      });
      mockApi.connect.mockResolvedValue("conn-b");

      await useConnectionStore.getState().connect({ ...base, read_only: true });

      expect(mockApi.connect).toHaveBeenCalledTimes(1);
      expect(useConnectionStore.getState().activeConnId).toBe("conn-b");
    });

    it("同一会话但数据库类型不同时应新建连接", async () => {
      const base = {
        name: "T",
        host: "localhost",
        port: 3306,
        username: "root",
        password: "p",
      };
      const existing = {
        connId: "conn-a",
        config: { ...base, database_type: "mysql" as const },
      };
      useConnectionStore.setState({
        activeConnections: { "conn-a": existing },
        activeConnId: "conn-a",
        activeConnection: existing,
      });
      mockApi.connect.mockResolvedValue("conn-b");

      await useConnectionStore
        .getState()
        .connect({ ...base, database_type: "postgres" });

      expect(mockApi.connect).toHaveBeenCalledTimes(1);
      expect(useConnectionStore.getState().activeConnId).toBe("conn-b");
    });
  });
});
