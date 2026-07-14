import { describe, expect, it } from "vitest";
import type { DatabaseCompareResult } from "../types";
import {
  buildDatabaseCompareWorkbookBase64,
  buildDatabaseCompareWorkbookSheets,
} from "../utils/databaseCompareExport";

const XLSX_ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function sampleCompareResult(): DatabaseCompareResult {
  return {
    database_type: "mysql",
    source: {
      connection_id: "source-id",
      connection_name: "源连接",
      database: "app",
    },
    target: {
      connection_id: "target-id",
      connection_name: "目标连接",
      database: "audit",
    },
    compared_at: "2026-07-14T08:00:00Z",
    summary: {
      source_only_tables: 1,
      target_only_tables: 0,
      changed_tables: 1,
      different_columns: 1,
    },
    tables: [
      {
        name: "source_only",
        status: "source_only",
        columns: [
          {
            name: "ignored",
            status: "source_only",
            changed_fields: [],
            source: {
              ordinal_position: 1,
              column_type: "int",
              nullable: false,
              default_value: null,
              primary_key: false,
              extra: "",
              comment: "",
            },
            target: null,
          },
        ],
      },
      {
        name: "users",
        status: "changed",
        columns: [
          {
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
          },
        ],
      },
    ],
  };
}

describe("databaseCompareExport", () => {
  it("构造摘要、表差异和字段差异三个工作表", () => {
    const sheets = buildDatabaseCompareWorkbookSheets(sampleCompareResult());

    expect(sheets.map((sheet) => sheet.sheet)).toEqual([
      "对比摘要",
      "表差异",
      "字段差异",
    ]);
    expect(sheets[0].data).toEqual([
      ["项目", "值"],
      ["数据库类型", "mysql"],
      ["源连接", "源连接"],
      ["源数据库/schema", "app"],
      ["目标连接", "目标连接"],
      ["目标数据库/schema", "audit"],
      ["对比时间", "2026-07-14T08:00:00Z"],
      ["仅源端表", 1],
      ["仅目标端表", 0],
      ["结构变化表", 1],
      ["差异字段", 1],
    ]);
    expect(sheets[1].data[1]).toEqual(["source_only", "仅源端"]);
    expect(sheets[2].data).toHaveLength(2);
    expect(sheets[2].data[1]).toEqual([
      "users",
      "email",
      "仅目标端",
      "",
      "",
      "字段顺序=2；字段类型=varchar(255)；允许为空=是；默认值=；主键=否；额外属性=；注释=",
    ]);
  });

  it("生成包含三个工作表的有效 xlsx", async () => {
    const base64 = await buildDatabaseCompareWorkbookBase64(
      sampleCompareResult()
    );
    const bytes = base64ToBytes(base64);

    expect(Array.from(bytes.slice(0, 4))).toEqual(XLSX_ZIP_MAGIC);
  });
});
