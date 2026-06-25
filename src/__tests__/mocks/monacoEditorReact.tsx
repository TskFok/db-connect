import type { ReactNode } from "react";
import React from "react";

/** Vitest 全局 @monaco-editor/react 替身 */
export default function MockMonacoEditor() {
  return React.createElement("div", { "data-testid": "mock-monaco-editor" });
}

export type OnMount = (editor: unknown, monaco: unknown) => void;

export const loader = {
  config: () => undefined,
  init: () => Promise.resolve(undefined),
};

export function MonacoEditor(_props: { value?: string; children?: ReactNode }) {
  return React.createElement("div", { "data-testid": "mock-monaco-editor" });
}
