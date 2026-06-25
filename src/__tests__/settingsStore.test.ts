import { describe, it, expect, beforeEach } from "vitest";
import {
  useSettingsStore,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_DEFAULT,
  TABLE_LIST_COL_WIDTH_MIN,
  TABLE_LIST_COL_WIDTH_MAX,
} from "../stores/settingsStore";
import { LIST_TABLE_IDS } from "../utils/listTableColumns";

describe("settingsStore", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      idleTimeoutMinutes: 15,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      listTableSettings: {},
    });
  });

  describe("idleTimeoutMinutes", () => {
    it("应该有默认值 15 分钟", () => {
      useSettingsStore.setState({ idleTimeoutMinutes: 15 });
      expect(useSettingsStore.getState().idleTimeoutMinutes).toBe(15);
    });

    it("setIdleTimeoutMinutes 应该更新超时时间", () => {
      useSettingsStore.getState().setIdleTimeoutMinutes(30);
      expect(useSettingsStore.getState().idleTimeoutMinutes).toBe(30);
    });

    it("设置为 0 表示禁用自动断开", () => {
      useSettingsStore.getState().setIdleTimeoutMinutes(0);
      expect(useSettingsStore.getState().idleTimeoutMinutes).toBe(0);
    });
  });

  describe("sidebarWidth", () => {
    it("应该有默认宽度", () => {
      useSettingsStore.setState({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
      expect(useSettingsStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
    });

    it("setSidebarWidth 应该更新宽度", () => {
      useSettingsStore.getState().setSidebarWidth(320);
      expect(useSettingsStore.getState().sidebarWidth).toBe(320);
    });

    it("setSidebarWidth 应限制在最小宽度内", () => {
      useSettingsStore.getState().setSidebarWidth(100);
      expect(useSettingsStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);
    });

    it("setSidebarWidth 应限制在最大宽度内", () => {
      useSettingsStore.getState().setSidebarWidth(600);
      expect(useSettingsStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
    });
  });

  describe("listTableSettings", () => {
    it("默认应为空对象", () => {
      expect(useSettingsStore.getState().listTableSettings).toEqual({});
    });

    it("setListTableColumnWidth 应更新指定列表的列宽", () => {
      useSettingsStore
        .getState()
        .setListTableColumnWidth(LIST_TABLE_IDS.DATABASE_TABLE_LIST, "name", 240);
      const settings =
        useSettingsStore.getState().listTableSettings[
          LIST_TABLE_IDS.DATABASE_TABLE_LIST
        ];
      expect(settings?.columnWidths.name).toBe(240);
    });

    it("setListTableColumnWidth 应限制在合法区间", () => {
      useSettingsStore
        .getState()
        .setListTableColumnWidth(LIST_TABLE_IDS.ROUTINE_LIST, "name", 20);
      let settings =
        useSettingsStore.getState().listTableSettings[LIST_TABLE_IDS.ROUTINE_LIST];
      expect(settings?.columnWidths.name).toBe(TABLE_LIST_COL_WIDTH_MIN);

      useSettingsStore
        .getState()
        .setListTableColumnWidth(LIST_TABLE_IDS.ROUTINE_LIST, "name", 9999);
      settings =
        useSettingsStore.getState().listTableSettings[LIST_TABLE_IDS.ROUTINE_LIST];
      expect(settings?.columnWidths.name).toBe(TABLE_LIST_COL_WIDTH_MAX);
    });

    it("setListTableColumnOrder 应更新列顺序", () => {
      useSettingsStore
        .getState()
        .setListTableColumnOrder(LIST_TABLE_IDS.DATABASE_TABLE_LIST, [
          "comment",
          "name",
        ]);
      const settings =
        useSettingsStore.getState().listTableSettings[
          LIST_TABLE_IDS.DATABASE_TABLE_LIST
        ];
      expect(settings?.columnOrder).toEqual(["comment", "name"]);
    });

    it("不同列表的列设置应互不影响", () => {
      useSettingsStore
        .getState()
        .setListTableColumnWidth(LIST_TABLE_IDS.ROUTINE_LIST, "name", 150);
      useSettingsStore
        .getState()
        .setListTableColumnWidth(LIST_TABLE_IDS.EVENT_LIST, "name", 180);
      const routine =
        useSettingsStore.getState().listTableSettings[LIST_TABLE_IDS.ROUTINE_LIST];
      const event =
        useSettingsStore.getState().listTableSettings[LIST_TABLE_IDS.EVENT_LIST];
      expect(routine?.columnWidths.name).toBe(150);
      expect(event?.columnWidths.name).toBe(180);
    });
  });
});
