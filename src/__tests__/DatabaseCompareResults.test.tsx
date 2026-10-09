import { fireEvent, render, screen, within } from "@testing-library/react";
import { Profiler, useState } from "react";
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
  result = baseProps.result,
}: {
  initiallySelected?: string[];
  result?: DatabaseCompareResult;
}) {
  const [selectedTableNames, setSelectedTableNames] =
    useState(initiallySelected);
  const [includeDrops, setIncludeDrops] = useState(false);
  return (
    <DatabaseCompareResults
      {...baseProps}
      result={result}
      includeDrops={includeDrops}
      onIncludeDropsChange={setIncludeDrops}
      onSelectionChange={setSelectedTableNames}
      selectedTableNames={selectedTableNames}
    />
  );
}

function manyTables(count = 1001): DatabaseCompareResult {
  return {
    ...compareResult(),
    tables: Array.from({ length: count }, (_, index) => ({
      name: `table_${String(index + 1).padStart(4, "0")}`,
      status: index === 0 || index === 50 ? "target_only" : "source_only",
      columns: [],
    })),
    summary: {
      source_only_tables: count - 2,
      target_only_tables: 2,
      changed_tables: 0,
      different_columns: 0,
    },
  };
}

function nextTablePage() {
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "差异表分页" })).getByTitle(
      "Next Page"
    )
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
  it("1001 张差异表仅挂载 50 行，跨页选择和全选保持完整", () => {
    render(<ControlledResults result={manyTables()} />);
    expect(
      screen.getAllByRole("checkbox", { name: /^选择 table_/ })
    ).toHaveLength(50);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 table_0002" }));
    nextTablePage();
    expect(
      screen.queryByRole("checkbox", { name: "选择 table_0002" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 table_0052" }));
    expect(screen.getByText("已选择 2 / 999 张表")).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "差异表分页" })).getByTitle(
        "Previous Page"
      )
    );
    expect(
      screen.getByRole("checkbox", { name: "选择 table_0002" })
    ).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择全部可同步表" }));
    expect(screen.getByText("已选择 999 / 999 张表")).toBeInTheDocument();
    nextTablePage();
    expect(
      screen.getByRole("checkbox", { name: "选择 table_0052" })
    ).toBeChecked();
  });

  it("关闭删除开关会移除所有页面的目标端独有表", () => {
    render(<ControlledResults result={manyTables()} />);
    const drops = screen.getByRole("switch", { name: "允许删除目标端结构" });
    fireEvent.click(drops);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 table_0001" }));
    nextTablePage();
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 table_0051" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 table_0052" }));
    fireEvent.click(drops);
    expect(screen.getByText("已选择 1 / 999 张表")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "选择 table_0051" })
    ).not.toBeChecked();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "差异表分页" })).getByTitle(
        "Previous Page"
      )
    );
    expect(
      screen.getByRole("checkbox", { name: "选择 table_0001" })
    ).not.toBeChecked();
  });

  it("搜索、清空、筛选和结果替换都不会保留越界页", () => {
    const result = manyTables();
    const { rerender } = render(
      <DatabaseCompareResults {...baseProps} result={result} />
    );
    nextTablePage();
    const search = screen.getByPlaceholderText("搜索表名");
    fireEvent.change(search, { target: { value: "table_1001" } });
    expect(screen.getByText("table_1001")).toBeInTheDocument();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByText("table_0001")).toBeInTheDocument();
    nextTablePage();
    fireEvent.click(screen.getByRole("radio", { name: "仅目标端" }));
    expect(screen.getByText("table_0001")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "全部" }));
    nextTablePage();
    rerender(
      <DatabaseCompareResults {...baseProps} result={compareResult()} />
    );
    expect(screen.getByText("orders")).toBeInTheDocument();
  });

  it("展开字段仅挂载当前 50 行，外层换页卸载展开内容", () => {
    const column = compareResult().tables[1].columns[0];
    const result = manyTables();
    result.tables[0] = {
      name: "table_0001",
      status: "changed",
      columns: Array.from({ length: 101 }, (_, index) => ({
        ...column,
        name: `field_${index + 1}`,
      })),
    };
    const { container } = render(
      <DatabaseCompareResults {...baseProps} result={result} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand row" }));
    expect(
      container.querySelectorAll(
        ".database-compare-expanded-table .ant-table-row"
      )
    ).toHaveLength(50);
    const fields = screen.getByRole("navigation", {
      name: "table_0001 字段分页",
    });
    fireEvent.click(within(fields).getByTitle("Next Page"));
    expect(screen.getByText("field_51")).toBeInTheDocument();
    expect(screen.queryByText("field_1")).not.toBeInTheDocument();
    nextTablePage();
    expect(
      container.querySelector(".database-compare-expanded-table")
    ).toBeNull();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "差异表分页" })).getByTitle(
        "Previous Page"
      )
    );
    expect(
      container.querySelector(".database-compare-expanded-table")
    ).toBeNull();
  });
  it("一万张差异表首屏和键盘换页均只挂载 50 行", () => {
    const commits: { phase: string; duration: number }[] = [];
    const { container } = render(
      <Profiler
        id="compare-pagination"
        onRender={(_id, phase, duration) => commits.push({ phase, duration })}
      >
        <DatabaseCompareResults {...baseProps} result={manyTables(10_000)} />
      </Profiler>
    );
    expect(container.querySelectorAll(".ant-table-row")).toHaveLength(50);
    const mount = [...commits];
    commits.length = 0;
    const next = within(
      screen.getByRole("navigation", { name: "差异表分页" })
    ).getByTitle("Next Page");
    next.focus();
    expect(next).toHaveFocus();
    fireEvent.keyDown(next, { key: "Enter", keyCode: 13 });
    expect(screen.getByText("table_0051")).toBeInTheDocument();
    expect(container.querySelectorAll(".ant-table-row")).toHaveLength(50);
    console.info(
      "任务2 Profiler：10000表",
      JSON.stringify({ mount, page: commits })
    );
  });
});
