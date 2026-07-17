import type { DatabaseSyncRisk, TableDiff } from "../types";

const SYNC_RISK_LABELS: Record<DatabaseSyncRisk, string> = {
  normal: "普通",
  high: "高风险",
  destructive: "删除",
};

export function eligibleSyncTableNames(
  tables: TableDiff[],
  includeDrops: boolean
): string[] {
  return tables
    .filter((table) => includeDrops || table.status !== "target_only")
    .map((table) => table.name)
    .sort((left, right) => left.localeCompare(right));
}

export function normalizeSyncSelection(
  selected: string[],
  tables: TableDiff[],
  includeDrops: boolean
): string[] {
  const eligible = new Set(eligibleSyncTableNames(tables, includeDrops));
  return [...new Set(selected)].filter((name) => eligible.has(name)).sort();
}

export function toggleSyncTable(
  selected: string[],
  tableName: string,
  checked: boolean
): string[] {
  const next = new Set(selected);
  if (checked) {
    next.add(tableName);
  } else {
    next.delete(tableName);
  }
  return [...next].sort();
}

export const selectAllSyncTables = eligibleSyncTableNames;

export function formatSyncRisk(risk: DatabaseSyncRisk): string {
  return SYNC_RISK_LABELS[risk];
}
