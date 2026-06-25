import { useEffect } from "react";
import type { MessageInstance } from "antd/es/message/interface";
import { formatAsyncRejectionReason } from "../utils/errorMessage";

/**
 * 全局错误处理 Hook
 *
 * 监听:
 * - window 'error' 事件 (未捕获的 JS 错误)
 * - window 'unhandledrejection' 事件 (未处理的 Promise 拒绝)
 *
 * 通过 Ant Design message API 展示错误通知
 */
export function useGlobalErrorHandler(messageApi: MessageInstance) {
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      const msg = event.error?.message || event.message || "发生未知错误";
      // ResizeObserver loop 为浏览器良性警告，多由第三方库（如 Ant Design Table 虚拟滚动）触发，可安全忽略
      if (msg.includes("ResizeObserver loop")) {
        event.preventDefault();
        return false;
      }
      console.error("[全局错误]", event.error);
      messageApi.error({
        content: `错误: ${msg}`,
        duration: 5,
      });
    };

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const msg = formatAsyncRejectionReason(event.reason);
      if (msg === null) {
        event.preventDefault();
        return;
      }
      console.error("[未处理的 Promise 拒绝]", event.reason);
      messageApi.error({
        content: `异步错误: ${msg}`,
        duration: 5,
      });
    };

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleUnhandledRejection);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener(
        "unhandledrejection",
        handleUnhandledRejection
      );
    };
  }, [messageApi]);
}
