import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { ColumnType } from "antd/es/table";
import { VirtualDataTable } from "../components/table/VirtualDataTable";

type Row = Record<string, unknown>;

function makeColumns(count: number): ColumnType<Row>[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `col_${i}`,
    dataIndex: `col_${i}`,
    key: `col_${i}`,
    width: 120,
    render: (_v, record) => <span>{String(record[`col_${i}`] ?? "")}</span>,
  }));
}

function makeRows(rowCount: number, colCount: number): Row[] {
  return Array.from({ length: rowCount }, (_, r) => {
    const row: Row = { _key: `r${r}` };
    for (let c = 0; c < colCount; c++) {
      row[`col_${c}`] = `v${r}_${c}`;
    }
    return row;
  });
}

describe("VirtualDataTable", () => {
  it("基本渲染：列头 / 数据 cell / 空数据占位", () => {
    const columns = makeColumns(3);
    const dataSource = makeRows(2, 3);
    const { container, getByText, rerender, queryByText } = render(
      <VirtualDataTable
        columns={columns}
        dataSource={dataSource}
        rowKey={(r) => String(r._key)}
        height={400}
      />
    );

    expect(getByText("col_0")).toBeInTheDocument();
    expect(getByText("col_1")).toBeInTheDocument();
    expect(getByText("v0_0")).toBeInTheDocument();
    expect(getByText("v1_2")).toBeInTheDocument();
    expect(container.querySelectorAll(".virtual-data-table-row").length).toBe(2);

    rerender(
      <VirtualDataTable
        columns={columns}
        dataSource={[]}
        rowKey={(r) => String(r._key)}
        height={400}
      />
    );
    expect(queryByText("v0_0")).not.toBeInTheDocument();
    expect(getByText("暂无数据")).toBeInTheDocument();
  });

  it("rowSelection: 行勾选切换、全选/取消全选", () => {
    const onChange = vi.fn();
    const columns = makeColumns(2);
    const dataSource = makeRows(3, 2);
    const { container, rerender } = render(
      <VirtualDataTable
        columns={columns}
        dataSource={dataSource}
        rowKey={(r) => String(r._key)}
        height={400}
        rowSelection={{ selectedRowKeys: [], onChange }}
      />
    );

    const allInputs = Array.from(
      container.querySelectorAll(".ant-checkbox-input")
    ) as HTMLInputElement[];
    expect(allInputs.length).toBeGreaterThanOrEqual(4);

    const headerCheckbox = container.querySelector(
      ".virtual-data-table-header .ant-checkbox-input"
    ) as HTMLInputElement;
    fireEvent.click(headerCheckbox);
    expect(onChange).toHaveBeenCalledWith(["r0", "r1", "r2"]);

    rerender(
      <VirtualDataTable
        columns={columns}
        dataSource={dataSource}
        rowKey={(r) => String(r._key)}
        height={400}
        rowSelection={{ selectedRowKeys: ["r0", "r1", "r2"], onChange }}
      />
    );
    fireEvent.click(headerCheckbox);
    expect(onChange).toHaveBeenLastCalledWith([]);

    onChange.mockClear();
    rerender(
      <VirtualDataTable
        columns={columns}
        dataSource={dataSource}
        rowKey={(r) => String(r._key)}
        height={400}
        rowSelection={{ selectedRowKeys: [], onChange }}
      />
    );
    const rowInputs = Array.from(
      container.querySelectorAll(".virtual-data-table-row .ant-checkbox-input")
    ) as HTMLInputElement[];
    fireEvent.click(rowInputs[1]!);
    expect(onChange).toHaveBeenCalledWith(["r1"]);
  });

  it("clientReadOnly 时（不传 rowSelection）不渲染行选择列", () => {
    const columns = makeColumns(2);
    const dataSource = makeRows(2, 2);
    const { container } = render(
      <VirtualDataTable
        columns={columns}
        dataSource={dataSource}
        rowKey={(r) => String(r._key)}
        height={400}
      />
    );
    expect(
      container.querySelectorAll(".virtual-data-table-header .ant-checkbox-input").length
    ).toBe(0);
  });

  it("视觉 token：容器上注入 --vdt-* CSS 变量，hover/选中等态由 CSS 驱动", () => {
    const columns = makeColumns(2);
    const dataSource = makeRows(2, 2);
    const { container } = render(
      <VirtualDataTable
        columns={columns}
        dataSource={dataSource}
        rowKey={(r) => String(r._key)}
        height={400}
      />
    );
    const root = container.querySelector(
      ".virtual-data-table-container"
    ) as HTMLElement;
    expect(root).toBeTruthy();
    const requiredVars = [
      "--vdt-bg",
      "--vdt-header-fill",
      "--vdt-header-color",
      "--vdt-cell-split",
      "--vdt-row-hover",
      "--vdt-row-selected",
      "--vdt-row-selected-hover",
      "--vdt-row-zebra",
      "--vdt-resize-handle-hover",
    ];
    for (const v of requiredVars) {
      expect(root.style.getPropertyValue(v)).not.toBe("");
    }
    // 斑马纹：偶数 / 奇数行有不同 className
    const rows = container.querySelectorAll(".virtual-data-table-row");
    expect(rows[0]?.className).toContain("virtual-data-table-row--even");
    expect(rows[1]?.className).toContain("virtual-data-table-row--odd");
  });

  it("视觉 token：选中行带有 --selected className，未选中不带", () => {
    const columns = makeColumns(2);
    const dataSource = makeRows(2, 2);
    const onChange = vi.fn();
    const { container, rerender } = render(
      <VirtualDataTable
        columns={columns}
        dataSource={dataSource}
        rowKey={(r) => String(r._key)}
        height={400}
        rowSelection={{ selectedRowKeys: [], onChange }}
      />
    );
    expect(
      container.querySelectorAll(".virtual-data-table-row--selected").length
    ).toBe(0);

    rerender(
      <VirtualDataTable
        columns={columns}
        dataSource={dataSource}
        rowKey={(r) => String(r._key)}
        height={400}
        rowSelection={{ selectedRowKeys: ["r0"], onChange }}
      />
    );
    const selectedRows = container.querySelectorAll(
      ".virtual-data-table-row--selected"
    );
    expect(selectedRows.length).toBe(1);
    expect((selectedRows[0] as HTMLElement).getAttribute("data-row-key")).toBe(
      "r0"
    );
  });

  it("列虚拟化：宽列数据下，仅渲染部分列而非全部 60 列", () => {
    const columns = makeColumns(60);
    const dataSource = makeRows(10, 60);
    const { container } = render(
      <div style={{ width: "1024px" }}>
        <VirtualDataTable
          columns={columns}
          dataSource={dataSource}
          rowKey={(r) => String(r._key)}
          height={400}
        />
      </div>
    );

    const headerCells = container.querySelectorAll(
      ".virtual-data-table-header > div"
    );
    // 第 0 行 row 内 cell 数 = 渲染的列数（含选择列若有）
    const firstRow = container.querySelector(
      ".virtual-data-table-row"
    ) as HTMLElement;
    const cellsInRow = firstRow ? firstRow.children.length : 0;

    expect(headerCells.length).toBeGreaterThan(0);
    expect(headerCells.length).toBeLessThan(60);
    expect(cellsInRow).toBeGreaterThan(0);
    expect(cellsInRow).toBeLessThan(60);
  });
});
