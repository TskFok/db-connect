import { beforeEach, expect, it } from "vitest";
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
