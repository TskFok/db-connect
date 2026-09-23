import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDatabaseStore } from "../stores/databaseStore";
import type { SqlExecuteResult } from "../types";

const firstResult: SqlExecuteResult = {
  result_type: "select",
  columns: ["value"],
  rows: [[1]],
  affected_rows: null,
  message: "返回 1 行",
  execution_time_ms: 1,
};
const secondResult: SqlExecuteResult = {
  ...firstResult,
  rows: [[2]],
};
const statementResults = [
  { sql: "SELECT 1", result: firstResult, error: null },
  { sql: "SELECT 2", result: secondResult, error: null },
];

function openSqlTab(connId: string): string {
  useDatabaseStore.getState().openSqlTab(connId, "SELECT 1; SELECT 2");
  const tabs = useDatabaseStore.getState().connectionStates[connId].openTabs;
  const tab = tabs[tabs.length - 1];
  if (tab.type !== "sql") throw new Error("SQL 标签页未创建");
  return tab.id;
}

function saveResults(connId: string, tabId: string) {
  useDatabaseStore
    .getState()
    .setSqlTabResult(
      connId,
      tabId,
      secondResult,
      null,
      ["SELECT 1", "SELECT 2"],
      statementResults
    );
}

describe("SQL 结果标签状态", () => {
  beforeEach(() => {
    let timestamp = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => timestamp++);
    useDatabaseStore.getState().reset();
    useDatabaseStore.getState().switchToConnection("conn-1");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("保存每条语句的结果，并在切换编辑器和连接后恢复选择", () => {
    const tabId = openSqlTab("conn-1");
    saveResults("conn-1", tabId);
    expect(
      useDatabaseStore.getState().sqlTabResults[tabId].statementResults
    ).toEqual(statementResults);
    expect(
      useDatabaseStore.getState().sqlTabResults[tabId].activeResultIndex
    ).toBe(0);

    useDatabaseStore.getState().setSqlTabActiveResult("conn-1", tabId, 1);
    openSqlTab("conn-1");
    useDatabaseStore.getState().switchTab("conn-1", 0);
    useDatabaseStore.getState().switchToConnection("conn-2");
    useDatabaseStore.getState().switchToConnection("conn-1");

    const saved = useDatabaseStore.getState().sqlTabResults[tabId];
    expect(saved.activeResultIndex).toBe(1);
    expect(
      saved.statementResults?.[saved.activeResultIndex ?? 0].result?.rows
    ).toEqual([[2]]);
  });

  it("重新执行后选中首个结果，不沿用上一批次的索引", () => {
    const tabId = openSqlTab("conn-1");
    saveResults("conn-1", tabId);
    useDatabaseStore.getState().setSqlTabActiveResult("conn-1", tabId, 1);

    useDatabaseStore
      .getState()
      .setSqlTabResult(
        "conn-1",
        tabId,
        firstResult,
        null,
        ["SELECT 1"],
        [statementResults[0]]
      );

    expect(useDatabaseStore.getState().sqlTabResults[tabId]).toMatchObject({
      activeResultIndex: 0,
      statementResults: [statementResults[0]],
    });
  });

  it("后台连接完成查询不会覆盖当前连接的结果", () => {
    const foregroundTab = openSqlTab("conn-1");
    const backgroundTab = openSqlTab("conn-2");
    saveResults("conn-1", foregroundTab);
    const foregroundResults = useDatabaseStore.getState().sqlTabResults;

    saveResults("conn-2", backgroundTab);

    expect(useDatabaseStore.getState().sqlTabResults).toBe(foregroundResults);
    useDatabaseStore.getState().switchToConnection("conn-2");
    expect(
      useDatabaseStore.getState().sqlTabResults[backgroundTab].statementResults
    ).toEqual(statementResults);
  });

  it("后台连接切换结果仅改变所属标签，当前连接和同连接其他标签不受影响", () => {
    const foregroundTab = openSqlTab("conn-1");
    const backgroundTab = openSqlTab("conn-2");
    const otherBackgroundTab = openSqlTab("conn-2");
    saveResults("conn-1", foregroundTab);
    saveResults("conn-2", backgroundTab);
    saveResults("conn-2", otherBackgroundTab);
    useDatabaseStore.getState().switchToConnection("conn-1");
    const foregroundResults = useDatabaseStore.getState().sqlTabResults;

    useDatabaseStore
      .getState()
      .setSqlTabActiveResult("conn-2", backgroundTab, 1);

    expect(useDatabaseStore.getState().sqlTabResults).toBe(foregroundResults);
    useDatabaseStore.getState().switchToConnection("conn-2");
    expect(
      useDatabaseStore.getState().sqlTabResults[backgroundTab].activeResultIndex
    ).toBe(1);
    expect(
      useDatabaseStore.getState().sqlTabResults[otherBackgroundTab]
        .activeResultIndex
    ).toBe(0);
  });

  it.each([-1, 2, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "无效索引 %s 不会丢失当前结果选择",
    (index) => {
      const tabId = openSqlTab("conn-1");
      saveResults("conn-1", tabId);
      useDatabaseStore.getState().setSqlTabActiveResult("conn-1", tabId, 1);

      useDatabaseStore.getState().setSqlTabActiveResult("conn-1", tabId, index);

      expect(
        useDatabaseStore.getState().sqlTabResults[tabId].activeResultIndex
      ).toBe(1);
    }
  );

  it("旧单结果调用清空上一批结果标签且无法选择不存在的结果", () => {
    const tabId = openSqlTab("conn-1");
    saveResults("conn-1", tabId);
    useDatabaseStore
      .getState()
      .setSqlTabResult("conn-1", tabId, firstResult, null, []);
    useDatabaseStore.getState().setSqlTabActiveResult("conn-1", tabId, 1);

    expect(useDatabaseStore.getState().sqlTabResults[tabId]).toMatchObject({
      result: firstResult,
      statementResults: [],
      activeResultIndex: 0,
    });
  });

  it("关闭标签清理全部结果，迟到结果不能重新创建已关闭标签的状态", () => {
    const tabId = openSqlTab("conn-1");
    saveResults("conn-1", tabId);
    useDatabaseStore.getState().closeTab("conn-1", 0);

    saveResults("conn-1", tabId);
    expect(useDatabaseStore.getState().sqlTabResults[tabId]).toBeUndefined();
    useDatabaseStore.getState().setSqlTabActiveResult("conn-1", tabId, 1);
    expect(
      useDatabaseStore.getState().connectionStates["conn-1"].sqlTabResults[
        tabId
      ]
    ).toBeUndefined();
  });

  it("断开连接后的迟到结果不能恢复已移除的连接状态", () => {
    const tabId = openSqlTab("conn-1");
    useDatabaseStore.getState().removeConnectionState("conn-1");

    saveResults("conn-1", tabId);
    expect(
      useDatabaseStore.getState().connectionStates["conn-1"]
    ).toBeUndefined();
    useDatabaseStore.getState().setSqlTabActiveResult("conn-1", tabId, 1);
    expect(useDatabaseStore.getState().sqlTabResults).toEqual({});
  });

  it("后台查询开始和结束不会清除当前连接的执行中状态", () => {
    const foregroundTab = openSqlTab("conn-1");
    const backgroundTab = openSqlTab("conn-2");
    useDatabaseStore.getState().setSqlTabExecution("conn-1", foregroundTab, {
      executionId: "foreground",
    });
    const foregroundExecutions = useDatabaseStore.getState().sqlTabExecutions;

    useDatabaseStore.getState().setSqlTabExecution("conn-2", backgroundTab, {
      executionId: "background",
    });
    expect(useDatabaseStore.getState().sqlTabExecutions).toBe(
      foregroundExecutions
    );

    useDatabaseStore
      .getState()
      .setSqlTabExecution("conn-2", backgroundTab, null);
    expect(useDatabaseStore.getState().sqlTabExecutions).toBe(
      foregroundExecutions
    );
    useDatabaseStore.getState().switchToConnection("conn-2");
    expect(
      useDatabaseStore.getState().sqlTabExecutions[backgroundTab]
    ).toBeUndefined();
  });
});
