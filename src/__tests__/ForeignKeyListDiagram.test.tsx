import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ForeignKeyList } from "../components/foreignKey/ForeignKeyList";
import { useDatabaseStore } from "../stores/databaseStore";
import { useConnectionStore } from "../stores/connectionStore";
import * as api from "../services/tauriCommands";
import { isConnectionGloballyReadOnly } from "../utils/sqlFileIoUi";

vi.mock("../components/common/MermaidBlock", () => ({
  MermaidBlock: ({ chart }: { chart: string }) => (
    <div data-testid="mock-mermaid">{chart}</div>
  ),
}));

vi.mock("../services/tauriCommands", () => ({
  listForeignKeys: vi.fn().mockResolvedValue([]),
}));

vi.mock("../utils/sqlFileIoUi", () => ({
  isConnectionGloballyReadOnly: vi.fn().mockResolvedValue(false),
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

const mockPostgresConnection = {
  connId: "conn-1",
  config: {
    id: "conn-1",
    name: "PostgreSQL",
    host: "localhost",
    port: 5432,
    username: "postgres",
    database_type: "postgres" as const,
  },
};

describe("ForeignKeyList 关系图", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

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

    vi.mocked(api.listForeignKeys).mockClear();
    vi.mocked(api.listForeignKeys).mockResolvedValue([]);
    vi.mocked(isConnectionGloballyReadOnly).mockClear();
    vi.mocked(isConnectionGloballyReadOnly).mockResolvedValue(false);

    useDatabaseStore.getState().reset();
    useConnectionStore.setState({
      activeConnections: { "conn-1": mockActiveConnection },
      activeConnId: "conn-1",
      activeConnection: mockActiveConnection,
    });
    useDatabaseStore.setState({
      activeConnId: "conn-1",
      selectedDatabase: "mydb",
      selectedTable: "orders",
      tableStructure: [{ name: "id", column_type: "int", nullable: false, key: "PRI", default_value: null, extra: "", comment: "" }],
      tableContentActiveTab: "foreignKeys",
    });
  });

  afterEach(() => {
    const actWarnings = consoleErrorSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("not wrapped in act")
    );
    consoleErrorSpy.mockRestore();
    expect(actWarnings).toHaveLength(0);
  });

  async function renderLoadedForeignKeyList() {
    render(<ForeignKeyList />);
    await waitFor(() => expect(api.listForeignKeys).toHaveBeenCalledTimes(1));
  }

  it("关系图默认折叠，展开后显示 Mermaid", async () => {
    await renderLoadedForeignKeyList();

    expect(screen.queryByTestId("mock-mermaid")).not.toBeInTheDocument();
    expect(screen.getByText("外键列表")).toBeInTheDocument();

    fireEvent.click(screen.getByText("关系图"));

    expect(screen.getByTestId("mock-mermaid")).toBeInTheDocument();
  });

  it("展开关系图后外键列表仍可见且关系图区域可内部滚动", async () => {
    await renderLoadedForeignKeyList();

    fireEvent.click(screen.getByText("关系图"));

    const section = screen.getByTestId("fk-diagram-section");
    expect(section).toHaveClass("foreign-key-diagram-section--expanded");
    expect(section).toBeVisible();
    expect(screen.getByText("外键列表")).toBeVisible();
  });

  it("PostgreSQL 外键页按数据库类型做只读探测并使用中立错误文案", async () => {
    useConnectionStore.setState({
      activeConnections: { "conn-1": mockPostgresConnection },
      activeConnId: "conn-1",
      activeConnection: mockPostgresConnection,
    });

    await renderLoadedForeignKeyList();

    await waitFor(() =>
      expect(isConnectionGloballyReadOnly).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "postgres"
      )
    );

    fireEvent.click(screen.getByText("添加外键向导"));

    expect(screen.getByText(/数据库会返回具体错误/)).toBeInTheDocument();
    expect(screen.queryByText(/MySQL 会返回具体错误/)).not.toBeInTheDocument();
  });
});
