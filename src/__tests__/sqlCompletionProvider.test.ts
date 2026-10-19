import { describe, expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
import {
  quoteSqlReference,
  registerSqlCompletionProvider,
  type SqlCompletionBinding,
  type SqlDialect,
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
function setup(
  sql: string,
  offset = sql.length,
  dialect: SqlDialect = "postgres"
) {
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
  const bindingKey = { ...key, dialect };
  let binding: SqlCompletionBinding | undefined = {
    key: bindingKey,
    index: buildSqlMetadataIndex(schema, bindingKey),
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

describe("provider MySQL SHOW 命令补全", () => {
  function suggest(marked: string, dialect: SqlDialect = "mysql") {
    const sql = marked.replace("|", "");
    const s = setup(sql, marked.indexOf("|"), dialect);
    const result = { sql, model: s.model, suggestions: s.run().suggestions };
    s.disposable.dispose();
    return result;
  }

  it.each([
    ["SH|", "SHOW FULL PROCESSLIST", "SHOW FULL PROCESSLIST"],
    ["SHOW |", "FULL PROCESSLIST", "SHOW FULL PROCESSLIST"],
    ["SHOW |", "PROCESSLIST", "SHOW PROCESSLIST"],
    ["SHOW FULL |", "PROCESSLIST", "SHOW FULL PROCESSLIST"],
    ["SHOW FULL PRO|CESSLIST", "PROCESSLIST", "SHOW FULL PROCESSLIST"],
    ["SHOW FU|LL PROCESSLIST", "FULL", "SHOW FULL PROCESSLIST"],
    ["show\tfull\npro|", "PROCESSLIST", "show\tfull\nPROCESSLIST"],
    [
      "SHOW /* 说明 */ FULL PRO|",
      "PROCESSLIST",
      "SHOW /* 说明 */ FULL PROCESSLIST",
    ],
    [
      "SELECT 1; SHOW FULL PRO|",
      "PROCESSLIST",
      "SELECT 1; SHOW FULL PROCESSLIST",
    ],
    [
      "SELECT '😀;中文'; SHOW FULL PRO|",
      "PROCESSLIST",
      "SELECT '😀;中文'; SHOW FULL PROCESSLIST",
    ],
  ])("接受命令候选正确替换 %s", (marked, insertText, expected) => {
    const { sql, model, suggestions } = suggest(marked);
    const item = suggestions.find(
      (candidate) => candidate.insertText === insertText
    );
    expect(item).toBeDefined();
    const range = item!.range as Monaco.IRange;
    const start = model.getOffsetAt({
      lineNumber: range.startLineNumber,
      column: range.startColumn,
    });
    const end = model.getOffsetAt({
      lineNumber: range.endLineNumber,
      column: range.endColumn,
    });
    expect(sql.slice(0, start) + item!.insertText + sql.slice(end)).toBe(
      expected
    );
  });

  it("光标右侧已有 PROCESSLIST 时不提供会重复尾部的候选", () => {
    const { suggestions } = suggest("SHOW FU|LL PROCESSLIST");
    expect(suggestions.some((item) => item.insertText === "FULL")).toBe(true);
    expect(
      suggestions.some((item) => item.insertText === "FULL PROCESSLIST")
    ).toBe(false);
  });

  it.each(["SHOW FULL PROCESSLIST |", "SHOW UNKNOWN |"])(
    "命令完成或无法识别后不回退语句起始关键词：%s",
    (marked) => {
      const { suggestions } = suggest(marked);
      expect(
        suggestions.some((item) =>
          /^(?:SELECT|INSERT(?: INTO)?|DELETE(?: FROM)?|UPDATE)$/.test(
            String(item.insertText)
          )
        )
      ).toBe(false);
    }
  );

  it.each([
    ["SHOW |", ["FULL", "DATABASES", "TABLES", "CREATE TABLE"]],
    ["SHOW FULL |", ["TABLES", "COLUMNS", "PROCESSLIST"]],
    ["SHOW GLOBAL |", ["VARIABLES", "STATUS"]],
    ["SHOW ENGINE INNODB |", ["STATUS"]],
  ])("按已输入的完整词提供后缀和下一单词：%s", (marked, expected) => {
    const { suggestions } = suggest(marked);
    expect(suggestions.map((item) => item.insertText)).toEqual(
      expect.arrayContaining(expected)
    );
  });

  it.each([
    "SHOW /* FULL PRO| */",
    "SHOW -- FULL PRO|\n",
    "SELECT 'SHOW FULL PRO|'",
    "SELECT SH| FROM users",
    "SELECT name AS SH| FROM users",
    "SELECT `SHOW` FU| FROM users",
    "`SHOW` FULL PRO|",
    "SHOW.`FU`|",
    "SELECT 1 SH|; SHOW FULL PROCESSLIST",
  ])("非命令位置不提供 PROCESSLIST 命令候选：%s", (marked) => {
    const { suggestions } = suggest(marked);
    expect(
      suggestions.some((item) =>
        /^(?:SHOW )?(?:FULL )?PROCESSLIST$/.test(String(item.insertText))
      )
    ).toBe(false);
  });

  it.each<SqlDialect>(["postgres", "sqlite", "sqlserver", "clickhouse"])(
    "%s 不提供 MySQL PROCESSLIST 命令候选",
    (dialect) => {
      for (const marked of ["SH|", "SHOW |", "SHOW FULL PRO|"]) {
        const { suggestions } = suggest(marked, dialect);
        expect(
          suggestions.some((item) =>
            /^(?:SHOW )?(?:FULL )?PROCESSLIST$/.test(String(item.insertText))
          )
        ).toBe(false);
      }
    }
  );

  it("元数据尚未加载时仍提供 SHOW 命令补全", () => {
    const s = setup("SHOW FULL PRO", undefined, "mysql");
    s.setBinding({ key: { ...key, dialect: "mysql" }, revision: 0 });
    expect(
      s.run().suggestions.some((item) => item.insertText === "PROCESSLIST")
    ).toBe(true);
    s.disposable.dispose();
  });
});

describe("provider MySQL 常用命令和函数补全", () => {
  function suggest(marked: string, dialect: SqlDialect = "mysql") {
    const offset = marked.indexOf("|");
    const sql = marked.replace("|", "");
    const s = setup(sql, offset, dialect);
    const result = { sql, model: s.model, suggestions: s.run().suggestions };
    s.disposable.dispose();
    return result;
  }

  function accept(
    result: ReturnType<typeof suggest>,
    item: Monaco.languages.CompletionItem
  ) {
    const range = item.range as Monaco.IRange;
    const start = result.model.getOffsetAt({
      lineNumber: range.startLineNumber,
      column: range.startColumn,
    });
    const end = result.model.getOffsetAt({
      lineNumber: range.endLineNumber,
      column: range.endColumn,
    });
    return result.sql.slice(0, start) + item.insertText + result.sql.slice(end);
  }

  it("语句起始的关键词与函数整句模板不重复候选", () => {
    const filters = suggest("|").suggestions.map((item) => item.filterText);
    expect(filters.filter((filter) => filter === "SELECT")).toHaveLength(1);
    expect(new Set(filters).size).toBe(filters.length);
  });

  it.each([
    ["STA|", "START TRANSACTION", "START TRANSACTION"],
    ["COM|", "COMMIT", "COMMIT"],
    ["ROLL|", "ROLLBACK", "ROLLBACK"],
    ["SAVE|", "SAVEPOINT", "SAVEPOINT"],
    ["REL|", "RELEASE SAVEPOINT", "RELEASE SAVEPOINT"],
    ["SET|", "SET GLOBAL", "SET GLOBAL"],
    ["ANAL|", "ANALYZE TABLE", "ANALYZE TABLE"],
    ["CHE|", "CHECK TABLE", "CHECK TABLE"],
    ["OPT|", "OPTIMIZE TABLE", "OPTIMIZE TABLE"],
    ["SE|", "SELECT VERSION()", "SELECT VERSION()"],
    ["SE|", "SELECT DATABASE()", "SELECT DATABASE()"],
    ["START |", "TRANSACTION", "START TRANSACTION"],
    ["ROLLBACK |", "TO SAVEPOINT", "ROLLBACK TO SAVEPOINT"],
    ["RELEASE |", "SAVEPOINT", "RELEASE SAVEPOINT"],
    ["SET SESSION au|", "autocommit", "SET SESSION autocommit"],
    ["SET GLOBAL au|", "autocommit", "SET GLOBAL autocommit"],
    ["SET PERSIST au|", "autocommit", "SET PERSIST autocommit"],
    ["ANALYZE TABLE us|", "`users`", "ANALYZE TABLE `users`"],
    ["CHECK TABLE us|", "`users`", "CHECK TABLE `users`"],
    ["OPTIMIZE TABLE us|", "`users`", "OPTIMIZE TABLE `users`"],
    ["ANALYZE TABLE users, us|", "`users`", "ANALYZE TABLE users, `users`"],
    ["CHECK TABLE users, us|", "`users`", "CHECK TABLE users, `users`"],
    ["OPTIMIZE TABLE users, us|", "`users`", "OPTIMIZE TABLE users, `users`"],
    ["ANALYZE TABLE app.us|", "`users`", "ANALYZE TABLE app.`users`"],
    ["CHECK TABLE app.us|", "`users`", "CHECK TABLE app.`users`"],
    ["OPTIMIZE TABLE app.us|", "`users`", "OPTIMIZE TABLE app.`users`"],
    ["SELECT VER|", "VERSION()", "SELECT VERSION()"],
    ["SELECT DATA|", "DATABASE()", "SELECT DATABASE()"],
    ["start\ttran|", "TRANSACTION", "start\tTRANSACTION"],
    [
      "SELECT '😀;中文';\nset session au|",
      "autocommit",
      "SELECT '😀;中文';\nset session autocommit",
    ],
    [
      "SELECT 1;\noptimize\ntable us|",
      "`users`",
      "SELECT 1;\noptimize\ntable `users`",
    ],
    ["SELECT /* 版本 */ ver|", "VERSION()", "SELECT /* 版本 */ VERSION()"],
  ])("接受候选得到可执行的命令或函数：%s", (marked, insertText, expected) => {
    const result = suggest(marked);
    const item = result.suggestions.find(
      (candidate) => candidate.insertText === insertText
    );
    expect(item).toBeDefined();
    expect(accept(result, item!)).toBe(expected);
  });

  it("SET 提供作用域后缀和常用静态系统变量", () => {
    expect(suggest("SET |").suggestions.map((item) => item.insertText)).toEqual(
      expect.arrayContaining(["GLOBAL", "SESSION", "PERSIST"])
    );
    expect(
      suggest("SET SESSION |").suggestions.map((item) => item.insertText)
    ).toEqual(expect.arrayContaining(["autocommit", "sql_mode", "time_zone"]));
  });

  it("max_connections 仅在 GLOBAL 和 PERSIST 作用域补全", () => {
    for (const scope of ["GLOBAL", "PERSIST"]) {
      expect(
        suggest(`SET ${scope} max_con|`).suggestions.some(
          (item) => item.insertText === "max_connections"
        )
      ).toBe(true);
    }
    expect(
      suggest("SET SESSION max_con|").suggestions.some(
        (item) => item.insertText === "max_connections"
      )
    ).toBe(false);
  });

  it.each(["VERSION", "DATABASE"])(
    "%s 右侧已有括号时接受补全不重复括号",
    (name) => {
      const result = suggest(`SELECT ${name}|()`);
      const item = result.suggestions.find(
        (candidate) => candidate.label === name
      );
      expect(item).toBeDefined();
      expect(item!.insertText).toBe(name);
      expect(accept(result, item!)).toBe(`SELECT ${name}()`);
    }
  );

  it.each([
    ["SELECT VER|SION()", "VERSION", "SELECT VERSION()"],
    ["SELECT DATA|BASE()", "DATABASE", "SELECT DATABASE()"],
  ])("函数词中接受补全保留右侧括号：%s", (marked, name, expected) => {
    const result = suggest(marked);
    const item = result.suggestions.find(
      (candidate) => candidate.label === name
    );
    expect(item).toBeDefined();
    expect(item!.filterText).toBe(name);
    expect(accept(result, item!)).toBe(expected);
  });

  it("元数据尚未加载时仍提供静态 SET 和函数候选", () => {
    for (const [sql, expected] of [
      ["SET SESSION au", "autocommit"],
      ["SELECT VER", "VERSION()"],
    ]) {
      const s = setup(sql, sql.length, "mysql");
      s.setBinding({ key: { ...key, dialect: "mysql" }, revision: 0 });
      expect(
        s.run().suggestions.some((item) => item.insertText === expected)
      ).toBe(true);
      s.disposable.dispose();
    }
  });

  it("UPDATE 的 SET 继续补全字段，不混入系统变量作用域", () => {
    const result = suggest("UPDATE users SET na|");
    expect(
      result.suggestions.some((item) => item.insertText === "`name`")
    ).toBe(true);
    expect(
      suggest("UPDATE users SET |").suggestions.some((item) =>
        /^(?:SET )?(?:GLOBAL|SESSION|PERSIST)$/.test(String(item.insertText))
      )
    ).toBe(false);
    expect(
      suggest("UPDATE users SET au|").suggestions.some(
        (item) => item.insertText === "autocommit"
      )
    ).toBe(false);
  });

  it.each([
    "SELECT 'START TRAN|",
    'SELECT "SET SESSION au|',
    "SELECT /* OPTIMIZE TABLE us| */",
    "SET -- SESSION au|\n",
  ])("字符串和注释中不补全命令或函数：%s", (marked) => {
    expect(suggest(marked).suggestions).toEqual([]);
  });

  it.each<SqlDialect>(["postgres", "sqlite", "sqlserver", "clickhouse"])(
    "%s 不泄漏新增 MySQL 专属命令和函数候选",
    (dialect) => {
      for (const [marked, forbidden] of [
        ["SET |", "PERSIST"],
        ["CHE|", "CHECK TABLE"],
        ["OPT|", "OPTIMIZE TABLE"],
        ["SELECT VER|", "VERSION()"],
        ["SELECT DATA|", "DATABASE()"],
      ]) {
        expect(
          suggest(marked, dialect).suggestions.some(
            (item) => item.insertText === forbidden
          )
        ).toBe(false);
      }
    }
  );
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
