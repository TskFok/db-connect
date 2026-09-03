/** 与 tauri.conf.json 主窗口 minWidth / minHeight 保持一致 */
export const WINDOW_MIN_WIDTH = 900;
export const WINDOW_MIN_HEIGHT = 600;

export type WindowLaunchMode = "maximized" | "remember";

export interface WindowBounds {
  width: number;
  height: number;
  x: number;
  y: number;
  maximized: boolean;
}

export interface WindowSnapshot extends WindowBounds {
  minimized: boolean;
}

export type WindowLaunchPlan =
  | { kind: "maximize" }
  | { kind: "restore"; bounds: WindowBounds }
  | { kind: "default" };

export interface LaunchableWindow {
  maximize(): Promise<void>;
  setSize(width: number, height: number): Promise<void>;
  setPosition(x: number, y: number): Promise<void>;
  show(): Promise<void>;
  currentMonitorWorkArea(): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>;
}

export function planWindowLaunch(
  mode: WindowLaunchMode,
  saved: WindowBounds | null | undefined
): WindowLaunchPlan {
  if (mode === "maximized") {
    return { kind: "maximize" };
  }
  if (!saved) {
    return { kind: "default" };
  }
  return { kind: "restore", bounds: saved };
}

export function clampWindowSize(
  width: number,
  height: number,
  minWidth = WINDOW_MIN_WIDTH,
  minHeight = WINDOW_MIN_HEIGHT
): { width: number; height: number } {
  return {
    width: Math.max(minWidth, Math.round(width)),
    height: Math.max(minHeight, Math.round(height)),
  };
}

export function clampPositionToMonitor(
  x: number,
  y: number,
  width: number,
  height: number,
  monitor: { x: number; y: number; width: number; height: number }
): { x: number; y: number } {
  const maxX = monitor.x + monitor.width - Math.min(width, monitor.width);
  const maxY = monitor.y + monitor.height - Math.min(height, monitor.height);
  return {
    x: Math.min(Math.max(Math.round(x), monitor.x), maxX),
    y: Math.min(Math.max(Math.round(y), monitor.y), maxY),
  };
}

export function nextSavedBounds(
  current: WindowBounds | null,
  snapshot: WindowSnapshot
): WindowBounds | null {
  if (snapshot.minimized) {
    return current;
  }
  if (snapshot.maximized) {
    return {
      width: current?.width ?? snapshot.width,
      height: current?.height ?? snapshot.height,
      x: current?.x ?? snapshot.x,
      y: current?.y ?? snapshot.y,
      maximized: true,
    };
  }
  return {
    width: snapshot.width,
    height: snapshot.height,
    x: snapshot.x,
    y: snapshot.y,
    maximized: false,
  };
}

export async function applyWindowLaunchPlan(
  win: LaunchableWindow,
  plan: WindowLaunchPlan
): Promise<void> {
  try {
    if (plan.kind === "maximize") {
      await win.maximize();
    } else if (plan.kind === "restore") {
      if (plan.bounds.maximized) {
        await win.maximize();
      } else {
        const size = clampWindowSize(plan.bounds.width, plan.bounds.height);
        const monitor = await win.currentMonitorWorkArea();
        const pos = monitor
          ? clampPositionToMonitor(
              plan.bounds.x,
              plan.bounds.y,
              size.width,
              size.height,
              monitor
            )
          : { x: Math.round(plan.bounds.x), y: Math.round(plan.bounds.y) };
        await win.setSize(size.width, size.height);
        await win.setPosition(pos.x, pos.y);
      }
    }
  } catch {
    // 启动调整失败仍应显示窗口，避免一直不可见
  } finally {
    try {
      await win.show();
    } catch {
      // 非 Tauri 环境或权限不足时忽略
    }
  }
}
