import { describe, it, expect } from "vitest";
import {
  parseColumnType,
  buildColumnType,
  UNSIGNED_TYPES,
  LENGTH_TYPES,
  SCALE_TYPES,
  MYSQL_DATA_TYPES,
} from "../utils/columnTypeUtils";

describe("parseColumnType", () => {
  it("解析简单类型 (无长度, 无 unsigned)", () => {
    expect(parseColumnType("int")).toEqual({
      dataType: "int",
      length: "",
      scale: "",
      unsigned: false,
    });
  });

  it("解析带长度的类型", () => {
    expect(parseColumnType("varchar(255)")).toEqual({
      dataType: "varchar",
      length: "255",
      scale: "",
      unsigned: false,
    });
  });

  it("解析带 unsigned 的类型", () => {
    expect(parseColumnType("int unsigned")).toEqual({
      dataType: "int",
      length: "",
      scale: "",
      unsigned: true,
    });
  });

  it("解析带长度和 unsigned 的类型", () => {
    expect(parseColumnType("bigint(20) unsigned")).toEqual({
      dataType: "bigint",
      length: "20",
      scale: "",
      unsigned: true,
    });
  });

  it("解析 decimal 精度格式 — 拆分为 length 和 scale", () => {
    expect(parseColumnType("decimal(10,2)")).toEqual({
      dataType: "decimal",
      length: "10",
      scale: "2",
      unsigned: false,
    });
  });

  it("解析 decimal 精度格式带 unsigned", () => {
    expect(parseColumnType("decimal(10,2) unsigned")).toEqual({
      dataType: "decimal",
      length: "10",
      scale: "2",
      unsigned: true,
    });
  });

  it("解析 decimal 仅有精度 (无小数位)", () => {
    expect(parseColumnType("decimal(10)")).toEqual({
      dataType: "decimal",
      length: "10",
      scale: "",
      unsigned: false,
    });
  });

  it("解析 float(7,4) — 拆分精度和小数位", () => {
    expect(parseColumnType("float(7,4)")).toEqual({
      dataType: "float",
      length: "7",
      scale: "4",
      unsigned: false,
    });
  });

  it("解析 float(7,4) unsigned", () => {
    expect(parseColumnType("float(7,4) unsigned")).toEqual({
      dataType: "float",
      length: "7",
      scale: "4",
      unsigned: true,
    });
  });

  it("解析 double(15,8)", () => {
    expect(parseColumnType("double(15,8)")).toEqual({
      dataType: "double",
      length: "15",
      scale: "8",
      unsigned: false,
    });
  });

  it("解析 text 类型 (无长度)", () => {
    expect(parseColumnType("text")).toEqual({
      dataType: "text",
      length: "",
      scale: "",
      unsigned: false,
    });
  });

  it("解析 datetime 类型", () => {
    expect(parseColumnType("datetime")).toEqual({
      dataType: "datetime",
      length: "",
      scale: "",
      unsigned: false,
    });
  });

  it("解析 tinyint(1) 类型", () => {
    expect(parseColumnType("tinyint(1)")).toEqual({
      dataType: "tinyint",
      length: "1",
      scale: "",
      unsigned: false,
    });
  });

  it("解析带空格的输入", () => {
    expect(parseColumnType("  varchar(100)  ")).toEqual({
      dataType: "varchar",
      length: "100",
      scale: "",
      unsigned: false,
    });
  });

  it("解析大写输入转为小写", () => {
    expect(parseColumnType("VARCHAR(255)")).toEqual({
      dataType: "varchar",
      length: "255",
      scale: "",
      unsigned: false,
    });
  });

  it("解析 BIGINT UNSIGNED (大写)", () => {
    expect(parseColumnType("BIGINT UNSIGNED")).toEqual({
      dataType: "bigint",
      length: "",
      scale: "",
      unsigned: true,
    });
  });

  it("解析 enum 类型 (逗号不拆分)", () => {
    expect(parseColumnType("enum('a','b','c')")).toEqual({
      dataType: "enum",
      length: "'a','b','c'",
      scale: "",
      unsigned: false,
    });
  });

  it("解析 json 类型", () => {
    expect(parseColumnType("json")).toEqual({
      dataType: "json",
      length: "",
      scale: "",
      unsigned: false,
    });
  });
});

