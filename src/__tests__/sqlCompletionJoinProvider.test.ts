import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import {
  registerSqlCompletionProvider,
  type SqlCompletionBinding,
} from "../utils/sqlCompletion";
import { buildSqlMetadataIndex } from "../utils/sqlCompletionMetadataIndex";
import type { SqlCompletionForeignKeyResult } from "../types";

const key = {
  connId: "join-provider",
  database: "sales",
  dialect: "postgres" as const,
  connectionRevision: 0,
};
const ready: SqlCompletionForeignKeyResult = {
  status: "ready",
  foreignKeys: [
    {
      id: "sales.orders/fk_customer",
      constraintName: "fk_customer",
      tableNamespace: "sales",
      tableName: "orders",
      columns: ["customer_id"],
      referencedNamespace: "sales",
      referencedTable: "customers",
      referencedColumns: ["id"],
    },
  ],
};
function setup(marked: string) {
  const offset = marked.includes("|") ? marked.indexOf("|") : marked.length;
  const sql = marked.replace("|", "");
  let provider!: Monaco.languages.CompletionItemProvider;
  const monaco = {
    languages: {
      CompletionItemKind: {
        Module: 2,
        Class: 3,
        Field: 4,
        Keyword: 1,
        Function: 5,
      },
      registerCompletionItemProvider: (
        _lang: string,
        value: Monaco.languages.CompletionItemProvider
      ) => {
        provider = value;
        return { dispose() {} };
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
    uri: { toString: () => "join-model" },
    getValue: () => sql,
    getVersionId: () => 1,
    isDisposed: () => false,
    getOffsetAt: () => offset,
    getPositionAt: positionAt,
    setValue: vi.fn(),
    applyEdits: vi.fn(),
  };
  let binding: SqlCompletionBinding = {
    key,
    revision: 0,
    sessionId: "tab-a",
    allowJoinRecommendations: true,
    index: buildSqlMetadataIndex(
      {
        databases: ["sales"],
        tables: [{ name: "orders" }, { name: "customers" }],
        columns: [
          { table: "orders", name: "customer_id", type: "int" },
          { table: "customers", name: "id", type: "int" },
        ],
      },
      key
    ),
    foreignKeys: { key, result: ready },
  };
  const registration = registerSqlCompletionProvider(
    monaco,
    "join-model",
    () => binding
  );
  const token = { isCancellationRequested: false };
  return {
    sql,
    model,
    token,
    registration,
    binding: () => binding,
    setBinding: (next: SqlCompletionBinding) => {
      binding = next;
    },
    run: (triggerKind = 0) =>
      provider.provideCompletionItems(
        model as unknown as Monaco.editor.ITextModel,
        positionAt(offset) as Monaco.Position,
        { triggerKind },
        token as Monaco.CancellationToken
      ) as Monaco.languages.CompletionList,
  };
}
const relations = (list: Monaco.languages.CompletionList) =>
  list.suggestions.filter((item) => item.kind === 2);

describe("JOIN 外键关系 provider", () => {
  it("显式补全返回完整条件，接受时仅替换当前前缀，不主动改写模型", () => {
    const s = setup("SELECT * FROM orders o\nJOIN customers c ON cus|");
    const item = relations(s.run())[0];
    expect(item?.insertText).toBe('"o"."customer_id" = "c"."id"');
    expect(item.range).toEqual({
      startLineNumber: 2,
      endLineNumber: 2,
      startColumn: 21,
      endColumn: 24,
    });
    expect(item.filterText).toContain("cus");
    expect(s.model.setValue).not.toHaveBeenCalled();
    expect(s.model.applyEdits).not.toHaveBeenCalled();
    const start = s.sql.lastIndexOf("cus");
    expect(s.sql.slice(0, start) + item.insertText).toBe(
      'SELECT * FROM orders o\nJOIN customers c ON "o"."customer_id" = "c"."id"'
    );
  });
  it.each([
    "SELECT * FROM orders o JOIN customers c ON o.customer_id = c.id|",
    "SELECT * FROM orders o JOIN customers c ON |o.customer_id = c.id",
    "SELECT * FROM orders o WHERE |",
    "WITH x AS (SELECT * FROM orders) SELECT * FROM x JOIN customers c ON |",
  ])("普通位置或已有表达式无关系项：%s", (sql) => {
    const s = setup(sql);
    expect(relations(s.run())).toEqual([]);
    expect(s.run().suggestions.length).toBeGreaterThan(0);
  });
  it.each([
    undefined,
    { key, result: { status: "unsupported", foreignKeys: [] } },
    { key, result: { status: "ready", foreignKeys: [] } },
    { key: { ...key, database: "old" }, result: ready },
  ] as Array<SqlCompletionBinding["foreignKeys"]>)(
    "缺失、失败、unsupported、不同 key 快照保持普通建议",
    (foreignKeys) => {
      const s = setup("SELECT * FROM orders o JOIN customers c ON |");
      s.setBinding({ ...s.binding(), foreignKeys });
      expect(relations(s.run())).toEqual([]);
      expect(s.run().suggestions.some((item) => item.kind === 4)).toBe(true);
    }
  );
  it("JOIN 左侧混有 CTE 时仍为真实表提供关系项", () => {
    const s = setup(
      "WITH x AS (SELECT customer_id FROM orders) SELECT * FROM x JOIN orders o ON x.customer_id = o.customer_id JOIN customers c ON |"
    );
    expect(relations(s.run())[0]?.insertText).toBe(
      '"o"."customer_id" = "c"."id"'
    );
  });
  it("跨 schema 的 FK 不依赖另一 schema 的列快照", () => {
    const s = setup("SELECT * FROM sales.orders o JOIN auth.customers c ON |");
    s.setBinding({
      ...s.binding(),
      foreignKeys: {
        key,
        result: {
          status: "ready",
          foreignKeys: [
            { ...ready.foreignKeys[0], referencedNamespace: "auth" },
          ],
        },
      },
    });
    expect(relations(s.run())[0]?.insertText).toBe(
      '"o"."customer_id" = "c"."id"'
    );
  });
  it("自动触发字符不显示关系，显式请求才显示", () => {
    const s = setup("SELECT * FROM orders o JOIN customers c ON |");
    s.setBinding({ ...s.binding(), allowJoinRecommendations: false });
    expect(relations(s.run(0))).toEqual([]); // Monaco 的自动快速建议同样使用 Invoke。
    s.setBinding({ ...s.binding(), allowJoinRecommendations: true });
    expect(relations(s.run(0))).toHaveLength(1);
    expect(relations(s.run(2))).toHaveLength(1); // 显式会话继续键入。
  });
  it.each(["tab", "connection", "version", "cancel", "dispose"])(
    "%s 变化后慢请求不得刷新旧建议",
    (reason) => {
      const s = setup("SELECT * FROM orders o JOIN customers c ON |");
      const refresh = vi.fn();
      s.setBinding({ ...s.binding(), requestRefresh: refresh });
      s.run();
      const current = refresh.mock.calls[0][0] as () => boolean;
      expect(current()).toBe(true);
      if (reason === "tab")
        s.setBinding({ ...s.binding(), sessionId: "tab-b" });
      if (reason === "connection")
        s.setBinding({
          ...s.binding(),
          key: { ...key, connectionRevision: 1 },
        });
      if (reason === "version") s.model.getVersionId = () => 2;
      if (reason === "cancel") s.token.isCancellationRequested = true;
      if (reason === "dispose") s.registration.dispose();
      expect(current()).toBe(false);
    }
  );
});
