import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { TableStructure } from "../components/table/TableStructure";
import { useDatabaseStore } from "../stores/databaseStore";
import { useConnectionStore } from "../stores/connectionStore";
import type { DatabaseType } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function renderStructure(databaseType: DatabaseType, columnType = "bigint") {
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
  useDatabaseStore.setState({
    activeConnId: connection.connId,
    selectedDatabase: "test-db",
    selectedTable: "prices",
    tableStructure: [
      {
        name: "id",
        column_type: columnType,
        nullable: false,
        key: "PRI",
        default_value: null,
        extra: "",
        comment: "",
      },
    ],
    selectedTableInfo: {
      name: "prices",
      table_type: "TABLE",
      engine: databaseType === "mysql" ? "InnoDB" : "PostgreSQL",
      rows: 0,
      data_length: 0,
      index_length: 0,
      comment: "",
    },
  });
  render(<TableStructure />);
}

async function selectColumnType(value: string) {
  const input = screen.getByRole("combobox", { name: "数据类型" });
  fireEvent.mouseDown(input);
  fireEvent.change(input, { target: { value } });
  const option = await waitFor(() => {
    const result = document.querySelector(
      `.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option[title="${value}"]`
    );
    expect(result).not.toBeNull();
    return result!;
  });
  fireEvent.click(option);
}

describe("表结构新增列的类型默认值", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset().mockResolvedValue([]);
    useDatabaseStore.getState().reset();
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

  it("MySQL varchar→decimal→text 自动更新参数，保存时没有隐藏字段残留", async () => {
    renderStructure("mysql");
    fireEvent.click(screen.getByRole("button", { name: /新增列/ }));
    expect(screen.getByLabelText("长度")).toHaveValue("255");
    await selectColumnType("decimal");
    expect(screen.getByLabelText("总位数 (M)")).toHaveValue("10");
    expect(screen.getByLabelText("小数位数 (D)")).toHaveValue("2");
    fireEvent.change(screen.getByLabelText("总位数 (M)"), {
      target: { value: "17" },
    });
    fireEvent.change(screen.getByLabelText("小数位数 (D)"), {
      target: { value: "6" },
    });
    await selectColumnType("text");
    expect(screen.queryByLabelText("长度")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("总位数 (M)")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("小数位数 (D)")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("请输入列名"), {
      target: { value: "body" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("add_column", {
        connId: "test-connection",
        database: "test-db",
        table: "prices",
        request: expect.objectContaining({ name: "body", column_type: "text" }),
      });
    });
  });

  it("PostgreSQL 新增 numeric 同时显示并提交总位数与小数位", async () => {
    renderStructure("postgres");
    fireEvent.click(screen.getByRole("button", { name: /新增列/ }));
    await selectColumnType("numeric");
    expect(screen.getByLabelText("总位数 (M)")).toHaveValue("10");
    expect(screen.getByLabelText("小数位数 (D)")).toHaveValue("2");
    fireEvent.change(screen.getByPlaceholderText("请输入列名"), {
      target: { value: "price" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("add_column", {
        connId: "test-connection",
        database: "test-db",
        table: "prices",
        request: expect.objectContaining({
          name: "price",
          column_type: "numeric(10,2)",
        }),
      });
    });
  });

  it("编辑现有 PostgreSQL numeric 列保留原精度，不套用新增默认值", () => {
    renderStructure("postgres", "numeric(12,4)");
    fireEvent.click(screen.getByLabelText("编辑列"));
    expect(screen.getByLabelText("总位数 (M)")).toHaveValue("12");
    expect(screen.getByLabelText("小数位数 (D)")).toHaveValue("4");
  });
});
