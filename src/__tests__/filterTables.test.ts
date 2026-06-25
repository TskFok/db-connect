import { describe, it, expect } from "vitest";
import { filterTables } from "../utils/databaseOverviewUtils";
import type { TableInfo } from "../types";

const mockTables: TableInfo[] = [
  {
    name: "users",
    table_type: "TABLE",
    engine: "InnoDB",
    rows: 100,
    data_length: 16384, index_length: null,
    comment: "用户表",
  },
  {
    name: "orders",
    table_type: "TABLE",
    engine: "InnoDB",
    rows: 500,
    data_length: 32768, index_length: null,
    comment: "订单表",
  },
  {
    name: "user_logs",
    table_type: "TABLE",
    engine: "MyISAM",
    rows: 10000,
    data_length: 65536, index_length: null,
    comment: "用户日志",
  },
  {
    name: "products",
    table_type: "TABLE",
    engine: "InnoDB",
    rows: 200,
    data_length: 16384, index_length: null,
    comment: "商品表",
  },
  {
    name: "user_view",
    table_type: "VIEW",
    engine: null,
    rows: null,
    data_length: null, index_length: null,
    comment: "",
  },
];

describe("filterTables", () => {
  it("空关键词 → 返回全部表", () => {
    expect(filterTables(mockTables, "")).toEqual(mockTables);
    expect(filterTables(mockTables, "  ")).toEqual(mockTables);
  });

  it("按表名精确匹配 → 返回匹配项", () => {
    const result = filterTables(mockTables, "orders");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("orders");
  });

  it("按表名部分匹配 → 返回所有含关键词的表", () => {
    const result = filterTables(mockTables, "user");
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.name)).toEqual(["users", "user_logs", "user_view"]);
  });

  it("按注释匹配 → 返回匹配项", () => {
    const result = filterTables(mockTables, "订单");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("orders");
  });

  it("大小写不敏感匹配", () => {
    const result = filterTables(mockTables, "USERS");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("users");
  });

  it("同时匹配表名和注释", () => {
    const result = filterTables(mockTables, "用户");
    expect(result).toHaveLength(2);
    expect(result.map((t) => t.name)).toEqual(["users", "user_logs"]);
  });

  it("无匹配结果 → 返回空数组", () => {
    const result = filterTables(mockTables, "xyz_not_exist");
    expect(result).toHaveLength(0);
  });

  it("关键词有前后空格 → 自动 trim", () => {
    const result = filterTables(mockTables, "  orders  ");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("orders");
  });

  it("空表列表 → 返回空数组", () => {
    expect(filterTables([], "users")).toEqual([]);
  });

  it("注释为空时不会报错", () => {
    const result = filterTables(mockTables, "view");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("user_view");
  });

  it("匹配下划线字符", () => {
    const result = filterTables(mockTables, "_log");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("user_logs");
  });
});
