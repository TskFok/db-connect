import { describe, it, expect } from "vitest";
import {
  ANT_TABLE_HEADER_HEIGHT_SMALL,
  computeAntTableScrollY,
} from "../utils/antTableLayout";

describe("antTableLayout", () => {
  it("容器未布局完成时返回 undefined", () => {
    expect(computeAntTableScrollY(0)).toBeUndefined();
    expect(computeAntTableScrollY(4)).toBeUndefined();
  });

  it("应减去表头高度", () => {
    expect(computeAntTableScrollY(400)).toBe(400 - ANT_TABLE_HEADER_HEIGHT_SMALL);
  });

  it("容器较小时严格跟随可用高度，避免表体溢出", () => {
    expect(computeAntTableScrollY(60)).toBe(60 - ANT_TABLE_HEADER_HEIGHT_SMALL);
  });
});
