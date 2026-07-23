import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseTree } from "../components/database/DatabaseTree";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore, emptyConnState } from "../stores/databaseStore";
import { useFavoriteStore } from "../stores/favoriteStore";
import * as api from "../services/tauriCommands";

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
  listSavedConnections: vi.fn(),
  saveConnection: vi.fn(),
  deleteSavedConnection: vi.fn(),
  testConnection: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  forceDisconnect: vi.fn(),
  pingConnection: vi.fn(),
  getSessionInfo: vi.fn(),
  getSessionInfoCached: vi.fn(),
  invalidateSessionInfoCache: vi.fn(),
}));

const mockApi = vi.mocked(api);

const postgresConnection = {
  connId: "pg-1",
  config: {
    id: "pg-profile",
    name: "Postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    database_type: "postgres" as const,
  },
};

const sqlserverConnection = {
  connId: "mssql-1",
  config: {
    id: "mssql-profile",
    name: "SQL Server",
    host: "localhost",
    port: 1433,
    username: "sa",
    database_type: "sqlserver" as const,
  },
};

const clickhouseConnection = {
  connId: "ch-1",
  config: {
    id: "ch-profile",
    name: "ClickHouse",
    host: "localhost",
    port: 8123,
    username: "default",
    database_type: "clickhouse" as const,
  },
};

const mysqlConnection = {
  connId: "mysql-1",
  config: {
    id: "mysql-profile",
    name: "MySQL",
    host: "localhost",
    port: 3306,
    username: "root",
    database_type: "mysql" as const,
  },
};

