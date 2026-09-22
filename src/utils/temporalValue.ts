import dayjs, { type Dayjs } from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";
import utc from "dayjs/plugin/utc";
import type { DatabaseType } from "../types";

dayjs.extend(customParseFormat);
dayjs.extend(utc);

export type TemporalKind = "date" | "time" | "datetime" | "year";

export const TEMPORAL_FORMATS: Record<TemporalKind, string> = {
  date: "YYYY-MM-DD",
  time: "HH:mm:ss",
  datetime: "YYYY-MM-DD HH:mm:ss",
  year: "YYYY",
};

export function getTemporalKind(
  columnType: string,
  databaseType: DatabaseType = "mysql"
): TemporalKind | null {
  let type = columnType.trim().toLowerCase().replace(/\s+/g, " ");
  if (databaseType === "clickhouse") {
    let wrapper = /^(?:nullable|lowcardinality)\((.*)\)$/.exec(type);
    while (wrapper) {
      type = wrapper[1].trim();
      wrapper = /^(?:nullable|lowcardinality)\((.*)\)$/.exec(type);
    }
    if (type === "date" || type === "date32") return "date";
    if (/^datetime(?:64)?(?:\([^()]*\))?$/.test(type)) return "datetime";
  }

  type = type.replace(/\s*\(\s*\d+\s*\)/g, "").trim();
  // SQL Server timestamp/rowversion 是二进制版本标记。
  if (databaseType === "sqlserver" && type === "timestamp") return null;
  if (type === "date") return "date";
  if (databaseType === "mysql" && type === "year") return "year";
  if (/^(?:time|timetz)(?: (?:with|without) time zone)?$/.test(type)) {
    return "time";
  }
  if (
    /^(?:datetime|datetime2|datetimeoffset|smalldatetime|timestamp|timestamptz)(?: (?:with|without) time zone)?$/.test(
      type
    )
  ) {
    return "datetime";
  }
  return null;
}

interface TemporalParts {
  date: string;
  clock: string;
  suffix: string;
}

/** 拆开可见的墙上时刻与小数秒/偏移，避免 Dayjs 截断微秒或转换时区。 */
function getTemporalParts(
  value: string,
  kind: TemporalKind
): TemporalParts | null {
  let date = "2000-01-01";
  let clock = value.trim();
  if (kind === "datetime") {
    const datetime = /^(\d{4}-\d{2}-\d{2})[ T](.+)$/.exec(clock);
    if (!datetime) return null;
    date = datetime[1];
    clock = datetime[2];
  }
  const time =
    /^(\d{1,2}):(\d{2}):(\d{2})(\.\d{1,9})?(\s*(?:Z|[+-]\d{2}(?::?\d{2})?))?$/.exec(
      clock
    );
  if (!time) return null;
  const offset = time[5]?.trim();
  if (offset && offset !== "Z") {
    const digits = offset.slice(1).replace(":", "");
    if (
      Number(digits.slice(0, 2)) > 23 ||
      Number(digits.slice(2) || "0") > 59
    ) {
      return null;
    }
  }
  return {
    date,
    clock: `${time[1].padStart(2, "0")}:${time[2]}:${time[3]}`,
    suffix: `${time[4] ?? ""}${time[5] ?? ""}`,
  };
}

export function parseTemporalValue(
  value: string,
  kind: TemporalKind
): Dayjs | null {
  const text = value.trim();
  let parseText = text;
  let format = TEMPORAL_FORMATS[kind];
  if (kind === "datetime" && /^\d{4}-\d{2}-\d{2}$/.test(text)) {
    // MySQL 当前会把恰好为午夜的 datetime/timestamp 返回为仅日期。
    parseText = `${text} 00:00:00`;
  } else if (kind === "datetime" || kind === "time") {
    const parts = getTemporalParts(text, kind);
    if (!parts) return null;
    parseText = `${parts.date} ${parts.clock}`;
    format = TEMPORAL_FORMATS.datetime;
  }
  // UTC 仅作为墙上时刻的容器；不把数据库时刻转换到浏览器时区。
  const parsed = dayjs.utc(parseText, format, true);
  return parsed.isValid() ? parsed : null;
}

export function formatTemporalValue(
  date: Dayjs,
  kind: TemporalKind,
  previousValue: string
): string {
  const suffix =
    kind === "datetime" || kind === "time"
      ? (getTemporalParts(previousValue, kind)?.suffix ?? "")
      : "";
  return `${date.format(TEMPORAL_FORMATS[kind])}${suffix}`;
}
