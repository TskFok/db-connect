import type { DatabaseSyncProgress } from "../types";

export function databaseSyncProgressPercent(
  progress: DatabaseSyncProgress | null
): number | undefined {
  if (!progress) return undefined;
  if (progress.phase !== "executing" || progress.total <= 0) return undefined;
  return Math.min(
    100,
    Math.max(0, Math.round((progress.current / progress.total) * 100))
  );
}

export function formatDatabaseSyncProgress(
  progress: DatabaseSyncProgress | null
): string {
  if (!progress) return "正在执行数据库结构同步";
  if (progress.phase === "validating") {
    return "正在校验源端与目标端结构";
  }
  if (progress.phase === "refreshing") {
    return "DDL 已执行完成，正在刷新结构对比";
  }
  return `正在执行 DDL，已完成 ${progress.current} / ${progress.total} 条语句`;
}
