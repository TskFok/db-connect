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
  Select,
} from "antd";
import {
  ReloadOutlined,
  CodeOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDatabaseStore } from "../../stores/databaseStore";
import type { RoutineInfo } from "../../types";
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
import { normalizeDatabaseType } from "../../utils/connectionConfig";

const { Text } = Typography;

export interface RoutineListProps {
  /** Tab 可见性变化时触发容器重测 */
  remeasureKey?: unknown;
}

const DEFAULT_ROUTINE_LIST_COLUMN_WIDTHS: Record<string, number> = {
  name: 180,
  routine_type: 110,
  data_type: 120,
  definer: 140,
  routine_comment: 200,
  a: 120,
};

const DEFAULT_ROUTINE_LIST_COLUMN_ORDER = [
  "name",
  "routine_type",
  "data_type",
  "definer",
  "routine_comment",
  "a",
] as const;

function getRoutineListCellText(
  record: RoutineInfo,
  columnKey: string
): string {
  switch (columnKey) {
    case "name":
      return record.identity_arguments
        ? `${record.name}(${record.identity_arguments})`
        : record.name;
    case "routine_type":
      return record.routine_type;
    case "data_type":
      return record.data_type ?? "-";
    case "definer":
      return record.definer ?? "";
    case "routine_comment":
      return record.routine_comment ?? "";
    case "a":
      return "查看 删除";
    default:
      return "";
  }
}

export function RoutineList({ remeasureKey }: RoutineListProps = {}) {
  const { activeConnection } = useConnectionStore();
  const clientReadOnly = useClientReadOnly();
  const { selectedDatabase } = useDatabaseStore();
  const { containerRef, scrollY } = useAntTableScrollY({ remeasureKey });
  const [data, setData] = useState<RoutineInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [filterType, setFilterType] = useState<string | null>(null);
  const [ddlOpen, setDdlOpen] = useState(false);
  const [ddlText, setDdlText] = useState("");
  const [ddlTitle, setDdlTitle] = useState("");
  const [readOnlyDb, setReadOnlyDb] = useState(false);
  const [msg, ctx] = message.useMessage();

  const connId = activeConnection?.connId ?? "";
  const database = selectedDatabase ?? "";
  const isSqlServer =
    normalizeDatabaseType(activeConnection?.config.database_type) ===
    "sqlserver";
  const writeBlocked = clientReadOnly || readOnlyDb;

  const {
    columnOrder,
    getColumnWidth,
    handleColumnResize,
    scrollX,
    sortableColumnIds,
    dnd,
  } = useListTableSettings({
    listId: LIST_TABLE_IDS.ROUTINE_LIST,
    defaultWidths: DEFAULT_ROUTINE_LIST_COLUMN_WIDTHS,
    defaultOrder: DEFAULT_ROUTINE_LIST_COLUMN_ORDER,
  });

  const load = useCallback(async () => {
    if (!connId || !database) return;
    setLoading(true);
    try {
      const rows = await api.listRoutines(connId, database, filterType);
      setData(rows);
    } catch (e) {
      msg.error(`加载例程失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [connId, database, filterType, msg]);

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

  const showDdl = useCallback(
    async (row: RoutineInfo) => {
      if (!connId || !database) return;
      try {
        const ddl = await api.getRoutineDefinition(
          connId,
          database,
          row.name,
          row.routine_type,
          row.identity_arguments
        );
        setDdlTitle(
          row.identity_arguments
            ? `${row.routine_type} ${row.name}(${row.identity_arguments})`
            : `${row.routine_type} ${row.name}`
        );
        setDdlText(ddl);
        setDdlOpen(true);
      } catch (e) {
        msg.error(`读取 DDL 失败: ${e}`);
      }
    },
    [connId, database, msg]
  );

  const handleDrop = useCallback(
    async (row: RoutineInfo) => {
      if (!connId || !database) return;
      try {
        await api.dropRoutine(
          connId,
          database,
          row.name,
          row.routine_type,
          row.identity_arguments
        );
        msg.success(
          row.identity_arguments
            ? `已删除 ${row.routine_type}「${row.name}(${row.identity_arguments})」`
            : `已删除 ${row.routine_type}「${row.name}」`
        );
        load();
      } catch (e) {
        msg.error(`删除失败: ${e}`);
      }
    },
    [connId, database, load, msg]
  );

  const columnDefinitions = useMemo<
    Record<string, ColumnsType<RoutineInfo>[number]>
  >(
    () => ({
      name: {
        title: "名称",
        dataIndex: "name",
        render: (n: string, row: RoutineInfo) => (
          <Space size={4} wrap>
            <Text code style={{ fontSize: 12 }}>
              {n}
            </Text>
            {row.identity_arguments ? (
              <Text type="secondary" style={{ fontSize: 12 }}>
                ({row.identity_arguments})
              </Text>
            ) : null}
          </Space>
        ),
      },
      routine_type: {
        title: "类型",
        dataIndex: "routine_type",
        render: (t: string) => (
          <Tag color={t === "FUNCTION" ? "green" : "geekblue"}>{t}</Tag>
        ),
      },
      data_type: {
        title: "返回值类型",
        dataIndex: "data_type",
        render: (t: string | null) => t ?? "-",
      },
      definer: {
        title: "DEFINER",
        dataIndex: "definer",
        ellipsis: true,
      },
      routine_comment: {
        title: "注释",
        dataIndex: "routine_comment",
        ellipsis: true,
      },
      a: {
        title: "操作",
        render: (_: unknown, row: RoutineInfo) => (
          <Space size={4}>
            <Tooltip title="查看 CREATE 语句">
              <Button
                type="link"
                size="small"
                icon={<CodeOutlined />}
                onClick={() => void showDdl(row)}
              />
            </Tooltip>
            {!isSqlServer && (
              <Popconfirm
                title={`删除 ${row.routine_type}？`}
                description="此操作不可恢复。"
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
            )}
          </Space>
        ),
      },
    }),
    [handleDrop, isSqlServer, showDdl, writeBlocked]
  );

  const getAutoFitWidth = useMemo(
    () =>
      createListColumnAutoFit(columnDefinitions, data, getRoutineListCellText, {
        sortableHeaders: true,
        minWidths: { a: DEFAULT_ROUTINE_LIST_COLUMN_WIDTHS.a },
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
    [
      columnDefinitions,
      columnOrder,
      getColumnWidth,
      handleColumnResize,
      getAutoFitWidth,
    ]
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
      <Space style={{ marginBottom: 12, flexShrink: 0 }} wrap>
        <Text type="secondary" style={{ fontSize: 12 }}>
          筛选：
        </Text>
        <Select
          style={{ width: 160 }}
          value={filterType}
          onChange={(v) => setFilterType(v)}
          allowClear
          placeholder="全部"
          options={[
            { value: "PROCEDURE", label: "仅存储过程" },
            { value: "FUNCTION", label: "仅函数" },
          ]}
        />
        <Button
          icon={<ReloadOutlined />}
          size="small"
          onClick={() => void load()}
        >
          刷新
        </Button>
      </Space>
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
      >
        <SortableListTable<RoutineInfo>
          className="routine-list-table"
          columns={columns}
          dataSource={data}
          rowKey={(r) => `${r.routine_type}:${r.name}`}
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
