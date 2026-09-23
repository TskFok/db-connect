import type * as Monaco from "monaco-editor";
import {
  registerSqlCompletionProvider,
  sqlCompletionKeyId,
  type SqlCompletionBinding,
} from "./sqlCompletion";

type MetadataBinding = Omit<SqlCompletionBinding, "requestRefresh"> & {
  requestRefresh: (onChanged?: () => void) => Promise<boolean>;
};

/** 编辑器生命周期与建议菜单刷新；公共 provider 保持只依赖模型的纯计算边界。 */
export function registerSqlEditorCompletion(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  getMetadata: () => MetadataBinding
): Monaco.IDisposable & { updateBinding(): void } {
  let disposed = false;
  let explicitSession = false;
  let openingExplicitMenu = false;
  const menuVisible = () =>
    !!editor.getDomNode()?.querySelector(".suggest-widget.visible");
  const endExplicitSession = () => {
    explicitSession = false;
    openingExplicitMenu = false;
  };
  let bindingId = `${sqlCompletionKeyId(getMetadata().key)}:${getMetadata().revision}:${getMetadata().sessionId ?? ""}`;
  let provider: Monaco.IDisposable | undefined;
  const registerModel = () => {
    endExplicitSession();
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
          get allowJoinRecommendations() {
            // 只在 provider 计算候选时消费首次打开标记；异步守卫读取绑定不改变会话。
            if (!openingExplicitMenu && !menuVisible()) explicitSession = false;
            openingExplicitMenu = false;
            return explicitSession;
          },
          requestRefresh(isCurrent) {
            const position = editor.getPosition();
            let notified = false;
            const refresh = () => {
              notified = true;
              if (
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
              if (menuVisible()) {
                openingExplicitMenu = explicitSession;
                // triggerSuggest 的公共 action 只在菜单隐藏时可执行。
                editor.trigger("sql-metadata", "hideSuggestWidget", {});
                editor.trigger(
                  "sql-metadata",
                  "editor.action.triggerSuggest",
                  {}
                );
              }
            };
            void metadata.requestRefresh(refresh).then((changed) => {
              if (changed && !notified) refresh();
            });
          },
        };
      }
    );
  };
  registerModel();
  // Monaco 的 Invoke 也用于 quickSuggestions。独立动作提供可观测的用户意图，
  // 覆盖常用补全快捷键，同时可从右键菜单/命令面板主动打开。
  const explicitAction = editor.addAction({
    id: "sql-completion.explicit",
    label: "SQL 智能补全",
    keybindings: [
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space,
      monaco.KeyMod.WinCtrl | monaco.KeyCode.Space,
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI,
    ],
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 1,
    run() {
      explicitSession = true;
      openingExplicitMenu = true;
      editor.trigger("sql-explicit", "hideSuggestWidget", {});
      editor.trigger("sql-explicit", "editor.action.triggerSuggest", {});
    },
  });
  const modelChange = editor.onDidChangeModel(registerModel);
  const blur = editor.onDidBlurEditorText(endExplicitSession);
  const focus = editor.onDidFocusEditorText(() => {
    void getMetadata().requestRefresh();
  });
  return {
    updateBinding() {
      const current = getMetadata();
      const currentId = `${sqlCompletionKeyId(current.key)}:${current.revision}:${current.sessionId ?? ""}`;
      if (currentId !== bindingId) {
        bindingId = currentId;
        endExplicitSession();
        editor.trigger("sql-binding", "hideSuggestWidget", {});
      }
    },
    dispose() {
      disposed = true;
      provider?.dispose();
      modelChange.dispose();
      focus.dispose();
      blur.dispose();
      explicitAction.dispose();
    },
  };
}
