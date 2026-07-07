/**
 * 手工 E2E 建议（需已连接真实 MySQL）：
 * 1) 在库概览点「导出」生成 .sql，再新建空库「导入」该文件，核对表/视图/触发器/事件。
 * 2) 大表限制 max 行后比对行数；无写权限目录导出应出现明确错误。
 * 3) 实例 @@global.read_only / super_read_only 时导入应被前端拦截。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../services/tauriCommands", () => ({
  executeSql: vi.fn(),
}));

import * as api from "../services/tauriCommands";
import {
  IMPORT_SQL_BACKUP_HINT,
  buildExportSqlDescription,
  buildImportFailureDetailsText,
  buildImportReadOnlyWarningText,
  buildImportSqlConfirmText,
  isConnectionGloballyReadOnly,
  isServerReadOnlyFromSqlResult,
} from "../utils/sqlFileIoUi";
import type { ImportSqlFileResult, SqlExecuteResult } from "../types";

const mockExecuteSql = vi.mocked(api.executeSql);

describe("sqlFileIoUi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("导入确认文案应包含备份提示", () => {
    const t = buildImportSqlConfirmText();
    expect(t).toContain(IMPORT_SQL_BACKUP_HINT);
    expect(t).toContain("DROP");
    expect(t).toContain("跳过");
  });

  it("SQL Server 导入确认文案提示 GO 批处理分隔符", () => {
    const t = buildImportSqlConfirmText("sqlserver");
    expect(t).toContain("GO");
    expect(t).toContain("批");
    expect(t).toContain(IMPORT_SQL_BACKUP_HINT);
  });

  it("ClickHouse 导入确认文案提示 FORMAT 数据与失败继续策略", () => {
    const t = buildImportSqlConfirmText("clickhouse");
    expect(t).toContain("ClickHouse");
    expect(t).toContain("FORMAT");
    expect(t).toContain("跳过");
    expect(t).toContain(IMPORT_SQL_BACKUP_HINT);
  });

  it("SQL Server 只读导入提示不使用 MySQL read_only 文案", () => {
    const t = buildImportReadOnlyWarningText("sqlserver");
    expect(t).toContain("SQL Server");
    expect(t).toContain("READ_ONLY");
    expect(t).not.toContain("@@global");
    expect(t).not.toContain("super_read_only");
  });

  it("ClickHouse 只读导入提示使用 readonly setting 文案", () => {
    const t = buildImportReadOnlyWarningText("clickhouse");
    expect(t).toContain("ClickHouse");
    expect(t).toContain("readonly");
    expect(t).not.toContain("@@global");
    expect(t).not.toContain("super_read_only");
  });

  it("SQL Server 导出说明使用 schema 和 GO 文案，不出现 MySQL 专属事件说明", () => {
    const t = buildExportSqlDescription("sqlserver");
    expect(t).toContain("当前 schema");
    expect(t).toContain("GO");
    expect(t).toContain("函数/过程");
    expect(t).not.toContain("事件");
    expect(t).not.toContain("mysqldump");
  });

  it("ClickHouse 导出说明使用 system.tables 和每表行数上限文案", () => {
    const t = buildExportSqlDescription("clickhouse");
    expect(t).toContain("ClickHouse");
    expect(t).toContain("system.tables");
    expect(t).toContain("每表最多行数");
    expect(t).not.toContain("触发器");
    expect(t).not.toContain("事件");
  });

  it("buildImportFailureDetailsText 无失败时为空", () => {
    expect(
      buildImportFailureDetailsText({
        statements_total: 1,
        statements_ok: 1,
        statements_failed: 0,
        failures: [],
        elapsed_ms: 0,
      })
    ).toBe("");
  });

  it("buildImportFailureDetailsText 列出失败条目", () => {
    const r: ImportSqlFileResult = {
      statements_total: 3,
      statements_ok: 2,
      statements_failed: 1,
      failures: [
        {
          statement_index: 2,
          statement_preview: "CREATE TABLE users (id integer)",
          error: "syntax",
        },
      ],
      elapsed_ms: 1,
    };
    expect(buildImportFailureDetailsText(r)).toContain("第 2 条");
    expect(buildImportFailureDetailsText(r)).toContain("CREATE TABLE users");
    expect(buildImportFailureDetailsText(r)).toContain("syntax");
  });

  it("buildImportFailureDetailsText 提示未记录详情条数", () => {
    const r: ImportSqlFileResult = {
      statements_total: 100,
      statements_ok: 10,
      statements_failed: 90,
      failures: [{ statement_index: 1, error: "a" }],
      elapsed_ms: 1,
    };
    expect(buildImportFailureDetailsText(r)).toContain("另有");
    expect(buildImportFailureDetailsText(r)).toContain("89");
  });

  it("read_only 查询结果 ro=1 应视为只读", () => {
    const r: SqlExecuteResult = {
      result_type: "select",
      columns: ["ro"],
      rows: [[1]],
      affected_rows: null,
      message: "",
      execution_time_ms: 0,
    };
    expect(isServerReadOnlyFromSqlResult(r)).toBe(true);
  });

  it("super_read_only=1 时即使 ro=0 也应视为只读", () => {
    const r: SqlExecuteResult = {
      result_type: "select",
      columns: ["ro", "sro"],
      rows: [[0, 1]],
      affected_rows: null,
      message: "",
      execution_time_ms: 0,
    };
    expect(isServerReadOnlyFromSqlResult(r)).toBe(true);
  });

  it("read_only 为 0 不应视为只读", () => {
    const r: SqlExecuteResult = {
      result_type: "select",
      columns: ["ro"],
      rows: [[0]],
      affected_rows: null,
      message: "",
      execution_time_ms: 0,
    };
    expect(isServerReadOnlyFromSqlResult(r)).toBe(false);
  });

  it("非 SELECT 结果应返回 false", () => {
    const r: SqlExecuteResult = {
      result_type: "modify",
      columns: null,
      rows: null,
      affected_rows: 1,
      message: "ok",
      execution_time_ms: 0,
    };
    expect(isServerReadOnlyFromSqlResult(r)).toBe(false);
  });

  it("isConnectionGloballyReadOnly 根据 executeSql 结果判断", async () => {
    mockExecuteSql.mockResolvedValue({
      result_type: "select",
      columns: ["ro", "sro"],
      rows: [[1, 0]],
      affected_rows: null,
      message: "",
      execution_time_ms: 0,
    });
    await expect(isConnectionGloballyReadOnly("c1", "db")).resolves.toBe(true);
    expect(mockExecuteSql).toHaveBeenCalledTimes(1);
  });

  it("isConnectionGloballyReadOnly 在首查失败时回退单字段查询", async () => {
    mockExecuteSql
      .mockRejectedValueOnce(new Error("no sro"))
      .mockResolvedValueOnce({
        result_type: "select",
        columns: ["ro"],
        rows: [[0]],
        affected_rows: null,
        message: "",
        execution_time_ms: 0,
      });
    await expect(isConnectionGloballyReadOnly("c1", "db")).resolves.toBe(false);
    expect(mockExecuteSql).toHaveBeenCalledTimes(2);
  });

  it("isConnectionGloballyReadOnly 在 PostgreSQL 下查询 transaction_read_only", async () => {
    mockExecuteSql.mockResolvedValue({
      result_type: "select",
      columns: ["ro"],
      rows: [["on"]],
      affected_rows: null,
      message: "",
      execution_time_ms: 0,
    });
    await expect(
      (
        isConnectionGloballyReadOnly as unknown as (
          connId: string,
          database: string,
          databaseType: "postgres"
        ) => Promise<boolean>
      )("c1", "public", "postgres")
    ).resolves.toBe(true);
    expect(mockExecuteSql).toHaveBeenCalledTimes(1);
    expect(mockExecuteSql).toHaveBeenCalledWith(
      "c1",
      "public",
      "SHOW transaction_read_only"
    );
  });

  it("isConnectionGloballyReadOnly 在 SQL Server 下查询当前 database 的只读状态", async () => {
    mockExecuteSql.mockResolvedValue({
      result_type: "select",
      columns: ["ro"],
      rows: [[1]],
      affected_rows: null,
      message: "",
      execution_time_ms: 0,
    });

    await expect(
      (
        isConnectionGloballyReadOnly as unknown as (
          connId: string,
          database: string,
          databaseType: "sqlserver"
        ) => Promise<boolean>
      )("mssql-1", "dbo", "sqlserver")
    ).resolves.toBe(true);

    expect(mockExecuteSql).toHaveBeenCalledTimes(1);
    expect(mockExecuteSql).toHaveBeenCalledWith(
      "mssql-1",
      "dbo",
      expect.stringContaining("DATABASEPROPERTYEX")
    );
    expect(mockExecuteSql.mock.calls[0]?.[2]).not.toContain("@@global");
  });

  it("isConnectionGloballyReadOnly 在 ClickHouse 下查询 readonly setting", async () => {
    mockExecuteSql.mockResolvedValue({
      result_type: "select",
      columns: ["ro"],
      rows: [[1]],
      affected_rows: null,
      message: "",
      execution_time_ms: 0,
    });

    await expect(
      (
        isConnectionGloballyReadOnly as unknown as (
          connId: string,
          database: string,
          databaseType: "clickhouse"
        ) => Promise<boolean>
      )("ch-1", "analytics", "clickhouse")
    ).resolves.toBe(true);

    expect(mockExecuteSql).toHaveBeenCalledTimes(1);
    expect(mockExecuteSql).toHaveBeenCalledWith(
      "ch-1",
      "analytics",
      expect.stringContaining("system.settings")
    );
    expect(mockExecuteSql.mock.calls[0]?.[2]).toContain("readonly");
    expect(mockExecuteSql.mock.calls[0]?.[2]).not.toContain("@@global");
  });
});
