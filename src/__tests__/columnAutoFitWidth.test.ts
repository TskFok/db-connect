import { describe, it, expect, beforeEach } from "vitest";
import {
  computeAutoFitColumnWidth,
  columnTitleToString,
  createListColumnAutoFit,
  measureTextWidth,
  resetAutoFitMeasureContext,
} from "../utils/columnAutoFitWidth";
import { RESIZABLE_COL_MIN_WIDTH } from "../components/common/ResizableTableHeaderCell";

describe("columnAutoFitWidth", () => {
  beforeEach(() => {
    resetAutoFitMeasureContext();
  });

  describe("measureTextWidth", () => {
    it("空字符串应返回 0 或 fallback 宽度", () => {
      expect(measureTextWidth("", "12px sans-serif")).toBeGreaterThanOrEqual(0);
    });

    it("较长文本应比短文本宽", () => {
      const short = measureTextWidth("ab", "12px sans-serif");
      const long = measureTextWidth("abcdefghij", "12px sans-serif");
      expect(long).toBeGreaterThanOrEqual(short);
    });
  });

  describe("computeAutoFitColumnWidth", () => {
    it("应取表头与单元格中最宽内容并加 padding", () => {
      const width = computeAutoFitColumnWidth("表名", ["users", "orders_history"], {
        cellPadding: 24,
        headerExtra: 0,
      });
      expect(width).toBeGreaterThan(RESIZABLE_COL_MIN_WIDTH);
    });

    it("应限制在 min/max 范围内", () => {
      const width = computeAutoFitColumnWidth("x", ["y"], {
        min: 100,
        max: 120,
        cellPadding: 0,
        headerExtra: 0,
      });
      expect(width).toBeGreaterThanOrEqual(100);
      expect(width).toBeLessThanOrEqual(120);
    });
  });

  describe("columnTitleToString", () => {
    it("字符串 title 应原样返回", () => {
      expect(columnTitleToString("表名")).toBe("表名");
    });

    it("复杂 ReactNode 应返回 fallback", () => {
      expect(columnTitleToString({ type: "span" }, "默认")).toBe("默认");
    });
  });

  describe("createListColumnAutoFit", () => {
    it("应基于数据源样本计算列宽", () => {
      const getAutoFit = createListColumnAutoFit(
        { name: { title: "名称" } },
        [{ name: "short" }, { name: "very_long_table_name_example" }],
        (record) => record.name,
        { sortableHeaders: true }
      );
      const width = getAutoFit("name");
      expect(width).toBeGreaterThan(RESIZABLE_COL_MIN_WIDTH);
    });

    it("应应用 minWidths 下限", () => {
      const getAutoFit = createListColumnAutoFit(
        { a: { title: "A" } },
        [{ v: "x" }],
        () => "x",
        { minWidths: { a: 200 } }
      );
      expect(getAutoFit("a")).toBeGreaterThanOrEqual(200);
    });
  });
});
