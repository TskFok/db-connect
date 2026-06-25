import { describe, expect, it } from "vitest";
import { sqlIoProgressPercent } from "../utils/sqlIoProgress";

describe("sqlIoProgressPercent", () => {
  it("total<=0 时应为 undefined", () => {
    expect(sqlIoProgressPercent({ current: 0, total: 0 })).toBeUndefined();
    expect(sqlIoProgressPercent(null)).toBeUndefined();
  });

  it("应按 current/total 计算百分比", () => {
    expect(sqlIoProgressPercent({ current: 1, total: 4 })).toBe(25);
    expect(sqlIoProgressPercent({ current: 4, total: 4 })).toBe(100);
  });
});
