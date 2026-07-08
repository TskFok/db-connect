import { describe, it, expect, vi } from "vitest";
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  normalizeValue,
  displayVal,
  isLongFieldValue,
  LONG_TEXT_MODAL_MIN_LEN,
  visualizeInvisibleChars,
} from "../components/table/tableDataUtils";
import { EditableCell } from "../components/table/EditableCell";
import type { PendingChange } from "../stores/tableDataStore";

describe("normalizeValue", () => {
  it("空字符串且原值为 null → 保持 null", () => {
    expect(normalizeValue("", null)).toBe(null);
  });

  it("空字符串且原值非 null → 返回空字符串", () => {
    expect(normalizeValue("", "hello")).toBe("");
  });

  it("原值为字符串时保持字符串，不做数字化", () => {
    expect(normalizeValue("42", "old")).toBe("42");
  });

  it("原值为字符串且有前导 0 时保持原文本", () => {
    expect(normalizeValue("0200046921690429", "0200046921690429")).toBe(
      "0200046921690429"
    );
  });

  it("浮点数字符串 → 返回数字", () => {
    expect(normalizeValue("3.14", 0)).toBe(3.14);
  });

  it("负数字符串 → 返回数字", () => {
    expect(normalizeValue("-10", 0)).toBe(-10);
  });

  it("非数字字符串 → 返回原字符串", () => {
    expect(normalizeValue("hello", "old")).toBe("hello");
  });

  it("纯空格字符串 → JS Number(' ')=0, 返回数字 0", () => {
    expect(normalizeValue("  ", null)).toBe(0);
  });

  it("零字符串 → 返回数字 0", () => {
    expect(normalizeValue("0", 1)).toBe(0);
  });

  it("原值为数字, 新输入也是数字 → 返回数字", () => {
    expect(normalizeValue("100", 50)).toBe(100);
  });

  it("原值为数字, 新输入是文字 → 返回文字", () => {
    expect(normalizeValue("abc", 50)).toBe("abc");
  });

  it("超出 Number 安全范围的大整数 → 保留为字符串，避免精度丢失", () => {
    expect(normalizeValue("3258946454736595494", 0)).toBe(
      "3258946454736595494"
    );
    expect(normalizeValue("9007199254740992", 0)).toBe("9007199254740992");
  });

  it("在 Number 安全范围内的整数 → 转为数字", () => {
    expect(normalizeValue("9007199254740991", 0)).toBe(9007199254740991);
    expect(normalizeValue("9007199254740990", 0)).toBe(9007199254740990);
  });

  it("forceString 时 varchar/text 列整段按字符串提交（含超安全范围大整数）", () => {
    const id = "98860078801500001234";
    expect(normalizeValue(id, 0, { forceString: true })).toBe(id);
    expect(normalizeValue("42", 0, { forceString: true })).toBe("42");
    expect(normalizeValue("100", 50, { forceString: true })).toBe("100");
  });
});

