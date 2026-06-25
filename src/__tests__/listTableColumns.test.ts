import { describe, it, expect } from "vitest";
import type { ColumnType } from "antd/es/table";
import {
  buildOrderedListColumns,
  computeListTableScrollX,
  reorderListColumnKeys,
  resolveListColumnOrder,
  resolveListColumnWidth,
} from "../utils/listTableColumns";

describe("resolveListColumnWidth", () => {
  it("持久化值优先于默认值", () => {
    expect(
      resolveListColumnWidth("name", { name: 300 }, { name: 200 })
    ).toBe(300);
  });

  it("无持久化值时使用默认值", () => {
    expect(resolveListColumnWidth("name", {}, { name: 200 })).toBe(200);
  });
});

describe("resolveListColumnOrder", () => {
  const defaults = ["a", "b", "c", "d"];

  it("无持久化顺序时返回默认顺序", () => {
    expect(resolveListColumnOrder(defaults)).toEqual(defaults);
  });

  it("持久化顺序应保留并重排默认列", () => {
    expect(resolveListColumnOrder(defaults, ["c", "a"])).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });

  it("持久化中的未知列应被忽略", () => {
    expect(resolveListColumnOrder(defaults, ["x", "b", "a"])).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
  });
});

describe("reorderListColumnKeys", () => {
  it("应移动列 key", () => {
    expect(reorderListColumnKeys(["a", "b", "c"], "a", "c")).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("无效索引应返回 null", () => {
    expect(reorderListColumnKeys(["a", "b"], "x", "b")).toBeNull();
  });
});

describe("computeListTableScrollX", () => {
  it("应按顺序累加列宽", () => {
    expect(
      computeListTableScrollX(["a", "b"], (key) => (key === "a" ? 100 : 50))
    ).toBe(150);
  });
});

describe("buildOrderedListColumns", () => {
  it("应按顺序注入宽度与 onHeaderCell", () => {
    const defs: Record<string, ColumnType<{ id: number }>> = {
      a: { title: "A", dataIndex: "id" },
      b: { title: "B", dataIndex: "id" },
    };
    const resize = (key: string) => (w: number) => w + key.length;
    const cols = buildOrderedListColumns(
      defs,
      ["b", "a"],
      (key) => (key === "a" ? 120 : 80),
      resize,
      {
        sortableHeaders: true,
        getAutoFitWidth: () => 150,
      }
    );

    expect(cols.map((c) => c.key)).toEqual(["b", "a"]);
    expect(cols[0]?.width).toBe(80);
    const headerProps = cols[0]?.onHeaderCell?.({} as never) as {
      width?: number;
      sortable?: boolean;
      columnKey?: string;
      onAutoFit?: () => void;
    };
    expect(headerProps.width).toBe(80);
    expect(headerProps.sortable).toBe(true);
    expect(headerProps.columnKey).toBe("b");
    expect(typeof headerProps.onAutoFit).toBe("function");
  });
});
