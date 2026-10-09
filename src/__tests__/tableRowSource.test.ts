import { describe, expect, it } from "vitest";
import { createTableRowSource } from "../components/table/tableRowSource";

// 全页记录转换、错误的复合主键或把 pending 值写回原数组都会破坏这些断言。
describe("二维表行源", () => {
  it("建立 10000×200 页快照只读取主键，按需读单元格", () => {
    let reads = 0;
    const rows = Array.from(
      { length: 10000 },
      (_, index) =>
        new Proxy(
          Array.from({ length: 200 }, (_, c) => index * 200 + c),
          {
            get(target, key, receiver) {
              if (/^\d+$/.test(String(key)) && key !== "0") reads++;
              return Reflect.get(target, key, receiver);
            },
          }
        )
    );
    const source = createTableRowSource({
      rows,
      columns: Array.from({ length: 200 }, (_, i) => `c${i}`),
      primaryKeyColumns: ["c0"],
      scopeKey: "conn|db|table",
      page: 1,
    });
    expect(source.rowCount).toBe(10000);
    expect(reads).toBe(0);
    source.getCell(2, "c3");
    expect(reads).toBe(1);
  });

  it("复合主键沿用既有键值，缺失主键退回页内位置", () => {
    const source = createTableRowSource({
      rows: [[3, "西"], [4]],
      columns: ["id", "region"],
      primaryKeyColumns: ["id", "region"],
      scopeKey: "conn|db|table",
      page: 7,
    });
    expect(source.getRowKey(0)).toBe('conn|db|table|id=3|region="西"');
    expect(source.getRowKey(1)).toBe("conn|db|table|page=7|row=1");
    expect(source.getPrimaryKeys(0)).toEqual({ id: 3, region: "西" });
  });

  it("仅物化请求行列、原页身份和主键，保留原值且不修改输入", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      Object.freeze([i, `原值${i}`, "隐藏"])
    );
    const source = createTableRowSource({
      rows,
      columns: ["id", "name", "secret"],
      primaryKeyColumns: ["id"],
      scopeKey: "s",
      page: 2,
    });
    const records = source.materializeRows([2, 7], ["name"]);
    expect(records).toEqual([
      { id: 2, name: "原值2", _rowKey: 2, _selectionKey: "s|id=2" },
      { id: 7, name: "原值7", _rowKey: 7, _selectionKey: "s|id=7" },
    ]);
    records[0].name = "待提交";
    expect(source.getCell(2, "name")).toBe("原值2");
    expect(source.materializeRows([], ["name"])).toEqual([]);
  });
});
