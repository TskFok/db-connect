import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ConnectionConfig } from "../types";
import { savedSqlConnectionKey, savedSqlConnectionLabel } from "../utils/savedSqlConnection";

export interface SavedSql {
  id: string;
  name: string;
  sql: string;
  createdAt: number;
  /** 保存时的连接绑定键；旧数据可能缺失 */
  connectionKey?: string;
  /** 保存时的连接展示名 */
  connectionLabel?: string;
}

interface SavedSqlState {
  list: SavedSql[];
  add: (name: string, sql: string, config: ConnectionConfig) => string;
  remove: (id: string) => void;
  getById: (id: string) => SavedSql | undefined;
  getAll: () => SavedSql[];
}

export const useSavedSqlStore = create<SavedSqlState>()(
  persist(
    (set, get) => ({
      list: [],

      add: (name: string, sql: string, config: ConnectionConfig) => {
        const id = `saved-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
        const item: SavedSql = {
          id,
          name: name.trim() || `SQL ${get().list.length + 1}`,
          sql,
          createdAt: Date.now(),
          connectionKey: savedSqlConnectionKey(config),
          connectionLabel: savedSqlConnectionLabel(config),
        };
        set({ list: [...get().list, item] });
        return id;
      },

      remove: (id: string) => {
        set({ list: get().list.filter((s) => s.id !== id) });
      },

      getById: (id: string) => get().list.find((s) => s.id === id),

      getAll: () => [...get().list].sort((a, b) => b.createdAt - a.createdAt),
    }),
    { name: "db-connect-saved-sql" }
  )
);
