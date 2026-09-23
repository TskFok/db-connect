import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import { Modal } from "antd";
import { FavoriteTables } from "../components/database/FavoriteTables";
import { useConnectionStore } from "../stores/connectionStore";
import { emptyConnState, useDatabaseStore } from "../stores/databaseStore";
import { useFavoriteStore } from "../stores/favoriteStore";
import * as tauriCommands from "../services/tauriCommands";

vi.mock("../services/tauriCommands", () => ({
  listDatabases: vi.fn(),
  listTables: vi.fn(),
  getTableStructure: vi.fn(),
  getDatabaseInfo: vi.fn(),
  alterDatabaseCharset: vi.fn(),
  createDatabase: vi.fn(),
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

describe("FavoriteTables", () => {
  let getComputedSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    getComputedSpy = vi.spyOn(window, "getComputedStyle").mockImplementation(
      (): CSSStyleDeclaration =>
        ({
          getPropertyValue: () => "",
        }) as unknown as CSSStyleDeclaration
    );
  });

  afterAll(() => {
    getComputedSpy.mockRestore();
  });

  afterEach(() => {
    Modal.destroyAll();
  });

  beforeEach(() => {
    useConnectionStore.setState({
      activeConnections: { "conn-1": mockActiveConnection },
      activeConnId: "conn-1",
      activeConnection: mockActiveConnection,
    });
    useFavoriteStore.setState({ favorites: [] });
    useDatabaseStore.setState({
      activeConnId: "conn-1",
      connectionStates: {},
      databases: [],
      tables: {},
    });
    vi.mocked(tauriCommands.listTables).mockReset();
    vi.mocked(tauriCommands.getTableStructure).mockReset();
  });

  it("无 activeConnection 时不渲染", () => {
    useConnectionStore.setState({ activeConnection: null });
    const { container } = render(<FavoriteTables />);
    expect(container.firstChild).toBeNull();
  });

  it("有 activeConnection 时渲染收藏按钮", () => {
    render(<FavoriteTables />);
    expect(screen.getByRole("button", { name: /收藏/ })).toBeInTheDocument();
  });

  it("点击收藏按钮展开下拉菜单", () => {
    render(<FavoriteTables />);
    const btn = screen.getByRole("button", { name: /收藏/ });
    fireEvent.click(btn);
    expect(screen.getByText("收藏的表")).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/搜索库名或表名/)).toBeInTheDocument();
  });

  it("SQL Server 使用 schema 文案，且未保存连接时不会串到同 host/port 的 MySQL 收藏", () => {
    const sqlserverConnection = {
      connId: "mssql-1",
      config: {
        name: "SQL Server 临时连接",
        host: "localhost",
        port: 1433,
        username: "sa",
        database_type: "sqlserver" as const,
        database: "appdb",
      },
    };
    useConnectionStore.setState({
      activeConnections: { "mssql-1": sqlserverConnection },
      activeConnId: "mssql-1",
      activeConnection: sqlserverConnection,
    });
    useFavoriteStore.setState({
      favorites: [
        {
          connectionId: "session:mysql|localhost|1433|root|appdb",
          database: "myapp",
          table: "users",
        },
        {
          connectionId: "session:sqlserver|localhost|1433|sa|appdb",
          database: "dbo",
          table: "users",
        },
      ],
    });

    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));

    expect(
      screen.getByPlaceholderText(/搜索 schema 或表名/)
    ).toBeInTheDocument();
    expect(screen.getByText("dbo.users")).toBeInTheDocument();
    expect(screen.queryByText("myapp.users")).not.toBeInTheDocument();
    expect(screen.queryByText(/搜索库名或表名/)).not.toBeInTheDocument();
  });

  it("无收藏时下拉显示空状态", () => {
    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));
    expect(screen.getByText("暂无收藏")).toBeInTheDocument();
    expect(
      screen.getByText(/在数据库概览的表列表中点击星标可添加收藏/)
    ).toBeInTheDocument();
  });

  it("有收藏时下拉显示收藏列表", () => {
    useFavoriteStore.setState({
      favorites: [
        { connectionId: "conn-1", database: "myapp", table: "users" },
        { connectionId: "conn-1", database: "myapp", table: "orders" },
      ],
    });
    useDatabaseStore.setState((s) => ({
      ...s,
      tables: {
        myapp: [
          {
            name: "users",
            table_type: "TABLE",
            engine: "InnoDB",
            rows: 100,
            data_length: 0,
            index_length: null,
            comment: "用户表",
          },
          {
            name: "orders",
            table_type: "TABLE",
            engine: "InnoDB",
            rows: 50,
            data_length: 0,
            index_length: null,
            comment: "订单表",
          },
        ],
      },
    }));

    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));

    expect(screen.getByText("myapp.users")).toBeInTheDocument();
    expect(screen.getByText("myapp.orders")).toBeInTheDocument();
    expect(screen.getByText("用户表")).toBeInTheDocument();
    expect(screen.getByText("订单表")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "打开全部收藏" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "取消全部收藏" })
    ).toBeInTheDocument();
  });

  it("点击取消全部收藏后清空当前连接收藏并显示空状态", async () => {
    useFavoriteStore.setState({
      favorites: [
        { connectionId: "conn-1", database: "myapp", table: "users" },
        { connectionId: "other", database: "x", table: "y" },
      ],
    });
    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));
    fireEvent.click(screen.getByRole("button", { name: "取消全部收藏" }));

    await waitFor(() => {
      expect(document.querySelector(".ant-modal-confirm")).not.toBeNull();
    });
    const dialog = screen.getByRole("dialog");

    fireEvent.click(within(dialog).getByRole("button", { name: /清\s*空/ }));

    await waitFor(() => {
      expect(screen.getByText("暂无收藏")).toBeInTheDocument();
    });
    expect(useFavoriteStore.getState().favorites).toEqual([
      { connectionId: "other", database: "x", table: "y" },
    ]);
  });

  it("取消全部收藏时在确认框点「保留」不应清空", async () => {
    useFavoriteStore.setState({
      favorites: [
        { connectionId: "conn-1", database: "myapp", table: "users" },
      ],
    });
    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));
    fireEvent.click(screen.getByRole("button", { name: "取消全部收藏" }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /保\s*留/ }));

    await waitFor(() => {
      expect(document.querySelector(".ant-modal-confirm")).toBeNull();
    });
    expect(useFavoriteStore.getState().favorites).toHaveLength(1);
    expect(screen.getByText("myapp.users")).toBeInTheDocument();
  });

  it("打开全部收藏只建立标签，不逐表查询，并保留已有 SQL 标签", () => {
    useDatabaseStore.setState({
      connectionStates: {
        "conn-1": {
          ...emptyConnState(),
          openTabs: [{ type: "sql", id: "draft" }],
          sqlTabContents: { draft: "SELECT 1" },
        },
      },
    });
    useFavoriteStore.setState({
      favorites: [
        { connectionId: "conn-1", database: "public", table: "users" },
        { connectionId: "conn-1", database: "audit", table: "users" },
        { connectionId: "other", database: "other", table: "secret" },
      ],
    });
    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开全部收藏" }));

    expect(tauriCommands.listTables).not.toHaveBeenCalled();
    expect(tauriCommands.getTableStructure).not.toHaveBeenCalled();
    expect(useDatabaseStore.getState().openTabs).toEqual([
      { type: "sql", id: "draft" },
      { type: "table", database: "public", table: "users" },
      { type: "table", database: "audit", table: "users" },
    ]);
    expect(useDatabaseStore.getState().selectedDatabase).toBe("audit");
    expect(useDatabaseStore.getState().sqlTabContents.draft).toBe("SELECT 1");
    fireEvent.click(screen.getByRole("button", { name: "打开全部收藏" }));
    expect(useDatabaseStore.getState().openTabs).toHaveLength(3);
  });

  it("单条收藏也可直接建立标签且无需批量进度弹窗", () => {
    useFavoriteStore.setState({
      favorites: [
        { connectionId: "conn-1", database: "public", table: "users" },
      ],
    });
    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开全部收藏" }));

    expect(tauriCommands.listTables).not.toHaveBeenCalled();
    expect(tauriCommands.getTableStructure).not.toHaveBeenCalled();
    expect(useDatabaseStore.getState().openTabs).toEqual([
      { type: "table", database: "public", table: "users" },
    ]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("PostgreSQL 使用 schema 提示，并隔离临时连接的实际数据库", () => {
    useConnectionStore.setState({
      activeConnection: {
        connId: "pg-1",
        config: {
          name: "PG 临时连接",
          host: "localhost",
          port: 5432,
          username: "postgres",
          database_type: "postgres",
          database: "appdb",
        },
      },
    });
    useFavoriteStore.setState({
      favorites: [
        {
          connectionId: "session:postgres|localhost|5432|postgres|otherdb",
          database: "public",
          table: "secret",
        },
      ],
    });
    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));
    expect(
      screen.getByPlaceholderText(/搜索 schema 或表名/)
    ).toBeInTheDocument();
    expect(screen.getByText("暂无收藏")).toBeInTheDocument();
    expect(
      screen.getByText(/在 schema 概览的表列表中点击星标可添加收藏/)
    ).toBeInTheDocument();
    expect(screen.queryByText("public.secret")).not.toBeInTheDocument();
  });

  it("PostgreSQL 单击收藏按 schema 打开，并可单独取消同名表", async () => {
    useConnectionStore.setState({
      activeConnection: {
        connId: "pg-1",
        config: {
          id: "pg-profile",
          name: "PG",
          host: "localhost",
          port: 5432,
          username: "postgres",
          database_type: "postgres",
          database: "appdb",
        },
      },
    });
    useDatabaseStore.setState({ activeConnId: "pg-1" });
    useFavoriteStore.setState({
      favorites: [
        { connectionId: "pg-profile", database: "public", table: "users" },
        { connectionId: "pg-profile", database: "audit", table: "users" },
      ],
    });
    vi.mocked(tauriCommands.listTables).mockResolvedValue([
      {
        name: "users",
        table_type: "VIEW",
        engine: "PostgreSQL",
        rows: null,
        data_length: null,
        index_length: null,
        comment: "",
      },
    ]);
    vi.mocked(tauriCommands.getTableStructure).mockResolvedValue([]);
    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));
    fireEvent.click(screen.getByText("audit.users"));
    await waitFor(() => {
      expect(useDatabaseStore.getState().selectedDatabase).toBe("audit");
    });
    expect(tauriCommands.listTables).not.toHaveBeenCalled();
    expect(tauriCommands.getTableStructure).not.toHaveBeenCalled();
    expect(useDatabaseStore.getState().openTabs).toEqual([
      { type: "table", database: "audit", table: "users" },
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: "取消收藏 audit.users" })
    );
    expect(screen.queryByText("audit.users")).not.toBeInTheDocument();
    expect(screen.getByText("public.users")).toBeInTheDocument();
    expect(useFavoriteStore.getState().favorites).toEqual([
      { connectionId: "pg-profile", database: "public", table: "users" },
    ]);
  });

  it("下拉内搜索可过滤收藏列表", () => {
    useFavoriteStore.setState({
      favorites: [
        { connectionId: "conn-1", database: "myapp", table: "users" },
        { connectionId: "conn-1", database: "myapp", table: "orders" },
      ],
    });
    useDatabaseStore.setState((s) => ({
      ...s,
      tables: {
        myapp: [
          {
            name: "users",
            table_type: "TABLE",
            engine: "InnoDB",
            rows: 100,
            data_length: 0,
            index_length: null,
            comment: "用户表",
          },
          {
            name: "orders",
            table_type: "TABLE",
            engine: "InnoDB",
            rows: 50,
            data_length: 0,
            index_length: null,
            comment: "订单表",
          },
        ],
      },
    }));

    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));
    const searchInput = screen.getByPlaceholderText(/搜索库名或表名/);
    fireEvent.change(searchInput, { target: { value: "orders" } });

    expect(screen.getByText("myapp.orders")).toBeInTheDocument();
    expect(screen.queryByText("myapp.users")).not.toBeInTheDocument();
  });

  it("点击收藏项跳转表后下拉仍保持打开", async () => {
    useFavoriteStore.setState({
      favorites: [
        { connectionId: "conn-1", database: "myapp", table: "users" },
      ],
    });
    useDatabaseStore.setState((s) => ({
      ...s,
      tables: {
        myapp: [
          {
            name: "users",
            table_type: "TABLE",
            engine: "InnoDB",
            rows: 100,
            data_length: 0,
            index_length: null,
            comment: "用户表",
          },
        ],
      },
    }));

    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));
    fireEvent.click(screen.getByText("myapp.users"));

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/搜索库名或表名/)).toBeInTheDocument();
    });
  });

  it("在下拉内取消收藏后立即从列表移除", async () => {
    useFavoriteStore.setState({
      favorites: [
        { connectionId: "conn-1", database: "myapp", table: "users" },
        { connectionId: "conn-1", database: "myapp", table: "orders" },
      ],
    });
    useDatabaseStore.setState((s) => ({
      ...s,
      tables: {
        myapp: [
          {
            name: "users",
            table_type: "TABLE",
            engine: "InnoDB",
            rows: 100,
            data_length: 0,
            index_length: null,
            comment: "用户表",
          },
          {
            name: "orders",
            table_type: "TABLE",
            engine: "InnoDB",
            rows: 50,
            data_length: 0,
            index_length: null,
            comment: "订单表",
          },
        ],
      },
    }));

    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));

    fireEvent.click(
      screen.getByRole("button", { name: "取消收藏 myapp.users" })
    );

    await waitFor(() => {
      expect(screen.queryByText("myapp.users")).not.toBeInTheDocument();
    });
    expect(screen.getByText("myapp.orders")).toBeInTheDocument();
  });

  it("超长库名与表名在下拉中仍保留完整文案（多行换行）", () => {
    const longDb = "very_long_database_name_that_would_overflow";
    const longTable =
      "extremely_long_table_name_for_testing_wrapping_behavior_in_favorites";
    const fullLabel = `${longDb}.${longTable}`;
    useFavoriteStore.setState({
      favorites: [
        { connectionId: "conn-1", database: longDb, table: longTable },
      ],
    });

    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));

    expect(screen.getByText(fullLabel)).toBeInTheDocument();
  });
});
