import { describe, expect, it, vi } from "vitest";
import {
  applyWindowLaunchPlan,
  clampPositionToMonitor,
  clampWindowSize,
  nextSavedBounds,
  planWindowLaunch,
  type LaunchableWindow,
} from "../utils/windowLaunch";

describe("planWindowLaunch", () => {
  it("最大化模式下始终最大化", () => {
    expect(planWindowLaunch("maximized", null)).toEqual({ kind: "maximize" });
    expect(
      planWindowLaunch("maximized", {
        width: 1100,
        height: 700,
        x: 10,
        y: 20,
        maximized: false,
      })
    ).toEqual({ kind: "maximize" });
  });

  it("记住模式下无已存尺寸时使用默认窗口", () => {
    expect(planWindowLaunch("remember", null)).toEqual({ kind: "default" });
  });

  it("记住模式下有已存尺寸时恢复", () => {
    const bounds = {
      width: 1280,
      height: 720,
      x: 40,
      y: 50,
      maximized: false,
    };
    expect(planWindowLaunch("remember", bounds)).toEqual({
      kind: "restore",
      bounds,
    });
  });
});

describe("clampWindowSize", () => {
  it("小于最小值时应抬升到最小宽高", () => {
    expect(clampWindowSize(100, 100)).toEqual({ width: 900, height: 600 });
  });

  it("合法尺寸应保持不变", () => {
    expect(clampWindowSize(1280, 800)).toEqual({ width: 1280, height: 800 });
  });
});

describe("clampPositionToMonitor", () => {
  const monitor = { x: 0, y: 0, width: 1920, height: 1080 };

  it("屏幕内坐标保持不变", () => {
    expect(clampPositionToMonitor(100, 80, 1200, 800, monitor)).toEqual({
      x: 100,
      y: 80,
    });
  });

  it("超出屏幕时应拉回可见区域", () => {
    expect(clampPositionToMonitor(5000, 4000, 1200, 800, monitor)).toEqual({
      x: 720,
      y: 280,
    });
  });
});

describe("nextSavedBounds", () => {
  it("最小化时不覆盖已存尺寸", () => {
    const current = {
      width: 1200,
      height: 800,
      x: 10,
      y: 20,
      maximized: false,
    };
    expect(
      nextSavedBounds(current, {
        width: 200,
        height: 40,
        x: 0,
        y: 0,
        maximized: false,
        minimized: true,
      })
    ).toEqual(current);
  });

  it("最大化时应保留上次普通尺寸并标记 maximized", () => {
    const current = {
      width: 1100,
      height: 700,
      x: 30,
      y: 40,
      maximized: false,
    };
    expect(
      nextSavedBounds(current, {
        width: 1920,
        height: 1080,
        x: 0,
        y: 0,
        maximized: true,
        minimized: false,
      })
    ).toEqual({
      width: 1100,
      height: 700,
      x: 30,
      y: 40,
      maximized: true,
    });
  });

  it("普通窗口应写入当前尺寸", () => {
    expect(
      nextSavedBounds(null, {
        width: 1300,
        height: 820,
        x: 12,
        y: 24,
        maximized: false,
        minimized: false,
      })
    ).toEqual({
      width: 1300,
      height: 820,
      x: 12,
      y: 24,
      maximized: false,
    });
  });
});

describe("applyWindowLaunchPlan", () => {
  function createWindow(): LaunchableWindow & {
    maximize: ReturnType<typeof vi.fn>;
    setSize: ReturnType<typeof vi.fn>;
    setPosition: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    currentMonitorWorkArea: ReturnType<typeof vi.fn>;
  } {
    return {
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
  }

  it("最大化计划应调用 maximize 并显示窗口", async () => {
    const win = createWindow();
    await applyWindowLaunchPlan(win, { kind: "maximize" });
    expect(win.maximize).toHaveBeenCalledTimes(1);
    expect(win.setSize).not.toHaveBeenCalled();
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it("恢复计划在未最大化时应设置尺寸和位置后显示", async () => {
    const win = createWindow();
    await applyWindowLaunchPlan(win, {
      kind: "restore",
      bounds: { width: 1280, height: 720, x: 40, y: 50, maximized: false },
    });
    expect(win.maximize).not.toHaveBeenCalled();
    expect(win.setSize).toHaveBeenCalledWith(1280, 720);
    expect(win.setPosition).toHaveBeenCalledWith(40, 50);
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it("恢复计划在上次最大化时应 maximize", async () => {
    const win = createWindow();
    await applyWindowLaunchPlan(win, {
      kind: "restore",
      bounds: { width: 1280, height: 720, x: 40, y: 50, maximized: true },
    });
    expect(win.maximize).toHaveBeenCalledTimes(1);
    expect(win.setSize).not.toHaveBeenCalled();
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it("默认计划只显示窗口", async () => {
    const win = createWindow();
    await applyWindowLaunchPlan(win, { kind: "default" });
    expect(win.maximize).not.toHaveBeenCalled();
    expect(win.setSize).not.toHaveBeenCalled();
    expect(win.show).toHaveBeenCalledTimes(1);
  });

  it("应用失败时仍应尝试显示窗口", async () => {
    const win = createWindow();
    win.maximize.mockRejectedValue(new Error("maximize failed"));
    await expect(
      applyWindowLaunchPlan(win, { kind: "maximize" })
    ).resolves.toBeUndefined();
    expect(win.show).toHaveBeenCalledTimes(1);
  });
});
