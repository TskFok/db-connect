import { describe, it, expect } from "vitest";
import { isConnectionLostError } from "../utils/connectionErrors";

describe("isConnectionLostError", () => {
  it.each([
    "SSH 进程已退出，本地转发未就绪 (退出码: 255)\n\nOpenSSH 错误详情:\nssh: connect to host jump.example.com port 22: Connection refused",
    "等待 SSH 本地端口转发超时\n\nOpenSSH 错误详情:\nConnection reset by peer",
    "检查 SSH 进程状态失败: Input/output error\n\nOpenSSH 错误详情:\nConnection closed by remote host",
    "启动 ssh 失败: Input/output error（请确认系统已安装 OpenSSH 客户端，且 /usr/bin/ssh 可用）",
  ])("SSH 建连阶段失败不会被当成活跃会话断开：%s", (error) => {
    expect(isConnectionLostError(error)).toBe(false);
    expect(isConnectionLostError(new Error(error))).toBe(false);
  });

  it("命中 Connection refused (os error 61) 模式", () => {
    expect(
      isConnectionLostError(
        "获取连接失败: Input/output error: Input/output error: Connection refused (os error 61)"
      )
    ).toBe(true);
  });

  it("命中 Input/output error 模式", () => {
    expect(isConnectionLostError("Input/output error: pipe closed")).toBe(true);
  });

  it("命中 Broken pipe 模式", () => {
    expect(isConnectionLostError("Broken pipe (os error 32)")).toBe(true);
  });

  it("命中 connection closed 模式", () => {
    expect(isConnectionLostError("mysql_async: connection closed")).toBe(true);
  });

  it("命中 Connection reset by peer 模式", () => {
    expect(isConnectionLostError("Connection reset by peer (os error 54)")).toBe(true);
  });

  it("命中 unexpected end of file（TLS 半路掉线）", () => {
    expect(isConnectionLostError("tls error: unexpected end of file")).toBe(true);
  });

  it("命中后端中文 `获取连接失败` 包装", () => {
    expect(isConnectionLostError("获取连接失败: timed out")).toBe(true);
  });

  it("命中 Network is unreachable", () => {
    expect(isConnectionLostError("Network is unreachable")).toBe(true);
  });

  it("接受 Error 对象", () => {
    expect(
      isConnectionLostError(new Error("connection refused"))
    ).toBe(true);
  });

  it("非连接错误应返回 false", () => {
    expect(isConnectionLostError("Syntax error in SQL near 'FROM'")).toBe(false);
    expect(isConnectionLostError("Access denied for user 'root'")).toBe(false);
    expect(isConnectionLostError("Table 'foo' doesn't exist")).toBe(false);
  });

  it("空/null/undefined 应返回 false", () => {
    expect(isConnectionLostError(null)).toBe(false);
    expect(isConnectionLostError(undefined)).toBe(false);
    expect(isConnectionLostError("")).toBe(false);
  });

  it("大小写不敏感", () => {
    expect(isConnectionLostError("CONNECTION REFUSED")).toBe(true);
    expect(isConnectionLostError("input/Output Error")).toBe(true);
  });
});
