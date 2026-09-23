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
import { IndexEditor } from "../components/index/IndexEditor";
import { TriggerEditor } from "../components/trigger/TriggerEditor";
import { useConnectionStore } from "../stores/connectionStore";
import type { ColumnInfo, IndexInfo, TriggerInfo } from "../types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../utils/monacoSetup", () => ({ setupMonacoEditor: vi.fn() }));
vi.mock("@monaco-editor/react", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      aria-label="触发器语句体"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

const columns: ColumnInfo[] = [
  {
    name: "email",
    column_type: "varchar(255)",
    nullable: true,
    key: "",
    default_value: null,
    extra: "",
    comment: "",
  },
];
const originalIndex: IndexInfo = {
  name: "idx_old",
  unique: false,
  index_type: "BTREE",
  is_primary: false,
  comment: "原注释",
  columns: [
    { column_name: "email", seq_in_index: 1, collation: "A", sub_part: null },
  ],
};
const originalTrigger: TriggerInfo = {
  name: "trg_old",
  event: "INSERT",
  timing: "BEFORE",
  table_name: "users",
  statement: "SET NEW.email = LOWER(NEW.email)",
  created: null,
  sql_mode: "",
  definer: "root@localhost",
};
const context = { connId: "conn-mysql", database: "myapp", table: "users" };
type EditorKind = "index" | "trigger";

function renderEditor(kind: EditorKind, edit = false) {
  const callbacks = { onCancel: vi.fn(), onSuccess: vi.fn() };
  const view = ({
    open = true,
    objectName,
    table = context.table,
  }: { open?: boolean; objectName?: string; table?: string } = {}) => (
    <ConfigProvider theme={{ token: { motion: false } }}>
      {kind === "index" ? (
        <IndexEditor
          {...context}
          {...callbacks}
          open={open}
          table={table}
          tableColumns={columns}
          editingIndex={
            edit
              ? objectName
                ? { ...originalIndex, name: objectName }
                : originalIndex
              : null
          }
        />
      ) : (
        <TriggerEditor
          {...context}
          {...callbacks}
          open={open}
          table={table}
          editingTrigger={
            edit
              ? objectName
                ? { ...originalTrigger, name: objectName }
                : originalTrigger
              : null
          }
        />
      )}
    </ConfigProvider>
  );
  const result = render(view());
  return {
    ...result,
    ...callbacks,
    rerenderEditor: (props: Parameters<typeof view>[0]) =>
      result.rerender(view(props)),
  };
}

async function getPreviewDialog() {
  // rc-util 的测试 ID 固定，按标题区分父编辑弹窗与 SQL 预览弹窗。
  const title = await screen.findByText("SQL 预览", {
    selector: ".ant-modal-title",
  });
  const dialog = title.closest('[role="dialog"]') as HTMLElement;
  await waitFor(() => expect(dialog).toBeVisible());
  return dialog;
}

function previewButton() {
  return screen.getByRole("button", { name: /SQL 预览/ });
}

function expectNoMutation() {
  expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/^(create_|delete_|drop_)/)])
  );
}

async function fillLatestValues(kind: EditorKind, edit: boolean) {
  if (kind === "index") {
    fireEvent.change(screen.getByLabelText("索引名称"), {
      target: { value: "idx_latest" },
    });
    if (!edit) {
      fireEvent.mouseDown(screen.getAllByRole("combobox")[2]!);
      fireEvent.click(await screen.findByText("email", { selector: "span" }));
    }
    fireEvent.change(screen.getByPlaceholderText("前缀长度"), {
      target: { value: "12" },
    });
    fireEvent.change(screen.getByLabelText("注释"), {
      target: { value: "最新注释" },
    });
  } else {
    fireEvent.change(screen.getByLabelText("触发器名称"), {
      target: { value: "trg_latest" },
    });
    fireEvent.mouseDown(screen.getByLabelText("触发时机"));
    fireEvent.click(
      await screen.findByText("AFTER (执行后)", {
        selector: ".ant-select-item-option-content",
      })
    );
    fireEvent.mouseDown(screen.getByLabelText("触发事件"));
    fireEvent.click(
      await screen.findByText("UPDATE", {
        selector: ".ant-select-item-option-content",
      })
    );
    fireEvent.change(screen.getByRole("textbox", { name: "触发器语句体" }), {
      target: { value: "BEGIN\n  SET NEW.email = LOWER(NEW.email);\nEND" },
    });
  }
}

