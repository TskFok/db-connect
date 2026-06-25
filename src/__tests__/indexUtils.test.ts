import { describe, it, expect } from "vitest";
import {
  getIndexKind,
  getIndexMethod,
  indexColumnsToFormValues,
} from "../utils/indexUtils";
import type { IndexInfo } from "../types";

/** 创建测试用的 IndexInfo */
function makeIndex(overrides: Partial<IndexInfo> = {}): IndexInfo {
  return {
    name: "idx_test",
    unique: false,
    index_type: "BTREE",
    columns: [],
    is_primary: false,
    comment: "",
    ...overrides,
  };
}

describe("getIndexKind", () => {
  it("FULLTEXT 索引 → 返回 FULLTEXT", () => {
    expect(getIndexKind(makeIndex({ index_type: "FULLTEXT" }))).toBe("FULLTEXT");
  });

  it("SPATIAL 索引 → 返回 SPATIAL", () => {
    expect(getIndexKind(makeIndex({ index_type: "SPATIAL" }))).toBe("SPATIAL");
  });

  it("唯一索引 (BTREE) → 返回 UNIQUE", () => {
    expect(
      getIndexKind(makeIndex({ unique: true, index_type: "BTREE" }))
    ).toBe("UNIQUE");
  });

  it("唯一索引 (HASH) → 返回 UNIQUE", () => {
    expect(
      getIndexKind(makeIndex({ unique: true, index_type: "HASH" }))
    ).toBe("UNIQUE");
  });

  it("普通索引 (BTREE) → 返回 INDEX", () => {
    expect(
      getIndexKind(makeIndex({ unique: false, index_type: "BTREE" }))
    ).toBe("INDEX");
  });

  it("普通索引 (HASH) → 返回 INDEX", () => {
    expect(
      getIndexKind(makeIndex({ unique: false, index_type: "HASH" }))
    ).toBe("INDEX");
  });

  it("FULLTEXT 优先于 unique 判断", () => {
    expect(
      getIndexKind(makeIndex({ unique: true, index_type: "FULLTEXT" }))
    ).toBe("FULLTEXT");
  });
});

describe("getIndexMethod", () => {
  it("BTREE 索引 → 返回 BTREE", () => {
    expect(getIndexMethod(makeIndex({ index_type: "BTREE" }))).toBe("BTREE");
  });

  it("HASH 索引 → 返回 HASH", () => {
    expect(getIndexMethod(makeIndex({ index_type: "HASH" }))).toBe("HASH");
  });

  it("FULLTEXT 索引 → 返回 undefined", () => {
    expect(getIndexMethod(makeIndex({ index_type: "FULLTEXT" }))).toBeUndefined();
  });

  it("SPATIAL 索引 → 返回 undefined", () => {
    expect(getIndexMethod(makeIndex({ index_type: "SPATIAL" }))).toBeUndefined();
  });
});

describe("indexColumnsToFormValues", () => {
  it("空列列表 → 返回空数组", () => {
    expect(indexColumnsToFormValues(makeIndex({ columns: [] }))).toEqual([]);
  });

  it("单列无前缀无排序", () => {
    const result = indexColumnsToFormValues(
      makeIndex({
        columns: [
          {
            column_name: "email",
            seq_in_index: 1,
            collation: "A",
            sub_part: null,
          },
        ],
      })
    );
    expect(result).toEqual([
      { column_name: "email", length: undefined, order: "ASC" },
    ]);
  });

  it("单列有前缀长度", () => {
    const result = indexColumnsToFormValues(
      makeIndex({
        columns: [
          {
            column_name: "name",
            seq_in_index: 1,
            collation: "A",
            sub_part: 10,
          },
        ],
      })
    );
    expect(result).toEqual([
      { column_name: "name", length: 10, order: "ASC" },
    ]);
  });

  it("列排序为 DESC", () => {
    const result = indexColumnsToFormValues(
      makeIndex({
        columns: [
          {
            column_name: "created_at",
            seq_in_index: 1,
            collation: "D",
            sub_part: null,
          },
        ],
      })
    );
    expect(result).toEqual([
      { column_name: "created_at", length: undefined, order: "DESC" },
    ]);
  });

  it("列排序为 null → order 为 undefined", () => {
    const result = indexColumnsToFormValues(
      makeIndex({
        columns: [
          {
            column_name: "data",
            seq_in_index: 1,
            collation: null,
            sub_part: null,
          },
        ],
      })
    );
    expect(result).toEqual([
      { column_name: "data", length: undefined, order: undefined },
    ]);
  });

  it("多列组合索引", () => {
    const result = indexColumnsToFormValues(
      makeIndex({
        columns: [
          {
            column_name: "user_id",
            seq_in_index: 1,
            collation: "A",
            sub_part: null,
          },
          {
            column_name: "created_at",
            seq_in_index: 2,
            collation: "D",
            sub_part: null,
          },
          {
            column_name: "name",
            seq_in_index: 3,
            collation: "A",
            sub_part: 20,
          },
        ],
      })
    );
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ column_name: "user_id", length: undefined, order: "ASC" });
    expect(result[1]).toEqual({ column_name: "created_at", length: undefined, order: "DESC" });
    expect(result[2]).toEqual({ column_name: "name", length: 20, order: "ASC" });
  });
});
