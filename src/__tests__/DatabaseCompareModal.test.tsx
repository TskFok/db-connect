import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseCompareModal } from "../components/databaseCompare/DatabaseCompareModal";
import * as api from "../services/tauriCommands";
import { useConnectionStore } from "../stores/connectionStore";
import type { ConnectionConfig, DatabaseCompareResult } from "../types";
import { saveDatabaseCompareWorkbook } from "../utils/databaseCompareExport";

vi.mock("../services/tauriCommands", () => ({
  listCompareDatabases: vi.fn(),
  compareDatabases: vi.fn(),
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

describe("DatabaseCompareModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listCompareDatabases).mockResolvedValue(["app", "audit"]);
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
});
