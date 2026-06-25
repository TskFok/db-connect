import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Space,
  Typography,
  Tag,
  message,
  Modal,
  Popconfirm,
  Tooltip,
} from "antd";
import {
  ReloadOutlined,
  CodeOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  StopOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDatabaseStore } from "../../stores/databaseStore";
import type { EventInfo } from "../../types";
import * as api from "../../services/tauriCommands";
import { isConnectionGloballyReadOnly } from "../../utils/sqlFileIoUi";
import { useClientReadOnly } from "../../hooks/useClientReadOnly";
import { SortableListTable } from "../common/SortableListTable";
import { useListTableSettings } from "../../hooks/useListTableSettings";
import {
  buildOrderedListColumns,
  LIST_TABLE_IDS,
} from "../../utils/listTableColumns";
import { createListColumnAutoFit } from "../../utils/columnAutoFitWidth";
import { useAntTableScrollY } from "../../hooks/useAntTableScrollY";

const { Text } = Typography;

export interface EventListProps {
  /** Tab 可见性变化时触发容器重测 */
  remeasureKey?: unknown;
}

const DEFAULT_EVENT_LIST_COLUMN_WIDTHS: Record<string, number> = {
  name: 180,
  status: 120,
  event_type: 110,
  definer: 130,
  time_zone: 100,
  a: 168,
};

const DEFAULT_EVENT_LIST_COLUMN_ORDER = [
  "name",
  "status",
  "event_type",
  "definer",
  "time_zone",
  "a",
] as const;

function getEventListCellText(
  record: EventInfo,
  columnKey: string
): string {
  switch (columnKey) {
    case "name":
      return record.name;
    case "status":
      return record.status || "-";
    case "event_type":
      return record.event_type ?? "";
    case "definer":
      return record.definer ?? "";
    case "time_zone":
      return record.time_zone ?? "";
    case "a":
      return "查看 启用 删除";
    default:
      return "";
  }
}

