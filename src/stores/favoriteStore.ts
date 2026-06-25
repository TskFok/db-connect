import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface FavoriteTable {
  /** 连接标识 (config.id 或 host:port) */
  connectionId: string;
  database: string;
  table: string;
}

interface FavoriteState {
  favorites: FavoriteTable[];
  addFavorite: (item: FavoriteTable) => void;
  removeFavorite: (connectionId: string, database: string, table: string) => void;
  /** 移除指定连接下的全部收藏（其他连接不受影响） */
  clearFavoritesForConnection: (connectionId: string) => void;
  isFavorite: (connectionId: string, database: string, table: string) => boolean;
  toggleFavorite: (item: FavoriteTable) => void;
  getFavoritesForConnection: (connectionId: string) => FavoriteTable[];
}

const matchFavorite = (
  a: FavoriteTable,
  connectionId: string,
  database: string,
  table: string
) =>
  a.connectionId === connectionId &&
  a.database === database &&
  a.table === table;

export const useFavoriteStore = create<FavoriteState>()(
  persist(
    (set, get) => ({
      favorites: [],

      addFavorite: (item: FavoriteTable) => {
        const { favorites } = get();
        if (
          favorites.some((f) =>
            matchFavorite(f, item.connectionId, item.database, item.table)
          )
        ) {
          return;
        }
        set({
          favorites: [...favorites, item],
        });
      },

      removeFavorite: (
        connectionId: string,
        database: string,
        table: string
      ) => {
        set({
          favorites: get().favorites.filter(
            (f) => !matchFavorite(f, connectionId, database, table)
          ),
        });
      },

      clearFavoritesForConnection: (connectionId: string) => {
        set({
          favorites: get().favorites.filter(
            (f) => f.connectionId !== connectionId
          ),
        });
      },

      isFavorite: (
        connectionId: string,
        database: string,
        table: string
      ): boolean => {
        return get().favorites.some((f) =>
          matchFavorite(f, connectionId, database, table)
        );
      },

      toggleFavorite: (item: FavoriteTable) => {
        const { isFavorite, addFavorite, removeFavorite } = get();
        if (isFavorite(item.connectionId, item.database, item.table)) {
          removeFavorite(item.connectionId, item.database, item.table);
        } else {
          addFavorite(item);
        }
      },

      getFavoritesForConnection: (connectionId: string): FavoriteTable[] => {
        return get().favorites.filter((f) => f.connectionId === connectionId);
      },
    }),
    {
      name: "db-connect-favorites",
    }
  )
);
