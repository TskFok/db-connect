import { describe, it, expect, beforeEach } from "vitest";
import {
  loadStoredUserTableHeight,
  saveUserTableHeight,
  clampUserTableHeight,
  stabilizeTableSlotHeight,
  isTrustedTableSlotMeasure,
  tableSlotMaxUserHeightOrNull,
  TABLE_SLOT_MEASURE_TRUST_MIN,
} from "../components/table/tableDataUtils";

describe("table 高度持久化工具", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  describe("isTrustedTableSlotMeasure", () => {
    it("过小或无效读数视为不可信", () => {
      expect(isTrustedTableSlotMeasure(0)).toBe(false);
      expect(isTrustedTableSlotMeasure(7)).toBe(false);
      expect(isTrustedTableSlotMeasure(Number.NaN)).toBe(false);
      expect(TABLE_SLOT_MEASURE_TRUST_MIN).toBe(8);
    });
    it("达到阈值视为可信", () => {
      expect(isTrustedTableSlotMeasure(8)).toBe(true);
      expect(isTrustedTableSlotMeasure(420)).toBe(true);
    });
  });

  describe("tableSlotMaxUserHeightOrNull", () => {
    it("slot 未可靠测量时返回 null（避免把 max clamp 成 TABLE_HEIGHT_MIN）", () => {
      expect(tableSlotMaxUserHeightOrNull(0)).toBeNull();
      expect(tableSlotMaxUserHeightOrNull(4)).toBeNull();
    });
    it("可信时返回 slot 高度减去 resize bar 并夹在合法区间", () => {
      expect(tableSlotMaxUserHeightOrNull(500)).toBe(500 - 6);
      expect(tableSlotMaxUserHeightOrNull(8)).toBe(200);
    });
  });

  describe("stabilizeTableSlotHeight", () => {
    it("首帧 prev 为 0 时直接采用测量值", () => {
      expect(stabilizeTableSlotHeight(0, 420)).toBe(420);
    });
    it("变化小于 epsilon 时保持 prev", () => {
      expect(stabilizeTableSlotHeight(400, 400.3)).toBe(400);
    });
    it("变化达到 epsilon 时采用新值", () => {
      expect(stabilizeTableSlotHeight(400, 401)).toBe(401);
    });
  });

  describe("clampUserTableHeight", () => {
    it("低于 200 时夹到 200", () => {
      expect(clampUserTableHeight(50)).toBe(200);
      expect(clampUserTableHeight(0)).toBe(200);
      expect(clampUserTableHeight(-100)).toBe(200);
    });
    it("在合法区间内原样四舍五入", () => {
      expect(clampUserTableHeight(300)).toBe(300);
      expect(clampUserTableHeight(420.7)).toBe(421);
      expect(clampUserTableHeight(199.6)).toBe(200);
    });
    it("超过 4000 时夹到 4000", () => {
      expect(clampUserTableHeight(5000)).toBe(4000);
      expect(clampUserTableHeight(99999)).toBe(4000);
    });
  });

  describe("save / load 往返", () => {
    it("写入后能原值读出", () => {
      saveUserTableHeight(420);
      expect(loadStoredUserTableHeight()).toBe(420);
    });
    it("写入 null 时清除存储", () => {
      saveUserTableHeight(420);
      saveUserTableHeight(null);
      expect(loadStoredUserTableHeight()).toBeNull();
    });
    it("非数值或空 key 返回 null", () => {
      expect(loadStoredUserTableHeight()).toBeNull();
      localStorage.setItem("mysqlc:table-height-px", "not-a-number");
      expect(loadStoredUserTableHeight()).toBeNull();
    });
    it("越界值返回 null（防御历史脏数据）", () => {
      localStorage.setItem("mysqlc:table-height-px", "10");
      expect(loadStoredUserTableHeight()).toBeNull();
      localStorage.setItem("mysqlc:table-height-px", "999999");
      expect(loadStoredUserTableHeight()).toBeNull();
    });
    it("浮点数会被 saveUserTableHeight 转为整数", () => {
      saveUserTableHeight(420.7);
      expect(loadStoredUserTableHeight()).toBe(421);
    });
  });
});
