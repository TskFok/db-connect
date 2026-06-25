import { useEffect, useState, useCallback } from "react";
import { Button, Alert, Typography, Space, message } from "antd";
import { ReloadOutlined, CopyOutlined } from "@ant-design/icons";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDatabaseStore } from "../../stores/databaseStore";
import * as api from "../../services/tauriCommands";
import { useThemeStore } from "../../stores/themeStore";
import { copyTextWithBreadcrumb } from "../../utils/crashBreadcrumbs";

const { Text, Paragraph } = Typography;

export function CreateTableSql() {
  const { activeConnection } = useConnectionStore();
  const { selectedDatabase, selectedTable } = useDatabaseStore();
  const themeMode = useThemeStore((s) => s.mode);
  const [messageApi, contextHolder] = message.useMessage();

  const [sql, setSql] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connId = activeConnection?.connId ?? "";
  const database = selectedDatabase ?? "";
  const table = selectedTable ?? "";

  const loadCreateTableSql = useCallback(async () => {
    if (!connId || !database || !table) return;
    try {
      setLoading(true);
      setError(null);
      const definition = await api.getTableDefinition(connId, database, table);
      setSql(definition);
    } catch (e) {
      const msg = String(e);
      console.error("获取创建表 SQL 失败:", msg);
      setError(msg);
      setSql("");
    } finally {
      setLoading(false);
    }
  }, [connId, database, table]);

  useEffect(() => {
    loadCreateTableSql();
  }, [loadCreateTableSql]);

  const handleCopy = async () => {
    if (!sql) return;
    try {
      await copyTextWithBreadcrumb(sql, "create-table-sql", {
        database,
        table,
      });
      messageApi.success("已复制到剪贴板");
    } catch {
      messageApi.error("复制失败");
    }
  };

  if (!database || !table) {
    return (
      <div style={{ padding: 24, textAlign: "center" }}>
        <Text type="secondary">请先选择数据表</Text>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {contextHolder}

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <Space>
          <Button
            icon={<ReloadOutlined />}
            size="small"
            onClick={loadCreateTableSql}
            loading={loading}
          >
            刷新
          </Button>
          <Button
            icon={<CopyOutlined />}
            size="small"
            onClick={handleCopy}
            disabled={!sql}
          >
            复制
          </Button>
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {database}.{table}
        </Text>
      </div>

      {error && (
        <Alert
          type="error"
          message="获取创建表 SQL 失败"
          description={error}
          showIcon
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 12 }}
        />
      )}

      <div
        style={{
          flex: 1,
          minHeight: 0,
          border: "1px solid var(--border-color)",
          borderRadius: 4,
          overflow: "auto",
          background: themeMode === "dark" ? "#111827" : "#fafafa",
        }}
      >
        <Paragraph
          style={{
            margin: 0,
            padding: 16,
            fontSize: 13,
            lineHeight: 1.6,
            fontFamily:
              "SFMono-Regular, Consolas, 'Liberation Mono', Menlo, monospace",
            color: "var(--text-primary)",
          }}
        >
          <pre
            style={{
              margin: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              font: "inherit",
            }}
          >
            {sql || "-- 暂无建表语句"}
          </pre>
        </Paragraph>
      </div>
    </div>
  );
}
