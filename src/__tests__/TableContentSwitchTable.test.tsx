import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  act,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { TableContent } from "../components/table/TableContent";
import { emptyConnState, useDatabaseStore } from "../stores/databaseStore";
import { useConnectionStore } from "../stores/connectionStore";
import { DatabaseTree } from "../components/database/DatabaseTree";
import * as api from "../services/tauriCommands";
import type { TableInfo } from "../types";

vi.mock("../services/tauriCommands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/tauriCommands")>()),
  listTables: vi.fn(),
  getTableStructure: vi.fn(),
}));

let tableDataMockRenderCount = 0;

vi.mock("../components/table/TableData", () => ({
  TableData: function MockTableData() {
    tableDataMockRenderCount += 1;
    return <div data-testid="mock-table-data" />;
  },
}));

vi.mock("../components/table/TableStructure", () => ({
  TableStructure: () => <div data-testid="mock-structure" />,
}));

vi.mock("../components/index/IndexList", () => ({
  IndexList: () => <div data-testid="mock-index-list" />,
}));

vi.mock("../components/trigger/TriggerList", () => ({
  TriggerList: () => <div data-testid="mock-trigger-list" />,
}));

vi.mock("../components/database/CreateTableSql", () => ({
  CreateTableSql: () => <div data-testid="mock-create-table-sql" />,
}));

vi.mock("../components/foreignKey/ForeignKeyList", () => ({
  ForeignKeyList: () => <div data-testid="mock-fk-list" />,
}));

