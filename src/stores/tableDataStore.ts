import { create } from "zustand";
import * as api from "../services/tauriCommands";
import type { TableSortField } from "../services/tauriCommands";
import type { WhereFilterConfig } from "../utils/whereFilterUtils";

export type { TableSortField };

/** 单表的快照数据，用于切换时恢复 */
interface TableDataSnapshot {
  columns: string[];
  rows: unknown[][];
  total: number;
  page: number;
  pageSize: number;
  /** 排序键列表，顺序即为 ORDER BY 优先级 */
  sortFields: TableSortField[];
  whereClause: string;
  /** 筛选器 UI 的行配置，用于标签页/表切换后恢复输入框 */
  filterRows: WhereFilterConfig[];
  dataError: string | null;
  executionTime: number | null;
  lastSelectColumns: string[] | undefined;
  /** 增删改后总数可能已过期，需手动刷新分页 */
  totalCountStale?: boolean;
}

/** 一条待提交的单元格修改记录 */
export interface PendingChange {
  /** 数据行索引，仅用于提交确认弹窗展示 */
  rowKey: number;
  /** 列名 */
  colName: string;
  /** 原始值 */
  oldValue: unknown;
  /** 新值 */
  newValue: unknown;
  /** 该行的主键值 */
  primaryKeys: Record<string, unknown>;
}

interface TableDataState {
  /** 当前表标识 connId|database|table */
  activeTableKey: string | null;
  /** 按表缓存的快照（切换时不重新加载） */
  tableDataCache: Record<string, TableDataSnapshot>;
  /** 按表缓存的待提交修改，key=connId|database|table */
  pendingChangesCache: Record<string, Record<string, PendingChange>>;
  /** 按表缓存的行勾选 key，避免组件重挂载后丢失 */
  rowSelectionCache: Record<string, string[]>;
  /** count 缓存：key=tableKey|whereClause，换页/排序时复用，不重复请求 */
  countCache: Record<string, number>;
  /** 列名列表 */
  columns: string[];
  /** 行数据 */
  rows: unknown[][];
  /** 满足条件的总行数 */
  total: number;
  /** 当前页码 (从 1 开始) */
  page: number;
  /** 每页行数 */
  pageSize: number;
  /** 排序字段（多列排序时按数组顺序） */
  sortFields: TableSortField[];
  /** WHERE 条件 */
  whereClause: string;
  /** 筛选器行配置（用于切换表/标签页后恢复 UI） */
  filterRows: WhereFilterConfig[];
  /** 是否正在加载数据 */
  dataLoading: boolean;
  /** 是否正在加载总数（与数据分离请求时，count 可能晚于数据返回） */
  totalCountLoading: boolean;
  /** 增删改后总数可能已过期，需手动刷新分页 */
  totalCountStale: boolean;
  /** 数据加载错误 */
  dataError: string | null;
  /** 最近一次查询耗时 (毫秒) */
  executionTime: number | null;
  /** 最近一次查询使用的 selectColumns（用于后续 reload 保持一致） */
  lastSelectColumns: string[] | undefined;
  /** 筛选触发计数器：每次 setWhereClause 调用时递增，确保相同条件也能触发重新加载 */
  _filterTrigger: number;

