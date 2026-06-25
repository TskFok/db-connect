import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { TableTabsBar } from "../components/table/TableTabsBar";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore, emptyConnState } from "../stores/databaseStore";
import { useTableDataStore } from "../stores/tableDataStore";

const mockActiveConnection = {
  connId: "conn-1",
  config: {
    id: "conn-1",
    name: "测试连接",
    host: "localhost",
    port: 3306,
    username: "root",
  },
};

describe("TableTabsBar 仅一个表标签时", () => {
  beforeEach(() => {
    useTableDataStore.getState().reset();
    useDatabaseStore.getState().reset();
    useConnectionStore.setState({
      activeConnections: { "conn-1": mockActiveConnection },
      activeConnId: "conn-1",
      activeConnection: mockActiveConnection,
    });
  });

  it("仍渲染顶部标签栏，显示表名且有关闭按钮", () => {
    const solo = {
      ...emptyConnState(),
      openTabs: [{ type: "table" as const, database: "mydb", table: "only_table" }],
      activeTabIndex: 0,
      selectedDatabase: "mydb",
      selectedTable: "only_table",
      tableInfos: {
        "mydb|only_table": {
          name: "only_table",
          table_type: "TABLE",
          engine: "InnoDB",
          rows: 0,
          data_length: 0, index_length: null,
          comment: "",
        },
      },
    };
    useDatabaseStore.setState({
      connectionStates: { "conn-1": solo },
    });
    useDatabaseStore.getState().switchToConnection("conn-1");

    render(<TableTabsBar />);

    expect(screen.getByText("only_table")).toBeInTheDocument();
    expect(screen.getByTitle("关闭")).toBeInTheDocument();
  });

  it("仅一个 SQL 标签时仍有关闭控件", () => {
    const solo = {
      ...emptyConnState(),
      openTabs: [{ type: "sql" as const, id: "sql-tab-a" }],
      activeTabIndex: 0,
    };
    useDatabaseStore.setState({
      connectionStates: { "conn-1": solo },
    });
    useDatabaseStore.getState().switchToConnection("conn-1");

    render(<TableTabsBar />);

    expect(screen.getByText("SQL")).toBeInTheDocument();
    expect(screen.getAllByTitle("关闭").length).toBeGreaterThan(0);
  });
});
