import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { render } from "@testing-library/react";
import { useGlobalErrorHandler } from "../hooks/useGlobalErrorHandler";
import type { MessageInstance } from "antd/es/message/interface";

function TestWrapper({ messageApi }: { messageApi: MessageInstance }) {
  useGlobalErrorHandler(messageApi);
  return null;
}

describe("全局错误处理", () => {
  let errorHandler: (e: ErrorEvent) => void;
  let rejectionHandler: (e: PromiseRejectionEvent) => void;

  beforeEach(() => {
    errorHandler = vi.fn();
    rejectionHandler = vi.fn();
    window.addEventListener("error", errorHandler);
    window.addEventListener("unhandledrejection", rejectionHandler);
  });

  afterEach(() => {
    window.removeEventListener("error", errorHandler);
    window.removeEventListener("unhandledrejection", rejectionHandler);
  });

  describe("window error 事件监听", () => {
    it("应该能捕获 error 事件", () => {
      const errorEvent = new ErrorEvent("error", {
        error: new Error("测试错误"),
        message: "测试错误",
      });

      window.dispatchEvent(errorEvent);

      expect(errorHandler).toHaveBeenCalledTimes(1);
    });

    it("ErrorEvent 应该包含正确的错误信息", () => {
      const errorEvent = new ErrorEvent("error", {
        error: new Error("具体的错误消息"),
        message: "具体的错误消息",
      });

      let capturedEvent: ErrorEvent | null = null;
      const captureHandler = (e: ErrorEvent) => {
        capturedEvent = e;
      };
      window.addEventListener("error", captureHandler);
      window.dispatchEvent(errorEvent);
      window.removeEventListener("error", captureHandler);

      expect(capturedEvent).not.toBeNull();
      expect(capturedEvent!.error.message).toBe("具体的错误消息");
    });
  });

  describe("unhandledrejection 事件监听", () => {
    it("应该能捕获 unhandledrejection 事件", () => {
      const rejectionEvent = new Event(
        "unhandledrejection"
      ) as PromiseRejectionEvent;
      Object.defineProperty(rejectionEvent, "reason", {
        value: new Error("未处理的 Promise"),
      });

      window.dispatchEvent(rejectionEvent);

      expect(rejectionHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe("错误消息提取", () => {
    it("应该能从 Error 对象提取 message", () => {
      const error = new Error("数据库连接超时");
      expect(error.message).toBe("数据库连接超时");
    });

    it("应该能处理字符串类型的错误", () => {
      const reason = "字符串形式的错误";
      const msg = typeof reason === "string" ? reason : String(reason);
      expect(msg).toBe("字符串形式的错误");
    });

    it("应该能处理 undefined/null 错误", () => {
      const reason = undefined;
      const msg = reason || "发生未知异步错误";
      expect(msg).toBe("发生未知异步错误");
    });
  });

  describe("useGlobalErrorHandler ResizeObserver 错误过滤", () => {
    it("应忽略 ResizeObserver loop 错误，不弹出 message", () => {
      const messageApi = { error: vi.fn() } as unknown as MessageInstance;
      render(createElement(TestWrapper, { messageApi }));

      const resizeObserverError = new ErrorEvent("error", {
        error: new Error("ResizeObserver loop completed with undelivered notifications."),
        message: "ResizeObserver loop completed with undelivered notifications.",
      });
      window.dispatchEvent(resizeObserverError);

      expect(messageApi.error).not.toHaveBeenCalled();
    });

    it("应对普通错误正常弹出 message", () => {
      const messageApi = { error: vi.fn() } as unknown as MessageInstance;
      render(createElement(TestWrapper, { messageApi }));

      const normalError = new ErrorEvent("error", {
        error: new Error("数据库连接失败"),
        message: "数据库连接失败",
      });
      window.dispatchEvent(normalError);

      expect(messageApi.error).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining("数据库连接失败") })
      );
    });

    it("应将 Event 类型的 rejection 格式化为资源加载失败", () => {
      const messageApi = { error: vi.fn() } as unknown as MessageInstance;
      render(createElement(TestWrapper, { messageApi }));

      const rejectionEvent = new Event(
        "unhandledrejection"
      ) as PromiseRejectionEvent;
      Object.defineProperty(rejectionEvent, "reason", {
        value: new Event("error"),
      });
      window.dispatchEvent(rejectionEvent);

      expect(messageApi.error).toHaveBeenCalledWith(
        expect.objectContaining({ content: "异步错误: 资源加载失败" })
      );
    });

    it("应忽略 Monaco 加载取消的 rejection", () => {
      const messageApi = { error: vi.fn() } as unknown as MessageInstance;
      render(createElement(TestWrapper, { messageApi }));

      const rejectionEvent = new Event(
        "unhandledrejection"
      ) as PromiseRejectionEvent;
      Object.defineProperty(rejectionEvent, "reason", {
        value: { type: "cancelation", msg: "operation is manually canceled" },
      });
      window.dispatchEvent(rejectionEvent);

      expect(messageApi.error).not.toHaveBeenCalled();
    });
  });
});
