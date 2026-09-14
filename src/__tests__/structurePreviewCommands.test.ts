import { beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import * as api from "../services/tauriCommands";

describe("表结构 SQL 预览命令", () => {
  beforeEach(() => clearMocks());

  it("新增列只调用预览命令并返回所有 SQL", async () => {
    const request = {
      name: "state",
      column_type: "varchar(32)",
      nullable: false,
      default_value: "draft",
      extra: "",
      comment: "状态",
      after_column: null,
    };
    mockIPC((command, payload) => {
      expect(command).toBe("preview_add_column");
      expect(payload).toEqual({
        connId: "conn",
        database: "app",
        table: "users",
        request,
      });
      return [
        "ALTER TABLE users ADD state varchar(32)",
        "COMMENT ON COLUMN users.state IS '状态'",
      ];
    });
    expect(
      await api.previewAddColumn("conn", "app", "users", request)
    ).toHaveLength(2);
  });

  it("表属性预览保留改名和引擎参数", async () => {
    mockIPC((command, payload) => {
      expect(command).toBe("preview_table_properties");
      expect(payload).toEqual({
        connId: "conn",
        database: "app",
        table: "old",
        newName: "new",
        engine: "MyISAM",
      });
      return [
        "ALTER TABLE old RENAME TO new",
        "ALTER TABLE new ENGINE = MyISAM",
      ];
    });
    expect(
      await api.previewTableProperties("conn", "app", "old", "new", "MyISAM")
    ).toHaveLength(2);
  });

  it("编辑列预览透传主键修改并传播失败", async () => {
    const request = {
      old_name: "id",
      new_name: "id",
      column_type: "bigint",
      nullable: false,
      default_value: null,
      extra: "",
      comment: "",
      is_primary: false,
    };
    mockIPC((command, payload) => {
      expect(command).toBe("preview_alter_column");
      expect(payload).toEqual({
        connId: "conn",
        database: "app",
        table: "users",
        request,
      });
      throw new Error("查询主键信息失败");
    });
    await expect(
      api.previewAlterColumn("conn", "app", "users", request)
    ).rejects.toThrow("查询主键信息失败");
  });

  it("新建表预览不调用创建命令", async () => {
    const request = {
      table_name: "users",
      columns: [
        {
          name: "id",
          column_type: "int",
          nullable: false,
          default_value: null,
          extra: "",
          comment: "",
        },
      ],
      primary_keys: ["id"],
      engine: "InnoDB",
      comment: "用户",
    };
    mockIPC((command, payload) => {
      expect(command).toBe("preview_create_table");
      expect(payload).toEqual({ connId: "conn", database: "app", request });
      return ["CREATE TABLE users (id int PRIMARY KEY)"];
    });
    expect(await api.previewCreateTable("conn", "app", request)).toEqual([
      "CREATE TABLE users (id int PRIMARY KEY)",
    ]);
  });
});
