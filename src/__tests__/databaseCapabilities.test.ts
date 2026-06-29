import { describe, it, expect } from "vitest";
import { getDatabaseCapabilities } from "../utils/databaseCapabilities";

describe("getDatabaseCapabilities", () => {
  it("默认（未提供数据库类型）走 MySQL 全功能集，含数据编辑", () => {
    const caps = getDatabaseCapabilities(undefined);
    expect(caps.tableDataEditing).toBe(true);
    expect(caps.databaseManagement).toBe(true);
    expect(caps.schemaManagement).toBe(true);
    expect(caps.sqlEditor).toBe(true);
  });

  it("MySQL 启用数据编辑", () => {
    expect(getDatabaseCapabilities("mysql").tableDataEditing).toBe(true);
  });

  it("PostgreSQL（阶段三）启用表数据编辑", () => {
    const caps = getDatabaseCapabilities("postgres");
    expect(caps.tableDataEditing).toBe(true);
    // SQL 编辑器 / 浏览仍开启
    expect(caps.sqlEditor).toBe(true);
    expect(caps.tableBrowsing).toBe(true);
  });

  it("PostgreSQL 阶段五：索引/外键/触发器/例程已开放，但不展示 MySQL 独占的事件，且仍隐藏引擎/字符集/列重排入口", () => {
    const caps = getDatabaseCapabilities("postgres");
    expect(caps.databaseManagement).toBe(true);
    expect(caps.schemaManagement).toBe(true);
    expect(caps.routineManagement).toBe(true);
    expect(caps.triggerManagement).toBe(true);
    expect(caps.indexManagement).toBe(true);
    expect(caps.foreignKeyManagement).toBe(true);
    // PostgreSQL 无定时事件等价物
    expect(caps.eventManagement).toBe(false);
    expect(caps.charsetAndCollation).toBe(false);
    expect(caps.storageEngine).toBe(false);
    expect(caps.columnReordering).toBe(false);
    expect(caps.databaseObjectNoun).toBe("schema");
  });

  it("PostgreSQL 阶段六：开放 SQL 文件导入导出入口", () => {
    expect(getDatabaseCapabilities("postgres").sqlFileImportExport).toBe(true);
  });

  it("MySQL 启用全部高级管理与字符集/引擎/列重排/事件", () => {
    const caps = getDatabaseCapabilities("mysql");
    expect(caps.charsetAndCollation).toBe(true);
    expect(caps.storageEngine).toBe(true);
    expect(caps.columnReordering).toBe(true);
    expect(caps.eventManagement).toBe(true);
    expect(caps.databaseObjectNoun).toBe("数据库");
  });

  it("SQLite 阶段五开放对象查看/索引/触发器/导入导出，仍隐藏数据库级管理和 MySQL 专属能力", () => {
    const caps = getDatabaseCapabilities("sqlite");

    expect(caps.tableBrowsing).toBe(true);
    expect(caps.sqlEditor).toBe(true);
    expect(caps.databaseManagement).toBe(false);
    expect(caps.tableDataEditing).toBe(true);
    expect(caps.schemaManagement).toBe(true);
    expect(caps.indexManagement).toBe(true);
    expect(caps.foreignKeyManagement).toBe(true);
    expect(caps.triggerManagement).toBe(true);
    expect(caps.sqlFileImportExport).toBe(true);
    expect(caps.favoriteTables).toBe(true);
    expect(caps.savedSql).toBe(true);
    expect(caps.routineManagement).toBe(false);
    expect(caps.eventManagement).toBe(false);
    expect(caps.charsetAndCollation).toBe(false);
    expect(caps.storageEngine).toBe(false);
    expect(caps.columnReordering).toBe(false);
    expect(caps.databaseObjectNoun).toBe("database");
  });

  it("SQL Server Phase 1 只开放连接层，暂不开放浏览、编辑、导入导出和对象管理", () => {
    const caps = getDatabaseCapabilities("sqlserver");

    expect(caps.sqlEditor).toBe(false);
    expect(caps.databaseManagement).toBe(false);
    expect(caps.tableBrowsing).toBe(false);
    expect(caps.tableDataEditing).toBe(false);
    expect(caps.schemaManagement).toBe(false);
    expect(caps.routineManagement).toBe(false);
    expect(caps.eventManagement).toBe(false);
    expect(caps.triggerManagement).toBe(false);
    expect(caps.indexManagement).toBe(false);
    expect(caps.foreignKeyManagement).toBe(false);
    expect(caps.sqlFileImportExport).toBe(false);
    expect(caps.savedSql).toBe(false);
    expect(caps.favoriteTables).toBe(false);
    expect(caps.charsetAndCollation).toBe(false);
    expect(caps.storageEngine).toBe(false);
    expect(caps.columnReordering).toBe(false);
    expect(caps.databaseObjectNoun).toBe("schema");
  });

  it("未知类型回退到 MySQL 能力集，避免静默禁用所有功能", () => {
    expect(getDatabaseCapabilities("unknown-db").tableDataEditing).toBe(true);
    expect(getDatabaseCapabilities(null).tableDataEditing).toBe(true);
  });
});
