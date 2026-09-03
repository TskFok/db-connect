import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useWindowLaunchState } from "../hooks/useWindowLaunchState";
import { useSettingsStore } from "../stores/settingsStore";
import type { LaunchableWindow } from "../utils/windowLaunch";

describe("useWindowLaunchState", () => {
  const win: LaunchableWindow & {
    maximize: ReturnType<typeof vi.fn>;
    setSize: ReturnType<typeof vi.fn>;
    setPosition: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    currentMonitorWorkArea: ReturnType<typeof vi.fn>;
  } = {
    maximize: vi.fn().mockResolvedValue(undefined),
    setSize: vi.fn().mockResolvedValue(undefined),
    setPosition: vi.fn().mockResolvedValue(undefined),
    show: vi.fn().mockResolvedValue(undefined),
    currentMonitorWorkArea: vi.fn().mockResolvedValue({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    }),
  };

  const snapshot = vi.fn();
  const listen = vi.fn();
  let unlisten = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    snapshot.mockResolvedValue({
      width: 1200,
      height: 800,
      x: 10,
      y: 20,
      maximized: false,
      minimized: false,
    });
    useSettingsStore.setState({
      windowLaunchMode: "maximized",
      windowBounds: null,
    });
  });

  it("最大化模式启动时应 maximize 并 show", async () => {
    renderHook(() =>
      useWindowLaunchState({
        getWindow: async () => win,
        snapshot,
        listen,
      })
    );

    await waitFor(() => {
      expect(win.maximize).toHaveBeenCalledTimes(1);
      expect(win.show).toHaveBeenCalledTimes(1);
    });
  });

  it("记住模式启动时应恢复已存尺寸", async () => {
    useSettingsStore.setState({
      windowLaunchMode: "remember",
      windowBounds: {
        width: 1280,
        height: 720,
        x: 40,
        y: 50,
        maximized: false,
      },
    });

    renderHook(() =>
      useWindowLaunchState({
        getWindow: async () => win,
        snapshot,
        listen,
      })
    );

    await waitFor(() => {
      expect(win.setSize).toHaveBeenCalledWith(1280, 720);
      expect(win.setPosition).toHaveBeenCalledWith(40, 50);
      expect(win.show).toHaveBeenCalledTimes(1);
    });
  });

  it("窗口变化时应保存尺寸", async () => {
    let onChange: () => void = () => {};
    listen.mockImplementation(async (_w, cb: () => void) => {
      onChange = cb;
      return unlisten;
    });

    renderHook(() =>
      useWindowLaunchState({
        getWindow: async () => win,
        snapshot,
        listen,
        saveDebounceMs: 0,
      })
    );

    await waitFor(() => {
      expect(listen).toHaveBeenCalled();
    });

    onChange();

    await waitFor(() => {
      expect(useSettingsStore.getState().windowBounds).toEqual({
        width: 1200,
        height: 800,
        x: 10,
        y: 20,
        maximized: false,
      });
    });
  });
});
