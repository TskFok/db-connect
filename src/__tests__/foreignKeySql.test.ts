import { describe, it, expect } from "vitest";
import {
  previewAddForeignKeySql,
  parseReferencedTable,
  validateReferentialAction,
} from "../utils/foreignKeySql";
import type { AddForeignKeyRequest } from "../types";

describe("foreignKeySql", () => {
  it("parseReferencedTable 支持默认库与限定名", () => {
    expect(parseReferencedTable("db1", "t")).toEqual(["db1", "t"]);
    expect(parseReferencedTable("db1", "other.t2")).toEqual(["other", "t2"]);
  });

  it("validateReferentialAction 拒绝非法值", () => {
    expect(() => validateReferentialAction("INVALID")).toThrow(/无效/);
  });

  it("previewAddForeignKeySql 与单列表一致", () => {
    const req: AddForeignKeyRequest = {
      constraint_name: "fk1",
      columns: ["user_id"],
      referenced_table: "users",
      referenced_columns: ["id"],
      on_update: "CASCADE",
      on_delete: "RESTRICT",
    };
    const sql = previewAddForeignKeySql("mydb", "orders", req);
    expect(sql).toContain("ADD CONSTRAINT `fk1`");
    expect(sql).toContain("FOREIGN KEY (`user_id`)");
    expect(sql).toContain("REFERENCES `mydb`.`users` (`id`)");
    expect(sql).toContain("ON UPDATE CASCADE");
    expect(sql).toContain("ON DELETE RESTRICT");
  });

  it("previewAddForeignKeySql 支持限定被引用表", () => {
    const req: AddForeignKeyRequest = {
      constraint_name: "fk2",
      columns: ["a", "b"],
      referenced_table: "other.r",
      referenced_columns: ["x", "y"],
      on_update: "NO ACTION",
      on_delete: "SET NULL",
    };
    const sql = previewAddForeignKeySql("d", "t", req);
    expect(sql).toContain("REFERENCES `other`.`r` (`x`, `y`)");
  });

  it("SQL Server 预览使用方括号并默认当前 schema", () => {
    const req: AddForeignKeyRequest = {
      constraint_name: "fk_orders_user",
      columns: ["user_id"],
      referenced_table: "users",
      referenced_columns: ["id"],
      on_update: "NO ACTION",
      on_delete: "CASCADE",
    };
    const sql = previewAddForeignKeySql("dbo", "orders", req, "sqlserver");
    expect(sql).toBe(
      "ALTER TABLE [dbo].[orders] ADD CONSTRAINT [fk_orders_user] FOREIGN KEY ([user_id]) REFERENCES [dbo].[users] ([id]) ON UPDATE NO ACTION ON DELETE CASCADE"
    );
  });

  it("SQL Server 预览拒绝 RESTRICT 引用动作", () => {
    const req: AddForeignKeyRequest = {
      constraint_name: "fk_orders_user",
      columns: ["user_id"],
      referenced_table: "users",
      referenced_columns: ["id"],
      on_update: "RESTRICT",
      on_delete: "NO ACTION",
    };
    expect(() =>
      previewAddForeignKeySql("dbo", "orders", req, "sqlserver")
    ).toThrow(/SQL Server.*NO ACTION/);
  });
});
