import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseCompareResults } from "../components/databaseCompare/DatabaseCompareResults";
import type { DatabaseCompareResult } from "../types";

function compareResult(): DatabaseCompareResult {
  return {
    database_type: "mysql",
    source: {
      connection_id: "source-id",
      connection_name: "Source",
      database: "source_db",
    },
    target: {
      connection_id: "target-id",
      connection_name: "Target",
      database: "target_db",
    },
    compared_at: "2026-07-18T08:00:00Z",
    summary: {
      source_only_tables: 1,
      target_only_tables: 1,
      changed_tables: 1,
      different_columns: 1,
    },
    tables: [
      { name: "orders", status: "source_only", columns: [] },
      {
        name: "users",
        status: "changed",
        columns: [
          {
            name: "email",
            status: "changed",
            changed_fields: ["nullable"],
            source: {
              ordinal_position: 1,
              column_type: "varchar(255)",
              nullable: false,
              default_value: null,
              primary_key: false,
              extra: "",
              comment: "",
            },
            target: {
              ordinal_position: 1,
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
      { name: "old_logs", status: "target_only", columns: [] },
    ],
  };
}

const baseProps = {
  disabled: false,
  includeDrops: false,
  onIncludeDropsChange: vi.fn(),
  onSelectionChange: vi.fn(),
  result: compareResult(),
  selectedTableNames: [] as string[],
};

function ControlledResults({
  initiallySelected = [],
}: {
  initiallySelected?: string[];
}) {
  const [selectedTableNames, setSelectedTableNames] =
    useState(initiallySelected);
  const [includeDrops, setIncludeDrops] = useState(false);
  return (
    <DatabaseCompareResults
      {...baseProps}
      includeDrops={includeDrops}
      onIncludeDropsChange={setIncludeDrops}
      onSelectionChange={setSelectedTableNames}
      selectedTableNames={selectedTableNames}
    />
  );
}

describe("DatabaseCompareResults", () => {
  beforeEach(() => {
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

  it("筛选后点击全选仍选择全部符合条件的表", () => {
    const onSelectionChange = vi.fn();
    render(
      <DatabaseCompareResults
        {...baseProps}
        onSelectionChange={onSelectionChange}
      />
    );

    fireEvent.change(screen.getByPlaceholderText("搜索表名"), {
      target: { value: "users" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "选择全部可同步表" }));

    expect(onSelectionChange).toHaveBeenCalledWith(["orders", "users"]);
  });

  it("删除默认关闭且目标端独有表不可选", () => {
    render(<DatabaseCompareResults {...baseProps} />);

    expect(
      screen.getByRole("switch", { name: "允许删除目标端结构" })
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "选择 old_logs" })
    ).toBeDisabled();
    expect(screen.getByText("目标端独有表默认不参与同步")).toBeInTheDocument();
  });

  it("选择部分表时显示半选和准确计数", () => {
    render(<ControlledResults initiallySelected={["users"]} />);

    expect(
      screen.getByRole("checkbox", { name: "选择全部可同步表" })
    ).toBePartiallyChecked();
    expect(screen.getByText("已选择 1 / 2 张表")).toBeInTheDocument();
  });

  it("开启删除后显示文字危险提示并允许选择目标端独有表", () => {
    render(<ControlledResults />);

    fireEvent.click(screen.getByRole("switch", { name: "允许删除目标端结构" }));

    expect(
      screen.getByRole("checkbox", { name: "选择 old_logs" })
    ).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "同步计划可能包含删除表或字段操作"
    );
    expect(
      screen.getByTestId("database-sync-drop-warning-icon")
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择全部可同步表" }));
    expect(screen.getByText("已选择 3 / 3 张表")).toBeInTheDocument();
  });

  it("关闭删除时自动取消已选择的目标端独有表", () => {
    render(<ControlledResults />);

    const includeDrops = screen.getByRole("switch", {
      name: "允许删除目标端结构",
    });
    fireEvent.click(includeDrops);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 old_logs" }));
    expect(screen.getByText("已选择 1 / 3 张表")).toBeInTheDocument();

    fireEvent.click(includeDrops);

    expect(screen.getByText("已选择 0 / 2 张表")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "选择 old_logs" })
    ).toBeDisabled();
  });

  it("结果变化时重置组件内搜索和状态筛选", () => {
    const { rerender } = render(<DatabaseCompareResults {...baseProps} />);
    const search = screen.getByPlaceholderText("搜索表名");
    fireEvent.change(search, { target: { value: "users" } });
    fireEvent.click(screen.getByRole("radio", { name: "结构变化" }));

    rerender(
      <DatabaseCompareResults
        {...baseProps}
        result={{ ...compareResult(), compared_at: "2026-07-18T09:00:00Z" }}
      />
    );

    expect(search).toHaveValue("");
    expect(screen.getByRole("radio", { name: "全部" })).toBeChecked();
  });

  it("禁用时所有同步选择控件均不可操作", () => {
    render(<DatabaseCompareResults {...baseProps} disabled />);

    expect(
      screen.getByRole("checkbox", { name: "选择全部可同步表" })
    ).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "选择 users" })).toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "允许删除目标端结构" })
    ).toBeDisabled();
  });
});
