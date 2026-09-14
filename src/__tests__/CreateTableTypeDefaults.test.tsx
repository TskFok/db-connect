import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CreateTableModal } from "../components/database/CreateTableModal";
import { useConnectionStore } from "../stores/connectionStore";
import type { DatabaseType } from "../types";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function renderCreateTable(databaseType: DatabaseType = "mysql") {
  const connection = {
    connId: "test-connection",
    config: {
      id: "test-connection",
      name: "测试连接",
      host: "localhost",
      port: 3306,
      username: "test",
      database_type: databaseType,
    },
  };
  useConnectionStore.setState({ activeConnection: connection });
  const onCreateTable = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <CreateTableModal
      open
      connId="test-connection"
      database="test-db"
      onCancel={() => {}}
      onSuccess={() => {}}
      onCreateTable={onCreateTable}
    />
  );
  return { onCreateTable, ...view };
}

async function selectColumnType(value: string, row = 0) {
  const input = document.getElementById(`columns_${row}_data_type`)!;
  fireEvent.mouseDown(input);
  fireEvent.change(input, { target: { value: value.replace(/\(.*/, "") } });
  await waitFor(() => {
    const option = document.querySelector(
      `.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="${value}"]`
    );
    expect(option).not.toBeNull();
    fireEvent.click(option!);
  });
}

function columnInput(field: string, row = 0) {
  return document.getElementById(`columns_${row}_${field}`) as HTMLInputElement;
}

describe("新建表切换数据类型", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
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
  });

  it("从自增整型切换到 decimal 后填充精度，并允许手动修改后提交", async () => {
    const { onCreateTable } = renderCreateTable();
    await selectColumnType("decimal");

    expect(columnInput("length")).toHaveValue("10");
    expect(columnInput("scale")).toHaveValue("2");
    expect(screen.queryByText("auto_increment")).not.toBeInTheDocument();

    fireEvent.change(columnInput("length"), { target: { value: "12" } });
    fireEvent.change(columnInput("scale"), { target: { value: "4" } });
    fireEvent.change(screen.getByPlaceholderText("例如: users"), {
      target: { value: "prices" },
    });
    fireEvent.click(screen.getByRole("button", { name: /创\s*建/ }));

    await waitFor(() => {
      expect(onCreateTable).toHaveBeenCalledWith(
        "test-connection",
        "test-db",
        expect.objectContaining({
          columns: [
            expect.objectContaining({
              column_type: "decimal(12,4) unsigned",
              extra: "",
            }),
          ],
        })
      );
    });
  });

  it("添加列从 varchar 切换为 text 后清空残留长度，提交有效 text 类型", async () => {
    const { onCreateTable } = renderCreateTable();
    fireEvent.click(screen.getByRole("button", { name: /添加列/ }));
    expect(columnInput("length", 1)).toHaveValue("255");
    await selectColumnType("text", 1);

    expect(columnInput("length", 1)).toHaveValue("");
    expect(columnInput("length", 1)).toBeDisabled();
    fireEvent.change(columnInput("name", 1), { target: { value: "body" } });
    fireEvent.change(screen.getByPlaceholderText("例如: users"), {
      target: { value: "articles" },
    });
    fireEvent.click(screen.getByRole("button", { name: /创\s*建/ }));
    await waitFor(() => {
      expect(onCreateTable).toHaveBeenCalledWith(
        "test-connection",
        "test-db",
        expect.objectContaining({
          columns: expect.arrayContaining([
            expect.objectContaining({ name: "body", column_type: "text" }),
          ]),
        })
      );
    });
  });

  it("PostgreSQL numeric 同时自动填充并开放精度和小数位输入", async () => {
    renderCreateTable("postgres");
    await selectColumnType("numeric");
    expect(columnInput("length")).toHaveValue("10");
    expect(columnInput("length")).toBeEnabled();
    expect(columnInput("scale")).toHaveValue("2");
    expect(columnInput("scale")).toBeEnabled();
  });

  it("SQL Server 采用 decimal 精度并自动填写 varbinary 的 max 长度", async () => {
    renderCreateTable("sqlserver");
    await selectColumnType("decimal(18,2)");
    expect(columnInput("length")).toHaveValue("18");
    expect(columnInput("scale")).toHaveValue("2");
    expect(screen.queryByText("identity")).not.toBeInTheDocument();
    await selectColumnType("varbinary(max)");
    expect(columnInput("length")).toHaveValue("max");
    expect(columnInput("scale")).toHaveValue("");
    expect(columnInput("scale")).toBeDisabled();
  });

  it("SQL 预览与实际创建使用相同的校验后参数，预览本身不创建表", async () => {
    vi.mocked(invoke).mockResolvedValue([
      "CREATE TABLE `prices` (`id` bigint unsigned NOT NULL AUTO_INCREMENT, PRIMARY KEY (`id`)) ENGINE=InnoDB;",
    ]);
    const { onCreateTable } = renderCreateTable();
    fireEvent.change(screen.getByPlaceholderText("例如: users"), {
      target: { value: "prices" },
    });
    fireEvent.click(screen.getByRole("button", { name: /SQL 预览/ }));

    await waitFor(() => {
      expect(screen.getByText(/CREATE TABLE `prices`/)).toBeInTheDocument();
    });
    expect(invoke).toHaveBeenCalledWith("preview_create_table", {
      connId: "test-connection",
      database: "test-db",
      request: expect.objectContaining({
        table_name: "prices",
        columns: [
          expect.objectContaining({
            name: "id",
            column_type: "bigint unsigned",
            extra: "auto_increment",
          }),
        ],
      }),
    });
    expect(onCreateTable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /关\s*闭/ }));
    fireEvent.click(screen.getByRole("button", { name: /创\s*建/ }));
    const previewRequest = vi.mocked(invoke).mock.calls[0][1] as {
      request: unknown;
    };
    await waitFor(() => {
      expect(onCreateTable).toHaveBeenCalledWith(
        "test-connection",
        "test-db",
        previewRequest.request
      );
    });
  });

  it("SQL 预览先校验必填项，未填写表名不发起请求", async () => {
    renderCreateTable();
    fireEvent.click(screen.getByRole("button", { name: /SQL 预览/ }));
    expect(await screen.findByText("请输入表名")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("切换数据库时关闭旧 SQL 预览", async () => {
    vi.mocked(invoke).mockResolvedValue(["CREATE TABLE prices (id bigint);"]);
    const { onCreateTable, rerender } = renderCreateTable();
    fireEvent.change(screen.getByPlaceholderText("例如: users"), {
      target: { value: "prices" },
    });
    fireEvent.click(screen.getByRole("button", { name: /SQL 预览/ }));
    expect(await screen.findByText(/CREATE TABLE prices/)).toBeInTheDocument();

    rerender(
      <CreateTableModal
        open
        connId="other-connection"
        database="other-db"
        onCancel={() => {}}
        onSuccess={() => {}}
        onCreateTable={onCreateTable}
      />
    );
    await waitFor(() => {
      expect(screen.queryByText(/CREATE TABLE prices/)).not.toBeInTheDocument();
    });
  });

  it("取消后的迟到结果不会覆盖下一次 SQL 预览", async () => {
    let resolveFirst!: (sql: string[]) => void;
    vi.mocked(invoke)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce(["CREATE TABLE current_prices (id bigint);"]);
    renderCreateTable();
    fireEvent.change(screen.getByPlaceholderText("例如: users"), {
      target: { value: "old_prices" },
    });
    fireEvent.click(screen.getByRole("button", { name: /SQL 预览/ }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /关\s*闭/ }));
    fireEvent.change(screen.getByPlaceholderText("例如: users"), {
      target: { value: "current_prices" },
    });
    fireEvent.click(screen.getByRole("button", { name: /SQL 预览/ }));
    expect(
      await screen.findByText(/CREATE TABLE current_prices/)
    ).toBeInTheDocument();

    await act(async () =>
      resolveFirst(["CREATE TABLE old_prices (id bigint);"])
    );
    expect(screen.getByText(/CREATE TABLE current_prices/)).toBeInTheDocument();
    expect(
      screen.queryByText(/CREATE TABLE old_prices/)
    ).not.toBeInTheDocument();
  });

  it("SQL 预览失败显示错误并保留表单供修改重试", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("连接已关闭"));
    const { onCreateTable } = renderCreateTable();
    fireEvent.change(screen.getByPlaceholderText("例如: users"), {
      target: { value: "prices" },
    });
    fireEvent.click(screen.getByRole("button", { name: /SQL 预览/ }));
    expect(await screen.findByText("连接已关闭")).toBeInTheDocument();
    expect(onCreateTable).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /关\s*闭/ }));
    expect(screen.getByPlaceholderText("例如: users")).toHaveValue("prices");
    expect(columnInput("name")).toHaveValue("id");
  });
});