describe("PendingChange 数据结构", () => {
  it("可以正确构造一条待提交修改", () => {
    const change: PendingChange = {
      rowKey: 0,
      colName: "name",
      oldValue: "Alice",
      newValue: "Bob",
      primaryKeys: { id: 1 },
    };
    expect(change.rowKey).toBe(0);
    expect(change.colName).toBe("name");
    expect(change.oldValue).toBe("Alice");
    expect(change.newValue).toBe("Bob");
    expect(change.primaryKeys).toEqual({ id: 1 });
  });

  it("支持 null 值", () => {
    const change: PendingChange = {
      rowKey: 2,
      colName: "email",
      oldValue: null,
      newValue: "test@example.com",
      primaryKeys: { id: 3 },
    };
    expect(change.oldValue).toBeNull();
    expect(change.newValue).toBe("test@example.com");
  });

  it("支持复合主键", () => {
    const change: PendingChange = {
      rowKey: 1,
      colName: "status",
      oldValue: 0,
      newValue: 1,
      primaryKeys: { user_id: 10, order_id: 20 },
    };
    expect(Object.keys(change.primaryKeys)).toHaveLength(2);
    expect(change.primaryKeys.user_id).toBe(10);
    expect(change.primaryKeys.order_id).toBe(20);
  });

  it("可以用 Map 管理多条修改, key 为 rowKey:colName", () => {
    const changes = new Map<string, PendingChange>();

    changes.set("0:name", {
      rowKey: 0,
      colName: "name",
      oldValue: "Alice",
      newValue: "Bob",
      primaryKeys: { id: 1 },
    });
    changes.set("0:email", {
      rowKey: 0,
      colName: "email",
      oldValue: "alice@test.com",
      newValue: "bob@test.com",
      primaryKeys: { id: 1 },
    });
    changes.set("1:name", {
      rowKey: 1,
      colName: "name",
      oldValue: "Charlie",
      newValue: "David",
      primaryKeys: { id: 2 },
    });

    expect(changes.size).toBe(3);
    expect(changes.get("0:name")?.newValue).toBe("Bob");
    expect(changes.get("0:email")?.newValue).toBe("bob@test.com");
    expect(changes.get("1:name")?.newValue).toBe("David");

    // 删除一条
    changes.delete("0:email");
    expect(changes.size).toBe(2);
    expect(changes.has("0:email")).toBe(false);

    // 更新一条的新值
    const existing = changes.get("0:name")!;
    changes.set("0:name", { ...existing, newValue: "Eve" });
    expect(changes.get("0:name")?.newValue).toBe("Eve");

    // 如果新值等于旧值应该删除
    const item = changes.get("1:name")!;
    if (item.newValue === item.oldValue) {
      changes.delete("1:name");
    }
    expect(changes.size).toBe(2); // 没删因为 David !== Charlie
  });
});

describe("displayVal", () => {
  it("null 显示为 NULL", () => {
    expect(displayVal(null)).toBe("NULL");
  });

  it("空字符串显示为 (空字符串)", () => {
    expect(displayVal("")).toBe("(空字符串)");
  });

  it("数字转为字符串", () => {
    expect(displayVal(42)).toBe("42");
    expect(displayVal(3.14)).toBe("3.14");
  });

  it("普通字符串原样返回", () => {
    expect(displayVal("hello")).toBe("hello");
  });

  it("undefined 转为字符串", () => {
    expect(displayVal(undefined)).toBe("undefined");
  });

  it("布尔值转为字符串", () => {
    expect(displayVal(true)).toBe("true");
    expect(displayVal(false)).toBe("false");
  });
});

describe("visualizeInvisibleChars", () => {
  it("可将常见不可见字符渲染为可见符号", () => {
    expect(visualizeInvisibleChars("a b\tc\nd\r")).toBe("a␠b⇥c↵d␍");
  });

  it("可识别零宽和 BOM 字符", () => {
    expect(visualizeInvisibleChars(`x\u200By\uFEFFz`)).toBe("x⟪ZWSP⟫y⟪BOM⟫z");
  });
});

describe("isLongFieldValue", () => {
  it("null/undefined 为短字段", () => {
    expect(isLongFieldValue(null)).toBe(false);
    expect(isLongFieldValue(undefined)).toBe(false);
  });

  it("长度不超过阈值则非长字段", () => {
    expect(isLongFieldValue("a".repeat(LONG_TEXT_MODAL_MIN_LEN))).toBe(false);
  });

  it("长度超过阈值则为长字段", () => {
    expect(isLongFieldValue("a".repeat(LONG_TEXT_MODAL_MIN_LEN + 1))).toBe(
      true
    );
  });
});

