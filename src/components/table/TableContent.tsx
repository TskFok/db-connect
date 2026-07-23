import { lazy, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { Tabs, Spin } from "antd";
import {
  TableOutlined,
  UnorderedListOutlined,
  CodeOutlined,
  BarChartOutlined,
  ThunderboltOutlined,
  LinkOutlined,
} from "@ant-design/icons";
import { useDatabaseStore } from "../../stores/databaseStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { TableStructure } from "./TableStructure";
import { TableData } from "./TableData";
import { SqlEditor } from "../sql/SqlEditorLazy";
import { getDatabaseCapabilities } from "../../utils/databaseCapabilities";
import { normalizeDatabaseType } from "../../utils/connectionConfig";

const IndexList = lazy(() =>
  import("../index/IndexList").then((m) => ({ default: m.IndexList }))
);
const TriggerList = lazy(() =>
  import("../trigger/TriggerList").then((m) => ({ default: m.TriggerList }))
);
const CreateTableSql = lazy(() =>
  import("../database/CreateTableSql").then((m) => ({ default: m.CreateTableSql }))
);
const ForeignKeyList = lazy(() =>
  import("../foreignKey/ForeignKeyList").then((m) => ({ default: m.ForeignKeyList }))
);

const lazyTabFallback = (
  <div style={{ display: "flex", justifyContent: "center", padding: 24 }}>
    <Spin size="small" />
  </div>
);

function withLazyTab(children: ReactNode) {
  return <Suspense fallback={lazyTabFallback}>{children}</Suspense>;
}

export function TableContent() {
  const { selectedDatabase, selectedTable, selectedTableInfo, tableContentActiveTab, setTableContentActiveTab } =
    useDatabaseStore();
  const activeConnection = useConnectionStore((s) => s.activeConnection);

  const isView = selectedTableInfo?.table_type === "VIEW";
  const tableScopeKey = `${selectedDatabase ?? ""}|${selectedTable ?? ""}`;
  const capabilities = useMemo(
    () => getDatabaseCapabilities(activeConnection?.config.database_type),
    [activeConnection?.config.database_type]
  );
  const databaseType = normalizeDatabaseType(activeConnection?.config.database_type);

  const tabItems = useMemo(() => {
    const base: { key: string; label: ReactNode; children: ReactNode }[] = [];
    if (capabilities.tableBrowsing) {
      base.push({
        key: "data",
        label: (
          <span>
            <TableOutlined />
            数据
          </span>
        ),
        children: <TableData key={`data:${tableScopeKey}`} />,
      });
    }
    base.push({
      key: "structure",
      label: (
        <span>
          <UnorderedListOutlined />
          结构
        </span>
      ),
      children: <TableStructure key={`structure:${tableScopeKey}`} />,
    });
    if (capabilities.indexManagement) {
      base.push(
      {
        key: "indexes",
        label: (
          <span>
            <BarChartOutlined />
            索引
          </span>
        ),
        children: withLazyTab(<IndexList />),
      },
      );
    }
    if (capabilities.triggerManagement) {
      base.push(
      {
        key: "triggers",
        label: (
          <span>
            <ThunderboltOutlined />
            触发器
          </span>
        ),
        children: withLazyTab(<TriggerList />),
      },
      );
    }
    if (!isView && capabilities.foreignKeyManagement) {
      base.push({
        key: "foreignKeys",
        label: (
          <span>
            <LinkOutlined />
            外键
          </span>
        ),
        children: withLazyTab(<ForeignKeyList />),
      });
    }
    if (capabilities.schemaManagement && databaseType !== "sqlserver") {
      base.push({
        key: "createTable",
        label: (
          <span>
            <TableOutlined />
            创建表
          </span>
        ),
        children: withLazyTab(<CreateTableSql />),
      });
    }
    if (capabilities.sqlEditor) {
      base.push({
        key: "sql",
        label: (
          <span>
            <CodeOutlined />
            SQL
          </span>
        ),
        children: <SqlEditor />,
      });
    }
    // selectedDatabase / selectedTable 必须参与依赖：否则顶部多表标签切换时仍复用旧 items，
    // Ant Tabs 可能不刷新「数据」面板，出现上一张表虚拟行叠在新表上、字体重叠。
    return base;
  }, [capabilities, databaseType, isView, tableScopeKey]);

  const tabKeys = useMemo(() => tabItems.map((t) => t.key), [tabItems]);
  const activeTabKey = tabKeys.includes(tableContentActiveTab)
    ? tableContentActiveTab
    : (tabKeys[0] ?? "structure");

  useEffect(() => {
    if (!selectedDatabase || !selectedTable) return;
    if (!tabKeys.includes(tableContentActiveTab)) {
      setTableContentActiveTab(tabKeys[0] ?? "structure");
    }
  }, [
    selectedDatabase,
    selectedTable,
    tabKeys,
    tableContentActiveTab,
    setTableContentActiveTab,
  ]);

  if (!selectedDatabase || !selectedTable) {
    return null;
  }

  const tableDisplayName = `${selectedDatabase}.${selectedTable}`;

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <Tabs
        key={`${selectedDatabase}|${selectedTable}`}
        activeKey={activeTabKey}
        onChange={setTableContentActiveTab}
        style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
        className="full-height-tabs"
        items={tabItems}
        tabBarExtraContent={{
          right: (
            <span
              title={tableDisplayName}
              style={{
                display: "inline-block",
                maxWidth: "min(40vw, 360px)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {tableDisplayName}
            </span>
          ),
        }}
      />
    </div>
  );
}
