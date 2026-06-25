import React from "react";
import ReactDOM from "react-dom/client";
import { ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import App from "./App";
import { getRuntimeInfo } from "./services/tauriCommands";
import { useThemeStore, applyThemeToDOM } from "./stores/themeStore";
import {
  logStoredCrashBreadcrumbs,
  setRuntimeInfoBreadcrumb,
} from "./utils/crashBreadcrumbs";
import "./App.css";

// 初始化时同步 DOM 主题属性
applyThemeToDOM(useThemeStore.getState().mode);

// 全局禁用 macOS WebKit 自动大写/纠正：对所有动态创建的 input/textarea 强制设置属性
const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node instanceof HTMLElement) {
        const targets =
          node.tagName === "INPUT" || node.tagName === "TEXTAREA"
            ? [node]
            : node.querySelectorAll<HTMLElement>("input, textarea");
        for (const el of targets) {
          el.setAttribute("autocapitalize", "off");
          el.setAttribute("autocorrect", "off");
          el.setAttribute("spellcheck", "false");
        }
      }
    }
  }
});
observer.observe(document.body, { childList: true, subtree: true });

logStoredCrashBreadcrumbs();
void getRuntimeInfo()
  .then((runtimeInfo) => {
    setRuntimeInfoBreadcrumb(runtimeInfo);
  })
  .catch((error) => {
    console.warn("[crash-breadcrumbs] 获取运行时信息失败", error);
  });

function Root() {
  const mode = useThemeStore((s) => s.mode);

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm:
          mode === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: "#1677ff",
          borderRadius: 6,
        },
      }}
    >
      <App />
    </ConfigProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
