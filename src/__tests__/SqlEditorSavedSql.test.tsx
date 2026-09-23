import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnMount } from "@monaco-editor/react";
import { SqlEditor } from "../components/sql/SqlEditor";
import { SavedSqlDropdown } from "../components/database/SavedSqlDropdown";
import { useConnectionStore } from "../stores/connectionStore";
import { emptyConnState, useDatabaseStore } from "../stores/databaseStore";
import { useSavedSqlStore } from "../stores/savedSqlStore";
import * as api from "../services/tauriCommands";

const editorMount = vi.hoisted(() => ({
  deferred: false,
  pending: undefined as (() => void) | undefined,
}));

vi.mock("../services/tauriCommands");
vi.mock("../utils/monacoSetup", () => ({ setupMonacoEditor: () => undefined }));
vi.mock("../utils/sqlCompletionSchema", () => ({
  loadSqlCompletionSchema: vi.fn().mockResolvedValue({
    databases: [],
    tables: [],
    columns: [],
  }),
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
      const changeRef = React.useRef(onChange);
      changeRef.current = onChange;
      React.useEffect(() => {
        const mount = () =>
          onMount(
            {
              getValue: () => textarea.current?.value ?? "",
              setValue: (sql: string) => {
                if (textarea.current) textarea.current.value = sql;
                changeRef.current?.(sql);
              },
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
        if (editorMount.deferred) editorMount.pending = mount;
        else mount();
        return () => {
          editorMount.pending = undefined;
        };
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

const postgresConnection = {
  connId: "pg-session",
  config: {
    id: "pg-profile",
    name: "PostgreSQL 应用库",
    host: "localhost",
    port: 5432,
    username: "postgres",
    database: "app_database",
    database_type: "postgres" as const,
  },
};

function SidebarAndActiveSqlEditor() {
  const activeTab = useDatabaseStore(
    (state) => state.openTabs[state.activeTabIndex]
  );
  const viewMode = useDatabaseStore((state) => state.viewMode);
  return (
    <>
      <SavedSqlDropdown />
      {viewMode === "tab" && activeTab?.type === "sql" && (
        <SqlEditor key={activeTab.id} tabId={activeTab.id} />
      )}
    </>
  );
}

describe("PostgreSQL 已保存 SQL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorMount.deferred = false;
    editorMount.pending = undefined;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => undefined,
        removeListener: () => undefined,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
    useConnectionStore.setState({
      activeConnection: postgresConnection,
      activeConnId: postgresConnection.connId,
      activeConnections: { [postgresConnection.connId]: postgresConnection },
    });
    useDatabaseStore.getState().reset();
    useDatabaseStore.getState().switchToConnection(postgresConnection.connId);
    const state =
      useDatabaseStore.getState().connectionStates[postgresConnection.connId] ??
      emptyConnState();
    useDatabaseStore.setState({
      selectedDatabase: "reporting",
      databases: ["public", "reporting"],
      connectionStates: {
        [postgresConnection.connId]: {
          ...state,
          selectedDatabase: "reporting",
          databases: ["public", "reporting"],
        },
      },
    });
    useSavedSqlStore.setState({ list: [] });
    vi.mocked(api.listTables).mockResolvedValue([]);
    vi.mocked(api.getSqlCompletionForeignKeys).mockResolvedValue({
      status: "ready",
      foreignKeys: [],
    });
    vi.mocked(api.getSessionInfoCached).mockResolvedValue({
      version: "16.0",
      hostname: "localhost",
      server_read_only: false,
      grant_write_capable: true,
      max_execution_time_ms: 0,
      time_zone: "UTC",
      database: "reporting",
      connection_id: 1,
    });
    vi.mocked(api.executeSql).mockResolvedValue({
      result_type: "select",
      columns: ["name"],
      rows: [["当前 schema 中的用户"]],
      affected_rows: null,
      message: "返回 1 行",
      execution_time_ms: 1,
    });
  });

  it.each([
    ["postgres", "schema"],
    ["sqlserver", "schema"],
    ["mysql", "数据库"],
    ["sqlite", "数据库"],
    ["clickhouse", "数据库"],
  ] as const)("%s 上下文选择器使用 %s 名称", async (databaseType, label) => {
    useConnectionStore.setState({
      activeConnection: {
        ...postgresConnection,
        config: { ...postgresConnection.config, database_type: databaseType },
      },
    });
    useDatabaseStore.setState({ selectedDatabase: null });
    render(<SqlEditor />);
    expect(await screen.findByText(`${label}:`)).toBeInTheDocument();
    expect(screen.getByText(`选择${label}`)).toBeInTheDocument();
  });

  it("保存 SQL 后可从当前连接的内嵌列表载入并在当前 schema 运行", async () => {
    render(<SqlEditor />);
    const editor = screen.getByRole("textbox", { name: "SQL 内容" });
    fireEvent.change(editor, { target: { value: "SELECT name FROM users" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    fireEvent.change(screen.getByPlaceholderText("例如：查询用户列表"), {
      target: { value: "当前 schema 用户" },
    });
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: /保\s*存/,
      })
    );
    expect(useSavedSqlStore.getState().list).toEqual([
      expect.objectContaining({
        name: "当前 schema 用户",
        sql: "SELECT name FROM users",
        connectionKey: "profile:pg-profile",
      }),
    ]);
    fireEvent.change(editor, { target: { value: "SELECT '草稿'" } });
    fireEvent.click(screen.getByRole("button", { name: /已保存的 SQL/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "加载并运行已保存的 SQL" })
    );

    expect(editor).toHaveValue("SELECT name FROM users");
    expect(await screen.findByText("当前 schema 中的用户")).toBeInTheDocument();
    expect(api.executeSql).toHaveBeenCalledWith(
      "pg-session",
      "reporting",
      "SELECT name FROM users",
      expect.any(String)
    );
  });

  it("侧边栏载入并运行在新 SQL 标签中执行一次，重挂载后不重复执行", async () => {
    editorMount.deferred = true;
    useSavedSqlStore
      .getState()
      .add("用户查询", "SELECT name FROM users", postgresConnection.config);
    const first = render(<SidebarAndActiveSqlEditor />);
    fireEvent.click(screen.getByRole("button", { name: /已保存的 SQL/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "加载并运行已保存的 SQL" })
    );

    expect(
      await screen.findByRole("textbox", { name: "SQL 内容" })
    ).toHaveValue("SELECT name FROM users");
    expect(api.executeSql).not.toHaveBeenCalled();
    act(() => editorMount.pending?.());
    expect(await screen.findByText("当前 schema 中的用户")).toBeInTheDocument();
    expect(api.executeSql).toHaveBeenCalledWith(
      "pg-session",
      "reporting",
      "SELECT name FROM users",
      expect.any(String)
    );
    first.unmount();
    editorMount.deferred = false;
    render(<SidebarAndActiveSqlEditor />);
    await waitFor(() =>
      expect(screen.getByText("当前 schema 中的用户")).toBeInTheDocument()
    );
    expect(api.executeSql).toHaveBeenCalledTimes(1);
  });

  it("正在执行时保留新的运行请求，当前执行结束后再处理", async () => {
    let finishFirst!: (
      result: Awaited<ReturnType<typeof api.executeSql>>
    ) => void;
    vi.mocked(api.executeSql).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve;
        })
    );
    useDatabaseStore
      .getState()
      .openSqlTab("pg-session", "SELECT name FROM users");
    const state = useDatabaseStore.getState();
    const tab = state.openTabs[state.activeTabIndex];
    if (tab.type !== "sql") throw new Error("未创建 SQL 标签");
    state.requestSqlTabExecute("pg-session", tab.id);
    render(<SqlEditor tabId={tab.id} />);
    await waitFor(() => expect(api.executeSql).toHaveBeenCalledTimes(1));

    act(() =>
      useDatabaseStore.getState().requestSqlTabExecute("pg-session", tab.id)
    );
    expect(api.executeSql).toHaveBeenCalledTimes(1);
    await act(async () =>
      finishFirst({
        result_type: "select",
        columns: ["name"],
        rows: [["第一次结果"]],
        affected_rows: null,
        message: "返回 1 行",
        execution_time_ms: 1,
      })
    );

    expect(await screen.findByText("当前 schema 中的用户")).toBeInTheDocument();
    expect(api.executeSql).toHaveBeenCalledTimes(2);
  });

  it("载入并运行等待编辑器期间切换 schema，返回后仍在请求时的 schema 执行", async () => {
    editorMount.deferred = true;
    useSavedSqlStore
      .getState()
      .add("用户查询", "SELECT name FROM users", postgresConnection.config);
    render(<SidebarAndActiveSqlEditor />);
    fireEvent.click(screen.getByRole("button", { name: /已保存的 SQL/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "加载并运行已保存的 SQL" })
    );
    expect(api.executeSql).not.toHaveBeenCalled();

    await act(async () =>
      useDatabaseStore.getState().selectDatabase("pg-session", "public")
    );
    expect(
      screen.queryByRole("textbox", { name: "SQL 内容" })
    ).not.toBeInTheDocument();
    act(() => useDatabaseStore.getState().switchTab("pg-session", 0));
    act(() => editorMount.pending?.());

    expect(await screen.findByText("当前 schema 中的用户")).toBeInTheDocument();
    expect(api.executeSql).toHaveBeenCalledWith(
      "pg-session",
      "reporting",
      "SELECT name FROM users",
      expect.any(String)
    );
    expect(screen.getByText("reporting")).toBeInTheDocument();
  });
});
