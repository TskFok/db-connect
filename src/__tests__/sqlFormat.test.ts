import { describe, it, expect } from "vitest";
import {
  formatSql,
  sqlDialectToFormatterLanguage,
} from "../utils/sqlFormat";

describe("sqlFormat", () => {
  describe("sqlDialectToFormatterLanguage", () => {
    it("应映射各数据库方言", () => {
      expect(sqlDialectToFormatterLanguage("mysql")).toBe("mysql");
      expect(sqlDialectToFormatterLanguage("postgres")).toBe("postgresql");
      expect(sqlDialectToFormatterLanguage("sqlite")).toBe("sqlite");
      expect(sqlDialectToFormatterLanguage("sqlserver")).toBe("transactsql");
      expect(sqlDialectToFormatterLanguage("clickhouse")).toBe("clickhouse");
    });
  });

  describe("formatSql", () => {
    it("空字符串应原样返回", () => {
      expect(formatSql("")).toBe("");
      expect(formatSql("   ")).toBe("   ");
    });

    it("应美化简单 SELECT 并大写关键字", () => {
      const formatted = formatSql("select a,b from t where x=1");
      expect(formatted).toContain("SELECT");
      expect(formatted).toContain("FROM");
      expect(formatted).toContain("WHERE");
      expect(formatted).toContain("a,");
      expect(formatted).toContain("b");
    });

    it("应按方言格式化", () => {
      const pg = formatSql("select * from public.users", { dialect: "postgres" });
      expect(pg).toContain("SELECT");
      expect(pg).toContain("public.users");
    });

    it("ClickHouse 方言应使用专用格式化语言且不抛错", () => {
      const formatted = formatSql("select * from events format JSON", {
        dialect: "clickhouse",
      });
      expect(formatted).toContain("SELECT");
      expect(formatted).toContain("FORMAT");
    });

    it("应保留多条语句之间的分号结构", () => {
      const formatted = formatSql("select 1; select 2");
      expect(formatted).toContain("SELECT");
      expect(formatted).toMatch(/1\s*;/);
      expect(formatted).toMatch(/SELECT\s+2/);
    });

    it("非法 SQL 应抛出错误", () => {
      expect(() => formatSql("'''")).toThrow();
    });
  });
});
