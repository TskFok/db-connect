import { describe, it, expect, beforeEach } from "vitest";
import {
  deriveSelectedFromOpenTabs,
  emptyConnState,
} from "../stores/databaseStoreState";
import { syncCurrentView } from "../stores/databaseStoreView";
import { useDatabaseStore } from "../stores/databaseStore";

describe("deriveSelectedFromOpenTabs / viewMode", () => {
  it("overview 模式保留树上选中的数据库，不因激活表标签覆盖 selectedTable", () => {
    const state = {
      ...emptyConnState(),
      viewMode: "overview" as const,
      selectedDatabase: "myapp",
      selectedTable: null,
      openTabs: [
        { type: "table" as const, database: "myapp", table: "users" },
      ],
      activeTabIndex: 0,
      tableInfos: {
        "myapp|users": {
          name: "users",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 1,
          data_length: 1,
          index_length: null,
          comment: "",
        },
      },
    };

    const derived = deriveSelectedFromOpenTabs(state);
    expect(derived.viewMode).toBe("overview");
    expect(derived.selectedDatabase).toBe("myapp");
    expect(derived.selectedTable).toBeNull();
    expect(derived.tableStructure).toBeNull();
  });

  it("tab 模式从表标签推导选中状态", () => {
    const structure = [
      {
        name: "id",
        column_type: "int",
        nullable: false,
        key: "PRI",
        default_value: null,
        extra: "",
        comment: "",
      },
    ];
    const state = {
      ...emptyConnState(),
      viewMode: "tab" as const,
      openTabs: [
        { type: "table" as const, database: "myapp", table: "users" },
      ],
      activeTabIndex: 0,
      tableStructures: { "myapp|users": structure },
      tableInfos: {
        "myapp|users": {
          name: "users",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 1,
          data_length: 1,
          index_length: null,
          comment: "",
        },
      },
    };

    const derived = deriveSelectedFromOpenTabs(state);
    expect(derived.viewMode).toBe("tab");
    expect(derived.selectedDatabase).toBe("myapp");
    expect(derived.selectedTable).toBe("users");
    expect(derived.tableStructure).toEqual(structure);
  });

  it("syncCurrentView 在 overview 下不会把 selectedTable 的 null 回退成旧值", () => {
    const state = {
      ...emptyConnState(),
      viewMode: "overview" as const,
      selectedDatabase: "myapp",
      selectedTable: null,
      openTabs: [
        { type: "table" as const, database: "myapp", table: "users" },
      ],
      activeTabIndex: 0,
    };

    const view = syncCurrentView(state);
    expect(view.viewMode).toBe("overview");
    expect(view.selectedDatabase).toBe("myapp");
    expect(view.selectedTable).toBeNull();
  });
});

describe("viewMode 与标签切换", () => {
  beforeEach(() => {
    useDatabaseStore.getState().reset();
    useDatabaseStore.getState().switchToConnection("conn-1");
  });

  it("从 overview 切换到表标签应进入 tab 模式并恢复表选中", () => {
    const tableInfo = {
      name: "users",
      table_type: "TABLE",
      engine: "InnoDB",
      rows: 1,
      data_length: 1,
      index_length: null,
      comment: "",
    };
    useDatabaseStore.setState({
      connectionStates: {
        "conn-1": {
          ...emptyConnState(),
          databases: ["myapp"],
          tables: { myapp: [tableInfo] },
          openTabs: [{ type: "table", database: "myapp", table: "users" }],
          activeTabIndex: 0,
          openTables: [{ database: "myapp", table: "users" }],
          tableInfos: { "myapp|users": tableInfo },
          selectedDatabase: "myapp",
          selectedTable: null,
          viewMode: "overview",
        },
      },
      selectedDatabase: "myapp",
      selectedTable: null,
      viewMode: "overview",
      openTabs: [{ type: "table", database: "myapp", table: "users" }],
      activeTabIndex: 0,
    });

    useDatabaseStore.getState().switchTab("conn-1", 0);
    const state = useDatabaseStore.getState();
    expect(state.viewMode).toBe("tab");
    expect(state.selectedDatabase).toBe("myapp");
    expect(state.selectedTable).toBe("users");
  });

  it("openSqlTab 应进入 tab 模式", () => {
    useDatabaseStore.getState().openSqlTab("conn-1", "SELECT 1");
    expect(useDatabaseStore.getState().viewMode).toBe("tab");
  });
});
