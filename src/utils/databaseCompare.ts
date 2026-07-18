import type {
  ColumnChangedField,
  ColumnDiff,
  ColumnSnapshot,
  SchemaDiffStatus,
  TableDiff,
} from "../types";

export const SCHEMA_DIFF_STATUS_LABELS: Record<SchemaDiffStatus, string> = {
  source_only: "仅源端",
  target_only: "仅目标端",
  changed: "结构变化",
};

export const COLUMN_CHANGED_FIELD_LABELS: Record<ColumnChangedField, string> = {
  ordinal_position: "字段顺序",
  column_type: "字段类型",
  nullable: "允许为空",
  default_value: "默认值",
  primary_key: "主键",
  extra: "额外属性",
  comment: "注释",
};

const ALL_COLUMN_FIELDS: ColumnChangedField[] = [
  "ordinal_position",
  "column_type",
  "nullable",
  "default_value",
  "primary_key",
  "extra",
  "comment",
];

export function formatSchemaDiffStatus(status: SchemaDiffStatus): string {
  return SCHEMA_DIFF_STATUS_LABELS[status];
}

export function filterTableDiffs(
  tables: TableDiff[],
  status: "all" | SchemaDiffStatus,
  search: string
): TableDiff[] {
  const filteredByStatus =
    status === "all"
      ? tables
      : tables.filter((table) => table.status === status);
  const normalizedSearch = search.toLocaleLowerCase();
  return filteredByStatus.filter((table) =>
    table.name.toLocaleLowerCase().includes(normalizedSearch)
  );
}

export function formatChangedFields(fields: ColumnChangedField[]): string {
  return fields.map((field) => COLUMN_CHANGED_FIELD_LABELS[field]).join("、");
}

function formatSnapshotValue(
  snapshot: ColumnSnapshot,
  field: ColumnChangedField
): string {
  const value = snapshot[field];
  if (field === "default_value" && value === null) return "NULL";
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

export function formatColumnSideValues(
  column: ColumnDiff,
  side: "source" | "target"
): string {
  const snapshot = column[side];
  if (snapshot === null) return "";

  const fields =
    column.status === "changed" ? column.changed_fields : ALL_COLUMN_FIELDS;
  return fields
    .map(
      (field) =>
        `${COLUMN_CHANGED_FIELD_LABELS[field]}=${formatSnapshotValue(snapshot, field)}`
    )
    .join("；");
}
