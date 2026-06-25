/** Vitest 全局 monaco-editor 轻量 stub */

export const KeyMod = { CtrlCmd: 1 };
export const KeyCode = { Enter: 2 };

export const languages = {
  registerCompletionItemProvider: () => ({ dispose: () => undefined }),
};

export type IStandaloneCodeEditor = unknown;

export type editor = {
  IStandaloneCodeEditor: IStandaloneCodeEditor;
};
