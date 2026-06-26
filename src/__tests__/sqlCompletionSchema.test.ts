import { describe, expect, it, vi } from "vitest";
import type { SqlCompletionMetadata } from "../types";
import { loadSqlCompletionSchema } from "../utils/sqlCompletionSchema";

describe("loadSqlCompletionSchema", () => {
  it("PostgreSQL 使用批量元数据接口加载 schema/table/column，不逐表查询结构", async () => {
    const metadata: SqlCompletionMetadata = {
      databases: ["public"],
      tables: [{ name: "users" }],
      columns: [{ table: "users", name: "id", type: "integer" }],
    };
    const source = {
      getSqlCompletionMetadata: vi.fn().mockResolvedValue(metadata),
      listDatabases: vi.fn(),
      listTables: vi.fn(),
      getTableStructure: vi.fn(),
    };

    const schema = await loadSqlCompletionSchema(
      source,
      "conn-1",
      "public",
      "postgres"
    );

    expect(source.getSqlCompletionMetadata).toHaveBeenCalledWith(
      "conn-1",
      "public"
    );
    expect(source.listTables).not.toHaveBeenCalled();
    expect(source.getTableStructure).not.toHaveBeenCalled();
    expect(schema).toEqual(metadata);
  });

  it("未选择 database/schema 时仍通过批量接口只加载数据库列表", async () => {
    const metadata: SqlCompletionMetadata = {
      databases: ["app"],
      tables: [],
      columns: [],
    };
    const source = {
      getSqlCompletionMetadata: vi.fn().mockResolvedValue(metadata),
      listDatabases: vi.fn(),
      listTables: vi.fn(),
      getTableStructure: vi.fn(),
    };

    const schema = await loadSqlCompletionSchema(
      source,
      "conn-1",
      null,
      "mysql"
    );

    expect(source.getSqlCompletionMetadata).toHaveBeenCalledWith(
      "conn-1",
      null
    );
    expect(source.listDatabases).not.toHaveBeenCalled();
    expect(schema).toEqual(metadata);
  });

  it("SQLite 也使用批量元数据接口加载 database/table/column", async () => {
    const metadata: SqlCompletionMetadata = {
      databases: ["main"],
      tables: [{ name: "users" }],
      columns: [{ table: "users", name: "name", type: "TEXT" }],
    };
    const source = {
      getSqlCompletionMetadata: vi.fn().mockResolvedValue(metadata),
      listDatabases: vi.fn(),
      listTables: vi.fn(),
      getTableStructure: vi.fn(),
    };

    const schema = await loadSqlCompletionSchema(
      source,
      "conn-1",
      "main",
      "sqlite"
    );

    expect(source.getSqlCompletionMetadata).toHaveBeenCalledWith(
      "conn-1",
      "main"
    );
    expect(source.listTables).not.toHaveBeenCalled();
    expect(source.getTableStructure).not.toHaveBeenCalled();
    expect(schema).toEqual(metadata);
  });
});
