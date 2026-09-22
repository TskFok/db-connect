import dayjs from "dayjs";
import { describe, expect, it } from "vitest";
import {
  formatTemporalValue,
  getTemporalKind,
  parseTemporalValue,
  TEMPORAL_FORMATS,
} from "../utils/temporalValue";

describe("日期时间列识别", () => {
  it.each([
    ["DATE", "mysql", "date"],
    ["datetime(6)", "mysql", "datetime"],
    ["timestamp(3)", "mysql", "datetime"],
    ["time(6)", "mysql", "time"],
    ["year(4)", "mysql", "year"],
    ["timestamp without time zone", "postgres", "datetime"],
    ["timestamp(6) with time zone", "postgres", "datetime"],
    ["timestamp (6) with time zone", "postgres", "datetime"],
    ["timestamptz", "postgres", "datetime"],
    ["time(3) without time zone", "postgres", "time"],
    ["time with time zone", "postgres", "time"],
    ["timetz(6)", "postgres", "time"],
    ["datetime2(7)", "sqlserver", "datetime"],
    ["datetimeoffset(7)", "sqlserver", "datetime"],
    ["smalldatetime", "sqlserver", "datetime"],
    ["date", "sqlserver", "date"],
    ["time(7)", "sqlserver", "time"],
    ["DATETIME", "sqlite", "datetime"],
    ["Date32", "clickhouse", "date"],
    ["DateTime('Asia/Shanghai')", "clickhouse", "datetime"],
    ["Nullable(DateTime64(6, 'UTC'))", "clickhouse", "datetime"],
    ["LowCardinality(Nullable(Date))", "clickhouse", "date"],
  ] as const)("%s (%s) 使用 %s 选择器", (type, dialect, expected) => {
    expect(getTemporalKind(type, dialect)).toBe(expected);
  });

  it.each([
    ["timestamp", "sqlserver"],
    ["rowversion", "sqlserver"],
    ["timestamp[]", "postgres"],
    ["interval", "postgres"],
    ["varchar(100)", "mysql"],
    ["Array(DateTime)", "clickhouse"],
    ["TEXT", "sqlite"],
  ] as const)("%s (%s) 保持文本输入", (type, dialect) => {
    expect(getTemporalKind(type, dialect)).toBeNull();
  });

  it("省略数据库类型时仍识别现有 MySQL 日期列", () => {
    expect(getTemporalKind(" timestamp(6) ")).toBe("datetime");
  });
});

describe("日期时间值解析", () => {
  it.each([
    ["2024-02-29", "date", "2024-02-29"],
    ["2026-09-22 14:05:09", "datetime", "2026-09-22 14:05:09"],
    ["2026-09-22", "datetime", "2026-09-22 00:00:00"],
    ["2026-09-22T14:05:09.123456+08:00", "datetime", "2026-09-22 14:05:09"],
    ["2026-09-22 14:05:09.1234567 +08:00", "datetime", "2026-09-22 14:05:09"],
    ["2026-03-08 02:30:00", "datetime", "2026-03-08 02:30:00"],
    ["9:05:09", "time", "09:05:09"],
    ["14:05:09.123456+08", "time", "14:05:09"],
    ["2026", "year", "2026"],
  ] as const)("%s 解析为 %s 墙上时刻", (value, kind, expected) => {
    const parsed = parseTemporalValue(value, kind);
    expect(parsed?.format(TEMPORAL_FORMATS[kind])).toBe(expected);
    expect(parsed?.isUTC()).toBe(true);
  });

  it.each([
    ["", "date"],
    ["0000-00-00", "date"],
    ["2026-02-29", "date"],
    ["2026-04-31 12:00:00", "datetime"],
    ["2026-09-22 24:00:00", "datetime"],
    ["2026-09-22 12:00:00+27:00", "datetime"],
    ["infinity", "datetime"],
    ["CURRENT_TIMESTAMP", "datetime"],
    ["26:30:00", "time"],
    ["-2:30:00", "time"],
    ["12:60:00", "time"],
    ["0000", "year"],
    ["2026-09-22", "year"],
  ] as const)("%s 不可由 %s 选择器表达时交还文本输入", (value, kind) => {
    expect(parseTemporalValue(value, kind)).toBeNull();
  });
});

describe("日期时间保存格式", () => {
  it.each([
    ["date", "", "2026-10-03"],
    ["time", "", "16:25:40"],
    ["datetime", "", "2026-10-03 16:25:40"],
    ["year", "", "2026"],
    ["datetime", "2026-09-22 14:05:09.123456", "2026-10-03 16:25:40.123456"],
    [
      "datetime",
      "2026-09-22T14:05:09.123456+08",
      "2026-10-03 16:25:40.123456+08",
    ],
    [
      "datetime",
      "2026-09-22 14:05:09.1234567 +08:00",
      "2026-10-03 16:25:40.1234567 +08:00",
    ],
    ["datetime", "2026-09-22T14:05:09Z", "2026-10-03 16:25:40Z"],
    ["time", "14:05:09.123456-03:30", "16:25:40.123456-03:30"],
    ["datetime", "infinity", "2026-10-03 16:25:40"],
  ] as const)(
    "%s 保存时保留原值 %s 的精度及偏移",
    (kind, previous, expected) => {
      const selected = parseTemporalValue("2026-10-03 16:25:40", "datetime")!;
      expect(formatTemporalValue(selected, kind, previous)).toBe(expected);
    }
  );

  it("选择器返回本地 Dayjs 时仍按显示的日期时间保存", () => {
    const selected = dayjs("2026-10-03T16:25:40");
    expect(formatTemporalValue(selected, "datetime", "")).toBe(
      "2026-10-03 16:25:40"
    );
  });

  it("带时区日期重新选择时不改变墙上时刻或原有偏移", () => {
    const previous = "2026-09-22 14:05:09.987654+08:00";
    const selected = parseTemporalValue(previous, "datetime")!.date(23);
    expect(formatTemporalValue(selected, "datetime", previous)).toBe(
      "2026-09-23 14:05:09.987654+08:00"
    );
  });
});