  // Actions
  /** 加载表数据，selectColumns 为可见列列表（后端自动合并主键列），为空时 SELECT * */
  loadData: (connId: string, database: string, table: string, selectColumns?: string[]) => Promise<void>;
  /** 仅重新统计总行数（刷新分页），不重新加载当前页数据 */
  refreshPagination: (
    connId: string,
    database: string,
    table: string
  ) => Promise<void>;
  /** 切换页码 */
  setPage: (page: number) => void;
  /** 切换每页大小 */
  setPageSize: (size: number) => void;
  /**
   * 设置排序（单列表便捷方法，会覆盖多列排序）
   */
  setSort: (column: string | undefined, order: "ASC" | "DESC" | undefined) => void;
  /**
   * 表头排序交互：additive=false 时与原先单击一致（主序列循环 DESC→ASC→清除）；
   * additive=true（如按住 Shift）时在末尾追加次要排序键，或对已存在列在其位置上循环 DESC→ASC→移除该项。
   */
  toggleSortColumn: (column: string, additive: boolean) => void;
  /** 从多列排序中移除指定列（其余顺序不变） */
  removeSortField: (column: string) => void;
  /** 将 sortFields 中下标为 index 的项与相邻项交换（-1 前移，+1 后移） */
  shiftSortFieldPriority: (index: number, direction: -1 | 1) => void;
  /** 设置 WHERE 条件；可选传入筛选行配置以在切换表/标签页后恢复 UI */
  setWhereClause: (clause: string, filterRows?: WhereFilterConfig[]) => void;
  /** 更新一行 (保存到后端) */
  updateCell: (
    connId: string,
    database: string,
    table: string,
    primaryKeys: Record<string, unknown>,
    updates: Record<string, unknown>
  ) => Promise<void>;
  /**
   * 在单个事务中批量更新多行（任一行失败则整批回滚）。成功后刷新当前页。
   * 失败时抛出错误，由调用方决定如何提示，且不会发生部分提交。
   */
  batchUpdateCells: (
    connId: string,
    database: string,
    table: string,
    rows: { primaryKeys: Record<string, unknown>; updates: Record<string, unknown> }[]
  ) => Promise<void>;
  /** 插入新行 */
  insertRow: (
    connId: string,
    database: string,
    table: string,
    values: Record<string, unknown>
  ) => Promise<void>;
  /** 删除多行 */
  deleteRows: (
    connId: string,
    database: string,
    table: string,
    primaryKeys: Record<string, unknown>[]
  ) => Promise<void>;
  /** 重置状态 */
  reset: () => void;
  /** 切换到指定表，恢复缓存或准备加载；返回是否从缓存恢复（无需 reload） */
  switchToTable: (connId: string, database: string, table: string) => boolean;
  /**
   * TRUNCATE 等清空表数据后：清除该表 count 缓存；若当前数据视图正是此表则重新 loadData。
   */
  afterTableDataCleared: (connId: string, database: string, table: string) => void;
  /** 关闭表时从缓存移除 */
  removeTableFromCache: (connId: string, database: string, table: string) => void;
  /** 连接断开时移除该连接下所有缓存，保留其他连接标签页内容 */
  removeConnectionCache: (connId: string) => void;
  /** 设置指定表的一条待提交修改 */
  setPendingChange: (
    connId: string,
    database: string,
    table: string,
    changeKey: string,
    change: PendingChange
  ) => void;
  /** 移除指定表的一条待提交修改 */
  removePendingChange: (
    connId: string,
    database: string,
    table: string,
    changeKey: string
  ) => void;
  /** 清空指定表的待提交修改 */
  clearPendingChanges: (connId: string, database: string, table: string) => void;
  /** 获取指定表的待提交修改 Map */
  getPendingChangesForTable: (
    connId: string,
    database: string,
    table: string
  ) => Map<string, PendingChange>;
  /** 更新指定表的行勾选缓存 */
  setRowSelection: (connId: string, database: string, table: string, rowKeys: string[]) => void;
  /** 清空指定表的行勾选缓存 */
  clearRowSelection: (connId: string, database: string, table: string) => void;
}

function tableKey(connId: string, database: string, table: string): string {
  return `${connId}|${database}|${table}`;
}

/** count 的缓存 key：仅表+whereClause 决定总数，换页/排序不变化 */
function countCacheKey(key: string, whereClause: string): string {
  return `${key}|${whereClause}`;
}

/** 重新加载某张表数据时分页/筛选参数：当前视图即该表时用全局状态，否则用该表快照（避免切换标签后误用其它表的 page/where） */
type ReloadQueryParams = Pick<
  TableDataSnapshot,
  "page" | "pageSize" | "sortFields" | "whereClause" | "filterRows" | "lastSelectColumns"
>;

