import { useMemo } from "react";
import { Button, Typography, message } from "antd";
import { CopyOutlined } from "@ant-design/icons";
import { useShallow } from "zustand/react/shallow";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDatabaseStore } from "../../stores/databaseStore";
import { normalizeDatabaseType } from "../../utils/connectionConfig";
import { copyTextWithBreadcrumb } from "../../utils/crashBreadcrumbs";
import {
  buildTableSqlExamples,
  type TableSqlExample,
} from "../../utils/tableSqlExamples";

export function TableSqlExamples() {
  const { selectedDatabase, selectedTable, selectedTableInfo, tableStructure } =
    useDatabaseStore(
      useShallow((s) => ({
        selectedDatabase: s.selectedDatabase,
        selectedTable: s.selectedTable,
        selectedTableInfo: s.selectedTableInfo,
        tableStructure: s.tableStructure,
      }))
    );
  const databaseType = useConnectionStore(
    (s) => s.activeConnection?.config.database_type
  );
  const [messageApi, contextHolder] = message.useMessage();
  const isView = selectedTableInfo?.table_type === "VIEW";
  const examples = useMemo(
    () =>
      selectedDatabase && selectedTable && tableStructure
        ? buildTableSqlExamples({
            database: selectedDatabase,
            table: selectedTable,
            columns: tableStructure,
            dialect: normalizeDatabaseType(databaseType),
            isView,
          })
        : [],
    [selectedDatabase, selectedTable, tableStructure, databaseType, isView]
  );

  const handleCopy = async (example: TableSqlExample) => {
    try {
      await copyTextWithBreadcrumb(example.sql, "table-sql-example", {
        database: selectedDatabase,
        table: selectedTable,
        example: example.id,
      });
      messageApi.success("SQL 已复制");
    } catch {
      messageApi.error("复制失败");
    }
  };

  return (
    <div style={{ height: "100%", overflow: "auto", paddingRight: 8 }}>
      {contextHolder}
      <div style={{ marginBottom: 16 }}>
        <Typography.Title level={5} style={{ margin: "0 0 4px" }}>
          SQL 示例
        </Typography.Title>
        <Typography.Text type="secondary">
          {
            "基于当前表结构生成。复制后请将 <…> 占位符替换为实际值，字符串需加单引号。"
          }
        </Typography.Text>
      </div>
      {examples.map((example) => (
        <article
          key={example.id}
          aria-label={example.title}
          style={{
            marginBottom: 16,
            border: "1px solid var(--border-color)",
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
              padding: "12px 16px",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <Typography.Text strong>{example.title}</Typography.Text>
              <div style={{ marginTop: 4 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {example.description}
                </Typography.Text>
              </div>
            </div>
            <Button
              size="small"
              icon={<CopyOutlined />}
              aria-label={`复制${example.title} SQL`}
              onClick={() => void handleCopy(example)}
              style={{ flexShrink: 0 }}
            >
              复制 SQL
            </Button>
          </div>
          <pre
            style={{
              margin: 0,
              padding: "12px 16px",
              borderTop: "1px solid var(--border-color)",
              background: "var(--bg-elevated)",
              color: "var(--text-primary)",
              fontSize: 13,
              lineHeight: 1.6,
              fontFamily:
                "SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            <code>{example.sql}</code>
          </pre>
        </article>
      ))}
    </div>
  );
}
