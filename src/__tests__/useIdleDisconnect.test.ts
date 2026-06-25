import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useIdleDisconnect } from "../hooks/useIdleDisconnect";

const mockSettingsState = { idleTimeoutMinutes: 15 };
const mockConnectionStoreState = {
  activeConnection: null as { connId: string; config: object } | null,
  activeConnections: {} as Record<string, { connId: string; config: object }>,
  activeConnId: null as string | null,
  disconnect: vi.fn(),
};
vi.mock("../stores/connectionStore", () => ({
  useConnectionStore: Object.assign(vi.fn(() => mockConnectionStoreState), {
    getState: () => mockConnectionStoreState,
  }),
}));

vi.mock("../stores/settingsStore", () => ({
  useSettingsStore: vi.fn((selector?: (s: { idleTimeoutMinutes: number }) => number | { idleTimeoutMinutes: number }) => {
    if (typeof selector === "function") {
      return selector(mockSettingsState);
    }
    return mockSettingsState;
  }),
}));

vi.mock("../services/tauriCommands", () => ({
  checkIdleDisconnect: vi.fn(),
}));

import * as api from "../services/tauriCommands";

const mockCheckIdleDisconnect = vi.mocked(api.checkIdleDisconnect);

describe("useIdleDisconnect", () => {
  const mockDisconnect = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockSettingsState.idleTimeoutMinutes = 15;
    const conn = {
      connId: "conn-123",
      config: {
        id: "1",
        name: "Test",
        host: "localhost",
        port: 3306,
        username: "root",
        password: "pass",
      },
    };
    mockConnectionStoreState.activeConnection = conn;
    mockConnectionStoreState.activeConnections = { "conn-123": conn };
    mockConnectionStoreState.activeConnId = "conn-123";
    mockConnectionStoreState.disconnect = mockDisconnect;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("空闲超时未到时不应断开", async () => {
    mockCheckIdleDisconnect.mockResolvedValue(false);

    const onDisconnected = vi.fn();
    renderHook(() => useIdleDisconnect(onDisconnected));

    // 前进 1 分钟（检测间隔）
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockCheckIdleDisconnect).toHaveBeenCalledWith("conn-123", 900);
    expect(mockDisconnect).not.toHaveBeenCalled();
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it("空闲超时后应断开并调用回调", async () => {
    mockCheckIdleDisconnect.mockResolvedValue(true);
    mockDisconnect.mockResolvedValue(undefined);

    const onDisconnected = vi.fn();
    renderHook(() => useIdleDisconnect(onDisconnected));

    await vi.advanceTimersByTimeAsync(60_000);

    expect(mockCheckIdleDisconnect).toHaveBeenCalledWith("conn-123", 900);
    expect(mockDisconnect).toHaveBeenCalled();
    expect(onDisconnected).toHaveBeenCalledWith(
      expect.stringContaining("长时间空闲")
    );
  });

  it("idleTimeoutMinutes 为 0 时不应启动检测", async () => {
    mockSettingsState.idleTimeoutMinutes = 0;

    renderHook(() => useIdleDisconnect(vi.fn()));

    await vi.advanceTimersByTimeAsync(120_000);

    expect(mockCheckIdleDisconnect).not.toHaveBeenCalled();
  });

  it("无活跃连接时不应启动检测", async () => {
    mockConnectionStoreState.activeConnection = null;
    mockConnectionStoreState.activeConnections = {};
    mockConnectionStoreState.activeConnId = null;
    mockConnectionStoreState.disconnect = mockDisconnect;

    renderHook(() => useIdleDisconnect(vi.fn()));

    await vi.advanceTimersByTimeAsync(120_000);

    expect(mockCheckIdleDisconnect).not.toHaveBeenCalled();
  });
});
