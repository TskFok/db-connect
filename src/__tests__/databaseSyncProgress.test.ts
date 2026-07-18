import { describe, expect, it } from "vitest";
import type { DatabaseSyncProgress } from "../types";
import {
  databaseSyncProgressPercent,
  formatDatabaseSyncProgress,
} from "../utils/databaseSyncProgress";

function progress(
  phase: DatabaseSyncProgress["phase"],
  current: number,
  total: number
): DatabaseSyncProgress {
  return {
    plan_fingerprint: "fingerprint",
    phase,
    current,
    total,
  };
}

describe("databaseSyncProgress", () => {
  it("校验和无事件状态使用不确定进度文案", () => {
    expect(databaseSyncProgressPercent(null)).toBeUndefined();
    expect(formatDatabaseSyncProgress(null)).toBe(
      "正在执行数据库结构同步"
    );
    expect(
      formatDatabaseSyncProgress(progress("validating", 0, 0))
    ).toBe("正在校验源端与目标端结构");
  });

  it("执行阶段按真实语句数计算并限制百分比", () => {
    expect(databaseSyncProgressPercent(progress("executing", 1, 4))).toBe(25);
    expect(databaseSyncProgressPercent(progress("executing", 5, 4))).toBe(100);
    expect(
      databaseSyncProgressPercent(progress("executing", 0, 0))
    ).toBeUndefined();
    expect(formatDatabaseSyncProgress(progress("executing", 2, 4))).toBe(
      "正在执行 DDL，已完成 2 / 4 条语句"
    );
  });

  it("刷新阶段显示 DDL 已完成", () => {
    expect(
      databaseSyncProgressPercent(progress("refreshing", 4, 4))
    ).toBeUndefined();
    expect(formatDatabaseSyncProgress(progress("refreshing", 4, 4))).toBe(
      "DDL 已执行完成，正在刷新结构对比"
    );
  });
});
