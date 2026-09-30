import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { OnMount } from "@monaco-editor/react";
import { message } from "antd";
import { SqlEditor } from "../components/sql/SqlEditor";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";
import type { SqlExecuteResult } from "../types";

// bug 回归：运行 SQL 时切换标签（SqlEditor 卸载重挂载），执行中状态与「停止」能力不应丢失

vi.mock("../services/tauriCommands", () => ({
  listDatabases: vi.fn(),
  listTables: vi.fn(),
  getTableStructure: vi.fn(),
  getDatabaseInfo: vi.fn(),
  alterDatabaseCharset: vi.fn(),
  createDatabase: vi.fn(),
  dropDatabase: vi.fn(),
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
  executeSql: vi.fn(),
  explainSql: vi.fn(),
  cancelQuery: vi.fn(),
  getSessionInfoCached: vi.fn().mockResolvedValue({
    version: "8.0.30",
    hostname: "localhost",
    server_read_only: false,
    grant_write_capable: true,
    max_execution_time_ms: 0,
    time_zone: "SYSTEM",
    database: null,
    connection_id: 1,
  }),
}));

vi.mock("../utils/sqlCompletionSchema", () => ({
  loadSqlCompletionSchema: vi
    .fn()
    .mockResolvedValue({ databases: [], tables: [], columns: [] }),
}));

vi.mock("../utils/monacoSetup", () => ({
  setupMonacoEditor: () => undefined,
}));

vi.mock("@monaco-editor/react", async () => {
  const React = await import("react");
  const monaco = await import("monaco-editor");
  return {
    default: function TestEditor({
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
      const executeAction = React.useRef<(() => void) | null>(null);
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
            addAction: (action: { id: string; run: () => void }) => {
              if (action.id === "execute-sql")
                executeAction.current = action.run;
              return { dispose: () => undefined };
            },
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
        onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
          if (event.ctrlKey && event.key === "Enter") executeAction.current?.();
        },
      });
    },
  };
});

import * as api from "../services/tauriCommands";

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

function openSqlTabAndGetId(): string {
  useDatabaseStore.getState().openSqlTab("conn-1", "SELECT SLEEP(10)");
  const tab = useDatabaseStore
    .getState()
    .openTabs.find((t) => t.type === "sql");
  return tab?.type === "sql" ? tab.id : "";
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: string) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function queryResult(value: string): SqlExecuteResult {
  return {
    result_type: "select",
    columns: ["value"],
    rows: [[value]],
    affected_rows: null,
    message: "返回 1 行",
    execution_time_ms: 1,
  };
}

function executeWithShortcut(sql?: string) {
  const editor = screen.getByRole("textbox", { name: "SQL 内容" });
  if (sql) fireEvent.change(editor, { target: { value: sql } });
  fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
}

