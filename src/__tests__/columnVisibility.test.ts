import { describe, it, expect } from "vitest";
import {
  filterVisibleColumns,
  searchColumns,
} from "../components/table/tableDataUtils";

describe("filterVisibleColumns", () => {
  const mockColumns = [
    { key: "id", title: "ID" },
    { key: "name", title: "Name" },
    { key: "email", title: "Email" },
    { key: "status", title: "Status" },
    { key: "created_at", title: "Created At" },
  ];

  it("隐藏列集合为空时返回所有列", () => {
    const result = filterVisibleColumns(mockColumns, new Set());
    expect(result).toBe(mockColumns);
    expect(result).toHaveLength(5);
  });

  it("隐藏单列后过滤掉该列", () => {
    const hidden = new Set(["email"]);
    const result = filterVisibleColumns(mockColumns, hidden);
    expect(result).toHaveLength(4);
    expect(result.map((c) => c.key)).toEqual([
      "id",
      "name",
      "status",
      "created_at",
    ]);
  });

  it("隐藏多列后过滤掉这些列", () => {
    const hidden = new Set(["email", "status", "created_at"]);
    const result = filterVisibleColumns(mockColumns, hidden);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.key)).toEqual(["id", "name"]);
  });

  it("全部隐藏返回空数组", () => {
    const hidden = new Set(["id", "name", "email", "status", "created_at"]);
    const result = filterVisibleColumns(mockColumns, hidden);
    expect(result).toHaveLength(0);
  });

  it("隐藏不存在的列名不影响结果", () => {
    const hidden = new Set(["nonexistent"]);
    const result = filterVisibleColumns(mockColumns, hidden);
    expect(result).toHaveLength(5);
  });
});

describe("searchColumns", () => {
  const columns = [
    "id",
    "user_name",
    "email",
    "created_at",
    "updated_at",
    "user_status",
    "NAME",
  ];

  it("搜索文本为空时返回所有列", () => {
    expect(searchColumns(columns, "")).toEqual(columns);
  });

  it("按列名子串搜索（不区分大小写）", () => {
    const result = searchColumns(columns, "user");
    expect(result).toEqual(["user_name", "user_status"]);
  });

  it("大小写不敏感搜索", () => {
    const result = searchColumns(columns, "NAME");
    expect(result).toEqual(["user_name", "NAME"]);
  });

  it("搜索 _at 后缀列", () => {
    const result = searchColumns(columns, "_at");
    expect(result).toEqual(["created_at", "updated_at"]);
  });

  it("无匹配返回空数组", () => {
    const result = searchColumns(columns, "zzz");
    expect(result).toEqual([]);
  });

  it("完全匹配列名", () => {
    const result = searchColumns(columns, "email");
    expect(result).toEqual(["email"]);
  });
});

describe("列可见性 Set 操作", () => {
  it("切换列可见性：隐藏 → 显示", () => {
    const hidden = new Set(["email", "status"]);
    hidden.delete("email");
    expect(hidden.has("email")).toBe(false);
    expect(hidden.size).toBe(1);
  });

  it("切换列可见性：显示 → 隐藏", () => {
    const hidden = new Set<string>();
    hidden.add("email");
    expect(hidden.has("email")).toBe(true);
    expect(hidden.size).toBe(1);
  });

  it("全部显示：清空 Set", () => {
    const hidden = new Set(["id", "name", "email"]);
    hidden.clear();
    expect(hidden.size).toBe(0);
  });

  it("全部隐藏：用所有列名初始化 Set", () => {
    const allCols = ["id", "name", "email", "status"];
    const hidden = new Set(allCols);
    expect(hidden.size).toBe(4);
    for (const col of allCols) {
      expect(hidden.has(col)).toBe(true);
    }
  });

  it("对大量列（50+）的性能：Set 操作应该是 O(1)", () => {
    const cols = Array.from({ length: 100 }, (_, i) => `col_${i}`);
    const hidden = new Set(cols.slice(0, 50));
    expect(hidden.size).toBe(50);
    expect(hidden.has("col_0")).toBe(true);
    expect(hidden.has("col_49")).toBe(true);
    expect(hidden.has("col_50")).toBe(false);
  });
});
