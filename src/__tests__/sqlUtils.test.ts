import { describe, it, expect } from "vitest";
import {
  BULK_EXECUTED_SQL_PREVIEW_CAP,
  BULK_EXECUTED_SQL_UI_THRESHOLD,
  escapeSqlString,
  formatSqlValue,
  generateInsertStatements,
  generateUpdateStatements,
  getExecutedSqlPreview,
  rowsToJsonArrayString,
  splitSqlStatements,
} from "../utils/sqlUtils";

describe("sqlUtils", () => {
  describe("splitSqlStatements", () => {
    it("应拆分单条语句", () => {
      expect(splitSqlStatements("SELECT 1")).toEqual(["SELECT 1"]);
    });

    it("应拆分为多条语句", () => {
      expect(splitSqlStatements("SELECT 1; SELECT 2")).toEqual([
        "SELECT 1",
        "SELECT 2",
      ]);
    });

    it("不应拆分引号内的分号", () => {
      expect(splitSqlStatements("INSERT INTO t VALUES ('a;b')")).toEqual([
        "INSERT INTO t VALUES ('a;b')",
      ]);
    });

    it("应正确处理空字符串和空白", () => {
      expect(splitSqlStatements("")).toEqual([]);
      expect(splitSqlStatements("   ")).toEqual([]);
      expect(splitSqlStatements("SELECT 1;\n\n  SELECT 2;")).toEqual([
        "SELECT 1",
        "SELECT 2",
      ]);
    });

    it("应处理反引号内的分号", () => {
      expect(splitSqlStatements("SELECT `col;name` FROM t")).toEqual([
        "SELECT `col;name` FROM t",
      ]);
    });

    it("不应把行注释里的分号当作语句结束", () => {
      expect(
        splitSqlStatements(
          "-- Import: choose target or USE your_db; blah\nSELECT 1;"
        )
      ).toEqual(["-- Import: choose target or USE your_db; blah\nSELECT 1"]);
    });

    it("不应把块注释里的分号当作语句结束", () => {
      expect(splitSqlStatements("SELECT 1 /* ; */; SELECT 2")).toEqual([
        "SELECT 1 /* ; */",
        "SELECT 2",
      ]);
    });

    it("字符串内的双减号不应视为行注释", () => {
      expect(splitSqlStatements("SELECT '-- a;b'")).toEqual([
        "SELECT '-- a;b'",
      ]);
    });
  });

  describe("getExecutedSqlPreview", () => {
    const thr = BULK_EXECUTED_SQL_UI_THRESHOLD;
    const cap = BULK_EXECUTED_SQL_PREVIEW_CAP;

    it("空列表应返回非批量且无切片", () => {
      expect(getExecutedSqlPreview([], thr, cap)).toEqual({
        total: 0,
        visibleSlice: [],
        hiddenCount: 0,
        isBulk: false,
      });
    });

    it("条数不超过阈值时应为非批量且 visibleSlice 为完整副本", () => {
      const list = Array.from({ length: thr }, (_, i) => `SELECT ${i};`);
      const r = getExecutedSqlPreview(list, thr, cap);
      expect(r.isBulk).toBe(false);
      expect(r.total).toBe(thr);
      expect(r.visibleSlice).toEqual(list);
      expect(r.hiddenCount).toBe(0);
      expect(r.visibleSlice).not.toBe(list);
    });

    it("条数为 threshold + 1 时应为批量并按 previewCap 切片", () => {
      const list = Array.from(
        { length: thr + 1 },
        (_, i) => `INSERT INTO t VALUES (${i});`
      );
      const r = getExecutedSqlPreview(list, thr, 10);
      expect(r.isBulk).toBe(true);
      expect(r.total).toBe(thr + 1);
      expect(r.visibleSlice).toHaveLength(10);
      expect(r.hiddenCount).toBe(list.length - 10);
      expect(r.visibleSlice[0]).toBe(list[0]);
    });

    it("批量模式下 previewCap 为 0 时 visibleSlice 为空且 hiddenCount 等于 total", () => {
      const list = ["a", "b", "c"];
      const r = getExecutedSqlPreview(list, 1, 0);
      expect(r.isBulk).toBe(true);
      expect(r.visibleSlice).toEqual([]);
      expect(r.hiddenCount).toBe(3);
    });
  });

  describe("escapeSqlString", () => {
    it("应该转义单引号（标准 SQL 双引号转义）", () => {
      expect(escapeSqlString("it's a test")).toBe("it''s a test");
    });

    it("应该转义反斜杠，避免 MySQL 默认字符串模式吞掉反斜杠", () => {
      expect(escapeSqlString('path\\to\\"file')).toBe('path\\\\to\\\\"file');
    });

    it("应该同时转义单引号和反斜杠", () => {
      expect(escapeSqlString("it's a \\test")).toBe("it''s a \\\\test");
    });

    it("普通字符串不需要转义", () => {
      expect(escapeSqlString("hello world")).toBe("hello world");
    });

    it("空字符串应返回空字符串", () => {
      expect(escapeSqlString("")).toBe("");
    });
  });

  describe("formatSqlValue", () => {
    it("null 应返回 NULL", () => {
      expect(formatSqlValue(null)).toBe("NULL");
    });

    it("undefined 应返回 NULL", () => {
      expect(formatSqlValue(undefined)).toBe("NULL");
    });

    it("数字应返回字符串表示", () => {
      expect(formatSqlValue(42)).toBe("42");
      expect(formatSqlValue(3.14)).toBe("3.14");
      expect(formatSqlValue(0)).toBe("0");
      expect(formatSqlValue(-100)).toBe("-100");
    });

    it("布尔值应转为 1/0", () => {
      expect(formatSqlValue(true)).toBe("1");
      expect(formatSqlValue(false)).toBe("0");
    });

    it("字符串应加引号并转义", () => {
      expect(formatSqlValue("hello")).toBe("'hello'");
      expect(formatSqlValue("it's")).toBe("'it''s'");
    });

    it("空字符串应返回带引号的空字符串", () => {
      expect(formatSqlValue("")).toBe("''");
    });
  });

  describe("generateInsertStatements", () => {
    it("应该生成正确的 INSERT 语句", () => {
      const result = generateInsertStatements(
        "users",
        ["id", "name", "email"],
        [{ id: 1, name: "Alice", email: "alice@test.com" }]
      );
      expect(result).toBe(
        "INSERT INTO `users` (`id`, `name`, `email`) VALUES (1, 'Alice', 'alice@test.com');"
      );
    });

    it("应该在 INSERT 字符串值中保留反斜杠双引号内容", () => {
      const result = generateInsertStatements(
        "users",
        ["id", "payload"],
        [{ id: 1, payload: 'value\\"quoted' }]
      );
      expect(result).toBe(
        "INSERT INTO `users` (`id`, `payload`) VALUES (1, 'value\\\\\"quoted');"
      );
    });

    it("应该支持多行生成", () => {
      const result = generateInsertStatements(
        "users",
        ["id", "name"],
        [
          { id: 1, name: "Alice" },
          { id: 2, name: "Bob" },
          { id: 3, name: "Charlie" },
        ]
      );
      const lines = result.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe(
        "INSERT INTO `users` (`id`, `name`) VALUES (1, 'Alice');"
      );
      expect(lines[1]).toBe(
        "INSERT INTO `users` (`id`, `name`) VALUES (2, 'Bob');"
      );
      expect(lines[2]).toBe(
        "INSERT INTO `users` (`id`, `name`) VALUES (3, 'Charlie');"
      );
    });

    it("应该能排除指定的列 (主键)", () => {
      const result = generateInsertStatements(
        "users",
        ["id", "name", "email"],
        [{ id: 1, name: "Alice", email: "alice@test.com" }],
        ["id"]
      );
      expect(result).toBe(
        "INSERT INTO `users` (`name`, `email`) VALUES ('Alice', 'alice@test.com');"
      );
    });

    it("应该正确处理 NULL 值", () => {
      const result = generateInsertStatements(
        "users",
        ["id", "name", "bio"],
        [{ id: 1, name: "Alice", bio: null }]
      );
      expect(result).toBe(
        "INSERT INTO `users` (`id`, `name`, `bio`) VALUES (1, 'Alice', NULL);"
      );
    });

    it("应该正确处理特殊字符", () => {
      const result = generateInsertStatements(
        "users",
        ["id", "name"],
        [{ id: 1, name: "O'Brien" }]
      );
      expect(result).toBe(
        "INSERT INTO `users` (`id`, `name`) VALUES (1, 'O''Brien');"
      );
    });

    it("排除所有列时应返回空字符串", () => {
      const result = generateInsertStatements(
        "users",
        ["id"],
        [{ id: 1 }],
        ["id"]
      );
      expect(result).toBe("");
    });

    it("空行数据应返回空字符串", () => {
      const result = generateInsertStatements("users", ["id", "name"], []);
      expect(result).toBe("");
    });

    it("应该支持排除多个主键列 (复合主键)", () => {
      const result = generateInsertStatements(
        "order_items",
        ["order_id", "product_id", "quantity", "price"],
        [{ order_id: 1, product_id: 100, quantity: 2, price: 9.99 }],
        ["order_id", "product_id"]
      );
      expect(result).toBe(
        "INSERT INTO `order_items` (`quantity`, `price`) VALUES (2, 9.99);"
      );
    });

    it("应该正确处理 undefined 值 (缺失的列)", () => {
      const result = generateInsertStatements(
        "users",
        ["id", "name", "email"],
        [{ id: 1, name: "Alice" }] // email is undefined
      );
      expect(result).toBe(
        "INSERT INTO `users` (`id`, `name`, `email`) VALUES (1, 'Alice', NULL);"
      );
    });
  });

  describe("rowsToJsonArrayString", () => {
    it("应按指定列导出为格式化的 JSON 数组", () => {
      const s = rowsToJsonArrayString(
        [
          { id: 1, name: "Alice", extra: "x" },
          { id: 2, name: "Bob", extra: "y" },
        ],
        ["id", "name"]
      );
      expect(s).toBe(
        `[
  {
    "id": 1,
    "name": "Alice"
  },
  {
    "id": 2,
    "name": "Bob"
  }
]`
      );
    });

    it("列名为空时应返回 []", () => {
      expect(rowsToJsonArrayString([{ id: 1 }], [])).toBe("[]");
    });

    it("应序列化 null 且将 BigInt 转为字符串", () => {
      const s = rowsToJsonArrayString(
        [{ id: 1n, note: null }] as Record<string, unknown>[],
        ["id", "note"]
      );
      expect(s).toContain('"id": "1"');
      expect(s).toContain('"note": null');
    });
  });

  describe("generateUpdateStatements", () => {
    it("应该生成正确的 UPDATE 语句", () => {
      const result = generateUpdateStatements("mydb", "users", [
        { primaryKeys: { id: 1 }, colName: "name", newValue: "Alice Updated" },
      ]);
      expect(result).toBe(
        "UPDATE `mydb`.`users` SET `name` = 'Alice Updated' WHERE `id` = 1;"
      );
    });

    it("同一行多列修改应合并为一条 UPDATE", () => {
      const result = generateUpdateStatements("mydb", "users", [
        { primaryKeys: { id: 1 }, colName: "name", newValue: "Alice" },
        {
          primaryKeys: { id: 1 },
          colName: "email",
          newValue: "alice@test.com",
        },
      ]);
      expect(result).toBe(
        "UPDATE `mydb`.`users` SET `name` = 'Alice', `email` = 'alice@test.com' WHERE `id` = 1;"
      );
    });

    it("不同行应生成多条 UPDATE", () => {
      const result = generateUpdateStatements("mydb", "users", [
        { primaryKeys: { id: 1 }, colName: "name", newValue: "A" },
        { primaryKeys: { id: 2 }, colName: "email", newValue: "b@test.com" },
      ]);
      const lines = result.split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(
        "UPDATE `mydb`.`users` SET `name` = 'A' WHERE `id` = 1;"
      );
      expect(lines[1]).toBe(
        "UPDATE `mydb`.`users` SET `email` = 'b@test.com' WHERE `id` = 2;"
      );
    });

    it("应该支持复合主键", () => {
      const result = generateUpdateStatements("mydb", "order_items", [
        {
          primaryKeys: { order_id: 1, product_id: 100 },
          colName: "quantity",
          newValue: 3,
        },
      ]);
      expect(result).toBe(
        "UPDATE `mydb`.`order_items` SET `quantity` = 3 WHERE `order_id` = 1 AND `product_id` = 100;"
      );
    });

    it("应该正确处理 NULL 值", () => {
      const result = generateUpdateStatements("mydb", "users", [
        { primaryKeys: { id: 1 }, colName: "bio", newValue: null },
      ]);
      expect(result).toBe(
        "UPDATE `mydb`.`users` SET `bio` = NULL WHERE `id` = 1;"
      );
    });

    it("应该在 UPDATE 字符串值和主键中保留反斜杠双引号内容", () => {
      const result = generateUpdateStatements("mydb", "users", [
        {
          primaryKeys: { id: 'pk\\"1' },
          colName: "payload",
          newValue: 'value\\"quoted',
        },
      ]);
      expect(result).toBe(
        "UPDATE `mydb`.`users` SET `payload` = 'value\\\\\"quoted' WHERE `id` = 'pk\\\\\"1';"
      );
    });
  });
});
