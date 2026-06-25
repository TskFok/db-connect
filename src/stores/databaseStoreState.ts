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
  /** 在 SQL 标签页时点击了数据库，应展示表列表而非 SQL 编辑器 */
  showDatabaseOverviewWhenSqlActive: boolean;
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
  showDatabaseOverviewWhenSqlActive: false,
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

/** 从 openTabs 推导当前选中状态（仅当激活 tab 为表时） */
export function deriveSelectedFromOpenTabs(
  state: ConnectionDatabaseState
): Partial<ConnectionDatabaseState> {
  const openTabs = state.openTabs ?? [];
  const activeTabIndex = state.activeTabIndex ?? 0;
  const tableStructures = state.tableStructures ?? {};
  const tableInfos = state.tableInfos ?? {};
  if (openTabs.length === 0) {
    return {
      selectedDatabase: null,
      selectedTable: null,
      tableStructure: null,
      selectedTableInfo: null,
    };
  }
  const idx = Math.min(activeTabIndex, openTabs.length - 1);
  const entry = openTabs[idx];
  if (entry.type !== "table") {
    return { activeTabIndex: idx };
  }
  const key = `${entry.database}|${entry.table}`;
  return {
    selectedDatabase: entry.database,
    selectedTable: entry.table,
    tableStructure: tableStructures[key] ?? null,
    selectedTableInfo: tableInfos[key] ?? null,
    activeTabIndex: idx,
    openTables: openTabs
      .filter(
        (t): t is { type: "table"; database: string; table: string } =>
          t.type === "table"
      )
      .map((t) => ({ database: t.database, table: t.table })),
    activeTableTabIndex: openTabs
      .slice(0, idx)
      .filter((t) => t.type === "table").length,
  };
}
