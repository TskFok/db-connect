/** Monaco loader 取消加载时抛出的标记对象 */
function isMonacoCancelation(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    "type" in reason &&
    (reason as { type: unknown }).type === "cancelation"
  );
}

/**
 * 将 unhandledrejection 的 reason 转为用户可读文案。
 * 返回 null 表示该拒绝可安全忽略（如 Monaco 加载取消）。
 */
export function formatAsyncRejectionReason(reason: unknown): string | null {
  if (isMonacoCancelation(reason)) {
    return null;
  }

  if (reason == null) {
    return "发生未知异步错误";
  }

  if (typeof reason === "string") {
    return reason;
  }

  if (reason instanceof Error) {
    return reason.message;
  }

  if (reason instanceof Event) {
    const target = reason.target;
    if (target instanceof HTMLScriptElement && target.src) {
      return `资源加载失败: ${target.src}`;
    }
    return "资源加载失败";
  }

  if (
    typeof reason === "object" &&
    "message" in reason &&
    typeof (reason as { message: unknown }).message === "string"
  ) {
    return (reason as { message: string }).message;
  }

  const str = String(reason);
  if (str === "[object Event]") {
    return "资源加载失败";
  }
  if (str === "[object Object]") {
    return "发生未知异步错误";
  }
  return str || "发生未知异步错误";
}
