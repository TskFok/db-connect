import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TableStructure } from "../components/table/TableStructure";
import { useDatabaseStore } from "../stores/databaseStore";
import { useConnectionStore } from "../stores/connectionStore";
import * as api from "../services/tauriCommands";

vi.mock("@dnd-kit/core", async (importOriginal) => {
  return importOriginal<typeof import("@dnd-kit/core")>();
});

vi.mock("../services/tauriCommands", () => ({
  listDatabases: vi.fn(),
  listTables: vi.fn(),
  getTableStructure: vi.fn().mockResolvedValue([]),
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

describe("TableStructure 表元数据", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
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

    vi.mocked(api.getTableStructure).mockResolvedValue([]);

    useDatabaseStore.getState().reset();
    useConnectionStore.setState({
      activeConnections: { "conn-1": mockActiveConnection },
      activeConnId: "conn-1",
      activeConnection: mockActiveConnection,
    });
    useDatabaseStore.setState({
      activeConnId: "conn-1",
      selectedDatabase: "mydb",
      selectedTable: "users",
      tableStructure: [],
      selectedTableInfo: {
        name: "users",
        table_type: "TABLE",
        engine: "InnoDB",
        rows: 1000,
        data_length: 65536,
        index_length: 16384,
        comment: "用户表",
      },
    });
  });

  it("展示数据大小与索引容量", () => {
    render(<TableStructure />);

    expect(screen.getByText("数据大小")).toBeInTheDocument();
    expect(screen.getByText("索引容量")).toBeInTheDocument();
    expect(screen.getByText("64.0 KB")).toBeInTheDocument();
    expect(screen.getByText("16.0 KB")).toBeInTheDocument();
  });

  it("SQL Server 结构元数据不展示存储引擎，也不渲染列拖拽手柄", () => {
    useConnectionStore.setState({
      activeConnections: {
        "conn-1": {
          ...mockActiveConnection,
          config: {
            ...mockActiveConnection.config,
            database_type: "sqlserver",
          },
        },
      },
      activeConnId: "conn-1",
      activeConnection: {
        ...mockActiveConnection,
        config: {
          ...mockActiveConnection.config,
          database_type: "sqlserver",
        },
      },
    });
    useDatabaseStore.setState({
      tableStructure: [
        {
          name: "id",
          column_type: "bigint",
          nullable: false,
          key: "PRI",
          default_value: null,
          extra: "identity",
          comment: "",
        },
      ],
      selectedTableInfo: {
        name: "users",
        table_type: "TABLE",
        engine: "SQL Server",
        rows: 1000,
        data_length: 65536,
        index_length: 16384,
        comment: "用户表",
      },
    });

    render(<TableStructure />);

    expect(screen.queryByText("引擎")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("拖拽调整顺序")).not.toBeInTheDocument();
  });

  it("SQL Server 编辑列弹窗不展示无效的主键开关", () => {
    useConnectionStore.setState({
      activeConnections: {
        "conn-1": {
          ...mockActiveConnection,
          config: {
            ...mockActiveConnection.config,
            database_type: "sqlserver",
          },
        },
      },
      activeConnId: "conn-1",
      activeConnection: {
        ...mockActiveConnection,
        config: {
          ...mockActiveConnection.config,
          database_type: "sqlserver",
        },
      },
    });
    useDatabaseStore.setState({
      tableStructure: [
        {
          name: "id",
          column_type: "bigint",
          nullable: false,
          key: "PRI",
          default_value: null,
          extra: "identity",
          comment: "",
        },
      ],
      selectedTableInfo: {
        name: "users",
        table_type: "TABLE",
        engine: "SQL Server",
        rows: 1000,
        data_length: 65536,
        index_length: 16384,
        comment: "用户表",
      },
    });

    render(<TableStructure />);
    fireEvent.click(screen.getByLabelText("编辑列"));

    expect(screen.getByText(/编辑列/)).toBeInTheDocument();
    expect(screen.queryByText("主键")).not.toBeInTheDocument();
  });

  it("ClickHouse 结构元数据显示排序键信息且禁用 DDL 操作入口", () => {
    useConnectionStore.setState({
      activeConnections: {
        "conn-1": {
          ...mockActiveConnection,
          config: {
            ...mockActiveConnection.config,
            port: 8123,
            database_type: "clickhouse",
          },
        },
      },
      activeConnId: "conn-1",
      activeConnection: {
        ...mockActiveConnection,
        config: {
          ...mockActiveConnection.config,
          port: 8123,
          database_type: "clickhouse",
        },
      },
    });
    useDatabaseStore.setState({
      selectedDatabase: "analytics",
      selectedTable: "events",
      tableStructure: [
        {
          name: "id",
          column_type: "UInt64",
          nullable: false,
          key: "PRI",
          default_value: null,
          extra: "",
          comment: "",
        },
        {
          name: "created_at",
          column_type: "DateTime",
          nullable: false,
          key: "",
          default_value: "DEFAULT now()",
          extra: "sorting key",
          comment: "创建时间",
        },
      ],
      selectedTableInfo: {
        name: "events",
        table_type: "TABLE",
        engine: "MergeTree",
        rows: null,
        data_length: 4096,
        index_length: null,
        comment: "事件表",
      },
    });

    render(<TableStructure />);

    expect(screen.queryByText("引擎")).not.toBeInTheDocument();
    expect(screen.getByText("sorting key")).toBeInTheDocument();
    expect(screen.queryByLabelText("拖拽调整顺序")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /新增列/ })).toBeDisabled();
    screen.getAllByLabelText("编辑列").forEach((button) => {
      expect(button).toBeDisabled();
    });
    screen.getAllByLabelText("删除列").forEach((button) => {
      expect(button).toBeDisabled();
    });
  });
});
