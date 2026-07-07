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