describe("TableContent 多表切换", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tableDataMockRenderCount = 0;
    useConnectionStore.setState({
      activeConnection: {
        connId: "conn-1",
        config: {
          id: "conn-1",
          name: "MySQL",
          host: "localhost",
          port: 3306,
          username: "root",
          database_type: "mysql",
        },
      },
      activeConnId: "conn-1",
    });
    useDatabaseStore.getState().reset();
    useDatabaseStore.setState({
      activeConnId: "conn-1",
      selectedDatabase: "mydb",
      selectedTable: "users",
      tableStructure: [
        {
          name: "id",
          column_type: "bigint",
          nullable: false,
          key: "PRI",
          default_value: null,
          extra: "",
          comment: "",
        },
      ],
      selectedTableInfo: {
        name: "users",
        table_type: "TABLE",
        engine: "InnoDB",
        rows: 0,
        data_length: 0,
        index_length: null,
        comment: "",
      },
      tableContentActiveTab: "data",
    });
  });

  it("结合实际数据库树，批量标签只加载激活的 VIEW，切换后再加载另一个表", async () => {
    const view: TableInfo = {
      name: "summary",
      table_type: "VIEW",
      engine: null,
      rows: null,
      data_length: null,
      index_length: null,
      comment: "",
    };
    const users: TableInfo = { ...view, name: "users", table_type: "TABLE" };
    let finishList!: (tables: TableInfo[]) => void;
    vi.mocked(api.listTables)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishList = resolve;
          })
      )
      .mockResolvedValue([users]);
    vi.mocked(api.getTableStructure).mockResolvedValue([]);
    useDatabaseStore.getState().reset();
    useDatabaseStore.getState().switchToConnection("conn-1");
    useDatabaseStore.setState({
      databases: ["public", "reports"],
      connectionStates: {
        "conn-1": {
          ...emptyConnState(),
          databases: ["public", "reports"],
        },
      },
    });
    useDatabaseStore.getState().openTableTabs("conn-1", [
      { database: "public", table: "users" },
      { database: "reports", table: "summary" },
    ]);
    render(
      <>
        <DatabaseTree />
        <TableContent />
      </>
    );

    expect(screen.queryByRole("tab", { name: /外键/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /数据/ })).not.toBeInTheDocument();
    expect(api.listTables).toHaveBeenCalledWith("conn-1", "reports");
    expect(api.listTables).toHaveBeenCalledTimes(1);
    await act(async () => {
      finishList([view]);
    });
    expect(
      await screen.findByRole("tab", { name: /数据/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /外键/ })).not.toBeInTheDocument();
    expect(api.getTableStructure).toHaveBeenCalledTimes(1);
    expect(api.listTables).toHaveBeenCalledTimes(1);
    expect(api.getTableStructure).toHaveBeenCalledWith(
      "conn-1",
      "reports",
      "summary"
    );

    act(() => {
      useDatabaseStore.getState().switchTab("conn-1", 0);
    });
    expect(
      await screen.findByRole("tab", { name: /外键/ })
    ).toBeInTheDocument();
    expect(api.getTableStructure).toHaveBeenCalledWith(
      "conn-1",
      "public",
      "users"
    );
    expect(api.getTableStructure).toHaveBeenCalledTimes(2);
    expect(api.listTables).toHaveBeenCalledTimes(2);
    act(() => {
      useDatabaseStore.getState().switchTab("conn-1", 1);
    });
    expect(screen.queryByRole("tab", { name: /外键/ })).not.toBeInTheDocument();
    expect(api.getTableStructure).toHaveBeenCalledTimes(2);
  });

  it("元数据失败显示错误且不会自动重试，用户重试后显示正确的视图", async () => {
    const view: TableInfo = {
      name: "summary",
      table_type: "VIEW",
      engine: null,
      rows: null,
      data_length: null,
      index_length: null,
      comment: "",
    };
    vi.mocked(api.listTables)
      .mockRejectedValueOnce(new Error("暂时无法读取 schema"))
      .mockResolvedValue([view]);
    vi.mocked(api.getTableStructure).mockResolvedValue([]);
    useDatabaseStore.getState().reset();
    useDatabaseStore.getState().switchToConnection("conn-1");
    useDatabaseStore
      .getState()
      .openTableTabs("conn-1", [{ database: "reports", table: "summary" }]);
    render(<TableContent />);

    expect(await screen.findByText(/暂时无法读取 schema/)).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /数据/ })).not.toBeInTheDocument();
    expect(api.listTables).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /重\s*试/ }));
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /数据/ })).toBeInTheDocument()
    );
    expect(screen.queryByRole("tab", { name: /外键/ })).not.toBeInTheDocument();
    expect(api.listTables).toHaveBeenCalledTimes(2);
  });

  it("不再渲染内容区的数据库、表名与类型表头", () => {
    render(<TableContent />);

    expect(screen.queryByText("mydb")).not.toBeInTheDocument();
    expect(screen.queryByText("users")).not.toBeInTheDocument();
    expect(screen.queryByText("TABLE")).not.toBeInTheDocument();
  });

  it("在页签栏右侧显示当前数据库/schema 与表名", () => {
    render(<TableContent />);

    const tableTitle = screen.getByText("mydb.users");
    expect(tableTitle).toBeInTheDocument();
    expect(tableTitle).toHaveAttribute("title", "mydb.users");
  });

  it("切换 selectedTable 时 data 面板的 TableData 会重新渲染（避免 Ant Tabs 复用旧 items）", () => {
    render(<TableContent />);

    const afterFirst = tableDataMockRenderCount;
    expect(afterFirst).toBeGreaterThan(0);

    act(() => {
      useDatabaseStore.setState({
        selectedTable: "orders",
        selectedTableInfo: {
          name: "orders",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 0,
          data_length: 0,
          index_length: null,
          comment: "",
        },
        tableStructure: [
          {
            name: "id",
            column_type: "bigint",
            nullable: false,
            key: "PRI",
            default_value: null,
            extra: "",
            comment: "",
          },
        ],
      });
    });

    expect(tableDataMockRenderCount).toBeGreaterThan(afterFirst);
  });

  it("PostgreSQL（阶段五）表详情显示数据、结构、SQL、创建表与索引/触发器/外键标签", () => {
    useConnectionStore.setState({
      activeConnection: {
        connId: "pg-1",
        config: {
          id: "pg-1",
          name: "PostgreSQL",
          host: "localhost",
          port: 5432,
          username: "postgres",
          database_type: "postgres",
        },
      },
      activeConnId: "pg-1",
    });
    useDatabaseStore.setState({
      activeConnId: "pg-1",
      selectedDatabase: "public",
      selectedTable: "users",
      selectedTableInfo: {
        name: "users",
        table_type: "TABLE",
        engine: "PostgreSQL",
        rows: 0,
        data_length: 0,
        index_length: null,
        comment: "",
      },
      tableContentActiveTab: "data",
    });

    render(<TableContent />);

    expect(screen.getByRole("tab", { name: /数据/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /结构/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /SQL/ })).toBeInTheDocument();
    // PostgreSQL 已支持创建表
    expect(screen.getByRole("tab", { name: /创建表/ })).toBeInTheDocument();
    // 阶段五：开放索引/触发器/外键
    expect(screen.getByRole("tab", { name: /索引/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /触发器/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /外键/ })).toBeInTheDocument();
  });

  it("SQL Server 不展示当前未支持的创建表 SQL 标签", () => {
    useConnectionStore.setState({
      activeConnection: {
        connId: "mssql-1",
        config: {
          id: "mssql-1",
          name: "SQL Server",
          host: "localhost",
          port: 1433,
          username: "sa",
          database_type: "sqlserver",
        },
      },
      activeConnId: "mssql-1",
    });
    useDatabaseStore.setState({
      activeConnId: "mssql-1",
      selectedDatabase: "dbo",
      selectedTable: "users",
      selectedTableInfo: {
        name: "users",
        table_type: "TABLE",
        engine: "SQL Server",
        rows: 0,
        data_length: 0,
        index_length: null,
        comment: "",
      },
      tableContentActiveTab: "data",
    });

    render(<TableContent />);

    expect(screen.getByRole("tab", { name: /数据/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /结构/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /SQL/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: /创建表/ })
    ).not.toBeInTheDocument();
  });

  it("ClickHouse 表详情显示数据/结构/SQL/创建表标签并隐藏未开放对象管理标签", () => {
    useConnectionStore.setState({
      activeConnection: {
        connId: "ch-1",
        config: {
          id: "ch-1",
          name: "ClickHouse",
          host: "localhost",
          port: 8123,
          username: "default",
          database_type: "clickhouse",
        },
      },
      activeConnId: "ch-1",
    });
    useDatabaseStore.setState({
      activeConnId: "ch-1",
      selectedDatabase: "analytics",
      selectedTable: "events",
      selectedTableInfo: {
        name: "events",
        table_type: "TABLE",
        engine: "MergeTree",
        rows: null,
        data_length: 4096,
        index_length: null,
        comment: "",
      },
      tableContentActiveTab: "data",
    });

    render(<TableContent />);

    expect(screen.getByRole("tab", { name: /数据/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /结构/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /SQL/ })).toBeInTheDocument();
    expect(screen.getByTestId("mock-table-data")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /创建表/ })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /索引/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: /触发器/ })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /外键/ })).not.toBeInTheDocument();
  });
});
