import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import { registerSqlEditorCompletion } from "../utils/sqlCompletionEditor";
import { buildSqlMetadataIndex } from "../utils/sqlCompletionMetadataIndex";

function setup() {
  const key = {
    connId: "editor",
    database: "app",
    dialect: "mysql" as const,
    connectionRevision: 0,
  };
  let finish!: (changed: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const metadata = {
    key,
    revision: 0,
    index: buildSqlMetadataIndex(
      { databases: [], tables: [], columns: [] },
      key
    ),
    requestRefresh: vi.fn(() => promise),
  };
  let provider!: Monaco.languages.CompletionItemProvider;
  const dispose = vi.fn();
  const model = {
    uri: { toString: () => "editor:a" },
    getVersionId: () => 1,
    getValue: () => "SELECT ",
    getOffsetAt: () => 7,
    getPositionAt: (offset: number) => ({ lineNumber: 1, column: offset + 1 }),
    isDisposed: () => false,
  };
  const dom = document.createElement("div");
  dom.innerHTML = '<div class="suggest-widget visible"></div>';
  const editor = {
    getModel: () => model,
    getPosition: () => ({ lineNumber: 1, column: 8 }),
    hasTextFocus: () => true,
    getDomNode: () => dom,
    trigger: vi.fn(),
    onDidChangeModel: () => ({ dispose: vi.fn() }),
    onDidFocusEditorText: () => ({ dispose: vi.fn() }),
  };
  const monaco = {
    languages: {
      CompletionItemKind: {},
      registerCompletionItemProvider: (
        _lang: string,
        p: Monaco.languages.CompletionItemProvider
      ) => {
        provider = p;
        return { dispose };
      },
    },
  };
  const registration = registerSqlEditorCompletion(
    monaco as unknown as typeof Monaco,
    editor as unknown as Monaco.editor.IStandaloneCodeEditor,
    () => metadata
  );
  const token = { isCancellationRequested: false };
  provider.provideCompletionItems(
    model as unknown as Monaco.editor.ITextModel,
    editor.getPosition() as Monaco.Position,
    { triggerKind: 0 },
    token as Monaco.CancellationToken
  );
  return { finish, registration, editor, model, metadata, dom, token, dispose };
}

describe("元数据到达时只刷新仍然有效的建议菜单", () => {
  it("原模型/光标/绑定/菜单均有效时刷新", async () => {
    const s = setup();
    s.finish(true);
    await Promise.resolve();
    // triggerSuggest 的 Monaco precondition 要求菜单已隐藏，所以刷新先同步关闭旧菜单。
    expect(s.editor.trigger.mock.calls).toEqual([
      ["sql-metadata", "hideSuggestWidget", {}],
      ["sql-metadata", "editor.action.triggerSuggest", {}],
    ]);
  });
  it("绑定切换即关闭旧菜单，避免仍接受上一库的候选", () => {
    const s = setup();
    s.metadata.revision++;
    s.registration.updateBinding();
    expect(s.editor.trigger).toHaveBeenCalledWith(
      "sql-binding",
      "hideSuggestWidget",
      {}
    );
  });
  it.each([
    "closed",
    "cursor",
    "version",
    "binding",
    "cancelled",
    "blur",
    "dispose",
  ])("%s 后不重开或刷新建议", async (reason) => {
    const s = setup();
    if (reason === "closed") s.dom.innerHTML = "";
    if (reason === "cursor")
      s.editor.getPosition = () => ({ lineNumber: 1, column: 9 });
    if (reason === "version") s.model.getVersionId = () => 2;
    if (reason === "binding") s.metadata.revision++;
    if (reason === "cancelled") s.token.isCancellationRequested = true;
    if (reason === "blur") s.editor.hasTextFocus = () => false;
    if (reason === "dispose") s.registration.dispose();
    s.finish(true);
    await Promise.resolve();
    expect(s.editor.trigger).not.toHaveBeenCalled();
  });
});
