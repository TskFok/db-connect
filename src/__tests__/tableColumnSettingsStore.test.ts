import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock Tauri preferences API 使测试回退到 localStorage
vi.mock("../services/tauriCommands", () => ({
  getTableColumnSettings: vi.fn().mockRejectedValue(new Error("No Tauri")),
  saveTableColumnSettings: vi.fn().mockRejectedValue(new Error("No Tauri")),
  deleteTableColumnSettings: vi.fn().mockRejectedValue(new Error("No Tauri")),
}));

import { useTableColumnSettingsStore } from "../stores/tableColumnSettingsStore";

const CONN_ID = "conn-1";
const DATABASE = "test_db";
const TABLE = "users";

describe("tableColumnSettingsStore", () => {
  beforeEach(() => {
    useTableColumnSettingsStore.setState({ settings: {} });
    localStorage.removeItem("db-connect-table-column-settings");
  });

  describe("getSettings", () => {
    it("未设置时返回默认空对象", () => {
      const settings = useTableColumnSettingsStore
        .getState()
        .getSettings(CONN_ID, DATABASE, TABLE);
      expect(settings.columnWidths).toEqual({});
      expect(settings.hiddenColumns).toEqual([]);
    });

    it("已设置时返回对应表的配置", () => {
      useTableColumnSettingsStore.getState().setColumnWidth(CONN_ID, DATABASE, TABLE, "id", 100);
      useTableColumnSettingsStore.getState().setHiddenColumns(CONN_ID, DATABASE, TABLE, ["email"]);
      const settings = useTableColumnSettingsStore
        .getState()
        .getSettings(CONN_ID, DATABASE, TABLE);
      expect(settings.columnWidths).toEqual({ id: 100 });
      expect(settings.hiddenColumns).toEqual(["email"]);
    });
  });

  describe("setColumnWidth / setColumnWidths", () => {
    it("setColumnWidth 应更新单列宽度", () => {
      useTableColumnSettingsStore
        .getState()
        .setColumnWidth(CONN_ID, DATABASE, TABLE, "name", 200);
      const settings = useTableColumnSettingsStore
        .getState()
        .getSettings(CONN_ID, DATABASE, TABLE);
      expect(settings.columnWidths.name).toBe(200);
    });

    it("setColumnWidth 多次调用应合并列宽", () => {
      useTableColumnSettingsStore.getState().setColumnWidth(CONN_ID, DATABASE, TABLE, "id", 80);
      useTableColumnSettingsStore.getState().setColumnWidth(CONN_ID, DATABASE, TABLE, "name", 160);
      const settings = useTableColumnSettingsStore
        .getState()
        .getSettings(CONN_ID, DATABASE, TABLE);
      expect(settings.columnWidths).toEqual({ id: 80, name: 160 });
    });

    it("setColumnWidths 应整体替换列宽", () => {
      useTableColumnSettingsStore.getState().setColumnWidth(CONN_ID, DATABASE, TABLE, "id", 80);
      useTableColumnSettingsStore.getState().setColumnWidths(CONN_ID, DATABASE, TABLE, {
        name: 200,
        email: 180,
      });
      const settings = useTableColumnSettingsStore
        .getState()
        .getSettings(CONN_ID, DATABASE, TABLE);
      expect(settings.columnWidths).toEqual({ name: 200, email: 180 });
    });

    it("不同表应有独立列宽", () => {
      useTableColumnSettingsStore.getState().setColumnWidth(CONN_ID, DATABASE, "users", "id", 100);
      useTableColumnSettingsStore.getState().setColumnWidth(CONN_ID, DATABASE, "orders", "id", 150);
      const users = useTableColumnSettingsStore.getState().getSettings(CONN_ID, DATABASE, "users");
      const orders = useTableColumnSettingsStore.getState().getSettings(CONN_ID, DATABASE, "orders");
      expect(users.columnWidths.id).toBe(100);
      expect(orders.columnWidths.id).toBe(150);
    });
  });

  describe("setHiddenColumns / toggleColumnVisibility", () => {
    it("setHiddenColumns 应更新隐藏列列表", () => {
      useTableColumnSettingsStore.getState().setHiddenColumns(CONN_ID, DATABASE, TABLE, [
        "email",
        "phone",
      ]);
      const settings = useTableColumnSettingsStore
        .getState()
        .getSettings(CONN_ID, DATABASE, TABLE);
      expect(settings.hiddenColumns).toEqual(["email", "phone"]);
    });

    it("toggleColumnVisibility 隐藏列 → 显示列", () => {
      useTableColumnSettingsStore.getState().setHiddenColumns(CONN_ID, DATABASE, TABLE, ["email"]);
      useTableColumnSettingsStore
        .getState()
        .toggleColumnVisibility(CONN_ID, DATABASE, TABLE, "email", new Set(["email"]));
      const settings = useTableColumnSettingsStore
        .getState()
        .getSettings(CONN_ID, DATABASE, TABLE);
      expect(settings.hiddenColumns).toEqual([]);
    });

    it("toggleColumnVisibility 显示列 → 隐藏列", () => {
      useTableColumnSettingsStore
        .getState()
        .toggleColumnVisibility(CONN_ID, DATABASE, TABLE, "email", new Set());
      const settings = useTableColumnSettingsStore
        .getState()
        .getSettings(CONN_ID, DATABASE, TABLE);
      expect(settings.hiddenColumns).toEqual(["email"]);
    });

    it("toggleColumnVisibility 多列混合", () => {
      useTableColumnSettingsStore.getState().setHiddenColumns(CONN_ID, DATABASE, TABLE, [
        "a",
        "b",
      ]);
      useTableColumnSettingsStore
        .getState()
        .toggleColumnVisibility(CONN_ID, DATABASE, TABLE, "a", new Set(["a", "b"]));
      const settings = useTableColumnSettingsStore
        .getState()
        .getSettings(CONN_ID, DATABASE, TABLE);
      expect(settings.hiddenColumns).toEqual(["b"]);
    });
  });

  describe("clearTableSettings", () => {
    it("应清除指定表的所有设置", () => {
      useTableColumnSettingsStore.getState().setColumnWidth(CONN_ID, DATABASE, TABLE, "id", 100);
      useTableColumnSettingsStore.getState().setHiddenColumns(CONN_ID, DATABASE, TABLE, ["email"]);
      useTableColumnSettingsStore.getState().clearTableSettings(CONN_ID, DATABASE, TABLE);
      const settings = useTableColumnSettingsStore
        .getState()
        .getSettings(CONN_ID, DATABASE, TABLE);
      expect(settings.columnWidths).toEqual({});
      expect(settings.hiddenColumns).toEqual([]);
    });

    it("清除不应影响其他表", () => {
      useTableColumnSettingsStore.getState().setColumnWidth(CONN_ID, DATABASE, "users", "id", 100);
      useTableColumnSettingsStore.getState().setColumnWidth(CONN_ID, DATABASE, "orders", "id", 150);
      useTableColumnSettingsStore.getState().clearTableSettings(CONN_ID, DATABASE, "users");
      const orders = useTableColumnSettingsStore.getState().getSettings(CONN_ID, DATABASE, "orders");
      expect(orders.columnWidths.id).toBe(150);
    });
  });
});
