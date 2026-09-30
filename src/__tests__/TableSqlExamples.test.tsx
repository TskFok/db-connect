import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";
import { TableContent } from "../components/table/TableContent";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";
import type { ColumnInfo } from "../types";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({ writeText: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../components/table/TableData", () => ({ TableData: () => null }));
vi.mock("../components/table/TableStructure", () => ({
  TableStructure: () => null,
}));

const columns: ColumnInfo[] = [
  {
    name: "id",
    column_type: "bigint",
    nullable: false,
    key: "PRI",
    default_value: null,
    extra: "auto_increment",
    comment: "",
  },
  {
    name: "name",
    column_type: "varchar(100)",
    nullable: false,
    key: "",
    default_value: null,
    extra: "",
    comment: "",
  },
];

describe("数据表 SQL 示例", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(writeText).mockResolvedValue(undefined);
    useConnectionStore.setState({
      activeConnId: "conn-1",
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
    });
    useDatabaseStore.getState().reset();
    useDatabaseStore.setState({
      activeConnId: "conn-1",
      selectedDatabase: "app",
      selectedTable: "users",
      selectedTableInfo: {
        name: "users",
        table_type: "TABLE",
        engine: "InnoDB",
        rows: 0,
        data_length: 0,
        index_length: 0,
        comment: "",
      },
      tableStructure: columns,
      tableContentActiveTab: "sql",
    });
  });

  it("SQL 标签展示当前表的示例，每个按钮仅复制所属 SQL 且不执行查询", async () => {
    render(<TableContent />);

    const select = screen.getByRole("article", { name: "查询数据" });
    expect(select.querySelector("code")?.textContent).toBe(
      "SELECT *\nFROM `app`.`users`\nLIMIT 100;"
    );
    expect(screen.getByRole("article", { name: "插入数据" })).toHaveTextContent(
      "`name`"
    );
    expect(screen.getByRole("article", { name: "更新数据" })).toHaveTextContent(
      "WHERE"
    );
    expect(screen.getByRole("article", { name: "删除数据" })).toHaveTextContent(
      "WHERE"
    );

    for (const example of screen.getAllByRole("article")) {
      fireEvent.click(
        within(example).getByRole("button", { name: /复制.*SQL/ })
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith(
          example.querySelector("code")?.textContent
        )
      );
    }
    expect(await screen.findAllByText("SQL 已复制")).not.toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("切换表与字段后，显示和复制新表的 SQL", async () => {
    render(<TableContent />);
    act(() => {
      useDatabaseStore.setState({
        selectedDatabase: "sales",
        selectedTable: "orders",
        selectedTableInfo: {
          ...useDatabaseStore.getState().selectedTableInfo!,
          name: "orders",
        },
        tableStructure: [columns[0], { ...columns[1], name: "total" }],
      });
    });

    const select = screen.getByRole("article", { name: "查询数据" });
    expect(select.querySelector("code")?.textContent).toBe(
      "SELECT *\nFROM `sales`.`orders`\nLIMIT 100;"
    );
    expect(screen.getByRole("article", { name: "插入数据" })).toHaveTextContent(
      "`total`"
    );
    expect(screen.queryByText(/FROM `app`.`users`/)).not.toBeInTheDocument();
    fireEvent.click(within(select).getByRole("button", { name: /复制.*SQL/ }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "SELECT *\nFROM `sales`.`orders`\nLIMIT 100;"
      )
    );
  });

  it("复制失败时显示错误提示", async () => {
    vi.mocked(writeText).mockRejectedValueOnce(
      new Error("clipboard unavailable")
    );
    render(<TableContent />);

    fireEvent.click(
      within(screen.getByRole("article", { name: "查询数据" })).getByRole(
        "button",
        { name: /复制.*SQL/ }
      )
    );

    expect(await screen.findByText("复制失败")).toBeInTheDocument();
    expect(screen.queryByText("SQL 已复制")).not.toBeInTheDocument();
  });
});
