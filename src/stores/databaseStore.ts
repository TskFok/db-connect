import { create } from "zustand";
import {
  estimateResultBytes,
  resultCacheController,
} from "../utils/resultCacheBudget";
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
  type SqlStatementResult,
  type TableSearchState,
  type ViewMode,
} from "./databaseStoreState";
import { applyOpenTabDerivedState, syncCurrentView } from "./databaseStoreView";
import {
  getMetadataRequestGeneration,
  getSqlCompletionConnectionRevision,
  invalidateMetadataRequestScope,
  invalidateSqlCompletion,
} from "../utils/sqlCompletionInvalidation";

// 状态形状与纯派生逻辑拆分到 ./databaseStoreState，便于维护并复用；此处重新导出以保持既有导入路径不变
export { emptyConnState };
export type {
  ConnectionDatabaseState,
  OpenTabEntry,
  OpenTableEntry,
  SqlStatementResult,
  ViewMode,
};

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
  sqlTabResults: ConnectionDatabaseState["sqlTabResults"];
  sqlTabExecuteNonce: Record<string, number>;
  /** SQL 标签页运行中的执行状态：id -> { executionId }（存在即执行中，切换标签不丢失） */
  sqlTabExecutions: Record<string, { executionId: string | null }>;
  /** 右侧内容区视图模式：overview=数据库概览，tab=激活标签内容 */
  viewMode: ViewMode;
  /** 按 database|table 缓存的表信息（用于 Tab 图标等） */
  tableInfos: Record<string, TableInfo>;
  /** 当前编辑的数据库信息 */
  databaseInfo: DatabaseInfo | null;
  /** 数据库信息加载状态 */
  databaseInfoLoading: boolean;

  // Actions
  loadDatabases: (
    connId: string,
    defaultDatabase?: string | null
  ) => Promise<void>;
  loadTables: (connId: string, database: string) => Promise<void>;
  selectDatabase: (connId: string, database: string) => Promise<void>;
  selectTable: (
    connId: string,
    database: string,
    table: string
  ) => Promise<void>;
  /** 打开表或切换到已打开的表（不关闭之前的表） */
  openOrSwitchToTable: (
    connId: string,
    database: string,
    table: string
  ) => Promise<void>;
  /** 仅建立并激活表标签；元数据由内容区在激活后按需加载。 */
  openTableTabs: (connId: string, entries: OpenTableEntry[]) => void;
  ensureTableMetadata: (
    connId: string,
    database: string,
    table: string
  ) => Promise<void>;
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
  setSqlTabResult: (
    connId: string,
    tabId: string,
    result: SqlExecuteResult | null,
    error: string | null,
    executedSqlList: string[],
    statementResults?: SqlStatementResult[]
  ) => void;
  /** 切换指定 SQL 标签页当前展示的语句结果。 */
  setSqlTabActiveResult: (connId: string, tabId: string, index: number) => void;
  /** 请求指定 SQL 标签页在当前连接下一次执行编辑器内容（编辑器内防抖监听） */
  requestSqlTabExecute: (connId: string, tabId: string) => void;
  /** 原子消费仍待执行的请求，避免新挂载漏执行或重新挂载重复执行。 */
  consumeSqlTabExecute: (
    connId: string,
    tabId: string,
    nonce: number
  ) => { database: string | null } | null;
  /**
   * 标记 SQL 标签页的运行中执行状态。
   * execution 非空表示执行中（executionId 供取消查询使用）；传 null 表示执行结束。
   */
  setSqlTabExecution: (
    connId: string,
    tabId: string,
    execution: { executionId: string | null } | null
  ) => void;
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
  dropTable: (connId: string, database: string, table: string) => Promise<void>;
  truncateTable: (
    connId: string,
    database: string,
    table: string
  ) => Promise<void>;
  refresh: (connId: string) => Promise<void>;
  setExpandedKeys: (keys: string[]) => void;
  setDatabaseSortOrder: (order: "asc" | "desc") => void;
  setTableSortOrder: (order: "asc" | "desc") => void;
  setTableSearch: (
    connId: string,
    database: string,
    search: Partial<TableSearchState>
  ) => void;
  setTableContentActiveTab: (tab: string) => void;
  /** 切换到指定连接，恢复其缓存状态 */
  switchToConnection: (connId: string) => void;
  /** 移除连接的缓存状态（断开时调用） */
  removeConnectionState: (connId: string) => void;
  reset: () => void;
}

// 标签对象同时作为请求身份：关闭后重开同名表不会接收旧请求的结果。
let sqlResultGeneration = 0;
const tableMetadataRequests = new WeakMap<
  OpenTabEntry,
  { generation: string; promise: Promise<void> }
>();

const selectionRequests = new Map<string, object>();
function beginSelection(connId: string): object {
  const request = {};
  selectionRequests.set(connId, request);
  return request;
}

// 断线生命周期独立于结构代次：并发成功 DDL 仍须负责新一代读取。
const connectionLifetimes = new Map<string, object>();
function connectionLifetime(connId: string): object {
  let lifetime = connectionLifetimes.get(connId);
  if (!lifetime) {
    lifetime = {};
    connectionLifetimes.set(connId, lifetime);
  }
  return lifetime;
}

type MetadataLoading = "treeLoading" | "structureLoading";
const loadingRequests: Record<MetadataLoading, Map<string, object>> = {
  treeLoading: new Map(),
  structureLoading: new Map(),
};
function beginMetadataLoading(connId: string, kind: MetadataLoading): object {
  const request = {};
  loadingRequests[kind].set(connId, request);
  return request;
}
function finishMetadataLoading(
  connId: string,
  kind: MetadataLoading,
  request: object
): void {
  if (loadingRequests[kind].get(connId) !== request) return;
  loadingRequests[kind].delete(connId);
  if (useDatabaseStore.getState().activeConnId === connId) {
    useDatabaseStore.setState(
      kind === "treeLoading"
        ? { treeLoading: false }
        : { structureLoading: false }
    );
  }
}

type MetadataResource =
  | readonly ["databases"]
  | readonly ["tables", string]
  | readonly ["structure", string, string];
const metadataReadOwners = new Map<string, Map<string, object>>();

/** 一个资源只允许最后登记的读取回填；不同表结构彼此不接管。 */
function ownMetadataRead(
  connId: string,
  resources: readonly MetadataResource[]
): () => boolean {
  const owners = metadataReadOwners.get(connId) ?? new Map<string, object>();
  metadataReadOwners.set(connId, owners);
  const request = {};
  const keys = resources.map((resource) => JSON.stringify(resource));
  for (const key of keys) owners.set(key, request);
  return () =>
    keys.every((key) => metadataReadOwners.get(connId)?.get(key) === request);
}

function discardMetadataResources(
  connId: string,
  resources: readonly MetadataResource[]
): void {
  useDatabaseStore.setState((current) => {
    const state = current.connectionStates[connId];
    if (!state) return current;
    const updated = {
      ...state,
      tables: { ...state.tables },
      tableStructures: { ...state.tableStructures },
    };
    for (const resource of resources) {
      if (resource[0] === "databases") updated.databases = [];
      if (resource[0] === "tables") delete updated.tables[resource[1]];
      if (resource[0] === "structure") {
        delete updated.tableStructures[`${resource[1]}|${resource[2]}`];
        if (
          state.selectedDatabase === resource[1] &&
          state.selectedTable === resource[2]
        )
          updated.tableStructure = null;
      }
    }
    return {
      connectionStates: { ...current.connectionStates, [connId]: updated },
      ...(current.activeConnId === connId ? syncCurrentView(updated) : {}),
    };
  });
}

