import {
  deriveSelectedFromOpenTabs,
  type ConnectionDatabaseState,
} from "./databaseStoreState";

export function syncCurrentView(state: ConnectionDatabaseState) {
  const derived = deriveSelectedFromOpenTabs(state);
  return {
    databases: state.databases,
    tables: state.tables,
    selectedDatabase: derived.selectedDatabase ?? state.selectedDatabase,
    selectedTable: derived.selectedTable ?? state.selectedTable,
    tableStructure: derived.tableStructure ?? state.tableStructure,
    selectedTableInfo: derived.selectedTableInfo ?? state.selectedTableInfo,
    expandedKeys: state.expandedKeys,
    databaseSortOrder: state.databaseSortOrder,
    tableSortOrder: state.tableSortOrder,
    databaseInfo: state.databaseInfo,
    openTables: derived.openTables ?? state.openTables ?? [],
    activeTableTabIndex: derived.activeTableTabIndex ?? state.activeTableTabIndex ?? 0,
    openTabs: state.openTabs ?? [],
    activeTabIndex: derived.activeTabIndex ?? state.activeTabIndex ?? 0,
    sqlTabContents: state.sqlTabContents ?? {},
    sqlTabResults: state.sqlTabResults ?? {},
    sqlTabExecuteNonce: state.sqlTabExecuteNonce ?? {},
    showDatabaseOverviewWhenSqlActive:
      state.showDatabaseOverviewWhenSqlActive ?? false,
    tableInfos: state.tableInfos ?? {},
  };
}

export function applyOpenTabDerivedState(state: ConnectionDatabaseState) {
  const derived = deriveSelectedFromOpenTabs(state);
  Object.assign(state, derived);
  return derived;
}