describe("EditableCell", () => {
  it("渲染普通值时显示字符串形式", () => {
    const onEdit = vi.fn();
    render(
      React.createElement(EditableCell, {
        value: "hello",
        pendingValue: undefined,
        hasPending: false,
        onEdit,
      })
    );
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByTitle("双击编辑")).toBeInTheDocument();
  });

  it("传入 displayText 时应优先显示可视化文本", () => {
    const onEdit = vi.fn();
    render(
      React.createElement(EditableCell, {
        value: "a b",
        pendingValue: undefined,
        hasPending: false,
        displayText: "a␠b",
        onEdit,
      })
    );
    expect(screen.getByText("a␠b")).toBeInTheDocument();
    expect(screen.queryByText("a b")).not.toBeInTheDocument();
  });

  it("渲染 null 时显示 NULL（斜体样式）", () => {
    const onEdit = vi.fn();
    render(
      React.createElement(EditableCell, {
        value: null,
        pendingValue: undefined,
        hasPending: false,
        onEdit,
      })
    );
    expect(screen.getByText("NULL")).toBeInTheDocument();
  });

  it("hasPending 为 true 时显示 pendingValue", () => {
    const onEdit = vi.fn();
    render(
      React.createElement(EditableCell, {
        value: "original",
        pendingValue: "edited",
        hasPending: true,
        onEdit,
      })
    );
    expect(screen.getByText("edited")).toBeInTheDocument();
    expect(screen.queryByText("original")).not.toBeInTheDocument();
  });

  it("hasPending 为 false 时显示 value", () => {
    const onEdit = vi.fn();
    render(
      React.createElement(EditableCell, {
        value: "original",
        pendingValue: "edited",
        hasPending: false,
        onEdit,
      })
    );
    expect(screen.getByText("original")).toBeInTheDocument();
  });

  it("双击进入编辑模式，显示 Input", () => {
    const onEdit = vi.fn();
    render(
      React.createElement(EditableCell, {
        value: "hello",
        pendingValue: undefined,
        hasPending: false,
        onEdit,
      })
    );
    const div = screen.getByTitle("双击编辑");
    fireEvent.doubleClick(div);
    // 进入编辑后应显示 input
    const input = document.querySelector('input[type="text"]');
    expect(input).toBeInTheDocument();
    expect((input as HTMLInputElement).value).toBe("hello");
  });

  it("极长文本双击打开弹窗 TextArea，确定后调用 onEdit", () => {
    const onEdit = vi.fn();
    const longVal = "x".repeat(LONG_TEXT_MODAL_MIN_LEN + 5);
    render(
      React.createElement(EditableCell, {
        value: longVal,
        pendingValue: undefined,
        hasPending: false,
        onEdit,
        fieldLabel: "body",
      })
    );
    fireEvent.doubleClick(screen.getByTitle("双击编辑"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("编辑：body")).toBeInTheDocument();

    const ta = document.querySelector("textarea");
    expect(ta).toBeInTheDocument();
    expect(ta).toHaveValue(longVal);

    fireEvent.change(ta!, { target: { value: `${longVal}Z` } });
    fireEvent.click(screen.getByRole("button", { name: "确 定" }));

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledWith(`${longVal}Z`);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("极长文本非编辑态只渲染预览，弹窗编辑仍保留完整值", () => {
    const onEdit = vi.fn();
    const longVal = "x".repeat(5000);
    render(
      React.createElement(EditableCell, {
        value: longVal,
        pendingValue: undefined,
        hasPending: false,
        onEdit,
        fieldLabel: "body",
      })
    );

    const cell = screen.getByTitle("双击编辑");
    expect(cell.textContent).not.toBe(longVal);
    expect((cell.textContent ?? "").length).toBeLessThan(longVal.length);

    fireEvent.doubleClick(cell);
    expect(screen.getByDisplayValue(longVal)).toBeInTheDocument();
  });

  it("极长文本弹窗点击取消不调用 onEdit", () => {
    const onEdit = vi.fn();
    const longVal = "y".repeat(LONG_TEXT_MODAL_MIN_LEN + 1);
    render(
      React.createElement(EditableCell, {
        value: longVal,
        pendingValue: undefined,
        hasPending: false,
        onEdit,
      })
    );
    fireEvent.doubleClick(screen.getByTitle("双击编辑"));
    fireEvent.change(document.querySelector("textarea")!, {
      target: { value: "changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "取 消" }));
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("编辑后按 Enter 调用 onEdit 并退出编辑模式", () => {
    const onEdit = vi.fn();
    render(
      React.createElement(EditableCell, {
        value: "hello",
        pendingValue: undefined,
        hasPending: false,
        onEdit,
      })
    );
    fireEvent.doubleClick(screen.getByTitle("双击编辑"));
    const input = document.querySelector('input[type="text"]')!;
    fireEvent.change(input, { target: { value: "world" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEdit).toHaveBeenCalledWith("world");
    // 退出编辑后应显示单元格（孤立测试中 value 不变，显示原值）
    expect(screen.getByTitle("双击编辑")).toBeInTheDocument();
  });

  it("编辑后 blur 调用 onEdit", () => {
    const onEdit = vi.fn();
    render(
      React.createElement(EditableCell, {
        value: 100,
        pendingValue: undefined,
        hasPending: false,
        onEdit,
      })
    );
    fireEvent.doubleClick(screen.getByTitle("双击编辑"));
    const input = document.querySelector('input[type="text"]')!;
    fireEvent.change(input, { target: { value: "200" } });
    fireEvent.blur(input);
    expect(onEdit).toHaveBeenCalledWith(200);
  });

  it("forceStringSemantics 时提交整数字符串为 string，不向 Number 转换", () => {
    const onEdit = vi.fn();
    render(
      React.createElement(EditableCell, {
        value: 100,
        pendingValue: undefined,
        hasPending: false,
        onEdit,
        forceStringSemantics: true,
      })
    );
    fireEvent.doubleClick(screen.getByTitle("双击编辑"));
    const input = document.querySelector('input[type="text"]')!;
    fireEvent.change(input, { target: { value: "200" } });
    fireEvent.blur(input);
    expect(onEdit).toHaveBeenCalledWith("200");
  });

  it("按 Escape 取消编辑，不调用 onEdit", () => {
    const onEdit = vi.fn();
    render(
      React.createElement(EditableCell, {
        value: "hello",
        pendingValue: undefined,
        hasPending: false,
        onEdit,
      })
    );
    fireEvent.doubleClick(screen.getByTitle("双击编辑"));
    const input = document.querySelector('input[type="text"]')!;
    fireEvent.change(input, { target: { value: "modified" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onEdit).not.toHaveBeenCalled();
    // 取消后应恢复显示原值
    expect(screen.getByText("hello")).toBeInTheDocument();
  });

  it("空输入且原值为 null 时 onEdit 收到 null", () => {
    const onEdit = vi.fn();
    render(
      React.createElement(EditableCell, {
        value: null,
        pendingValue: undefined,
        hasPending: false,
        onEdit,
      })
    );
    fireEvent.doubleClick(screen.getByTitle("双击编辑"));
    const input = document.querySelector('input[type="text"]')!;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onEdit).toHaveBeenCalledWith(null);
  });

  it("编辑模式下按 Tab 调用 onEdit (完成编辑)", () => {
    const onEdit = vi.fn();
    render(
      React.createElement(EditableCell, {
        value: "hello",
        pendingValue: undefined,
        hasPending: false,
        onEdit,
      })
    );
    fireEvent.doubleClick(screen.getByTitle("双击编辑"));
    const input = document.querySelector('input[type="text"]')!;
    fireEvent.change(input, { target: { value: "tabbed" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onEdit).toHaveBeenCalledWith("tabbed");
  });

  it("Tab 导航后 blur 不会重复调用 onEdit", () => {
    const onEdit = vi.fn();
    render(
      React.createElement(EditableCell, {
        value: "hello",
        pendingValue: undefined,
        hasPending: false,
        onEdit,
      })
    );
    fireEvent.doubleClick(screen.getByTitle("双击编辑"));
    const input = document.querySelector('input[type="text"]')!;
    fireEvent.change(input, { target: { value: "tabbed" } });
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.blur(input);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("readOnly 为 true 时双击不进入编辑且 title 提示只读", () => {
    const onEdit = vi.fn();
    render(
      React.createElement(EditableCell, {
        value: "x",
        pendingValue: undefined,
        hasPending: false,
        onEdit,
        readOnly: true,
      })
    );
    fireEvent.doubleClick(screen.getByTitle("当前为只读连接，无法编辑单元格"));
    expect(onEdit).not.toHaveBeenCalled();
    expect(document.querySelector('input[type="text"]')).toBeNull();
  });
});
