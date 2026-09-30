import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnMount } from "@monaco-editor/react";
import { SqlEditor } from "../components/sql/SqlEditor";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";
import * as api from "../services/tauriCommands";
import * as excelExport from "../utils/excelExport";
import {
  resultCacheController,
  createResultCacheController,
} from "../utils/resultCacheBudget";
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
    vi.mocked(api.explainSql).mockReset();
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

  afterEach(() => vi.restoreAllMocks());

  it("已释放结果保留 SQL 和摘要，禁用导出且不自动重跑", async () => {
    const tabId = openSqlTab("SELECT 'released'");
    const result = { ...selectResult("released"), rows: [] };
    useDatabaseStore.getState().setSqlTabResult(
      connection.connId,
      tabId,
      result,
      null,
      ["SELECT 'released'"],
      [
        {
          sql: "SELECT 'released'",
          result,
          error: null,
          retention: "evicted",
          retainedRowCount: 1,
        } as never,
      ]
    );
    render(<SqlEditor tabId={tabId} />);
    expect(
      await screen.findByText("结果已释放，请重新执行以查看数据")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /导出 Excel/ })).toBeDisabled();
    expect(screen.getByText("返回 1 行")).toBeInTheDocument();
    expect(api.executeSql).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "20 条合成结果执行中即可回收，保留最后结果且写入顺序不变（内嵌=%s）",
    async (embedded) => {
      const cache = createResultCacheController(300);
      for (const method of [
        "track",
        "transfer",
        "pin",
        "remove",
        "touch",
        "enforce",
      ] as const) {
        vi.spyOn(resultCacheController, method).mockImplementation(
          cache[method] as never
        );
      }
      const statements = [
        ...Array.from({ length: 20 }, (_, index) => `SELECT ${index}`),
        "UPDATE users SET enabled = 1 WHERE id = 1",
      ];
      const returned: SqlExecuteResult[] = [];
      let finishWrite!: (result: SqlExecuteResult) => void;
      vi.mocked(api.executeSql).mockImplementation(async (_cid, _db, sql) => {
        if (sql.startsWith("UPDATE"))
          return new Promise((resolve) => {
            finishWrite = resolve;
          });
        const value = selectResult(sql + "x".repeat(100));
        returned.push(value);
        return value;
      });
      const tabId = embedded ? undefined : openSqlTab(statements.join(";"));
      render(<SqlEditor tabId={tabId} />);
      if (embedded)
        fireEvent.change(screen.getByRole("textbox", { name: "SQL 内容" }), {
          target: { value: statements.join(";") },
        });
      fireEvent.click(screen.getByRole("button", { name: /执\s*行$/ }));
      await waitFor(() => expect(api.executeSql).toHaveBeenCalledTimes(21));
      expect(returned[0].rows).toEqual([]);
      expect(returned[19].rows?.length).toBe(1);
      expect(cache.enforce().retainedBytes).toBeLessThanOrEqual(300);
      await act(async () =>
        finishWrite({
          result_type: "modify",
          columns: null,
          rows: null,
          affected_rows: 1,
          message: "已修改",
          execution_time_ms: 1,
        })
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: /停\s*止$/ })
        ).not.toBeInTheDocument()
      );
      expect(
        screen.getByText("结果已释放，请重新执行以查看数据")
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /导出 Excel/ })).toBeDisabled();
      expect(
        vi.mocked(api.executeSql).mock.calls.map((call) => call[2])
      ).toEqual(statements);
      fireEvent.click(screen.getByRole("tab", { name: "SQL 20" }));
      expect(
        screen.getByText("SELECT 19" + "x".repeat(100))
      ).toBeInTheDocument();
      expect(api.executeSql).toHaveBeenCalledTimes(21);
    }
  );

  it.each(["close", "disconnect", "embedded-unmount"])(
    "%s 立即清理进行中的结果，迟到回复不复活且不继续下一条",
    async (reason) => {
      const cache = createResultCacheController(1000);
      for (const method of [
        "track",
        "transfer",
        "pin",
        "remove",
        "touch",
        "enforce",
      ] as const) {
        vi.spyOn(resultCacheController, method).mockImplementation(
          cache[method] as never
        );
      }
      const first = selectResult("in-flight-owned");
      let finish!: (value: SqlExecuteResult) => void;
      vi.mocked(api.executeSql)
        .mockResolvedValueOnce(first)
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            })
        );
      const embedded = reason === "embedded-unmount";
      const sql = "SELECT 1; SELECT 2; UPDATE users SET enabled=1 WHERE id=1";
      const tabId = embedded ? undefined : openSqlTab(sql);
      const mounted = render(<SqlEditor tabId={tabId} />);
      if (embedded)
        fireEvent.change(screen.getByRole("textbox", { name: "SQL 内容" }), {
          target: { value: sql },
        });
      fireEvent.click(screen.getByRole("button", { name: /执\s*行$/ }));
      await waitFor(() => expect(api.executeSql).toHaveBeenCalledTimes(2));
      expect(cache.enforce().retainedBytes).toBeGreaterThan(0);
      act(() => {
        if (reason === "close")
          useDatabaseStore.getState().closeTab(connection.connId, 0);
        else if (reason === "disconnect")
          useDatabaseStore.getState().removeConnectionState(connection.connId);
        else mounted.unmount();
      });
      expect(cache.enforce().retainedBytes).toBe(0);
      expect(first.rows).toEqual([]);
      await act(async () => finish(selectResult("late")));
      expect(api.executeSql).toHaveBeenCalledTimes(2);
      expect(cache.enforce().retainedBytes).toBe(0);
      expect(
        useDatabaseStore.getState().sqlTabResults[tabId ?? "missing"]
      ).toBeUndefined();
    }
  );

  it("内嵌 EXPLAIN 结果同样登记预算并在卸载时释放", async () => {
    const cache = createResultCacheController(1000);
    for (const method of [
      "track",
      "transfer",
      "pin",
      "remove",
      "touch",
      "enforce",
    ] as const) {
      vi.spyOn(resultCacheController, method).mockImplementation(
        cache[method] as never
      );
    }
    const result = selectResult("explain-plan");
    vi.mocked(api.explainSql).mockResolvedValueOnce(result);
    const mounted = render(<SqlEditor />);
    fireEvent.change(screen.getByRole("textbox", { name: "SQL 内容" }), {
      target: { value: "SELECT 1" },
    });
    fireEvent.click(
      screen.getByRole("img", { name: "file-search" }).closest("button")!
    );
    expect(await screen.findByText("explain-plan")).toBeInTheDocument();
    expect(cache.enforce().retainedBytes).toBeGreaterThan(0);
    mounted.unmount();
    expect(cache.enforce().retainedBytes).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it.each([
    [false, "success", false],
    [true, "success", false],
    [false, "error", false],
    [true, "error", false],
    [false, "success", true],
    [true, "success", true],
    [false, "error", true],
    [true, "error", true],
  ] as const)(
    "EXPLAIN 迟到不覆盖快捷键新执行（内嵌=%s，旧回复=%s，新脚本已完成=%s）",
    async (embedded, outcome, completed) => {
      const cache = createResultCacheController(1000);
      for (const method of [
        "track",
        "transfer",
        "pin",
        "remove",
        "touch",
        "enforce",
      ] as const) {
        vi.spyOn(resultCacheController, method).mockImplementation(
          cache[method] as never
        );
      }
      let finishExplain!: (value: SqlExecuteResult) => void;
      let failExplain!: (error: Error) => void;
      vi.mocked(api.explainSql).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finishExplain = resolve;
            failExplain = reject;
          })
      );
      let finishSecond!: (value: SqlExecuteResult) => void;
      vi.mocked(api.executeSql)
        .mockResolvedValueOnce(selectResult("new-first"))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finishSecond = resolve;
            })
        )
        .mockResolvedValueOnce(selectResult("new-third"));
      const tabId = embedded ? undefined : openSqlTab("SELECT 'old'");
      const mounted = render(<SqlEditor tabId={tabId} />);
      const textbox = screen.getByRole("textbox", { name: "SQL 内容" });
      if (embedded)
        fireEvent.change(textbox, { target: { value: "SELECT 'old'" } });
      fireEvent.click(
        screen.getByRole("img", { name: "file-search" }).closest("button")!
      );
      await waitFor(() => expect(api.explainSql).toHaveBeenCalledTimes(1));
      fireEvent.change(textbox, {
        target: {
          value: "SELECT 'new-first'; SELECT 'new-second'; SELECT 'new-third'",
        },
      });
      fireEvent.keyDown(textbox, { key: "Enter", ctrlKey: true });
      await waitFor(() => expect(api.executeSql).toHaveBeenCalledTimes(2));
      if (completed) {
        await act(async () => finishSecond(selectResult("new-second")));
        await waitFor(() =>
          expect(screen.getByText("new-first")).toBeInTheDocument()
        );
      }
      await act(async () => {
        if (outcome === "success") finishExplain(selectResult("old-plan"));
        else failExplain(new Error("旧 EXPLAIN 失败"));
      });
      if (!completed) {
        expect(
          screen.getByRole("button", { name: /停\s*止$/ })
        ).toBeInTheDocument();
        await act(async () => finishSecond(selectResult("new-second")));
      }
      await waitFor(() =>
        expect(screen.getByText("new-first")).toBeInTheDocument()
      );
      expect(screen.getAllByRole("tab")).toHaveLength(3);
      expect(screen.queryByText("old-plan")).not.toBeInTheDocument();
      expect(screen.queryByText(/旧 EXPLAIN 失败/)).not.toBeInTheDocument();
      expect(
        vi.mocked(api.executeSql).mock.calls.map((call) => call[2])
      ).toEqual([
        "SELECT 'new-first'",
        "SELECT 'new-second'",
        "SELECT 'new-third'",
      ]);
      mounted.unmount();
      if (!embedded)
        act(() => useDatabaseStore.getState().closeTab(connection.connId, 0));
      expect(cache.enforce().retainedBytes).toBe(0);
    }
  );

  it("EXPLAIN 前端执行标识不会作为后端取消令牌", async () => {
    let finish!: (value: SqlExecuteResult) => void;
    vi.mocked(api.explainSql).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const tabId = openSqlTab("SELECT 'plan'");
    const mounted = render(<SqlEditor tabId={tabId} />);
    fireEvent.click(
      screen.getByRole("img", { name: "file-search" }).closest("button")!
    );
    await waitFor(() => expect(api.explainSql).toHaveBeenCalledTimes(1));
    mounted.unmount();
    render(<SqlEditor tabId={tabId} />);
    const stop = await screen.findByRole("button", { name: /停\s*止$/ });
    expect(stop).toBeDisabled();
    fireEvent.click(stop);
    expect(api.cancelQuery).not.toHaveBeenCalled();
    await act(async () => finish(selectResult("plan")));
    expect(await screen.findByText("plan")).toBeInTheDocument();
  });

  it.each([false, true])(
    "EXPLAIN 关闭或卸载后迟到成功不登记结果（内嵌=%s）",
    async (embedded) => {
      const cache = createResultCacheController(1000);
      for (const method of [
        "track",
        "transfer",
        "pin",
        "remove",
        "touch",
        "enforce",
      ] as const) {
        vi.spyOn(resultCacheController, method).mockImplementation(
          cache[method] as never
        );
      }
      let finish!: (value: SqlExecuteResult) => void;
      vi.mocked(api.explainSql).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const tabId = embedded ? undefined : openSqlTab("SELECT 'old'");
      const mounted = render(<SqlEditor tabId={tabId} />);
      if (embedded)
        fireEvent.change(screen.getByRole("textbox", { name: "SQL 内容" }), {
          target: { value: "SELECT 'old'" },
        });
      fireEvent.click(
        screen.getByRole("img", { name: "file-search" }).closest("button")!
      );
      await waitFor(() => expect(api.explainSql).toHaveBeenCalledTimes(1));
      if (!embedded)
        act(() => useDatabaseStore.getState().closeTab(connection.connId, 0));
      mounted.unmount();
      await act(async () => finish(selectResult("late-plan")));
      expect(cache.enforce().retainedBytes).toBe(0);
      expect(
        useDatabaseStore.getState().sqlTabResults[tabId ?? "missing"]
      ).toBeUndefined();
    }
  );

  it.each(["success", "cancel", "error"])(
    "SQL 导出租约在 %s 后释放，切换结果时仍保护导出行",
    async (outcome) => {
      const cache = createResultCacheController(1000);
      for (const method of [
        "track",
        "transfer",
        "pin",
        "remove",
        "touch",
        "enforce",
      ] as const) {
        vi.spyOn(resultCacheController, method).mockImplementation(
          cache[method] as never
        );
      }
      vi.mocked(api.executeSql)
        .mockResolvedValueOnce(selectResult("export-retained"))
        .mockResolvedValueOnce(selectResult("other-row"));
      let finish!: (value: boolean) => void;
      let fail!: (error: Error) => void;
      vi.mocked(excelExport.saveExcelWithDialog).mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          })
      );
      const tabId = openSqlTab("SELECT 1; SELECT 2");
      render(<SqlEditor tabId={tabId} />);
      await execute();
      fireEvent.click(screen.getByRole("button", { name: /导出 Excel/ }));
      await waitFor(() =>
        expect(excelExport.saveExcelWithDialog).toHaveBeenCalled()
      );
      fireEvent.click(screen.getByRole("tab", { name: "SQL 2" }));
      const release = cache.pin("pressure");
      await act(async () =>
        cache.track({ key: "pressure", estimatedBytes: 1000, evict: () => {} })
      );
      expect(
        useDatabaseStore.getState().sqlTabResults[tabId].statementResults![0]
          .result?.rows
      ).toEqual([["export-retained"]]);
      await act(async () => {
        if (outcome === "error") fail(new Error("save failed"));
        else finish(outcome === "success");
      });
      await waitFor(() =>
        expect(
          useDatabaseStore.getState().sqlTabResults[tabId].statementResults![0]
            .retention
        ).toBe("evicted")
      );
      release();
      cache.remove("pressure");
    }
  );

  it.each(["modify", "select", "failure"])(
    "执行结果 %s 只在成功修改时失效",
    async (outcome) => {
      useConnectionStore.setState({
        activeConnection: {
          ...connection,
          config: { ...connection.config, skip_dangerous_sql_confirm: true },
        },
      });
      if (outcome === "failure")
        vi.mocked(api.executeSql).mockRejectedValue(new Error("失败"));
      else
        vi.mocked(api.executeSql).mockResolvedValue({
          ...selectResult("row", "value"),
          result_type: outcome,
        });
      const listener = vi.fn();
      const stop = subscribeSqlCompletionInvalidation(listener);
      const tabId = openSqlTab("UPDATE t SET value = 1");
      const mounted = render(<SqlEditor tabId={tabId} />);
      try {
        await execute();
        if (outcome === "modify")
          expect(listener).toHaveBeenCalledWith({
            connId: connection.connId,
            reason: "schema-change",
          });
        else expect(listener).not.toHaveBeenCalled();
      } finally {
        stop();
        mounted.unmount();
      }
    }
  );

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
