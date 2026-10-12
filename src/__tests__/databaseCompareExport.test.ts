import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseCompareResult } from "../types";
import {
  buildDatabaseCompareFilename,
  saveDatabaseCompareWorkbook,
  buildDatabaseCompareWorkbookSheets,
} from "../utils/databaseCompareExport";

import { exportExcelWithDialog } from "../utils/excelExport";

vi.mock("../utils/excelExport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../utils/excelExport")>()),
  exportExcelWithDialog: vi.fn(),
}));

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
  beforeEach(() => vi.clearAllMocks());
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
      "字段顺序=2；字段类型=varchar(255)；允许为空=是；默认值=NULL；主键=否；额外属性=；注释=",
    ]);
  });

  it("取消保存时不读取对比数据构造矩阵", async () => {
    const result = sampleCompareResult();
    const originalTables = result.tables;
    Object.defineProperty(result, "tables", {
      configurable: true,
      get: () => originalTables,
    });
    const tables = vi.spyOn(result, "tables", "get");
    vi.mocked(exportExcelWithDialog).mockResolvedValueOnce(false);
    expect(await saveDatabaseCompareWorkbook(result)).toBe(false);
    expect(tables).not.toHaveBeenCalled();
  });

  it("选择路径后输出完整的摘要、表、字段三个工作表", async () => {
    const result = sampleCompareResult();
    let prepared:
      | Awaited<ReturnType<Parameters<typeof exportExcelWithDialog>[1]>>
      | undefined;
    vi.mocked(exportExcelWithDialog).mockImplementationOnce(
      async (_name, prepare) => {
        prepared = await prepare();
        return true;
      }
    );
    expect(await saveDatabaseCompareWorkbook(result)).toBe(true);
    expect(prepared?.sheets.map((sheet) => sheet.sheet)).toEqual([
      "对比摘要",
      "表差异",
      "字段差异",
    ]);
    expect(prepared?.sheets[0].data[3]).toEqual(["源数据库/schema", "app"]);
    expect(prepared?.sheets[1].data).toEqual([
      ["表名", "差异状态"],
      ["source_only", "仅源端"],
      ["users", "结构变化"],
    ]);
    expect(prepared?.sheets[2].data[1]).toEqual([
      "users",
      "email",
      "仅目标端",
      "",
      "",
      "字段顺序=2；字段类型=varchar(255)；允许为空=是；默认值=NULL；主键=否；额外属性=；注释=",
    ]);
    result.tables.length = 0;
    expect(prepared?.sheets[1].data).toHaveLength(3);
    prepared?.release();
  });

  it("对话框返回后来源已失效时拒绝准备工作表", async () => {
    vi.mocked(exportExcelWithDialog).mockImplementationOnce(
      async (_name, prepare) => {
        const prepared = await prepare();
        prepared.release();
        return true;
      }
    );
    await expect(
      saveDatabaseCompareWorkbook(sampleCompareResult(), {
        isCurrent: () => false,
      })
    ).rejects.toThrow(/对比结果已变化/);
  });

  it("净化并限制跨平台导出文件名", () => {
    const result = sampleCompareResult();
    result.source.database = "app/prod";
    result.target.database = `audit:2026\\main.${"库".repeat(80)}`;

    const filename = buildDatabaseCompareFilename(result);

    expect(filename).not.toMatch(/[<>:"/\\|?*]/);
    expect(filename).toMatch(/^数据库对比-app_prod-audit_2026_main/);
    expect(Array.from(filename).length).toBeLessThanOrEqual(100);
    expect(filename.endsWith(".xlsx")).toBe(true);

    result.source.database = "😀".repeat(80);
    result.target.database = "😀".repeat(80);
    expect(
      new TextEncoder().encode(buildDatabaseCompareFilename(result)).length
    ).toBeLessThanOrEqual(240);
  });
});
