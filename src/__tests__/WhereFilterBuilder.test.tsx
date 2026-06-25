import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WhereFilterBuilder } from "../components/table/WhereFilterBuilder";
import type { WhereFilterConfig } from "../utils/whereFilterUtils";

const columns = ["id", "name", "status"];

describe("WhereFilterBuilder", () => {
  it("点击筛选后不应因 initialFilterRows 回流而重建行（保留焦点）", () => {
    const onFilter = vi.fn();
    const { rerender } = render(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={[]}
        onFilter={onFilter}
      />
    );

    const selects = screen.getAllByRole("combobox");
    // 0=组选择，1=列选择
    fireEvent.mouseDown(selects[1]);
    const option = screen.getByTitle("id");
    fireEvent.click(option);

    const valueInput = screen.getByPlaceholderText("值");
    fireEvent.change(valueInput, { target: { value: "5" } });

    fireEvent.click(screen.getByText("筛选"));

    expect(onFilter).toHaveBeenCalledTimes(1);
    const [clause, filterRows] = onFilter.mock.calls[0];
    expect(clause).toContain("`id`");
    expect(filterRows).toHaveLength(1);

    // 模拟 store 回流：父组件用 onFilter 返回的 filterRows 重新传入 initialFilterRows
    rerender(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={filterRows as WhereFilterConfig[]}
        onFilter={onFilter}
      />
    );

    // 行不应被重建：输入框应保留原有值
    const valueInputAfter = screen.getByPlaceholderText("值");
    expect(valueInputAfter).toBeInTheDocument();
    expect((valueInputAfter as HTMLInputElement).value).toBe("5");
  });

  it("连续两次相同筛选不应重建行（_filterTrigger 机制配合 selfTriggeredRef）", () => {
    const onFilter = vi.fn();
    const { rerender } = render(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={[]}
        onFilter={onFilter}
      />
    );

    // 通过 UI 设置筛选条件
    const selects = screen.getAllByRole("combobox");
    // 0=组选择，1=列选择
    fireEvent.mouseDown(selects[1]);
    fireEvent.click(screen.getByTitle("name"));

    const valueInput = screen.getByPlaceholderText("值");
    fireEvent.change(valueInput, { target: { value: "Alice" } });

    // 第一次筛选
    fireEvent.click(screen.getByText("筛选"));
    expect(onFilter).toHaveBeenCalledTimes(1);
    const [clause1, rows1] = onFilter.mock.calls[0];

    // 模拟 store 回流
    rerender(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={rows1 as WhereFilterConfig[]}
        onFilter={onFilter}
      />
    );

    // 第二次点击筛选（相同条件）
    fireEvent.click(screen.getByText("筛选"));
    expect(onFilter).toHaveBeenCalledTimes(2);
    const [clause2, rows2] = onFilter.mock.calls[1];
    expect(clause2).toBe(clause1);

    // 再次 store 回流，行不应被重建
    rerender(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={rows2 as WhereFilterConfig[]}
        onFilter={onFilter}
      />
    );

    // 输入框值应保持不变
    const valueInputAfter = screen.getByPlaceholderText("值");
    expect((valueInputAfter as HTMLInputElement).value).toBe("Alice");
  });

  it("表切换时 initialFilterRows 外部变更应正常同步行", () => {
    const onFilter = vi.fn();
    const { rerender } = render(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={[]}
        onFilter={onFilter}
      />
    );

    // 模拟切换到另一张有筛选条件的表
    const newRows: WhereFilterConfig[] = [
      { column: "status", operator: "=", value: "1" },
    ];
    rerender(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={newRows}
        onFilter={onFilter}
      />
    );

    const valueInput = screen.getByPlaceholderText("值");
    expect((valueInput as HTMLInputElement).value).toBe("1");
  });

  it("字符串列不填值时筛选应生成 = ''", () => {
    const onFilter = vi.fn();
    const columnTypes = { name: "varchar(50)", id: "bigint", status: "int" };
    render(
      <WhereFilterBuilder
        columns={columns}
        columnTypes={columnTypes}
        initialFilterRows={[]}
        onFilter={onFilter}
      />
    );

    const selects = screen.getAllByRole("combobox");
    // 0=组选择，1=列选择
    fireEvent.mouseDown(selects[1]);
    fireEvent.click(screen.getByTitle("name"));

    const valueInput = screen.getByPlaceholderText("值");
    expect((valueInput as HTMLInputElement).value).toBe("");

    fireEvent.click(screen.getByText("筛选"));

    expect(onFilter).toHaveBeenCalledTimes(1);
    const [clause, filterRows] = onFilter.mock.calls[0];
    expect(clause).toBe("`name` = ''");
    expect(filterRows).toHaveLength(1);
  });

  it("新增条件行默认启用（checkbox 勾选）", () => {
    const onFilter = vi.fn();
    render(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={[]}
        onFilter={onFilter}
      />
    );

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(1);
    expect(checkboxes[0]).toBeChecked();
  });

  it("取消勾选后，该条件不参与筛选", () => {
    const onFilter = vi.fn();
    render(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={[]}
        onFilter={onFilter}
      />
    );

    // 设置筛选条件
    const selects = screen.getAllByRole("combobox");
    // 0=组选择，1=列选择
    fireEvent.mouseDown(selects[1]);
    fireEvent.click(screen.getByTitle("id"));

    const valueInput = screen.getByPlaceholderText("值");
    fireEvent.change(valueInput, { target: { value: "5" } });

    // 取消勾选
    const checkbox = screen.getByRole("checkbox");
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();

    // 点击筛选
    fireEvent.click(screen.getByText("筛选"));

    expect(onFilter).toHaveBeenCalledTimes(1);
    const [clause, filterRows] = onFilter.mock.calls[0];
    // WHERE 子句应为空（禁用的条件不参与构建）
    expect(clause).toBe("");
    // 但 filterRows 应包含该条件（用于持久化和恢复 UI）
    expect(filterRows).toHaveLength(1);
    expect(filterRows[0].enabled).toBe(false);
    expect(filterRows[0].column).toBe("id");
  });

  it("多条件时，仅启用的条件参与筛选", () => {
    const onFilter = vi.fn();
    render(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={[]}
        onFilter={onFilter}
      />
    );

    // 设置第一个条件
    const selects = screen.getAllByRole("combobox");
    // 0=组选择，1=列选择
    fireEvent.mouseDown(selects[1]);
    fireEvent.click(screen.getByTitle("id"));

    const valueInput = screen.getByPlaceholderText("值");
    fireEvent.change(valueInput, { target: { value: "5" } });

    // 添加第二个条件
    fireEvent.click(screen.getByText("添加条件"));

    const allSelects = screen.getAllByRole("combobox");
    // 第 2 行的列选择：第 0 行有 3 个下拉（组/列/操作符），第 1 行从 index=3 开始，列选择是 index=4
    fireEvent.mouseDown(allSelects[4]);
    const nameOptions = screen.getAllByTitle("name");
    fireEvent.click(nameOptions[nameOptions.length - 1]);

    const valueInputs = screen.getAllByPlaceholderText("值");
    fireEvent.change(valueInputs[1], { target: { value: "Alice" } });

    // 禁用第一个条件
    const checkboxes = screen.getAllByRole("checkbox");
    fireEvent.click(checkboxes[0]);

    // 筛选
    fireEvent.click(screen.getByText("筛选"));

    expect(onFilter).toHaveBeenCalledTimes(1);
    const [clause, filterRows] = onFilter.mock.calls[0];
    // 只有 name 条件参与 WHERE（id 条件被禁用）
    expect(clause).toContain("`name`");
    expect(clause).not.toContain("`id`");
    // 两个条件都被持久化
    expect(filterRows).toHaveLength(2);
    expect(filterRows[0].enabled).toBe(false);
    expect(filterRows[1].enabled).toBe(true);
  });

  it("从 initialFilterRows 恢复时应保留 enabled 状态", () => {
    const onFilter = vi.fn();
    const savedRows: WhereFilterConfig[] = [
      { column: "id", operator: "=", value: "5", enabled: false },
      { column: "name", operator: "LIKE", value: "%test%", enabled: true },
    ];
    render(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={savedRows}
        onFilter={onFilter}
      />
    );

    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(2);
    expect(checkboxes[0]).not.toBeChecked();
    expect(checkboxes[1]).toBeChecked();
  });

  it("重新勾选已禁用的条件后应恢复参与筛选", () => {
    const onFilter = vi.fn();
    const savedRows: WhereFilterConfig[] = [
      { column: "id", operator: "=", value: "5", enabled: false },
    ];
    render(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={savedRows}
        onFilter={onFilter}
      />
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).not.toBeChecked();

    // 重新勾选
    fireEvent.click(checkbox);
    expect(checkbox).toBeChecked();

    // 筛选
    fireEvent.click(screen.getByText("筛选"));

    expect(onFilter).toHaveBeenCalledTimes(1);
    const [clause, filterRows] = onFilter.mock.calls[0];
    expect(clause).toContain("`id`");
    expect(filterRows).toHaveLength(1);
    expect(filterRows[0].enabled).toBe(true);
  });

  it("修改组后应参与 OR 分组构建", () => {
    const onFilter = vi.fn();
    render(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={[]}
        onFilter={onFilter}
      />
    );

    // 第 1 行：列 id = 1，保持组 1
    const selects = screen.getAllByRole("combobox");
    fireEvent.mouseDown(selects[1]); // 第 1 行列选择
    fireEvent.click(screen.getByTitle("id"));
    const valueInput = screen.getByPlaceholderText("值");
    fireEvent.change(valueInput, { target: { value: "1" } });

    // 添加第 2 行并改为组 2，列 status = 2
    fireEvent.click(screen.getByText("添加条件"));
    const allSelects = screen.getAllByRole("combobox");
    fireEvent.mouseDown(allSelects[3]); // 第 2 行组选择
    fireEvent.click(screen.getByTitle("组 2"));
    fireEvent.mouseDown(allSelects[4]); // 第 2 行列选择
    const statusOptions = screen.getAllByTitle("status");
    fireEvent.click(statusOptions[statusOptions.length - 1]);
    const inputs = screen.getAllByPlaceholderText("值");
    fireEvent.change(inputs[1], { target: { value: "2" } });

    fireEvent.click(screen.getByText("筛选"));
    expect(onFilter).toHaveBeenCalledTimes(1);
    const [clause, rows] = onFilter.mock.calls[0];
    expect(clause).toContain(" OR ");
    expect(clause).toContain("`id` = 1");
    expect(clause).toContain("`status` = 2");
    expect(rows[0].group).toBe("1");
    expect(rows[1].group).toBe("2");
  });
});
