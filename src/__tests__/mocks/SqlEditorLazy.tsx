/** Vitest 全局替身：避免加载 monaco-editor（体积大且 jsdom 兼容性差） */
import React from "react";

export function SqlEditor() {
  return React.createElement("div", { "data-testid": "mock-sql-editor" });
}
