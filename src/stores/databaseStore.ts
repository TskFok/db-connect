import { create } from "zustand";
import type {
  AddColumnRequest,
  AlterColumnRequest,
  ColumnInfo,
  CreateTableRequest,
  DatabaseInfo,
  TableInfo,
  SqlExecuteResult,
} from "../types";
import * as api from "../services/tauriCommands";
import { useTableDataStore } from "./tableDataStore";
import {
  emptyConnState,
  type ConnectionDatabaseState,
  type OpenTabEntry,
  type OpenTableEntry,
} from "./databaseStoreState";
import {
  applyOpenTabDerivedState,
  syncCurrentView,
} from "./databaseStoreView";

// 状态形状与纯派生逻辑拆分到 ./databaseStoreState，便于维护并复用；此处重新导出以保持既有导入路径不变
export { emptyConnState };
export type { ConnectionDatabaseState, OpenTabEntry, OpenTableEntry };

interface DatabaseState {
  /** 当前激活的 connId（来自 connectionStore） */
  activeConnId: string | null;
  /** 按 connId 分桶的连接状态 */
  connectionStates: Record<string, ConnectionDatabaseState>;
  /** 当前视图的数据库列表（= connectionStates[activeConnId]?.databases） */
  databases: string[];
  /** 当前视图的表列表 */
  tables: Record<string, TableInfo[]>;
  /** 当前视图的选中数据库 */
  selectedDatabase: string | null;
  /** 当前视图的选中表 */
  selectedTable: string | null;
  /** 当前表的列结构 */
  tableStructure: ColumnInfo[] | null;
  /** 当前表信息 */
  selectedTableInfo: TableInfo | null;
  /** 树加载状态 */
  treeLoading: boolean;
  /** 表结构加载状态 */
  structureLoading: boolean;
  /** 表结构加载错误 */
  structureError: string | null;
  /** 当前视图的展开节点 key */
  expandedKeys: string[];
  /** 数据库排序方式 */
  databaseSortOrder: "asc" | "desc";
  /** 表排序方式 */
  tableSortOrder: "asc" | "desc";
  /** 表内容区当前激活的 tab */
  tableContentActiveTab: string;
  /** 打开的多个表（tab 列表） */
  openTables: OpenTableEntry[];
  /** 当前激活的表 tab 索引 */
  activeTableTabIndex: number;
  /** 打开的标签页（表 + SQL） */
  openTabs: OpenTabEntry[];
  /** 当前激活的 tab 索引 */
  activeTabIndex: number;
  /** SQL 标签页内容 */
  sqlTabContents: Record<string, string>;
  sqlTabResults: Record<string, { result: SqlExecuteResult | null; error: string | null; executedSqlList: string[] }>;
  sqlTabExecuteNonce: Record<string, number>;
  showDatabaseOverviewWhenSqlActive: boolean;
  /** 按 database|table 缓存的表信息（用于 Tab 图标等） */
  tableInfos: Record<string, TableInfo>;
  /** 当前编辑的数据库信息 */
  databaseInfo: DatabaseInfo | null;
  /** 数据库信息加载状态 */
  databaseInfoLoading: boolean;

  // Actions
  loadDatabases: (connId: string, defaultDatabase?: string | null) => Promise<void>;
  loadTables: (connId: string, database: string) => Promise<void>;
  selectDatabase: (connId: string, database: string) => Promise<void>;
  selectTable: (connId: string, database: string, table: string) => Promise<void>;
  /** 打开表或切换到已打开的表（不关闭之前的表） */
  openOrSwitchToTable: (connId: string, database: string, table: string) => Promise<void>;
  /** 切换到指定索引的表 tab */
  switchTableTab: (connId: string, index: number) => void;
  /** 关闭指定索引的表 tab */
  closeTableTab: (connId: string, index: number) => void;
  /** 打开新的 SQL 标签页，可选传入初始 SQL 内容 */
  openSqlTab: (connId: string, initialContent?: string) => void;
  /** 切换到指定索引的 tab（表或 SQL） */
  switchTab: (connId: string, index: number) => void;
  /** 关闭指定索引的 tab */
  closeTab: (connId: string, index: number) => void;
  /** 更新 SQL 标签页内容 */
  setSqlTabContent: (connId: string, tabId: string, content: string) => void;
  /** 更新 SQL 标签页执行结果 */
  setSqlTabResult: (connId: string, tabId: string, result: SqlExecuteResult | null, error: string | null, executedSqlList: string[]) => void;
  /** 请求指定 SQL 标签页在当前连接下一次执行编辑器内容（编辑器内防抖监听） */
  requestSqlTabExecute: (connId: string, tabId: string) => void;
  loadDatabaseInfo: (connId: string, database: string) => Promise<void>;
  createDatabase: (
    connId: string,
    name: string,
    characterSet: string,
    collation: string
  ) => Promise<void>;
  editDatabase: (
    connId: string,
    database: string,
    characterSet: string,
    collation: string
  ) => Promise<void>;
  renameDatabase: (
    connId: string,
    oldName: string,
    newName: string,
    characterSet: string,
    collation: string
  ) => Promise<void>;
  /** 删除数据库并清理本地打开的该库表标签与缓存 */
  dropDatabase: (connId: string, database: string) => Promise<void>;
  renameTable: (
    connId: string,
    database: string,
    oldName: string,
    newName: string
  ) => Promise<void>;
  alterTableEngine: (
    connId: string,
    database: string,
    table: string,
    engine: string
  ) => Promise<void>;
  alterColumn: (
    connId: string,
    database: string,
    table: string,
    request: AlterColumnRequest
  ) => Promise<void>;
  addColumn: (
    connId: string,
    database: string,
    table: string,
    request: AddColumnRequest
  ) => Promise<void>;
  dropColumn: (
    connId: string,
    database: string,
    table: string,
    columnName: string
  ) => Promise<void>;
  createTable: (
    connId: string,
    database: string,
    request: CreateTableRequest
  ) => Promise<void>;
  dropTable: (
    connId: string,
    database: string,
    table: string
  ) => Promise<void>;
  truncateTable: (
    connId: string,
    database: string,
    table: string
  ) => Promise<void>;
  refresh: (connId: string) => Promise<void>;
  setExpandedKeys: (keys: string[]) => void;
  setDatabaseSortOrder: (order: "asc" | "desc") => void;
  setTableSortOrder: (order: "asc" | "desc") => void;
  setTableContentActiveTab: (tab: string) => void;
  /** 切换到指定连接，恢复其缓存状态 */
  switchToConnection: (connId: string) => void;
  /** 移除连接的缓存状态（断开时调用） */
  removeConnectionState: (connId: string) => void;
  reset: () => void;
}

