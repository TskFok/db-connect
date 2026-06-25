import { describe, it, expect, vi, beforeEach } from "vitest";
import { useDatabaseStore, emptyConnState } from "../stores/databaseStore";
import { useTableDataStore } from "../stores/tableDataStore";
import { getDatabaseCapabilities } from "../utils/databaseCapabilities";

// Mock Tauri API
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Mock api service
vi.mock("../services/tauriCommands", () => ({
  listDatabases: vi.fn(),
  listTables: vi.fn(),
  getTableStructure: vi.fn(),
  getDatabaseInfo: vi.fn(),
  executeSql: vi.fn(),
  queryTableData: vi.fn(),
  queryTableCount: vi.fn(),
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
  // Phase 1 的方法也需要 mock (被其他 store 引用)
  listSavedConnections: vi.fn(),
  saveConnection: vi.fn(),
  deleteSavedConnection: vi.fn(),
  testConnection: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

import * as api from "../services/tauriCommands";

const mockApi = vi.mocked(api);

describe("databaseStore", () => {
  beforeEach(() => {
    useTableDataStore.getState().reset();
    useDatabaseStore.getState().reset();
    useDatabaseStore.getState().switchToConnection("conn-1");
    vi.clearAllMocks();
  });

  describe("初始状态", () => {
    it("应该有正确的初始值", () => {
      const state = useDatabaseStore.getState();
      expect(state.databases).toEqual([]);
      expect(state.tables).toEqual({});
      expect(state.selectedDatabase).toBeNull();
      expect(state.selectedTable).toBeNull();
      expect(state.tableStructure).toBeNull();
      expect(state.selectedTableInfo).toBeNull();
      expect(state.treeLoading).toBe(false);
      expect(state.structureLoading).toBe(false);
      expect(state.structureError).toBeNull();
      expect(state.expandedKeys).toEqual([]);
      expect(state.databaseSortOrder).toBe("asc");
      expect(state.tableSortOrder).toBe("asc");
      expect(state.tableContentActiveTab).toBe("data");
      expect(state.openTabs).toEqual([]);
      expect(state.activeTabIndex).toBe(0);
      expect(state.sqlTabContents).toEqual({});
      expect(state.sqlTabExecuteNonce).toEqual({});
    });

    it("数据库 capability 应区分 MySQL 全量能力与 PostgreSQL（阶段五：索引/外键/触发器/例程已开放，但不展示 MySQL 独有的事件/引擎/字符集）", () => {
      expect(getDatabaseCapabilities("mysql")).toMatchObject({
        sqlEditor: true,
        databaseManagement: true,
        tableDataEditing: true,
        schemaManagement: true,
        routineManagement: true,
        eventManagement: true,
        charsetAndCollation: true,
        storageEngine: true,
        columnReordering: true,
        databaseObjectNoun: "数据库",
      });
      expect(getDatabaseCapabilities("postgres")).toMatchObject({
        sqlEditor: true,
        // PostgreSQL 已支持 schema/table/column DDL（schema 语义）
        databaseManagement: true,
        tableBrowsing: true,
        tableDataEditing: true,
        schemaManagement: true,
        // 阶段五：开放索引/外键/触发器/例程
        routineManagement: true,
        triggerManagement: true,
        indexManagement: true,
        foreignKeyManagement: true,
        // PostgreSQL 无定时事件等价物
        eventManagement: false,
        sqlFileImportExport: true,
        // PostgreSQL 不暴露字符集/引擎/列重排
        charsetAndCollation: false,
        storageEngine: false,
        columnReordering: false,
        databaseObjectNoun: "schema",
      });
    });
  });

  describe("openSqlTab", () => {
    it("应该添加新的 SQL 标签页", () => {
      useDatabaseStore.getState().openSqlTab("conn-1");
      const state = useDatabaseStore.getState();
      expect(state.openTabs).toHaveLength(1);
      expect(state.openTabs[0].type).toBe("sql");
      expect(state.openTabs[0]).toHaveProperty("id");
      expect(state.activeTabIndex).toBe(0);
    });

    it("可以打开多个 SQL 标签页", () => {
      useDatabaseStore.getState().openSqlTab("conn-1");
      useDatabaseStore.getState().openSqlTab("conn-1");
      const state = useDatabaseStore.getState();
      expect(state.openTabs).toHaveLength(2);
      expect(state.openTabs[0].type).toBe("sql");
      expect(state.openTabs[1].type).toBe("sql");
      expect(state.activeTabIndex).toBe(1);
    });

    it("可传入初始 SQL 内容", () => {
      useDatabaseStore.getState().openSqlTab("conn-1", "SELECT * FROM users");
      const state = useDatabaseStore.getState();
      const tabId = state.openTabs[0].type === "sql" ? state.openTabs[0].id : "";
      expect(state.sqlTabContents[tabId]).toBe("SELECT * FROM users");
    });

    it("requestSqlTabExecute 为指定 SQL 标签递增 nonce", () => {
      useDatabaseStore.getState().openSqlTab("conn-1", "SELECT 1");
      const state0 = useDatabaseStore.getState();
      const sqlId =
        state0.openTabs[0].type === "sql" ? state0.openTabs[0].id : "";
      expect(state0.sqlTabExecuteNonce?.[sqlId]).toBeUndefined();

      useDatabaseStore.getState().requestSqlTabExecute("conn-1", sqlId);
      expect(useDatabaseStore.getState().sqlTabExecuteNonce?.[sqlId]).toBe(1);

      useDatabaseStore.getState().requestSqlTabExecute("conn-1", sqlId);
      expect(useDatabaseStore.getState().sqlTabExecuteNonce?.[sqlId]).toBe(2);
    });

    it("requestSqlTabExecute 对不存在的标签 id 不生效", () => {
      useDatabaseStore.getState().openSqlTab("conn-1", "SELECT 1");
      useDatabaseStore.getState().requestSqlTabExecute("conn-1", "unknown-tab-id");
      const state = useDatabaseStore.getState();
      expect(Object.keys(state.sqlTabExecuteNonce ?? {})).toHaveLength(0);
    });
  });

  describe("数据库和表排序", () => {
    it("setDatabaseSortOrder 应该设置数据库排序方式", () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.getState().setDatabaseSortOrder("asc");
      expect(useDatabaseStore.getState().databaseSortOrder).toBe("asc");

      useDatabaseStore.getState().setDatabaseSortOrder("desc");
      expect(useDatabaseStore.getState().databaseSortOrder).toBe("desc");
    });

    it("setTableSortOrder 应该设置表排序方式", () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.getState().setTableSortOrder("asc");
      expect(useDatabaseStore.getState().tableSortOrder).toBe("asc");

      useDatabaseStore.getState().setTableSortOrder("desc");
      expect(useDatabaseStore.getState().tableSortOrder).toBe("desc");
    });

    it("reset 后应恢复为 asc", () => {
      useDatabaseStore.getState().setDatabaseSortOrder("desc");
      useDatabaseStore.getState().setTableSortOrder("desc");
      useDatabaseStore.getState().reset();
      expect(useDatabaseStore.getState().databaseSortOrder).toBe("asc");
      expect(useDatabaseStore.getState().tableSortOrder).toBe("asc");
    });
  });

  describe("setTableContentActiveTab", () => {
    it("应该设置表内容区激活的 tab", () => {
      useDatabaseStore.getState().setTableContentActiveTab("data");
      expect(useDatabaseStore.getState().tableContentActiveTab).toBe("data");

      useDatabaseStore.getState().setTableContentActiveTab("sql");
      expect(useDatabaseStore.getState().tableContentActiveTab).toBe("sql");
    });

    it("reset 后应恢复为 data", () => {
      useDatabaseStore.getState().setTableContentActiveTab("structure");
      useDatabaseStore.getState().reset();
      expect(useDatabaseStore.getState().tableContentActiveTab).toBe("data");
    });
  });

  describe("loadDatabases", () => {
    it("应该加载数据库列表", async () => {
      const mockDbs = ["information_schema", "mysql", "myapp"];
      mockApi.listDatabases.mockResolvedValue(mockDbs);

      await useDatabaseStore.getState().loadDatabases("conn-1");

      const state = useDatabaseStore.getState();
      expect(state.databases).toEqual(mockDbs);
      expect(state.treeLoading).toBe(false);
      expect(mockApi.listDatabases).toHaveBeenCalledWith("conn-1");
    });

    it("加载失败时应该保持空列表", async () => {
      mockApi.listDatabases.mockRejectedValue("连接失败");

      await useDatabaseStore.getState().loadDatabases("conn-1");

      const state = useDatabaseStore.getState();
      expect(state.databases).toEqual([]);
      expect(state.treeLoading).toBe(false);
    });

    it("传入默认数据库且在列表中时应自动选中", async () => {
      const mockDbs = ["information_schema", "mysql", "myapp"];
      const mockTables = [
        {
          name: "users",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 100,
          data_length: 16384, index_length: null,
          comment: "",
        },
      ];
      mockApi.listDatabases.mockResolvedValue(mockDbs);
      mockApi.listTables.mockResolvedValue(mockTables);

      await useDatabaseStore.getState().loadDatabases("conn-1", "myapp");

      const state = useDatabaseStore.getState();
      expect(state.databases).toEqual(mockDbs);
      expect(state.selectedDatabase).toBe("myapp");
      expect(mockApi.listTables).toHaveBeenCalledWith("conn-1", "myapp");
    });

    it("默认数据库不在列表中时不应选中", async () => {
      const mockDbs = ["information_schema", "mysql"];
      mockApi.listDatabases.mockResolvedValue(mockDbs);

      await useDatabaseStore.getState().loadDatabases("conn-1", "nonexistent");

      const state = useDatabaseStore.getState();
      expect(state.databases).toEqual(mockDbs);
      expect(state.selectedDatabase).toBeNull();
      expect(mockApi.listTables).not.toHaveBeenCalled();
    });
  });

  describe("loadTables", () => {
    it("应该加载指定数据库的表列表", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      const mockTables = [
        {
          name: "users",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 100,
          data_length: 16384, index_length: null,
          comment: "",
        },
        {
          name: "active_users",
          table_type: "VIEW",
          engine: null,
          rows: null,
          data_length: null, index_length: null,
          comment: "",
        },
      ];
      mockApi.listTables.mockResolvedValue(mockTables);

      await useDatabaseStore.getState().loadTables("conn-1", "myapp");

      const state = useDatabaseStore.getState();
      expect(state.tables["myapp"]).toEqual(mockTables);
      expect(state.tables["myapp"]).toHaveLength(2);
      expect(mockApi.listTables).toHaveBeenCalledWith("conn-1", "myapp");
    });

    it("应该保留其他数据库的表数据", async () => {
      // 先加载 db1 的表
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        activeConnId: "conn-1",
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["db1", "db2"],
            tables: {
              db1: [
                {
                  name: "t1",
                  table_type: "TABLE",
                  engine: "InnoDB",
                  rows: 10,
                  data_length: 0, index_length: null,
                  comment: "",
                },
              ],
            },
            selectedDatabase: null,
            selectedTable: null,
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: null,
            selectedTableInfo: null,
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
        databases: ["db1", "db2"],
        tables: {
          db1: [
            {
              name: "t1",
              table_type: "TABLE",
              engine: "InnoDB",
              rows: 10,
              data_length: 0, index_length: null,
              comment: "",
            },
          ],
        },
      });

      mockApi.listTables.mockResolvedValue([
        {
          name: "t2",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 20,
          data_length: 0, index_length: null,
          comment: "",
        },
      ]);

      await useDatabaseStore.getState().loadTables("conn-1", "db2");

      const state = useDatabaseStore.getState();
      expect(state.tables["db1"]).toHaveLength(1);
      expect(state.tables["db2"]).toHaveLength(1);
    });
  });

  describe("selectTable", () => {
    it("应该选中表并加载结构", async () => {
      // 预设表列表
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {
              myapp: [
                {
                  name: "users",
                  table_type: "TABLE",
                  engine: "InnoDB",
                  rows: 100,
                  data_length: 16384, index_length: null,
                  comment: "用户表",
                },
              ],
            },
            selectedDatabase: null,
            selectedTable: null,
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: null,
            selectedTableInfo: null,
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
        tables: {
          myapp: [
            {
              name: "users",
              table_type: "TABLE",
              engine: "InnoDB",
              rows: 100,
              data_length: 16384, index_length: null,
              comment: "用户表",
            },
          ],
        },
      });

      const mockColumns = [
        {
          name: "id",
          column_type: "bigint unsigned",
          nullable: false,
          key: "PRI",
          default_value: null,
          extra: "auto_increment",
          comment: "主键",
        },
        {
          name: "name",
          column_type: "varchar(255)",
          nullable: false,
          key: "",
          default_value: null,
          extra: "",
          comment: "用户名",
        },
      ];
      mockApi.getTableStructure.mockResolvedValue(mockColumns);

      await useDatabaseStore
        .getState()
        .selectTable("conn-1", "myapp", "users");

      const state = useDatabaseStore.getState();
      expect(state.selectedDatabase).toBe("myapp");
      expect(state.selectedTable).toBe("users");
      expect(state.tableStructure).toEqual(mockColumns);
      expect(state.selectedTableInfo?.name).toBe("users");
      expect(state.structureLoading).toBe(false);
      expect(state.structureError).toBeNull();
      expect(mockApi.getTableStructure).toHaveBeenCalledWith(
        "conn-1",
        "myapp",
        "users"
      );
    });

    it("加载结构失败时应该清空结构数据并设置错误信息", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {
              myapp: [
                {
                  name: "users",
                  table_type: "TABLE",
                  engine: "InnoDB",
                  rows: 100,
                  data_length: 16384, index_length: null,
                  comment: "",
                },
              ],
            },
            selectedDatabase: null,
            selectedTable: null,
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: null,
            selectedTableInfo: null,
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
        tables: { myapp: [{ name: "users", table_type: "TABLE", engine: "InnoDB", rows: 100, data_length: 16384, index_length: null, comment: "" }] },
      });
      mockApi.getTableStructure.mockRejectedValue("查询失败");

      await useDatabaseStore
        .getState()
        .selectTable("conn-1", "myapp", "users");

      const state = useDatabaseStore.getState();
      expect(state.selectedDatabase).toBe("myapp");
      expect(state.selectedTable).toBe("users");
      expect(state.tableStructure).toBeNull();
      expect(state.structureLoading).toBe(false);
      expect(state.structureError).toBe("查询失败");
    });
  });

  describe("setExpandedKeys", () => {
    it("应该更新展开的节点", () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.getState().setExpandedKeys(["db:myapp", "db:test"]);

      expect(useDatabaseStore.getState().expandedKeys).toEqual([
        "db:myapp",
        "db:test",
      ]);
    });
  });

  describe("reset", () => {
    it("应该重置所有状态", () => {
      useDatabaseStore.setState({
        databases: ["db1", "db2"],
        tables: { db1: [] },
        selectedDatabase: "db1",
        selectedTable: "t1",
        tableStructure: [],
        expandedKeys: ["db:db1"],
      });

      useDatabaseStore.getState().reset();

      const state = useDatabaseStore.getState();
      expect(state.databases).toEqual([]);
      expect(state.tables).toEqual({});
      expect(state.selectedDatabase).toBeNull();
      expect(state.selectedTable).toBeNull();
      expect(state.tableStructure).toBeNull();
      expect(state.expandedKeys).toEqual([]);
      expect(state.openTabs).toEqual([]);
      expect(state.activeTabIndex).toBe(0);
    });
  });

  describe("多表快速切换", () => {
    it("openOrSwitchToTable 应添加新表到 openTables 而非替换", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {
              myapp: [
                { name: "users", table_type: "TABLE", engine: "InnoDB", rows: 10, data_length: 1024, index_length: null, comment: "" },
                { name: "posts", table_type: "TABLE", engine: "InnoDB", rows: 5, data_length: 512, index_length: null, comment: "" },
              ],
            },
            selectedDatabase: null,
            selectedTable: null,
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: null,
            selectedTableInfo: null,
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
      });
      mockApi.getTableStructure.mockResolvedValue([{ name: "id", column_type: "int", nullable: false, key: "PRI", default_value: null, extra: "", comment: "" }]);

      await useDatabaseStore.getState().openOrSwitchToTable("conn-1", "myapp", "users");
      let state = useDatabaseStore.getState();
      expect(state.openTables).toHaveLength(1);
      expect(state.openTables[0]).toEqual({ database: "myapp", table: "users" });
      expect(state.selectedTable).toBe("users");

      await useDatabaseStore.getState().openOrSwitchToTable("conn-1", "myapp", "posts");
      state = useDatabaseStore.getState();
      expect(state.openTables).toHaveLength(2);
      expect(state.openTables[0]).toEqual({ database: "myapp", table: "users" });
      expect(state.openTables[1]).toEqual({ database: "myapp", table: "posts" });
      expect(state.selectedTable).toBe("posts");
    });

    it("openOrSwitchToTable 已打开的表应切换而不新增", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {
              myapp: [
                { name: "users", table_type: "TABLE", engine: "InnoDB", rows: 10, data_length: 1024, index_length: null, comment: "" },
                { name: "posts", table_type: "TABLE", engine: "InnoDB", rows: 5, data_length: 512, index_length: null, comment: "" },
              ],
            },
            openTables: [{ database: "myapp", table: "users" }, { database: "myapp", table: "posts" }],
            openTabs: [
              { type: "table", database: "myapp", table: "users" },
              { type: "table", database: "myapp", table: "posts" },
            ],
            activeTabIndex: 1,
            activeTableTabIndex: 1,
            sqlTabContents: {},
            tableStructures: {},
            tableInfos: {},
            selectedDatabase: "myapp",
            selectedTable: "posts",
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: null,
            selectedTableInfo: null,
            databaseInfo: null,
          },
        },
        openTabs: [
          { type: "table", database: "myapp", table: "users" },
          { type: "table", database: "myapp", table: "posts" },
        ],
        activeTabIndex: 1,
      });
      mockApi.getTableStructure.mockResolvedValue([{ name: "id", column_type: "int", nullable: false, key: "PRI", default_value: null, extra: "", comment: "" }]);

      await useDatabaseStore.getState().openOrSwitchToTable("conn-1", "myapp", "users");
      const state = useDatabaseStore.getState();
      expect(state.openTables).toHaveLength(2);
      expect(state.activeTableTabIndex).toBe(0);
      expect(state.selectedTable).toBe("users");
      expect(mockApi.getTableStructure).not.toHaveBeenCalled();
    });

    it("switchTableTab 应切换激活的 tab", () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: { myapp: [] },
            openTables: [{ database: "myapp", table: "users" }, { database: "myapp", table: "posts" }],
            openTabs: [
              { type: "table", database: "myapp", table: "users" },
              { type: "table", database: "myapp", table: "posts" },
            ],
            activeTabIndex: 0,
            activeTableTabIndex: 0,
            sqlTabContents: {},
            tableStructures: {
              "myapp|users": [{ name: "id", column_type: "int", nullable: false, key: "PRI", default_value: null, extra: "", comment: "" }],
              "myapp|posts": [{ name: "id", column_type: "int", nullable: false, key: "PRI", default_value: null, extra: "", comment: "" }],
            },
            tableInfos: {
              "myapp|users": { name: "users", table_type: "TABLE", engine: "InnoDB", rows: 10, data_length: 1024, index_length: null, comment: "" },
              "myapp|posts": { name: "posts", table_type: "TABLE", engine: "InnoDB", rows: 5, data_length: 512, index_length: null, comment: "" },
            },
            selectedDatabase: "myapp",
            selectedTable: "users",
            tableStructure: [],
            selectedTableInfo: null,
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            databaseInfo: null,
          },
        },
        openTabs: [
          { type: "table", database: "myapp", table: "users" },
          { type: "table", database: "myapp", table: "posts" },
        ],
        activeTabIndex: 0,
      });

      useDatabaseStore.getState().switchTab("conn-1", 1);
      const state = useDatabaseStore.getState();
      expect(state.activeTableTabIndex).toBe(1);
      expect(state.selectedTable).toBe("posts");
      expect(state.selectedDatabase).toBe("myapp");
    });

    it("closeTableTab 应关闭指定 tab 并切换激活", () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: { myapp: [] },
            openTables: [{ database: "myapp", table: "users" }, { database: "myapp", table: "posts" }],
            openTabs: [
              { type: "table", database: "myapp", table: "users" },
              { type: "table", database: "myapp", table: "posts" },
            ],
            activeTabIndex: 1,
            activeTableTabIndex: 1,
            sqlTabContents: {},
            tableStructures: {
              "myapp|users": [],
              "myapp|posts": [],
            },
            tableInfos: {
              "myapp|users": { name: "users", table_type: "TABLE", engine: "InnoDB", rows: 10, data_length: 1024, index_length: null, comment: "" },
              "myapp|posts": { name: "posts", table_type: "TABLE", engine: "InnoDB", rows: 5, data_length: 512, index_length: null, comment: "" },
            },
            selectedDatabase: "myapp",
            selectedTable: "posts",
            tableStructure: [],
            selectedTableInfo: null,
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            databaseInfo: null,
          },
        },
        openTabs: [
          { type: "table", database: "myapp", table: "users" },
          { type: "table", database: "myapp", table: "posts" },
        ],
        activeTabIndex: 1,
      });

      useDatabaseStore.getState().closeTab("conn-1", 1);
      const state = useDatabaseStore.getState();
      expect(state.openTables).toHaveLength(1);
      expect(state.openTables[0]).toEqual({ database: "myapp", table: "users" });
      expect(state.activeTableTabIndex).toBe(0);
      expect(state.selectedTable).toBe("users");
    });

    it("selectDatabase 应保留 openTables（不关闭已打开的表标签页）", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: { myapp: [] },
            openTables: [{ database: "myapp", table: "users" }],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            selectedDatabase: "myapp",
            selectedTable: "users",
            tableStructure: [],
            selectedTableInfo: null,
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            databaseInfo: null,
          },
        },
      });

      await useDatabaseStore.getState().selectDatabase("conn-1", "myapp");
      const state = useDatabaseStore.getState();
      expect(state.openTables).toHaveLength(1);
      expect(state.openTables[0]).toEqual({ database: "myapp", table: "users" });
      expect(state.selectedDatabase).toBe("myapp");
    });
  });

  describe("refresh", () => {
    it("应该重新加载数据库列表", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      mockApi.listDatabases.mockResolvedValue(["db1", "db2"]);

      await useDatabaseStore.getState().refresh("conn-1");

      const state = useDatabaseStore.getState();
      expect(state.databases).toEqual(["db1", "db2"]);
    });

    it("有选中数据库时应该同时刷新表列表", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {},
            selectedDatabase: "myapp",
            selectedTable: null,
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: null,
            selectedTableInfo: null,
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
        selectedDatabase: "myapp",
      });

      mockApi.listDatabases.mockResolvedValue(["myapp"]);
      mockApi.listTables.mockResolvedValue([
        {
          name: "users",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 200,
          data_length: 32768, index_length: null,
          comment: "",
        },
      ]);

      await useDatabaseStore.getState().refresh("conn-1");

      expect(mockApi.listTables).toHaveBeenCalledWith("conn-1", "myapp");
      expect(useDatabaseStore.getState().tables["myapp"]).toHaveLength(1);
    });

    it("有选中表时应该同时刷新表结构", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {
              myapp: [
                {
                  name: "users",
                  table_type: "TABLE",
                  engine: "InnoDB",
                  rows: 200,
                  data_length: 32768, index_length: null,
                  comment: "",
                },
              ],
            },
            selectedDatabase: "myapp",
            selectedTable: "users",
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: null,
            selectedTableInfo: null,
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
        selectedDatabase: "myapp",
        selectedTable: "users",
      });

      mockApi.listDatabases.mockResolvedValue(["myapp"]);
      mockApi.listTables.mockResolvedValue([
        {
          name: "users",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 200,
          data_length: 32768, index_length: null,
          comment: "",
        },
      ]);
      mockApi.getTableStructure.mockResolvedValue([
        {
          name: "id",
          column_type: "int",
          nullable: false,
          key: "PRI",
          default_value: null,
          extra: "auto_increment",
          comment: "",
        },
      ]);

      await useDatabaseStore.getState().refresh("conn-1");

      expect(mockApi.getTableStructure).toHaveBeenCalledWith(
        "conn-1",
        "myapp",
        "users"
      );
      expect(useDatabaseStore.getState().tableStructure).toHaveLength(1);
    });
  });

  describe("selectDatabase", () => {
    it("应该选中数据库并清空选中的表", async () => {
      const mockTables = [
        {
          name: "users",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 100,
          data_length: 16384, index_length: null,
          comment: "",
        },
      ];
      mockApi.listTables.mockResolvedValue(mockTables);

      await useDatabaseStore.getState().selectDatabase("conn-1", "myapp");

      const state = useDatabaseStore.getState();
      expect(state.selectedDatabase).toBe("myapp");
      expect(state.selectedTable).toBeNull();
      expect(state.tableStructure).toBeNull();
      expect(state.tables["myapp"]).toEqual(mockTables);
    });

    it("如果表列表已缓存则不重复加载", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {
              myapp: [
                {
                  name: "users",
                  table_type: "TABLE",
                  engine: "InnoDB",
                  rows: 100,
                  data_length: 16384, index_length: null,
                  comment: "",
                },
              ],
            },
            selectedDatabase: null,
            selectedTable: null,
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: null,
            selectedTableInfo: null,
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
        tables: {
          myapp: [
            {
              name: "users",
              table_type: "TABLE",
              engine: "InnoDB",
              rows: 100,
              data_length: 16384, index_length: null,
              comment: "",
            },
          ],
        },
      });

      await useDatabaseStore.getState().selectDatabase("conn-1", "myapp");

      expect(mockApi.listTables).not.toHaveBeenCalled();
      expect(useDatabaseStore.getState().selectedDatabase).toBe("myapp");
    });

    it("应该自动展开数据库节点", async () => {
      mockApi.listTables.mockResolvedValue([]);

      await useDatabaseStore.getState().selectDatabase("conn-1", "myapp");

      const state = useDatabaseStore.getState();
      expect(state.expandedKeys).toContain("db:myapp");
    });

    it("如果数据库节点已展开则不重复添加", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: { myapp: [] },
            selectedDatabase: null,
            selectedTable: null,
            expandedKeys: ["db:myapp"],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: null,
            selectedTableInfo: null,
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
        expandedKeys: ["db:myapp"],
        tables: { myapp: [] },
      });

      await useDatabaseStore.getState().selectDatabase("conn-1", "myapp");

      const state = useDatabaseStore.getState();
      expect(state.expandedKeys.filter((k) => k === "db:myapp")).toHaveLength(1);
    });
  });

  describe("loadDatabaseInfo", () => {
    it("应该加载数据库信息", async () => {
      const mockInfo = {
        name: "myapp",
        character_set: "utf8mb4",
        collation: "utf8mb4_general_ci",
      };
      mockApi.getDatabaseInfo.mockResolvedValue(mockInfo);

      await useDatabaseStore.getState().loadDatabaseInfo("conn-1", "myapp");

      const state = useDatabaseStore.getState();
      expect(state.databaseInfo).toEqual(mockInfo);
      expect(state.databaseInfoLoading).toBe(false);
      expect(mockApi.getDatabaseInfo).toHaveBeenCalledWith("conn-1", "myapp");
    });

    it("加载失败时应该清空数据库信息", async () => {
      mockApi.getDatabaseInfo.mockRejectedValue("查询失败");

      await useDatabaseStore.getState().loadDatabaseInfo("conn-1", "myapp");

      const state = useDatabaseStore.getState();
      expect(state.databaseInfo).toBeNull();
      expect(state.databaseInfoLoading).toBe(false);
    });
  });

  describe("createDatabase", () => {
    it("应该调用创建数据库 API 并刷新列表", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      const mockDbs = ["information_schema", "mysql", "my_new_db"];

      mockApi.createDatabase.mockResolvedValue(undefined);
      mockApi.listDatabases.mockResolvedValue(mockDbs);

      await useDatabaseStore
        .getState()
        .createDatabase("conn-1", "my_new_db", "utf8mb4", "utf8mb4_general_ci");

      expect(mockApi.createDatabase).toHaveBeenCalledWith(
        "conn-1",
        "my_new_db",
        "utf8mb4",
        "utf8mb4_general_ci"
      );
      expect(mockApi.listDatabases).toHaveBeenCalledWith("conn-1");

      const state = useDatabaseStore.getState();
      expect(state.databases).toEqual(mockDbs);
    });

    it("创建失败时应该抛出错误", async () => {
      mockApi.createDatabase.mockRejectedValue("权限不足");

      await expect(
        useDatabaseStore
          .getState()
          .createDatabase("conn-1", "my_new_db", "utf8mb4", "utf8mb4_general_ci")
      ).rejects.toThrow("权限不足");
    });
  });

  describe("dropDatabase", () => {
    it("应调用 API 并移除该库缓存与选中状态", async () => {
      const mockDbsBefore = ["myapp", "other"];
      const mockTables = [
        {
          name: "users",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 100,
          data_length: 16384, index_length: null,
          comment: "",
        },
      ];
      mockApi.listDatabases.mockResolvedValue(mockDbsBefore);
      mockApi.listTables.mockResolvedValue(mockTables);

      await useDatabaseStore.getState().loadDatabases("conn-1", "myapp");

      mockApi.dropDatabase.mockResolvedValue(undefined);
      mockApi.listDatabases.mockResolvedValue(["other"]);

      await useDatabaseStore.getState().dropDatabase("conn-1", "myapp");

      expect(mockApi.dropDatabase).toHaveBeenCalledWith("conn-1", "myapp");
      const state = useDatabaseStore.getState();
      expect(state.databases).toEqual(["other"]);
      expect(state.tables.myapp).toBeUndefined();
      expect(state.selectedDatabase).toBeNull();
      expect(state.expandedKeys.includes("db:myapp")).toBe(false);
    });

    it("删除非当前选中库时不应清空当前选中", async () => {
      const mockDbsBefore = ["alpha", "beta"];
      mockApi.listDatabases.mockResolvedValue(mockDbsBefore);
      mockApi.listTables.mockResolvedValue([]);

      await useDatabaseStore.getState().loadDatabases("conn-1", "alpha");

      mockApi.dropDatabase.mockResolvedValue(undefined);
      mockApi.listDatabases.mockResolvedValue(["alpha"]);

      await useDatabaseStore.getState().dropDatabase("conn-1", "beta");

      expect(useDatabaseStore.getState().selectedDatabase).toBe("alpha");
    });
  });

  describe("editDatabase", () => {
    it("应该调用修改字符集 API", async () => {
      mockApi.alterDatabaseCharset.mockResolvedValue(undefined);

      await useDatabaseStore
        .getState()
        .editDatabase("conn-1", "myapp", "utf8mb4", "utf8mb4_unicode_ci");

      expect(mockApi.alterDatabaseCharset).toHaveBeenCalledWith(
        "conn-1",
        "myapp",
        "utf8mb4",
        "utf8mb4_unicode_ci"
      );
    });

    it("修改失败时应该抛出错误", async () => {
      mockApi.alterDatabaseCharset.mockRejectedValue("权限不足");

      await expect(
        useDatabaseStore
          .getState()
          .editDatabase("conn-1", "myapp", "utf8mb4", "utf8mb4_unicode_ci")
      ).rejects.toThrow("权限不足");
    });
  });

  describe("renameDatabase", () => {
    it("应该调用重命名 API 并刷新列表", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["old_db", "other_db"],
            tables: {
              old_db: [
                {
                  name: "t1",
                  table_type: "TABLE",
                  engine: "InnoDB",
                  rows: 10,
                  data_length: 0, index_length: null,
                  comment: "",
                },
              ],
            },
            selectedDatabase: "old_db",
            selectedTable: null,
            expandedKeys: ["db:old_db"],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: null,
            selectedTableInfo: null,
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
        selectedDatabase: "old_db",
        expandedKeys: ["db:old_db"],
        tables: {
          old_db: [
            {
              name: "t1",
              table_type: "TABLE",
              engine: "InnoDB",
              rows: 10,
              data_length: 0, index_length: null,
              comment: "",
            },
          ],
        },
      });

      mockApi.renameDatabase.mockResolvedValue(undefined);
      mockApi.listDatabases.mockResolvedValue(["new_db", "other_db"]);

      await useDatabaseStore
        .getState()
        .renameDatabase("conn-1", "old_db", "new_db", "utf8mb4", "utf8mb4_general_ci");

      expect(mockApi.renameDatabase).toHaveBeenCalledWith(
        "conn-1",
        "old_db",
        "new_db",
        "utf8mb4",
        "utf8mb4_general_ci"
      );

      const state = useDatabaseStore.getState();
      expect(state.databases).toEqual(["new_db", "other_db"]);
      expect(state.tables["new_db"]).toHaveLength(1);
      expect(state.tables["old_db"]).toBeUndefined();
      expect(state.expandedKeys).toContain("db:new_db");
      expect(state.expandedKeys).not.toContain("db:old_db");
      expect(state.selectedDatabase).toBe("new_db");
    });

    it("重命名失败时应该抛出错误", async () => {
      mockApi.renameDatabase.mockRejectedValue("迁移失败");

      await expect(
        useDatabaseStore
          .getState()
          .renameDatabase("conn-1", "old_db", "new_db", "utf8mb4", "utf8mb4_general_ci")
      ).rejects.toThrow("迁移失败");
    });
  });

  describe("renameTable", () => {
    it("应该调用重命名表 API 并更新状态", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {
              myapp: [
                {
                  name: "old_table",
                  table_type: "TABLE",
                  engine: "InnoDB",
                  rows: 100,
                  data_length: 16384, index_length: null,
                  comment: "",
                },
              ],
            },
            selectedDatabase: "myapp",
            selectedTable: "old_table",
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: null,
            selectedTableInfo: null,
            openTables: [],
            openTabs: [{ type: "table", database: "myapp", table: "old_table" }],
            activeTabIndex: 0,
            activeTableTabIndex: 0,
            sqlTabContents: {},
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
        selectedDatabase: "myapp",
        selectedTable: "old_table",
        tables: {
          myapp: [
            {
              name: "old_table",
              table_type: "TABLE",
              engine: "InnoDB",
              rows: 100,
              data_length: 16384, index_length: null,
              comment: "",
            },
          ],
        },
      });

      mockApi.renameTable.mockResolvedValue(undefined);
      mockApi.listTables.mockResolvedValue([
        {
          name: "new_table",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 100,
          data_length: 16384, index_length: null,
          comment: "",
        },
      ]);
      mockApi.getTableStructure.mockResolvedValue([
        {
          name: "id",
          column_type: "int",
          nullable: false,
          key: "PRI",
          default_value: null,
          extra: "auto_increment",
          comment: "",
        },
      ]);

      await useDatabaseStore
        .getState()
        .renameTable("conn-1", "myapp", "old_table", "new_table");

      expect(mockApi.renameTable).toHaveBeenCalledWith(
        "conn-1",
        "myapp",
        "old_table",
        "new_table"
      );

      const state = useDatabaseStore.getState();
      expect(state.selectedTable).toBe("new_table");
      expect(state.tables["myapp"]?.[0]?.name).toBe("new_table");
      expect(state.tableStructure).toHaveLength(1);
    });

    it("重命名表失败时应该抛出错误", async () => {
      mockApi.renameTable.mockRejectedValue("权限不足");

      await expect(
        useDatabaseStore
          .getState()
          .renameTable("conn-1", "myapp", "old_table", "new_table")
      ).rejects.toThrow("权限不足");
    });
  });

  describe("alterTableEngine", () => {
    it("应该调用修改引擎 API 并更新表信息", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {
              myapp: [
                {
                  name: "users",
                  table_type: "TABLE",
                  engine: "InnoDB",
                  rows: 100,
                  data_length: 16384, index_length: null,
                  comment: "",
                },
              ],
            },
            selectedDatabase: "myapp",
            selectedTable: "users",
            selectedTableInfo: {
              name: "users",
              table_type: "TABLE",
              engine: "InnoDB",
              rows: 100,
              data_length: 16384, index_length: null,
              comment: "",
            },
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: null,
            databaseInfo: null,
          },
        },
        selectedDatabase: "myapp",
        selectedTable: "users",
        selectedTableInfo: {
          name: "users",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 100,
          data_length: 16384, index_length: null,
          comment: "",
        },
        tables: {
          myapp: [
            {
              name: "users",
              table_type: "TABLE",
              engine: "InnoDB",
              rows: 100,
              data_length: 16384, index_length: null,
              comment: "",
            },
          ],
        },
      });

      mockApi.alterTableEngine.mockResolvedValue(undefined);
      mockApi.listTables.mockResolvedValue([
        {
          name: "users",
          table_type: "TABLE",
          engine: "MyISAM",
          rows: 100,
          data_length: 16384, index_length: null,
          comment: "",
        },
      ]);

      await useDatabaseStore
        .getState()
        .alterTableEngine("conn-1", "myapp", "users", "MyISAM");

      expect(mockApi.alterTableEngine).toHaveBeenCalledWith(
        "conn-1",
        "myapp",
        "users",
        "MyISAM"
      );

      const state = useDatabaseStore.getState();
      expect(state.selectedTableInfo?.engine).toBe("MyISAM");
      expect(state.tables["myapp"]?.[0]?.engine).toBe("MyISAM");
    });

    it("修改引擎失败时应该抛出错误", async () => {
      mockApi.alterTableEngine.mockRejectedValue("不支持的引擎");

      await expect(
        useDatabaseStore
          .getState()
          .alterTableEngine("conn-1", "myapp", "users", "InvalidEngine")
      ).rejects.toThrow("不支持的引擎");
    });
  });

  describe("alterColumn", () => {
    it("应该调用修改列 API 并刷新表结构", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {},
            selectedDatabase: "myapp",
            selectedTable: "users",
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: [
              {
                name: "username",
                column_type: "varchar(100)",
                nullable: true,
                key: "",
                default_value: null,
                extra: "",
                comment: "",
              },
            ],
            selectedTableInfo: null,
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
        selectedDatabase: "myapp",
        selectedTable: "users",
        tableStructure: [
          {
            name: "username",
            column_type: "varchar(100)",
            nullable: true,
            key: "",
            default_value: null,
            extra: "",
            comment: "",
          },
        ],
      });

      const updatedStructure = [
        {
          name: "user_name",
          column_type: "varchar(128)",
          nullable: false,
          key: "",
          default_value: null,
          extra: "",
          comment: "用户名",
        },
      ];

      mockApi.alterColumn.mockResolvedValue(undefined);
      mockApi.getTableStructure.mockResolvedValue(updatedStructure);

      const request = {
        old_name: "username",
        new_name: "user_name",
        column_type: "varchar(128)",
        nullable: false,
        default_value: null,
        extra: "",
        comment: "用户名",
      };

      await useDatabaseStore
        .getState()
        .alterColumn("conn-1", "myapp", "users", request);

      expect(mockApi.alterColumn).toHaveBeenCalledWith(
        "conn-1",
        "myapp",
        "users",
        request
      );

      const state = useDatabaseStore.getState();
      expect(state.tableStructure).toEqual(updatedStructure);
      expect(state.tableStructure?.[0]?.name).toBe("user_name");
    });

    it("修改列失败时应该抛出错误", async () => {
      mockApi.alterColumn.mockRejectedValue("修改列失败: 语法错误");

      await expect(
        useDatabaseStore.getState().alterColumn("conn-1", "myapp", "users", {
          old_name: "col",
          new_name: "col",
          column_type: "invalid_type",
          nullable: true,
          default_value: null,
          extra: "",
          comment: "",
        })
      ).rejects.toThrow("修改列失败: 语法错误");
    });
  });

  describe("addColumn", () => {
    it("应该调用新增列 API 并刷新表结构", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {},
            selectedDatabase: "myapp",
            selectedTable: "users",
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: [
              {
                name: "id",
                column_type: "int",
                nullable: false,
                key: "PRI",
                default_value: null,
                extra: "auto_increment",
                comment: "",
              },
            ],
            selectedTableInfo: null,
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
        selectedDatabase: "myapp",
        selectedTable: "users",
        tableStructure: [
          {
            name: "id",
            column_type: "int",
            nullable: false,
            key: "PRI",
            default_value: null,
            extra: "auto_increment",
            comment: "",
          },
        ],
      });

      const updatedStructure = [
        {
          name: "id",
          column_type: "int",
          nullable: false,
          key: "PRI",
          default_value: null,
          extra: "auto_increment",
          comment: "",
        },
        {
          name: "email",
          column_type: "varchar(255)",
          nullable: true,
          key: "",
          default_value: null,
          extra: "",
          comment: "邮箱",
        },
      ];

      mockApi.addColumn.mockResolvedValue(undefined);
      mockApi.getTableStructure.mockResolvedValue(updatedStructure);

      const request = {
        name: "email",
        column_type: "varchar(255)",
        nullable: true,
        default_value: null,
        extra: "",
        comment: "邮箱",
        after_column: "id",
      };

      await useDatabaseStore
        .getState()
        .addColumn("conn-1", "myapp", "users", request);

      expect(mockApi.addColumn).toHaveBeenCalledWith(
        "conn-1",
        "myapp",
        "users",
        request
      );

      const state = useDatabaseStore.getState();
      expect(state.tableStructure).toHaveLength(2);
      expect(state.tableStructure?.[1]?.name).toBe("email");
    });

    it("新增列后应更新 tableStructures 缓存以便列结构列表刷新", async () => {
      const oldStructure = [
        {
          name: "id",
          column_type: "int",
          nullable: false,
          key: "PRI",
          default_value: null,
          extra: "auto_increment",
          comment: "",
        },
      ];
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {},
            selectedDatabase: "myapp",
            selectedTable: "users",
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: oldStructure,
            selectedTableInfo: null,
            openTables: [{ database: "myapp", table: "users" }],
            activeTableTabIndex: 0,
            tableStructures: { "myapp|users": oldStructure },
            tableInfos: {},
            databaseInfo: null,
          },
        },
        selectedDatabase: "myapp",
        selectedTable: "users",
        tableStructure: oldStructure,
      });

      const updatedStructure = [
        ...oldStructure,
        {
          name: "email",
          column_type: "varchar(255)",
          nullable: true,
          key: "",
          default_value: null,
          extra: "",
          comment: "邮箱",
        },
      ];
      mockApi.addColumn.mockResolvedValue(undefined);
      mockApi.getTableStructure.mockResolvedValue(updatedStructure);

      await useDatabaseStore
        .getState()
        .addColumn("conn-1", "myapp", "users", {
          name: "email",
          column_type: "varchar(255)",
          nullable: true,
          default_value: null,
          extra: "",
          comment: "邮箱",
          after_column: "id",
        });

      const state = useDatabaseStore.getState();
      const cached = state.connectionStates["conn-1"]?.tableStructures?.["myapp|users"];
      expect(cached).toBeDefined();
      expect(cached).toHaveLength(2);
      expect(cached?.[1]?.name).toBe("email");
      expect(state.tableStructure).toHaveLength(2);
      expect(state.tableStructure?.[1]?.name).toBe("email");
    });

    it("新增列失败时应该抛出错误", async () => {
      mockApi.addColumn.mockRejectedValue("新增列失败: 列名重复");

      await expect(
        useDatabaseStore.getState().addColumn("conn-1", "myapp", "users", {
          name: "id",
          column_type: "int",
          nullable: false,
          default_value: null,
          extra: "",
          comment: "",
          after_column: null,
        })
      ).rejects.toThrow("新增列失败: 列名重复");
    });
  });

  describe("dropColumn", () => {
    it("应该调用删除列 API 并刷新表结构", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {},
            selectedDatabase: "myapp",
            selectedTable: "users",
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: [
              {
                name: "id",
                column_type: "int",
                nullable: false,
                key: "PRI",
                default_value: null,
                extra: "auto_increment",
                comment: "",
              },
              {
                name: "old_field",
                column_type: "varchar(50)",
                nullable: true,
                key: "",
                default_value: null,
                extra: "",
                comment: "",
              },
            ],
            selectedTableInfo: null,
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
        selectedDatabase: "myapp",
        selectedTable: "users",
        tableStructure: [
          {
            name: "id",
            column_type: "int",
            nullable: false,
            key: "PRI",
            default_value: null,
            extra: "auto_increment",
            comment: "",
          },
          {
            name: "old_field",
            column_type: "varchar(50)",
            nullable: true,
            key: "",
            default_value: null,
            extra: "",
            comment: "",
          },
        ],
      });

      const updatedStructure = [
        {
          name: "id",
          column_type: "int",
          nullable: false,
          key: "PRI",
          default_value: null,
          extra: "auto_increment",
          comment: "",
        },
      ];

      mockApi.dropColumn.mockResolvedValue(undefined);
      mockApi.getTableStructure.mockResolvedValue(updatedStructure);

      await useDatabaseStore
        .getState()
        .dropColumn("conn-1", "myapp", "users", "old_field");

      expect(mockApi.dropColumn).toHaveBeenCalledWith(
        "conn-1",
        "myapp",
        "users",
        "old_field"
      );

      const state = useDatabaseStore.getState();
      expect(state.tableStructure).toHaveLength(1);
      expect(state.tableStructure?.[0]?.name).toBe("id");
    });

    it("删除列失败时应该抛出错误", async () => {
      mockApi.dropColumn.mockRejectedValue("删除列失败: 列不存在");

      await expect(
        useDatabaseStore
          .getState()
          .dropColumn("conn-1", "myapp", "users", "nonexistent")
      ).rejects.toThrow("删除列失败: 列不存在");
    });
  });

  describe("dropTable", () => {
    it("删除表成功后应该刷新表列表", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {
              myapp: [
                {
                  name: "users",
                  table_type: "TABLE",
                  engine: "InnoDB",
                  rows: 100,
                  data_length: 16384, index_length: null,
                  comment: "用户表",
                },
                {
                  name: "logs",
                  table_type: "TABLE",
                  engine: "InnoDB",
                  rows: 500,
                  data_length: 32768, index_length: null,
                  comment: "日志表",
                },
              ],
            },
            selectedDatabase: "myapp",
            selectedTable: null,
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: null,
            selectedTableInfo: null,
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
        selectedDatabase: "myapp",
        tables: {
          myapp: [
            {
              name: "users",
              table_type: "TABLE",
              engine: "InnoDB",
              rows: 100,
              data_length: 16384, index_length: null,
              comment: "用户表",
            },
            {
              name: "logs",
              table_type: "TABLE",
              engine: "InnoDB",
              rows: 500,
              data_length: 32768, index_length: null,
              comment: "日志表",
            },
          ],
        },
      });

      mockApi.dropTable.mockResolvedValue(undefined);
      mockApi.listTables.mockResolvedValue([
        {
          name: "users",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 100,
          data_length: 16384, index_length: null,
          comment: "用户表",
        },
      ]);

      await useDatabaseStore
        .getState()
        .dropTable("conn-1", "myapp", "logs");

      expect(mockApi.dropTable).toHaveBeenCalledWith("conn-1", "myapp", "logs");
      expect(mockApi.listTables).toHaveBeenCalledWith("conn-1", "myapp");

      const state = useDatabaseStore.getState();
      expect(state.tables.myapp).toHaveLength(1);
      expect(state.tables.myapp[0].name).toBe("users");
    });

    it("删除当前选中的表后应该清除选中状态", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {
              myapp: [
                {
                  name: "logs",
                  table_type: "TABLE",
                  engine: "InnoDB",
                  rows: 500,
                  data_length: 32768, index_length: null,
                  comment: "日志表",
                },
              ],
            },
            selectedDatabase: "myapp",
            selectedTable: "logs",
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: [
              {
                name: "id",
                column_type: "int",
                nullable: false,
                key: "PRI",
                default_value: null,
                extra: "auto_increment",
                comment: "",
              },
            ],
            selectedTableInfo: {
              name: "logs",
              table_type: "TABLE",
              engine: "InnoDB",
              rows: 500,
              data_length: 32768, index_length: null,
              comment: "日志表",
            },
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
        selectedDatabase: "myapp",
        selectedTable: "logs",
        tableStructure: [
          {
            name: "id",
            column_type: "int",
            nullable: false,
            key: "PRI",
            default_value: null,
            extra: "auto_increment",
            comment: "",
          },
        ],
        selectedTableInfo: {
          name: "logs",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 500,
          data_length: 32768, index_length: null,
          comment: "日志表",
        },
        tables: {
          myapp: [
            {
              name: "logs",
              table_type: "TABLE",
              engine: "InnoDB",
              rows: 500,
              data_length: 32768, index_length: null,
              comment: "日志表",
            },
          ],
        },
      });

      mockApi.dropTable.mockResolvedValue(undefined);
      mockApi.listTables.mockResolvedValue([]);

      await useDatabaseStore
        .getState()
        .dropTable("conn-1", "myapp", "logs");

      const state = useDatabaseStore.getState();
      expect(state.selectedTable).toBeNull();
      expect(state.tableStructure).toBeNull();
      expect(state.selectedTableInfo).toBeNull();
      expect(state.tables.myapp).toHaveLength(0);
    });

    it("删除非当前选中的表不应该影响选中状态", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": { ...emptyConnState(),
            databases: ["myapp"],
            tables: {
              myapp: [
                {
                  name: "users",
                  table_type: "TABLE",
                  engine: "InnoDB",
                  rows: 100,
                  data_length: 16384, index_length: null,
                  comment: "",
                },
                {
                  name: "logs",
                  table_type: "TABLE",
                  engine: "InnoDB",
                  rows: 500,
                  data_length: 32768, index_length: null,
                  comment: "",
                },
              ],
            },
            selectedDatabase: "myapp",
            selectedTable: "users",
            expandedKeys: [],
            databaseSortOrder: "asc",
            tableSortOrder: "asc",
            tableStructure: null,
            selectedTableInfo: null,
            openTables: [],
            activeTableTabIndex: 0,
            tableStructures: {},
            tableInfos: {},
            databaseInfo: null,
          },
        },
        selectedDatabase: "myapp",
        selectedTable: "users",
        tables: {
          myapp: [
            {
              name: "users",
              table_type: "TABLE",
              engine: "InnoDB",
              rows: 100,
              data_length: 16384, index_length: null,
              comment: "",
            },
            {
              name: "logs",
              table_type: "TABLE",
              engine: "InnoDB",
              rows: 500,
              data_length: 32768, index_length: null,
              comment: "",
            },
          ],
        },
      });

      mockApi.dropTable.mockResolvedValue(undefined);
      mockApi.listTables.mockResolvedValue([
        {
          name: "users",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 100,
          data_length: 16384, index_length: null,
          comment: "",
        },
      ]);

      await useDatabaseStore
        .getState()
        .dropTable("conn-1", "myapp", "logs");

      const state = useDatabaseStore.getState();
      expect(state.selectedTable).toBe("users");
      expect(state.tables.myapp).toHaveLength(1);
    });

    it("删除表失败时应该抛出错误", async () => {
      mockApi.dropTable.mockRejectedValue("删除表失败: 权限不足");

      await expect(
        useDatabaseStore
          .getState()
          .dropTable("conn-1", "myapp", "users")
      ).rejects.toThrow("删除表失败: 权限不足");
    });
  });

  describe("truncateTable", () => {
    it("清空表后应刷新表列表并更新选中表信息行数", async () => {
      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": {
            ...emptyConnState(),
            databases: ["myapp"],
            tables: {
              myapp: [
                {
                  name: "logs",
                  table_type: "TABLE",
                  engine: "InnoDB",
                  rows: 500,
                  data_length: 32768, index_length: null,
                  comment: "",
                },
              ],
            },
            selectedDatabase: "myapp",
            selectedTable: "logs",
            openTabs: [],
            tableInfos: {},
            tableStructures: {},
          },
        },
        selectedDatabase: "myapp",
        selectedTable: "logs",
        tables: {
          myapp: [
            {
              name: "logs",
              table_type: "TABLE",
              engine: "InnoDB",
              rows: 500,
              data_length: 32768, index_length: null,
              comment: "",
            },
          ],
        },
        selectedTableInfo: {
          name: "logs",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 500,
          data_length: 32768, index_length: null,
          comment: "",
        },
      });

      mockApi.truncateTable.mockResolvedValue(undefined);
      mockApi.listTables.mockResolvedValue([
        {
          name: "logs",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 0,
          data_length: 16384, index_length: null,
          comment: "",
        },
      ]);

      await useDatabaseStore
        .getState()
        .truncateTable("conn-1", "myapp", "logs");

      expect(mockApi.truncateTable).toHaveBeenCalledWith(
        "conn-1",
        "myapp",
        "logs"
      );
      expect(mockApi.listTables).toHaveBeenCalledWith("conn-1", "myapp");

      const state = useDatabaseStore.getState();
      expect(state.tables.myapp[0].rows).toBe(0);
      expect(state.selectedTableInfo?.rows).toBe(0);
    });

    it("清空表失败时应该抛出错误", async () => {
      mockApi.truncateTable.mockRejectedValue("清空表失败: 权限不足");

      await expect(
        useDatabaseStore
          .getState()
          .truncateTable("conn-1", "myapp", "logs")
      ).rejects.toThrow("清空表失败: 权限不足");
    });

    it("清空表后若数据页正打开该表应触发重新查询", async () => {
      mockApi.queryTableData.mockResolvedValue({
        columns: ["id"],
        rows: [],
        total: 0,
        execution_time_ms: 1,
      });
      mockApi.queryTableCount.mockResolvedValue(0);
      useTableDataStore.setState({
        activeTableKey: "conn-1|myapp|logs",
        page: 1,
        pageSize: 50,
        sortFields: [],
        whereClause: "",
        lastSelectColumns: undefined,
      });

      useDatabaseStore.getState().switchToConnection("conn-1");
      useDatabaseStore.setState({
        connectionStates: {
          "conn-1": {
            ...emptyConnState(),
            databases: ["myapp"],
            tables: {
              myapp: [
                {
                  name: "logs",
                  table_type: "TABLE",
                  engine: "InnoDB",
                  rows: 10,
                  data_length: 16384, index_length: null,
                  comment: "",
                },
              ],
            },
            selectedDatabase: "myapp",
            selectedTable: "logs",
          },
        },
        tables: {
          myapp: [
            {
              name: "logs",
              table_type: "TABLE",
              engine: "InnoDB",
              rows: 10,
              data_length: 16384, index_length: null,
              comment: "",
            },
          ],
        },
      });

      mockApi.truncateTable.mockResolvedValue(undefined);
      mockApi.listTables.mockResolvedValue([
        {
          name: "logs",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 0,
          data_length: 8192, index_length: null,
          comment: "",
        },
      ]);

      await useDatabaseStore
        .getState()
        .truncateTable("conn-1", "myapp", "logs");

      await vi.waitFor(() => {
        expect(mockApi.queryTableData).toHaveBeenCalled();
      });
    });
  });
});
