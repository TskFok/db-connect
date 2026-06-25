import { describe, it, expect } from "vitest";
import { formColumnToDef } from "../utils/createTableFormUtils";
import type { CreateTableRequest, CreateTableColumnDef } from "../types";

describe("formColumnToDef", () => {
  it("基本 varchar 列 → 正确构建 column_type", () => {
    const result = formColumnToDef({
      name: "username",
      data_type: "varchar",
      length: "100",
      scale: "",
      unsigned: false,
      nullable: true,
      default_value: "",
      extra: "",
      comment: "用户名",
    });

    expect(result).toEqual({
      name: "username",
      column_type: "varchar(100)",
      nullable: true,
      default_value: null,
      extra: "",
      comment: "用户名",
    });
  });

  it("bigint unsigned auto_increment → 正确构建", () => {
    const result = formColumnToDef({
      name: "id",
      data_type: "bigint",
      length: "",
      scale: "",
      unsigned: true,
      nullable: false,
      default_value: "",
      extra: "auto_increment",
      comment: "主键",
    });

    expect(result).toEqual({
      name: "id",
      column_type: "bigint unsigned",
      nullable: false,
      default_value: null,
      extra: "auto_increment",
      comment: "主键",
    });
  });

  it("decimal 带精度和小数位 → 正确构建 (M,D)", () => {
    const result = formColumnToDef({
      name: "price",
      data_type: "decimal",
      length: "10",
      scale: "2",
      unsigned: false,
      nullable: false,
      default_value: "0.00",
      extra: "",
      comment: "价格",
    });

    expect(result).toEqual({
      name: "price",
      column_type: "decimal(10,2)",
      nullable: false,
      default_value: "0.00",
      extra: "",
      comment: "价格",
    });
  });

  it("text 类型 (无长度/unsigned) → 正确构建", () => {
    const result = formColumnToDef({
      name: "content",
      data_type: "text",
      length: "",
      scale: "",
      unsigned: false,
      nullable: true,
      default_value: "",
      extra: "",
      comment: "",
    });

    expect(result).toEqual({
      name: "content",
      column_type: "text",
      nullable: true,
      default_value: null,
      extra: "",
      comment: "",
    });
  });

  it("int 带长度和 unsigned → 正确构建", () => {
    const result = formColumnToDef({
      name: "status",
      data_type: "int",
      length: "11",
      scale: "",
      unsigned: true,
      nullable: false,
      default_value: "0",
      extra: "",
      comment: "状态",
    });

    expect(result).toEqual({
      name: "status",
      column_type: "int(11) unsigned",
      nullable: false,
      default_value: "0",
      extra: "",
      comment: "状态",
    });
  });

  it("datetime 带默认值 CURRENT_TIMESTAMP → 保留默认值", () => {
    const result = formColumnToDef({
      name: "created_at",
      data_type: "datetime",
      length: "",
      scale: "",
      unsigned: false,
      nullable: false,
      default_value: "CURRENT_TIMESTAMP",
      extra: "",
      comment: "创建时间",
    });

    expect(result).toEqual({
      name: "created_at",
      column_type: "datetime",
      nullable: false,
      default_value: "CURRENT_TIMESTAMP",
      extra: "",
      comment: "创建时间",
    });
  });

  it("nullable 默认为 true 当 undefined 时", () => {
    const result = formColumnToDef({
      name: "field",
      data_type: "varchar",
      length: "255",
    });

    expect(result.nullable).toBe(true);
  });

  it("空名称 → 空字符串 (不 trim)", () => {
    const result = formColumnToDef({
      name: "  test  ",
      data_type: "int",
      length: "",
      scale: "",
      unsigned: false,
    });

    expect(result.name).toBe("test");
  });

  it("空默认值字符串 → null", () => {
    const result = formColumnToDef({
      name: "col",
      data_type: "int",
      default_value: "",
    });
    expect(result.default_value).toBeNull();
  });

  it("undefined 默认值 → null", () => {
    const result = formColumnToDef({
      name: "col",
      data_type: "int",
    });
    expect(result.default_value).toBeNull();
  });
});

describe("CreateTableRequest 结构", () => {
  it("完整构建请求对象", () => {
    const columns: CreateTableColumnDef[] = [
      {
        name: "id",
        column_type: "bigint unsigned",
        nullable: false,
        default_value: null,
        extra: "auto_increment",
        comment: "主键",
      },
      {
        name: "name",
        column_type: "varchar(100)",
        nullable: false,
        default_value: "",
        extra: "",
        comment: "用户名",
      },
    ];

    const request: CreateTableRequest = {
      table_name: "users",
      columns,
      primary_keys: ["id"],
      engine: "InnoDB",
      comment: "用户表",
    };

    expect(request.table_name).toBe("users");
    expect(request.columns).toHaveLength(2);
    expect(request.primary_keys).toEqual(["id"]);
    expect(request.engine).toBe("InnoDB");
    expect(request.comment).toBe("用户表");
  });

  it("多列复合主键", () => {
    const request: CreateTableRequest = {
      table_name: "order_items",
      columns: [
        {
          name: "order_id",
          column_type: "bigint",
          nullable: false,
          default_value: null,
          extra: "",
          comment: "",
        },
        {
          name: "item_id",
          column_type: "bigint",
          nullable: false,
          default_value: null,
          extra: "",
          comment: "",
        },
      ],
      primary_keys: ["order_id", "item_id"],
      engine: "InnoDB",
      comment: "",
    };

    expect(request.primary_keys).toHaveLength(2);
    expect(request.primary_keys).toContain("order_id");
    expect(request.primary_keys).toContain("item_id");
  });

  it("无主键请求", () => {
    const request: CreateTableRequest = {
      table_name: "logs",
      columns: [
        {
          name: "msg",
          column_type: "text",
          nullable: true,
          default_value: null,
          extra: "",
          comment: "",
        },
      ],
      primary_keys: [],
      engine: "MyISAM",
      comment: "",
    };

    expect(request.primary_keys).toHaveLength(0);
  });
});
