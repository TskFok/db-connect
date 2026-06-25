import { lazy, Suspense, useEffect, useMemo, type ReactNode } from "react";
import { Tabs, Space, Typography, Tag, Spin } from "antd";
import {
  TableOutlined,
  EyeOutlined,
  DatabaseOutlined,
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

const { Title, Text } = Typography;

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

  const tabItems = useMemo(() => {
    const base = [
      {
        key: "data",
        label: (
          <span>
            <TableOutlined />
            数据
          </span>
        ),
        children: <TableData key={`data:${tableScopeKey}`} />,
      },
      {
        key: "structure",
        label: (
          <span>
            <UnorderedListOutlined />
            结构
          </span>
        ),
        children: <TableStructure key={`structure:${tableScopeKey}`} />,
      },
    ];
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
    if (capabilities.schemaManagement) {
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
  }, [capabilities, isView, tableScopeKey]);

  const tabKeys = useMemo(() => tabItems.map((t) => t.key), [tabItems]);

  useEffect(() => {
    if (!selectedDatabase || !selectedTable) return;
    if (!tabKeys.includes(tableContentActiveTab)) {
      setTableContentActiveTab(tabKeys[0] ?? "data");
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

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {/* 表头信息 */}
      <div style={{ marginBottom: 12 }}>
        <Space align="center">
          <DatabaseOutlined style={{ color: "#1677ff" }} />
          <Text type="secondary">{selectedDatabase}</Text>
          <Text type="secondary">/</Text>
          {isView ? (
            <EyeOutlined style={{ color: "#faad14" }} />
          ) : (
            <TableOutlined style={{ color: "#52c41a" }} />
          )}
          <Title level={4} style={{ margin: 0 }}>
            {selectedTable}
          </Title>
          <Tag color={isView ? "orange" : "blue"}>
            {isView ? "VIEW" : "TABLE"}
          </Tag>
        </Space>
      </div>

      <Tabs
        key={`${selectedDatabase}|${selectedTable}`}
        activeKey={tableContentActiveTab}
        onChange={setTableContentActiveTab}
        style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
        className="full-height-tabs"
        items={tabItems}
      />
    </div>
  );
}
