import { useEffect, useRef } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import {
  applyWindowLaunchPlan,
  nextSavedBounds,
  planWindowLaunch,
  type LaunchableWindow,
  type WindowSnapshot,
} from "../utils/windowLaunch";

const SAVE_DEBOUNCE_MS = 300;

export interface WindowLaunchDeps {
  getWindow: () => Promise<LaunchableWindow | null>;
  snapshot: () => Promise<WindowSnapshot>;
  listen: (
    win: LaunchableWindow,
    onChange: () => void
  ) => Promise<() => void>;
  saveDebounceMs?: number;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function createTauriWindow(): Promise<LaunchableWindow | null> {
  if (!isTauriRuntime()) {
    return null;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const { LogicalSize, LogicalPosition } = await import("@tauri-apps/api/dpi");
  const win = getCurrentWindow();
  return {
    maximize: () => win.maximize(),
    setSize: (width, height) => win.setSize(new LogicalSize(width, height)),
    setPosition: (x, y) => win.setPosition(new LogicalPosition(x, y)),
    show: () => win.show(),
    async currentMonitorWorkArea() {
      const { currentMonitor } = await import("@tauri-apps/api/window");
      const monitor = await currentMonitor();
      if (!monitor) {
        return null;
      }
      const scale = monitor.scaleFactor;
      const position = monitor.workArea.position.toLogical(scale);
      const size = monitor.workArea.size.toLogical(scale);
      return {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
      };
    },
  };
}

async function snapshotTauriWindow(): Promise<WindowSnapshot> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  const [maximized, minimized, size, pos, scale] = await Promise.all([
    win.isMaximized(),
    win.isMinimized(),
    win.innerSize(),
    win.outerPosition(),
    win.scaleFactor(),
  ]);
  return {
    width: size.width / scale,
    height: size.height / scale,
    x: pos.x / scale,
    y: pos.y / scale,
    maximized,
    minimized,
  };
}

async function listenTauriWindow(
  _win: LaunchableWindow,
  onChange: () => void
): Promise<() => void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  const unlistenResize = await win.onResized(() => onChange());
  const unlistenMoved = await win.onMoved(() => onChange());
  return () => {
    unlistenResize();
    unlistenMoved();
  };
}

function waitForSettingsHydration(): Promise<void> {
  const persistApi = useSettingsStore.persist;
  if (!persistApi || persistApi.hasHydrated()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    persistApi.onFinishHydration(() => resolve());
  });
}

/**
 * 按设置应用启动窗口状态，并在记住模式下持续保存尺寸/位置。
 */
export function useWindowLaunchState(deps?: WindowLaunchDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const persistBounds = async () => {
      const currentDeps = depsRef.current;
      const snap = await (currentDeps?.snapshot ?? snapshotTauriWindow)();
      if (cancelled) {
        return;
      }
      const current = useSettingsStore.getState().windowBounds;
      useSettingsStore.getState().setWindowBounds(nextSavedBounds(current, snap));
    };

    const run = async () => {
      await waitForSettingsHydration();
      if (cancelled) {
        return;
      }
      const currentDeps = depsRef.current;
      const win = await (currentDeps?.getWindow ?? createTauriWindow)();
      if (!win || cancelled) {
        return;
      }
      const { windowLaunchMode, windowBounds } = useSettingsStore.getState();
      await applyWindowLaunchPlan(
        win,
        planWindowLaunch(windowLaunchMode, windowBounds)
      );
      if (cancelled) {
        return;
      }
      unlisten = await (currentDeps?.listen ?? listenTauriWindow)(win, () => {
        if (timer) {
          clearTimeout(timer);
        }
        const delay = currentDeps?.saveDebounceMs ?? SAVE_DEBOUNCE_MS;
        timer = setTimeout(() => {
          void persistBounds();
        }, delay);
      });
    };

    void run();

    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
      unlisten?.();
    };
  }, []);
}
