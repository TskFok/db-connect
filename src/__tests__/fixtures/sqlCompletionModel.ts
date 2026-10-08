import { vi } from "vitest";
import type * as Monaco from "monaco-editor";

type Change = { rangeOffset: number; rangeLength: number; text: string };

/** 仅替代 Monaco 存储和事件；provider、解析器、缓存及候选生成使用真实实现。 */
export function createSqlCompletionModel(initial: string, uri = "model:a") {
  let text = initial;
  let version = 1;
  let disposed = false;
  const changes = new Set<
    (event: Monaco.editor.IModelContentChangedEvent) => void
  >();
  const disposals = new Set<() => void>();
  const getPositionAt = (offset: number) => {
    const lines = text.slice(0, offset).split("\n");
    return {
      lineNumber: lines.length,
      column: lines[lines.length - 1].length + 1,
    };
  };
  const getValue = vi.fn(() => text);
  const model = {
    uri: { toString: () => uri },
    getValue,
    getVersionId: () => version,
    isDisposed: () => disposed,
    getPositionAt,
    getOffsetAt: (position: Monaco.IPosition) => {
      const lines = text.split("\n");
      return (
        lines
          .slice(0, position.lineNumber - 1)
          .reduce((sum, line) => sum + line.length + 1, 0) +
        position.column -
        1
      );
    },
    onDidChangeContent: (
      listener: (event: Monaco.editor.IModelContentChangedEvent) => void
    ) => {
      changes.add(listener);
      return { dispose: () => changes.delete(listener) };
    },
    onWillDispose: (listener: () => void) => {
      disposals.add(listener);
      return { dispose: () => disposals.delete(listener) };
    },
  } as unknown as Monaco.editor.ITextModel;
  return {
    model,
    getValue,
    position: () => getPositionAt(text.length) as Monaco.Position,
    subscriptions: () => changes.size + disposals.size,
    edit(
      edits: readonly Change[],
      options: {
        nextVersion?: number;
        flush?: boolean;
        silent?: boolean;
        undo?: boolean;
        redo?: boolean;
      } = {}
    ) {
      const eventChanges = edits.map((edit) => ({
        ...edit,
        range: {
          startLineNumber: getPositionAt(edit.rangeOffset).lineNumber,
          startColumn: getPositionAt(edit.rangeOffset).column,
          endLineNumber: getPositionAt(edit.rangeOffset + edit.rangeLength)
            .lineNumber,
          endColumn: getPositionAt(edit.rangeOffset + edit.rangeLength).column,
        },
      }));
      for (const edit of [...edits].sort(
        (a, b) => b.rangeOffset - a.rangeOffset
      )) {
        text =
          text.slice(0, edit.rangeOffset) +
          edit.text +
          text.slice(edit.rangeOffset + edit.rangeLength);
      }
      version = options.nextVersion ?? version + 1;
      if (!options.silent) {
        const event: Monaco.editor.IModelContentChangedEvent = {
          changes: eventChanges,
          eol: "\n",
          versionId: version,
          isFlush: options.flush ?? false,
          isUndoing: options.undo ?? false,
          isRedoing: options.redo ?? false,
          isEolChange: false,
          detailedReasonsChangeLengths: [],
        };
        for (const listener of [...changes]) listener(event);
      }
    },
    dispose() {
      for (const listener of [...disposals]) listener();
      disposed = true;
    },
  };
}
