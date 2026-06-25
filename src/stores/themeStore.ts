import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemeMode = "dark" | "light";

interface ThemeState {
  /** 当前主题模式 */
  mode: ThemeMode;
  /** 切换主题 */
  toggleTheme: () => void;
  /** 设置主题 */
  setTheme: (mode: ThemeMode) => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set, get) => ({
      mode: "dark",

      toggleTheme: () => {
        const next = get().mode === "dark" ? "light" : "dark";
        set({ mode: next });
        applyThemeToDOM(next);
      },

      setTheme: (mode: ThemeMode) => {
        set({ mode });
        applyThemeToDOM(mode);
      },
    }),
    {
      name: "db-connect-theme",
    }
  )
);

/** 将主题 class 同步到 <html> 元素，用于 CSS 变量切换 */
export function applyThemeToDOM(mode: ThemeMode) {
  const root = document.documentElement;
  root.setAttribute("data-theme", mode);
}
