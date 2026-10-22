import type {
  DataTaskCapabilities,
  DataTaskKind,
  DataTaskMode,
  TableMapping,
  DataTaskPreview,
} from "../types/dataTasks";
export const dataTaskModeLabels: Record<DataTaskMode, string> = {
  merge: "合并（保留目标独有行）",
  mirror: "镜像（删除目标独有行）",
  append: "追加（唯一冲突时失败）",
  replace: "替换（事务内删除后写入）",
};
export function availableDataTaskModes(
  capabilities: DataTaskCapabilities | null,
  kind: DataTaskKind
): DataTaskMode[] {
  if (
    !capabilities ||
    !capabilities[kind === "row_sync" ? "row_sync" : "transfer"]
  )
    return [];
  return capabilities.supported_modes.filter((mode) =>
    kind === "row_sync"
      ? ["merge", "mirror"].includes(mode)
      : ["append", "replace"].includes(mode)
  );
}

export function defaultDataTaskMappings(
  capabilities: DataTaskCapabilities,
  selected?: string[]
): TableMapping[] {
  return capabilities.source_tables
    .filter(
      (source) =>
        (!selected?.length || selected.includes(source.table)) &&
        capabilities.target_tables.some(
          (target) => target.table === source.table
        )
    )
    .map((source) => ({
      source_table: source.table,
      target_table: source.table,
      columns: source.columns
        .filter((column) =>
          capabilities.target_tables
            .find((target) => target.table === source.table)!
            .columns.includes(column)
        )
        .map((column) => ({ source_column: column, target_column: column })),
    }));
}

export const TARGET_SCOPE_RISK = "ui:target_scope";
export const EMPTY_SOURCE_RISK = "ui:empty_source";
export function requiredPreviewConfirmations(
  preview: DataTaskPreview
): string[] {
  const risks = preview.risks.filter((r) => r.required).map((r) => r.id);
  if (["mirror", "replace"].includes(preview.mode)) {
    risks.push(TARGET_SCOPE_RISK);
    if (
      preview.tables.some(
        (table) =>
          table.counts.source_rows === "0" && table.counts.target_rows !== "0"
      )
    )
      risks.push(EMPTY_SOURCE_RISK);
  }
  return risks;
}
