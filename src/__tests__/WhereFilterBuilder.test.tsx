import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { Modal } from "antd";
import { WhereFilterBuilder } from "../components/table/WhereFilterBuilder";
import type { WhereFilterConfig } from "../utils/whereFilterUtils";

const columns = ["id", "name", "status"];

function editValue(value: string, rowIndex = 0) {
  fireEvent.click(
    screen.getAllByRole("button", { name: "编辑筛选值" })[rowIndex]
  );
  const dialog = screen.getByRole("dialog", { name: "编辑筛选值" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "值" }), {
    target: { value },
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "确 定" }));
}

describe("WhereFilterBuilder", () => {
  it.each([
    ["Command + Enter", { metaKey: true }, false],
    ["Ctrl + Enter", { ctrlKey: true }, false],
    ["鼠标", { metaKey: true }, true],
  ])("%s 确认筛选值后可从实际焦点快捷保存", async (_, modifier, clickConfirm) => {
    const onFilter = vi.fn();
    const primaryButtonRef = createRef<HTMLButtonElement>();
    render(
      <Modal
        open
        title="筛选"
        footer={null}
        afterOpenChange={(visible) => {
          if (visible) primaryButtonRef.current?.focus();
        }}
      >
        <WhereFilterBuilder
          columns={columns}
          initialFilterRows={[{ column: "name", operator: "=", value: "原值" }]}
          primaryButtonText="保存并应用"
          primaryButtonRef={primaryButtonRef}
          onFilter={onFilter}
        />
      </Modal>
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /保存并应用/ })).toHaveFocus();
    });

    // 模拟 macOS WebKit：鼠标点击按钮不会自动将焦点放到按钮上。
    primaryButtonRef.current?.blur();
    const editButton = screen.getByRole("button", { name: "编辑筛选值" });
    fireEvent.click(editButton);
    const input = screen.getByRole("textbox", { name: "值" });
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: "已修改\n第二行" } });
    if (clickConfirm) {
      fireEvent.click(screen.getByRole("button", { name: "确 定" }));
    } else {
      expect(
        fireEvent.keyDown(document.activeElement!, { key: "Enter", ...modifier })
      ).toBe(false);
    }

    expect(
      screen.queryByRole("dialog", { name: "编辑筛选值" })
    ).not.toBeInTheDocument();
    expect(onFilter).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "编辑筛选值" })).toHaveTextContent(
      "已修改 第二行"
    );

    await waitFor(() => expect(editButton).toHaveFocus());
    fireEvent.keyDown(document.activeElement!, {
      key: "Enter",
      ...modifier,
    });
    expect(onFilter).toHaveBeenCalledTimes(1);
    expect(onFilter.mock.calls[0][1]).toEqual([
      {
        column: "name",
        operator: "=",
        value: "已修改\n第二行",
        enabled: true,
        group: "1",
      },
    ]);
  });

  it.each(["起始值", "结束值"])(
    "在范围筛选的%s中按 Command + Enter 会同时确认两个值",
    (inputName) => {
      const onFilter = vi.fn();
      render(
        <WhereFilterBuilder
          columns={columns}
          initialFilterRows={[
            { column: "id", operator: "BETWEEN", value: "1", value2: "9" },
          ]}
          onFilter={onFilter}
        />
      );
      fireEvent.click(screen.getByRole("button", { name: "编辑筛选值" }));
      fireEvent.change(screen.getByRole("textbox", { name: "起始值" }), {
        target: { value: "10" },
      });
      fireEvent.change(screen.getByRole("textbox", { name: "结束值" }), {
        target: { value: "99" },
      });
      fireEvent.keyDown(screen.getByRole("textbox", { name: inputName }), {
        key: "Enter",
        metaKey: true,
      });
      expect(
        screen.queryByRole("dialog", { name: "编辑筛选值" })
      ).not.toBeInTheDocument();
      expect(onFilter).not.toHaveBeenCalled();
      fireEvent.click(screen.getByText("筛选"));
      expect(onFilter.mock.calls[0][0]).toBe("`id` BETWEEN 10 AND 99");
    }
  );

  it.each([
    ["输入法组合输入", { isComposing: true }],
    ["输入法兼容键码", { keyCode: 229 }],
    ["长按自动重复", { repeat: true }],
  ])("%s时 Command + Enter 不确认值或保存条件", (_, keyboardState) => {
    const onFilter = vi.fn();
    render(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={[{ column: "name", operator: "=", value: "原值" }]}
        primaryButtonText="保存并应用"
        onFilter={onFilter}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑筛选值" }));
    const input = screen.getByRole("textbox", { name: "值" });
    fireEvent.change(input, { target: { value: "草稿" } });
    fireEvent.keyDown(input, {
      key: "Enter",
      metaKey: true,
      ...keyboardState,
    });
    expect(screen.getByRole("dialog", { name: "编辑筛选值" })).toBeInTheDocument();
    expect(onFilter).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "确 定" }));
    fireEvent.keyDown(screen.getByRole("button", { name: /保存并应用/ }), {
      key: "Enter",
      metaKey: true,
      ...keyboardState,
    });
    expect(onFilter).not.toHaveBeenCalled();
  });

  it("弹窗确认后回填长文本，输入换行不会提前应用筛选", () => {
    const onFilter = vi.fn();
    render(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={[{ column: "name", operator: "=", value: "原值" }]}
        onFilter={onFilter}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑筛选值" }));
    const dialog = screen.getByRole("dialog", { name: "编辑筛选值" });
    const input = within(dialog).getByRole("textbox", { name: "值" });
    expect(input).toHaveValue("原值");
    const value = "较长的筛选内容".repeat(30) + "\n第二行内容";
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(onFilter).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "确 定" }));
    expect(onFilter).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("筛选"));
    expect(onFilter.mock.calls[0][1][0].value).toBe(value);
    fireEvent.click(screen.getByRole("button", { name: "编辑筛选值" }));
    expect(screen.getByRole("textbox", { name: "值" })).toHaveValue(value);
  });

  it("取消弹窗丢弃草稿，重新打开仍显示原值", () => {
    const onFilter = vi.fn();
    render(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={[{ column: "name", operator: "=", value: "原值" }]}
        onFilter={onFilter}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑筛选值" }));
    fireEvent.change(screen.getByRole("textbox", { name: "值" }), {
      target: { value: "未保存的草稿" },
    });
    fireEvent.click(screen.getByRole("button", { name: "取 消" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑筛选值" }));
    expect(screen.getByRole("textbox", { name: "值" })).toHaveValue("原值");
    fireEvent.click(screen.getByRole("button", { name: "取 消" }));
    fireEvent.click(screen.getByText("筛选"));
    expect(onFilter.mock.calls[0][0]).toBe("`name` = '原值'");
  });

  it("范围筛选在同一弹窗保存起始值和结束值", () => {
    const onFilter = vi.fn();
    render(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={[
          { column: "id", operator: "BETWEEN", value: "1", value2: "9" },
        ]}
        onFilter={onFilter}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "编辑筛选值" }));
    expect(screen.getByRole("textbox", { name: "起始值" })).toHaveValue("1");
    expect(screen.getByRole("textbox", { name: "结束值" })).toHaveValue("9");
    fireEvent.change(screen.getByRole("textbox", { name: "起始值" }), {
      target: { value: "10" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "结束值" }), {
      target: { value: "99" },
    });
    fireEvent.click(screen.getByRole("button", { name: "确 定" }));
    fireEvent.click(screen.getByText("筛选"));
    expect(onFilter.mock.calls[0][0]).toBe("`id` BETWEEN 10 AND 99");
    expect(onFilter.mock.calls[0][1][0]).toMatchObject({
      value: "10",
      value2: "99",
    });
  });

  it("切换表时关闭旧值弹窗，丢弃未确认的草稿", () => {
    const onFilter = vi.fn();
    const { rerender } = render(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={[{ column: "name", operator: "=", value: "原值" }]}
        onFilter={onFilter}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑筛选值" }));
    fireEvent.change(screen.getByRole("textbox", { name: "值" }), {
      target: { value: "旧表草稿" },
    });

    rerender(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={[{ column: "status", operator: "=", value: "2" }]}
        onFilter={onFilter}
      />
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "编辑筛选值" }));
    expect(screen.getByRole("textbox", { name: "值" })).toHaveValue("2");
  });

  it("嵌套弹窗按 Escape 只取消值编辑，外层仍可应用原值", () => {
    const onFilter = vi.fn();
    const onOuterCancel = vi.fn();
    render(
      <Modal open title="筛选" footer={null} onCancel={onOuterCancel}>
        <WhereFilterBuilder
          columns={columns}
          initialFilterRows={[{ column: "name", operator: "=", value: "原值" }]}
          primaryButtonText="保存并应用"
          onFilter={onFilter}
        />
      </Modal>
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑筛选值" }));
    const input = screen.getByRole("textbox", { name: "值" });
    fireEvent.change(input, { target: { value: "未保存" } });
    fireEvent.keyDown(input, { key: "Escape", code: "Escape", keyCode: 27 });
    expect(
      screen.queryByRole("dialog", { name: "编辑筛选值" })
    ).not.toBeInTheDocument();
    expect(onOuterCancel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("保存并应用"));
    expect(onFilter.mock.calls[0][0]).toBe("`name` = '原值'");
  });

  it("弹窗清空已保存的字符串值后仍可筛选空字符串", () => {
    const onFilter = vi.fn();
    render(
      <WhereFilterBuilder
        columns={columns}
        columnTypes={{ name: "varchar(50)" }}
        initialFilterRows={[{ column: "name", operator: "=", value: "原值" }]}
        onFilter={onFilter}
      />
    );
    editValue("");
    fireEvent.click(screen.getByText("筛选"));
    expect(onFilter.mock.calls[0][0]).toBe("`name` = ''");
  });

  it("逗号分隔的多行列表仍按 IN 筛选", () => {
    const onFilter = vi.fn();
    render(
      <WhereFilterBuilder
        columns={columns}
        initialFilterRows={[{ column: "id", operator: "IN", value: "" }]}
        onFilter={onFilter}
      />
    );
    editValue("1,\n2,\n3");
    fireEvent.click(screen.getByText("筛选"));
    expect(onFilter.mock.calls[0][0]).toBe("`id` IN (1, 2, 3)");
  });

  it.each(["IS NULL", "IS NOT NULL"] as const)(
    "%s 不显示值编辑入口",
    (operator) => {
      const onFilter = vi.fn();
      render(
        <WhereFilterBuilder
          columns={columns}
          initialFilterRows={[{ column: "name", operator, value: "" }]}
          onFilter={onFilter}
        />
      );
      expect(
        screen.queryByRole("button", { name: "编辑筛选值" })
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByText("筛选"));
      expect(onFilter.mock.calls[0][0]).toBe(`\`name\` ${operator}`);
    }
  );

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

    editValue("5");
    const valueButton = screen.getByRole("button", { name: "编辑筛选值" });

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

    // 行不应被重建：入口保留同一 DOM 节点及原有值
    const valueButtonAfter = screen.getByRole("button", { name: "编辑筛选值" });
    expect(valueButtonAfter).toBe(valueButton);
    expect(valueButtonAfter).toHaveTextContent("5");
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

    editValue("Alice");
    const valueButton = screen.getByRole("button", { name: "编辑筛选值" });

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

    // 编辑入口和已确认的值应保持不变
    const valueButtonAfter = screen.getByRole("button", { name: "编辑筛选值" });
    expect(valueButtonAfter).toBe(valueButton);
    expect(valueButtonAfter).toHaveTextContent("Alice");
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

    expect(
      screen.getByRole("button", { name: "编辑筛选值" })
    ).toHaveTextContent("1");
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

    expect(
      screen.getByRole("button", { name: "编辑筛选值" })
    ).toHaveTextContent("点击输入值");

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

    editValue("5");

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

    editValue("5");

    // 添加第二个条件
    fireEvent.click(screen.getByText("添加条件"));

    const allSelects = screen.getAllByRole("combobox");
    // 第 2 行的列选择：第 0 行有 3 个下拉（组/列/操作符），第 1 行从 index=3 开始，列选择是 index=4
    fireEvent.mouseDown(allSelects[4]);
    const nameOptions = screen.getAllByTitle("name");
    fireEvent.click(nameOptions[nameOptions.length - 1]);

    editValue("Alice", 1);

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
    editValue("1");

    // 添加第 2 行并改为组 2，列 status = 2
    fireEvent.click(screen.getByText("添加条件"));
    const allSelects = screen.getAllByRole("combobox");
    fireEvent.mouseDown(allSelects[3]); // 第 2 行组选择
    fireEvent.click(screen.getByTitle("组 2"));
    fireEvent.mouseDown(allSelects[4]); // 第 2 行列选择
    const statusOptions = screen.getAllByTitle("status");
    fireEvent.click(statusOptions[statusOptions.length - 1]);
    editValue("2", 1);

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
