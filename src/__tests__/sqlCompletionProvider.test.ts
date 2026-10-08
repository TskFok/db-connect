import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import {
  quoteSqlReference,
  registerSqlCompletionProvider,
  type SqlCompletionBinding,
} from "../utils/sqlCompletion";
import { buildSqlMetadataIndex } from "../utils/sqlCompletionMetadataIndex";
import { createSqlCompletionModel } from "./fixtures/sqlCompletionModel";

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
  const fixture = createSqlCompletionModel(sql);
  const model = fixture.model;
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
  const run = (m = model, at = offset) =>
    provider.provideCompletionItems(
      m,
      m.getPositionAt(at),
      { triggerKind: 0 },
      token
    ) as Monaco.languages.CompletionList;
  return {
    ...fixture,
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

describe("provider 文档增量缓存和生命周期", () => {
  it("同模型同版本只读一次全文，普通编辑通过内容事件更新", () => {
    const sql = "SELECT * FROM users u WHERE u.na";
    const s = setup(sql);
    expect(
      s.run().suggestions.some((item) => item.insertText === '"name"')
    ).toBe(true);
    s.run();
    expect(s.getValue).toHaveBeenCalledTimes(1);
    expect(s.subscriptions()).toBe(2);
    s.edit([{ rangeOffset: sql.length, rangeLength: 0, text: "m" }]);
    expect(
      s
        .run(s.model, sql.length + 1)
        .suggestions.some((item) => item.insertText === '"name"')
    ).toBe(true);
    expect(s.getValue).toHaveBeenCalledTimes(1);
    s.disposable.dispose();
    expect(s.subscriptions()).toBe(0);
  });

  it.each(["跳跃事件", "漏事件", "flush"])("%s 只完整重建一次", (reason) => {
    const sql = "SELECT * FROM users u WHERE u.na";
    const s = setup(sql);
    s.run();
    s.edit([{ rangeOffset: sql.length, rangeLength: 0, text: "m" }], {
      nextVersion: reason === "跳跃事件" ? 4 : 2,
      silent: reason === "漏事件",
      flush: reason === "flush",
    });
    expect(
      s
        .run(s.model, sql.length + 1)
        .suggestions.some((item) => item.insertText === '"name"')
    ).toBe(true);
    s.run(s.model, sql.length + 1);
    expect(s.getValue).toHaveBeenCalledTimes(2);
    s.disposable.dispose();
  });

  it("相同 URI 新模型替换旧模型，清理订阅并使旧异步请求失效", () => {
    const s = setup("SELECT * FROM users u WHERE u.na");
    const refresh = vi.fn();
    s.setBinding({
      key,
      revision: 0,
      index: buildSqlMetadataIndex(schema, key),
      requestRefresh: refresh,
    });
    s.run();
    const previous = refresh.mock.calls[0][0] as () => boolean;
    const nextSql = "SELECT * FROM ";
    const next = createSqlCompletionModel(nextSql);
    expect(
      s
        .run(next.model, nextSql.length)
        .suggestions.some((item) => item.label === "users")
    ).toBe(true);
    expect(previous()).toBe(false);
    expect(s.subscriptions()).toBe(0);
    expect(next.subscriptions()).toBe(2);
    next.dispose();
    expect(next.subscriptions()).toBe(0);
    expect(s.run(next.model, nextSql.length).suggestions).toEqual([]);
    s.disposable.dispose();
  });

  it("反复更换模型后仅当前模型有订阅，解绑恢复基线", () => {
    const s = setup("SELECT * FROM ");
    s.run();
    const models = Array.from({ length: 12 }, () =>
      createSqlCompletionModel("SELECT * FROM ")
    );
    for (const next of models) s.run(next.model, 14);
    expect(s.subscriptions()).toBe(0);
    expect(
      models.reduce((count, item) => count + item.subscriptions(), 0)
    ).toBe(2);
    s.setBinding(undefined);
    expect(s.run(models[models.length - 1].model, 14).suggestions).toEqual([]);
    expect(models.every((item) => item.subscriptions() === 0)).toBe(true);
    s.disposable.dispose();
  });

  it("方言变更重建词法，同方言更换元数据和连接立即重新绑定 CTE 字段", () => {
    const sql = "WITH x AS (SELECT * FROM users) SELECT * FROM x WHERE x.";
    const s = setup(sql);
    expect(s.run().suggestions.map((item) => item.label)).toContain("x.name");
    const nextKey = { ...key, connectionRevision: 1 };
    s.setBinding({
      key: nextKey,
      revision: 1,
      index: buildSqlMetadataIndex(
        { ...schema, columns: [{ table: "users", name: "fresh" }] },
        nextKey
      ),
    });
    const fresh = s.run().suggestions.map((item) => item.label);
    expect(fresh).toContain("x.fresh");
    expect(fresh).not.toContain("x.name");
    expect(s.getValue).toHaveBeenCalledTimes(1);
    const mysqlKey = { ...nextKey, dialect: "mysql" as const };
    s.setBinding({
      key: mysqlKey,
      revision: 2,
      index: buildSqlMetadataIndex(schema, mysqlKey),
    });
    expect(
      s.run().suggestions.some((item) => item.insertText === "`name`")
    ).toBe(true);
    s.run();
    expect(s.getValue).toHaveBeenCalledTimes(2);
    s.disposable.dispose();
  });

  it("计算期间取消或绑定改变时也不发布候选", () => {
    const s = setup("SELECT * FROM ");
    s.setBinding({
      key,
      revision: 0,
      index: buildSqlMetadataIndex(schema, key),
      requestRefresh: () => {
        s.token.isCancellationRequested = true;
      },
    });
    expect(s.run().suggestions).toEqual([]);
    s.token.isCancellationRequested = false;
    s.setBinding({
      key,
      revision: 0,
      index: buildSqlMetadataIndex(schema, key),
      requestRefresh: () => {
        s.setBinding({ key, revision: 1 });
      },
    });
    expect(s.run().suggestions).toEqual([]);
    s.disposable.dispose();
  });

  it("同一双引号输入切换 MySQL 后采用字符串语义，切回 PostgreSQL 恢复标识符候选", () => {
    const s = setup('SELECT * FROM users u WHERE u."na');
    expect(
      s.run().suggestions.some((item) => item.insertText === '"name"')
    ).toBe(true);
    const mysqlKey = { ...key, dialect: "mysql" as const };
    s.setBinding({
      key: mysqlKey,
      revision: 1,
      index: buildSqlMetadataIndex(schema, mysqlKey),
    });
    expect(s.run().suggestions).toEqual([]);
    s.setBinding({
      key,
      revision: 2,
      index: buildSqlMetadataIndex(schema, key),
    });
    expect(
      s.run().suggestions.some((item) => item.insertText === '"name"')
    ).toBe(true);
    expect(s.getValue).toHaveBeenCalledTimes(3);
    s.disposable.dispose();
  });
});
