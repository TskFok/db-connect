import { describe, expect, it } from "vitest";
import {
  collectSelectedPrimaryKeyRows,
} from "../components/table/tableDataRowKeys";

describe("collectSelectedPrimaryKeyRows", () => {
  it("删除复合主键行时应收集每行完整主键对象", () => {
    const rows = [
      {
        _selectionKey: "orders|order_id=1|product_id=10",
        order_id: 1,
        product_id: 10,
        qty: 2,
      },
      {
        _selectionKey: "orders|order_id=1|product_id=11",
        order_id: 1,
        product_id: 11,
        qty: 3,
      },
    ];

    expect(
      collectSelectedPrimaryKeyRows(
        rows,
        ["order_id", "product_id"],
        new Set(["orders|order_id=1|product_id=11"])
      )
    ).toEqual([{ order_id: 1, product_id: 11 }]);
  });

  it("主键值缺失时跳过该行，避免构造无法唯一定位的删除请求", () => {
    const rows = [
      {
        _selectionKey: "orders|order_id=1|product_id=10",
        order_id: 1,
        product_id: undefined,
      },
    ];

    expect(
      collectSelectedPrimaryKeyRows(
        rows,
        ["order_id", "product_id"],
        new Set(["orders|order_id=1|product_id=10"])
      )
    ).toEqual([]);
  });
});
