import { describe, it, expect } from "vitest";
import { assertCsvRowWithinLimit, CSV_EXPORT_MAX_ROWS } from "../utils/csvExport";

describe("csvExport（导出行数限制）", () => {
  it("assertCsvRowWithinLimit 超限时抛出", () => {
    expect(() => assertCsvRowWithinLimit(CSV_EXPORT_MAX_ROWS + 1)).toThrow(
      /超过导出上限/
    );
    expect(() => assertCsvRowWithinLimit(CSV_EXPORT_MAX_ROWS)).not.toThrow();
  });
});
