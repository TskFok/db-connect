import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import {
  quoteSqlReference,
  registerSqlCompletionProvider,
  type SqlCompletionBinding,
} from "../utils/sqlCompletion";
import { buildSqlMetadataIndex } from "../utils/sqlCompletionMetadataIndex";

const key = {
  connId: "provider",
  database: "app",
  dialect: "postgres" as const,
  connectionRevision: 0,
};
const schema = {
  databases: ["app"],
  tables: [{ name: "users" }],
  columns: [{ table: "users", name: "name", type: "text" }],
};
function setup(sql: string, offset = sql.length) {
  const providers = new Set<Monaco.languages.CompletionItemProvider>();
  const monaco = {
    languages: {
      CompletionItemKind: {
        Keyword: 1,
        Module: 2,
        Class: 3,
        Field: 4,
        Function: 5,
        Variable: 6,
      },
      registerCompletionItemProvider: (
        _language: string,
        provider: Monaco.languages.CompletionItemProvider
      ) => {
        providers.add(provider);
        return { dispose: () => providers.delete(provider) };
      },
    },
  } as unknown as typeof Monaco;
  const positionAt = (at: number) => {
    const lines = sql.slice(0, at).split("\n");
    return {
      lineNumber: lines.length,
      column: lines[lines.length - 1].length + 1,
    };
  };
  const model = {
    uri: { toString: () => "model:a" },
    getValue: () => sql,
    getOffsetAt: () => offset,
    getPositionAt: positionAt,
    getVersionId: () => 1,
    isDisposed: () => false,
  } as unknown as Monaco.editor.ITextModel;
  let binding: SqlCompletionBinding | undefined = {
    key,
    index: buildSqlMetadataIndex(schema, key),
    revision: 0,
  };
  const disposable = registerSqlCompletionProvider(
    monaco,
    "model:a",
    () => binding
  );
  const provider = [...providers][0];
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose() {} }),
  };
  const run = (m = model) =>
    provider.provideCompletionItems(
      m,
      positionAt(offset) as Monaco.Position,
      { triggerKind: 0 },
      token
    ) as Monaco.languages.CompletionList;
  return {
    run,
    model,
    providers,
    disposable,
    token,
    setBinding: (b: SqlCompletionBinding | undefined) => {
      binding = b;
    },
  };
}

describe("模型绑定 SQL provider", () => {
  it("其他模型、取消和已解绑模型没有候选", () => {
    const s = setup("SELECT * FROM ");
    expect(
      s.run({
        ...s.model,
        uri: { toString: () => "model:b" },
      } as Monaco.editor.ITextModel).suggestions
    ).toEqual([]);
    s.token.isCancellationRequested = true;
    expect(s.run().suggestions).toEqual([]);
    s.token.isCancellationRequested = false;
    s.setBinding(undefined);
    expect(s.run().suggestions).toEqual([]);
    s.disposable.dispose();
    expect(s.providers.size).toBe(0);
  });
  it.each([
    [
      "SELECT * FROM users u WHERE u.na",
      'SELECT * FROM users u WHERE u."name"',
    ],
    [
      'SELECT * FROM users u WHERE u."na',
      'SELECT * FROM users u WHERE u."name"',
    ],
    [
      'SELECT * FROM users u WHERE u."na|me" AND 1=1',
      'SELECT * FROM users u WHERE u."name" AND 1=1',
    ],
  ])("接受候选正确替换 %s", (marked, expected) => {
    const offset = marked.includes("|") ? marked.indexOf("|") : marked.length;
    const sql = marked.replace("|", "");
    const s = setup(sql, offset);
    const item = s.run().suggestions.find((i) => i.insertText === '"name"')!;
    expect(item).toBeDefined();
    const range = item.range as Monaco.IRange;
    expect(
      sql.slice(0, range.startColumn - 1) +
        item.insertText +
        sql.slice(range.endColumn - 1)
    ).toBe(expected);
    expect(item.filterText).toBe(
      sql[range.startColumn - 1] === '"' ? '"name"' : "name"
    );
  });
  it("跨行引用、字符串和注释不提供候选", () => {
    for (const sql of [
      'SELECT * FROM users WHERE "na\nme',
      "SELECT 'abc",
      "SELECT /* a",
      "SELECT -- a",
    ]) {
      expect(setup(sql).run().suggestions).toEqual([]);
    }
  });
  it("拒绝不同 key 的索引，加载中保留安全关键词", () => {
    const s = setup("SELECT * FROM ");
    s.setBinding({
      key: { ...key, database: "other" },
      index: buildSqlMetadataIndex(schema, key),
      revision: 1,
    });
    expect(s.run().suggestions.some((i) => i.label === "users")).toBe(false);
    const empty = setup("");
    empty.setBinding({ key, revision: 0 });
    expect(empty.run().suggestions.some((i) => i.label === "SELECT")).toBe(
      true
    );
  });
  it("只通知预取，并用版本、绑定和取消令牌约束后续刷新", () => {
    const s = setup("SELECT * FROM ");
    const refresh = vi.fn();
    s.setBinding({ key, revision: 1, requestRefresh: refresh });
    s.run();
    const isCurrent = refresh.mock.calls[0][0] as () => boolean;
    expect(isCurrent()).toBe(true);
    s.token.isCancellationRequested = true;
    expect(isCurrent()).toBe(false);
    s.token.isCancellationRequested = false;
    s.setBinding({ key, revision: 2 });
    expect(isCurrent()).toBe(false);
  });
});

describe("SQL 引用的语义名称", () => {
  it("只折叠 PostgreSQL 未引用名称的 ASCII 大写", () => {
    expect(quoteSqlReference("U", false, "postgres")).toBe('"u"');
    expect(quoteSqlReference("U", true, "postgres")).toBe('"U"');
    expect(quoteSqlReference("ÄU", false, "postgres")).toBe('"Äu"');
    expect(quoteSqlReference("U", false, "mysql")).toBe("`U`");
  });
});
