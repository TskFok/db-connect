import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  deleteTableColumnSettings,
  getTableColumnSettings,
  saveTableColumnSettings,
} from "../services/tauriCommands";

const PERSIST_KEY = "db-connect-table-column-settings";

/** Tauri 文件存储 + 非 Tauri 环境回退到 localStorage */
const tableColumnSettingsStorage = createJSONStorage<{
  settings: Record<string, TableColumnSettings>;
}>(
  () => ({
    getItem: async (name: string): Promise<string | null> => {
      try {
        const result = await getTableColumnSettings();
        return result ?? null;
      } catch {
        return typeof localStorage !== "undefined"
          ? localStorage.getItem(name)
          : null;
      }
    },
    setItem: async (name: string, value: string): Promise<void> => {
      try {
        await saveTableColumnSettings(value);
      } catch {
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(name, value);
        }
      }
    },
    removeItem: async (name: string): Promise<void> => {
      try {
        await deleteTableColumnSettings();
      } catch {
        if (typeof localStorage !== "undefined") {
          localStorage.removeItem(name);
        }
      }
    },
  })
);

/** 生成表的持久化 key */
function tableKey(connId: string, database: string, table: string): string {
  return `${connId}|${database}|${table}`;
}

export interface TableColumnSettings {
  columnWidths: Record<string, number>;
  hiddenColumns: string[];
}

interface TableColumnSettingsState {
  /** 按 connId|database|table 为 key 的表列设置 */
  settings: Record<string, TableColumnSettings>;
  /** 获取指定表的列设置 */
  getSettings: (
    connId: string,
    database: string,
    table: string
  ) => TableColumnSettings;
  /** 更新列宽 */
  setColumnWidths: (
    connId: string,
    database: string,
    table: string,
    columnWidths: Record<string, number>
  ) => void;
  /** 更新列宽（单列） */
  setColumnWidth: (
    connId: string,
    database: string,
    table: string,
    colName: string,
    width: number
  ) => void;
  /** 更新隐藏列 */
  setHiddenColumns: (
    connId: string,
    database: string,
    table: string,
    hiddenColumns: string[]
  ) => void;
  /** 切换列可见性 */
  toggleColumnVisibility: (
    connId: string,
    database: string,
    table: string,
    colName: string,
    currentHidden: Set<string>
  ) => void;
  /** 清空指定表设置（用于表切换时的可选清理） */
  clearTableSettings: (
    connId: string,
    database: string,
    table: string
  ) => void;
}

const defaultSettings: TableColumnSettings = {
  columnWidths: {},
  hiddenColumns: [],
};

export const useTableColumnSettingsStore = create<TableColumnSettingsState>()(
  persist(
    (set, get) => ({
      settings: {},

      getSettings: (connId: string, database: string, table: string): TableColumnSettings => {
        const key = tableKey(connId, database, table);
        return (
          (get().settings[key] as TableColumnSettings | undefined) ?? { ...defaultSettings }
        );
      },

      setColumnWidths: (connId: string, database: string, table: string, columnWidths: Record<string, number>) => {
        const key = tableKey(connId, database, table);
        set((state) => ({
          settings: {
            ...state.settings,
            [key]: {
              ...(state.settings[key] ?? defaultSettings),
              columnWidths,
            },
          },
        }));
      },

      setColumnWidth: (connId: string, database: string, table: string, colName: string, width: number) => {
        const key = tableKey(connId, database, table);
        set((state) => {
          const current = state.settings[key] ?? defaultSettings;
          return {
            settings: {
              ...state.settings,
              [key]: {
                ...current,
                columnWidths: { ...current.columnWidths, [colName]: width },
              },
            },
          };
        });
      },

      setHiddenColumns: (connId: string, database: string, table: string, hiddenColumns: string[]) => {
        const key = tableKey(connId, database, table);
        set((state) => ({
          settings: {
            ...state.settings,
            [key]: {
              ...(state.settings[key] ?? defaultSettings),
              hiddenColumns,
            },
          },
        }));
      },

      toggleColumnVisibility: (connId: string, database: string, table: string, colName: string, currentHidden: Set<string>) => {
        const key = tableKey(connId, database, table);
        const nextHidden = new Set(currentHidden);
        if (nextHidden.has(colName)) {
          nextHidden.delete(colName);
        } else {
          nextHidden.add(colName);
        }
        set((state) => ({
          settings: {
            ...state.settings,
            [key]: {
              ...(state.settings[key] ?? defaultSettings),
              hiddenColumns: Array.from(nextHidden),
            },
          },
        }));
      },

      clearTableSettings: (connId: string, database: string, table: string) => {
        const key = tableKey(connId, database, table);
        set((state) => {
          const { [key]: _, ...rest } = state.settings;
          return { settings: rest };
        });
      },
    }),
    {
      name: PERSIST_KEY,
      storage: tableColumnSettingsStorage,
      partialize: (state) => ({ settings: state.settings }),
    }
  )
);