describe("SqlEditor 执行中状态跨卸载保留", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.executeSql).mockReset();
    vi.mocked(api.cancelQuery).mockReset();
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
      activeConnections: { "conn-1": mockActiveConnection },
      activeConnId: "conn-1",
      activeConnection: mockActiveConnection,
    });
    useDatabaseStore.getState().reset();
    useDatabaseStore.getState().switchToConnection("conn-1");
  });

  afterEach(() => {
    act(() => message.destroy());
    vi.restoreAllMocks();
  });

  it("store 中登记执行中状态时，新挂载的编辑器应显示「停止」按钮", () => {
    const tabId = openSqlTabAndGetId();
    useDatabaseStore
      .getState()
      .setSqlTabExecution("conn-1", tabId, { executionId: "exec-1" });

    // 模拟切走再切回：全新挂载的 SqlEditor 实例
    render(<SqlEditor tabId={tabId} />);

    expect(
      screen.getByRole("button", { name: /停 止|停止/ })
    ).toBeInTheDocument();
  });

  it("卸载重挂载后仍处于执行中，并能用 store 中的令牌停止查询", async () => {
    const tabId = openSqlTabAndGetId();
    useDatabaseStore
      .getState()
      .setSqlTabExecution("conn-1", tabId, { executionId: "exec-42" });
    vi.mocked(api.cancelQuery).mockResolvedValue(true);

    const first = render(<SqlEditor tabId={tabId} />);
    expect(
      screen.getByRole("button", { name: /停 止|停止/ })
    ).toBeInTheDocument();
    first.unmount();

    // 重挂载（相当于切回 SQL 标签）
    render(<SqlEditor tabId={tabId} />);
    const stopBtn = screen.getByRole("button", { name: /停 止|停止/ });
    expect(stopBtn).toBeInTheDocument();

    fireEvent.click(stopBtn);
    await waitFor(() => {
      expect(api.cancelQuery).toHaveBeenCalledWith("conn-1", "exec-42");
    });
  });

  it("执行结束（状态清除）后重挂载不再显示「停止」按钮", () => {
    const tabId = openSqlTabAndGetId();
    useDatabaseStore
      .getState()
      .setSqlTabExecution("conn-1", tabId, { executionId: "exec-1" });
    useDatabaseStore.getState().setSqlTabExecution("conn-1", tabId, null);

    render(<SqlEditor tabId={tabId} />);

    expect(
      screen.queryByRole("button", { name: /停 止|停止/ })
    ).not.toBeInTheDocument();
  });

  it("取消确认只显示已请求取消，执行返回前保留停止能力与 SQL 草稿", async () => {
    const execution = deferred<SqlExecuteResult>();
    vi.mocked(api.executeSql).mockReturnValue(execution.promise);
    vi.mocked(api.cancelQuery).mockResolvedValue(true);
    const tabId = openSqlTabAndGetId();
    render(<SqlEditor tabId={tabId} />);
    executeWithShortcut();
    const executionId =
      useDatabaseStore.getState().sqlTabExecutions[tabId]?.executionId;

    fireEvent.click(screen.getByRole("button", { name: /停\s*止$/ }));

    expect(await screen.findByText("已请求取消当前查询")).toBeInTheDocument();
    expect(api.cancelQuery).toHaveBeenCalledWith("conn-1", executionId);
    expect(
      screen.getByRole("button", { name: /停\s*止$/ })
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "SQL 内容" })).toHaveValue(
      "SELECT SLEEP(10)"
    );

    await act(async () => execution.reject("查询已取消"));

    expect(screen.getByRole("alert")).toHaveTextContent("查询已取消");
    expect(
      screen.queryByRole("button", { name: /停\s*止$/ })
    ).not.toBeInTheDocument();
    expect(
      useDatabaseStore.getState().sqlTabResults[tabId].executedSqlList
    ).toEqual([]);
  });

  it("取消失败保留未确认终止与刷新提示，执行错误保留原始错误和清理上下文", async () => {
    const execution = deferred<SqlExecuteResult>();
    const cancelError = "取消请求超时；查询未确认终止，请刷新确认";
    const executionError = `原始执行错误；取消清理失败: ${cancelError}`;
    vi.mocked(api.executeSql).mockReturnValue(execution.promise);
    vi.mocked(api.cancelQuery).mockRejectedValue(cancelError);
    const tabId = openSqlTabAndGetId();
    render(<SqlEditor tabId={tabId} />);
    executeWithShortcut();

    fireEvent.click(screen.getByRole("button", { name: /停\s*止$/ }));

    expect(
      await screen.findByText(`取消查询失败: ${cancelError}`)
    ).toBeInTheDocument();
    expect(screen.queryByText("已请求取消当前查询")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /停\s*止$/ })
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "SQL 内容" })).toHaveValue(
      "SELECT SLEEP(10)"
    );

    await act(async () => execution.reject(executionError));

    expect(screen.getByRole("alert")).toHaveTextContent(executionError);
    expect(
      screen.queryByRole("button", { name: /停\s*止$/ })
    ).not.toBeInTheDocument();
    expect(useDatabaseStore.getState().sqlTabResults[tabId].error).toBe(
      executionError
    );
  });

  it("已结束查询的取消回复不能显示取消成功", async () => {
    const tabId = openSqlTabAndGetId();
    useDatabaseStore
      .getState()
      .setSqlTabExecution("conn-1", tabId, { executionId: "exec-finished" });
    vi.mocked(api.cancelQuery).mockResolvedValue(false);
    render(<SqlEditor tabId={tabId} />);

    fireEvent.click(screen.getByRole("button", { name: /停\s*止$/ }));

    expect(
      await screen.findByText("查询可能已结束，无需取消")
    ).toBeInTheDocument();
    expect(screen.queryByText("已请求取消当前查询")).not.toBeInTheDocument();
  });

  it.each(["成功", "失败"])(
    "旧执行%s返回后不能清除新执行或覆盖新结果与草稿",
    async (outcome) => {
      const oldExecution = deferred<SqlExecuteResult>();
      const newExecution = deferred<SqlExecuteResult>();
      vi.mocked(api.executeSql)
        .mockReturnValueOnce(oldExecution.promise)
        .mockReturnValueOnce(newExecution.promise);
      const tabId = openSqlTabAndGetId();
      render(<SqlEditor tabId={tabId} />);
      // 同一毫秒触发两次执行仍须有独立身份。
      vi.spyOn(Date, "now").mockReturnValue(1000);
      executeWithShortcut();
      executeWithShortcut("SELECT '新结果'");
      const newExecutionId =
        useDatabaseStore.getState().sqlTabExecutions[tabId]?.executionId;

      await act(async () => {
        if (outcome === "成功") oldExecution.resolve(queryResult("旧结果"));
        else oldExecution.reject("旧执行错误");
      });

      expect(
        screen.getByRole("button", { name: /停\s*止$/ })
      ).toBeInTheDocument();
      expect(
        useDatabaseStore.getState().sqlTabExecutions[tabId]?.executionId
      ).toBe(newExecutionId);
      expect(screen.queryByText("旧结果")).not.toBeInTheDocument();
      expect(screen.queryByText("旧执行错误")).not.toBeInTheDocument();
      await act(async () => newExecution.resolve(queryResult("新结果")));
      expect(screen.getByText("新结果")).toBeInTheDocument();
      expect(screen.getByRole("textbox", { name: "SQL 内容" })).toHaveValue(
        "SELECT '新结果'"
      );
      expect(
        useDatabaseStore.getState().sqlTabResults[tabId].executedSqlList
      ).toEqual(["SELECT '新结果'"]);
    }
  );

  it.each(["成功", "失败"])(
    "新查询执行期间，旧取消请求%s回复不能描述或改变新查询",
    async (outcome) => {
      const oldExecution = deferred<SqlExecuteResult>();
      const newExecution = deferred<SqlExecuteResult>();
      const cancellation = deferred<boolean>();
      vi.mocked(api.executeSql)
        .mockReturnValueOnce(oldExecution.promise)
        .mockReturnValueOnce(newExecution.promise);
      vi.mocked(api.cancelQuery).mockReturnValue(cancellation.promise);
      const tabId = openSqlTabAndGetId();
      render(<SqlEditor tabId={tabId} />);
      executeWithShortcut();
      fireEvent.click(screen.getByRole("button", { name: /停\s*止$/ }));
      await act(async () =>
        oldExecution.resolve(queryResult("旧查询自然完成"))
      );
      executeWithShortcut("SELECT '当前结果'");
      const newExecutionId =
        useDatabaseStore.getState().sqlTabExecutions[tabId]?.executionId;

      await act(async () => {
        if (outcome === "成功") cancellation.resolve(true);
        else cancellation.reject("旧取消请求超时");
      });

      expect(screen.queryByText("已请求取消当前查询")).not.toBeInTheDocument();
      expect(screen.queryByText(/旧取消请求超时/)).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: /停\s*止$/ })
      ).toBeInTheDocument();
      expect(
        useDatabaseStore.getState().sqlTabExecutions[tabId]?.executionId
      ).toBe(newExecutionId);
      await act(async () => newExecution.resolve(queryResult("当前结果")));
      expect(screen.getByText("当前结果")).toBeInTheDocument();
    }
  );
});
