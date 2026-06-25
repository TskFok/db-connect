import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ColumnInfo } from "../types";
import { TableStructure } from "../components/table/TableStructure";
import { useDatabaseStore } from "../stores/databaseStore";
import { useConnectionStore } from "../stores/connectionStore";

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

function col(name: string, extra = ""): ColumnInfo {
  return {
    name,
    column_type: "integer",
    nullable: false,
    key: name === "id" ? "PRI" : "",
    default_value: null,
    extra,
    comment: "",
  };
}

function mockMatchMedia(): void {
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
}

function setupConnection(databaseType: "mysql" | "postgres"): void {
  mockMatchMedia();
  const connId = `conn-${databaseType}`;
  const connection = {
    connId,
    config: {
      id: connId,
      name: `${databaseType} 测试`,
      host: "localhost",
      port: databaseType === "postgres" ? 5432 : 3306,
      username: "u",
      database_type: databaseType,
    },
  };
  useConnectionStore.setState({
    activeConnections: { [connId]: connection },
    activeConnId: connId,
    activeConnection: connection,
  });
}

describe("TableStructure — PostgreSQL", () => {
  beforeEach(() => {
    useDatabaseStore.getState().reset();
  });

  it("PostgreSQL 下隐藏 engine 字段，identity/generated 在 extra 列只读展示", () => {
    setupConnection("postgres");
    useDatabaseStore.setState({
      activeConnId: "conn-postgres",
      selectedDatabase: "public",
      selectedTable: "users",
      tableStructure: [col("id", "identity"), col("name", "")],
      selectedTableInfo: {
        name: "users",
        table_type: "TABLE",
        engine: "PostgreSQL",
        rows: 10,
        data_length: 8192,
        index_length: 4096,
        comment: "",
      },
    });

    render(<TableStructure />);

    // 不应出现"引擎"行
    expect(screen.queryByText("引擎")).not.toBeInTheDocument();
    // identity 通过 extra 列展示
    expect(screen.getByText("identity")).toBeInTheDocument();
  });

  it("MySQL 下仍展示引擎字段", () => {
    setupConnection("mysql");
    useDatabaseStore.setState({
      activeConnId: "conn-mysql",
      selectedDatabase: "myapp",
      selectedTable: "users",
      tableStructure: [col("id")],
      selectedTableInfo: {
        name: "users",
        table_type: "TABLE",
        engine: "InnoDB",
        rows: 0,
        data_length: 0,
        index_length: 0,
        comment: "",
      },
    });

    render(<TableStructure />);

    expect(screen.getByText("引擎")).toBeInTheDocument();
    expect(screen.getByText("InnoDB")).toBeInTheDocument();
  });

  it("PostgreSQL 下不渲染拖拽手柄列（columnReordering = false）", () => {
    setupConnection("postgres");
    useDatabaseStore.setState({
      activeConnId: "conn-postgres",
      selectedDatabase: "public",
      selectedTable: "users",
      tableStructure: [col("id"), col("name")],
      selectedTableInfo: {
        name: "users",
        table_type: "TABLE",
        engine: "PostgreSQL",
        rows: 0,
        data_length: 0,
        index_length: 0,
        comment: "",
      },
    });

    render(<TableStructure />);

    // 拖拽列在 MySQL 下用 aria-label="拖拽调整顺序"；PG 下不渲染
    expect(screen.queryByLabelText("拖拽调整顺序")).not.toBeInTheDocument();
  });
});
