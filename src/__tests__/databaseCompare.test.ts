import { describe, expect, it } from "vitest";
import type { ColumnDiff, TableDiff } from "../types";
import {
  filterTableDiffs,
  formatChangedFields,
  formatColumnSideValues,
  formatSchemaDiffStatus,
} from "../utils/databaseCompare";

function sampleChangedColumn(): ColumnDiff {
  return {
    name: "id",
    status: "changed",
    changed_fields: ["column_type", "nullable"],
    source: {
      ordinal_position: 1,
      column_type: "bigint",
      nullable: false,
      default_value: null,
      primary_key: true,
      extra: "auto_increment",
      comment: "主键",
    },
    target: {
      ordinal_position: 1,
      column_type: "int",
      nullable: true,
      default_value: null,
      primary_key: true,
      extra: "auto_increment",
      comment: "主键",
    },
  };
}

describe("databaseCompare", () => {
  it("按状态和表名筛选差异", () => {
    const tables: TableDiff[] = [
      { name: "audit_logs", status: "source_only", columns: [] },
      { name: "users", status: "changed", columns: [] },
      { name: "UserProfiles", status: "changed", columns: [] },
    ];

    expect(
      filterTableDiffs(tables, "changed", "USER").map((row) => row.name)
    ).toEqual(["users", "UserProfiles"]);
    expect(filterTableDiffs(tables, "all", "audit")).toEqual([tables[0]]);
  });

  it("格式化字段变化时只输出变化属性", () => {
    const column = sampleChangedColumn();

    expect(formatChangedFields(column.changed_fields)).toBe(
      "字段类型、允许为空"
    );
    expect(formatColumnSideValues(column, "source")).toBe(
      "字段类型=bigint；允许为空=否"
    );
  });

  it("格式化单侧字段时输出七项完整属性", () => {
    const column: ColumnDiff = {
      name: "email",
      status: "target_only",
      changed_fields: [],
      source: null,
      target: {
        ordinal_position: 2,
        column_type: "varchar(255)",
        nullable: true,
        default_value: null,
        primary_key: false,
        extra: "",
        comment: "",
      },
    };

    expect(formatColumnSideValues(column, "source")).toBe("");
    expect(formatColumnSideValues(column, "target")).toBe(
      "字段顺序=2；字段类型=varchar(255)；允许为空=是；默认值=；主键=否；额外属性=；注释="
    );
  });

  it("格式化差异状态为中文", () => {
    expect(formatSchemaDiffStatus("source_only")).toBe("仅源端");
    expect(formatSchemaDiffStatus("target_only")).toBe("仅目标端");
    expect(formatSchemaDiffStatus("changed")).toBe("结构变化");
  });
});
