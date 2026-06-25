import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { DatabaseCreateModal } from "../components/database/DatabaseCreateModal";
import { useDatabaseStore } from "../stores/databaseStore";
import { useConnectionStore } from "../stores/connectionStore";

vi.mock("../services/tauriCommands", () => ({
  listDatabases: vi.fn(),
  listTables: vi.fn(),
  getTableStructure: vi.fn(),
  getDatabaseInfo: vi.fn(),
  alterDatabaseCharset: vi.fn(),
  createDatabase: vi.fn().mockResolvedValue(undefined),
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

function setupPostgresConnection(): void {
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
    connId: "conn-pg",
    config: {
      id: "conn-pg",
      name: "PG 测试",
      host: "localhost",
      port: 5432,
      username: "postgres",
      database_type: "postgres" as const,
    },
  };
  useConnectionStore.setState({
    activeConnections: { "conn-pg": connection },
    activeConnId: "conn-pg",
    activeConnection: connection,
  });
}

function setupMysqlConnection(): void {
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
    connId: "conn-mysql",
    config: {
      id: "conn-mysql",
      name: "MySQL 测试",
      host: "localhost",
      port: 3306,
      username: "root",
      database_type: "mysql" as const,
    },
  };
  useConnectionStore.setState({
    activeConnections: { "conn-mysql": connection },
    activeConnId: "conn-mysql",
    activeConnection: connection,
  });
}

describe("DatabaseCreateModal — PostgreSQL", () => {
  beforeEach(() => {
    useDatabaseStore.getState().reset();
  });

  it("PostgreSQL 模式下使用 schema 文案且不显示字符集/排序规则字段", async () => {
    setupPostgresConnection();
    render(
      <DatabaseCreateModal
        open
        connId="conn-pg"
        onClose={() => {}}
        onSuccess={() => {}}
      />
    );

    expect(await screen.findByText("新建schema")).toBeInTheDocument();
    expect(screen.getByText("schema名称")).toBeInTheDocument();
    expect(screen.queryByText("字符集")).not.toBeInTheDocument();
    expect(screen.queryByText("排序规则")).not.toBeInTheDocument();
  });

  it("PostgreSQL 模式提交时 charset/collation 传空串，后端按 schema 创建", async () => {
    setupPostgresConnection();
    const createDatabaseSpy = vi.spyOn(useDatabaseStore.getState(), "createDatabase");

    const { container } = render(
      <DatabaseCreateModal
        open
        connId="conn-pg"
        onClose={() => {}}
        onSuccess={() => {}}
      />
    );

    const input = await screen.findByPlaceholderText("例如: app");
    fireEvent.change(input, { target: { value: "my_schema" } });
    // Modal Portal 中 form 也会被渲染到 body；直接触发表单 submit 事件以走完成校验流程
    const form = container.ownerDocument.querySelector("form");
    if (!form) throw new Error("form not found in document");
    await act(async () => {
      fireEvent.submit(form);
    });

    await waitFor(() => {
      expect(createDatabaseSpy).toHaveBeenCalledWith(
        "conn-pg",
        "my_schema",
        "",
        ""
      );
    });
  });

  it("MySQL 模式保留字符集与排序规则字段", async () => {
    setupMysqlConnection();
    await act(async () => {
      render(
        <DatabaseCreateModal
          open
          connId="conn-mysql"
          onClose={() => {}}
          onSuccess={() => {}}
        />
      );
    });

    expect(await screen.findByText("新建数据库")).toBeInTheDocument();
    expect(screen.getByText("字符集")).toBeInTheDocument();
    expect(screen.getByText("排序规则")).toBeInTheDocument();
  });
});
