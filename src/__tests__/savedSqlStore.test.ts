import { describe, it, expect, beforeEach } from "vitest";
import type { ConnectionConfig } from "../types";
import { useSavedSqlStore } from "../stores/savedSqlStore";
import { savedSqlConnectionKey, savedSqlConnectionLabel } from "../utils/savedSqlConnection";

function mockConn(overrides: Partial<ConnectionConfig> = {}): ConnectionConfig {
  return {
    name: "测试连接",
    host: "127.0.0.1",
    port: 3306,
    username: "root",
    ...overrides,
  };
}

describe("savedSqlStore", () => {
  beforeEach(() => {
    useSavedSqlStore.setState({ list: [] });
  });

  describe("add", () => {
    it("应该添加保存的 SQL", () => {
      const cfg = mockConn();
      const id = useSavedSqlStore.getState().add("查询用户", "SELECT * FROM users", cfg);
      const list = useSavedSqlStore.getState().list;
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe("查询用户");
      expect(list[0].sql).toBe("SELECT * FROM users");
      expect(list[0].id).toBe(id);
      expect(list[0].createdAt).toBeGreaterThan(0);
      expect(list[0].connectionKey).toBe(savedSqlConnectionKey(cfg));
      expect(list[0].connectionLabel).toBe(savedSqlConnectionLabel(cfg));
    });

    it("名称为空时使用默认名称", () => {
      useSavedSqlStore.getState().add("", "SELECT 1", mockConn());
      const list = useSavedSqlStore.getState().list;
      expect(list[0].name).toBe("SQL 1");
    });

    it("名称为空格时使用默认名称", () => {
      useSavedSqlStore.setState({ list: [] });
      useSavedSqlStore.getState().add("   ", "SELECT 1", mockConn());
      const list = useSavedSqlStore.getState().list;
      expect(list[0].name).toBe("SQL 1");
    });
  });

  describe("remove", () => {
    it("应该移除指定 id 的 SQL", () => {
      const id = useSavedSqlStore.getState().add("test", "SELECT 1", mockConn());
      expect(useSavedSqlStore.getState().list).toHaveLength(1);
      useSavedSqlStore.getState().remove(id);
      expect(useSavedSqlStore.getState().list).toHaveLength(0);
    });

    it("移除不存在的 id 不应报错", () => {
      useSavedSqlStore.getState().add("test", "SELECT 1", mockConn());
      useSavedSqlStore.getState().remove("non-existent");
      expect(useSavedSqlStore.getState().list).toHaveLength(1);
    });
  });

  describe("getById", () => {
    it("应返回指定 id 的 SQL", () => {
      const id = useSavedSqlStore.getState().add("查询", "SELECT * FROM t", mockConn());
      const item = useSavedSqlStore.getState().getById(id);
      expect(item).toBeDefined();
      expect(item?.name).toBe("查询");
      expect(item?.sql).toBe("SELECT * FROM t");
    });

    it("不存在的 id 应返回 undefined", () => {
      expect(useSavedSqlStore.getState().getById("non-existent")).toBeUndefined();
    });
  });

  describe("getAll", () => {
    it("应按创建时间倒序返回", async () => {
      useSavedSqlStore.getState().add("first", "SELECT 1", mockConn());
      await new Promise((r) => setTimeout(r, 2));
      useSavedSqlStore.getState().add("second", "SELECT 2", mockConn());
      await new Promise((r) => setTimeout(r, 2));
      useSavedSqlStore.getState().add("third", "SELECT 3", mockConn());
      const list = useSavedSqlStore.getState().getAll();
      expect(list).toHaveLength(3);
      expect(list[0].name).toBe("third");
      expect(list[1].name).toBe("second");
      expect(list[2].name).toBe("first");
    });

    it("无保存时返回空数组", () => {
      expect(useSavedSqlStore.getState().getAll()).toEqual([]);
    });
  });
});
