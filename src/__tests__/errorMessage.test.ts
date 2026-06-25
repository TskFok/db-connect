import { describe, it, expect } from "vitest";
import { formatAsyncRejectionReason } from "../utils/errorMessage";

describe("formatAsyncRejectionReason", () => {
  it("应返回 Error 的 message", () => {
    expect(formatAsyncRejectionReason(new Error("数据库连接超时"))).toBe(
      "数据库连接超时"
    );
  });

  it("应直接返回字符串 reason", () => {
    expect(formatAsyncRejectionReason("字符串形式的错误")).toBe(
      "字符串形式的错误"
    );
  });

  it("应将 Event 转为资源加载失败提示", () => {
    const script = document.createElement("script");
    script.src = "https://cdn.example.com/loader.js";
    const event = new Event("error");
    Object.defineProperty(event, "target", { value: script });

    expect(formatAsyncRejectionReason(event)).toBe(
      "资源加载失败: https://cdn.example.com/loader.js"
    );
  });

  it("应将无 target 的 Event 转为通用资源加载失败", () => {
    expect(formatAsyncRejectionReason(new Event("error"))).toBe("资源加载失败");
  });

  it("应忽略 Monaco 加载取消", () => {
    expect(
      formatAsyncRejectionReason({
        type: "cancelation",
        msg: "operation is manually canceled",
      })
    ).toBeNull();
  });

  it("应对 undefined 返回默认文案", () => {
    expect(formatAsyncRejectionReason(undefined)).toBe("发生未知异步错误");
  });
});