type ResourceOwnership = (resource: MetadataResource) => boolean;
type SchemaMutation = {
  read: <T>(
    resources: readonly MetadataResource[],
    loader: (owns: ResourceOwnership) => Promise<T>,
    apply: (value: T, owns: ResourceOwnership) => void
  ) => Promise<void>;
};

class MetadataRefreshRequiredError extends Error {}

/** 接管资源也接管更新责任：同一读取最多补读一次，提交与校验同步进行。 */
function createMetadataRead(
  connId: string,
  scope: readonly string[] | undefined,
  resources: readonly MetadataResource[],
  relevant: ResourceOwnership = () => true,
  changedMessage = "元数据在读取期间再次变化，请刷新后重试"
) {
  const lifetime = connectionLifetime(connId);
  const revision = getSqlCompletionConnectionRevision(connId);
  const owners = new Map(
    resources.map((resource) => [
      JSON.stringify(resource),
      ownMetadataRead(connId, [resource]),
    ])
  );
  const owns: ResourceOwnership = (resource) =>
    lifetime === connectionLifetimes.get(connId) &&
    revision === getSqlCompletionConnectionRevision(connId) &&
    relevant(resource) &&
    (owners.get(JSON.stringify(resource))?.() ?? false);
  const ownsAny = () => resources.some(owns);
  return {
    owns,
    ownsAny,
    async read<T>(
      loader: (owns: ResourceOwnership) => Promise<T>,
      apply: (value: T, owns: ResourceOwnership) => void
    ) {
      if (!ownsAny()) return;
      let generation = getMetadataRequestGeneration(connId, scope);
      const current = () =>
        generation === getMetadataRequestGeneration(connId, scope);
      const readOnce = async () => {
        try {
          return { ok: true as const, value: await loader(owns) };
        } catch (error) {
          return { ok: false as const, error };
        }
      };
      let result = await readOnce();
      if (!ownsAny()) return;
      if (!current()) {
        generation = getMetadataRequestGeneration(connId, scope);
        // 明确的单次补读，不递归、不排队、不在循环中执行查询。
        result = await readOnce();
        if (!ownsAny()) return;
        if (!current()) {
          discardMetadataResources(connId, resources.filter(owns));
          throw new MetadataRefreshRequiredError(changedMessage);
        }
      }
      if (!result.ok) throw result.error;
      apply(result.value, owns);
    },
  };
}

