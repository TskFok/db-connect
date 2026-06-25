import { describe, it, expect } from "vitest";
import type { TableInfo } from "../types";
import {
  filterLargeIndexTables,
  getTableTotalSize,
  isLargeIndexTable,
  sortTablesByTotalSize,
  summarizeTableStorage,
} from "../utils/tableStorageStats";

const baseTable = (overrides: Partial<TableInfo>): TableInfo => ({
  name: "t",
  table_type: "TABLE",
  engine: "InnoDB",
  rows: 100,
  data_length: 0,
  index_length: 0,
  comment: "",
  ...overrides,
});

describe("getTableTotalSize", () => {
  it("数据与索引均为 null → null", () => {
    expect(
      getTableTotalSize(
        baseTable({ data_length: null, index_length: null, table_type: "VIEW" })
      )
    ).toBeNull();
  });

  it("合计数据与索引容量", () => {
    expect(
      getTableTotalSize(baseTable({ data_length: 1000, index_length: 500 }))
    ).toBe(1500);
  });
});

describe("summarizeTableStorage", () => {
  it("汇总全部表的数据、索引与总占用", () => {
    const summary = summarizeTableStorage([
      baseTable({ name: "a", data_length: 1000, index_length: 200 }),
      baseTable({ name: "b", data_length: 3000, index_length: 500 }),
      baseTable({
        name: "v",
        table_type: "VIEW",
        data_length: null,
        index_length: null,
      }),
    ]);

    expect(summary).toEqual({
      totalDataLength: 4000,
      totalIndexLength: 700,
      totalSize: 4700,
      tableCount: 3,
    });
  });
});

describe("isLargeIndexTable", () => {
  it("视图不计入大索引", () => {
    expect(
      isLargeIndexTable(
        baseTable({
          table_type: "VIEW",
          data_length: null,
          index_length: 99999999,
        })
      )
    ).toBe(false);
  });

  it("索引 ≥ 10MB → 大索引", () => {
    expect(
      isLargeIndexTable(
        baseTable({
          data_length: 100 * 1024 * 1024,
          index_length: 10 * 1024 * 1024,
        })
      )
    ).toBe(true);
  });

  it("索引超过数据容量 → 大索引", () => {
    expect(
      isLargeIndexTable(
        baseTable({ data_length: 1024 * 1024, index_length: 2 * 1024 * 1024 })
      )
    ).toBe(true);
  });

  it("索引占比 ≥ 50% → 大索引", () => {
    expect(
      isLargeIndexTable(
        baseTable({ data_length: 2 * 1024 * 1024, index_length: 1024 * 1024 })
      )
    ).toBe(true);
  });

  it("小索引表 → 非大索引", () => {
    expect(
      isLargeIndexTable(
        baseTable({ data_length: 10 * 1024 * 1024, index_length: 64 * 1024 })
      )
    ).toBe(false);
  });
});

describe("filterLargeIndexTables", () => {
  it("仅保留大索引表", () => {
    const tables = [
      baseTable({ name: "small", data_length: 1024 * 1024, index_length: 4096 }),
      baseTable({
        name: "large",
        data_length: 1024 * 1024,
        index_length: 2 * 1024 * 1024,
      }),
    ];
    expect(filterLargeIndexTables(tables).map((t) => t.name)).toEqual(["large"]);
  });
});

describe("sortTablesByTotalSize", () => {
  it("默认按总占用降序", () => {
    const tables = [
      baseTable({ name: "mid", data_length: 2000, index_length: 500 }),
      baseTable({ name: "small", data_length: 100, index_length: 50 }),
      baseTable({ name: "big", data_length: 9000, index_length: 1000 }),
    ];
    expect(sortTablesByTotalSize(tables).map((t) => t.name)).toEqual([
      "big",
      "mid",
      "small",
    ]);
  });
});
