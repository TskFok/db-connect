import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSyncPreviewModal } from "../components/databaseCompare/DatabaseSyncPreviewModal";
import type {
  CompareEndpointInfo,
  DatabaseSyncExecutionResult,
  DatabaseSyncPreview,
} from "../types";

const source: CompareEndpointInfo = {
  connection_id: "source-id",
  connection_name: "生产只读副本",
  database: "source_db",
};

const target: CompareEndpointInfo = {
  connection_id: "target-id",
  connection_name: "测试环境",
  database: "target_db",
};

const safePreview: DatabaseSyncPreview = {
  plan_fingerprint:
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  summary: {
    selected_tables: 2,
    executable_operations: 2,
    high_risk_operations: 1,
    destructive_operations: 0,
    skipped_items: 1,
    blockers: 0,
  },
  operations: [
    {
      id: "op-0001",
      table_name: "orders",
      kind: "create_table",
      summary: "创建目标端缺失的 orders 表",
      risk: "normal",
      sql: [
        "CREATE TABLE `target_db`.`orders` (`id` BIGINT NOT NULL)",
        "ALTER TABLE `target_db`.`orders` ADD PRIMARY KEY (`id`)",
      ],
    },
    {
      id: "op-0002",
      table_name: "users",
      kind: "alter_column",
      summary: "修改 users.email 的类型和可空性",
      risk: "high",
      sql: [
        "ALTER TABLE `target_db`.`users` MODIFY COLUMN `email` VARCHAR(255) NOT NULL",
      ],
    },
  ],
  skipped_items: [
    {
      table_name: "users",
      summary: "保留目标端字段 users.legacy",
      reason: "删除操作未开启",
    },
  ],
  blockers: [],
  can_execute: true,
};

const destructivePreview: DatabaseSyncPreview = {
  ...safePreview,
  plan_fingerprint:
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  summary: {
    ...safePreview.summary,
    executable_operations: 3,
    destructive_operations: 1,
    skipped_items: 0,
  },
  operations: [
    ...safePreview.operations,
    {
      id: "op-0003",
      table_name: "old_logs",
      kind: "drop_table",
      summary: "删除目标端独有表 old_logs",
      risk: "destructive",
      sql: ["DROP TABLE `target_db`.`old_logs`"],
    },
  ],
  skipped_items: [],
};

const partialFailure: DatabaseSyncExecutionResult = {
  status: "partially_succeeded",
  completed_statements: [
    { operation_id: "op-0001", statement_index: 0 },
    { operation_id: "op-0001", statement_index: 1 },
  ],
  failed: {
    operation_id: "op-0002",
    statement_index: 0,
    error: "目标字段仍被视图引用",
  },
  pending_operation_ids: ["op-0002", "op-0003"],
  cleanup_errors: ["目标端临时连接清理失败，请稍后检查连接状态"],
  latest_compare_result: null,
};

const baseProps = {
  executionResult: null,
  executing: false,
  executionLocked: false,
  onBack: vi.fn(),
  onConfirm: vi.fn(),
  onRecompare: vi.fn(),
  open: true,
  preview: safePreview,
  source,
  target,
};

function renderPreview(
  overrides: Partial<React.ComponentProps<typeof DatabaseSyncPreviewModal>> = {}
) {
  return render(<DatabaseSyncPreviewModal {...baseProps} {...overrides} />);
}

describe("DatabaseSyncPreviewModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it("固定展示同步方向、摘要、操作类型、风险和全部只读 SQL", () => {
    renderPreview();

    expect(
      screen.getByText("生产只读副本 / source_db → 测试环境 / target_db")
    ).toBeInTheDocument();
    expect(screen.getByText("目标数据库：target_db")).toBeInTheDocument();
    expect(screen.getByText("已选择表")).toBeInTheDocument();
    expect(screen.getByText("可执行操作")).toBeInTheDocument();
    expect(screen.getByText("计划 0123456789ab")).toBeInTheDocument();

    const createOperation = screen.getByRole("article", {
      name: "orders 创建表 普通",
    });
    expect(within(createOperation).getByText("orders")).toBeInTheDocument();
    expect(within(createOperation).getByText("创建表")).toBeInTheDocument();
    expect(within(createOperation).getByText("普通")).toBeInTheDocument();
    expect(
      within(createOperation).getByText("创建目标端缺失的 orders 表")
    ).toBeInTheDocument();
    expect(within(createOperation).getAllByText(/target_db/)).toHaveLength(2);
    expect(
      within(createOperation).getByTestId("database-sync-risk-normal-icon")
    ).toBeInTheDocument();

    const highRiskOperation = screen.getByRole("article", {
      name: "users 修改字段 高风险",
    });
    expect(
      within(highRiskOperation).getByTestId("database-sync-risk-high-icon")
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "关闭同步预览" })
    ).toBeInTheDocument();
  });

  it("分区展示跳过项及恢复路径", () => {
    renderPreview();

    const skipped = screen.getByRole("region", { name: "已跳过项目" });
    expect(within(skipped).getByText("已跳过 1 项")).toBeInTheDocument();
    expect(
      within(skipped).getByText("保留目标端字段 users.legacy")
    ).toBeInTheDocument();
    expect(within(skipped).getByText("删除操作未开启")).toBeInTheDocument();
    expect(
      within(skipped).getByText(
        "如需同步删除，请返回并开启删除操作后重新预览。"
      )
    ).toBeInTheDocument();
  });

  it("存在阻塞项时不可执行并说明如何恢复", () => {
    const blockedPreview: DatabaseSyncPreview = {
      ...safePreview,
      blockers: [
        {
          table_name: "users",
          summary: "无法安全修改 users.id 主键",
          reason: "SQLite 不支持原地替换主键",
        },
      ],
      can_execute: false,
      summary: { ...safePreview.summary, blockers: 1 },
    };
    renderPreview({ preview: blockedPreview });

    const blockers = screen.getByRole("region", { name: "阻塞项目" });
    expect(within(blockers).getByText("无法自动同步")).toBeInTheDocument();
    expect(
      within(blockers).getByText("无法安全修改 users.id 主键")
    ).toBeInTheDocument();
    expect(
      within(blockers).getByText(
        "请返回对比结果，取消选择被阻塞的表，再重新生成预览。"
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
  });

  it("后端标记不可执行但没有阻塞详情时仍禁用并给出恢复提示", () => {
    renderPreview({ preview: { ...safePreview, can_execute: false } });

    expect(screen.getByText("当前计划不可执行")).toBeInTheDocument();
    expect(
      screen.getByText("请返回调整选择或删除设置，然后重新生成预览。")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
  });

  it("普通计划也要求确认已检查 SQL", () => {
    const onConfirm = vi.fn();
    renderPreview({ onConfirm });
    const confirm = screen.getByRole("button", { name: "确认执行" });
    expect(confirm).toBeDisabled();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "我已检查以上 SQL，并理解已成功执行的 DDL 可能无法自动回滚",
      })
    );
    fireEvent.click(confirm);

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("父级执行状态更新前也只允许提交一次确认", () => {
    const onConfirm = vi.fn();
    renderPreview({ onConfirm });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "我已检查以上 SQL，并理解已成功执行的 DDL 可能无法自动回滚",
      })
    );
    const confirm = screen.getByRole("button", { name: "确认执行" });

    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("删除计划要求二次勾选确认并使用危险按钮", () => {
    const onConfirm = vi.fn();
    renderPreview({ onConfirm, preview: destructivePreview });
    expect(
      screen.getByText("删除操作不可由本工具自动恢复")
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("database-sync-destructive-warning-icon")
    ).toBeInTheDocument();
    const confirm = screen.getByRole("button", {
      name: "确认并执行删除同步",
    });
    expect(confirm).toBeDisabled();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "我已检查以上 SQL，并理解已成功执行的 DDL 可能无法自动回滚",
      })
    );
    fireEvent.click(confirm);

    expect(onConfirm).toHaveBeenCalledOnce();
    expect(confirm).toHaveClass("ant-btn-dangerous");
  });

  it("计划指纹变化时旧确认立即失效", () => {
    const { rerender } = renderPreview();
    const acknowledgement = screen.getByRole("checkbox", {
      name: "我已检查以上 SQL，并理解已成功执行的 DDL 可能无法自动回滚",
    });
    fireEvent.click(acknowledgement);
    expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled();

    rerender(
      <DatabaseSyncPreviewModal
        {...baseProps}
        preview={{ ...safePreview, plan_fingerprint: "new-fingerprint" }}
      />
    );

    expect(acknowledgement).not.toBeChecked();
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
  });

  it("端点请求变化时旧确认立即失效", () => {
    const { rerender } = renderPreview();
    const acknowledgement = screen.getByRole("checkbox", {
      name: "我已检查以上 SQL，并理解已成功执行的 DDL 可能无法自动回滚",
    });
    fireEvent.click(acknowledgement);
    expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled();

    rerender(
      <DatabaseSyncPreviewModal
        {...baseProps}
        source={{ ...source, database: "other_source_db" }}
      />
    );

    expect(acknowledgement).not.toBeChecked();
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
  });

  it("关闭重开及执行结果变化都会清除旧确认", () => {
    const { rerender } = renderPreview();
    const acknowledge = () =>
      fireEvent.click(
        screen.getByRole("checkbox", {
          name: "我已检查以上 SQL，并理解已成功执行的 DDL 可能无法自动回滚",
        })
      );

    acknowledge();
    rerender(<DatabaseSyncPreviewModal {...baseProps} open={false} />);
    rerender(<DatabaseSyncPreviewModal {...baseProps} />);
    expect(
      screen.getByRole("checkbox", {
        name: "我已检查以上 SQL，并理解已成功执行的 DDL 可能无法自动回滚",
      })
    ).not.toBeChecked();

    acknowledge();
    rerender(
      <DatabaseSyncPreviewModal
        {...baseProps}
        executionResult={partialFailure}
      />
    );
    rerender(<DatabaseSyncPreviewModal {...baseProps} />);
    expect(
      screen.getByRole("checkbox", {
        name: "我已检查以上 SQL，并理解已成功执行的 DDL 可能无法自动回滚",
      })
    ).not.toBeChecked();
  });

  it("执行中禁用返回、关闭和重复执行并显示加载状态", () => {
    const onBack = vi.fn();
    const onConfirm = vi.fn();
    renderPreview({ executing: true, onBack, onConfirm });

    expect(screen.getByRole("button", { name: "返回对比结果" })).toBeDisabled();
    const confirm = screen.getByRole("button", { name: "正在执行同步" });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "正在执行数据库结构同步，请勿关闭窗口"
    );
    expect(
      screen.queryByRole("button", { name: "关闭同步预览" })
    ).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(confirm);
    expect(onBack).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("部分失败时同时展示成功、失败和未执行项", () => {
    const onRecompare = vi.fn();
    renderPreview({
      executionResult: partialFailure,
      onRecompare,
      preview: destructivePreview,
    });

    expect(screen.getByText("同步部分完成")).toBeInTheDocument();
    expect(screen.getByText("已执行 2 条语句")).toBeInTheDocument();
    expect(screen.getByText(/执行在第 3 条语句停止/)).toBeInTheDocument();
    expect(screen.getByText("失败操作：users / 修改字段")).toBeInTheDocument();
    expect(screen.getByText("目标字段仍被视图引用")).toBeInTheDocument();
    expect(screen.getByText("未执行 2 个操作")).toBeInTheDocument();
    expect(
      screen.getByText("orders / 创建表 / 第 1 条 SQL")
    ).toBeInTheDocument();
    expect(
      screen.getByText("orders / 创建表 / 第 2 条 SQL")
    ).toBeInTheDocument();
    expect(screen.getByText("users / 修改字段")).toBeInTheDocument();
    expect(screen.getByText("old_logs / 删除表")).toBeInTheDocument();
    expect(screen.getByText("连接清理警告")).toBeInTheDocument();

    const recompare = screen.getByRole("button", { name: "重新对比" });
    expect(recompare).toBeEnabled();
    fireEvent.click(recompare);
    expect(onRecompare).toHaveBeenCalledOnce();
  });

  it("多语句操作部分执行后失败时不把整个操作标为未执行", () => {
    const failureWithinOperation: DatabaseSyncExecutionResult = {
      status: "partially_succeeded",
      completed_statements: [{ operation_id: "op-0001", statement_index: 0 }],
      failed: {
        operation_id: "op-0001",
        statement_index: 1,
        error: "添加主键失败",
      },
      pending_operation_ids: ["op-0001", "op-0002"],
      cleanup_errors: [],
      latest_compare_result: null,
    };
    renderPreview({ executionResult: failureWithinOperation });

    expect(screen.getByText("该操作已完成 1 条 SQL")).toBeInTheDocument();
    expect(screen.getByText("未执行 1 个操作")).toBeInTheDocument();
    const pending = screen.getByRole("region", { name: "未执行操作" });
    expect(
      within(pending).queryByText("orders / 创建表")
    ).not.toBeInTheDocument();
    expect(within(pending).getByText("users / 修改字段")).toBeInTheDocument();
  });

  it("全部成功时展示成功摘要和清理警告", () => {
    const succeeded: DatabaseSyncExecutionResult = {
      ...partialFailure,
      status: "succeeded",
      failed: null,
      pending_operation_ids: [],
    };
    renderPreview({ executionResult: succeeded });

    expect(screen.getByText("数据库结构已同步")).toBeInTheDocument();
    expect(screen.getByText("已完成 1 个操作（2 条语句）")).toBeInTheDocument();
    expect(screen.getByText("连接清理警告")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "数据库结构同步成功，已完成 1 个操作，共 2 条语句"
    );
    expect(screen.getByRole("button", { name: "重新对比" })).toHaveFocus();
  });

  it("首条语句失败时展示零成功、失败定位和未执行操作", () => {
    const failed: DatabaseSyncExecutionResult = {
      status: "failed",
      completed_statements: [],
      failed: {
        operation_id: "op-0001",
        statement_index: 0,
        error: "目标端拒绝执行 DDL",
      },
      pending_operation_ids: ["op-0001", "op-0002"],
      cleanup_errors: [],
      latest_compare_result: null,
    };
    renderPreview({ executionResult: failed });

    expect(screen.getByText("同步执行失败")).toBeInTheDocument();
    expect(screen.getByText("已执行 0 条语句")).toBeInTheDocument();
    expect(screen.getByText("执行在第 1 条语句停止")).toBeInTheDocument();
    expect(screen.getByText("失败操作：orders / 创建表")).toBeInTheDocument();
    expect(screen.getByText("未执行 2 个操作")).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "已成功执行的语句" })
    ).not.toBeInTheDocument();
  });
});
