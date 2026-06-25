import { create } from "zustand";
import { persist } from "zustand/middleware";
import { LIST_TABLE_IDS } from "../utils/listTableColumns";

/** 空闲超时选项（分钟），0 表示不自动断开 */
export const IDLE_TIMEOUT_OPTIONS = [
  { value: 0, label: "永不" },
  { value: 5, label: "5 分钟" },
  { value: 10, label: "10 分钟" },
  { value: 15, label: "15 分钟" },
  { value: 30, label: "30 分钟" },
  { value: 60, label: "1 小时" },
] as const;

/** 侧边栏宽度范围 */
export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 280;

/** 列表表格列宽范围 */
export const TABLE_LIST_COL_WIDTH_MIN = 60;
export const TABLE_LIST_COL_WIDTH_MAX = 800;

export interface ListTableSettings {
  columnWidths: Record<string, number>;
  columnOrder: string[];
}

interface SettingsState {
  /** 空闲超时断开时间（分钟），0 表示禁用 */
  idleTimeoutMinutes: number;
  /** 设置空闲超时 */
  setIdleTimeoutMinutes: (minutes: number) => void;
  /** 左侧边栏宽度（px） */
  sidebarWidth: number;
  /** 设置左侧边栏宽度 */
  setSidebarWidth: (width: number) => void;
  /** 各 antd 列表的列宽与列顺序设置 */
  listTableSettings: Record<string, ListTableSettings>;
  /** 更新列表单列宽度 */
  setListTableColumnWidth: (
    listId: string,
    columnKey: string,
    width: number
  ) => void;
  /** 更新列表列顺序 */
  setListTableColumnOrder: (listId: string, order: string[]) => void;
}

const defaultListTableSettings: ListTableSettings = {
  columnWidths: {},
  columnOrder: [],
};

function clampListColumnWidth(width: number): number {
  return Math.min(
    TABLE_LIST_COL_WIDTH_MAX,
    Math.max(TABLE_LIST_COL_WIDTH_MIN, width)
  );
}

type PersistedSettingsV0 = {
  idleTimeoutMinutes?: number;
  sidebarWidth?: number;
  tableListColumnWidths?: Record<string, number>;
  listTableSettings?: Record<string, ListTableSettings>;
};

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      idleTimeoutMinutes: 15,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      listTableSettings: {},

      setIdleTimeoutMinutes: (minutes: number) => {
        set({ idleTimeoutMinutes: minutes });
      },

      setSidebarWidth: (width: number) => {
        set({
          sidebarWidth: Math.min(
            SIDEBAR_WIDTH_MAX,
            Math.max(SIDEBAR_WIDTH_MIN, width)
          ),
        });
      },

      setListTableColumnWidth: (
        listId: string,
        columnKey: string,
        width: number
      ) => {
        set((state) => {
          const current =
            state.listTableSettings[listId] ?? defaultListTableSettings;
          return {
            listTableSettings: {
              ...state.listTableSettings,
              [listId]: {
                ...current,
                columnWidths: {
                  ...current.columnWidths,
                  [columnKey]: clampListColumnWidth(width),
                },
              },
            },
          };
        });
      },

      setListTableColumnOrder: (listId: string, order: string[]) => {
        set((state) => {
          const current =
            state.listTableSettings[listId] ?? defaultListTableSettings;
          return {
            listTableSettings: {
              ...state.listTableSettings,
              [listId]: {
                ...current,
                columnOrder: order,
              },
            },
          };
        });
      },
    }),
    {
      name: "db-connect-settings",
      version: 1,
      migrate: (persistedState, version) => {
        const state = persistedState as PersistedSettingsV0;
        if (version === 0) {
          const legacyWidths = state.tableListColumnWidths ?? {};
          const existing = state.listTableSettings ?? {};
          if (Object.keys(legacyWidths).length > 0) {
            return {
              ...state,
              listTableSettings: {
                ...existing,
                [LIST_TABLE_IDS.DATABASE_TABLE_LIST]: {
                  columnWidths: legacyWidths,
                  columnOrder:
                    existing[LIST_TABLE_IDS.DATABASE_TABLE_LIST]?.columnOrder ??
                    [],
                },
              },
              tableListColumnWidths: undefined,
            };
          }
        }
        return state;
      },
    }
  )
);
