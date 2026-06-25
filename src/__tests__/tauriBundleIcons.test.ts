import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** 与 macOS 一致：Windows 需在 bundle.icon 中声明 .ico，且文件需由同源 PNG 生成。 */
describe("Tauri bundle icons (Windows / macOS)", () => {
  const root = process.cwd();
  const confPath = join(root, "src-tauri", "tauri.conf.json");
  const iconsDir = join(root, "src-tauri", "icons");

  it("tauri.conf.json 的 bundle.icon 同时包含 .ico 与 .icns", () => {
    const raw = readFileSync(confPath, "utf-8");
    const conf = JSON.parse(raw) as {
      bundle?: { icon?: string[] };
    };
    const list = conf.bundle?.icon ?? [];
    expect(list).toContain("icons/icon.ico");
    expect(list).toContain("icons/icon.icns");
  });

  it("icon.ico 与 icon.icns 存在且非空（避免桌面绿块/缺资源）", () => {
    const ico = join(iconsDir, "icon.ico");
    const icns = join(iconsDir, "icon.icns");
    expect(existsSync(ico), "icon.ico 缺失").toBe(true);
    expect(existsSync(icns), "icon.icns 缺失").toBe(true);
    expect(statSync(ico).size).toBeGreaterThan(1024);
    expect(statSync(icns).size).toBeGreaterThan(1024);
  });
});