export const useDatabaseStore = create<DatabaseState>((set, get) => ({
  activeConnId: null,
  connectionStates: {},
  databases: [],
  tables: {},
  selectedDatabase: null,
  selectedTable: null,
  tableStructure: null,
  selectedTableInfo: null,
  treeLoading: false,
  structureLoading: false,
  structureError: null,
  expandedKeys: [],
  databaseSortOrder: "asc",
  tableSortOrder: "asc",
  tableContentActiveTab: "data",
  openTables: [],
  activeTableTabIndex: 0,
  openTabs: [],
  activeTabIndex: 0,
  sqlTabContents: {},
  sqlTabResults: {},
  sqlTabExecuteNonce: {},
  showDatabaseOverviewWhenSqlActive: false,
  tableInfos: {},
  databaseInfo: null,
  databaseInfoLoading: false,

  loadDatabases: async (connId: string, defaultDatabase?: string | null) => {
    try {
      set({ treeLoading: true });
      const databases = await api.listDatabases(connId);

      set((s) => {
        const state = s.connectionStates[connId] ?? emptyConnState();
        const updated = { ...state, databases };
        const newStates = { ...s.connectionStates, [connId]: updated };
        const res: Partial<DatabaseState> = {
          connectionStates: newStates,
          treeLoading: false,
        };
        if (s.activeConnId === connId) {
          Object.assign(res, syncCurrentView(updated));
        }
        return res;
      });

      if (defaultDatabase && databases.includes(defaultDatabase)) {
        await get().selectDatabase(connId, defaultDatabase);
      }
    } catch (e) {
      console.error("加载数据库列表失败:", e);
      set({ treeLoading: false });
    }
  },

  loadTables: async (connId: string, database: string) => {
    try {
      set({ treeLoading: true });
      const tableList = await api.listTables(connId, database);

      set((s) => {
        const state = s.connectionStates[connId] ?? emptyConnState();
        const updated = {
          ...state,
          tables: { ...state.tables, [database]: tableList },
        };
        const newStates = { ...s.connectionStates, [connId]: updated };
        const res: Partial<DatabaseState> = {
          connectionStates: newStates,
          treeLoading: false,
        };
        if (s.activeConnId === connId) {
          Object.assign(res, syncCurrentView(updated));
        }
        return res;
      });
    } catch (e) {
      console.error("加载表列表失败:", e);
      set({ treeLoading: false });
    }
  },

  selectDatabase: async (connId: string, database: string) => {
    try {
      const { connectionStates, activeConnId } = get();
      const state = connectionStates[connId] ?? emptyConnState();

      // 仅更新树上的选中数据库与展开状态，不关闭已打开的表标签页
      // 点击数据库时标记需展示表列表（当当前在 SQL 标签页时）
      const updated: ConnectionDatabaseState = {
        ...state,
        selectedDatabase: database,
        selectedTable: null,
        tableStructure: null,
        selectedTableInfo: null,
        showDatabaseOverviewWhenSqlActive: true,
        expandedKeys: state.expandedKeys.includes(`db:${database}`)
          ? state.expandedKeys
          : [...state.expandedKeys, `db:${database}`],
      };

      if (!state.tables[database]) {
        set({ treeLoading: true });
        const tableList = await api.listTables(connId, database);
        updated.tables = { ...updated.tables, [database]: tableList };
      }

      const newStates = { ...connectionStates, [connId]: updated };
      const res: Partial<DatabaseState> = {
        connectionStates: newStates,
        treeLoading: false,
      };
      if (activeConnId === connId) {
        Object.assign(res, syncCurrentView(updated));
        // 点击数据库时强制用树选中项驱动右侧视图，显示该库的表列表（不因 openTables 被覆盖）
        res.selectedDatabase = database;
        res.selectedTable = null;
        res.tableStructure = null;
        res.selectedTableInfo = null;
        res.showDatabaseOverviewWhenSqlActive = true;
      }
      set(res);
    } catch (e) {
      console.error("选中数据库失败:", e);
      set({ treeLoading: false });
    }
  },

  selectTable: async (connId: string, database: string, table: string) => {
    await get().openOrSwitchToTable(connId, database, table);
  },

  openOrSwitchToTable: async (connId: string, database: string, table: string) => {
    try {
      const { connectionStates, activeConnId } = get();
      const state = connectionStates[connId] ?? emptyConnState();
      const key = `${database}|${table}`;
      const openTabs = state.openTabs ?? [];

      const existingIdx = openTabs.findIndex(
        (e) => e.type === "table" && e.database === database && e.table === table
      );

      if (existingIdx >= 0) {
        const updated: ConnectionDatabaseState = {
          ...state,
          activeTabIndex: existingIdx,
        };
        const derived = applyOpenTabDerivedState(updated);
        const newStates = { ...connectionStates, [connId]: updated };
        const res: Partial<DatabaseState> = {
          connectionStates: newStates,
          openTabs: updated.openTabs,
          activeTabIndex: updated.activeTabIndex,
          openTables: derived.openTables ?? [],
          activeTableTabIndex: derived.activeTableTabIndex ?? 0,
          selectedDatabase: updated.selectedDatabase,
          selectedTable: updated.selectedTable,
          tableStructure: updated.tableStructure,
          selectedTableInfo: updated.selectedTableInfo,
        };
        if (activeConnId === connId) {
          Object.assign(res, syncCurrentView(updated));
        }
        set(res);
        return;
      }

      set({ structureLoading: true, structureError: null });

      const tableInfo = state.tables[database]?.find((t) => t.name === table) ?? null;
      const structure = await api.getTableStructure(connId, database, table);

      const newEntry: OpenTabEntry = { type: "table", database, table };
      const newOpenTabs = [...(state.openTabs ?? []), newEntry];
      const newIdx = newOpenTabs.length - 1;
      const newTableStructures = { ...(state.tableStructures ?? {}), [key]: structure };
      const newTableInfos = { ...(state.tableInfos ?? {}), [key]: tableInfo ?? { name: table, table_type: "TABLE", engine: null, rows: null, data_length: null, index_length: null, comment: "" } };
      const derivedOpenTables = newOpenTabs.filter((t): t is { type: "table"; database: string; table: string } => t.type === "table").map((t) => ({ database: t.database, table: t.table }));

      const updated: ConnectionDatabaseState = {
        ...state,
        openTabs: newOpenTabs,
        activeTabIndex: newIdx,
        openTables: derivedOpenTables,
        activeTableTabIndex: derivedOpenTables.length - 1,
        tableStructures: newTableStructures,
        tableInfos: newTableInfos,
        selectedDatabase: database,
        selectedTable: table,
        tableStructure: structure,
        selectedTableInfo: tableInfo,
      };
      const derived = applyOpenTabDerivedState(updated);

      const newStates = { ...connectionStates, [connId]: updated };
      const res: Partial<DatabaseState> = {
        connectionStates: newStates,
        structureLoading: false,
        openTabs: newOpenTabs,
        activeTabIndex: newIdx,
        openTables: derived.openTables ?? updated.openTables,
        activeTableTabIndex: derived.activeTableTabIndex ?? newIdx,
      };
      if (activeConnId === connId) {
        Object.assign(res, syncCurrentView(updated));
      }
      set(res);
    } catch (e) {
      const msg = String(e);
      console.error("加载表结构失败:", msg);
      const { connectionStates, activeConnId } = get();
      const state = connectionStates[connId] ?? emptyConnState();
      const tableInfo = state.tables[database]?.find((t) => t.name === table) ?? null;
      const key = `${database}|${table}`;
      const newEntry: OpenTabEntry = { type: "table", database, table };
      const newOpenTabs = [...(state.openTabs ?? []), newEntry];
      const newIdx = newOpenTabs.length - 1;
      const newTableInfos = { ...state.tableInfos, [key]: tableInfo ?? { name: table, table_type: "TABLE", engine: null, rows: null, data_length: null, index_length: null, comment: "" } };
      const derivedOpenTables = newOpenTabs.filter((t): t is { type: "table"; database: string; table: string } => t.type === "table").map((t) => ({ database: t.database, table: t.table }));
      const updated: ConnectionDatabaseState = {
        ...state,
        openTabs: newOpenTabs,
        activeTabIndex: newIdx,
        openTables: derivedOpenTables,
        activeTableTabIndex: derivedOpenTables.length - 1,
        tableInfos: newTableInfos,
        selectedDatabase: database,
        selectedTable: table,
        tableStructure: null,
        selectedTableInfo: tableInfo,
      };
      const newStates = { ...connectionStates, [connId]: updated };
      const res: Partial<DatabaseState> = {
        connectionStates: newStates,
        structureLoading: false,
        structureError: msg,
        openTabs: newOpenTabs,
        activeTabIndex: newIdx,
      };
      if (activeConnId === connId) {
        Object.assign(res, syncCurrentView(updated));
      }
      set(res);
    }
  },

  openSqlTab: (connId: string, initialContent?: string) => {
    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const tabId = `sql-${Date.now()}`;
    const newEntry: OpenTabEntry = { type: "sql", id: tabId };
    const newOpenTabs = [...(state.openTabs ?? []), newEntry];
    const newIdx = newOpenTabs.length - 1;
    const newSqlTabContents = { ...(state.sqlTabContents ?? {}), [tabId]: initialContent ?? "" };
    const updated: ConnectionDatabaseState = {
      ...state,
      openTabs: newOpenTabs,
      activeTabIndex: newIdx,
      sqlTabContents: newSqlTabContents,
      showDatabaseOverviewWhenSqlActive: false,
    };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = {
      connectionStates: newStates,
      openTabs: newOpenTabs,
      activeTabIndex: newIdx,
      sqlTabContents: newSqlTabContents,
      showDatabaseOverviewWhenSqlActive: false,
    };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  setSqlTabContent: (connId: string, tabId: string, content: string) => {
    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const newSqlTabContents = { ...(state.sqlTabContents ?? {}), [tabId]: content };
    const updated: ConnectionDatabaseState = { ...state, sqlTabContents: newSqlTabContents };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = { connectionStates: newStates, sqlTabContents: newSqlTabContents };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  setSqlTabResult: (connId: string, tabId: string, result: SqlExecuteResult | null, error: string | null, executedSqlList: string[]) => {
    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const newSqlTabResults = { ...(state.sqlTabResults ?? {}), [tabId]: { result, error, executedSqlList } };
    const updated: ConnectionDatabaseState = { ...state, sqlTabResults: newSqlTabResults };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = { connectionStates: newStates, sqlTabResults: newSqlTabResults };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  requestSqlTabExecute: (connId: string, tabId: string) => {
    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId];
    const openTabs = state?.openTabs ?? [];
    if (!state || !tabId || !openTabs.some((t) => t.type === "sql" && t.id === tabId)) {
      return;
    }
    const prev = state.sqlTabExecuteNonce ?? {};
    const newSqlTabExecuteNonce = { ...prev, [tabId]: (prev[tabId] ?? 0) + 1 };
    const updated: ConnectionDatabaseState = { ...state, sqlTabExecuteNonce: newSqlTabExecuteNonce };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = {
      connectionStates: newStates,
      sqlTabExecuteNonce: newSqlTabExecuteNonce,
    };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  switchTableTab: (connId: string, index: number) => {
    get().switchTab(connId, index);
  },

  switchTab: (connId: string, index: number) => {
    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId];
    const openTabs = state?.openTabs ?? [];
    if (!state || index < 0 || index >= openTabs.length) return;

    const newTab = openTabs[index];
    const updated: ConnectionDatabaseState = {
      ...state,
      activeTabIndex: index,
      // 切换到 SQL 标签时清除「展示表列表」标记，恢复显示 SQL 编辑器
      showDatabaseOverviewWhenSqlActive: newTab?.type === "sql" ? false : state.showDatabaseOverviewWhenSqlActive,
    };
    const derived = applyOpenTabDerivedState(updated);
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = {
      connectionStates: newStates,
      activeTabIndex: index,
      openTables: derived.openTables ?? state.openTables,
      activeTableTabIndex: derived.activeTableTabIndex ?? state.activeTableTabIndex,
      selectedDatabase: updated.selectedDatabase,
      selectedTable: updated.selectedTable,
      tableStructure: updated.tableStructure,
      selectedTableInfo: updated.selectedTableInfo,
    };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  closeTableTab: (connId: string, index: number) => {
    get().closeTab(connId, index);
  },

  closeTab: (connId: string, index: number) => {
    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId];
    const openTabs = state?.openTabs ?? [];
    if (!state || index < 0 || index >= openTabs.length) return;

    const closedEntry = openTabs[index];
    const newOpenTabs = openTabs.filter((_, i) => i !== index);

    let updated: ConnectionDatabaseState = { ...state, openTabs: newOpenTabs };
    if (closedEntry.type === "table") {
      const closedKey = `${closedEntry.database}|${closedEntry.table}`;
      const newTableStructures = { ...(state.tableStructures ?? {}) };
      const newTableInfos = { ...(state.tableInfos ?? {}) };
      delete newTableStructures[closedKey];
      delete newTableInfos[closedKey];
      updated = { ...updated, tableStructures: newTableStructures, tableInfos: newTableInfos };
    } else {
      const newSqlTabContents = { ...(state.sqlTabContents ?? {}) };
      const newSqlTabResults = { ...(state.sqlTabResults ?? {}) };
      const newSqlTabExecuteNonce = { ...(state.sqlTabExecuteNonce ?? {}) };
      delete newSqlTabContents[closedEntry.id];
      delete newSqlTabResults[closedEntry.id];
      delete newSqlTabExecuteNonce[closedEntry.id];
      updated = {
        ...updated,
        sqlTabContents: newSqlTabContents,
        sqlTabResults: newSqlTabResults,
        sqlTabExecuteNonce: newSqlTabExecuteNonce,
      };
    }

    const currentIdx = state.activeTabIndex ?? 0;
    let newIdx = currentIdx;
    if (newOpenTabs.length === 0) {
      newIdx = 0;
    } else if (index < currentIdx) {
      newIdx = currentIdx - 1;
    } else if (index === currentIdx) {
      newIdx = Math.min(currentIdx, newOpenTabs.length - 1);
    }
    updated.activeTabIndex = newIdx;

    const nextEntry = newOpenTabs[newIdx];
    if (nextEntry?.type === "table") {
      const key = `${nextEntry.database}|${nextEntry.table}`;
      updated.selectedDatabase = nextEntry.database;
      updated.selectedTable = nextEntry.table;
      updated.tableStructure = updated.tableStructures?.[key] ?? null;
      updated.selectedTableInfo = updated.tableInfos?.[key] ?? null;
    } else {
      updated.selectedDatabase = null;
      updated.selectedTable = null;
      updated.tableStructure = null;
      updated.selectedTableInfo = null;
    }

    const derived = applyOpenTabDerivedState(updated);
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = {
      connectionStates: newStates,
      openTabs: newOpenTabs,
      activeTabIndex: newIdx,
      openTables: derived.openTables ?? newOpenTabs.filter((t) => t.type === "table").map((t) => ({ database: t.database, table: t.table })),
      activeTableTabIndex: derived.activeTableTabIndex ?? 0,
      selectedDatabase: updated.selectedDatabase,
      selectedTable: updated.selectedTable,
      tableStructure: updated.tableStructure,
      selectedTableInfo: updated.selectedTableInfo,
      sqlTabContents: updated.sqlTabContents,
      sqlTabResults: updated.sqlTabResults,
      sqlTabExecuteNonce: updated.sqlTabExecuteNonce,
    };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  renameTable: async (
    connId: string,
    database: string,
    oldName: string,
    newName: string
  ) => {
    await api.renameTable(connId, database, oldName, newName);
    const tableList = await api.listTables(connId, database);
    const structure = await api.getTableStructure(connId, database, newName);
    const tableInfo = tableList.find((t) => t.name === newName) ?? null;

    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const oldKey = `${database}|${oldName}`;
    const newKey = `${database}|${newName}`;

    const newTableStructures = { ...(state.tableStructures ?? {}) };
    const newTableInfos = { ...(state.tableInfos ?? {}) };
    if (newTableStructures[oldKey]) {
      delete newTableStructures[oldKey];
    }
    if (newTableInfos[oldKey]) {
      delete newTableInfos[oldKey];
    }
    newTableStructures[newKey] = structure;
    newTableInfos[newKey] = tableInfo ?? { name: newName, table_type: "TABLE", engine: null, rows: null, data_length: null, index_length: null, comment: "" };

    const openTabs = state.openTabs ?? [];
    const newOpenTabs = openTabs.map((e) =>
      e.type === "table" && e.database === database && e.table === oldName
        ? { type: "table" as const, database, table: newName }
        : e
    );
    const newOpenTables = newOpenTabs.filter((t): t is { type: "table"; database: string; table: string } => t.type === "table").map((t) => ({ database: t.database, table: t.table }));

    const updated: ConnectionDatabaseState = {
      ...state,
      tables: { ...state.tables, [database]: tableList },
      openTabs: newOpenTabs,
      openTables: newOpenTables,
      tableStructures: newTableStructures,
      tableInfos: newTableInfos,
      selectedTable: state.selectedTable === oldName ? newName : state.selectedTable,
      tableStructure: state.selectedTable === oldName ? structure : state.tableStructure,
      selectedTableInfo: state.selectedTable === oldName ? tableInfo : state.selectedTableInfo,
    };
    applyOpenTabDerivedState(updated);
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = { connectionStates: newStates };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  alterTableEngine: async (
    connId: string,
    database: string,
    table: string,
    engine: string
  ) => {
    await api.alterTableEngine(connId, database, table, engine);
    const tableList = await api.listTables(connId, database);
    const tableInfo = tableList.find((t) => t.name === table) ?? null;

    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const updated: ConnectionDatabaseState = {
      ...state,
      tables: { ...state.tables, [database]: tableList },
      selectedTableInfo: tableInfo,
    };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = { connectionStates: newStates };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  alterColumn: async (
    connId: string,
    database: string,
    table: string,
    request: AlterColumnRequest
  ) => {
    await api.alterColumn(connId, database, table, request);
    const structure = await api.getTableStructure(connId, database, table);

    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const key = `${database}|${table}`;
    const newTableStructures = { ...(state.tableStructures ?? {}), [key]: structure };
    const updated: ConnectionDatabaseState = {
      ...state,
      tableStructures: newTableStructures,
      tableStructure: structure,
    };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = { connectionStates: newStates };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  addColumn: async (
    connId: string,
    database: string,
    table: string,
    request: AddColumnRequest
  ) => {
    await api.addColumn(connId, database, table, request);
    const structure = await api.getTableStructure(connId, database, table);

    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const key = `${database}|${table}`;
    const newTableStructures = { ...(state.tableStructures ?? {}), [key]: structure };
    const updated: ConnectionDatabaseState = {
      ...state,
      tableStructures: newTableStructures,
      tableStructure: structure,
    };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = { connectionStates: newStates };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  dropColumn: async (
    connId: string,
    database: string,
    table: string,
    columnName: string
  ) => {
    await api.dropColumn(connId, database, table, columnName);
    const structure = await api.getTableStructure(connId, database, table);

    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const key = `${database}|${table}`;
    const newTableStructures = { ...(state.tableStructures ?? {}), [key]: structure };
    const updated: ConnectionDatabaseState = {
      ...state,
      tableStructures: newTableStructures,
      tableStructure: structure,
    };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = { connectionStates: newStates };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  createTable: async (
    connId: string,
    database: string,
    request: CreateTableRequest
  ) => {
    await api.createTable(connId, database, request);
    const tableList = await api.listTables(connId, database);

    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const updated: ConnectionDatabaseState = {
      ...state,
      tables: { ...state.tables, [database]: tableList },
    };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = { connectionStates: newStates };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  dropTable: async (connId: string, database: string, table: string) => {
    await api.dropTable(connId, database, table);

    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const droppedKey = `${database}|${table}`;
    const openTabs = state.openTabs ?? [];

    const newOpenTabs = openTabs.filter(
      (e) => !(e.type === "table" && e.database === database && e.table === table)
    );
    const newOpenTables = newOpenTabs.filter((t): t is { type: "table"; database: string; table: string } => t.type === "table").map((t) => ({ database: t.database, table: t.table }));
    const wasActive = state.selectedDatabase === database && state.selectedTable === table;
    const currentIdx = state.activeTabIndex ?? 0;
    let newIdx = currentIdx;
    const droppedIdx = openTabs.findIndex(
      (e) => e.type === "table" && e.database === database && e.table === table
    );
    if (droppedIdx >= 0) {
      if (droppedIdx < currentIdx) {
        newIdx = currentIdx - 1;
      } else if (droppedIdx === currentIdx) {
        newIdx = newOpenTabs.length > 0 ? Math.min(currentIdx, newOpenTabs.length - 1) : 0;
      }
    }

    const newTableStructures = { ...(state.tableStructures ?? {}) };
    const newTableInfos = { ...(state.tableInfos ?? {}) };
    delete newTableStructures[droppedKey];
    delete newTableInfos[droppedKey];

    const tableList = await api.listTables(connId, database);
    const nextEntry = newOpenTabs[newIdx];
    const updated: ConnectionDatabaseState = {
      ...state,
      tables: { ...state.tables, [database]: tableList },
      openTabs: newOpenTabs,
      openTables: newOpenTables,
      activeTabIndex: newIdx,
      activeTableTabIndex: newOpenTabs.slice(0, newIdx).filter((t) => t.type === "table").length,
      tableStructures: newTableStructures,
      tableInfos: newTableInfos,
      selectedDatabase: nextEntry?.type === "table" ? nextEntry.database : (wasActive ? null : state.selectedDatabase),
      selectedTable: nextEntry?.type === "table" ? nextEntry.table : (wasActive ? null : state.selectedTable),
      tableStructure: nextEntry?.type === "table" ? (newTableStructures[`${nextEntry.database}|${nextEntry.table}`] ?? null) : (wasActive ? null : state.tableStructure),
      selectedTableInfo: nextEntry?.type === "table" ? (newTableInfos[`${nextEntry.database}|${nextEntry.table}`] ?? null) : (wasActive ? null : state.selectedTableInfo),
    };

    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = {
      connectionStates: newStates,
      openTabs: newOpenTabs,
      openTables: newOpenTables,
      activeTabIndex: newIdx,
    };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  truncateTable: async (connId: string, database: string, table: string) => {
    await api.truncateTable(connId, database, table);
    const tableList = await api.listTables(connId, database);

    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const key = `${database}|${table}`;
    const info = tableList.find((t) => t.name === table) ?? null;
    const updated: ConnectionDatabaseState = {
      ...state,
      tables: { ...state.tables, [database]: tableList },
      tableInfos: info
        ? { ...(state.tableInfos ?? {}), [key]: info }
        : { ...(state.tableInfos ?? {}) },
      selectedTableInfo:
        state.selectedDatabase === database && state.selectedTable === table
          ? (info ?? state.selectedTableInfo)
          : state.selectedTableInfo,
    };

    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = { connectionStates: newStates };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
    useTableDataStore.getState().afterTableDataCleared(connId, database, table);
  },

  refresh: async (connId: string) => {
    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const { selectedDatabase, selectedTable } = state;
    const openTabs = state.openTabs ?? [];
    const tableEntries = openTabs.filter((t): t is { type: "table"; database: string; table: string } => t.type === "table");

    set({ treeLoading: true });
    try {
      const databases = await api.listDatabases(connId);
      let tables = state.tables;
      let tableStructure = state.tableStructure;
      let selectedTableInfo = state.selectedTableInfo;
      let tableStructures = { ...(state.tableStructures ?? {}) };
      let tableInfos = { ...(state.tableInfos ?? {}) };

      for (const { database } of tableEntries) {
        if (tables[database] === undefined) continue;
        const tableList = await api.listTables(connId, database);
        tables = { ...tables, [database]: tableList };
      }

      if (selectedDatabase) {
        const tableList = tables[selectedDatabase] ?? await api.listTables(connId, selectedDatabase);
        tables = { ...tables, [selectedDatabase]: tableList };
        if (selectedTable) {
          set({ structureLoading: true, structureError: null });
          tableStructure = await api.getTableStructure(
            connId,
            selectedDatabase,
            selectedTable
          );
          selectedTableInfo =
            tableList.find((t) => t.name === selectedTable) ?? null;
          const key = `${selectedDatabase}|${selectedTable}`;
          tableStructures = { ...tableStructures, [key]: tableStructure };
          tableInfos = { ...tableInfos, [key]: selectedTableInfo ?? tableInfos[key]! };
        }
      }

      const updated: ConnectionDatabaseState = {
        ...state,
        databases,
        tables,
        tableStructure: tableStructure ?? null,
        selectedTableInfo,
        tableStructures,
        tableInfos,
      };
      const newStates = { ...connectionStates, [connId]: updated };
      const res: Partial<DatabaseState> = {
        connectionStates: newStates,
        treeLoading: false,
        structureLoading: false,
      };
      if (activeConnId === connId) {
        Object.assign(res, syncCurrentView(updated));
      }
      set(res);
    } catch (e) {
      console.error("刷新失败:", e);
      set({ treeLoading: false, structureLoading: false });
    }
  },

  loadDatabaseInfo: async (connId: string, database: string) => {
    try {
      set({ databaseInfoLoading: true, databaseInfo: null });
      const info = await api.getDatabaseInfo(connId, database);

      const { connectionStates, activeConnId } = get();
      const state = connectionStates[connId] ?? emptyConnState();
      const updated: ConnectionDatabaseState = {
        ...state,
        databaseInfo: info,
      };
      const newStates = { ...connectionStates, [connId]: updated };
      const res: Partial<DatabaseState> = {
        connectionStates: newStates,
        databaseInfoLoading: false,
      };
      if (activeConnId === connId) {
        res.databaseInfo = info;
      }
      set(res);
    } catch (e) {
      console.error("加载数据库信息失败:", e);
      set({ databaseInfoLoading: false });
    }
  },

  createDatabase: async (
    connId: string,
    name: string,
    characterSet: string,
    collation: string
  ) => {
    await api.createDatabase(connId, name, characterSet, collation);
    const databases = await api.listDatabases(connId);

    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const updated: ConnectionDatabaseState = {
      ...state,
      databases,
    };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = { connectionStates: newStates };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  dropDatabase: async (connId: string, database: string) => {
    await api.dropDatabase(connId, database);
    const databases = await api.listDatabases(connId);

    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const openTabs = state.openTabs ?? [];

    const newOpenTabs = openTabs.filter(
      (e) => !(e.type === "table" && e.database === database)
    );
    const newOpenTables = newOpenTabs
      .filter((t): t is { type: "table"; database: string; table: string } => t.type === "table")
      .map((t) => ({ database: t.database, table: t.table }));

    const oldIdx = state.activeTabIndex ?? 0;
    let removedBefore = 0;
    let activeRemoved = false;
    for (let i = 0; i < openTabs.length; i++) {
      const e = openTabs[i];
      const rm = e.type === "table" && e.database === database;
      if (rm) {
        if (i < oldIdx) removedBefore += 1;
        if (i === oldIdx) activeRemoved = true;
      }
    }
    let newIdx = oldIdx - removedBefore;
    if (activeRemoved && newOpenTabs.length > 0) {
      newIdx = Math.min(newIdx, newOpenTabs.length - 1);
    }
    newIdx = Math.max(0, Math.min(newIdx, Math.max(0, newOpenTabs.length - 1)));

    const prefix = `${database}|`;
    const newTableStructures = { ...(state.tableStructures ?? {}) };
    const newTableInfos = { ...(state.tableInfos ?? {}) };
    for (const k of Object.keys(newTableStructures)) {
      if (k.startsWith(prefix)) {
        delete newTableStructures[k];
      }
    }
    for (const k of Object.keys(newTableInfos)) {
      if (k.startsWith(prefix)) {
        delete newTableInfos[k];
      }
    }

    const newTables = { ...state.tables };
    delete newTables[database];

    const newExpandedKeys = state.expandedKeys.filter((k) => k !== `db:${database}`);

    const nextEntry = newOpenTabs[newIdx];
    const hadSelectionInDroppedDb = state.selectedDatabase === database;

    const updated: ConnectionDatabaseState = {
      ...state,
      databases,
      tables: newTables,
      expandedKeys: newExpandedKeys,
      openTabs: newOpenTabs,
      openTables: newOpenTables,
      activeTabIndex: newIdx,
      activeTableTabIndex: newOpenTabs
        .slice(0, newIdx)
        .filter((t) => t.type === "table").length,
      tableStructures: newTableStructures,
      tableInfos: newTableInfos,
      selectedDatabase: hadSelectionInDroppedDb
        ? nextEntry?.type === "table"
          ? nextEntry.database
          : null
        : state.selectedDatabase,
      selectedTable: hadSelectionInDroppedDb
        ? nextEntry?.type === "table"
          ? nextEntry.table
          : null
        : state.selectedTable,
      tableStructure: hadSelectionInDroppedDb
        ? nextEntry?.type === "table"
          ? newTableStructures[`${nextEntry.database}|${nextEntry.table}`] ?? null
          : null
        : state.tableStructure,
      selectedTableInfo: hadSelectionInDroppedDb
        ? nextEntry?.type === "table"
          ? newTableInfos[`${nextEntry.database}|${nextEntry.table}`] ?? null
          : null
        : state.selectedTableInfo,
      databaseInfo: hadSelectionInDroppedDb ? null : state.databaseInfo,
    };

    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = {
      connectionStates: newStates,
      openTabs: newOpenTabs,
      openTables: newOpenTables,
      activeTabIndex: newIdx,
    };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  editDatabase: async (
    connId: string,
    database: string,
    characterSet: string,
    collation: string
  ) => {
    await api.alterDatabaseCharset(
      connId,
      database,
      characterSet,
      collation
    );
  },

  renameDatabase: async (
    connId: string,
    oldName: string,
    newName: string,
    characterSet: string,
    collation: string
  ) => {
    await api.renameDatabase(
      connId,
      oldName,
      newName,
      characterSet,
      collation
    );
    const databases = await api.listDatabases(connId);

    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const newTables = { ...state.tables };
    if (newTables[oldName]) {
      newTables[newName] = newTables[oldName];
      delete newTables[oldName];
    }
    const newExpandedKeys = state.expandedKeys.map((k) =>
      k === `db:${oldName}` ? `db:${newName}` : k
    );
    const updated: ConnectionDatabaseState = {
      ...state,
      databases,
      tables: newTables,
      expandedKeys: newExpandedKeys,
      selectedDatabase: state.selectedDatabase === oldName ? newName : state.selectedDatabase,
    };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = { connectionStates: newStates };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  setExpandedKeys: (keys: string[]) => {
    const { activeConnId, connectionStates } = get();
    if (!activeConnId) return;
    const state = connectionStates[activeConnId] ?? emptyConnState();
    const updated = { ...state, expandedKeys: keys };
    const newStates = { ...connectionStates, [activeConnId]: updated };
    set({
      connectionStates: newStates,
      expandedKeys: keys,
    });
  },

  setDatabaseSortOrder: (order: "asc" | "desc") => {
    const { activeConnId, connectionStates } = get();
    if (!activeConnId) return;
    const state = connectionStates[activeConnId] ?? emptyConnState();
    const updated = { ...state, databaseSortOrder: order };
    const newStates = { ...connectionStates, [activeConnId]: updated };
    set({
      connectionStates: newStates,
      databaseSortOrder: order,
    });
  },

  setTableSortOrder: (order: "asc" | "desc") => {
    const { activeConnId, connectionStates } = get();
    if (!activeConnId) return;
    const state = connectionStates[activeConnId] ?? emptyConnState();
    const updated = { ...state, tableSortOrder: order };
    const newStates = { ...connectionStates, [activeConnId]: updated };
    set({
      connectionStates: newStates,
      tableSortOrder: order,
    });
  },

  setTableContentActiveTab: (tab: string) => {
    set({ tableContentActiveTab: tab });
  },

  switchToConnection: (connId: string) => {
    const { connectionStates } = get();
    const state = connectionStates[connId];
    set({
      activeConnId: connId,
      ...(state ? syncCurrentView(state) : {
        databases: [],
        tables: {},
        selectedDatabase: null,
        selectedTable: null,
        tableStructure: null,
        selectedTableInfo: null,
        openTables: [],
        activeTableTabIndex: 0,
        openTabs: [],
        activeTabIndex: 0,
        sqlTabContents: {},
        sqlTabResults: {},
        sqlTabExecuteNonce: {},
        showDatabaseOverviewWhenSqlActive: false,
        tableInfos: {},
        expandedKeys: [],
        databaseInfo: null,
      }),
    });
  },

  removeConnectionState: (connId: string) => {
    const { connectionStates, activeConnId } = get();
    const newStates = { ...connectionStates };
    delete newStates[connId];
    set({ connectionStates: newStates });
    if (activeConnId === connId) {
      set({
        activeConnId: null,
        databases: [],
        tables: {},
        selectedDatabase: null,
        selectedTable: null,
        tableStructure: null,
        selectedTableInfo: null,
        openTables: [],
        activeTableTabIndex: 0,
        openTabs: [],
        activeTabIndex: 0,
        sqlTabContents: {},
        sqlTabResults: {},
        sqlTabExecuteNonce: {},
        showDatabaseOverviewWhenSqlActive: false,
        tableInfos: {},
        expandedKeys: [],
        structureError: null,
        databaseInfo: null,
      });
    }
  },

  reset: () => {
    set({
      activeConnId: null,
      connectionStates: {},
      databases: [],
      tables: {},
      selectedDatabase: null,
      selectedTable: null,
      tableStructure: null,
      selectedTableInfo: null,
      openTables: [],
      activeTableTabIndex: 0,
      openTabs: [],
      activeTabIndex: 0,
      sqlTabContents: {},
      sqlTabResults: {},
      sqlTabExecuteNonce: {},
      showDatabaseOverviewWhenSqlActive: false,
      tableInfos: {},
      treeLoading: false,
      structureLoading: false,
      structureError: null,
      expandedKeys: [],
      databaseSortOrder: "asc",
      tableSortOrder: "asc",
      tableContentActiveTab: "data",
      databaseInfo: null,
      databaseInfoLoading: false,
    });
  },
}));
