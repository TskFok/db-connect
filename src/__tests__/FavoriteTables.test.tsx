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
import { useDatabaseStore } from "../stores/databaseStore";
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
      screen.getByText(/在数据库树中点击表旁的星标可添加收藏/)
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

  it("点击打开全部收藏会为每个收藏项请求表结构", async () => {
    const mockCol = [
      {
        name: "id",
        column_type: "int",
        nullable: false,
        key: "PRI",
        default_value: null,
        extra: "",
        comment: "",
      },
    ];
    vi.mocked(tauriCommands.listTables).mockResolvedValue([]);
    vi.mocked(tauriCommands.getTableStructure).mockResolvedValue(mockCol);

    useFavoriteStore.setState({
      favorites: [
        { connectionId: "conn-1", database: "myapp", table: "users" },
        { connectionId: "conn-1", database: "myapp", table: "orders" },
      ],
    });

    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开全部收藏" }));

    await waitFor(() => {
      expect(screen.getByText("批量打开收藏的表")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(tauriCommands.getTableStructure).toHaveBeenCalledTimes(2);
    });
    expect(tauriCommands.getTableStructure).toHaveBeenCalledWith(
      "conn-1",
      "myapp",
      "users"
    );
    expect(tauriCommands.getTableStructure).toHaveBeenCalledWith(
      "conn-1",
      "myapp",
      "orders"
    );
  });

  it("批量打开时点击中止仅在当前表加载完成后停止后续表", async () => {
    const mockCol = [
      {
        name: "id",
        column_type: "int",
        nullable: false,
        key: "PRI",
        default_value: null,
        extra: "",
        comment: "",
      },
    ];
    vi.mocked(tauriCommands.listTables).mockResolvedValue([]);

    let resolveFirst!: () => void;
    const firstGate = new Promise<void>((res) => {
      resolveFirst = res;
    });

    vi.mocked(tauriCommands.getTableStructure)
      .mockReset()
      .mockImplementationOnce(async () => {
        await firstGate;
        return mockCol;
      })
      .mockResolvedValue(mockCol);

    useFavoriteStore.setState({
      favorites: [
        { connectionId: "conn-1", database: "myapp", table: "users" },
        { connectionId: "conn-1", database: "myapp", table: "orders" },
      ],
    });

    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开全部收藏" }));

    await waitFor(() => {
      expect(screen.getByText("批量打开收藏的表")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole("button", { name: "中止批量打开" }));

    await waitFor(() => {
      expect(screen.getByText(/已中止批量打开/)).toBeInTheDocument();
    });

    resolveFirst();

    await waitFor(() => {
      expect(tauriCommands.getTableStructure).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("button", { name: "知道了" }));
    await waitFor(() => {
      expect(screen.queryByText(/已中止批量打开/)).not.toBeInTheDocument();
    });
  });

  it("仅 1 条收藏时打开全部不显示进度弹窗", async () => {
    const mockCol = [
      {
        name: "id",
        column_type: "int",
        nullable: false,
        key: "PRI",
        default_value: null,
        extra: "",
        comment: "",
      },
    ];
    vi.mocked(tauriCommands.listTables).mockResolvedValue([]);
    vi.mocked(tauriCommands.getTableStructure).mockResolvedValue(mockCol);

    useFavoriteStore.setState({
      favorites: [
        { connectionId: "conn-1", database: "myapp", table: "users" },
      ],
    });

    render(<FavoriteTables />);
    fireEvent.click(screen.getByRole("button", { name: /收藏/ }));
    fireEvent.click(screen.getByRole("button", { name: "打开全部收藏" }));

    await waitFor(() => {
      expect(tauriCommands.getTableStructure).toHaveBeenCalledWith(
        "conn-1",
        "myapp",
        "users"
      );
    });
    expect(screen.queryByText(/批量打开收藏的表/)).not.toBeInTheDocument();
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
