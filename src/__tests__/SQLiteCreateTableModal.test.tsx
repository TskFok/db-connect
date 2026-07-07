import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CreateTableModal } from "../components/database/CreateTableModal";
import { useConnectionStore } from "../stores/connectionStore";

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

function setupClickHouseConnection(): void {
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
    connId: "conn-clickhouse",
    config: {
      id: "conn-clickhouse",
      name: "ClickHouse 测试",
      host: "localhost",
      port: 8123,
      username: "default",
      database_type: "clickhouse" as const,
    },
  };

  useConnectionStore.setState({
    activeConnections: { "conn-clickhouse": connection },
    activeConnId: "conn-clickhouse",
    activeConnection: connection,
  });
}

describe("CreateTableModal — SQLite", () => {
  beforeEach(() => {
    setupSqliteConnection();
  });

  it("隐藏 MySQL 专属字段，提交时不发送 engine/comment/extra", async () => {
    const onCreateTable = vi.fn().mockResolvedValue(undefined);

    render(
      <CreateTableModal
        open
        onCancel={() => {}}
        onSuccess={() => {}}
        connId="conn-sqlite"
        database="main"
        onCreateTable={onCreateTable}
      />
    );

    expect(screen.queryByText("存储引擎")).not.toBeInTheDocument();
    expect(screen.queryByText("表注释")).not.toBeInTheDocument();
    expect(screen.queryByText("UNSIGNED")).not.toBeInTheDocument();
    expect(screen.queryByText("额外")).not.toBeInTheDocument();
    expect(screen.queryByText("注释")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("例如: users"), {
      target: { value: "users" },
    });
    fireEvent.click(screen.getByRole("button", { name: /创\s*建/ }));

    await waitFor(() => {
      expect(onCreateTable).toHaveBeenCalledWith(
        "conn-sqlite",
        "main",
        expect.objectContaining({
          table_name: "users",
          primary_keys: ["id"],
          engine: "",
          comment: "",
          columns: [
            expect.objectContaining({
              name: "id",
              column_type: "INTEGER",
              extra: "",
              comment: "",
            }),
          ],
        })
      );
    });
  });
});

describe("CreateTableModal — ClickHouse", () => {
  beforeEach(() => {
    setupClickHouseConnection();
  });

  it("显示 ClickHouse 专属类型、引擎和 ORDER BY，并提交最小 MergeTree 请求", async () => {
    const onCreateTable = vi.fn().mockResolvedValue(undefined);

    render(
      <CreateTableModal
        open
        onCancel={() => {}}
        onSuccess={() => {}}
        connId="conn-clickhouse"
        database="analytics"
        onCreateTable={onCreateTable}
      />
    );

    expect(screen.getByText("ClickHouse 引擎")).toBeInTheDocument();
    expect(screen.getByText("ORDER BY")).toBeInTheDocument();
    expect(screen.getByText("UInt64")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("例如: users"), {
      target: { value: "events" },
    });
    fireEvent.click(screen.getByRole("button", { name: /创\s*建/ }));

    await waitFor(() => {
      expect(onCreateTable).toHaveBeenCalledWith(
        "conn-clickhouse",
        "analytics",
        expect.objectContaining({
          table_name: "events",
          engine: "MergeTree",
          order_by: [],
          comment: "",
          primary_keys: [],
          columns: [
            expect.objectContaining({
              name: "id",
              column_type: "UInt64",
              nullable: false,
              extra: "",
              comment: "",
            }),
          ],
        })
      );
    });
  });
});
