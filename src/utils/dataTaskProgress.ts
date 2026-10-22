/** IPC 的计数和 sequence 始终以十进制字符串比较，避免 Number 精度损失。 */
export function isNewerDataTaskSequence(
  incoming: string,
  previous: string
): boolean {
  return (
    /^\d+$/.test(incoming) &&
    /^\d+$/.test(previous) &&
    BigInt(incoming) > BigInt(previous)
  );
}
export function formatDataCount(value: string): string {
  return /^\d+$/.test(value) ? BigInt(value).toLocaleString("en-US") : "—";
}
const labels: Record<string, string> = {
  created: "任务已创建",
  validating: "正在预检",
  reading: "正在读取快照",
  comparing: "正在比较行差异",
  ready: "预览已就绪",
  executing: "正在写入目标",
  verifying: "正在验证目标数据",
  committing: "正在确认提交结果",
  cancelling: "正在取消，等待回滚",
  cancelled: "已取消",
  succeeded: "已成功提交",
  failed: "任务失败",
  expired: "预览已过期，请重新预览",
  interrupted: "任务已中断",
  partial: "部分数据已写入",
  outcome_unknown: "提交结果不明，请核对目标，勿重复执行",
};
export function describeDataTaskProgress(status: string): string {
  return labels[status] ?? status;
}
export function isDataTaskTerminal(status: string): boolean {
  return [
    "succeeded",
    "failed",
    "cancelled",
    "expired",
    "interrupted",
    "partial",
    "outcome_unknown",
  ].includes(status);
}

/** 只有执行阶段且预览已给出准确操作数量时显示百分比。 */
export function dataTaskPercent(
  task: import("../types/dataTasks").DataTaskSnapshot
): number | null {
  if (task.status !== "executing" || !task.preview) return null;
  const total = task.preview.tables.reduce(
    (sum, table) =>
      sum +
      (task.request.kind === "transfer"
        ? BigInt(table.counts.source_rows)
        : BigInt(table.counts.inserted) +
          BigInt(table.counts.updated) +
          BigInt(table.counts.deleted)),
    0n
  );
  if (total === 0n) return null;
  const value = (BigInt(task.written_rows) * 100n) / total;
  return Number(value > 100n ? 100n : value);
}
