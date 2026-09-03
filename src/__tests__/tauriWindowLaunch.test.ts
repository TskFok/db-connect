import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Tauri 窗口启动配置", () => {
  const root = process.cwd();

  it("主窗口默认不强制最大化，启动后由前端设置决定", () => {
    const conf = JSON.parse(
      readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf-8")
    ) as {
      app?: {
        windows?: Array<{ maximized?: boolean; visible?: boolean }>;
      };
    };
    const windows = conf.app?.windows ?? [];
    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0]?.maximized).not.toBe(true);
    expect(windows[0]?.visible).toBe(false);
  });

  it("capabilities 允许前端最大化、改尺寸并显示窗口", () => {
    const cap = JSON.parse(
      readFileSync(join(root, "src-tauri", "capabilities", "default.json"), "utf-8")
    ) as { permissions?: string[] };
    const permissions = cap.permissions ?? [];
    expect(permissions).toEqual(
      expect.arrayContaining([
        "core:window:allow-maximize",
        "core:window:allow-unmaximize",
        "core:window:allow-set-size",
        "core:window:allow-set-position",
        "core:window:allow-show",
      ])
    );
  });
});