describe("buildColumnType", () => {
  it("构建简单类型", () => {
    expect(buildColumnType("int", "", "", false)).toBe("int");
  });

  it("构建带长度的类型", () => {
    expect(buildColumnType("varchar", "255", "", false)).toBe("varchar(255)");
  });

  it("构建带 unsigned 的数值类型", () => {
    expect(buildColumnType("int", "", "", true)).toBe("int unsigned");
  });

  it("构建带长度和 unsigned 的类型", () => {
    expect(buildColumnType("bigint", "20", "", true)).toBe("bigint(20) unsigned");
  });

  it("构建 decimal 带精度和小数位", () => {
    expect(buildColumnType("decimal", "10", "2", false)).toBe("decimal(10,2)");
  });

  it("构建 decimal 带精度和小数位 + unsigned", () => {
    expect(buildColumnType("decimal", "10", "2", true)).toBe(
      "decimal(10,2) unsigned"
    );
  });

  it("构建 decimal 仅有精度 (无小数位)", () => {
    expect(buildColumnType("decimal", "10", "", false)).toBe("decimal(10)");
  });

  it("构建 float 带精度和小数位", () => {
    expect(buildColumnType("float", "7", "4", false)).toBe("float(7,4)");
  });

  it("构建 double 带精度和小数位 + unsigned", () => {
    expect(buildColumnType("double", "15", "8", true)).toBe(
      "double(15,8) unsigned"
    );
  });

  it("非 SCALE_TYPES 忽略 scale 参数", () => {
    expect(buildColumnType("varchar", "255", "2", false)).toBe("varchar(255)");
  });

  it("非数值类型忽略 unsigned", () => {
    expect(buildColumnType("varchar", "255", "", true)).toBe("varchar(255)");
  });

  it("text 类型忽略 unsigned 和 scale", () => {
    expect(buildColumnType("text", "", "", true)).toBe("text");
  });

  it("空长度不生成括号", () => {
    expect(buildColumnType("text", "", "", false)).toBe("text");
  });

  it("长度只有空格时不生成括号", () => {
    expect(buildColumnType("int", "   ", "", false)).toBe("int");
  });

  it("构建 enum 类型", () => {
    expect(buildColumnType("enum", "'a','b','c'", "", false)).toBe(
      "enum('a','b','c')"
    );
  });
});

describe("parseColumnType + buildColumnType 往返一致性", () => {
  const testCases = [
    "int",
    "int unsigned",
    "varchar(255)",
    "bigint(20) unsigned",
    "decimal(10,2)",
    "decimal(10,2) unsigned",
    "decimal(10)",
    "float(7,4)",
    "float(7,4) unsigned",
    "double(15,8)",
    "text",
    "datetime",
    "tinyint(1)",
    "json",
  ];

  testCases.forEach((type) => {
    it(`往返: "${type}"`, () => {
      const parsed = parseColumnType(type);
      const rebuilt = buildColumnType(
        parsed.dataType,
        parsed.length,
        parsed.scale,
        parsed.unsigned
      );
      expect(rebuilt).toBe(type);
    });
  });
});

describe("MYSQL_DATA_TYPES", () => {
  it("包含分组选项", () => {
    expect(MYSQL_DATA_TYPES.length).toBeGreaterThan(0);
    MYSQL_DATA_TYPES.forEach((group) => {
      expect(group).toHaveProperty("label");
      expect(group).toHaveProperty("options");
      expect(group.options.length).toBeGreaterThan(0);
    });
  });

  it("每个选项有 label 和 value", () => {
    MYSQL_DATA_TYPES.forEach((group) => {
      group.options.forEach((opt) => {
        expect(opt).toHaveProperty("label");
        expect(opt).toHaveProperty("value");
        expect(typeof opt.label).toBe("string");
        expect(typeof opt.value).toBe("string");
      });
    });
  });

  it("包含常用数据类型", () => {
    const allTypes = MYSQL_DATA_TYPES.flatMap((g) =>
      g.options.map((o) => o.value)
    );
    expect(allTypes).toContain("int");
    expect(allTypes).toContain("varchar");
    expect(allTypes).toContain("text");
    expect(allTypes).toContain("datetime");
    expect(allTypes).toContain("decimal");
    expect(allTypes).toContain("bigint");
    expect(allTypes).toContain("json");
  });
});

describe("UNSIGNED_TYPES", () => {
  it("包含数值类型", () => {
    expect(UNSIGNED_TYPES.has("int")).toBe(true);
    expect(UNSIGNED_TYPES.has("bigint")).toBe(true);
    expect(UNSIGNED_TYPES.has("decimal")).toBe(true);
    expect(UNSIGNED_TYPES.has("float")).toBe(true);
    expect(UNSIGNED_TYPES.has("double")).toBe(true);
  });

  it("不包含非数值类型", () => {
    expect(UNSIGNED_TYPES.has("varchar")).toBe(false);
    expect(UNSIGNED_TYPES.has("text")).toBe(false);
    expect(UNSIGNED_TYPES.has("datetime")).toBe(false);
    expect(UNSIGNED_TYPES.has("json")).toBe(false);
  });
});

describe("LENGTH_TYPES", () => {
  it("包含需要长度的类型", () => {
    expect(LENGTH_TYPES.has("varchar")).toBe(true);
    expect(LENGTH_TYPES.has("char")).toBe(true);
    expect(LENGTH_TYPES.has("int")).toBe(true);
    expect(LENGTH_TYPES.has("decimal")).toBe(true);
  });

  it("不包含不需要长度的类型", () => {
    expect(LENGTH_TYPES.has("text")).toBe(false);
    expect(LENGTH_TYPES.has("mediumtext")).toBe(false);
    expect(LENGTH_TYPES.has("longtext")).toBe(false);
    expect(LENGTH_TYPES.has("json")).toBe(false);
    expect(LENGTH_TYPES.has("date")).toBe(false);
  });
});

describe("SCALE_TYPES", () => {
  it("包含 decimal/float/double", () => {
    expect(SCALE_TYPES.has("decimal")).toBe(true);
    expect(SCALE_TYPES.has("float")).toBe(true);
    expect(SCALE_TYPES.has("double")).toBe(true);
  });

  it("不包含其他类型", () => {
    expect(SCALE_TYPES.has("int")).toBe(false);
    expect(SCALE_TYPES.has("varchar")).toBe(false);
    expect(SCALE_TYPES.has("bigint")).toBe(false);
  });
});
