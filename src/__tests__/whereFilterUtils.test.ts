import { describe, it, expect } from "vitest";
import {
  buildWhereClause,
  buildWhereClauseFromFilters,
  columnSupportsEmptyStringValue,
  isStringColumnType,
  WHERE_OPERATORS,
  TWO_VALUE_OPERATORS,
  NO_VALUE_OPERATORS,
} from "../utils/whereFilterUtils";

const allowedColumns = ["id", "name", "status", "created_at"];

const columnTypes: Record<string, string> = {
  id: "bigint",
  name: "varchar(255)",
  status: "int",
  created_at: "datetime",
};

describe("whereFilterUtils", () => {
  describe("buildWhereClause", () => {
    it("等于操作符应生成正确的 WHERE 子句", () => {
      const clause = buildWhereClause(
        { column: "status", operator: "=", value: "1" },
        allowedColumns
      );
      expect(clause).toBe("`status` = 1");
    });

    it("等于操作符字符串值应加引号", () => {
      const clause = buildWhereClause(
        { column: "name", operator: "=", value: "Alice" },
        allowedColumns
      );
      expect(clause).toBe("`name` = 'Alice'");
    });

    it("LIKE 操作符应正确格式化", () => {
      const clause = buildWhereClause(
        { column: "name", operator: "LIKE", value: "%test%" },
        allowedColumns
      );
      expect(clause).toBe("`name` LIKE '%test%'");
    });

    it("BETWEEN 操作符应需要两个值", () => {
      const clause = buildWhereClause(
        {
          column: "id",
          operator: "BETWEEN",
          value: "1",
          value2: "100",
        },
        allowedColumns
      );
      expect(clause).toBe("`id` BETWEEN 1 AND 100");
    });

    it("BETWEEN 操作符字符串值应加引号", () => {
      const clause = buildWhereClause(
        {
          column: "created_at",
          operator: "BETWEEN",
          value: "2024-01-01",
          value2: "2024-12-31",
        },
        allowedColumns
      );
      expect(clause).toBe("`created_at` BETWEEN '2024-01-01' AND '2024-12-31'");
    });

    it("IN 操作符应生成正确的 IN 列表", () => {
      const clause = buildWhereClause(
        { column: "status", operator: "IN", value: "1, 2, 3" },
        allowedColumns
      );
      expect(clause).toBe("`status` IN (1, 2, 3)");
    });

    it("IN 操作符支持字符串值", () => {
      const clause = buildWhereClause(
        { column: "name", operator: "IN", value: "Alice, Bob" },
        allowedColumns
      );
      expect(clause).toBe("`name` IN ('Alice', 'Bob')");
    });

    it("IS NULL 操作符不需要值", () => {
      const clause = buildWhereClause(
        { column: "name", operator: "IS NULL", value: "" },
        allowedColumns
      );
      expect(clause).toBe("`name` IS NULL");
    });

    it("IS NOT NULL 操作符不需要值", () => {
      const clause = buildWhereClause(
        { column: "name", operator: "IS NOT NULL", value: "" },
        allowedColumns
      );
      expect(clause).toBe("`name` IS NOT NULL");
    });

    it("列名不在白名单时应返回空字符串", () => {
      const clause = buildWhereClause(
        { column: "malicious; DROP TABLE--", operator: "=", value: "1" },
        allowedColumns
      );
      expect(clause).toBe("");
    });

    it("空列或空操作符应返回空字符串", () => {
      expect(
        buildWhereClause(
          { column: "", operator: "=", value: "1" },
          allowedColumns
        )
      ).toBe("");
      expect(
        buildWhereClause(
          { column: "id", operator: "" as never, value: "1" },
          allowedColumns
        )
      ).toBe("");
    });

    it("BETWEEN 缺少 value2 时应返回空字符串", () => {
      const clause = buildWhereClause(
        { column: "id", operator: "BETWEEN", value: "1" },
        allowedColumns
      );
      expect(clause).toBe("");
    });

    it("应转义字符串中的单引号", () => {
      const clause = buildWhereClause(
        { column: "name", operator: "=", value: "O'Brien" },
        allowedColumns
      );
      expect(clause).toBe("`name` = 'O''Brien'");
    });

    it("空值应格式化为 NULL", () => {
      const clause = buildWhereClause(
        { column: "name", operator: "=", value: "null" },
        allowedColumns
      );
      expect(clause).toBe("`name` = NULL");
    });

    it("字符串列搜索数字时应格式化为字符串", () => {
      const clause = buildWhereClause(
        { column: "name", operator: "=", value: "123" },
        allowedColumns,
        columnTypes
      );
      expect(clause).toBe("`name` = '123'");
    });

    it("字符串列 LIKE 数字时应格式化为字符串", () => {
      const clause = buildWhereClause(
        { column: "name", operator: "LIKE", value: "123" },
        allowedColumns,
        columnTypes
      );
      expect(clause).toBe("`name` LIKE '123'");
    });

    it("数值列搜索数字时保持数字格式", () => {
      const clause = buildWhereClause(
        { column: "status", operator: "=", value: "1" },
        allowedColumns,
        columnTypes
      );
      expect(clause).toBe("`status` = 1");
    });

    it("字符串列 IN 数字时应格式化为字符串", () => {
      const clause = buildWhereClause(
        { column: "name", operator: "IN", value: "123, 456" },
        allowedColumns,
        columnTypes
      );
      expect(clause).toBe("`name` IN ('123', '456')");
    });

    it("字符串列不填值时应生成 = ''（空字符串）", () => {
      const clause = buildWhereClause(
        { column: "name", operator: "=", value: "" },
        allowedColumns,
        columnTypes
      );
      expect(clause).toBe("`name` = ''");
    });

    it("数值列不填值时不应生成条件", () => {
      const clause = buildWhereClause(
        { column: "status", operator: "=", value: "" },
        allowedColumns,
        columnTypes
      );
      expect(clause).toBe("");
    });

    it("LIKE 不填值时应生成 LIKE ''", () => {
      const clause = buildWhereClause(
        { column: "status", operator: "LIKE", value: "" },
        allowedColumns
      );
      expect(clause).toBe("`status` LIKE ''");
    });

    it("PostgreSQL 方言应使用双引号标识符并保留反斜杠字面量", () => {
      const clause = buildWhereClause(
        { column: "name", operator: "LIKE", value: '%\\"quoted%' },
        allowedColumns,
        columnTypes,
        "postgres"
      );
      expect(clause).toBe("\"name\" LIKE '%\\\"quoted%'");
    });

    it("SQLite 方言应使用双引号标识符和单引号字符串转义", () => {
      const clause = buildWhereClause(
        { column: "name", operator: "=", value: "O'Brien" },
        allowedColumns,
        columnTypes,
        "sqlite"
      );
      expect(clause).toBe("\"name\" = 'O''Brien'");
    });
  });

  describe("buildWhereClauseFromFilters (OR 分组)", () => {
    it("默认行为：未指定 group 时仍用 AND 连接", () => {
      const clause = buildWhereClauseFromFilters(
        [
          { column: "status", operator: "=", value: "1" },
          { column: "id", operator: ">", value: "10" },
        ],
        allowedColumns,
        columnTypes
      );
      expect(clause).toBe("`status` = 1 AND `id` > 10");
    });

    it("不同 group 之间用 OR，同组内用 AND 并加括号", () => {
      const clause = buildWhereClauseFromFilters(
        [
          { column: "status", operator: "=", value: "1", group: "1" },
          { column: "id", operator: ">", value: "10", group: "1" },
          { column: "name", operator: "LIKE", value: "%Alice%", group: "2" },
        ],
        allowedColumns,
        columnTypes
      );
      expect(clause).toBe(
        "(`status` = 1 AND `id` > 10) OR (`name` LIKE '%Alice%')"
      );
    });

    it("SQLite 分组筛选应使用双引号标识符", () => {
      const clause = buildWhereClauseFromFilters(
        [
          { column: "status", operator: "=", value: "1", group: "1" },
          { column: "name", operator: "LIKE", value: "%Alice%", group: "2" },
        ],
        allowedColumns,
        columnTypes,
        "sqlite"
      );
      expect(clause).toBe("(\"status\" = 1) OR (\"name\" LIKE '%Alice%')");
    });

    it("禁用条件不参与分组与构建", () => {
      const clause = buildWhereClauseFromFilters(
        [
          {
            column: "status",
            operator: "=",
            value: "1",
            group: "1",
            enabled: false,
          },
          { column: "id", operator: ">", value: "10", group: "1" },
          { column: "name", operator: "=", value: "Bob", group: "2" },
        ],
        allowedColumns,
        columnTypes
      );
      expect(clause).toBe("(`id` > 10) OR (`name` = 'Bob')");
    });

    it("空 group 视为默认组 1", () => {
      const clause = buildWhereClauseFromFilters(
        [
          { column: "status", operator: "=", value: "1", group: " " },
          { column: "id", operator: ">", value: "10" },
        ],
        allowedColumns,
        columnTypes
      );
      expect(clause).toBe("`status` = 1 AND `id` > 10");
    });
  });

  describe("columnSupportsEmptyStringValue", () => {
    it("无 columnTypes 时应为 false", () => {
      expect(columnSupportsEmptyStringValue("name", undefined)).toBe(false);
    });

    it("映射中无该列时应视为可按字符串处理空串", () => {
      expect(columnSupportsEmptyStringValue("new_col", columnTypes)).toBe(true);
    });

    it("varchar 列应为 true", () => {
      expect(columnSupportsEmptyStringValue("name", columnTypes)).toBe(true);
    });

    it("bigint 列应为 false", () => {
      expect(columnSupportsEmptyStringValue("id", columnTypes)).toBe(false);
    });
  });

  describe("isStringColumnType", () => {
    it("应识别 varchar 为字符串类型", () => {
      expect(isStringColumnType("varchar(255)")).toBe(true);
    });
    it("应识别 text 为字符串类型", () => {
      expect(isStringColumnType("text")).toBe(true);
    });
    it("应识别 int 为非字符串类型", () => {
      expect(isStringColumnType("int")).toBe(false);
    });
  });

  describe("buildWhereClauseFromFilters", () => {
    it("多个条件应用 AND 连接", () => {
      const clause = buildWhereClauseFromFilters(
        [
          { column: "status", operator: "=", value: "1" },
          { column: "name", operator: "LIKE", value: "%test%" },
        ],
        allowedColumns
      );
      expect(clause).toBe("`status` = 1 AND `name` LIKE '%test%'");
    });

    it("空配置列表应返回空字符串", () => {
      expect(buildWhereClauseFromFilters([], allowedColumns)).toBe("");
    });

    it("无效条件应被过滤掉", () => {
      const clause = buildWhereClauseFromFilters(
        [
          { column: "", operator: "=", value: "1" },
          { column: "status", operator: "=", value: "1" },
        ],
        allowedColumns
      );
      expect(clause).toBe("`status` = 1");
    });

    it("三个条件应正确拼接", () => {
      const clause = buildWhereClauseFromFilters(
        [
          { column: "id", operator: "BETWEEN", value: "1", value2: "100" },
          { column: "status", operator: "=", value: "1" },
          { column: "name", operator: "IS NOT NULL", value: "" },
        ],
        allowedColumns
      );
      expect(clause).toBe(
        "`id` BETWEEN 1 AND 100 AND `status` = 1 AND `name` IS NOT NULL"
      );
    });

    it("传入 columnTypes 时字符串列数字应格式化为字符串", () => {
      const clause = buildWhereClauseFromFilters(
        [
          { column: "name", operator: "=", value: "123" },
          { column: "status", operator: "=", value: "1" },
        ],
        allowedColumns,
        columnTypes
      );
      expect(clause).toBe("`name` = '123' AND `status` = 1");
    });

    it("字符串值中的反斜杠双引号应在 WHERE 中保真", () => {
      const clause = buildWhereClauseFromFilters(
        [{ column: "name", operator: "LIKE", value: '%\\"quoted%' }],
        allowedColumns,
        columnTypes
      );
      expect(clause).toBe("`name` LIKE '%\\\\\"quoted%'");
    });

    it("PostgreSQL 方言多个条件应用双引号并保留分组", () => {
      const clause = buildWhereClauseFromFilters(
        [
          { column: "status", operator: "=", value: "1", group: "1" },
          { column: "name", operator: "=", value: "Alice", group: "2" },
        ],
        allowedColumns,
        columnTypes,
        "postgres"
      );
      expect(clause).toBe("(\"status\" = 1) OR (\"name\" = 'Alice')");
    });
  });

  describe("常量", () => {
    it("TWO_VALUE_OPERATORS 应包含 BETWEEN", () => {
      expect(TWO_VALUE_OPERATORS).toContain("BETWEEN");
    });

    it("NO_VALUE_OPERATORS 应包含 IS NULL 和 IS NOT NULL", () => {
      expect(NO_VALUE_OPERATORS).toContain("IS NULL");
      expect(NO_VALUE_OPERATORS).toContain("IS NOT NULL");
    });

    it("WHERE_OPERATORS 应包含所有常用操作符", () => {
      const values = WHERE_OPERATORS.map((o) => o.value);
      expect(values).toContain("=");
      expect(values).toContain("!=");
      expect(values).toContain(">");
      expect(values).toContain("<");
      expect(values).toContain("LIKE");
      expect(values).toContain("IN");
      expect(values).toContain("BETWEEN");
    });
  });
});
