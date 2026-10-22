import { useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Select,
  Space,
  Table,
  Typography,
} from "antd";
import {
  dataTaskErrorMessage,
  getDataTaskDiff,
} from "../../services/dataTasks";
import { formatDataCount } from "../../utils/dataTaskProgress";
import { useConnectionStore } from "../../stores/connectionStore";
import type {
  DataDiffPage,
  DataTaskPreview,
  DataValuePreview,
  TableMapping,
} from "../../types/dataTasks";
import {
  TARGET_SCOPE_RISK,
  EMPTY_SOURCE_RISK,
  requiredPreviewConfirmations,
  dataTaskModeLabels,
} from "../../utils/dataTaskCapabilities";
function displayValue(value: DataValuePreview | null): string {
  if (!value) return "（不存在）";
  return `${value.value_type}: ${value.display}${value.truncated ? `（已截断，原始 ${formatDataCount(value.original_bytes)} 字节）` : ""}`;
}
export function DataTaskPreviewView({
  preview,
  accepted,
  onAcceptedChange,
  showDiff = true,
  mappings,
}: {
  preview: DataTaskPreview;
  accepted: string[];
  onAcceptedChange: (ids: string[]) => void;
  showDiff?: boolean;
  mappings?: TableMapping[];
}) {
  const connections = useConnectionStore((state) => state.savedConnections);
  const [tableId, setTableId] = useState(preview.tables[0]?.table_id);
  const [page, setPage] = useState<DataDiffPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setTableId(preview.tables[0]?.table_id);
    setCursor(null);
  }, [preview]);
  useEffect(() => {
    let current = true;
    setPage(null);
    setError(null);
    if (!showDiff || !tableId) return;
    setLoading(true);
    void getDataTaskDiff(preview.plan_id, tableId, cursor)
      .then((value) => {
        if (current) setPage(value);
      })
      .catch((e) => {
        if (current) setError(dataTaskErrorMessage(e));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [preview.plan_id, tableId, cursor, showDiff]);
  const confirmations = [
    ...preview.risks,
    ...(requiredPreviewConfirmations(preview).includes(TARGET_SCOPE_RISK)
      ? [
          {
            id: TARGET_SCOPE_RISK,
            required: true,
            message: `确认目标范围：${preview.target.database} / ${preview.tables.map((table) => `${table.target_table}，将删除 ${formatDataCount(preview.mode === "replace" ? table.counts.target_rows : table.counts.deleted)} 行`).join("；")}`,
          },
        ]
      : []),
    ...(requiredPreviewConfirmations(preview).includes(EMPTY_SOURCE_RISK)
      ? [
          {
            id: EMPTY_SOURCE_RISK,
            required: true,
            message: "空源将清空对应目标表，我确认此操作",
          },
        ]
      : []),
  ];
  return (
    <Space direction="vertical" style={{ width: "100%" }}>
      <Descriptions
        size="small"
        column={1}
        items={[
          {
            key: "mode",
            label: "执行模式",
            children: dataTaskModeLabels[preview.mode],
          },
          {
            key: "source-endpoint",
            label: "源端",
            children: `${connections.find((connection) => connection.id === preview.source.saved_connection_id)?.name ?? preview.source.saved_connection_id} / ${preview.source.database}`,
          },
          {
            key: "target-endpoint",
            label: "目标端",
            children: `${connections.find((connection) => connection.id === preview.target.saved_connection_id)?.name ?? preview.target.saved_connection_id} / ${preview.target.database}`,
          },
          {
            key: "source",
            label: "源快照采集时间",
            children: new Date(
              Number(preview.source_captured_at)
            ).toLocaleString("zh-CN", { hour12: false }),
          },
          {
            key: "target",
            label: "目标快照采集时间",
            children: new Date(
              Number(preview.target_captured_at)
            ).toLocaleString("zh-CN", { hour12: false }),
          },
          {
            key: "expiry",
            label: "预览有效期截止",
            children: new Date(Number(preview.expires_at)).toLocaleString(
              "zh-CN",
              { hour12: false }
            ),
          },
          {
            key: "fingerprint",
            label: "计划指纹",
            children: preview.fingerprint.slice(0, 12),
          },
        ]}
      />
      {preview.tables.map((table) => (
        <Card
          size="small"
          key={table.table_id}
          title={`${table.source_table} → ${preview.target.database}.${table.target_table}`}
        >
          {mappings
            ?.find(
              (mapping) =>
                mapping.source_table === table.source_table &&
                mapping.target_table === table.target_table
            )
            ?.columns.map((column) => (
              <div key={column.target_column}>
                {column.source_column} → {column.target_column}
              </div>
            ))}
          <Space wrap>
            <span>源行数 {formatDataCount(table.counts.source_rows)}</span>
            <span>目标行数 {formatDataCount(table.counts.target_rows)}</span>
            <span>新增 {formatDataCount(table.counts.inserted)}</span>
            <span>修改 {formatDataCount(table.counts.updated)}</span>
            <span>删除 {formatDataCount(table.counts.deleted)}</span>
            <span>保留 {formatDataCount(table.counts.retained)}</span>
            <span>无变化 {formatDataCount(table.counts.unchanged)}</span>
          </Space>
        </Card>
      ))}
      {preview.blockers.map((blocker, i) => (
        <Alert
          key={i}
          type="error"
          message={`${blocker.table ?? ""} ${blocker.message}`}
        />
      ))}
      {confirmations.map((risk) => (
        <Checkbox
          key={risk.id}
          checked={accepted.includes(risk.id)}
          onChange={(event) =>
            onAcceptedChange(
              event.target.checked
                ? [...accepted, risk.id]
                : accepted.filter((id) => id !== risk.id)
            )
          }
        >
          {risk.message}
          {risk.required ? "（必须确认）" : ""}
        </Checkbox>
      ))}
      {showDiff && (
        <>
          <Typography.Text strong>
            行差异（只读分页，超大值显示截断样本）
          </Typography.Text>
          <Select
            aria-label="差异表"
            value={tableId}
            options={preview.tables.map((t) => ({
              value: t.table_id,
              label: t.source_table,
            }))}
            onChange={(value) => {
              setTableId(value);
              setCursor(null);
            }}
            style={{ minWidth: 220 }}
          />
          <Table
            size="small"
            loading={loading}
            pagination={false}
            scroll={{ x: 600 }}
            rowKey="row_id"
            dataSource={(page?.items ?? []).map((item, index) => ({
              ...item,
              row_id: `${cursor ?? "first"}:${index}`,
            }))}
            columns={[
              {
                title: "操作",
                dataIndex: "operation",
                render: (
                  operation: "insert" | "update" | "delete" | "retain"
                ) =>
                  ({
                    insert: "新增",
                    update: "修改",
                    delete: "删除",
                    retain: "保留",
                  })[operation],
              },
              {
                title: "定位键",
                render: (_, row) =>
                  row.key.map((value) => displayValue(value)).join(" / "),
              },
              {
                title: "字段变化",
                render: (_, row) =>
                  row.changes.map((change) => (
                    <div key={change.column}>
                      {change.column}：{displayValue(change.old)} →{" "}
                      {displayValue(change.new)}
                    </div>
                  )),
              },
            ]}
          />
          <Space>
            <Button
              disabled={cursor === null || loading}
              onClick={() => setCursor(null)}
            >
              第一页
            </Button>
            <Button
              disabled={!page?.next_cursor || loading}
              onClick={() => setCursor(page!.next_cursor)}
            >
              下一页
            </Button>
          </Space>
        </>
      )}
      {error && <Alert type="error" message={error} />}
      {!!preview.sql_examples.length && (
        <Card size="small" title="参数化操作示例（样本）">
          {preview.sql_examples.map((sql, i) => (
            <pre key={i} style={{ whiteSpace: "pre-wrap" }}>
              {sql}
            </pre>
          ))}
        </Card>
      )}
    </Space>
  );
}
export const DataSyncPreview = DataTaskPreviewView;
