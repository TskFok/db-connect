import { describe, it, expect } from "vitest";
import type { ColumnInfo } from "../types";
import {
  computeReorderPlacementAfterMove,
  columnInfoToReorderAlterRequest,
  describeColumnReorderPlacement,
} from "../utils/tableColumnReorder";

function col(name: string): ColumnInfo {
  return {
    name,
    column_type: "int",
    nullable: true,
    key: "",
    default_value: null,
    extra: "",
    comment: "",
  };
}

describe("computeReorderPlacementAfterMove", () => {
  const three = [col("a"), col("b"), col("c")];

  it("无移动时返回 null", () => {
    expect(computeReorderPlacementAfterMove(three, 1, 1)).toBeNull();
  });

  it("移到首位应 FIRST", () => {
    expect(computeReorderPlacementAfterMove(three, 1, 0)).toEqual({
      column: col("b"),
      placement: { kind: "first" },
    });
  });

  it("下移一位应 AFTER 前一列（新顺序中）", () => {
    // a b c -> b a c ：a 排到 index 1，前面是 b
    expect(computeReorderPlacementAfterMove(three, 0, 1)).toEqual({
      column: col("a"),
      placement: { kind: "after", column: "b" },
    });
  });

  it("移动到末尾仍可表达为 AFTER", () => {
    // a b c -> b c a
    expect(computeReorderPlacementAfterMove(three, 0, 2)).toEqual({
      column: col("a"),
      placement: { kind: "after", column: "c" },
    });
  });
});

describe("describeColumnReorderPlacement", () => {
  it("FIRST 文案", () => {
    expect(describeColumnReorderPlacement({ kind: "first" })).toBe(
      "移动到第一列"
    );
  });

  it("AFTER 文案", () => {
    expect(
      describeColumnReorderPlacement({ kind: "after", column: "user_id" })
    ).toBe("移动到列「user_id」之后");
  });
});

describe("columnInfoToReorderAlterRequest", () => {
  it("应携带与原列一致的类型信息并附上 column_placement", () => {
    const c = col("user_id");
    c.nullable = false;
    c.column_type = "bigint";
    expect(columnInfoToReorderAlterRequest(c, { kind: "first" })).toEqual({
      old_name: "user_id",
      new_name: "user_id",
      column_type: "bigint",
      nullable: false,
      default_value: null,
      extra: "",
      comment: "",
      column_placement: { kind: "first" },
    });
  });
});