describe("索引和触发器 SQL 预览", () => {
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
      connId: context.connId,
      config: {
        id: context.connId,
        name: "测试",
        host: "localhost",
        port: 3306,
        username: "u",
        database_type: "mysql" as const,
      },
    };
    useConnectionStore.setState({
      activeConnections: { [context.connId]: connection },
      activeConnId: context.connId,
      activeConnection: connection,
    });
  });

  it.each([
    ["index", false],
    ["index", true],
    ["trigger", false],
    ["trigger", true],
  ] as const)(
    "%s 编辑模式 %s 预览最新表单及全部 SQL，保存使用相同定义",
    async (kind, edit) => {
      const statements = edit
        ? [
            `DROP ${kind.toUpperCase()} original_from_backend`,
            `CREATE ${kind.toUpperCase()} latest_from_backend`,
          ]
        : [`CREATE ${kind.toUpperCase()} latest_from_backend`];
      vi.mocked(invoke).mockImplementation(async (command) =>
        command === `preview_${kind}` ? statements : []
      );
      renderEditor(kind, edit);
      await fillLatestValues(kind, edit);
      fireEvent.click(previewButton());
      const preview = await getPreviewDialog();
      for (const statement of statements) {
        expect(
          await within(preview).findByText(
            (_, element) =>
              element?.tagName === "PRE" &&
              !!element.textContent?.includes(statement)
          )
        ).toBeVisible();
      }
      const request =
        kind === "index"
          ? {
              index_name: "idx_latest",
              index_type: "INDEX",
              index_method: edit ? "BTREE" : undefined,
              columns: [
                {
                  column_name: "email",
                  length: 12,
                  order: edit ? "ASC" : undefined,
                },
              ],
              comment: "最新注释",
            }
          : {
              name: "trg_latest",
              timing: "AFTER",
              event: "UPDATE",
              body: "BEGIN\n  SET NEW.email = LOWER(NEW.email);\nEND",
            };
      expect(invoke).toHaveBeenCalledWith(`preview_${kind}`, {
        ...context,
        request,
        originalName: edit ? (kind === "index" ? "idx_old" : "trg_old") : null,
      });
      expectNoMutation();
      fireEvent.click(within(preview).getByRole("button", { name: /关\s*闭/ }));
      fireEvent.click(
        screen.getByRole("button", { name: edit ? /保\s*存/ : /创\s*建/ })
      );
      await waitFor(() =>
        expect(invoke).toHaveBeenCalledWith(`create_${kind}`, {
          ...context,
          request,
        })
      );
      if (edit) {
        expect(invoke).toHaveBeenCalledWith(
          kind === "index" ? "delete_index" : "drop_trigger",
          {
            ...context,
            ...(kind === "index"
              ? { indexName: "idx_old" }
              : { triggerName: "trg_old" }),
          }
        );
      }
    }
  );

  it.each(["index", "trigger"] as const)(
    "%s 缺少名称时先校验，不发送预览请求",
    async (kind) => {
      renderEditor(kind);
      fireEvent.click(previewButton());
      await waitFor(() =>
        expect(
          screen.getByText(
            kind === "index" ? "请输入索引名称" : "请输入触发器名称"
          )
        ).toBeVisible()
      );
      expect(invoke).not.toHaveBeenCalled();
      expect(
        screen.queryByText("SQL 预览", { selector: ".ant-modal-title" })
      ).not.toBeInTheDocument();
    }
  );

  it("触发器空语句体不发送预览请求", async () => {
    renderEditor("trigger", true);
    fireEvent.change(screen.getByRole("textbox", { name: "触发器语句体" }), {
      target: { value: "   " },
    });
    fireEvent.click(previewButton());
    await waitFor(() =>
      expect(screen.getByText("触发器语句体不能为空")).toBeVisible()
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["index", "trigger"] as const)(
    "%s 预览失败保留表单供继续编辑",
    async (kind) => {
      vi.mocked(invoke).mockRejectedValue("连接已断开");
      renderEditor(kind, true);
      await fillLatestValues(kind, true);
      fireEvent.click(previewButton());
      const preview = await getPreviewDialog();
      expect(await within(preview).findByText("连接已断开")).toBeVisible();
      expectNoMutation();
      fireEvent.click(within(preview).getByRole("button", { name: /关\s*闭/ }));
      expect(
        screen.getByLabelText(kind === "index" ? "索引名称" : "触发器名称")
      ).toHaveValue(kind === "index" ? "idx_latest" : "trg_latest");
      if (kind === "trigger")
        expect(
          screen.getByRole("textbox", { name: "触发器语句体" })
        ).toHaveValue("BEGIN\n  SET NEW.email = LOWER(NEW.email);\nEND");
    }
  );

  it.each(["index", "trigger"] as const)(
    "%s 关闭预览后忽略迟到结果",
    async (kind) => {
      let resolvePreview!: (sql: string[]) => void;
      vi.mocked(invoke).mockReturnValue(
        new Promise((resolve) => {
          resolvePreview = resolve;
        })
      );
      renderEditor(kind, true);
      fireEvent.click(previewButton());
      const preview = await getPreviewDialog();
      await waitFor(() => expect(invoke).toHaveBeenCalled());
      fireEvent.click(within(preview).getByRole("button", { name: /关\s*闭/ }));
      await act(async () => {
        resolvePreview(["CREATE late_result"]);
      });
      await waitFor(() =>
        expect(
          screen.queryByText("SQL 预览", { selector: ".ant-modal-title" })
        ).not.toBeInTheDocument()
      );
      expectNoMutation();
    }
  );

  it.each([
    ["index", "close"],
    ["index", "object"],
    ["index", "table"],
    ["trigger", "close"],
    ["trigger", "object"],
    ["trigger", "table"],
  ] as const)("%s 在 %s 改变后丢弃旧预览", async (kind, change) => {
    let resolvePreview!: (sql: string[]) => void;
    vi.mocked(invoke).mockReturnValue(
      new Promise((resolve) => {
        resolvePreview = resolve;
      })
    );
    const editor = renderEditor(kind, true);
    fireEvent.click(previewButton());
    await getPreviewDialog();
    await waitFor(() => expect(invoke).toHaveBeenCalled());
    editor.rerenderEditor(
      change === "close"
        ? { open: false }
        : change === "object"
          ? { objectName: "another_object" }
          : { table: "another_table" }
    );
    await act(async () => {
      resolvePreview(["CREATE stale_object"]);
    });
    await waitFor(() =>
      expect(
        screen.queryByText("SQL 预览", { selector: ".ant-modal-title" })
      ).not.toBeInTheDocument()
    );
    expect(screen.queryByText(/CREATE stale_object/)).not.toBeInTheDocument();
    expectNoMutation();
  });
});
