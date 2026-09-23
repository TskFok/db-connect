import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnMount } from "@monaco-editor/react";
import { SqlEditor } from "../components/sql/SqlEditor";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";
import * as api from "../services/tauriCommands";
import * as excelExport from "../utils/excelExport";
import type { SqlExecuteResult } from "../types";
import { subscribeSqlCompletionInvalidation } from "../utils/sqlCompletionInvalidation";

vi.mock("../services/tauriCommands");
vi.mock("../utils/monacoSetup", () => ({ setupMonacoEditor: () => undefined }));
vi.mock("../utils/sqlCompletionSchema", () => ({
  loadSqlCompletionSchema: vi.fn().mockResolvedValue({
    databases: [],
    tables: [],
    columns: [],
  }),
}));
vi.mock("../utils/excelExport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/excelExport")>()),
  buildQueryResultWorkbookBase64: vi.fn().mockResolvedValue("workbook-base64"),
  saveExcelWithDialog: vi.fn().mockResolvedValue(true),
}));
vi.mock("@monaco-editor/react", async () => {
  const React = await import("react");
  const monaco = await import("monaco-editor");
  return {
    default: function MockEditor({
      value,
      defaultValue,
      onChange,
      onMount,
    }: {
      value?: string;
      defaultValue?: string;
      onChange?: (value: string) => void;
      onMount: OnMount;
    }) {
      const textarea = React.useRef<HTMLTextAreaElement>(null);
      React.useEffect(() => {
        onMount(
          {
            getValue: () => textarea.current?.value ?? "",
            getSelection: () => null,
            getModel: () => null,
            trigger: () => undefined,
            onDidChangeModel: () => ({ dispose: () => undefined }),
            onDidFocusEditorText: () => ({ dispose: () => undefined }),
            onDidBlurEditorText: () => ({ dispose: () => undefined }),
            addAction: () => ({ dispose: () => undefined }),
          } as unknown as Parameters<OnMount>[0],
          monaco
        );
      }, [onMount]);
      return React.createElement("textarea", {
        ref: textarea,
        "aria-label": "SQL 内容",
        value,
        defaultValue,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
          onChange?.(event.target.value),
      });
    },
  };
});

const connection = {
  connId: "conn-multiple-results",
  config: {
    id: "profile-multiple-results",
    name: "测试连接",
    host: "localhost",
    port: 3306,
    username: "root",
    database_type: "mysql" as const,
  },
};

function openSqlTab(sql: string): string {
  useDatabaseStore.getState().openSqlTab(connection.connId, sql);
  const tab = useDatabaseStore
    .getState()
    .openTabs.find((item) => item.type === "sql");
  if (!tab || tab.type !== "sql") throw new Error("SQL 标签页创建失败");
  return tab.id;
}

function selectResult(value: string, column = "value"): SqlExecuteResult {
  return {
    result_type: "select",
    columns: [column],
    rows: [[value]],
    affected_rows: null,
    message: "返回 1 行",
    execution_time_ms: 1,
  };
}

async function execute() {
  fireEvent.click(screen.getByRole("button", { name: /执\s*行$/ }));
  await waitFor(() => {
    expect(
      screen.queryByRole("button", { name: /停\s*止$/ })
    ).not.toBeInTheDocument();
  });
}

