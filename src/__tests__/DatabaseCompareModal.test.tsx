import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { message } from "antd";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseCompareModal } from "../components/databaseCompare/DatabaseCompareModal";
import * as api from "../services/tauriCommands";
import { useConnectionStore } from "../stores/connectionStore";
import type {
  ConnectionConfig,
  DatabaseCompareResult,
  DatabaseSyncExecutionResult,
  DatabaseSyncPreview,
} from "../types";
import { saveDatabaseCompareWorkbook } from "../utils/databaseCompareExport";

vi.mock("../services/tauriCommands", () => ({
  listCompareDatabases: vi.fn(),
  compareDatabases: vi.fn(),
  previewDatabaseSync: vi.fn(),
  executeDatabaseSync: vi.fn(),
}));

vi.mock("../utils/databaseCompareExport", () => ({
  saveDatabaseCompareWorkbook: vi.fn(),
}));

const SAVED_CONNECTIONS: ConnectionConfig[] = [
  {
    id: "mysql-a",
    name: "MySQL A",
    database_type: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
  },
  {
    id: "mysql-b",
    name: "MySQL B",
    database_type: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
  },
  {
    id: "postgres-c",
    name: "PostgreSQL C",
    database_type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
  },
];

function sampleCompareResult(): DatabaseCompareResult {
  return {
    database_type: "mysql",
    source: {
      connection_id: "mysql-a",
      connection_name: "MySQL A",
      database: "app",
    },
    target: {
      connection_id: "mysql-b",
      connection_name: "MySQL B",
      database: "audit",
    },
    compared_at: "2026-07-14T08:00:00Z",
    summary: {
      source_only_tables: 0,
      target_only_tables: 0,
      changed_tables: 1,
      different_columns: 1,
    },
    tables: [
      {
        name: "users",
        status: "changed",
        columns: [
          {
            name: "email",
            status: "changed",
            changed_fields: ["nullable"],
            source: {
              ordinal_position: 2,
              column_type: "varchar(255)",
              nullable: false,
              default_value: null,
              primary_key: false,
              extra: "",
              comment: "",
            },
            target: {
              ordinal_position: 2,
              column_type: "varchar(255)",
              nullable: true,
              default_value: null,
              primary_key: false,
              extra: "",
              comment: "",
            },
          },
        ],
      },
    ],
  };
}

function sampleAllStatusesResult(): DatabaseCompareResult {
  const result = sampleCompareResult();
  return {
    ...result,
    summary: {
      source_only_tables: 1,
      target_only_tables: 1,
      changed_tables: 1,
      different_columns: 1,
    },
    tables: [
      { name: "audit_logs", status: "source_only", columns: [] },
      { name: "events", status: "target_only", columns: [] },
      ...result.tables,
    ],
  };
}

function sampleSyncPreview(): DatabaseSyncPreview {
  return {
    plan_fingerprint: "preview-fingerprint",
    summary: {
      selected_tables: 1,
      executable_operations: 1,
      high_risk_operations: 1,
      destructive_operations: 0,
      skipped_items: 0,
      blockers: 0,
    },
    operations: [
      {
        id: "users:alter_column:0",
        table_name: "users",
        kind: "alter_column",
        summary: "修改字段 email",
        risk: "high",
        sql: ["ALTER TABLE `users` MODIFY `email` varchar(255) NOT NULL"],
      },
    ],
    skipped_items: [],
    blockers: [],
    can_execute: true,
  };
}

function sampleNoDiffResult(): DatabaseCompareResult {
  return {
    ...sampleCompareResult(),
    compared_at: "2026-07-18T08:00:00Z",
    summary: {
      source_only_tables: 0,
      target_only_tables: 0,
      changed_tables: 0,
      different_columns: 0,
    },
    tables: [],
  };
}

function sampleSucceededExecution(): DatabaseSyncExecutionResult {
  return {
    status: "succeeded",
    completed_statements: [
      { operation_id: "users:alter_column:0", statement_index: 0 },
    ],
    failed: null,
    pending_operation_ids: [],
    cleanup_errors: [],
    latest_compare_result: sampleNoDiffResult(),
  };
}

function samplePartialExecution(): DatabaseSyncExecutionResult {
  return {
    status: "partially_succeeded",
    completed_statements: [
      { operation_id: "users:alter_column:0", statement_index: 0 },
    ],
    failed: {
      operation_id: "users:alter_column:0",
      statement_index: 1,
      error: "目标字段仍被视图引用",
    },
    pending_operation_ids: ["users:alter_column:0"],
    cleanup_errors: ["目标端临时连接清理失败"],
    latest_compare_result: null,
  };
}

function sampleFailedExecution(): DatabaseSyncExecutionResult {
  return {
    status: "failed",
    completed_statements: [],
    failed: {
      operation_id: "users:alter_column:0",
      statement_index: 0,
      error: "目标端拒绝执行 DDL",
    },
    pending_operation_ids: ["users:alter_column:0"],
    cleanup_errors: [],
    latest_compare_result: null,
  };
}

