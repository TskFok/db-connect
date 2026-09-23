import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { Modal } from "antd";
import { ForeignKeyList } from "../components/foreignKey/ForeignKeyList";
import { useDatabaseStore } from "../stores/databaseStore";
import { useConnectionStore } from "../stores/connectionStore";
import * as api from "../services/tauriCommands";
import { isConnectionGloballyReadOnly } from "../utils/sqlFileIoUi";
import { subscribeSqlCompletionInvalidation } from "../utils/sqlCompletionInvalidation";
import type { SqlCompletionInvalidation } from "../utils/sqlCompletionInvalidation";

vi.mock("../components/common/MermaidBlock", () => ({
  MermaidBlock: ({ chart }: { chart: string }) => (
    <div data-testid="mock-mermaid">{chart}</div>
  ),
}));

vi.mock("../services/tauriCommands", () => ({
  listForeignKeys: vi.fn().mockResolvedValue([]),
  addForeignKey: vi.fn().mockResolvedValue(undefined),
  dropForeignKey: vi.fn().mockResolvedValue(undefined),
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

const mockSqlServerConnection = {
  connId: "conn-1",
  config: {
    id: "conn-1",
    name: "SQL Server",
    host: "localhost",
    port: 1433,
    username: "sa",
    database_type: "sqlserver" as const,
  },
};

describe("ForeignKeyList 关系图", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let events: SqlCompletionInvalidation[];
  let unsubscribe: () => void;

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
    vi.mocked(api.addForeignKey).mockReset().mockResolvedValue(undefined);
    vi.mocked(api.dropForeignKey).mockReset().mockResolvedValue(undefined);
    events = [];
    unsubscribe = subscribeSqlCompletionInvalidation((event) =>
      events.push(event)
    );
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
      tableStructure: [
        {
          name: "id",
          column_type: "int",
          nullable: false,
          key: "PRI",
          default_value: null,
          extra: "",
          comment: "",
        },
      ],
      tableContentActiveTab: "foreignKeys",
    });
  });

  afterEach(() => {
    unsubscribe();
    const actWarnings = consoleErrorSpy.mock.calls.filter((call: unknown[]) =>
      String(call[0]).includes("not wrapped in act")
    );
    vi.restoreAllMocks();
    expect(actWarnings).toHaveLength(0);
  });

  const crossSchemaForeignKey = {
    constraint_name: "fk_orders_user",
    direction: "outgoing",
    table_schema: "sales",
    table_name: "orders",
    column_names: ["user_id"],
    referenced_table_schema: "auth",
    referenced_table_name: "users",
    referenced_column_names: ["id"],
    update_rule: "NO ACTION",
    delete_rule: "CASCADE",
  };

  async function submitCrossSchemaForeignKeyWizard() {
    fireEvent.click(screen.getByText("添加外键向导"));
    const dialog = await screen.findByRole("dialog", {
      name: "添加外键（向导）",
    });
    fireEvent.change(within(dialog).getByLabelText("约束名"), {
      target: { value: "fk_orders_user" },
    });
    fireEvent.mouseDown(within(dialog).getByText("选择列"));
    fireEvent.click(
      await screen.findByText("id", {
        selector: ".ant-select-item-option-content",
      })
    );
    fireEvent.change(within(dialog).getByLabelText("被引用表"), {
      target: { value: "auth.users" },
    });
    fireEvent.change(
      within(dialog).getByLabelText("引用列（逗号分隔，顺序与上面一致）"),
      {
        target: { value: "id" },
      }
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "生成并确认" }));
  }

  it("跨 schema 添加外键成功后广播整个连接的 schema 失效", async () => {
    useDatabaseStore.setState({ selectedDatabase: "sales" });
    const confirm = vi.spyOn(Modal, "confirm").mockImplementation(() => ({
      destroy: vi.fn(),
      update: vi.fn(),
    }));
    await renderLoadedForeignKeyList();
    await submitCrossSchemaForeignKeyWizard();
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await act(async () => {
      await confirm.mock.calls[0][0].onOk?.(() => {});
    });
    expect(api.addForeignKey).toHaveBeenCalledWith(
      "conn-1",
      "sales",
      "orders",
      {
        constraint_name: "fk_orders_user",
        columns: ["id"],
        referenced_table: "auth.users",
        referenced_columns: ["id"],
        on_update: "RESTRICT",
        on_delete: "RESTRICT",
      }
    );
    expect(events).toEqual([{ connId: "conn-1", reason: "schema-change" }]);
  });

  it("跨 schema 添加外键失败时不广播失效", async () => {
    useDatabaseStore.setState({ selectedDatabase: "sales" });
    vi.mocked(api.addForeignKey).mockRejectedValue(new Error("denied"));
    const confirm = vi.spyOn(Modal, "confirm").mockImplementation(() => ({
      destroy: vi.fn(),
      update: vi.fn(),
    }));
    await renderLoadedForeignKeyList();
    await submitCrossSchemaForeignKeyWizard();
    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    await act(async () => {
      await expect(confirm.mock.calls[0][0].onOk?.(() => {})).rejects.toThrow(
        "denied"
      );
    });
    expect(events).toEqual([]);
  });

  it("跨 schema 删除外键成功后广播整个连接的 schema 失效", async () => {
    vi.mocked(api.listForeignKeys).mockResolvedValue([crossSchemaForeignKey]);
    useDatabaseStore.setState({ selectedDatabase: "sales" });
    const { container } = render(<ForeignKeyList />);
    await screen.findByText("fk_orders_user");
    const deleteButton = container.querySelector(
      ".ant-table-cell-fix-right .ant-btn-dangerous"
    );
    expect(deleteButton).not.toBeNull();
    fireEvent.click(deleteButton!);
    fireEvent.click(await screen.findByRole("button", { name: /删\s*除/ }));
    await waitFor(() =>
      expect(api.dropForeignKey).toHaveBeenCalledWith(
        "conn-1",
        "sales",
        "orders",
        "fk_orders_user"
      )
    );
    await waitFor(() =>
      expect(events).toEqual([{ connId: "conn-1", reason: "schema-change" }])
    );
  });

  it("跨 schema 删除外键失败时不广播失效", async () => {
    vi.mocked(api.listForeignKeys).mockResolvedValue([crossSchemaForeignKey]);
    vi.mocked(api.dropForeignKey).mockRejectedValue(new Error("denied"));
    useDatabaseStore.setState({ selectedDatabase: "sales" });
    const { container } = render(<ForeignKeyList />);
    await screen.findByText("fk_orders_user");
    const deleteButton = container.querySelector(
      ".ant-table-cell-fix-right .ant-btn-dangerous"
    );
    expect(deleteButton).not.toBeNull();
    fireEvent.click(deleteButton!);
    fireEvent.click(await screen.findByRole("button", { name: /删\s*除/ }));
    await screen.findByText(/删除失败: Error: denied/);
    expect(events).toEqual([]);
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

  it("SQL Server 删除外键确认文案使用 DROP CONSTRAINT 术语", async () => {
    useConnectionStore.setState({
      activeConnections: { "conn-1": mockSqlServerConnection },
      activeConnId: "conn-1",
      activeConnection: mockSqlServerConnection,
    });
    vi.mocked(api.listForeignKeys).mockResolvedValue([
      {
        constraint_name: "fk_orders_user",
        direction: "outgoing",
        table_schema: "dbo",
        table_name: "orders",
        column_names: ["user_id"],
        referenced_table_schema: "dbo",
        referenced_table_name: "users",
        referenced_column_names: ["id"],
        update_rule: "NO ACTION",
        delete_rule: "CASCADE",
      },
    ]);

    const { container } = render(<ForeignKeyList />);
    await waitFor(() =>
      expect(screen.getByText("fk_orders_user")).toBeInTheDocument()
    );

    const deleteButton = container.querySelector(
      ".ant-table-cell-fix-right .ant-btn-dangerous"
    ) as HTMLButtonElement | null;
    expect(deleteButton).not.toBeNull();
    fireEvent.click(deleteButton!);

    expect(await screen.findByText(/DROP CONSTRAINT/)).toBeInTheDocument();
    expect(screen.queryByText(/DROP FOREIGN KEY/)).not.toBeInTheDocument();
  });
});