export function EventList({ remeasureKey }: EventListProps = {}) {
  const { activeConnection } = useConnectionStore();
  const clientReadOnly = useClientReadOnly();
  const { selectedDatabase } = useDatabaseStore();
  const { containerRef, scrollY } = useAntTableScrollY({ remeasureKey });
  const [data, setData] = useState<EventInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [ddlOpen, setDdlOpen] = useState(false);
  const [ddlText, setDdlText] = useState("");
  const [ddlTitle, setDdlTitle] = useState("");
  const [readOnlyDb, setReadOnlyDb] = useState(false);
  const [msg, ctx] = message.useMessage();

  const connId = activeConnection?.connId ?? "";
  const database = selectedDatabase ?? "";
  const writeBlocked = clientReadOnly || readOnlyDb;

  const {
    columnOrder,
    getColumnWidth,
    handleColumnResize,
    scrollX,
    sortableColumnIds,
    dnd,
  } = useListTableSettings({
    listId: LIST_TABLE_IDS.EVENT_LIST,
    defaultWidths: DEFAULT_EVENT_LIST_COLUMN_WIDTHS,
    defaultOrder: DEFAULT_EVENT_LIST_COLUMN_ORDER,
  });

  const load = useCallback(async () => {
    if (!connId || !database) return;
    setLoading(true);
    try {
      const rows = await api.listEvents(connId, database);
      setData(rows);
    } catch (e) {
      msg.error(`加载事件失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [connId, database, msg]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let c = false;
    if (!connId || !database) {
      setReadOnlyDb(false);
      return;
    }
    void (async () => {
      try {
        const ro = await isConnectionGloballyReadOnly(connId, database);
        if (!c) setReadOnlyDb(ro);
      } catch {
        if (!c) setReadOnlyDb(false);
      }
    })();
    return () => {
      c = true;
    };
  }, [connId, database]);

  const showDdl = useCallback(async (row: EventInfo) => {
    if (!connId || !database) return;
    try {
      const ddl = await api.getEventDefinition(connId, database, row.name);
      setDdlTitle(`EVENT ${row.name}`);
      setDdlText(ddl);
      setDdlOpen(true);
    } catch (e) {
      msg.error(`读取 DDL 失败: ${e}`);
    }
  }, [connId, database, msg]);

  const toggleEnabled = useCallback(async (row: EventInfo, enabled: boolean) => {
    if (!connId || !database) return;
    try {
      await api.setEventEnabled(connId, database, row.name, enabled);
      msg.success(enabled ? `已启用「${row.name}」` : `已禁用「${row.name}」`);
      load();
    } catch (e) {
      msg.error(`操作失败: ${e}`);
    }
  }, [connId, database, load, msg]);

  const handleDrop = useCallback(async (row: EventInfo) => {
    if (!connId || !database) return;
    try {
      await api.dropEvent(connId, database, row.name);
      msg.success(`已删除事件「${row.name}」`);
      load();
    } catch (e) {
      msg.error(`删除失败: ${e}`);
    }
  }, [connId, database, load, msg]);

  const columnDefinitions = useMemo<Record<string, ColumnsType<EventInfo>[number]>>(
    () => ({
      name: {
        title: "名称",
        dataIndex: "name",
        render: (n: string) => (
          <Text code style={{ fontSize: 12 }}>
            {n}
          </Text>
        ),
      },
      status: {
        title: "状态",
        dataIndex: "status",
        render: (s: string) => {
          const enabled = s === "ENABLED";
          return (
            <Tag color={enabled ? "success" : "default"}>{s || "-"}</Tag>
          );
        },
      },
      event_type: {
        title: "类型",
        dataIndex: "event_type",
      },
      definer: {
        title: "DEFINER",
        dataIndex: "definer",
        ellipsis: true,
      },
      time_zone: {
        title: "时区",
        dataIndex: "time_zone",
        ellipsis: true,
      },
      a: {
        title: "操作",
        render: (_: unknown, row: EventInfo) => {
          const enabled = row.status === "ENABLED";
          return (
            <Space size={4}>
              <Tooltip title="CREATE EVENT">
                <Button
                  type="link"
                  size="small"
                  icon={<CodeOutlined />}
                  onClick={() => void showDdl(row)}
                />
              </Tooltip>
              {enabled ? (
                <Tooltip title="DISABLE">
                  <Button
                    type="link"
                    size="small"
                    icon={<StopOutlined />}
                    disabled={writeBlocked}
                    onClick={() => void toggleEnabled(row, false)}
                  />
                </Tooltip>
              ) : (
                <Tooltip title="ENABLE">
                  <Button
                    type="link"
                    size="small"
                    icon={<CheckCircleOutlined />}
                    disabled={writeBlocked}
                    onClick={() => void toggleEnabled(row, true)}
                  />
                </Tooltip>
              )}
              <Popconfirm
                title="删除事件？"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                disabled={writeBlocked}
                onConfirm={() => void handleDrop(row)}
              >
                <Button
                  type="link"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  disabled={writeBlocked}
                />
              </Popconfirm>
            </Space>
          );
        },
      },
    }),
    [handleDrop, showDdl, toggleEnabled, writeBlocked]
  );

  const getAutoFitWidth = useMemo(
    () =>
      createListColumnAutoFit(columnDefinitions, data, getEventListCellText, {
        sortableHeaders: true,
        minWidths: { a: DEFAULT_EVENT_LIST_COLUMN_WIDTHS.a },
      }),
    [columnDefinitions, data]
  );

  const columns = useMemo(
    () =>
      buildOrderedListColumns(
        columnDefinitions,
        columnOrder,
        getColumnWidth,
        handleColumnResize,
        { sortableHeaders: true, getAutoFitWidth }
      ),
    [columnDefinitions, columnOrder, getColumnWidth, handleColumnResize, getAutoFitWidth]
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
        flex: 1,
      }}
    >
      {ctx}
      <Space style={{ marginBottom: 12, flexShrink: 0 }}>
        <Button icon={<ReloadOutlined />} size="small" onClick={() => void load()}>
          刷新
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          需要 event_scheduler=ON；只读实例无法 ALTER/DROP。
        </Text>
      </Space>
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
      >
        <SortableListTable<EventInfo>
          className="event-list-table"
          columns={columns}
          dataSource={data}
          rowKey="name"
          loading={loading}
          pagination={false}
          size="small"
          sortableColumnIds={sortableColumnIds}
          sensors={dnd.sensors}
          onColumnDragEnd={dnd.onDragEnd}
          scroll={{
            x: scrollX,
            ...(scrollY != null ? { y: scrollY } : {}),
          }}
        />
      </div>
      <Modal
        title={ddlTitle}
        open={ddlOpen}
        onCancel={() => setDdlOpen(false)}
        footer={null}
        width={800}
      >
        <pre
          style={{
            maxHeight: 480,
            overflow: "auto",
            fontSize: 12,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {ddlText}
        </pre>
      </Modal>
    </div>
  );
}
