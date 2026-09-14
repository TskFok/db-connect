import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ConfigProvider } from "antd";
import { TableStructure } from "../components/table/TableStructure";
import { useDatabaseStore } from "../stores/databaseStore";
import { useConnectionStore } from "../stores/connectionStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// rc-util 在测试环境给所有弹窗同一个 aria-labelledby id，按标题定位各弹窗。
async function getPreviewDialog() {
  const title = await screen.findByText("SQL 预览", {
    selector: ".ant-modal-title",
  });
  const dialog = title.closest('[role="dialog"]') as HTMLElement;
  await waitFor(() => expect(dialog).toBeVisible());
  return dialog;
}

function renderStructure() {
  return render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <TableStructure />
    </ConfigProvider>
  );
}

describe("表结构 SQL 预览", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue([]);
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
      connId: "conn-mysql",
      config: {
        id: "conn-mysql",
        name: "测试",
        host: "localhost",
        port: 3306,
        username: "u",
        database_type: "mysql" as const,
      },
    };
    useConnectionStore.setState({
      activeConnections: { "conn-mysql": connection },
      activeConnId: "conn-mysql",
      activeConnection: connection,
    });
    useDatabaseStore.getState().reset();
    useDatabaseStore.setState({
      activeConnId: "conn-mysql",
      selectedDatabase: "myapp",
      selectedTable: "users",
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
      selectedTableInfo: {
        name: "users",
        table_type: "TABLE",
        engine: "InnoDB",
        rows: 0,
        data_length: 0,
        index_length: 0,
        comment: "",
      },
    });
  });

  it("新增列预览显示后端 SQL，只有保存才执行 DDL，且两次请求定义相同", async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "preview_add_column"
        ? ["ALTER TABLE `myapp`.`users` ADD COLUMN `nickname` varchar(80) NULL"]
        : []
    );
    renderStructure();
    fireEvent.click(screen.getByRole("button", { name: /新增列/ }));
    fireEvent.change(screen.getByLabelText("列名"), {
      target: { value: "nickname" },
    });
    fireEvent.change(screen.getByLabelText("长度"), {
      target: { value: "80" },
    });
    fireEvent.click(screen.getByRole("button", { name: /SQL 预览/ }));
    const preview = await getPreviewDialog();
    expect(
      await within(preview).findByText(
        /ADD COLUMN `nickname` varchar\(80\) NULL/
      )
    ).toBeVisible();
    const previewCall = vi
      .mocked(invoke)
      .mock.calls.find(([cmd]) => cmd === "preview_add_column");
    expect(previewCall?.[1]).toMatchObject({
      connId: "conn-mysql",
      database: "myapp",
      table: "users",
      request: {
        name: "nickname",
        column_type: "varchar(80)",
        nullable: true,
        default_value: null,
      },
    });
    expect(
      vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "add_column")
    ).toBe(false);
    fireEvent.click(within(preview).getByRole("button", { name: /关\s*闭/ }));
    fireEvent.click(screen.getByRole("button", { name: /保\s*存/ }));
    await waitFor(() =>
      expect(
        vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "add_column")?.[1]
      ).toEqual(previewCall?.[1])
    );
  });

  it("编辑列预览包含重命名、主键及表单最新值", async () => {
    vi.mocked(invoke).mockResolvedValue([
      "ALTER TABLE `myapp`.`users` CHANGE COLUMN `id` `user_id` int NOT NULL",
    ]);
    renderStructure();
    fireEvent.click(screen.getByLabelText("编辑列"));
    fireEvent.change(screen.getByLabelText("列名"), {
      target: { value: "user_id" },
    });
    fireEvent.click(screen.getByRole("button", { name: /SQL 预览/ }));
    await getPreviewDialog();
    expect(
      await screen.findByText(/CHANGE COLUMN `id` `user_id`/)
    ).toBeVisible();
    expect(invoke).toHaveBeenCalledWith(
      "preview_alter_column",
      expect.objectContaining({
        request: expect.objectContaining({
          old_name: "id",
          new_name: "user_id",
          is_primary: true,
        }),
      })
    );
    expect(
      vi.mocked(invoke).mock.calls.some(([cmd]) => cmd === "alter_column")
    ).toBe(false);
  });

  it("表属性预览携带新表名与引擎且无变化时有明确提示", async () => {
    renderStructure();
    fireEvent.click(screen.getByRole("button", { name: /编辑表属性/ }));
    fireEvent.change(screen.getByLabelText("表名"), {
      target: { value: "members" },
    });
    fireEvent.click(screen.getByRole("button", { name: /SQL 预览/ }));
    await getPreviewDialog();
    expect(await screen.findByText("没有需要执行的 SQL")).toBeVisible();
    expect(invoke).toHaveBeenCalledWith("preview_table_properties", {
      connId: "conn-mysql",
      database: "myapp",
      table: "users",
      newName: "members",
      engine: null,
    });
  });

  it("空列名先显示表单校验，不发送预览请求", async () => {
    renderStructure();
    fireEvent.click(screen.getByRole("button", { name: /新增列/ }));
    fireEvent.click(screen.getByRole("button", { name: /SQL 预览/ }));
    await waitFor(() => expect(screen.getByText("列名不能为空")).toBeVisible());
    expect(invoke).not.toHaveBeenCalled();
    expect(
      screen.queryByText("SQL 预览", { selector: ".ant-modal-title" })
    ).not.toBeInTheDocument();
  });

  it("预览失败显示错误并保留可继续编辑的表单", async () => {
    vi.mocked(invoke).mockRejectedValue("连接已断开");
    renderStructure();
    fireEvent.click(screen.getByLabelText("编辑列"));
    fireEvent.click(screen.getByRole("button", { name: /SQL 预览/ }));
    const preview = await getPreviewDialog();
    expect(await within(preview).findByText("连接已断开")).toBeVisible();
    fireEvent.click(within(preview).getByRole("button", { name: /关\s*闭/ }));
    expect(screen.getByLabelText("列名")).toHaveValue("id");
  });

  it("关闭加载中的预览后，迟到的结果不会重新打开预览", async () => {
    let resolvePreview!: (sql: string[]) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((resolve) => {
        resolvePreview = resolve;
      })
    );
    renderStructure();
    fireEvent.click(screen.getByLabelText("编辑列"));
    fireEvent.click(screen.getByRole("button", { name: /SQL 预览/ }));
    const preview = await getPreviewDialog();
    fireEvent.click(within(preview).getByRole("button", { name: /关\s*闭/ }));
    await act(async () => {
      resolvePreview(["ALTER TABLE late_result"]);
    });
    await waitFor(() =>
      expect(
        screen.queryByText("SQL 预览", { selector: ".ant-modal-title" })
      ).not.toBeInTheDocument()
    );
  });
});
