import type { CreateTableColumnDef } from "../types";
import { buildColumnType } from "./columnTypeUtils";

/** 将表单列值转换为 CreateTableColumnDef */
export function formColumnToDef(
  col: Record<string, unknown>
): CreateTableColumnDef {
  const dataType = (col.data_type as string) || "varchar";
  const length = (col.length as string) || "";
  const scale = (col.scale as string) || "";
  const unsigned = (col.unsigned as boolean) || false;

  const columnType = buildColumnType(dataType, length, scale, unsigned);
  const defaultVal = (col.default_value as string)?.trim();

  return {
    name: ((col.name as string) || "").trim(),
    column_type: columnType,
    nullable: col.nullable !== false,
    default_value: defaultVal === "" || defaultVal === undefined ? null : defaultVal,
    extra: (col.extra as string) || "",
    comment: ((col.comment as string) || "").trim(),
  };
}
