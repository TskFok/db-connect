import {
  deriveSelectedFromOpenTabs,
  type ConnectionDatabaseState,
  type ViewMode,
} from "./databaseStoreState";

export type { ViewMode };

export function syncCurrentView(state: ConnectionDatabaseState) {
  const derived = deriveSelectedFromOpenTabs(state);
  const viewMode: ViewMode = derived.viewMode ?? state.viewMode ?? "tab";
  return {
    databases: state.databases,
    tables: state.tables,
    viewMode,
    // 显式字段优先用 derived（含 null），避免 overview 下 selectedTable: null 被 ?? 回退覆盖
    selectedDatabase:
      "selectedDatabase" in derived
        ? (derived.selectedDatabase ?? null)
        : state.selectedDatabase,
    selectedTable:
      "selectedTable" in derived
        ? (derived.selectedTable ?? null)
        : state.selectedTable,
    tableStructure:
      "tableStructure" in derived
        ? (derived.tableStructure ?? null)
        : state.tableStructure,
    selectedTableInfo:
      "selectedTableInfo" in derived
        ? (derived.selectedTableInfo ?? null)
        : state.selectedTableInfo,
    expandedKeys: state.expandedKeys,
    databaseSortOrder: state.databaseSortOrder,
    tableSortOrder: state.tableSortOrder,
    databaseInfo: state.databaseInfo,
    openTables: derived.openTables ?? state.openTables ?? [],
    activeTableTabIndex:
      derived.activeTableTabIndex ?? state.activeTableTabIndex ?? 0,
    openTabs: state.openTabs ?? [],
    activeTabIndex: derived.activeTabIndex ?? state.activeTabIndex ?? 0,
    sqlTabContents: state.sqlTabContents ?? {},
    sqlTabResults: state.sqlTabResults ?? {},
    sqlTabExecuteNonce: state.sqlTabExecuteNonce ?? {},
    sqlTabExecutions: state.sqlTabExecutions ?? {},
    tableInfos: state.tableInfos ?? {},
  };
}

export function applyOpenTabDerivedState(state: ConnectionDatabaseState) {
  const derived = deriveSelectedFromOpenTabs(state);
  Object.assign(state, derived);
  return derived;
}