async function selectAntOption(label: string, option: string): Promise<void> {
  const combobox = screen.getByLabelText(label);
  fireEvent.mouseDown(combobox);
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

async function configureEndpoints(): Promise<void> {
  await selectAntOption("源连接", "MySQL A");
  await waitFor(() => {
    expect(api.listCompareDatabases).toHaveBeenCalledWith("mysql-a");
  });
  await selectAntOption("源数据库/schema", "app");
  await selectAntOption("目标连接", "MySQL B");
  await waitFor(() => {
    expect(api.listCompareDatabases).toHaveBeenCalledWith("mysql-b");
  });
  await selectAntOption("目标数据库/schema", "audit");
}

async function finishCompare(
  result: DatabaseCompareResult = sampleCompareResult()
): Promise<void> {
  vi.mocked(api.compareDatabases).mockResolvedValue(result);
  await configureEndpoints();
  fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
  await screen.findByText(result.tables[0]?.name ?? "两个数据库结构一致");
}

async function openSafePreview(): Promise<void> {
  await finishCompare();
  fireEvent.click(screen.getByRole("checkbox", { name: "选择 users" }));
  fireEvent.click(screen.getByRole("button", { name: "预览同步（1）" }));
  await screen.findByText("同步 SQL 预览");
}

function acknowledgeSyncPlan(): void {
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "我已检查以上 SQL，并理解已成功执行的 DDL 可能无法自动回滚",
    })
  );
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("DatabaseCompareModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listCompareDatabases).mockResolvedValue(["app", "audit"]);
    vi.mocked(api.previewDatabaseSync).mockResolvedValue(sampleSyncPreview());
    vi.mocked(api.executeDatabaseSync).mockResolvedValue(
      sampleSucceededExecution()
    );
    vi.mocked(saveDatabaseCompareWorkbook).mockResolvedValue(true);
    useConnectionStore.setState({ savedConnections: SAVED_CONNECTIONS });
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
  });

  it("按先源后目标流程过滤连接并完成对比", async () => {
    vi.mocked(api.compareDatabases).mockResolvedValue(sampleCompareResult());
    render(<DatabaseCompareModal open onClose={vi.fn()} />);

    expect(screen.getByLabelText("目标连接")).toBeDisabled();
    await selectAntOption("源连接", "MySQL A");
    await selectAntOption("源数据库/schema", "app");

    const targetConnection = screen.getByLabelText("目标连接");
    fireEvent.mouseDown(targetConnection);
    expect(
      await screen.findByRole("option", { name: "MySQL B" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "PostgreSQL C" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("option", { name: "MySQL B" }));
    await selectAntOption("目标数据库/schema", "audit");
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));

    expect(await screen.findByText("users")).toBeInTheDocument();
    expect(screen.getAllByText("结构变化表")).not.toHaveLength(0);
    expect(api.compareDatabases).toHaveBeenCalledWith(
      { saved_connection_id: "mysql-a", database: "app" },
      { saved_connection_id: "mysql-b", database: "audit" }
    );
  });

  it("错误后保留选择并允许重试", async () => {
    vi.mocked(api.compareDatabases)
      .mockRejectedValueOnce("目标端无权限")
      .mockResolvedValueOnce(sampleCompareResult());
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();

    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    expect(await screen.findByText(/目标端无权限/)).toBeInTheDocument();
    const sourceDatabase = screen.getByLabelText("源数据库/schema");
    expect(sourceDatabase.parentElement?.parentElement).toHaveTextContent(
      "app"
    );

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("users")).toBeInTheDocument();
    expect(api.compareDatabases).toHaveBeenCalledTimes(2);
  });

  it("源端列表加载期间阻止选择目标连接，避免列表请求并发", async () => {
    const sourceDatabases = deferred<string[]>();
    vi.mocked(api.listCompareDatabases).mockImplementation((connectionId) =>
      connectionId === "mysql-a"
        ? sourceDatabases.promise
        : Promise.resolve(["audit"])
    );
    render(<DatabaseCompareModal open onClose={vi.fn()} />);

    await selectAntOption("源连接", "MySQL A");
    expect(screen.getByLabelText("目标连接")).toBeDisabled();
    expect(screen.getByRole("button", { name: "开始对比" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出 Excel" })).toBeDisabled();

    await act(async () => {
      sourceDatabases.resolve(["app"]);
      await sourceDatabases.promise;
    });
    await waitFor(() => {
      expect(screen.getByLabelText("目标连接")).toBeEnabled();
    });
  });

  it("数据库列表加载失败后可重试并继续选择", async () => {
    vi.mocked(api.listCompareDatabases)
      .mockRejectedValueOnce("连接超时")
      .mockResolvedValueOnce(["app"]);
    render(<DatabaseCompareModal open onClose={vi.fn()} />);

    await selectAntOption("源连接", "MySQL A");
    expect(await screen.findByText(/连接超时/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "重试源端列表" }));

    await waitFor(() => {
      expect(api.listCompareDatabases).toHaveBeenCalledTimes(2);
    });
    await selectAntOption("源数据库/schema", "app");
    expect(
      screen.getByLabelText("源数据库/schema").parentElement?.parentElement
    ).toHaveTextContent("app");
  });

  it("选择目标连接不会清除源端列表错误及重试入口", async () => {
    let sourceAttempts = 0;
    vi.mocked(api.listCompareDatabases).mockImplementation((connectionId) => {
      if (connectionId === "mysql-a") {
        sourceAttempts += 1;
        return sourceAttempts === 1
          ? Promise.reject("源端连接超时")
          : Promise.resolve(["app"]);
      }
      return Promise.resolve(["audit"]);
    });
    render(<DatabaseCompareModal open onClose={vi.fn()} />);

    await selectAntOption("源连接", "MySQL A");
    expect(await screen.findByText(/源端连接超时/)).toBeInTheDocument();
    await selectAntOption("目标连接", "MySQL B");
    expect(screen.getByText(/源端连接超时/)).toBeInTheDocument();

    const retrySource = screen.getByRole("button", {
      name: "重试源端列表",
    });
    await waitFor(() => expect(retrySource).toBeEnabled());
    fireEvent.click(retrySource);
    await waitFor(() => expect(sourceAttempts).toBe(2));
    await selectAntOption("源数据库/schema", "app");
  });

  it("切换源数据库不会清除目标端列表错误及重试入口", async () => {
    let targetAttempts = 0;
    vi.mocked(api.listCompareDatabases).mockImplementation((connectionId) => {
      if (connectionId === "mysql-b") {
        targetAttempts += 1;
        return targetAttempts === 1
          ? Promise.reject("目标端连接超时")
          : Promise.resolve(["audit"]);
      }
      return Promise.resolve(["app", "audit"]);
    });
    render(<DatabaseCompareModal open onClose={vi.fn()} />);

    await selectAntOption("源连接", "MySQL A");
    await selectAntOption("源数据库/schema", "app");
    await selectAntOption("目标连接", "MySQL B");
    expect(await screen.findByText(/目标端连接超时/)).toBeInTheDocument();
    await selectAntOption("源数据库/schema", "audit");
    expect(screen.getByText(/目标端连接超时/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重试目标端列表" }));
    await waitFor(() => expect(targetAttempts).toBe(2));
    await selectAntOption("目标数据库/schema", "audit");
  });

  it("目标端列表加载期间禁止交换，完成后恢复", async () => {
    const targetDatabases = deferred<string[]>();
    vi.mocked(api.listCompareDatabases).mockImplementation((connectionId) =>
      connectionId === "mysql-b"
        ? targetDatabases.promise
        : Promise.resolve(["app"])
    );
    render(<DatabaseCompareModal open onClose={vi.fn()} />);

    await selectAntOption("源连接", "MySQL A");
    await selectAntOption("源数据库/schema", "app");
    await selectAntOption("目标连接", "MySQL B");
    expect(
      screen.getByRole("button", { name: "交换源端和目标端" })
    ).toBeDisabled();

    await act(async () => {
      targetDatabases.resolve(["audit"]);
      await targetDatabases.promise;
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "交换源端和目标端" })
      ).toBeEnabled();
    });
  });

  it("对比和导出期间正确禁用冲突操作", async () => {
    const comparison = deferred<DatabaseCompareResult>();
    const exportResult = deferred<boolean>();
    vi.mocked(api.compareDatabases).mockReturnValue(comparison.promise);
    vi.mocked(saveDatabaseCompareWorkbook).mockReturnValue(
      exportResult.promise
    );
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();

    const compareButton = screen.getByRole("button", { name: "开始对比" });
    const exportButton = screen.getByRole("button", { name: "导出 Excel" });
    expect(compareButton).toBeEnabled();
    expect(exportButton).toBeDisabled();
    fireEvent.click(compareButton);
    expect(compareButton).toBeDisabled();
    expect(exportButton).toBeDisabled();

    await act(async () => {
      comparison.resolve(sampleCompareResult());
      await comparison.promise;
    });
    await waitFor(() => {
      expect(exportButton).toBeEnabled();
    });

    fireEvent.click(exportButton);
    expect(compareButton).toBeDisabled();
    expect(exportButton).toBeDisabled();
    await act(async () => {
      exportResult.resolve(true);
      await exportResult.promise;
    });
    await waitFor(() => {
      expect(compareButton).toBeEnabled();
      expect(exportButton).toBeEnabled();
    });
  });

  it("仅结构变化表可展开并显示字段差异列", async () => {
    vi.mocked(api.compareDatabases).mockResolvedValue(
      sampleAllStatusesResult()
    );
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    expect(await screen.findByText("audit_logs")).toBeInTheDocument();

    const sourceOnlyRow = screen.getByText("audit_logs").closest("tr");
    const changedRow = screen.getByText("users").closest("tr");
    const sourceOnlyExpandButton =
      sourceOnlyRow?.querySelector<HTMLButtonElement>(
        'button[aria-label="Expand row"]'
      );
    const expandButton = changedRow?.querySelector<HTMLButtonElement>(
      'button[aria-label="Expand row"]'
    );
    expect(sourceOnlyExpandButton).toBeTruthy();
    expect(expandButton).toBeTruthy();
    fireEvent.click(sourceOnlyExpandButton as HTMLButtonElement);
    expect(screen.queryByText("email")).not.toBeInTheDocument();
    await act(async () => {
      fireEvent.click(expandButton as HTMLButtonElement);
    });

    expect(screen.getAllByText("字段名")).not.toHaveLength(0);
    expect(screen.getAllByText("变化属性")).not.toHaveLength(0);
    expect(screen.getAllByText("源端值")).not.toHaveLength(0);
    expect(screen.getAllByText("目标端值")).not.toHaveLength(0);
    expect(screen.getByText("email")).toBeInTheDocument();
  });

  it("交换两端后清空旧结果并使用交换后的端点", async () => {
    vi.mocked(api.compareDatabases).mockResolvedValue(sampleCompareResult());
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    expect(await screen.findByText("users")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "交换源端和目标端" }));
    expect(screen.queryByText("users")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));

    await waitFor(() => {
      expect(api.compareDatabases).toHaveBeenLastCalledWith(
        { saved_connection_id: "mysql-b", database: "audit" },
        { saved_connection_id: "mysql-a", database: "app" }
      );
    });
  });

  it("按表名和差异状态筛选结果", async () => {
    vi.mocked(api.compareDatabases).mockResolvedValue(
      sampleAllStatusesResult()
    );
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    expect(await screen.findByText("audit_logs")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索表名" }), {
      target: { value: "user" },
    });
    expect(screen.getByText("users")).toBeInTheDocument();
    expect(screen.queryByText("audit_logs")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "搜索表名" }), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "仅源端" }));
    expect(screen.getByText("audit_logs")).toBeInTheDocument();
    expect(screen.queryByText("users")).not.toBeInTheDocument();
    expect(screen.queryByText("events")).not.toBeInTheDocument();
  });

  it("结构一致时显示成功态", async () => {
    vi.mocked(api.compareDatabases).mockResolvedValue({
      ...sampleCompareResult(),
      summary: {
        source_only_tables: 0,
        target_only_tables: 0,
        changed_tables: 0,
        different_columns: 0,
      },
      tables: [],
    });
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));

    expect(await screen.findByText("两个数据库结构一致")).toBeInTheDocument();
  });

  it("导出按钮保存当前对比结果", async () => {
    const result = sampleCompareResult();
    vi.mocked(api.compareDatabases).mockResolvedValue(result);
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    expect(await screen.findByText("users")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "导出 Excel" }));
    await waitFor(() => {
      expect(saveDatabaseCompareWorkbook).toHaveBeenCalledWith(result);
    });
  });

  it("关闭后重开时清空端点和结果", async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <DatabaseCompareModal open onClose={onClose} />
    );
    await selectAntOption("源连接", "MySQL A");
    await waitFor(() => {
      expect(api.listCompareDatabases).toHaveBeenCalledWith("mysql-a");
    });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<DatabaseCompareModal open={false} onClose={onClose} />);
    rerender(<DatabaseCompareModal open onClose={onClose} />);
    expect(screen.getByLabelText("目标连接")).toBeDisabled();
    expect(
      screen.getByLabelText("源连接").parentElement?.parentElement
    ).not.toHaveTextContent("MySQL A");
    expect(screen.queryByText("users")).not.toBeInTheDocument();
  });

  it("关闭后忽略旧列表失败和旧导出成功回调", async () => {
    const sourceDatabases = deferred<string[]>();
    const exportResult = deferred<boolean>();
    const successSpy = vi.spyOn(message, "success");
    vi.mocked(api.listCompareDatabases).mockReturnValueOnce(
      sourceDatabases.promise
    );
    const onClose = vi.fn();
    const { rerender } = render(
      <DatabaseCompareModal open onClose={onClose} />
    );

    await selectAntOption("源连接", "MySQL A");
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    rerender(<DatabaseCompareModal open={false} onClose={onClose} />);
    await act(async () => {
      sourceDatabases.reject("旧请求失败");
      await sourceDatabases.promise.catch(() => undefined);
    });
    rerender(<DatabaseCompareModal open onClose={onClose} />);
    expect(screen.queryByText(/旧请求失败/)).not.toBeInTheDocument();

    vi.mocked(api.compareDatabases).mockResolvedValue(sampleCompareResult());
    vi.mocked(saveDatabaseCompareWorkbook).mockReturnValue(
      exportResult.promise
    );
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    expect(await screen.findByText("users")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "导出 Excel" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    rerender(<DatabaseCompareModal open={false} onClose={onClose} />);
    await act(async () => {
      exportResult.resolve(true);
      await exportResult.promise;
    });
    expect(successSpy).not.toHaveBeenCalled();
    successSpy.mockRestore();
  });

  it("端点变化后忽略尚未完成的旧对比结果", async () => {
    let resolveComparison: (result: DatabaseCompareResult) => void = () => {};
    vi.mocked(api.compareDatabases).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveComparison = resolve;
        })
    );
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));

    await selectAntOption("源数据库/schema", "audit");
    await act(async () => {
      resolveComparison(sampleCompareResult());
      await Promise.resolve();
    });

    expect(screen.queryByText("users")).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("源数据库/schema").parentElement?.parentElement
    ).toHaveTextContent("audit");
  });

  it("端点变化后等待旧对比请求结束才允许再次开始", async () => {
    const oldComparison = deferred<DatabaseCompareResult>();
    vi.mocked(api.compareDatabases)
      .mockReturnValueOnce(oldComparison.promise)
      .mockResolvedValueOnce(sampleCompareResult());
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));

    await selectAntOption("源数据库/schema", "audit");
    const compareButton = screen.getByRole("button", { name: "开始对比" });
    expect(compareButton).toBeDisabled();

    await act(async () => {
      oldComparison.resolve(sampleCompareResult());
      await oldComparison.promise;
    });
    await waitFor(() => expect(compareButton).toBeEnabled());
    fireEvent.click(compareButton);
    await waitFor(() => expect(api.compareDatabases).toHaveBeenCalledTimes(2));
  });

  it("关闭重开立即开始新对比时旧请求不会覆盖结果或提前解锁", async () => {
    const oldComparison = deferred<DatabaseCompareResult>();
    const newComparison = deferred<DatabaseCompareResult>();
    vi.mocked(api.compareDatabases)
      .mockReturnValueOnce(oldComparison.promise)
      .mockReturnValueOnce(newComparison.promise);
    const { rerender } = render(
      <DatabaseCompareModal open onClose={vi.fn()} />
    );
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    expect(api.compareDatabases).toHaveBeenCalledTimes(1);

    rerender(<DatabaseCompareModal open={false} onClose={vi.fn()} />);
    rerender(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();
    const compareButton = screen.getByRole("button", { name: "开始对比" });
    expect(compareButton).toBeEnabled();
    fireEvent.click(compareButton);
    expect(api.compareDatabases).toHaveBeenCalledTimes(2);
    expect(compareButton).toBeDisabled();

    await act(async () => {
      oldComparison.resolve(sampleAllStatusesResult());
      await oldComparison.promise;
    });
    expect(screen.queryByText("audit_logs")).not.toBeInTheDocument();
    expect(compareButton).toBeDisabled();

    await act(async () => {
      newComparison.resolve(sampleCompareResult());
      await newComparison.promise;
    });
    expect(await screen.findByText("users")).toBeInTheDocument();
    expect(screen.queryByText("audit_logs")).not.toBeInTheDocument();
    await waitFor(() => expect(compareButton).toBeEnabled());
  });

  it("用当前合法选择和端点请求同步预览并打开确认弹窗", async () => {
    const successSpy = vi.spyOn(message, "success");
    vi.mocked(api.compareDatabases).mockResolvedValue(
      sampleAllStatusesResult()
    );
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    expect(await screen.findByText("users")).toBeInTheDocument();

    const previewButton = screen.getByRole("button", {
      name: "预览同步（0）",
    });
    expect(previewButton).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 users" }));
    fireEvent.click(screen.getByRole("button", { name: "预览同步（1）" }));

    await waitFor(() => {
      expect(api.previewDatabaseSync).toHaveBeenCalledWith({
        source: { saved_connection_id: "mysql-a", database: "app" },
        target: { saved_connection_id: "mysql-b", database: "audit" },
        selected_tables: ["users"],
        include_drops: false,
      });
    });
    expect(successSpy).toHaveBeenCalledWith(
      "同步预览已生成；执行前仍需检查并确认 SQL"
    );
    expect(screen.getByText("同步 SQL 预览")).toBeInTheDocument();
    expect(
      screen.getByText(
        "ALTER TABLE `users` MODIFY `email` varchar(255) NOT NULL"
      )
    ).toBeInTheDocument();
    successSpy.mockRestore();
  });

  it("开启删除后同步全部差异表", async () => {
    vi.mocked(api.compareDatabases).mockResolvedValue(
      sampleAllStatusesResult()
    );
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    expect(await screen.findByText("users")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "允许删除目标端结构" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择全部可同步表" }));
    fireEvent.click(screen.getByRole("button", { name: "预览同步（3）" }));

    await waitFor(() => {
      expect(api.previewDatabaseSync).toHaveBeenCalledWith({
        source: { saved_connection_id: "mysql-a", database: "app" },
        target: { saved_connection_id: "mysql-b", database: "audit" },
        selected_tables: ["audit_logs", "events", "users"],
        include_drops: true,
      });
    });
  });

  it("生成预览时禁用冲突操作并同时显示文字和加载图标", async () => {
    const preview = deferred<DatabaseSyncPreview>();
    vi.mocked(api.compareDatabases).mockResolvedValue(sampleCompareResult());
    vi.mocked(api.previewDatabaseSync).mockReturnValue(preview.promise);
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    expect(await screen.findByText("users")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 users" }));
    fireEvent.click(screen.getByRole("button", { name: "预览同步（1）" }));

    const loadingButton = screen.getByRole("button", {
      name: "正在生成同步预览",
    });
    expect(loadingButton).toBeDisabled();
    expect(
      screen.getByTestId("database-sync-preview-loading-icon")
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "选择 users" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "开始对比" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出 Excel" })).toBeDisabled();

    await act(async () => {
      preview.resolve(sampleSyncPreview());
      await preview.promise;
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "预览同步（1）" })
      ).toBeEnabled();
    });
  });

  it("当前预览失败时反馈错误并允许重试", async () => {
    const errorSpy = vi.spyOn(message, "error");
    vi.mocked(api.compareDatabases).mockResolvedValue(sampleCompareResult());
    vi.mocked(api.previewDatabaseSync).mockRejectedValue("目标端只读");
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    expect(await screen.findByText("users")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 users" }));
    fireEvent.click(screen.getByRole("button", { name: "预览同步（1）" }));

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith("生成同步预览失败：目标端只读");
    });
    expect(screen.getByRole("button", { name: "预览同步（1）" })).toBeEnabled();
    errorSpy.mockRestore();
  });

  it("端点变化后忽略尚未完成的旧预览错误", async () => {
    const preview = deferred<DatabaseSyncPreview>();
    const errorSpy = vi.spyOn(message, "error");
    vi.mocked(api.compareDatabases).mockResolvedValue(sampleCompareResult());
    vi.mocked(api.previewDatabaseSync).mockReturnValue(preview.promise);
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    expect(await screen.findByText("users")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 users" }));
    fireEvent.click(screen.getByRole("button", { name: "预览同步（1）" }));

    await selectAntOption("源数据库/schema", "audit");
    await act(async () => {
      preview.reject("旧预览失败");
      await preview.promise.catch(() => undefined);
    });

    expect(errorSpy).not.toHaveBeenCalledWith("生成同步预览失败：旧预览失败");
    expect(screen.queryByText("users")).not.toBeInTheDocument();
    errorSpy.mockRestore();
  });

  it("端点变化后忽略旧预览成功并重置同步状态", async () => {
    const preview = deferred<DatabaseSyncPreview>();
    const successSpy = vi.spyOn(message, "success");
    vi.mocked(api.compareDatabases).mockResolvedValue(
      sampleAllStatusesResult()
    );
    vi.mocked(api.previewDatabaseSync).mockReturnValue(preview.promise);
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    expect(await screen.findByText("users")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "允许删除目标端结构" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择全部可同步表" }));
    fireEvent.click(screen.getByRole("button", { name: "预览同步（3）" }));

    await selectAntOption("源数据库/schema", "audit");
    await act(async () => {
      preview.resolve(sampleSyncPreview());
      await preview.promise;
    });
    expect(successSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    await waitFor(() => {
      expect(screen.getByText("已选择 0 / 2 张表")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("switch", { name: "允许删除目标端结构" })
    ).not.toBeChecked();
    successSpy.mockRestore();
  });

  it("关闭期间忽略旧预览成功并在重开后清空同步状态", async () => {
    const preview = deferred<DatabaseSyncPreview>();
    const successSpy = vi.spyOn(message, "success");
    const onClose = vi.fn();
    vi.mocked(api.compareDatabases).mockResolvedValue(
      sampleAllStatusesResult()
    );
    vi.mocked(api.previewDatabaseSync).mockReturnValue(preview.promise);
    const { rerender } = render(
      <DatabaseCompareModal open onClose={onClose} />
    );
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    expect(await screen.findByText("users")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "允许删除目标端结构" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择全部可同步表" }));
    fireEvent.click(screen.getByRole("button", { name: "预览同步（3）" }));

    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    rerender(<DatabaseCompareModal open={false} onClose={onClose} />);
    await act(async () => {
      preview.resolve(sampleSyncPreview());
      await preview.promise;
    });
    expect(successSpy).not.toHaveBeenCalled();

    rerender(<DatabaseCompareModal open onClose={onClose} />);
    await configureEndpoints();
    fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
    await waitFor(() => {
      expect(screen.getByText("已选择 0 / 2 张表")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("switch", { name: "允许删除目标端结构" })
    ).not.toBeChecked();
    successSpy.mockRestore();
  });

  it("重新对比会清空同步选择并恢复删除默认关闭", async () => {
    vi.mocked(api.compareDatabases).mockResolvedValue(
      sampleAllStatusesResult()
    );
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await configureEndpoints();
    const compareButton = screen.getByRole("button", { name: "开始对比" });
    fireEvent.click(compareButton);
    expect(await screen.findByText("users")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "允许删除目标端结构" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择全部可同步表" }));
    expect(screen.getByText("已选择 3 / 3 张表")).toBeInTheDocument();

    fireEvent.click(compareButton);

    await waitFor(() => {
      expect(screen.getByText("已选择 0 / 2 张表")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("switch", { name: "允许删除目标端结构" })
    ).not.toBeChecked();
  });

  it("确认执行只提交原请求和计划指纹，并结构化展示成功结果", async () => {
    const successSpy = vi.spyOn(message, "success");
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await openSafePreview();
    acknowledgeSyncPlan();

    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    await waitFor(() => {
      expect(api.executeDatabaseSync).toHaveBeenCalledWith({
        request: {
          source: { saved_connection_id: "mysql-a", database: "app" },
          target: { saved_connection_id: "mysql-b", database: "audit" },
          selected_tables: ["users"],
          include_drops: false,
        },
        plan_fingerprint: "preview-fingerprint",
      });
    });
    const executeInput = vi.mocked(api.executeDatabaseSync).mock.calls[0][0];
    expect(Object.keys(executeInput).sort()).toEqual([
      "plan_fingerprint",
      "request",
    ]);
    expect(Object.keys(executeInput.request).sort()).toEqual([
      "include_drops",
      "selected_tables",
      "source",
      "target",
    ]);
    expect(await screen.findByText("同步执行结果")).toBeInTheDocument();
    expect(screen.getAllByText("数据库结构已同步")).not.toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent(
      "数据库结构同步成功，已完成 1 个操作，共 1 条语句"
    );
    expect(successSpy).toHaveBeenCalledWith("数据库结构已同步");
    successSpy.mockRestore();
  });

  it("成功后重新对比采用后端最新结果并清空旧同步计划", async () => {
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await openSafePreview();
    acknowledgeSyncPlan();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(await screen.findByText("数据库结构已同步")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新对比" }));

    expect(screen.queryByText("同步执行结果")).not.toBeInTheDocument();
    expect(screen.getByText("两个数据库结构一致")).toBeInTheDocument();
    expect(api.compareDatabases).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: /预览同步/ })
    ).not.toBeInTheDocument();
  });

  it("部分失败时展示结构化结果和清理警告，重新对比真实目标结构", async () => {
    vi.mocked(api.executeDatabaseSync).mockResolvedValue(
      samplePartialExecution()
    );
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await openSafePreview();
    vi.mocked(api.compareDatabases).mockResolvedValue(sampleNoDiffResult());
    acknowledgeSyncPlan();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    expect(await screen.findByText("同步部分完成")).toBeInTheDocument();
    expect(screen.getByText("目标字段仍被视图引用")).toBeInTheDocument();
    expect(screen.getByText("连接清理警告")).toBeInTheDocument();
    expect(screen.getByText("目标端临时连接清理失败")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新对比" }));
    expect(await screen.findByText("两个数据库结构一致")).toBeInTheDocument();
    expect(api.compareDatabases).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("同步执行结果")).not.toBeInTheDocument();
  });

  it("失败执行结果保持结构化展示且旧计划不能重复执行", async () => {
    vi.mocked(api.executeDatabaseSync).mockResolvedValue(
      sampleFailedExecution()
    );
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await openSafePreview();
    acknowledgeSyncPlan();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    expect(await screen.findByText("同步执行失败")).toBeInTheDocument();
    expect(screen.getByText("目标端拒绝执行 DDL")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "确认执行" })
    ).not.toBeInTheDocument();
    expect(api.executeDatabaseSync).toHaveBeenCalledTimes(1);
  });

  it.each(["右上角 X", "遮罩", "Escape"])(
    "部分执行结果通过%s退出时重新对比真实目标结构",
    async (dismissMethod) => {
      vi.mocked(api.executeDatabaseSync).mockResolvedValue(
        samplePartialExecution()
      );
      render(<DatabaseCompareModal open onClose={vi.fn()} />);
      await openSafePreview();
      vi.mocked(api.compareDatabases).mockResolvedValue(sampleNoDiffResult());
      acknowledgeSyncPlan();
      fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
      expect(await screen.findByText("同步部分完成")).toBeInTheDocument();

      if (dismissMethod === "右上角 X") {
        fireEvent.click(screen.getByRole("button", { name: "关闭同步预览" }));
      } else if (dismissMethod === "遮罩") {
        const modalWrap = document.querySelector(
          ".database-sync-preview-modal .ant-modal-wrap"
        );
        expect(modalWrap).not.toBeNull();
        fireEvent.mouseDown(modalWrap as Element);
        fireEvent.click(modalWrap as Element);
      } else {
        const modalWrap = document.querySelector(
          ".database-sync-preview-modal .ant-modal-wrap"
        );
        expect(modalWrap).not.toBeNull();
        fireEvent.keyDown(modalWrap as Element, {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
        });
      }

      expect(await screen.findByText("两个数据库结构一致")).toBeInTheDocument();
      expect(api.compareDatabases).toHaveBeenCalledTimes(2);
      expect(screen.queryByText("同步执行结果")).not.toBeInTheDocument();
    }
  );

  it("执行中锁定关闭、交换、新对比和重复确认", async () => {
    const execution = deferred<DatabaseSyncExecutionResult>();
    const onClose = vi.fn();
    vi.mocked(api.executeDatabaseSync).mockReturnValue(execution.promise);
    render(<DatabaseCompareModal open onClose={onClose} />);
    await openSafePreview();
    acknowledgeSyncPlan();
    const confirm = screen.getByRole("button", { name: "确认执行" });

    fireEvent.click(confirm);

    expect(screen.getByRole("button", { name: "正在执行同步" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "交换源端和目标端" })
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "开始对比" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "导出 Excel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "关闭" })).toBeDisabled();
    expect(screen.getByLabelText("源连接")).toBeDisabled();
    expect(screen.getByLabelText("源数据库/schema")).toBeDisabled();
    expect(screen.getByLabelText("目标连接")).toBeDisabled();
    expect(screen.getByLabelText("目标数据库/schema")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "正在执行同步" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(api.executeDatabaseSync).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      execution.resolve(sampleSucceededExecution());
      await execution.promise;
    });
  });

  it("程序关闭使尚未返回的执行成功失效并完全重置状态", async () => {
    const execution = deferred<DatabaseSyncExecutionResult>();
    const successSpy = vi.spyOn(message, "success");
    vi.mocked(api.executeDatabaseSync).mockReturnValue(execution.promise);
    const { rerender } = render(
      <DatabaseCompareModal open onClose={vi.fn()} />
    );
    await openSafePreview();
    acknowledgeSyncPlan();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    rerender(<DatabaseCompareModal open={false} onClose={vi.fn()} />);
    await act(async () => {
      execution.resolve(sampleSucceededExecution());
      await execution.promise;
    });
    expect(successSpy).not.toHaveBeenCalledWith("数据库结构已同步");

    rerender(<DatabaseCompareModal open onClose={vi.fn()} />);
    expect(screen.queryByText("同步执行结果")).not.toBeInTheDocument();
    expect(screen.queryByText("users")).not.toBeInTheDocument();
    expect(screen.getByLabelText("目标连接")).toBeDisabled();
    expect(
      screen.getByLabelText("源连接").parentElement?.parentElement
    ).not.toHaveTextContent("MySQL A");
    successSpy.mockRestore();
  });

  it("旧执行关闭重开后仍占用执行锁，完成后才允许执行新计划", async () => {
    const oldExecution = deferred<DatabaseSyncExecutionResult>();
    vi.mocked(api.executeDatabaseSync)
      .mockReturnValueOnce(oldExecution.promise)
      .mockResolvedValueOnce(sampleSucceededExecution());
    const { rerender } = render(
      <DatabaseCompareModal open onClose={vi.fn()} />
    );
    await openSafePreview();
    acknowledgeSyncPlan();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(api.executeDatabaseSync).toHaveBeenCalledTimes(1);

    rerender(<DatabaseCompareModal open={false} onClose={vi.fn()} />);
    rerender(<DatabaseCompareModal open onClose={vi.fn()} />);
    await openSafePreview();
    acknowledgeSyncPlan();

    expect(screen.getByText("上一同步请求仍在处理中")).toBeInTheDocument();
    const lockedConfirm = screen.getByRole("button", { name: "确认执行" });
    expect(lockedConfirm).toBeDisabled();
    fireEvent.click(lockedConfirm);
    expect(api.executeDatabaseSync).toHaveBeenCalledTimes(1);

    await act(async () => {
      oldExecution.resolve(sampleSucceededExecution());
      await oldExecution.promise;
    });

    await waitFor(() => {
      expect(
        screen.queryByText("上一同步请求仍在处理中")
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled();
    });
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => {
      expect(api.executeDatabaseSync).toHaveBeenCalledTimes(2);
    });
  });

  it("关闭后生成的新预览不受旧执行错误影响", async () => {
    const execution = deferred<DatabaseSyncExecutionResult>();
    const errorSpy = vi.spyOn(message, "error");
    vi.mocked(api.executeDatabaseSync).mockReturnValue(execution.promise);
    const { rerender } = render(
      <DatabaseCompareModal open onClose={vi.fn()} />
    );
    await openSafePreview();
    acknowledgeSyncPlan();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    rerender(<DatabaseCompareModal open={false} onClose={vi.fn()} />);
    rerender(<DatabaseCompareModal open onClose={vi.fn()} />);
    await openSafePreview();
    await act(async () => {
      execution.reject("旧执行失败：不应显示");
      await execution.promise.catch(() => undefined);
    });

    expect(errorSpy).not.toHaveBeenCalledWith("旧执行失败：不应显示");
    expect(screen.getByText("同步 SQL 预览")).toBeInTheDocument();
    expect(screen.getByText(/计划 preview-/)).toBeInTheDocument();
    errorSpy.mockRestore();
  });

  it("结构漂移错误关闭旧计划、保留合法选择并允许重新预览", async () => {
    const errorSpy = vi.spyOn(message, "error");
    vi.mocked(api.executeDatabaseSync).mockRejectedValue(
      new Error("数据库结构已变化，请重新对比并预览同步计划")
    );
    render(<DatabaseCompareModal open onClose={vi.fn()} />);
    await openSafePreview();
    acknowledgeSyncPlan();
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));

    await waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(
        "数据库结构已变化，请重新对比并预览同步计划"
      );
    });
    expect(screen.queryByText("同步 SQL 预览")).not.toBeInTheDocument();
    expect(screen.getByText("已选择 1 / 1 张表")).toBeInTheDocument();
    const previewAgain = screen.getByRole("button", {
      name: "预览同步（1）",
    });
    expect(previewAgain).toBeEnabled();
    fireEvent.click(previewAgain);
    expect(await screen.findByText("同步 SQL 预览")).toBeInTheDocument();
    expect(api.previewDatabaseSync).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });
});
