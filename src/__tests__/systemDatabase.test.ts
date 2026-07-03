import { describe, expect, it } from "vitest";
import { isSystemDatabase } from "../utils/systemDatabase";

describe("systemDatabase", () => {
  it("应识别 MySQL 系统库", () => {
    expect(isSystemDatabase("mysql")).toBe(true);
    expect(isSystemDatabase("INFORMATION_SCHEMA")).toBe(true);
  });

  it("应识别 PostgreSQL 系统 schema", () => {
    expect(isSystemDatabase("pg_catalog")).toBe(true);
    expect(isSystemDatabase("PG_TOAST")).toBe(true);
    // pg_* 前缀（包含 pg_temp_*）一律视为系统 schema
    expect(isSystemDatabase("pg_temp_1")).toBe(true);
    expect(isSystemDatabase("pg_toast_temp_1")).toBe(true);
  });

  it("应识别 ClickHouse 系统库", () => {
    expect(isSystemDatabase("system")).toBe(true);
    expect(isSystemDatabase("INFORMATION_SCHEMA")).toBe(true);
    expect(isSystemDatabase("information_schema")).toBe(true);
  });

  it("用户库/schema 不应视为系统对象", () => {
    expect(isSystemDatabase("my_app")).toBe(false);
    expect(isSystemDatabase("public")).toBe(false);
  });
});