describe("DatabaseTree capabilities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFavoriteStore.setState({ favorites: [] });
    useDatabaseStore.getState().reset();
    useDatabaseStore.setState({
      activeConnId: "pg-1",
      connectionStates: {
        "pg-1": {
          ...emptyConnState(),
          databases: [],
          tables: {},
        },
      },
    });
    useConnectionStore.setState({
      savedConnections: [],
      connectionGroups: [],
      activeConnections: { "pg-1": postgresConnection },
      activeConnId: "pg-1",
      activeConnection: postgresConnection,
      loading: false,
      error: null,
      showConnectionForm: false,
      editingConnection: null,
    });
    mockApi.listDatabases.mockResolvedValue(["app"]);
  });

  it("标题区域保留连接名称但不显示数据库地址", () => {
    render(<DatabaseTree />);

    expect(screen.getByText("Postgres")).toBeInTheDocument();
    expect(screen.queryByText("localhost:5432")).not.toBeInTheDocument();
  });

  it("PostgreSQL MVP 阶段会自动加载 schema 树", async () => {
    render(<DatabaseTree />);

    await waitFor(() => {
      expect(mockApi.listDatabases).toHaveBeenCalledWith("pg-1");
    });
    expect(
      screen.queryByText("当前数据库类型暂不支持对象浏览")
    ).not.toBeInTheDocument();
  });

  it("SQL Server Phase 2 会自动加载 schema 树", async () => {
    useDatabaseStore.setState({
      activeConnId: "mssql-1",
      connectionStates: {
        "mssql-1": {
          ...emptyConnState(),
          databases: [],
          tables: {},
        },
      },
    });
    useConnectionStore.setState({
      activeConnections: { "mssql-1": sqlserverConnection },
      activeConnId: "mssql-1",
      activeConnection: sqlserverConnection,
    });
    mockApi.listDatabases.mockResolvedValue(["dbo"]);

    render(<DatabaseTree />);

    await waitFor(() => {
      expect(mockApi.listDatabases).toHaveBeenCalledWith("mssql-1");
    });
    expect(
      screen.queryByText("当前数据库类型暂不支持对象浏览")
    ).not.toBeInTheDocument();
  });

  it("ClickHouse 元数据阶段会自动加载 database 树", async () => {
    useDatabaseStore.setState({
      activeConnId: "ch-1",
      connectionStates: {
        "ch-1": {
          ...emptyConnState(),
          databases: [],
          tables: {},
        },
      },
    });
    useConnectionStore.setState({
      activeConnections: { "ch-1": clickhouseConnection },
      activeConnId: "ch-1",
      activeConnection: clickhouseConnection,
    });
    mockApi.listDatabases.mockResolvedValue(["analytics", "system"]);

    render(<DatabaseTree />);

    await waitFor(() => {
      expect(mockApi.listDatabases).toHaveBeenCalledWith("ch-1");
    });
    expect(
      screen.queryByText("当前数据库类型暂不支持对象浏览")
    ).not.toBeInTheDocument();
  });

  it("PostgreSQL MVP 阶段显示 schema/table 但隐藏收藏入口", () => {
    useFavoriteStore.setState({
      favorites: [
        { connectionId: "pg-profile", database: "app", table: "users" },
      ],
    });
    useDatabaseStore.setState({
      activeConnId: "pg-1",
      connectionStates: {
        "pg-1": {
          ...emptyConnState(),
          databases: ["app"],
          tables: {
            app: [
              {
                name: "users",
                table_type: "TABLE",
                engine: "PostgreSQL",
                rows: 1,
                data_length: null,
                index_length: null,
                comment: "",
              },
            ],
          },
          expandedKeys: ["db:app"],
        },
      },
      databases: ["app"],
      tables: {
        app: [
          {
            name: "users",
            table_type: "TABLE",
            engine: "PostgreSQL",
            rows: 1,
            data_length: null,
            index_length: null,
            comment: "",
          },
        ],
      },
      expandedKeys: ["db:app"],
    });

    render(<DatabaseTree />);

    expect(screen.getByText("app")).toBeInTheDocument();
    expect(screen.getByText("users")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /收藏/ })
    ).not.toBeInTheDocument();
  });

  it("表节点只显示单行表名，不显示行数或收藏入口", () => {
    const tableName = "very_long_table_name_that_must_stay_on_one_line";
    useConnectionStore.setState({
      activeConnections: { "mysql-1": mysqlConnection },
      activeConnId: "mysql-1",
      activeConnection: mysqlConnection,
    });
    useDatabaseStore.setState({
      activeConnId: "mysql-1",
      databases: ["app"],
      tables: {
        app: [
          {
            name: tableName,
            table_type: "TABLE",
            engine: "InnoDB",
            rows: 1234,
            data_length: null,
            index_length: null,
            comment: "",
          },
        ],
      },
      expandedKeys: ["db:app"],
    });

    render(<DatabaseTree />);

    const title = screen.getByText(tableName);
    expect(title).toHaveStyle({
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    });
    expect(screen.queryByText("1,234 行")).not.toBeInTheDocument();
    expect(screen.queryByTitle("收藏")).not.toBeInTheDocument();
    expect(
      title.closest(".ant-tree-treenode")?.querySelector(".ant-tree-iconEle")
    ).toBeInTheDocument();
  });

  it("ClickHouse 显示 database/table 元数据，允许行数为空", () => {
    useDatabaseStore.setState({
      activeConnId: "ch-1",
      connectionStates: {
        "ch-1": {
          ...emptyConnState(),
          databases: ["analytics"],
          tables: {
            analytics: [
              {
                name: "events",
                table_type: "TABLE",
                engine: "MergeTree",
                rows: null,
                data_length: 4096,
                index_length: null,
                comment: "事件表",
              },
            ],
          },
          expandedKeys: ["db:analytics"],
        },
      },
      databases: ["analytics"],
      tables: {
        analytics: [
          {
            name: "events",
            table_type: "TABLE",
            engine: "MergeTree",
            rows: null,
            data_length: 4096,
            index_length: null,
            comment: "事件表",
          },
        ],
      },
      expandedKeys: ["db:analytics"],
    });
    useConnectionStore.setState({
      activeConnections: { "ch-1": clickhouseConnection },
      activeConnId: "ch-1",
      activeConnection: clickhouseConnection,
    });

    render(<DatabaseTree />);

    expect(screen.getByText("analytics")).toBeInTheDocument();
    expect(screen.getByText("events")).toBeInTheDocument();
    expect(
      screen.queryByText("当前数据库类型暂不支持对象浏览")
    ).not.toBeInTheDocument();
  });
});