function getReloadQueryParams(
  get: () => TableDataState,
  connId: string,
  database: string,
  table: string
): ReloadQueryParams {
  const key = tableKey(connId, database, table);
  const s = get();
  if (s.activeTableKey === key) {
    return {
      page: s.page,
      pageSize: s.pageSize,
      sortFields: s.sortFields,
      whereClause: s.whereClause,
      filterRows: s.filterRows,
      lastSelectColumns: s.lastSelectColumns,
    };
  }
  const cached = s.tableDataCache[key];
  if (cached) {
    return {
      page: cached.page,
      pageSize: cached.pageSize,
      sortFields: cached.sortFields ?? [],
      whereClause: cached.whereClause,
      filterRows: cached.filterRows ?? [],
      lastSelectColumns: cached.lastSelectColumns,
    };
  }
  return {
    page: s.page,
    pageSize: s.pageSize,
    sortFields: s.sortFields,
    whereClause: s.whereClause,
    filterRows: s.filterRows,
    lastSelectColumns: s.lastSelectColumns,
  };
}

function applyCrudDataReload(
  set: (
    partial:
      | Partial<TableDataState>
      | ((state: TableDataState) => Partial<TableDataState>)
  ) => void,
  get: () => TableDataState,
  key: string,
  rp: ReloadQueryParams,
  result: { columns: string[]; rows: unknown[][]; execution_time_ms: number }
) {
  const ccKey = countCacheKey(key, rp.whereClause);
  const prevTotal =
    get().tableDataCache[key]?.total ??
    (get().activeTableKey === key ? get().total : 0);

  const snapshot: TableDataSnapshot = {
    columns: result.columns,
    rows: result.rows,
    total: prevTotal,
    page: rp.page,
    pageSize: rp.pageSize,
    sortFields: rp.sortFields,
    whereClause: rp.whereClause,
    filterRows: rp.filterRows,
    dataError: null,
    executionTime: result.execution_time_ms,
    lastSelectColumns: rp.lastSelectColumns,
    totalCountStale: true,
  };

  set((s) => {
    const nextCount = { ...s.countCache };
    delete nextCount[ccKey];
    const nextCache = { ...s.tableDataCache, [key]: snapshot };
    const navigatedAway = s.activeTableKey !== null && s.activeTableKey !== key;
    if (navigatedAway) {
      return { tableDataCache: nextCache, countCache: nextCount };
    }
    return {
      columns: result.columns,
      rows: result.rows,
      total: prevTotal,
      executionTime: result.execution_time_ms,
      dataLoading: false,
      dataError: null,
      totalCountStale: true,
      tableDataCache: nextCache,
      countCache: nextCount,
    };
  });
}

async function reloadAfterMutation(
  set: (
    partial:
      | Partial<TableDataState>
      | ((state: TableDataState) => Partial<TableDataState>)
  ) => void,
  get: () => TableDataState,
  connId: string,
  database: string,
  table: string,
  key: string
) {
  const rp = getReloadQueryParams(get, connId, database, table);
  const result = await api.queryTableData(
    connId,
    database,
    table,
    rp.page,
    rp.pageSize,
    rp.sortFields.length > 0 ? rp.sortFields : undefined,
    rp.whereClause || undefined,
    rp.lastSelectColumns,
    true
  );
  applyCrudDataReload(set, get, key, rp, result);
}

const initialSlice = {
  columns: [] as string[],
  rows: [] as unknown[][],
  total: 0,
  page: 1,
  pageSize: 50,
  sortFields: [] as TableSortField[],
  whereClause: "",
  filterRows: [] as WhereFilterConfig[],
  dataError: null as string | null,
  executionTime: null as number | null,
  lastSelectColumns: undefined as string[] | undefined,
  _filterTrigger: 0,
};

let _loadCounter = 0;

