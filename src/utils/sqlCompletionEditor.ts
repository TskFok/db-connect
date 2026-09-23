import type * as Monaco from "monaco-editor";
import {
  registerSqlCompletionProvider,
  sqlCompletionKeyId,
  type SqlCompletionBinding,
} from "./sqlCompletion";

type MetadataBinding = Omit<SqlCompletionBinding, "requestRefresh"> & {
  requestRefresh: () => Promise<boolean>;
};

/** 编辑器生命周期与建议菜单刷新；公共 provider 保持只依赖模型的纯计算边界。 */
export function registerSqlEditorCompletion(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  getMetadata: () => MetadataBinding
): Monaco.IDisposable & { updateBinding(): void } {
  let disposed = false;
  let bindingId = `${sqlCompletionKeyId(getMetadata().key)}:${getMetadata().revision}`;
  let provider: Monaco.IDisposable | undefined;
  const registerModel = () => {
    provider?.dispose();
    const model = editor.getModel();
    if (!model) return;
    provider = registerSqlCompletionProvider(
      monaco,
      model.uri.toString(),
      () => {
        if (disposed || editor.getModel() !== model) return undefined;
        const metadata = getMetadata();
        return {
          ...metadata,
          requestRefresh(isCurrent) {
            const position = editor.getPosition();
            void metadata.requestRefresh().then((changed) => {
              if (
                !changed ||
                disposed ||
                !isCurrent?.() ||
                editor.getModel() !== model ||
                !editor.hasTextFocus()
              )
                return;
              const currentPosition = editor.getPosition();
              if (
                !position ||
                currentPosition?.lineNumber !== position.lineNumber ||
                currentPosition.column !== position.column
              )
                return;
              // Monaco 没有公开的菜单可见状态 API。只检查本编辑器的可见 DOM；
              // DOM 结构不兼容时保守跳过，绝不主动重开菜单。
              if (
                editor.getDomNode()?.querySelector(".suggest-widget.visible")
              ) {
                // triggerSuggest 的公共 action 只在菜单隐藏时可执行。
                editor.trigger("sql-metadata", "hideSuggestWidget", {});
                editor.trigger(
                  "sql-metadata",
                  "editor.action.triggerSuggest",
                  {}
                );
              }
            });
          },
        };
      }
    );
  };
  registerModel();
  const modelChange = editor.onDidChangeModel(registerModel);
  const focus = editor.onDidFocusEditorText(() => {
    void getMetadata().requestRefresh();
  });
  return {
    updateBinding() {
      const current = getMetadata();
      const currentId = `${sqlCompletionKeyId(current.key)}:${current.revision}`;
      if (currentId !== bindingId) {
        bindingId = currentId;
        editor.trigger("sql-binding", "hideSuggestWidget", {});
      }
    },
    dispose() {
      disposed = true;
      provider?.dispose();
      modelChange.dispose();
      focus.dispose();
    },
  };
}
