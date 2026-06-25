import { describe, it, expect, beforeEach } from "vitest";
import { useThemeStore, applyThemeToDOM } from "../stores/themeStore";

describe("themeStore", () => {
  beforeEach(() => {
    // 重置 store 状态
    useThemeStore.setState({ mode: "dark" });
    // 重置 DOM
    document.documentElement.removeAttribute("data-theme");
  });

  describe("初始状态", () => {
    it("默认应该是暗色主题", () => {
      const state = useThemeStore.getState();
      expect(state.mode).toBe("dark");
    });
  });

  describe("toggleTheme", () => {
    it("应该从暗色切换到浅色", () => {
      useThemeStore.getState().toggleTheme();
      expect(useThemeStore.getState().mode).toBe("light");
    });

    it("应该从浅色切换回暗色", () => {
      useThemeStore.setState({ mode: "light" });
      useThemeStore.getState().toggleTheme();
      expect(useThemeStore.getState().mode).toBe("dark");
    });

    it("切换主题时应该更新 DOM data-theme 属性", () => {
      useThemeStore.getState().toggleTheme();
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");

      useThemeStore.getState().toggleTheme();
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    });
  });

  describe("setTheme", () => {
    it("应该设置为指定主题", () => {
      useThemeStore.getState().setTheme("light");
      expect(useThemeStore.getState().mode).toBe("light");
    });

    it("应该同步更新 DOM", () => {
      useThemeStore.getState().setTheme("light");
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
  });

  describe("applyThemeToDOM", () => {
    it("应该在 <html> 元素上设置 data-theme 属性", () => {
      applyThemeToDOM("dark");
      expect(document.documentElement.getAttribute("data-theme")).toBe("dark");

      applyThemeToDOM("light");
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    });
  });
});
