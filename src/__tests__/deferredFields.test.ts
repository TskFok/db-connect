import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryFullRows } from "../services/tauriCommands";
import {
  fetchCompleteRows,
  hydrateDeferredRows,
} from "../components/table/deferredFields";

vi.mock("../services/tauriCommands", () => ({ queryFullRows: vi.fn() }));
const query = vi.mocked(queryFullRows);
const context = {
  connId: "c",
  database: "d",
  table: "t",
  primaryKeyColumns: ["id"],
};
const deferred = {
  __deferred_field: true,
  preview: "前缀",
  byte_length: 10000,
  kind: "text",
};
const result = (columns: string[], rows: unknown[][]) => ({
  columns,
  rows,
  total: rows.length,
  execution_time_ms: 1,
});

describe("大字段完整值批量读取", () => {
  beforeEach(() => vi.clearAllMocks());

  it("以一次查询批量补齐所需列，并按主键恢复顺序及保留普通值", async () => {
    query.mockResolvedValue(
      result(
        ["id", "body"],
        [
          [2, "完整二"],
          [1, "完整一"],
        ]
      )
    );
    const rows = [
      { id: 1, body: deferred, name: "一", _rowKey: 0 },
      { id: 2, body: deferred, name: "二", _rowKey: 1 },
    ];
    const hydrated = await hydrateDeferredRows(context, rows, ["name", "body"]);
    expect(hydrated.map((r) => [r.id, r.body, r.name, r._rowKey])).toEqual([
      [1, "完整一", "一", 0],
      [2, "完整二", "二", 1],
    ]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith("c", "d", "t", "id", [1, 2], undefined, [
      "body",
    ]);
    expect(rows[0].body).toBe(deferred);
  });

  it("未选择延迟列时不读取完整值", async () => {
    const rows = [{ id: 1, body: deferred, name: "普通" }];
    expect(await hydrateDeferredRows(context, rows, ["name"])).toEqual(rows);
    expect(query).not.toHaveBeenCalled();
  });

  it("其他数据库完整行中的同形 JSON 对象保持原值", async () => {
    query.mockResolvedValue(result(["id", "body"], [[1, deferred]]));
    const otherContext = { ...context, databaseType: "postgres" };
    const complete = await fetchCompleteRows(otherContext, [{ id: 1 }]);
    expect(complete.rows).toEqual([{ id: 1, body: deferred }]);
  });

  it("复合主键与超大整数字符串保持精确，NULL 完整值有效", async () => {
    query.mockResolvedValue(
      result(["tenant", "id", "body"], [["a", "9007199254740993", null]])
    );
    const rows = [{ tenant: "a", id: "9007199254740993", body: deferred }];
    expect(
      await hydrateDeferredRows(
        { ...context, primaryKeyColumns: ["tenant", "id"] },
        rows,
        ["body"]
      )
    ).toEqual([{ tenant: "a", id: "9007199254740993", body: null }]);
    expect(query).toHaveBeenCalledWith(
      "c",
      "d",
      "t",
      "tenant",
      [],
      [{ tenant: "a", id: "9007199254740993" }],
      ["body"]
    );
  });

  it.each([
    ["行已删除", ["id", "body"], []],
    [
      "返回重复行",
      ["id", "body"],
      [
        [1, "a"],
        [1, "b"],
      ],
    ],
    ["字段缺失", ["id"], [[1]]],
    ["仍是预览", ["id", "body"], [[1, deferred]]],
  ])("%s 时拒绝生成不完整导出", async (_, columns, rows) => {
    query.mockResolvedValue(result(columns as string[], rows as unknown[][]));
    await expect(
      hydrateDeferredRows(context, [{ id: 1, body: deferred }], ["body"])
    ).rejects.toThrow();
  });

  it("主键不完整时不发送查询", async () => {
    await expect(
      hydrateDeferredRows(context, [{ body: deferred }], ["body"])
    ).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });

  it("完整行回查包含隐藏列，并保留输入行顺序", async () => {
    query.mockResolvedValue(
      result(
        ["id", "body", "hidden"],
        [
          [2, "二", "隐藏二"],
          [1, "一", "隐藏一"],
        ]
      )
    );
    const complete = await fetchCompleteRows(context, [{ id: 1 }, { id: 2 }]);
    expect(complete.columns).toEqual(["id", "body", "hidden"]);
    expect(complete.rows).toEqual([
      { id: 1, body: "一", hidden: "隐藏一" },
      { id: 2, body: "二", hidden: "隐藏二" },
    ]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