describe("SqlEditor 多语句结果标签", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.executeSql).mockReset();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
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
    useConnectionStore.setState({
      activeConnection: connection,
      activeConnId: connection.connId,
      activeConnections: { [connection.connId]: connection },
    });
    useDatabaseStore.getState().reset();
    useDatabaseStore.getState().switchToConnection(connection.connId);
    vi.mocked(api.getSessionInfoCached).mockResolvedValue({
      version: "8.0.30",
      hostname: "localhost",
      server_read_only: false,
      grant_write_capable: true,
      max_execution_time_ms: 0,
      time_zone: "SYSTEM",
      database: null,
      connection_id: 1,
    });
  });

  it.each([
    "CREATE TABLE t (id int)",
    "/* ddl */ ALTER TABLE t ADD name text",
    "DROP TABLE t",
    "RENAME TABLE t TO t2",
  ])("成功执行 %s 通知补全缓存失效", async (sql) => {
    useConnectionStore.setState({
      activeConnection: {
        ...connection,
        config: { ...connection.config, skip_dangerous_sql_confirm: true },
      },
    });
    vi.mocked(api.executeSql).mockResolvedValue({
      result_type: "execute",
      message: "成功",
      columns: [],
      rows: [],
      affected_rows: 0,
      execution_time_ms: 1,
    });
    const listener = vi.fn();
    const stop = subscribeSqlCompletionInvalidation(listener);
    const tabId = openSqlTab(sql);
    const mounted = render(<SqlEditor tabId={tabId} />);
    try {
      await execute();
      expect(listener).toHaveBeenCalledWith({
        connId: connection.connId,
        reason: "schema-change",
      });
    } finally {
      stop();
      mounted.unmount();
    }
  });

  it("每条 SELECT 都有结果标签，默认第一条并可切换表格", async () => {
    const firstResult = {
      ...selectResult("first-row", "first_column"),
      rows: [
        ["first-row"],
        ...Array.from({ length: 99 }, (_, index) => [`first-middle-${index}`]),
        ["first-last-page"],
      ],
    };
    vi.mocked(api.executeSql)
      .mockResolvedValueOnce(firstResult)
      .mockResolvedValueOnce(selectResult("second-row", "second_column"));
    const tabId = openSqlTab("SELECT 'first-row'; SELECT 'second-row';");
    const { container } = render(<SqlEditor tabId={tabId} />);

    await execute();

    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "SQL 1" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("first-row")).toBeInTheDocument();
    expect(screen.queryByText("second-row")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("tabpanel")).getByText("SELECT 'first-row'")
    ).toBeInTheDocument();
    expect(screen.queryByText("SELECT 'second-row'")).not.toBeInTheDocument();
    expect(screen.queryByText(/已成功执行/)).not.toBeInTheDocument();

    // 修改编辑器内容不会改写已经执行的 SQL 快照。
    fireEvent.change(screen.getByRole("textbox", { name: "SQL 内容" }), {
      target: { value: "SELECT 'edited';" },
    });

    const nextPage = container.querySelector<HTMLButtonElement>(
      ".ant-pagination-next button"
    );
    expect(nextPage).not.toBeNull();
    fireEvent.click(nextPage!);
    expect(await screen.findByText("first-last-page")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "SQL 2" }));

    expect(screen.getByRole("tab", { name: "SQL 2" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("second_column")).toBeInTheDocument();
    expect(screen.getByText("second-row")).toBeInTheDocument();
    expect(screen.queryByText("first-row")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("tabpanel")).getByText("SELECT 'second-row'")
    ).toBeInTheDocument();
    expect(screen.queryByText("SELECT 'first-row'")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "SQL 1" }));

    expect(screen.getByText("first-row")).toBeInTheDocument();
    expect(screen.queryByText("first-last-page")).not.toBeInTheDocument();
  });

  it("导出始终使用当前选中标签的列与行", async () => {
    vi.mocked(api.executeSql)
      .mockResolvedValueOnce(selectResult("first-export-row", "first_column"))
      .mockResolvedValueOnce(
        selectResult("second-export-row", "second_column")
      );
    const tabId = openSqlTab(
      "SELECT 'first-export-row'; SELECT 'second-export-row';"
    );
    render(<SqlEditor tabId={tabId} />);
    await execute();

    fireEvent.click(screen.getByRole("tab", { name: "SQL 2" }));
    fireEvent.click(screen.getByRole("button", { name: /导出 Excel/ }));

    await waitFor(() => {
      expect(
        excelExport.buildQueryResultWorkbookBase64
      ).toHaveBeenNthCalledWith(
        1,
        ["second_column"],
        [["second-export-row"]],
        "query_result"
      );
      expect(excelExport.saveExcelWithDialog).toHaveBeenCalledWith(
        "query_result.xlsx",
        "workbook-base64"
      );
    });

    fireEvent.click(screen.getByRole("tab", { name: "SQL 1" }));
    fireEvent.click(screen.getByRole("button", { name: /导出 Excel/ }));

    await waitFor(() => {
      expect(
        excelExport.buildQueryResultWorkbookBase64
      ).toHaveBeenNthCalledWith(
        2,
        ["first_column"],
        [["first-export-row"]],
        "query_result"
      );
    });
  });

  it("遇错停止并选中失败标签，之前的成功结果仍可查看", async () => {
    vi.mocked(api.executeSql)
      .mockResolvedValueOnce(selectResult("successful-row"))
      .mockRejectedValueOnce(new Error("测试查询失败"));
    const tabId = openSqlTab(
      "SELECT 'successful-row'; SELECT missing_column; SELECT 'not-executed';"
    );
    render(<SqlEditor tabId={tabId} />);
    await execute();

    expect(api.executeSql).toHaveBeenCalledTimes(2);
    expect(api.executeSql).toHaveBeenNthCalledWith(
      2,
      connection.connId,
      null,
      "SELECT missing_column",
      expect.any(String)
    );
    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(
      screen.queryByRole("tab", { name: "SQL 3" })
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /SQL 2/ })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText(/测试查询失败/)).toBeInTheDocument();
    expect(screen.queryByText("successful-row")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("tabpanel")).getByText("SELECT missing_column")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "SQL 1" }));

    expect(screen.getByText("successful-row")).toBeInTheDocument();
    expect(screen.queryByText(/测试查询失败/)).not.toBeInTheDocument();
    expect(screen.queryByText("SELECT missing_column")).not.toBeInTheDocument();
  });

  it("再次执行替换旧结果，并为单条语句保留 SQL 1 标签", async () => {
    vi.mocked(api.executeSql)
      .mockResolvedValueOnce(selectResult("old-first"))
      .mockResolvedValueOnce(selectResult("old-second"))
      .mockResolvedValueOnce(selectResult("new-only"));
    const tabId = openSqlTab("SELECT 'old-first'; SELECT 'old-second';");
    render(<SqlEditor tabId={tabId} />);
    await execute();
    fireEvent.click(screen.getByRole("tab", { name: "SQL 2" }));

    fireEvent.change(screen.getByRole("textbox", { name: "SQL 内容" }), {
      target: { value: "SELECT 'new-only';" },
    });
    await execute();

    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "SQL 1" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("new-only")).toBeInTheDocument();
    expect(screen.queryByText("old-first")).not.toBeInTheDocument();
    expect(screen.queryByText("old-second")).not.toBeInTheDocument();
  });

  it("卸载重挂载后保留所有结果和选中的标签", async () => {
    vi.mocked(api.executeSql)
      .mockResolvedValueOnce(selectResult("persistent-first"))
      .mockResolvedValueOnce(selectResult("persistent-second"));
    const tabId = openSqlTab(
      "SELECT 'persistent-first'; SELECT 'persistent-second';"
    );
    const first = render(<SqlEditor tabId={tabId} />);
    await execute();
    fireEvent.click(screen.getByRole("tab", { name: "SQL 2" }));

    first.unmount();
    render(<SqlEditor tabId={tabId} />);

    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "SQL 2" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("persistent-second")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "SQL 1" }));

    expect(screen.getByText("persistent-first")).toBeInTheDocument();
    expect(api.executeSql).toHaveBeenCalledTimes(2);
  });

  it("大量结果分组展示标签，仍能访问末尾结果并切回前一组", async () => {
    const statements = Array.from(
      { length: 105 },
      (_, index) => `SELECT ${index + 1}`
    );
    vi.mocked(api.executeSql).mockImplementation(
      async (_connId, _database, sql) => selectResult(`row-${sql}`)
    );
    const tabId = openSqlTab(statements.join(";"));
    render(<SqlEditor tabId={tabId} />);
    await execute();

    expect(screen.getAllByRole("tab").length).toBeLessThan(statements.length);
    expect(screen.getByText("row-SELECT 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "上一组结果" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "下一组结果" }));
    expect(screen.getByText("row-SELECT 51")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一组结果" }));
    fireEvent.click(screen.getByRole("tab", { name: "SQL 105" }));
    expect(screen.getByText("row-SELECT 105")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一组结果" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "上一组结果" }));
    expect(screen.getByText("row-SELECT 51")).toBeInTheDocument();
    expect(api.executeSql).toHaveBeenCalledTimes(105);
  });

  it("无 tabId 的嵌入模式也可切换查询结果与影响行数", async () => {
    vi.mocked(api.executeSql)
      .mockResolvedValueOnce(selectResult("embedded-row"))
      .mockResolvedValueOnce({
        result_type: "modify",
        columns: null,
        rows: null,
        affected_rows: 3,
        message: "执行成功",
        execution_time_ms: 2,
      });
    render(<SqlEditor />);
    fireEvent.change(screen.getByRole("textbox", { name: "SQL 内容" }), {
      target: {
        value:
          "SELECT 'embedded-row'; UPDATE users SET enabled = 1 WHERE id = 1;",
      },
    });
    await execute();

    expect(screen.getAllByRole("tab")).toHaveLength(2);
    expect(screen.getByRole("tab", { name: "SQL 1" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByText("embedded-row")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "SQL 2" }));

    expect(screen.getByText(/影响\s*3\s*行/)).toBeInTheDocument();
    expect(screen.queryByText("embedded-row")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /导出 Excel/ })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "SQL 1" }));

    expect(screen.getByText("embedded-row")).toBeInTheDocument();
    expect(screen.queryByText(/影响\s*3\s*行/)).not.toBeInTheDocument();
  });
});