export const useTableDataStore = create<TableDataState>((set, get) => ({
  activeTableKey: null,
  tableDataCache: {},
  pendingChangesCache: {},
  rowSelectionCache: {},
  countCache: {},
  ...initialSlice,
  dataLoading: false,
  totalCountLoading: false,
  totalCountStale: false,

  loadData: async (connId: string, database: string, table: string, selectColumns?: string[]) => {
    const { page, pageSize, sortFields, whereClause, countCache } = get();
    const key = tableKey(connId, database, table);
    const ccKey = countCacheKey(key, whereClause);
    const cachedTotal = countCache[ccKey];
    const myLoadId = ++_loadCounter;

    set({
      dataLoading: true,
      totalCountLoading: cachedTotal === undefined,
      dataError: null,
      lastSelectColumns: selectColumns,
      activeTableKey: key,
    });

    if (cachedTotal !== undefined) {
      set({ total: cachedTotal, totalCountLoading: false });
    }

    const dataPromise = api.queryTableData(
      connId,
      database,
      table,
      page,
      pageSize,
      sortFields.length > 0 ? sortFields : undefined,
      whereClause || undefined,
      selectColumns,
      true
    );

    const countPromise =
      cachedTotal !== undefined
        ? Promise.resolve(cachedTotal)
        : api.queryTableCount(connId, database, table, whereClause || undefined);

    const isLatest = () => _loadCounter === myLoadId;

    dataPromise
      .then((result) => {
        if (!isLatest()) return;
        const totalForSnapshot = cachedTotal ?? 0;
        const snapshot: TableDataSnapshot = {
          columns: result.columns,
          rows: result.rows,
          total: totalForSnapshot,
          page,
          pageSize,
          sortFields,
          whereClause,
          filterRows: get().filterRows,
          dataError: null,
          executionTime: result.execution_time_ms,
          lastSelectColumns: selectColumns,
        };
        set((s) => ({
          columns: result.columns,
          rows: result.rows,
          executionTime: result.execution_time_ms,
          dataLoading: false,
          tableDataCache: { ...s.tableDataCache, [key]: snapshot },
        }));
      })
      .catch((e) => {
        if (!isLatest()) return;
        const msg = String(e);
        console.error("加载表数据失败:", msg);
        set({ dataLoading: false, totalCountLoading: false, dataError: msg });
      });

    if (cachedTotal !== undefined) return;

    countPromise
      .then((total) => {
        if (!isLatest()) return;
        set((s) => ({
          total,
          totalCountLoading: false,
          totalCountStale: false,
          countCache: { ...s.countCache, [ccKey]: total },
          tableDataCache: s.tableDataCache[key]
            ? {
                ...s.tableDataCache,
                [key]: { ...s.tableDataCache[key], total, totalCountStale: false },
              }
            : s.tableDataCache,
        }));
      })
      .catch(() => {
        if (!isLatest()) return;
        set({ totalCountLoading: false });
      });
  },

  refreshPagination: async (connId: string, database: string, table: string) => {
    const key = tableKey(connId, database, table);
    const { whereClause, activeTableKey } = get();
    const ccKey = countCacheKey(key, whereClause);
    const isActive = activeTableKey === key;

    if (isActive) {
      set({ totalCountLoading: true });
    }

    try {
      const total = await api.queryTableCount(
        connId,
        database,
        table,
        whereClause || undefined
      );
      set((s) => {
        const nextCount = { ...s.countCache, [ccKey]: total };
        const cached = s.tableDataCache[key];
        const nextTableCache =
          cached != null
            ? {
                ...s.tableDataCache,
                [key]: { ...cached, total, totalCountStale: false },
              }
            : s.tableDataCache;

        if (!isActive) {
          return { countCache: nextCount, tableDataCache: nextTableCache };
        }

        const maxPage = Math.max(1, Math.ceil(total / s.pageSize));
        const nextPage = s.page > maxPage ? maxPage : s.page;

        return {
          total,
          totalCountLoading: false,
          totalCountStale: false,
          countCache: nextCount,
          tableDataCache: nextTableCache,
          page: nextPage,
        };
      });
    } catch (e) {
      console.error("刷新分页失败:", e);
      if (isActive) {
        set({ totalCountLoading: false });
      }
      throw e;
    }
  },

  setPage: (page: number) => {
    set({ page });
  },

  setPageSize: (size: number) => {
    set({ pageSize: size, page: 1 });
  },

  setSort: (column, order) => {
    if (!column || !order) {
      set({ sortFields: [], page: 1 });
    } else {
      set({ sortFields: [{ column, order }], page: 1 });
    }
  },

  toggleSortColumn: (column: string, additive: boolean) => {
    set((s) => {
      const prev = s.sortFields;
      let next: TableSortField[];
      if (additive) {
        const idx = prev.findIndex((f) => f.column === column);
        if (idx < 0) {
          next = [...prev, { column, order: "DESC" }];
        } else {
          const cur = prev[idx]!;
          if (cur.order === "DESC") {
            next = prev.map((f, i) => (i === idx ? { ...f, order: "ASC" as const } : f));
          } else {
            next = prev.filter((_, i) => i !== idx);
          }
        }
      } else {
        const first = prev[0];
        if (prev.length === 0 || first?.column !== column) {
          next = [{ column, order: "DESC" }];
        } else if (first.order === "DESC") {
          next = [{ column, order: "ASC" }];
        } else {
          next = [];
        }
      }
      return { sortFields: next, page: 1 };
    });
  },

  removeSortField: (column: string) => {
    set((s) => {
      const next = s.sortFields.filter((f) => f.column !== column);
      if (next.length === s.sortFields.length) return {};
      return { sortFields: next, page: 1 };
    });
  },

  shiftSortFieldPriority: (index: number, direction: -1 | 1) => {
    set((s) => {
      const prev = s.sortFields;
      const j = index + direction;
      if (index < 0 || index >= prev.length || j < 0 || j >= prev.length) return {};
      const next = [...prev];
      [next[index], next[j]] = [next[j]!, next[index]!];
      return { sortFields: next, page: 1 };
    });
  },

  setWhereClause: (clause: string, filterRows?: WhereFilterConfig[]) => {
    set((s) => ({
      whereClause: clause,
      page: 1,
      filterRows:
        filterRows !== undefined ? filterRows : clause ? s.filterRows : [],
      _filterTrigger: s._filterTrigger + 1,
    }));
  },

  updateCell: async (connId, database, table, primaryKeys, updates) => {
    const key = tableKey(connId, database, table);
    try {
      set({ dataLoading: true, dataError: null });
      await api.updateRow(connId, database, table, primaryKeys, updates);
      await reloadAfterMutation(set, get, connId, database, table, key);
    } catch (e) {
      const msg = String(e);
      console.error("更新数据失败:", msg);
      set((s) => {
        const navigatedAway =
          s.activeTableKey !== null && s.activeTableKey !== key;
        if (navigatedAway) return {};
        return { dataLoading: false, dataError: msg };
      });
    }
  },

  batchUpdateCells: async (connId, database, table, rows) => {
    const key = tableKey(connId, database, table);
    set({ dataLoading: true, dataError: null });
    try {
      await api.batchUpdateRows(connId, database, table, rows);
      await reloadAfterMutation(set, get, connId, database, table, key);
    } catch (e) {
      const msg = String(e);
      console.error("批量更新数据失败:", msg);
      set((s) => {
        const navigatedAway =
          s.activeTableKey !== null && s.activeTableKey !== key;
        if (navigatedAway) return {};
        return { dataLoading: false, dataError: msg };
      });
      // 重新抛出，让调用方区分「全成功」与「整批回滚」并据此决定是否清空待提交
      throw e;
    }
  },

  insertRow: async (connId, database, table, values) => {
    const key = tableKey(connId, database, table);
    try {
      set({ dataLoading: true, dataError: null });
      await api.insertRow(connId, database, table, values);
      await reloadAfterMutation(set, get, connId, database, table, key);
    } catch (e) {
      const msg = String(e);
      console.error("插入数据失败:", msg);
      set((s) => {
        const navigatedAway =
          s.activeTableKey !== null && s.activeTableKey !== key;
        if (navigatedAway) return {};
        return { dataLoading: false, dataError: msg };
      });
    }
  },

  deleteRows: async (connId, database, table, primaryKeys) => {
    const key = tableKey(connId, database, table);
    try {
      set({ dataLoading: true, dataError: null });
      await api.deleteRows(connId, database, table, primaryKeys);
      await reloadAfterMutation(set, get, connId, database, table, key);
    } catch (e) {
      const msg = String(e);
      console.error("删除数据失败:", msg);
      set((s) => {
        const navigatedAway =
          s.activeTableKey !== null && s.activeTableKey !== key;
        if (navigatedAway) return {};
        return { dataLoading: false, dataError: msg };
      });
    }
  },

  reset: () => {
    set({
      activeTableKey: null,
      tableDataCache: {},
      pendingChangesCache: {},
      rowSelectionCache: {},
      countCache: {},
      ...initialSlice,
      dataLoading: false,
      totalCountLoading: false,
      totalCountStale: false,
    });
  },

  switchToTable: (connId: string, database: string, table: string) => {
    const key = tableKey(connId, database, table);
    const { activeTableKey, tableDataCache } = get();

    const snapshot: TableDataSnapshot = {
      columns: get().columns,
      rows: get().rows,
      total: get().total,
      page: get().page,
      pageSize: get().pageSize,
      sortFields: get().sortFields,
      whereClause: get().whereClause,
      filterRows: get().filterRows,
      dataError: get().dataError,
      executionTime: get().executionTime,
      lastSelectColumns: get().lastSelectColumns,
      totalCountStale: get().totalCountStale,
    };

    let newCache = tableDataCache;
    if (activeTableKey && activeTableKey !== key && (get().rows.length > 0 || get().columns.length > 0)) {
      newCache = { ...tableDataCache, [activeTableKey]: snapshot };
    }

    const cached = newCache[key];
    if (cached) {
      const ccKey = countCacheKey(key, cached.whereClause);
      set((s) => ({
        activeTableKey: key,
        tableDataCache: newCache,
        columns: cached.columns,
        rows: cached.rows,
        total: cached.total,
        page: cached.page,
        pageSize: cached.pageSize,
        sortFields: cached.sortFields ?? [],
        whereClause: cached.whereClause,
        filterRows: cached.filterRows ?? [],
        dataError: cached.dataError,
        executionTime: cached.executionTime,
        lastSelectColumns: cached.lastSelectColumns,
        dataLoading: false,
        totalCountLoading: false,
        totalCountStale: cached.totalCountStale ?? false,
        countCache: cached.total > 0 ? { ...s.countCache, [ccKey]: cached.total } : s.countCache,
      }));
      return true;
    }

    set({
      activeTableKey: key,
      tableDataCache: newCache,
      ...initialSlice,
      dataLoading: false,
    });
    return false;
  },

  afterTableDataCleared: (connId, database, table) => {
    const tk = tableKey(connId, database, table);
    const prefix = `${tk}|`;
    set((s) => {
      const nextCount = { ...s.countCache };
      for (const k of Object.keys(nextCount)) {
        if (k.startsWith(prefix)) {
          delete nextCount[k];
        }
      }
      const nextTableCache = { ...s.tableDataCache };
      const nextPendingChangesCache = { ...s.pendingChangesCache };
      const nextRowSelectionCache = { ...s.rowSelectionCache };
      delete nextTableCache[tk];
      delete nextPendingChangesCache[tk];
      delete nextRowSelectionCache[tk];
      return {
        countCache: nextCount,
        tableDataCache: nextTableCache,
        pendingChangesCache: nextPendingChangesCache,
        rowSelectionCache: nextRowSelectionCache,
      };
    });
    const { activeTableKey, lastSelectColumns } = get();
    if (activeTableKey === tk) {
      void get().loadData(connId, database, table, lastSelectColumns);
    }
  },

  removeTableFromCache: (connId: string, database: string, table: string) => {
    const key = tableKey(connId, database, table);
    const { tableDataCache, pendingChangesCache, rowSelectionCache, countCache, activeTableKey } = get();
    const newCache = { ...tableDataCache };
    const newPendingChangesCache = { ...pendingChangesCache };
    const newRowSelectionCache = { ...rowSelectionCache };
    delete newCache[key];
    delete newPendingChangesCache[key];
    delete newRowSelectionCache[key];
    const prefix = `${key}|`;
    const newCountCache = Object.fromEntries(
      Object.entries(countCache).filter(([k]) => !k.startsWith(prefix))
    );
    set({
      tableDataCache: newCache,
      pendingChangesCache: newPendingChangesCache,
      rowSelectionCache: newRowSelectionCache,
      countCache: newCountCache,
    });
    if (activeTableKey === key) {
      set({ activeTableKey: null, ...initialSlice, dataLoading: false });
    }
  },

  removeConnectionCache: (connId: string) => {
    const prefix = `${connId}|`;
    const { activeTableKey } = get();
    set((s) => {
      const nextTableCache = Object.fromEntries(
        Object.entries(s.tableDataCache).filter(([k]) => !k.startsWith(prefix))
      );
      const nextPendingChangesCache = Object.fromEntries(
        Object.entries(s.pendingChangesCache).filter(([k]) => !k.startsWith(prefix))
      );
      const nextRowSelectionCache = Object.fromEntries(
        Object.entries(s.rowSelectionCache).filter(([k]) => !k.startsWith(prefix))
      );
      const nextCountCache = Object.fromEntries(
        Object.entries(s.countCache).filter(([k]) => !k.startsWith(prefix))
      );
      const activeRemoved = Boolean(activeTableKey?.startsWith(prefix));
      return activeRemoved
        ? {
            activeTableKey: null,
            tableDataCache: nextTableCache,
            pendingChangesCache: nextPendingChangesCache,
            rowSelectionCache: nextRowSelectionCache,
            countCache: nextCountCache,
            ...initialSlice,
            dataLoading: false,
            totalCountLoading: false,
          }
        : {
            tableDataCache: nextTableCache,
            pendingChangesCache: nextPendingChangesCache,
            rowSelectionCache: nextRowSelectionCache,
            countCache: nextCountCache,
          };
    });
  },

  setPendingChange: (connId, database, table, changeKey, change) => {
    const key = tableKey(connId, database, table);
    set((s) => ({
      pendingChangesCache: {
        ...s.pendingChangesCache,
        [key]: {
          ...(s.pendingChangesCache[key] ?? {}),
          [changeKey]: change,
        },
      },
    }));
  },

  removePendingChange: (connId, database, table, changeKey) => {
    const key = tableKey(connId, database, table);
    set((s) => {
      const tablePending = s.pendingChangesCache[key];
      if (!tablePending || !(changeKey in tablePending)) return s;

      const nextTablePending = { ...tablePending };
      delete nextTablePending[changeKey];

      const nextPendingChangesCache = { ...s.pendingChangesCache };
      if (Object.keys(nextTablePending).length === 0) {
        delete nextPendingChangesCache[key];
      } else {
        nextPendingChangesCache[key] = nextTablePending;
      }

      return { pendingChangesCache: nextPendingChangesCache };
    });
  },

  clearPendingChanges: (connId, database, table) => {
    const key = tableKey(connId, database, table);
    set((s) => {
      if (!(key in s.pendingChangesCache)) return s;
      const nextPendingChangesCache = { ...s.pendingChangesCache };
      delete nextPendingChangesCache[key];
      return { pendingChangesCache: nextPendingChangesCache };
    });
  },

  getPendingChangesForTable: (connId, database, table) => {
    const key = tableKey(connId, database, table);
    return new Map(Object.entries(get().pendingChangesCache[key] ?? {}));
  },

  setRowSelection: (connId, database, table, rowKeys) => {
    const key = tableKey(connId, database, table);
    set((s) => ({
      rowSelectionCache: { ...s.rowSelectionCache, [key]: rowKeys },
    }));
  },

  clearRowSelection: (connId, database, table) => {
    const key = tableKey(connId, database, table);
    set((s) => {
      if (!(key in s.rowSelectionCache)) return s;
      const nextRowSelectionCache = { ...s.rowSelectionCache };
      delete nextRowSelectionCache[key];
      return { rowSelectionCache: nextRowSelectionCache };
    });
  },
}));
