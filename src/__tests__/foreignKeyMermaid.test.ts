import { describe, it, expect } from "vitest";
import { buildForeignKeyMermaidDiagram } from "../utils/foreignKeyMermaid";
import type { ForeignKeyInfo } from "../types";

describe("foreignKeyMermaid", () => {
  it("空列表生成占位", () => {
    const s = buildForeignKeyMermaidDiagram([]);
    expect(s).toContain("flowchart LR");
    expect(s).toContain("无外键关联");
  });

  it("单条外键含方向与列", () => {
    const fk: ForeignKeyInfo = {
      constraint_name: "fk_u",
      direction: "outgoing",
      table_schema: "db",
      table_name: "orders",
      column_names: ["user_id"],
      referenced_table_schema: "db",
      referenced_table_name: "users",
      referenced_column_names: ["id"],
      update_rule: "CASCADE",
      delete_rule: "RESTRICT",
    };
    const s = buildForeignKeyMermaidDiagram([fk]);
    expect(s).toContain("db.orders");
    expect(s).toContain("db.users");
    expect(s).toContain("fk_u");
    expect(s).toContain("user_id -> id");
    expect(s).toContain("outgoing");
  });
});