/** DDL 仅执行一次，随后将需要回填的资源交给共享读取上下文。 */
async function mutateSchema(
  connId: string,
  database: string | undefined,
  operation: () => Promise<void>
): Promise<SchemaMutation | undefined> {
  const scope = database === undefined ? undefined : [database];
  const lifetime = connectionLifetime(connId);
  const revision = getSqlCompletionConnectionRevision(connId);
  const sameConnection = () =>
    lifetime === connectionLifetimes.get(connId) &&
    revision === getSqlCompletionConnectionRevision(connId);
  await operation();
  invalidateSqlCompletion({
    connId,
    ...(database === undefined ? {} : { database }),
    reason: "schema-change",
  });
  if (!sameConnection()) return;
  return {
    async read(resources, loader, apply) {
      if (!sameConnection()) return;
      await createMetadataRead(
        connId,
        scope,
        resources,
        () => true,
        "操作已成功，元数据在读取期间再次变化，请刷新；无需重复执行操作"
      ).read(loader, apply);
    },
  };
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
  sqlTabExecutions: {},
  viewMode: "tab",
  tableInfos: {},
  databaseInfo: null,
  databaseInfoLoading: false,

  loadDatabases: async (connId: string, defaultDatabase?: string | null) => {
    const read = createMetadataRead(connId, undefined, [["databases"]]);
    const loading = beginMetadataLoading(connId, "treeLoading");
    let selectDefault = false;
    try {
      set({ treeLoading: true });
      await read.read(
        () => api.listDatabases(connId),
        (databases) => {
          set((s) => {
            const state = s.connectionStates[connId] ?? emptyConnState();
            const updated = { ...state, databases };
            return {
              connectionStates: { ...s.connectionStates, [connId]: updated },
              ...(s.activeConnId === connId ? syncCurrentView(updated) : {}),
            };
          });
          selectDefault =
            !!defaultDatabase && databases.includes(defaultDatabase);
        }
      );
      if (selectDefault && defaultDatabase && read.ownsAny()) {
        await get().selectDatabase(connId, defaultDatabase);
      }
    } catch (error) {
      if (!read.ownsAny()) return;
      if (error instanceof MetadataRefreshRequiredError) throw error;
      console.error("加载数据库列表失败:", error);
    } finally {
      finishMetadataLoading(connId, "treeLoading", loading);
    }
  },

  loadTables: async (connId: string, database: string) => {
    const read = createMetadataRead(connId, [database], [["tables", database]]);
    const loading = beginMetadataLoading(connId, "treeLoading");
    try {
      if (get().activeConnId === connId) set({ treeLoading: true });
      await read.read(
        () => api.listTables(connId, database),
        (tableList) => {
          set((current) => {
            const state = current.connectionStates[connId] ?? emptyConnState();
            const updated = {
              ...state,
              tables: { ...state.tables, [database]: tableList },
            };
            return {
              connectionStates: {
                ...current.connectionStates,
                [connId]: updated,
              },
              ...(current.activeConnId === connId
                ? syncCurrentView(updated)
                : {}),
            };
          });
        }
      );
    } catch (error) {
      if (!read.ownsAny()) return;
      if (error instanceof MetadataRefreshRequiredError) throw error;
      console.error("加载表列表失败:", error);
    } finally {
      finishMetadataLoading(connId, "treeLoading", loading);
    }
  },

  selectDatabase: async (connId: string, database: string) => {
    beginSelection(connId);
    // 先同步选择，再等待目录；迟到响应只补充目录，不回放选择快照。
    set((current) => {
      const state = current.connectionStates[connId] ?? emptyConnState();
      const updated: ConnectionDatabaseState = {
        ...state,
        selectedDatabase: database,
        selectedTable: null,
        tableStructure: null,
        selectedTableInfo: null,
        viewMode: "overview",
        expandedKeys: [...new Set([...state.expandedKeys, `db:${database}`])],
      };
      return {
        connectionStates: { ...current.connectionStates, [connId]: updated },
        ...(current.activeConnId === connId ? syncCurrentView(updated) : {}),
      };
    });
    if (!get().connectionStates[connId]?.tables[database]) {
      await get().loadTables(connId, database);
    }
  },

  selectTable: async (connId: string, database: string, table: string) => {
    await get().openOrSwitchToTable(connId, database, table);
  },

  openTableTabs: (connId, entries) => {
    beginSelection(connId);
    if (entries.length === 0) return;
    set((current) => {
      const state = current.connectionStates[connId] ?? emptyConnState();
      const openTabs = [...state.openTabs];
      const expandedKeys = new Set(state.expandedKeys);
      let activeTabIndex = state.activeTabIndex;
      for (const entry of entries) {
        const index = openTabs.findIndex(
          (tab) =>
            tab.type === "table" &&
            tab.database === entry.database &&
            tab.table === entry.table
        );
        if (index >= 0) {
          activeTabIndex = index;
        } else {
          openTabs.push({
            type: "table",
            database: entry.database,
            table: entry.table,
          });
          activeTabIndex = openTabs.length - 1;
        }
        // 未缓存的节点展开会触发树的 loadData；等激活表加载完再展开。
        if (state.tables[entry.database])
          expandedKeys.add(`db:${entry.database}`);
      }
      const updated: ConnectionDatabaseState = {
        ...state,
        openTabs,
        activeTabIndex,
        expandedKeys: [...expandedKeys],
        viewMode: "tab",
      };
      applyOpenTabDerivedState(updated);
      return {
        connectionStates: { ...current.connectionStates, [connId]: updated },
        ...(current.activeConnId === connId
          ? {
              ...syncCurrentView(updated),
              structureError: null,
              structureLoading: false,
            }
          : {}),
      };
    });
  },

  ensureTableMetadata: async (connId, database, table) => {
    const current = get();
    const state = current.connectionStates[connId];
    const entry = state?.openTabs[state.activeTabIndex];
    if (
      current.activeConnId !== connId ||
      state?.viewMode !== "tab" ||
      entry?.type !== "table" ||
      entry.database !== database ||
      entry.table !== table
    )
      return;
    const key = `${database}|${table}`;
    if (state.tableStructures[key] && state.tableInfos[key]) return;
    const generation = getMetadataRequestGeneration(connId, [database]);
    const pending = tableMetadataRequests.get(entry);
    if (pending?.generation === generation) return pending.promise;
    const needsTables =
      !state.tableInfos[key] &&
      !state.tables[database]?.some((item) => item.name === table);
    const read = createMetadataRead(
      connId,
      [database],
      [
        ["structure", database, table],
        ...(needsTables ? [["tables", database] as const] : []),
      ],
      () => !!get().connectionStates[connId]?.openTabs.includes(entry)
    );
    const isStillActive = () => {
      const latest = get();
      const connection = latest.connectionStates[connId];
      return (
        read.owns(["structure", database, table]) &&
        latest.activeConnId === connId &&
        connection?.viewMode === "tab" &&
        connection.openTabs[connection.activeTabIndex] === entry
      );
    };
    let structureRequest: object | undefined;
    const request = read.read(
      async (owns) => {
        let tableList = get().connectionStates[connId]?.tables[database];
        let loadedTableList: TableInfo[] | undefined;
        if (needsTables && owns(["tables", database])) {
          tableList = await api.listTables(connId, database);
          loadedTableList = tableList;
          if (!isStillActive()) return;
        }
        if (!owns(["structure", database, table])) return;
        const tableInfo =
          tableList?.find((item) => item.name === table) ??
          state.tableInfos[key];
        if (!tableInfo)
          throw new Error(`找不到表或视图 ${database}.${table}，请刷新后重试`);
        // 补读不能沿用上一代已缓存结构；缺失元数据的普通首次加载仍可复用缓存。
        let structure =
          generation === getMetadataRequestGeneration(connId, [database])
            ? state.tableStructures[key]
            : undefined;
        if (!structure) {
          structureRequest = beginMetadataLoading(connId, "structureLoading");
          structure = await api.getTableStructure(connId, database, table);
        }
        return { tableList, loadedTableList, tableInfo, structure };
      },
      (result, owns) => {
        if (!result || !owns(["structure", database, table])) return;
        const { tableList, loadedTableList, tableInfo, structure } = result;
        set((latest) => {
          const connection = latest.connectionStates[connId];
          if (!connection?.openTabs.includes(entry)) return latest;
          const listUnchanged =
            connection.tables[database] === state.tables[database];
          const mayApplyTables = owns(["tables", database]) && listUnchanged;
          const currentTableList = mayApplyTables
            ? (loadedTableList ?? connection.tables[database])
            : connection.tables[database];
          const currentTableInfo = currentTableList?.find(
            (item) => item.name === table
          );
          if (currentTableList && !currentTableInfo)
            throw new Error(
              `找不到表或视图 ${database}.${table}，请刷新后重试`
            );
          const updated: ConnectionDatabaseState = {
            ...connection,
            expandedKeys:
              isStillActive() && tableList
                ? [...new Set([...connection.expandedKeys, `db:${database}`])]
                : connection.expandedKeys,
            tables:
              loadedTableList && mayApplyTables
                ? { ...connection.tables, [database]: loadedTableList }
                : connection.tables,
            tableStructures: {
              ...connection.tableStructures,
              [key]:
                connection.tableStructures[key] !== state.tableStructures[key]
                  ? (connection.tableStructures[key] ?? structure)
                  : structure,
            },
            tableInfos: {
              ...connection.tableInfos,
              [key]:
                currentTableInfo ?? connection.tableInfos[key] ?? tableInfo,
            },
          };
          applyOpenTabDerivedState(updated);
          return {
            connectionStates: { ...latest.connectionStates, [connId]: updated },
            ...(latest.activeConnId === connId ? syncCurrentView(updated) : {}),
            ...(isStillActive() ? { structureError: null } : {}),
          };
        });
      }
    );
    const pendingEntry = { generation, promise: request };
    tableMetadataRequests.set(entry, pendingEntry);
    try {
      await request;
    } finally {
      if (structureRequest)
        finishMetadataLoading(connId, "structureLoading", structureRequest);
      if (tableMetadataRequests.get(entry) === pendingEntry)
        tableMetadataRequests.delete(entry);
    }
  },

  openOrSwitchToTable: async (
    connId: string,
    database: string,
    table: string
  ) => {
    const selection = beginSelection(connId);
    let read: ReturnType<typeof createMetadataRead> | undefined;
    const isCurrent = () => read?.ownsAny() ?? false;
    let structureRequest: object | undefined;
    try {
      let { connectionStates, activeConnId } = get();
      let state = connectionStates[connId] ?? emptyConnState();
      const key = `${database}|${table}`;
      const openTabs = state.openTabs ?? [];

      const existingIdx = openTabs.findIndex(
        (e) =>
          e.type === "table" && e.database === database && e.table === table
      );

      if (existingIdx >= 0) {
        const updated: ConnectionDatabaseState = {
          ...state,
          activeTabIndex: existingIdx,
          viewMode: "tab",
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
          viewMode: "tab",
        };
        if (activeConnId === connId) {
          Object.assign(res, syncCurrentView(updated));
        }
        set(activeConnId === connId ? res : { connectionStates: newStates });
        return;
      }

      read = createMetadataRead(
        connId,
        [database],
        [["structure", database, table]],
        () => selectionRequests.get(connId) === selection
      );
      structureRequest = beginMetadataLoading(connId, "structureLoading");
      set({ structureLoading: true, structureError: null });

      const tableInfo =
        state.tables[database]?.find((t) => t.name === table) ?? null;
      await read.read(
        () => api.getTableStructure(connId, database, table),
        (structure) => {
          ({ connectionStates, activeConnId } = get());
          state = connectionStates[connId] ?? emptyConnState();

          const newEntry: OpenTabEntry = { type: "table", database, table };
          const newOpenTabs = [...(state.openTabs ?? []), newEntry];
          const newIdx = newOpenTabs.length - 1;
          const newTableStructures = {
            ...(state.tableStructures ?? {}),
            [key]: structure,
          };
          const newTableInfos = {
            ...(state.tableInfos ?? {}),
            [key]: tableInfo ?? {
              name: table,
              table_type: "TABLE",
              engine: null,
              rows: null,
              data_length: null,
              index_length: null,
              comment: "",
            },
          };
          const derivedOpenTables = newOpenTabs
            .filter(
              (t): t is { type: "table"; database: string; table: string } =>
                t.type === "table"
            )
            .map((t) => ({ database: t.database, table: t.table }));

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
            viewMode: "tab",
          };
          const derived = applyOpenTabDerivedState(updated);

          const newStates = { ...connectionStates, [connId]: updated };
          const res: Partial<DatabaseState> = {
            connectionStates: newStates,
            openTabs: newOpenTabs,
            activeTabIndex: newIdx,
            openTables: derived.openTables ?? updated.openTables,
            activeTableTabIndex: derived.activeTableTabIndex ?? newIdx,
            viewMode: "tab",
          };
          if (activeConnId === connId) {
            Object.assign(res, syncCurrentView(updated));
          }
          set(activeConnId === connId ? res : { connectionStates: newStates });
        }
      );
    } catch (e) {
      if (!isCurrent()) return;
      const msg = String(e);
      console.error("加载表结构失败:", msg);
      const { connectionStates, activeConnId } = get();
      const state = connectionStates[connId] ?? emptyConnState();
      const tableInfo =
        state.tables[database]?.find((t) => t.name === table) ?? null;
      const key = `${database}|${table}`;
      const newEntry: OpenTabEntry = { type: "table", database, table };
      const newOpenTabs = [...(state.openTabs ?? []), newEntry];
      const newIdx = newOpenTabs.length - 1;
      const newTableInfos = {
        ...state.tableInfos,
        [key]: tableInfo ?? {
          name: table,
          table_type: "TABLE",
          engine: null,
          rows: null,
          data_length: null,
          index_length: null,
          comment: "",
        },
      };
      const derivedOpenTables = newOpenTabs
        .filter(
          (t): t is { type: "table"; database: string; table: string } =>
            t.type === "table"
        )
        .map((t) => ({ database: t.database, table: t.table }));
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
        viewMode: "tab",
      };
      const newStates = { ...connectionStates, [connId]: updated };
      const res: Partial<DatabaseState> = {
        connectionStates: newStates,
        structureError: msg,
        openTabs: newOpenTabs,
        activeTabIndex: newIdx,
        viewMode: "tab",
      };
      if (activeConnId === connId) {
        Object.assign(res, syncCurrentView(updated));
      }
      set(activeConnId === connId ? res : { connectionStates: newStates });
    } finally {
      if (structureRequest)
        finishMetadataLoading(connId, "structureLoading", structureRequest);
    }
  },

  openSqlTab: (connId: string, initialContent?: string) => {
    beginSelection(connId);
    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    const tabId = `sql-${Date.now()}`;
    const newEntry: OpenTabEntry = { type: "sql", id: tabId };
    const newOpenTabs = [...(state.openTabs ?? []), newEntry];
    const newIdx = newOpenTabs.length - 1;
    const newSqlTabContents = {
      ...(state.sqlTabContents ?? {}),
      [tabId]: initialContent ?? "",
    };
    const updated: ConnectionDatabaseState = {
      ...state,
      openTabs: newOpenTabs,
      activeTabIndex: newIdx,
      sqlTabContents: newSqlTabContents,
      viewMode: "tab",
    };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = {
      connectionStates: newStates,
      openTabs: newOpenTabs,
      activeTabIndex: newIdx,
      sqlTabContents: newSqlTabContents,
      viewMode: "tab",
    };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  setSqlTabContent: (connId: string, tabId: string, content: string) => {
    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId] ?? emptyConnState();
    if (state.sqlTabContents[tabId] === content) return;
    const newSqlTabContents = {
      ...(state.sqlTabContents ?? {}),
      [tabId]: content,
    };
    const updated: ConnectionDatabaseState = {
      ...state,
      sqlTabContents: newSqlTabContents,
    };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = {
      connectionStates: newStates,
    };
    if (activeConnId === connId) {
      // 编辑草稿不改变选中表或标签；仅同步当前连接的内容，避免重建视图派生状态。
      res.sqlTabContents = newSqlTabContents;
    }
    set(res);
  },

  setSqlTabResult: (
    connId: string,
    tabId: string,
    result: SqlExecuteResult | null,
    error: string | null,
    executedSqlList: string[],
    statementResults: SqlStatementResult[] = []
  ) => {
    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId];
    if (
      !state ||
      !state.openTabs.some((tab) => tab.type === "sql" && tab.id === tabId)
    ) {
      return;
    }
    const generation = ++sqlResultGeneration;
    statementResults = (
      statementResults.length
        ? statementResults
        : result
          ? [{ sql: executedSqlList[0] ?? "", result, error }]
          : []
    ).map((statement, index) => ({
      ...statement,
      cacheKey:
        statement.cacheKey ?? `sql:${connId}:${tabId}:${generation}:${index}`,
      retention: statement.retention ?? "resident",
      retainedRowCount:
        statement.retainedRowCount ?? statement.result?.rows?.length ?? 0,
    }));
    const newSqlTabResults = {
      ...(state.sqlTabResults ?? {}),
      [tabId]: {
        result,
        error,
        executedSqlList,
        statementResults,
        activeResultIndex: 0,
      },
    };
    const updated: ConnectionDatabaseState = {
      ...state,
      sqlTabResults: newSqlTabResults,
    };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = {
      connectionStates: newStates,
    };
    if (activeConnId === connId) {
      res.sqlTabResults = newSqlTabResults;
    }
    set(res);
    for (const statement of statementResults) {
      if (
        !statement.result?.rows ||
        !statement.result.columns ||
        statement.retention === "evicted" ||
        !statement.cacheKey
      )
        continue;
      const key = statement.cacheKey;
      if (
        resultCacheController.transfer(key, () =>
          evictSqlResult(connId, tabId, key)
        )
      )
        continue;
      resultCacheController.track({
        key,
        estimatedBytes: estimateResultBytes(
          statement.result.columns,
          statement.result.rows
        ),
        evict: () => evictSqlResult(connId, tabId, key),
      });
    }
  },

  setSqlTabActiveResult: (connId, tabId, index) => {
    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId];
    const current = state?.sqlTabResults[tabId];
    if (
      !state ||
      !current ||
      !state.openTabs.some((tab) => tab.type === "sql" && tab.id === tabId) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= (current.statementResults?.length ?? 0) ||
      current.activeResultIndex === index
    ) {
      return;
    }
    const sqlTabResults = {
      ...state.sqlTabResults,
      [tabId]: { ...current, activeResultIndex: index },
    };
    const res: Partial<DatabaseState> = {
      connectionStates: {
        ...connectionStates,
        [connId]: { ...state, sqlTabResults },
      },
    };
    if (activeConnId === connId) {
      res.sqlTabResults = sqlTabResults;
    }
    set(res);
  },

  requestSqlTabExecute: (connId: string, tabId: string) => {
    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId];
    const openTabs = state?.openTabs ?? [];
    if (
      !state ||
      !tabId ||
      !openTabs.some((t) => t.type === "sql" && t.id === tabId)
    ) {
      return;
    }
    const prev = state.sqlTabExecuteNonce ?? {};
    const newSqlTabExecuteNonce = { ...prev, [tabId]: (prev[tabId] ?? 0) + 1 };
    const updated: ConnectionDatabaseState = {
      ...state,
      sqlTabExecuteNonce: newSqlTabExecuteNonce,
      sqlTabExecuteDatabases: {
        ...state.sqlTabExecuteDatabases,
        [tabId]: state.selectedDatabase,
      },
    };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = {
      connectionStates: newStates,
    };
    if (activeConnId === connId) {
      Object.assign(res, syncCurrentView(updated));
    }
    set(res);
  },

  consumeSqlTabExecute: (connId, tabId, nonce) => {
    let consumed: { database: string | null } | null = null;
    set((current) => {
      const state = current.connectionStates[connId];
      if (
        !state ||
        nonce <= 0 ||
        state.sqlTabExecuteNonce[tabId] !== nonce ||
        !state.openTabs.some((tab) => tab.type === "sql" && tab.id === tabId)
      ) {
        return current;
      }
      consumed = { database: state.sqlTabExecuteDatabases?.[tabId] ?? null };
      const sqlTabExecuteNonce = { ...state.sqlTabExecuteNonce, [tabId]: 0 };
      const sqlTabExecuteDatabases = { ...state.sqlTabExecuteDatabases };
      delete sqlTabExecuteDatabases[tabId];
      return {
        connectionStates: {
          ...current.connectionStates,
          [connId]: { ...state, sqlTabExecuteNonce, sqlTabExecuteDatabases },
        },
        ...(current.activeConnId === connId ? { sqlTabExecuteNonce } : {}),
      };
    });
    return consumed;
  },

  setSqlTabExecution: (
    connId: string,
    tabId: string,
    execution: { executionId: string | null } | null
  ) => {
    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId];
    if (!state || !tabId) return;
    const prev = state.sqlTabExecutions ?? {};
    const newSqlTabExecutions = { ...prev };
    if (execution) {
      // 仅为仍打开的 SQL 标签登记执行中状态，避免标签关闭后残留
      const openTabs = state.openTabs ?? [];
      if (!openTabs.some((t) => t.type === "sql" && t.id === tabId)) return;
      newSqlTabExecutions[tabId] = execution;
    } else {
      delete newSqlTabExecutions[tabId];
    }
    const updated: ConnectionDatabaseState = {
      ...state,
      sqlTabExecutions: newSqlTabExecutions,
    };
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = {
      connectionStates: newStates,
    };
    if (activeConnId === connId) {
      res.sqlTabExecutions = newSqlTabExecutions;
    }
    set(res);
  },

  switchTableTab: (connId: string, index: number) => {
    get().switchTab(connId, index);
  },

  switchTab: (connId: string, index: number) => {
    beginSelection(connId);
    const { connectionStates, activeConnId } = get();
    const state = connectionStates[connId];
    const openTabs = state?.openTabs ?? [];
    if (!state || index < 0 || index >= openTabs.length) return;

    const updated: ConnectionDatabaseState = {
      ...state,
      activeTabIndex: index,
      // 切换到任意标签时进入 tab 模式，恢复显示标签内容（离开数据库概览）
      viewMode: "tab",
    };
    const derived = applyOpenTabDerivedState(updated);
    const newStates = { ...connectionStates, [connId]: updated };
    const res: Partial<DatabaseState> = {
      connectionStates: newStates,
      activeTabIndex: index,
      viewMode: "tab",
      openTables: derived.openTables ?? state.openTables,
      activeTableTabIndex:
        derived.activeTableTabIndex ?? state.activeTableTabIndex,
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
      updated = {
        ...updated,
        tableStructures: newTableStructures,
        tableInfos: newTableInfos,
      };
    } else {
      const newSqlTabContents = { ...(state.sqlTabContents ?? {}) };
      const newSqlTabResults = { ...(state.sqlTabResults ?? {}) };
      const newSqlTabExecuteNonce = { ...(state.sqlTabExecuteNonce ?? {}) };
      const newSqlTabExecuteDatabases = { ...state.sqlTabExecuteDatabases };
      const newSqlTabExecutions = { ...(state.sqlTabExecutions ?? {}) };
      delete newSqlTabContents[closedEntry.id];
      delete newSqlTabResults[closedEntry.id];
      delete newSqlTabExecuteNonce[closedEntry.id];
      delete newSqlTabExecuteDatabases[closedEntry.id];
      delete newSqlTabExecutions[closedEntry.id];
      updated = {
        ...updated,
        sqlTabContents: newSqlTabContents,
        sqlTabResults: newSqlTabResults,
        sqlTabExecuteNonce: newSqlTabExecuteNonce,
        sqlTabExecuteDatabases: newSqlTabExecuteDatabases,
        sqlTabExecutions: newSqlTabExecutions,
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
      openTables:
        derived.openTables ??
        newOpenTabs
          .filter((t) => t.type === "table")
          .map((t) => ({ database: t.database, table: t.table })),
      activeTableTabIndex: derived.activeTableTabIndex ?? 0,
      selectedDatabase: updated.selectedDatabase,
      selectedTable: updated.selectedTable,
      tableStructure: updated.tableStructure,
      selectedTableInfo: updated.selectedTableInfo,
      sqlTabContents: updated.sqlTabContents,
      sqlTabResults: updated.sqlTabResults,
      sqlTabExecuteNonce: updated.sqlTabExecuteNonce,
      sqlTabExecutions: updated.sqlTabExecutions,
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
    const mutation = await mutateSchema(connId, database, () =>
      api.renameTable(connId, database, oldName, newName)
    );
    if (!mutation) return;
    await mutation.read(
      [
        ["tables", database],
        ["structure", database, newName],
      ],
      async (owns) => ({
        tableList: owns(["tables", database])
          ? await api.listTables(connId, database)
          : undefined,
        structure: owns(["structure", database, newName])
          ? await api.getTableStructure(connId, database, newName)
          : undefined,
      }),
      ({ tableList, structure }, owns) => {
        const { connectionStates, activeConnId } = get();
        const state = connectionStates[connId] ?? emptyConnState();
        const ownsTables = owns(["tables", database]);
        const ownsStructure = owns(["structure", database, newName]);
        const tableInfo =
          (ownsTables ? tableList : state.tables[database])?.find(
            (item) => item.name === newName
          ) ?? null;
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
        if (ownsStructure && structure) newTableStructures[newKey] = structure;
        newTableInfos[newKey] = tableInfo ??
          newTableInfos[newKey] ?? {
            name: newName,
            table_type: "TABLE",
            engine: null,
            rows: null,
            data_length: null,
            index_length: null,
            comment: "",
          };

        const openTabs = state.openTabs ?? [];
        const newOpenTabs = openTabs.map((e) =>
          e.type === "table" && e.database === database && e.table === oldName
            ? { type: "table" as const, database, table: newName }
            : e
        );
        const newOpenTables = newOpenTabs
          .filter(
            (t): t is { type: "table"; database: string; table: string } =>
              t.type === "table"
          )
          .map((t) => ({ database: t.database, table: t.table }));

        const updated: ConnectionDatabaseState = {
          ...state,
          tables:
            ownsTables && tableList
              ? { ...state.tables, [database]: tableList }
              : state.tables,
          openTabs: newOpenTabs,
          openTables: newOpenTables,
          tableStructures: newTableStructures,
          tableInfos: newTableInfos,
          selectedTable:
            state.selectedDatabase === database &&
            state.selectedTable === oldName
              ? newName
              : state.selectedTable,
          tableStructure:
            state.selectedDatabase === database &&
            state.selectedTable === oldName &&
            ownsStructure &&
            structure
              ? structure
              : state.tableStructure,
          selectedTableInfo:
            state.selectedDatabase === database &&
            state.selectedTable === oldName
              ? tableInfo
              : state.selectedTableInfo,
        };
        applyOpenTabDerivedState(updated);
        const newStates = { ...connectionStates, [connId]: updated };
        const res: Partial<DatabaseState> = { connectionStates: newStates };
        if (activeConnId === connId) {
          Object.assign(res, syncCurrentView(updated));
        }
        set(res);
      }
    );
  },

  alterTableEngine: async (
    connId: string,
    database: string,
    table: string,
    engine: string
  ) => {
    const mutation = await mutateSchema(connId, database, () =>
      api.alterTableEngine(connId, database, table, engine)
    );
    if (!mutation) return;
    await mutation.read(
      [["tables", database]],
      () => api.listTables(connId, database),
      (tableList) => {
        const tableInfo = tableList.find((t) => t.name === table) ?? null;

        const { connectionStates, activeConnId } = get();
        const state = connectionStates[connId] ?? emptyConnState();
        const updated: ConnectionDatabaseState = {
          ...state,
          tables: { ...state.tables, [database]: tableList },
          selectedTableInfo:
            state.selectedDatabase === database && state.selectedTable === table
              ? tableInfo
              : state.selectedTableInfo,
        };
        const newStates = { ...connectionStates, [connId]: updated };
        const res: Partial<DatabaseState> = { connectionStates: newStates };
        if (activeConnId === connId) {
          Object.assign(res, syncCurrentView(updated));
        }
        set(res);
      }
    );
  },

  alterColumn: async (
    connId: string,
    database: string,
    table: string,
    request: AlterColumnRequest
  ) => {
    const mutation = await mutateSchema(connId, database, () =>
      api.alterColumn(connId, database, table, request)
    );
    if (!mutation) return;
    await mutation.read(
      [["structure", database, table]],
      () => api.getTableStructure(connId, database, table),
      (structure) => {
        const { connectionStates, activeConnId } = get();
        const state = connectionStates[connId] ?? emptyConnState();
        const key = `${database}|${table}`;
        const newTableStructures = {
          ...(state.tableStructures ?? {}),
          [key]: structure,
        };
        const updated: ConnectionDatabaseState = {
          ...state,
          tableStructures: newTableStructures,
          tableStructure:
            state.selectedDatabase === database && state.selectedTable === table
              ? structure
              : state.tableStructure,
        };
        const newStates = { ...connectionStates, [connId]: updated };
        const res: Partial<DatabaseState> = { connectionStates: newStates };
        if (activeConnId === connId) {
          Object.assign(res, syncCurrentView(updated));
        }
        set(res);
      }
    );
  },

  addColumn: async (
    connId: string,
    database: string,
    table: string,
    request: AddColumnRequest
  ) => {
    const mutation = await mutateSchema(connId, database, () =>
      api.addColumn(connId, database, table, request)
    );
    if (!mutation) return;
    await mutation.read(
      [["structure", database, table]],
      () => api.getTableStructure(connId, database, table),
      (structure) => {
        const { connectionStates, activeConnId } = get();
        const state = connectionStates[connId] ?? emptyConnState();
        const key = `${database}|${table}`;
        const newTableStructures = {
          ...(state.tableStructures ?? {}),
          [key]: structure,
        };
        const updated: ConnectionDatabaseState = {
          ...state,
          tableStructures: newTableStructures,
          tableStructure:
            state.selectedDatabase === database && state.selectedTable === table
              ? structure
              : state.tableStructure,
        };
        const newStates = { ...connectionStates, [connId]: updated };
        const res: Partial<DatabaseState> = { connectionStates: newStates };
        if (activeConnId === connId) {
          Object.assign(res, syncCurrentView(updated));
        }
        set(res);
      }
    );
  },

  dropColumn: async (
    connId: string,
    database: string,
    table: string,
    columnName: string
  ) => {
    const mutation = await mutateSchema(connId, database, () =>
      api.dropColumn(connId, database, table, columnName)
    );
    if (!mutation) return;
    await mutation.read(
      [["structure", database, table]],
      () => api.getTableStructure(connId, database, table),
      (structure) => {
        const { connectionStates, activeConnId } = get();
        const state = connectionStates[connId] ?? emptyConnState();
        const key = `${database}|${table}`;
        const newTableStructures = {
          ...(state.tableStructures ?? {}),
          [key]: structure,
        };
        const updated: ConnectionDatabaseState = {
          ...state,
          tableStructures: newTableStructures,
          tableStructure:
            state.selectedDatabase === database && state.selectedTable === table
              ? structure
              : state.tableStructure,
        };
        const newStates = { ...connectionStates, [connId]: updated };
        const res: Partial<DatabaseState> = { connectionStates: newStates };
        if (activeConnId === connId) {
          Object.assign(res, syncCurrentView(updated));
        }
        set(res);
      }
    );
  },

  createTable: async (
    connId: string,
    database: string,
    request: CreateTableRequest
  ) => {
    const mutation = await mutateSchema(connId, database, () =>
      api.createTable(connId, database, request)
    );
    if (!mutation) return;
    await mutation.read(
      [["tables", database]],
      () => api.listTables(connId, database),
      (tableList) => {
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
      }
    );
  },

  dropTable: async (connId: string, database: string, table: string) => {
    const mutation = await mutateSchema(connId, database, () =>
      api.dropTable(connId, database, table)
    );
    if (!mutation) return;

    await mutation.read(
      [["tables", database]],
      () => api.listTables(connId, database),
      (tableList) => {
        const { connectionStates, activeConnId } = get();
        const state = connectionStates[connId] ?? emptyConnState();
        const droppedKey = `${database}|${table}`;
        const openTabs = state.openTabs ?? [];

        const newOpenTabs = openTabs.filter(
          (e) =>
            !(
              e.type === "table" &&
              e.database === database &&
              e.table === table
            )
        );
        const newOpenTables = newOpenTabs
          .filter(
            (t): t is { type: "table"; database: string; table: string } =>
              t.type === "table"
          )
          .map((t) => ({ database: t.database, table: t.table }));
        const wasActive =
          state.selectedDatabase === database && state.selectedTable === table;
        const currentIdx = state.activeTabIndex ?? 0;
        let newIdx = currentIdx;
        const droppedIdx = openTabs.findIndex(
          (e) =>
            e.type === "table" && e.database === database && e.table === table
        );
        if (droppedIdx >= 0) {
          if (droppedIdx < currentIdx) {
            newIdx = currentIdx - 1;
          } else if (droppedIdx === currentIdx) {
            newIdx =
              newOpenTabs.length > 0
                ? Math.min(currentIdx, newOpenTabs.length - 1)
                : 0;
          }
        }

        const newTableStructures = { ...(state.tableStructures ?? {}) };
        const newTableInfos = { ...(state.tableInfos ?? {}) };
        delete newTableStructures[droppedKey];
        delete newTableInfos[droppedKey];

        const nextEntry = newOpenTabs[newIdx];
        const updated: ConnectionDatabaseState = {
          ...state,
          tables: { ...state.tables, [database]: tableList },
          openTabs: newOpenTabs,
          openTables: newOpenTables,
          activeTabIndex: newIdx,
          activeTableTabIndex: newOpenTabs
            .slice(0, newIdx)
            .filter((t) => t.type === "table").length,
          tableStructures: newTableStructures,
          tableInfos: newTableInfos,
          selectedDatabase:
            nextEntry?.type === "table"
              ? nextEntry.database
              : wasActive
                ? null
                : state.selectedDatabase,
          selectedTable:
            nextEntry?.type === "table"
              ? nextEntry.table
              : wasActive
                ? null
                : state.selectedTable,
          tableStructure:
            nextEntry?.type === "table"
              ? (newTableStructures[
                  `${nextEntry.database}|${nextEntry.table}`
                ] ?? null)
              : wasActive
                ? null
                : state.tableStructure,
          selectedTableInfo:
            nextEntry?.type === "table"
              ? (newTableInfos[`${nextEntry.database}|${nextEntry.table}`] ??
                null)
              : wasActive
                ? null
                : state.selectedTableInfo,
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
      }
    );
  },

  truncateTable: async (connId: string, database: string, table: string) => {
    const mutation = await mutateSchema(connId, database, () =>
      api.truncateTable(connId, database, table)
    );
    if (!mutation) return;
    await mutation.read(
      [["tables", database]],
      () => api.listTables(connId, database),
      (tableList) => {
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
        useTableDataStore
          .getState()
          .afterTableDataCleared(connId, database, table);
      }
    );
  },

  refresh: async (connId: string) => {
    invalidateSqlCompletion({ connId, reason: "refresh" });
    const state = get().connectionStates[connId] ?? emptyConnState();
    const { selectedDatabase, selectedTable } = state;
    const catalogDatabases = [
      ...new Set([
        ...Object.keys(state.tables),
        ...(selectedDatabase ? [selectedDatabase] : []),
      ]),
    ];
    const selectedEntry = state.openTabs[state.activeTabIndex];
    const selection = selectionRequests.get(connId);
    const sameSelection = () => {
      const latest = get().connectionStates[connId];
      return (
        latest?.selectedDatabase === selectedDatabase &&
        latest?.selectedTable === selectedTable &&
        latest?.openTabs[latest.activeTabIndex] === selectedEntry &&
        selectionRequests.get(connId) === selection
      );
    };
    const resources: MetadataResource[] = [
      ["databases"],
      ...catalogDatabases.map(
        (database): MetadataResource => ["tables", database]
      ),
      ...(selectedDatabase && selectedTable
        ? [["structure", selectedDatabase, selectedTable] as const]
        : []),
    ];
    const read = createMetadataRead(
      connId,
      undefined,
      resources,
      (resource) => resource[0] !== "structure" || sameSelection()
    );
    const treeRequest = beginMetadataLoading(connId, "treeLoading");
    let structureRequest: object | undefined;
    if (get().activeConnId === connId) set({ treeLoading: true });
    try {
      // 等后端缓存失效后开始读取；后续 DDL 只触发有限补读，不重复失效或执行 DDL。
      await api.invalidateTableMetadataCache(connId);
      await read.read(
        async (owns) => {
          const databases = owns(["databases"])
            ? await api.listDatabases(connId)
            : (get().connectionStates[connId]?.databases ?? []);
          if (!read.ownsAny()) return;
          const available = new Set(databases);
          const databasesToRefresh = catalogDatabases.filter(
            (database) => available.has(database) && owns(["tables", database])
          );
          const entries = await api.listTablesBatch(connId, databasesToRefresh);
          if (!read.ownsAny()) return;
          let structure: ColumnInfo[] | undefined;
          if (
            selectedDatabase &&
            selectedTable &&
            available.has(selectedDatabase) &&
            owns(["structure", selectedDatabase, selectedTable])
          ) {
            structureRequest = beginMetadataLoading(connId, "structureLoading");
            if (get().activeConnId === connId)
              set({ structureLoading: true, structureError: null });
            structure = await api.getTableStructure(
              connId,
              selectedDatabase,
              selectedTable
            );
          }
          return { databases, entries, structure, available };
        },
        (result, owns) => {
          if (!result) return;
          const { databases, entries, structure, available } = result;
          set((current) => {
            const latest = current.connectionStates[connId] ?? emptyConnState();
            const tables = Object.fromEntries(
              Object.entries(latest.tables).filter(
                ([database]) =>
                  !owns(["tables", database]) || available.has(database)
              )
            );
            for (const entry of entries) {
              if (
                owns(["tables", entry.database]) &&
                latest.tables[entry.database] === state.tables[entry.database]
              ) {
                tables[entry.database] = entry.tables;
              }
            }
            const updated = {
              ...latest,
              databases: owns(["databases"]) ? databases : latest.databases,
              tables,
            };
            if (
              structure &&
              selectedDatabase &&
              selectedTable &&
              owns(["structure", selectedDatabase, selectedTable]) &&
              loadingRequests.structureLoading.get(connId) === structureRequest
            ) {
              const info =
                tables[selectedDatabase]?.find(
                  (table) => table.name === selectedTable
                ) ?? null;
              const key = `${selectedDatabase}|${selectedTable}`;
              updated.tableStructure = structure;
              updated.selectedTableInfo = info;
              updated.tableStructures = {
                ...latest.tableStructures,
                [key]: structure,
              };
              updated.tableInfos = {
                ...latest.tableInfos,
                ...(info ? { [key]: info } : {}),
              };
            }
            return {
              connectionStates: {
                ...current.connectionStates,
                [connId]: updated,
              },
              ...(current.activeConnId === connId
                ? syncCurrentView(updated)
                : {}),
            };
          });
        }
      );
    } catch (error) {
      if (!read.ownsAny()) return;
      if (error instanceof MetadataRefreshRequiredError) throw error;
      console.error("刷新失败:", error);
    } finally {
      finishMetadataLoading(connId, "treeLoading", treeRequest);
      if (structureRequest)
        finishMetadataLoading(connId, "structureLoading", structureRequest);
    }
  },

  loadDatabaseInfo: async (connId: string, database: string) => {
    const generation = getMetadataRequestGeneration(connId, [database]);
    const isCurrent = () =>
      generation === getMetadataRequestGeneration(connId, [database]);
    try {
      set({ databaseInfoLoading: true, databaseInfo: null });
      const info = await api.getDatabaseInfo(connId, database);
      if (!isCurrent()) return;

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
      if (!isCurrent()) return;
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
    const mutation = await mutateSchema(connId, undefined, () =>
      api.createDatabase(connId, name, characterSet, collation)
    );
    if (!mutation) return;
    await mutation.read(
      [["databases"]],
      () => api.listDatabases(connId),
      (databases) => {
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
      }
    );
  },

  dropDatabase: async (connId: string, database: string) => {
    const mutation = await mutateSchema(connId, undefined, () =>
      api.dropDatabase(connId, database)
    );
    if (!mutation) return;
    await mutation.read(
      [["databases"]],
      () => api.listDatabases(connId),
      (databases) => {
        const { connectionStates, activeConnId } = get();
        const state = connectionStates[connId] ?? emptyConnState();
        const openTabs = state.openTabs ?? [];

        const newOpenTabs = openTabs.filter(
          (e) => !(e.type === "table" && e.database === database)
        );
        const newOpenTables = newOpenTabs
          .filter(
            (t): t is { type: "table"; database: string; table: string } =>
              t.type === "table"
          )
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
        newIdx = Math.max(
          0,
          Math.min(newIdx, Math.max(0, newOpenTabs.length - 1))
        );

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

        const newExpandedKeys = state.expandedKeys.filter(
          (k) => k !== `db:${database}`
        );

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
              ? (newTableStructures[
                  `${nextEntry.database}|${nextEntry.table}`
                ] ?? null)
              : null
            : state.tableStructure,
          selectedTableInfo: hadSelectionInDroppedDb
            ? nextEntry?.type === "table"
              ? (newTableInfos[`${nextEntry.database}|${nextEntry.table}`] ??
                null)
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
      }
    );
  },

  editDatabase: async (
    connId: string,
    database: string,
    characterSet: string,
    collation: string
  ) => {
    const mutation = await mutateSchema(connId, database, () =>
      api.alterDatabaseCharset(connId, database, characterSet, collation)
    );
    if (!mutation) return;
  },

  renameDatabase: async (
    connId: string,
    oldName: string,
    newName: string,
    characterSet: string,
    collation: string
  ) => {
    const mutation = await mutateSchema(connId, undefined, () =>
      api.renameDatabase(connId, oldName, newName, characterSet, collation)
    );
    if (!mutation) return;
    await mutation.read(
      [["databases"]],
      () => api.listDatabases(connId),
      (databases) => {
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
          selectedDatabase:
            state.selectedDatabase === oldName
              ? newName
              : state.selectedDatabase,
        };
        const newStates = { ...connectionStates, [connId]: updated };
        const res: Partial<DatabaseState> = { connectionStates: newStates };
        if (activeConnId === connId) {
          Object.assign(res, syncCurrentView(updated));
        }
        set(res);
      }
    );
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

  setTableSearch: (connId, database, search) => {
    set((s) => {
      const state = s.connectionStates[connId] ?? emptyConnState();
      return {
        connectionStates: {
          ...s.connectionStates,
          [connId]: {
            ...state,
            tableSearchByDatabase: {
              ...state.tableSearchByDatabase,
              [database]: {
                ...(state.tableSearchByDatabase?.[database] ?? {
                  visible: false,
                  keyword: "",
                }),
                ...search,
              },
            },
          },
        },
      };
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
      treeLoading: loadingRequests.treeLoading.has(connId),
      structureLoading: loadingRequests.structureLoading.has(connId),
      ...(state
        ? syncCurrentView(state)
        : {
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
            sqlTabExecutions: {},
            viewMode: "tab",
            tableInfos: {},
            expandedKeys: [],
            databaseInfo: null,
          }),
    });
  },

  removeConnectionState: (connId: string) => {
    invalidateMetadataRequestScope(connId);
    selectionRequests.delete(connId);
    connectionLifetimes.delete(connId);
    metadataReadOwners.delete(connId);
    loadingRequests.treeLoading.delete(connId);
    loadingRequests.structureLoading.delete(connId);
    const { connectionStates, activeConnId } = get();
    const newStates = { ...connectionStates };
    delete newStates[connId];
    set({ connectionStates: newStates });
    if (activeConnId === connId) {
      set({
        activeConnId: null,
        treeLoading: false,
        structureLoading: false,
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
        sqlTabExecutions: {},
        viewMode: "tab",
        tableInfos: {},
        expandedKeys: [],
        structureError: null,
        databaseInfo: null,
      });
    }
  },

  reset: () => {
    selectionRequests.clear();
    connectionLifetimes.clear();
    metadataReadOwners.clear();
    loadingRequests.treeLoading.clear();
    loadingRequests.structureLoading.clear();
    for (const connId of Object.keys(get().connectionStates))
      invalidateMetadataRequestScope(connId);
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
      sqlTabExecutions: {},
      viewMode: "tab",
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

/** 回调只捕获身份，行从当前拥有方读取；同时释放兼容字段和执行上下文的数组别名。 */
function evictSqlResult(connId: string, tabId: string, cacheKey: string) {
  useDatabaseStore.setState((state) => {
    const conn = state.connectionStates[connId];
    const tab = conn?.sqlTabResults[tabId];
    if (!tab) return {};
    let changed = false;
    const statements = tab.statementResults?.map((statement) => {
      if (statement.cacheKey !== cacheKey || statement.retention === "evicted")
        return statement;
      changed = true;
      if (statement.result?.rows) statement.result.rows.length = 0;
      statement.retention = "evicted";
      return {
        ...statement,
        result: statement.result ? { ...statement.result, rows: [] } : null,
      };
    });
    if (!changed) return {};
    const sqlTabResults = {
      ...conn.sqlTabResults,
      [tabId]: {
        ...tab,
        statementResults: statements,
        result: tab.result ? { ...tab.result, rows: tab.result.rows } : null,
      },
    };
    return {
      connectionStates: {
        ...state.connectionStates,
        [connId]: { ...conn, sqlTabResults },
      },
      ...(state.activeConnId === connId ? { sqlTabResults } : {}),
    };
  });
}

let sqlCacheKeys = new Set<string>();
let visibleSqlKey: string | undefined;
let releaseVisibleSql: (() => void) | undefined;
useDatabaseStore.subscribe((state, previous) => {
  if (
    state.connectionStates === previous.connectionStates &&
    state.activeConnId === previous.activeConnId
  )
    return;
  const keys = new Set<string>();
  for (const conn of Object.values(state.connectionStates)) {
    for (const tab of Object.values(conn.sqlTabResults)) {
      for (const result of tab.statementResults ?? []) {
        if (result.cacheKey && result.retention !== "evicted")
          keys.add(result.cacheKey);
      }
    }
  }
  const conn = state.activeConnId
    ? state.connectionStates[state.activeConnId]
    : undefined;
  const tab =
    conn?.viewMode === "tab" ? conn.openTabs[conn.activeTabIndex] : undefined;
  const result = tab?.type === "sql" ? conn?.sqlTabResults[tab.id] : undefined;
  const visible = result?.statementResults?.[result.activeResultIndex ?? 0];
  const nextVisibleKey =
    visible?.retention !== "evicted" ? visible?.cacheKey : undefined;
  const previousRelease =
    nextVisibleKey !== visibleSqlKey ? releaseVisibleSql : undefined;
  if (nextVisibleKey !== visibleSqlKey) {
    visibleSqlKey = nextVisibleKey;
    releaseVisibleSql = nextVisibleKey
      ? resultCacheController.pin(nextVisibleKey)
      : undefined;
    if (nextVisibleKey) resultCacheController.touch(nextVisibleKey);
  }
  const removed = [...sqlCacheKeys].filter((key) => !keys.has(key));
  sqlCacheKeys = keys;
  for (const key of removed) resultCacheController.remove(key);
  previousRelease?.();
});
