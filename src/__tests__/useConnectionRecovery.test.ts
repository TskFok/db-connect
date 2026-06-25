import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useConnectionRecovery } from "../hooks/useConnectionRecovery";

const mockForceCleanupConnection = vi.fn();
type MockConn = { connId: string; config: { name?: string } };
const mockState = {
  activeConnections: {} as Record<string, MockConn>,
  activeConnId: null as string | null,
  forceCleanupConnection: mockForceCleanupConnection,
};

vi.mock("../stores/connectionStore", () => ({
  useConnectionStore: Object.assign(vi.fn(() => mockState), {
    getState: () => mockState,
  }),
}));

vi.mock("../services/tauriCommands", () => ({
  pingConnection: vi.fn(),
  forceDisconnect: vi.fn(),
}));

import * as api from "../services/tauriCommands";
const mockPing = vi.mocked(api.pingConnection);

/** 工具：触发 visibilitychange 事件并把 document.visibilityState 切到指定值 */
function dispatchVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useConnectionRecovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.activeConnections = {};
    mockState.activeConnId = null;
    mockForceCleanupConnection.mockResolvedValue(undefined);
  });

  afterEach(() => {
    dispatchVisibility("visible");
  });

  it("无活跃连接时 visibilitychange 不应触发 ping", async () => {
    renderHook(() => useConnectionRecovery());
    await act(async () => {
      dispatchVisibility("visible");
      await Promise.resolve();
    });
    expect(mockPing).not.toHaveBeenCalled();
    expect(mockForceCleanupConnection).not.toHaveBeenCalled();
  });

  it("文档变 hidden 时不应触发 ping（只有 visible 才检测）", async () => {
    const conn: MockConn = { connId: "c1", config: { name: "T1" } };
    mockState.activeConnections = { c1: conn };
    mockState.activeConnId = "c1";

    renderHook(() => useConnectionRecovery());
    await act(async () => {
      dispatchVisibility("hidden");
      await Promise.resolve();
    });
    expect(mockPing).not.toHaveBeenCalled();
  });

  it("ping 成功（连接仍存活）不应清理连接", async () => {
    const conn: MockConn = { connId: "c1", config: { name: "T1" } };
    mockState.activeConnections = { c1: conn };
    mockState.activeConnId = "c1";
    mockPing.mockResolvedValue(true);

    const onLost = vi.fn();
    renderHook(() => useConnectionRecovery(onLost));

    await act(async () => {
      dispatchVisibility("visible");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockPing).toHaveBeenCalledWith("c1");
    expect(mockForceCleanupConnection).not.toHaveBeenCalled();
    expect(onLost).not.toHaveBeenCalled();
  });

  it("ping 失败时应强制清理连接并触发回调", async () => {
    const conn: MockConn = { connId: "c1", config: { name: "T1" } };
    mockState.activeConnections = { c1: conn };
    mockState.activeConnId = "c1";
    mockPing.mockResolvedValue(false);

    const onLost = vi.fn();
    renderHook(() => useConnectionRecovery(onLost));

    await act(async () => {
      dispatchVisibility("visible");
      // 等待 async 链
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockPing).toHaveBeenCalledWith("c1");
    expect(mockForceCleanupConnection).toHaveBeenCalledWith("c1");
    expect(onLost).toHaveBeenCalledWith(expect.stringContaining("已自动清理"));
    expect(onLost).toHaveBeenCalledWith(expect.stringContaining("T1"));
  });

  it("pingConnection 抛错时也视为不可用并清理", async () => {
    const conn: MockConn = { connId: "c1", config: { name: "T1" } };
    mockState.activeConnections = { c1: conn };
    mockState.activeConnId = "c1";
    mockPing.mockRejectedValue("invoke error");

    const onLost = vi.fn();
    renderHook(() => useConnectionRecovery(onLost));

    await act(async () => {
      dispatchVisibility("visible");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockForceCleanupConnection).toHaveBeenCalledWith("c1");
    expect(onLost).toHaveBeenCalled();
  });

  it("online 事件也应触发健康检查", async () => {
    const conn: MockConn = { connId: "c1", config: { name: "T1" } };
    mockState.activeConnections = { c1: conn };
    mockState.activeConnId = "c1";
    mockPing.mockResolvedValue(true);

    renderHook(() => useConnectionRecovery());

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockPing).toHaveBeenCalledWith("c1");
  });

  it("focus 事件也应触发健康检查", async () => {
    const conn: MockConn = { connId: "c1", config: { name: "T1" } };
    mockState.activeConnections = { c1: conn };
    mockState.activeConnId = "c1";
    mockPing.mockResolvedValue(true);

    renderHook(() => useConnectionRecovery());

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockPing).toHaveBeenCalledWith("c1");
  });

  it("多个活跃连接：只清理 ping 失败的那个", async () => {
    const c1: MockConn = { connId: "c1", config: { name: "A" } };
    const c2: MockConn = { connId: "c2", config: { name: "B" } };
    mockState.activeConnections = { c1, c2 };
    mockState.activeConnId = "c1";
    mockPing.mockImplementation(async (id: string) => id === "c2");

    const onLost = vi.fn();
    renderHook(() => useConnectionRecovery(onLost));

    await act(async () => {
      dispatchVisibility("visible");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockPing).toHaveBeenCalledWith("c1");
    expect(mockPing).toHaveBeenCalledWith("c2");
    expect(mockForceCleanupConnection).toHaveBeenCalledTimes(1);
    expect(mockForceCleanupConnection).toHaveBeenCalledWith("c1");
  });

  it("hook 卸载后不应再监听事件", async () => {
    const conn: MockConn = { connId: "c1", config: { name: "T1" } };
    mockState.activeConnections = { c1: conn };
    mockState.activeConnId = "c1";
    mockPing.mockResolvedValue(true);

    const { unmount } = renderHook(() => useConnectionRecovery());
    unmount();

    await act(async () => {
      dispatchVisibility("visible");
      window.dispatchEvent(new Event("online"));
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(mockPing).not.toHaveBeenCalled();
  });
});
