import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import type { VirtualDataTableColumn } from "../components/table/VirtualDataTable";
import {
  createTableRowSource,
  type TableRowSource,
} from "../components/table/tableRowSource";
import { VirtualDataTable } from "../components/table/VirtualDataTable";

function makeColumns(count: number): VirtualDataTableColumn[] {
  return Array.from({ length: count }, (_, i) => ({
    title: `col_${i}`,
    key: `col_${i}`,
    width: 120,
    renderCell: (rowIndex) => <span>{`v${rowIndex}_${i}`}</span>,
  }));
}

function makeRows(rowCount: number, colCount: number): TableRowSource {
  return createTableRowSource({
    rows: Array.from({ length: rowCount }, (_, r) =>
      Array.from({ length: colCount }, (_, c) => `v${r}_${c}`)
    ),
    columns: Array.from({ length: colCount }, (_, c) => `col_${c}`),
    primaryKeyColumns: [],
    scopeKey: "",
    page: 1,
  });
}

describe("VirtualDataTable", () => {
  it("10000×200 页的固定视口只读取可见单元格，滚动不重新扫描选择键", () => {
    const readColumns = new Set<number>();
    let reads = 0;
    const rows = Array.from(
      { length: 10000 },
      (_, r) =>
        new Proxy(
          Array.from({ length: 200 }, (_, c) => r * 200 + c),
          {
            get(target, key, receiver) {
              if (/^\d+$/.test(String(key)) && key !== "0") {
                reads++;
                readColumns.add(Number(key));
              }
              return Reflect.get(target, key, receiver);
            },
          }
        )
    );
    const names = Array.from({ length: 200 }, (_, i) => `c${i}`);
    const rowSource = createTableRowSource({
      rows,
      columns: names,
      primaryKeyColumns: ["c0"],
      scopeKey: "s",
      page: 1,
    });
    const getRowKey = vi.spyOn(rowSource, "getRowKey");
    const { container } = render(
      <VirtualDataTable
        rowSource={rowSource}
        columns={names.map((key) => ({
          key,
          title: key,
          width: 120,
          renderCell: (index) => String(rowSource.getCell(index, key) ?? ""),
        }))}
        height={400}
        rowSelection={{ selectedRowKeys: [], onChange: vi.fn() }}
      />
    );
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(2000);
    expect(readColumns.has(199)).toBe(false);
    expect(getRowKey.mock.calls.length).toBeLessThan(100);
    getRowKey.mockClear();
    fireEvent.scroll(
      container.querySelector(".virtual-data-table-container")!,
      { target: { scrollTop: 3200 } }
    );
    expect(getRowKey.mock.calls.length).toBeLessThan(100);
  });

  it("窗口变大使内容无需滚动时，恢复被夹断到零仍显示首行首列", () => {
    const columns = makeColumns(20);
    const props = {
      columns,
      rowSource: makeRows(20, 20),

      height: 400,
      testId: "clamped-scroll-table",
      initialScrollPosition: { top: 480, left: 1200 },
      scrollRestoreReady: false,
    };
    const { getByTestId, rerender } = render(<VirtualDataTable {...props} />);
    const table = getByTestId("clamped-scroll-table");
    // jsdom 没有布局：模拟浏览器将超出内容范围的偏移夹断，且值未变时不发 scroll。
    for (const [offset, dimension, viewport] of [
      ["scrollTop", "height", "offsetHeight"],
      ["scrollLeft", "width", "offsetWidth"],
    ] as const) {
      let value = 0;
      Object.defineProperty(table, offset, {
        configurable: true,
        get: () => value,
        set: (next: number) => {
          const content = table.firstElementChild as HTMLElement;
          const max = Math.max(
            0,
            parseFloat(content.style[dimension]) - table[viewport]
          );
          value = Math.max(0, Math.min(next, max));
        },
      });
    }

    rerender(
      <VirtualDataTable
        {...props}
        columns={columns.map((column) => ({ ...column, width: 40 }))}
        height={800}
        scrollRestoreReady
      />
    );

    expect(table.scrollTop).toBe(0);
    expect(table.scrollLeft).toBe(0);
    expect(
      table.querySelector('[data-row-key="page=1|row=0"]')
    ).toBeInTheDocument();
    expect(table).toHaveTextContent("v0_0");
  });

  it("等待目标表数据就绪后恢复滚动，后续渲染不覆盖用户的新位置", () => {
    const columns = makeColumns(20);
    const rowSource = makeRows(100, 20);
    const props = {
      columns,
      rowSource: makeRows(1, 20),

      height: 400,
      testId: "scroll-table",
      initialScrollPosition: { top: 960, left: 600 },
      scrollRestoreReady: false,
    };
    const { getByTestId, rerender } = render(<VirtualDataTable {...props} />);

    rerender(
      <VirtualDataTable {...props} rowSource={rowSource} scrollRestoreReady />
    );
    const table = getByTestId("scroll-table");
    expect(table.scrollTop).toBe(960);
    expect(table.scrollLeft).toBe(600);
    expect(
      table.querySelector('[data-row-key="page=1|row=30"]')
    ).toBeInTheDocument();

    fireEvent.scroll(table, { target: { scrollTop: 1280, scrollLeft: 720 } });
    rerender(
      <VirtualDataTable
        {...props}
        rowSource={rowSource}
        scrollRestoreReady
        height={450}
      />
    );
    expect(table.scrollTop).toBe(1280);
    expect(table.scrollLeft).toBe(720);
    expect(
      table.querySelector('[data-row-key="page=1|row=40"]')
    ).toBeInTheDocument();
  });

  it("基本渲染：列头 / 数据 cell / 空数据占位", () => {
    const columns = makeColumns(3);
    const rowSource = makeRows(2, 3);
    const { container, getByText, rerender, queryByText } = render(
      <VirtualDataTable columns={columns} rowSource={rowSource} height={400} />
    );

    expect(getByText("col_0")).toBeInTheDocument();
    expect(getByText("col_1")).toBeInTheDocument();
    expect(getByText("v0_0")).toBeInTheDocument();
    expect(getByText("v1_2")).toBeInTheDocument();
    expect(container.querySelectorAll(".virtual-data-table-row").length).toBe(
      2
    );

    rerender(
      <VirtualDataTable
        columns={columns}
        rowSource={makeRows(0, 3)}
        height={400}
      />
    );
    expect(queryByText("v0_0")).not.toBeInTheDocument();
    expect(getByText("暂无数据")).toBeInTheDocument();
  });

  it("rowSelection: 行勾选切换、全选/取消全选", () => {
    const onChange = vi.fn();
    const columns = makeColumns(2);
    const rowSource = makeRows(3, 2);
    const { container, rerender } = render(
      <VirtualDataTable
        columns={columns}
        rowSource={rowSource}
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
    expect(onChange).toHaveBeenCalledWith([
      "page=1|row=0",
      "page=1|row=1",
      "page=1|row=2",
    ]);

    rerender(
      <VirtualDataTable
        columns={columns}
        rowSource={rowSource}
        height={400}
        rowSelection={{
          selectedRowKeys: ["page=1|row=0", "page=1|row=1", "page=1|row=2"],
          onChange,
        }}
      />
    );
    fireEvent.click(headerCheckbox);
    expect(onChange).toHaveBeenLastCalledWith([]);

    onChange.mockClear();
    rerender(
      <VirtualDataTable
        columns={columns}
        rowSource={rowSource}
        height={400}
        rowSelection={{ selectedRowKeys: [], onChange }}
      />
    );
    const rowInputs = Array.from(
      container.querySelectorAll(".virtual-data-table-row .ant-checkbox-input")
    ) as HTMLInputElement[];
    fireEvent.click(rowInputs[1]!);
    expect(onChange).toHaveBeenCalledWith(["page=1|row=1"]);
  });

  it("clientReadOnly 时（不传 rowSelection）不渲染行选择列", () => {
    const columns = makeColumns(2);
    const rowSource = makeRows(2, 2);
    const { container } = render(
      <VirtualDataTable columns={columns} rowSource={rowSource} height={400} />
    );
    expect(
      container.querySelectorAll(
        ".virtual-data-table-header .ant-checkbox-input"
      ).length
    ).toBe(0);
  });

  it("视觉 token：容器上注入 --vdt-* CSS 变量，hover/选中等态由 CSS 驱动", () => {
    const columns = makeColumns(2);
    const rowSource = makeRows(2, 2);
    const { container } = render(
      <VirtualDataTable columns={columns} rowSource={rowSource} height={400} />
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
    const rowSource = makeRows(2, 2);
    const onChange = vi.fn();
    const { container, rerender } = render(
      <VirtualDataTable
        columns={columns}
        rowSource={rowSource}
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
        rowSource={rowSource}
        height={400}
        rowSelection={{ selectedRowKeys: ["page=1|row=0"], onChange }}
      />
    );
    const selectedRows = container.querySelectorAll(
      ".virtual-data-table-row--selected"
    );
    expect(selectedRows.length).toBe(1);
    expect((selectedRows[0] as HTMLElement).getAttribute("data-row-key")).toBe(
      "page=1|row=0"
    );
  });

  it("列虚拟化：宽列数据下，仅渲染部分列而非全部 60 列", () => {
    const columns = makeColumns(60);
    const rowSource = makeRows(10, 60);
    const { container } = render(
      <div style={{ width: "1024px" }}>
        <VirtualDataTable
          columns={columns}
          rowSource={rowSource}
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
