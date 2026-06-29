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
