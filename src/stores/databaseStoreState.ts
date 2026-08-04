import type {
  ColumnInfo,
  DatabaseInfo,
  TableInfo,
  SqlExecuteResult,
} from "../types";

/** 单个打开的表的标识 */
export interface OpenTableEntry {
  database: string;
  table: string;
}

/** 打开的标签页：表或独立 SQL */
export type OpenTabEntry =
  | { type: "table"; database: string; table: string }
  | { type: "sql"; id: string };

/**
 * 右侧主内容区视图模式：
 * - `overview`：浏览数据库概览（表列表），不由激活标签驱动
 * - `tab`：显示 openTabs[activeTabIndex] 对应的表内容或 SQL 编辑器
 */
export type ViewMode = "overview" | "tab";

/** 单个连接的数据库状态 */
export interface ConnectionDatabaseState {
  databases: string[];
  tables: Record<string, TableInfo[]>;
  /** 打开的多个表（tab 列表）- 保留用于兼容，实际使用 openTabs */
  openTables: OpenTableEntry[];
  /** 当前激活的表 tab 索引 - 保留用于兼容 */
  activeTableTabIndex: number;
  /**  unified: 打开的标签页（表 + SQL） */
  openTabs: OpenTabEntry[];
  /** unified: 当前激活的 tab 索引 */
  activeTabIndex: number;
  /** SQL 标签页内容：id -> sql 文本 */
  sqlTabContents: Record<string, string>;
  /** SQL 标签页执行结果：id -> { result, error, executedSqlList } */
  sqlTabResults: Record<
    string,
    {
      result: SqlExecuteResult | null;
      error: string | null;
      executedSqlList: string[];
    }
  >;
  /** 侧边栏等对指定 SQL 标签页请求执行时的单调递增令牌（编辑器内监听 nonce 触发执行） */
  sqlTabExecuteNonce: Record<string, number>;
  /**
   * SQL 标签页运行中的执行状态：id -> { executionId }。
   * 存在即表示执行中；executionId 供「停止」按钮取消查询。
   * 放在 store 而非组件内，保证切换标签（编辑器卸载/重挂载）后执行中状态与取消能力不丢失。
   */
  sqlTabExecutions: Record<string, { executionId: string | null }>;
  /**
   * 右侧内容区视图模式。点击数据库进入 overview；打开/切换标签进入 tab。
   * 刷新、加载表列表等数据同步不得改变此模式，避免从概览跳回已打开标签。
   */
  viewMode: ViewMode;
  /** 按 database|table 缓存的表结构 */
  tableStructures: Record<string, ColumnInfo[]>;
  /** 按 database|table 缓存的表信息 */
  tableInfos: Record<string, TableInfo>;
  selectedDatabase: string | null;
  selectedTable: string | null;
  tableStructure: ColumnInfo[] | null;
  selectedTableInfo: TableInfo | null;
  expandedKeys: string[];
  databaseSortOrder: "asc" | "desc";
  tableSortOrder: "asc" | "desc";
  databaseInfo: DatabaseInfo | null;
}

/** 构造空的单连接数据库状态 */
export const emptyConnState = (): ConnectionDatabaseState => ({
  databases: [],
  tables: {},
  openTables: [],
  activeTableTabIndex: 0,
  openTabs: [],
  activeTabIndex: 0,
  sqlTabContents: {},
  sqlTabResults: {},
  sqlTabExecuteNonce: {},
  sqlTabExecutions: {},
  viewMode: "tab",
  tableStructures: {},
  tableInfos: {},
  selectedDatabase: null,
  selectedTable: null,
  tableStructure: null,
  selectedTableInfo: null,
  expandedKeys: [],
  databaseSortOrder: "asc",
  tableSortOrder: "asc",
  databaseInfo: null,
});

function deriveOpenTables(openTabs: OpenTabEntry[]): OpenTableEntry[] {
  return openTabs
    .filter(
      (t): t is { type: "table"; database: string; table: string } =>
        t.type === "table"
    )
    .map((t) => ({ database: t.database, table: t.table }));
}

/**
 * 从 openTabs / viewMode 推导当前选中与标签派生状态。
 * overview 模式保留树上选中的数据库，不因激活标签覆盖为已打开的表。
 */
export function deriveSelectedFromOpenTabs(
  state: ConnectionDatabaseState
): Partial<ConnectionDatabaseState> {
  const openTabs = state.openTabs ?? [];
  const activeTabIndex = state.activeTabIndex ?? 0;
  const tableStructures = state.tableStructures ?? {};
  const tableInfos = state.tableInfos ?? {};
  const viewMode: ViewMode = state.viewMode ?? "tab";
  const openTables = deriveOpenTables(openTabs);
  const idx =
    openTabs.length === 0 ? 0 : Math.min(activeTabIndex, openTabs.length - 1);

  if (viewMode === "overview") {
    return {
      viewMode: "overview",
      selectedDatabase: state.selectedDatabase,
      selectedTable: null,
      tableStructure: null,
      selectedTableInfo: null,
      activeTabIndex: idx,
      // openTabs 为权威来源；仅有遗留 openTables 时保留之
      openTables:
        openTabs.length > 0 ? openTables : (state.openTables ?? []),
      activeTableTabIndex: state.activeTableTabIndex ?? 0,
    };
  }

  // tab 模式且无打开标签：不从标签推导选中态（保留树上的 selected*，与历史 sync 行为一致）
  if (openTabs.length === 0) {
    return {
      viewMode: "tab",
      openTables: [],
      activeTabIndex: 0,
      activeTableTabIndex: 0,
    };
  }

  const entry = openTabs[idx];
  if (entry.type !== "table") {
    return {
      viewMode: "tab",
      activeTabIndex: idx,
      openTables,
      activeTableTabIndex: openTabs
        .slice(0, idx)
        .filter((t) => t.type === "table").length,
    };
  }

  const key = `${entry.database}|${entry.table}`;
  return {
    viewMode: "tab",
    selectedDatabase: entry.database,
    selectedTable: entry.table,
    tableStructure: tableStructures[key] ?? null,
    selectedTableInfo: tableInfos[key] ?? null,
    activeTabIndex: idx,
    openTables,
    activeTableTabIndex: openTabs
      .slice(0, idx)
      .filter((t) => t.type === "table").length,
  };
}
