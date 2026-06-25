import { describe, it, expect, beforeEach } from "vitest";
import { useFavoriteStore } from "../stores/favoriteStore";

describe("favoriteStore", () => {
  beforeEach(() => {
    useFavoriteStore.setState({ favorites: [] });
  });

  describe("addFavorite", () => {
    it("应该添加收藏", () => {
      useFavoriteStore.getState().addFavorite({
        connectionId: "conn-1",
        database: "myapp",
        table: "users",
      });

      const state = useFavoriteStore.getState();
      expect(state.favorites).toHaveLength(1);
      expect(state.favorites[0]).toEqual({
        connectionId: "conn-1",
        database: "myapp",
        table: "users",
      });
    });

    it("重复添加不应重复", () => {
      const item = {
        connectionId: "conn-1",
        database: "myapp",
        table: "users",
      };
      useFavoriteStore.getState().addFavorite(item);
      useFavoriteStore.getState().addFavorite(item);

      expect(useFavoriteStore.getState().favorites).toHaveLength(1);
    });
  });

  describe("removeFavorite", () => {
    it("应该移除收藏", () => {
      useFavoriteStore.setState({
        favorites: [
          { connectionId: "conn-1", database: "myapp", table: "users" },
        ],
      });

      useFavoriteStore.getState().removeFavorite("conn-1", "myapp", "users");

      expect(useFavoriteStore.getState().favorites).toHaveLength(0);
    });
  });

  describe("clearFavoritesForConnection", () => {
    it("应清空指定连接的全部收藏且保留其它连接", () => {
      useFavoriteStore.setState({
        favorites: [
          { connectionId: "conn-1", database: "a", table: "t1" },
          { connectionId: "conn-1", database: "b", table: "t2" },
          { connectionId: "conn-2", database: "c", table: "t3" },
        ],
      });

      useFavoriteStore.getState().clearFavoritesForConnection("conn-1");

      expect(useFavoriteStore.getState().favorites).toEqual([
        { connectionId: "conn-2", database: "c", table: "t3" },
      ]);
    });

    it("无匹配连接时列表不变", () => {
      useFavoriteStore.setState({
        favorites: [{ connectionId: "conn-x", database: "a", table: "t" }],
      });
      useFavoriteStore.getState().clearFavoritesForConnection("unknown");
      expect(useFavoriteStore.getState().favorites).toHaveLength(1);
    });
  });

  describe("isFavorite", () => {
    it("已收藏应返回 true", () => {
      useFavoriteStore.setState({
        favorites: [
          { connectionId: "conn-1", database: "myapp", table: "users" },
        ],
      });

      expect(
        useFavoriteStore.getState().isFavorite("conn-1", "myapp", "users")
      ).toBe(true);
    });

    it("未收藏应返回 false", () => {
      expect(
        useFavoriteStore.getState().isFavorite("conn-1", "myapp", "users")
      ).toBe(false);
    });
  });

  describe("toggleFavorite", () => {
    it("未收藏时切换应添加", () => {
      const item = {
        connectionId: "conn-1",
        database: "myapp",
        table: "users",
      };
      useFavoriteStore.getState().toggleFavorite(item);

      expect(useFavoriteStore.getState().favorites).toHaveLength(1);
      expect(useFavoriteStore.getState().isFavorite("conn-1", "myapp", "users")).toBe(true);
    });

    it("已收藏时切换应移除", () => {
      const item = {
        connectionId: "conn-1",
        database: "myapp",
        table: "users",
      };
      useFavoriteStore.setState({ favorites: [item] });
      useFavoriteStore.getState().toggleFavorite(item);

      expect(useFavoriteStore.getState().favorites).toHaveLength(0);
      expect(useFavoriteStore.getState().isFavorite("conn-1", "myapp", "users")).toBe(false);
    });
  });

  describe("getFavoritesForConnection", () => {
    it("应返回指定连接的收藏", () => {
      useFavoriteStore.setState({
        favorites: [
          { connectionId: "conn-1", database: "db1", table: "t1" },
          { connectionId: "conn-1", database: "db1", table: "t2" },
          { connectionId: "conn-2", database: "db2", table: "t1" },
        ],
      });

      const result = useFavoriteStore.getState().getFavoritesForConnection("conn-1");
      expect(result).toHaveLength(2);
      expect(result.every((f) => f.connectionId === "conn-1")).toBe(true);
    });

    it("无收藏时返回空数组", () => {
      const result = useFavoriteStore.getState().getFavoritesForConnection("conn-1");
      expect(result).toEqual([]);
    });
  });
});
