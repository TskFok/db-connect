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

function col(name: string): ColumnInfo {
  return {
    name,
    column_type: name === "id" ? "INTEGER" : "TEXT",
    nullable: name !== "id",
    key: name === "id" ? "PRI" : "",
    default_value: null,
    extra: "",
    comment: "",
  };
}

function setupSqliteConnection(): void {
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

  const connection = {
    connId: "conn-sqlite",
    config: {
      id: "conn-sqlite",
      name: "SQLite 测试",
      host: "localhost",
      port: 0,
      username: "",
      database_type: "sqlite" as const,
      sqlite_path: "/tmp/test.sqlite",
    },
  };

  useConnectionStore.setState({
    activeConnections: { "conn-sqlite": connection },
    activeConnId: "conn-sqlite",
    activeConnection: connection,
  });
}

describe("TableStructure — SQLite", () => {
  beforeEach(() => {
    useDatabaseStore.getState().reset();
    setupSqliteConnection();
    useDatabaseStore.setState({
      activeConnId: "conn-sqlite",
      selectedDatabase: "main",
      selectedTable: "users",
      tableStructure: [col("id"), col("name")],
      selectedTableInfo: {
        name: "users",
        table_type: "TABLE",
        engine: "SQLite",
        rows: 2,
        data_length: 0,
        index_length: 0,
        comment: "",
      },
    });
  });

  it("隐藏存储引擎、列顺序拖拽和改列定义入口，但保留新增/删除列", () => {
    render(<TableStructure />);

    expect(screen.queryByText("引擎")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("拖拽调整顺序")).not.toBeInTheDocument();
    expect(screen.queryAllByLabelText("编辑列")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /新增列/ })).toBeEnabled();
    expect(screen.getAllByLabelText("删除列")).toHaveLength(2);
  });
});
