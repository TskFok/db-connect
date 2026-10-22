import { beforeEach, expect, it } from "vitest";
import { useDataTaskStore } from "../stores/dataTaskStore";
import { useConnectionStore } from "../stores/connectionStore";
import type { ConnectionConfig } from "../types";
import { dataSnapshot } from "./dataTaskFixtures";
import { useTableDataStore } from "../stores/tableDataStore";

beforeEach(() => useTableDataStore.getState().reset());
it("外部任务失效数据和分页但保留未提交编辑", () => {
  const store = useTableDataStore.getState();
  store.switchToTable("c", "db", "t");
  store.setPendingChange("c", "db", "t", "0:name", {
    rowKey: 0,
    colName: "name",
    oldValue: "a",
    newValue: "b",
    primaryKeys: { id: 1 },
  });
  useTableDataStore.setState({
    rows: [[1, "a"]],
    countCache: { "c|db|t|": 1 },
  });
  useTableDataStore.getState().markTableDataStale("c", "db", "t");
  expect(
    useTableDataStore.getState().pendingChangesCache["c|db|t"]["0:name"]
      .newValue
  ).toBe("b");
  expect(useTableDataStore.getState().countCache).toEqual({});
  expect(useTableDataStore.getState().totalCountStale).toBe(true);
  expect(useTableDataStore.getState().dataError).toContain("未提交");
});

it("关闭后重新切回失效表不会将旧分页计数重新写入 count 缓存", () => {
  const store = useTableDataStore.getState();
  store.switchToTable("c", "db", "t");
  useTableDataStore.setState({ columns: ["id"], rows: [[1]], total: 1 });
  store.switchToTable("c", "db", "other");
  store.markTableDataStale("c", "db", "t");
  expect(store.switchToTable("c", "db", "t")).toBe(false);
  expect(useTableDataStore.getState().countCache["c|db|t|"]).toBeUndefined();
});

it.each(["committed", "partial", "unknown"] as const)(
  "任务终态 %s 定向失效目标缓存并保留编辑草稿",
  (commit_state) => {
    useDataTaskStore.setState({ tasks: {}, selectedTaskId: null });
    useConnectionStore.setState({
      activeConnections: {
        source: { connId: "source", config: { id: "a" } as ConnectionConfig },
        target: { connId: "target", config: { id: "b" } as ConnectionConfig },
      },
    });
    const store = useTableDataStore.getState();
    store.switchToTable("target", "dest", "users");
    store.setPendingChange("target", "dest", "users", "0:name", {
      rowKey: 0,
      colName: "name",
      oldValue: "before",
      newValue: "我的草稿",
      primaryKeys: { id: 1 },
    });
    useTableDataStore.setState({
      rows: [[1, "before"]],
      countCache: {
        "target|dest|users|": 1,
        "source|src|users|": 2,
        "target|dest|other|": 3,
      },
    });
    const status =
      commit_state === "unknown"
        ? "outcome_unknown"
        : commit_state === "partial"
          ? "partial"
          : "succeeded";
    useDataTaskStore.getState().applySnapshot({
      ...dataSnapshot,
      sequence: "2",
      status,
      result: {
        status,
        commit_state,
        tables: [],
        error: null,
        cleanup_errors: [],
        requires_target_refresh: true,
      },
    });
    const state = useTableDataStore.getState();
    expect(
      state.pendingChangesCache["target|dest|users"]["0:name"].newValue
    ).toBe("我的草稿");
    expect(state.rows).toEqual([[1, "before"]]);
    expect(state.dataError).toContain("未提交");
    expect(state.staleTableKeys["target|dest|users"]).toBe(true);
    expect(state.countCache).toEqual({
      "source|src|users|": 2,
      "target|dest|other|": 3,
    });
  }
);
