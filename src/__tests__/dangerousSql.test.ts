import { describe, it, expect } from "vitest";
import {
  isDangerousSqlStatement,
  listDangerousSqlStatements,
} from "../utils/dangerousSql";

describe("dangerousSql", () => {
  it("识别 TRUNCATE / DROP DATABASE / DROP SCHEMA", () => {
    expect(isDangerousSqlStatement("truncate table t")).toBe(true);
    expect(isDangerousSqlStatement("  DROP DATABASE `x`")).toBe(true);
    expect(isDangerousSqlStatement("drop schema db1")).toBe(true);
  });

  it("普通 DML/DDL 不误报", () => {
    expect(isDangerousSqlStatement("select * from t")).toBe(false);
    expect(isDangerousSqlStatement("drop table t")).toBe(false);
    expect(isDangerousSqlStatement("delete from t where id=1")).toBe(false);
  });

  it("listDangerousSqlStatements 过滤多条", () => {
    expect(
      listDangerousSqlStatements([
        "select 1",
        "truncate a",
        "drop database x",
      ])
    ).toHaveLength(2);
  });
});
