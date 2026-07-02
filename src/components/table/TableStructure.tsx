import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  createContext,
  useContext,
  type CSSProperties,
  type HTMLAttributes,
} from "react";
import {
  Table,
  Tag,
  Typography,
  Card,
  Space,
  Descriptions,
  Alert,
  Button,
  Modal,
  Form,
  Select,
  Switch,
  message,
  Popconfirm,
  Tooltip,
} from "antd";
import { SafeInput } from "../common/SafeInput";
import {
  KeyOutlined,
  EditOutlined,
  PlusOutlined,
  DeleteOutlined,
  HolderOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useShallow } from "zustand/react/shallow";
import { useDatabaseStore } from "../../stores/databaseStore";
import { useConnectionStore } from "../../stores/connectionStore";
import type {
  ColumnInfo,
  AlterColumnRequest,
  AddColumnRequest,
} from "../../types";
import {
  MYSQL_DATA_TYPES,
  UNSIGNED_TYPES,
  LENGTH_TYPES,
  SCALE_TYPES,
  POSTGRES_DATA_TYPES,
  POSTGRES_LENGTH_TYPES,
  POSTGRES_SCALE_TYPES,
  SQLITE_DATA_TYPES,
  SQLITE_LENGTH_TYPES,
  SQLITE_SCALE_TYPES,
  SQLSERVER_DATA_TYPES,
  SQLSERVER_LENGTH_TYPES,
  SQLSERVER_SCALE_TYPES,
  SQLSERVER_UNSIGNED_TYPES,
  parseColumnType,
  buildColumnTypeWithConfig,
} from "../../utils/columnTypeUtils";
import {
  columnInfoToReorderAlterRequest,
  computeReorderPlacementAfterMove,
  describeColumnReorderPlacement,
} from "../../utils/tableColumnReorder";
import { useClientReadOnly } from "../../hooks/useClientReadOnly";
import { useAntTableScrollY } from "../../hooks/useAntTableScrollY";
import { formatBytes } from "../../utils/formatBytes";
import { getDatabaseCapabilities } from "../../utils/databaseCapabilities";
import { normalizeDatabaseType } from "../../utils/connectionConfig";

const { Text } = Typography;

function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/** 常用 MySQL 引擎列表 */
const ENGINE_OPTIONS = [
  "InnoDB",
  "MyISAM",
  "MEMORY",
  "CSV",
  "ARCHIVE",
  "BLACKHOLE",
  "MERGE",
  "FEDERATED",
  "NDB",
];

/** 常用额外属性列表（MySQL 专属：auto_increment / ON UPDATE） */
const MYSQL_EXTRA_OPTIONS = [
  { label: "(无)", value: "" },
  { label: "auto_increment", value: "auto_increment" },
  {
    label: "ON UPDATE CURRENT_TIMESTAMP",
    value: "ON UPDATE CURRENT_TIMESTAMP",
  },
];

/** PostgreSQL 仅暴露"(无)"；identity/generated 通过类型/SQL 显式管理。 */
const POSTGRES_EXTRA_OPTIONS = [{ label: "(无)", value: "" }];

const SQLSERVER_EXTRA_OPTIONS = [
  { label: "(无)", value: "" },
  { label: "identity", value: "identity" },
];

interface StructureDragRowContextValue {
  setActivatorNodeRef: (element: HTMLElement | null) => void;
  listeners: DraggableSyntheticListeners;
  dragDisabled: boolean;
}

const StructureDragRowCtx = createContext<StructureDragRowContextValue | null>(
  null
);

function StructureDragHandleCell() {
  const ctx = useContext(StructureDragRowCtx);
  if (!ctx || ctx.dragDisabled) {
    return null;
  }
  return (
    <Tooltip title="拖拽调整顺序">
      <span
        ref={ctx.setActivatorNodeRef}
        {...(ctx.listeners ?? {})}
        style={{
          cursor: "grab",
          display: "inline-flex",
          color: "var(--text-secondary)",
          touchAction: "none",
        }}
        aria-label="拖拽调整顺序"
      >
        <HolderOutlined />
      </span>
    </Tooltip>
  );
}

type SortBodyRowProps = HTMLAttributes<HTMLTableRowElement> & {
  "data-row-key"?: string | number;
  dragDisabled: boolean;
};

function SortableStructureTableRow(props: SortBodyRowProps) {
  const { dragDisabled, children, ...trProps } = props;
  const rowKey = String(trProps["data-row-key"] ?? "");
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: rowKey,
    disabled: dragDisabled || !rowKey,
  });

  const style: CSSProperties = {
    ...props.style,
    transform: CSS.Transform.toString(transform),
    transition,
    ...(isDragging ? { position: "relative", zIndex: 1 } : {}),
  };

  const ctxVal: StructureDragRowContextValue = {
    setActivatorNodeRef,
    listeners,
    dragDisabled,
  };

  return (
    <tr ref={setNodeRef} {...trProps} {...attributes} style={style}>
      <StructureDragRowCtx.Provider value={ctxVal}>
        {children}
      </StructureDragRowCtx.Provider>
    </tr>
  );
}

export function TableStructure() {
  const activeConnection = useConnectionStore((s) => s.activeConnection);
  const clientReadOnly = useClientReadOnly();
  const {
    selectedDatabase,
    selectedTable,
    selectedTableInfo,
    tableStructure,
    structureLoading,
    structureError,
    renameTable,
    alterTableEngine,
    alterColumn,
    addColumn,
    dropColumn,
    tableContentActiveTab,
  } = useDatabaseStore(
    useShallow((s) => ({
      selectedDatabase: s.selectedDatabase,
      selectedTable: s.selectedTable,
      selectedTableInfo: s.selectedTableInfo,
      tableStructure: s.tableStructure,
      structureLoading: s.structureLoading,
      structureError: s.structureError,
      renameTable: s.renameTable,
      alterTableEngine: s.alterTableEngine,
      alterColumn: s.alterColumn,
      addColumn: s.addColumn,
      dropColumn: s.dropColumn,
      tableContentActiveTab: s.tableContentActiveTab,
    }))
  );

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editForm] = Form.useForm();
  const [editLoading, setEditLoading] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();

  // 列编辑 Modal 状态
  const [columnModalOpen, setColumnModalOpen] = useState(false);
  const [columnModalMode, setColumnModalMode] = useState<"edit" | "add">(
    "edit"
  );
  const [editingColumnName, setEditingColumnName] = useState<string>("");
  const [columnForm] = Form.useForm();
  const [columnLoading, setColumnLoading] = useState(false);

  const connId = activeConnection?.connId ?? "";
  const database = selectedDatabase ?? "";
  const table = selectedTable ?? "";
  const isView = selectedTableInfo?.table_type === "VIEW";
  const capabilities = useMemo(
    () => getDatabaseCapabilities(activeConnection?.config.database_type),
    [activeConnection?.config.database_type]
  );
  const databaseType = normalizeDatabaseType(
    activeConnection?.config.database_type
  );
  const isSqlite = databaseType === "sqlite";
  const isSqlServer = databaseType === "sqlserver";
  const structureReadOnly =
    clientReadOnly || isView || !capabilities.schemaManagement;
  const showEngine = capabilities.storageEngine;
  const columnReorderingEnabled = capabilities.columnReordering;
  const dataTypeOptions = isSqlite
    ? SQLITE_DATA_TYPES
    : isSqlServer
      ? SQLSERVER_DATA_TYPES
      : showEngine
        ? MYSQL_DATA_TYPES
        : POSTGRES_DATA_TYPES;
  const lengthSet = isSqlite
    ? SQLITE_LENGTH_TYPES
    : isSqlServer
      ? SQLSERVER_LENGTH_TYPES
      : showEngine
        ? LENGTH_TYPES
        : POSTGRES_LENGTH_TYPES;
  const scaleSet = isSqlite
    ? SQLITE_SCALE_TYPES
    : isSqlServer
      ? SQLSERVER_SCALE_TYPES
      : showEngine
        ? SCALE_TYPES
        : POSTGRES_SCALE_TYPES;
  const unsignedSet = isSqlServer
    ? SQLSERVER_UNSIGNED_TYPES
    : showEngine
      ? UNSIGNED_TYPES
      : new Set<string>();
  const extraOptions = showEngine
    ? MYSQL_EXTRA_OPTIONS
    : isSqlServer
      ? SQLSERVER_EXTRA_OPTIONS
      : POSTGRES_EXTRA_OPTIONS;
  const canAlterColumnDefinition = !isSqlite;

  const [structureOrderOverride, setStructureOrderOverride] = useState<
    ColumnInfo[] | null
  >(null);
  // PostgreSQL 不支持原生重排列；即便有写权限也禁用拖拽，避免误导用户。
  const dragSortEnabled = !structureReadOnly && columnReorderingEnabled;
  const dragRowDisabled =
    structureReadOnly || structureLoading || !columnReorderingEnabled;
  const { containerRef: tableContainerRef, scrollY: tableScrollY } =
    useAntTableScrollY({
      remeasureKey: `${tableContentActiveTab}|${selectedDatabase}|${selectedTable}`,
    });

  const displayCols = useMemo(
    () => structureOrderOverride ?? tableStructure ?? [],
    [structureOrderOverride, tableStructure]
  );

  useEffect(() => {
    setStructureOrderOverride(null);
  }, [tableStructure, database, selectedTable]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  );

  const columnSortableIds = useMemo(
    () => displayCols.map((c) => c.name),
    [displayCols]
  );

  const handleStructureDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!dragSortEnabled || !connId || !database || !table) return;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const items = displayCols;
      const activeId = String(active.id);
      const overId = String(over.id);
      const oldIndex = items.findIndex((c) => c.name === activeId);
      const newIndex = items.findIndex((c) => c.name === overId);
      if (oldIndex < 0 || newIndex < 0) return;
      const result = computeReorderPlacementAfterMove(
        items,
        oldIndex,
        newIndex
      );
      if (!result) return;

      const placementText = describeColumnReorderPlacement(result.placement);
      Modal.confirm({
        title: "确认调整列顺序？",
        content: `将列「${result.column.name}」${placementText}。此操作将执行 ALTER TABLE 修改列顺序，是否继续？`,
        okText: "确认",
        cancelText: "取消",
        centered: true,
        onOk: async () => {
          const optimistic = arrayMove(items, oldIndex, newIndex);
          setStructureOrderOverride(optimistic);
          try {
            await alterColumn(
              connId,
              database,
              table,
              columnInfoToReorderAlterRequest(result.column, result.placement)
            );
            messageApi.success("列顺序已更新");
          } catch (e) {
            setStructureOrderOverride(null);
            messageApi.error(toErrorMessage(e));
          }
        },
      });
    },
    [
      dragSortEnabled,
      connId,
      database,
      table,
      displayCols,
      alterColumn,
      messageApi,
    ]
  );

  // 打开编辑表属性 Modal
  const handleOpenEditModal = useCallback(() => {
    editForm.setFieldsValue({
      tableName: selectedTable ?? "",
      engine: selectedTableInfo?.engine ?? "InnoDB",
    });
    setEditModalOpen(true);
  }, [editForm, selectedTable, selectedTableInfo]);

  // 保存表属性
  const handleEditSave = useCallback(async () => {
    if (!connId || !database || !selectedTable) return;
    try {
      const values = await editForm.validateFields();
      setEditLoading(true);

      const newName = values.tableName?.trim();
      const newEngine = showEngine ? values.engine : null;

      if (newName && newName !== selectedTable) {
        await renameTable(connId, database, selectedTable, newName);
        messageApi.success(`表名已修改为 "${newName}"`);
      }

      const currentTable =
        newName && newName !== selectedTable ? newName : selectedTable;
      if (showEngine && newEngine && newEngine !== selectedTableInfo?.engine) {
        await alterTableEngine(connId, database, currentTable, newEngine);
        messageApi.success(`引擎已修改为 "${newEngine}"`);
      }

      setEditModalOpen(false);
    } catch (e) {
      messageApi.error(toErrorMessage(e));
    } finally {
      setEditLoading(false);
    }
  }, [
    connId,
    database,
    selectedTable,
    selectedTableInfo,
    editForm,
    renameTable,
    alterTableEngine,
    messageApi,
    showEngine,
  ]);

  // 打开列编辑 Modal
  const handleOpenColumnEdit = useCallback(
    (column: ColumnInfo) => {
      setColumnModalMode("edit");
      setEditingColumnName(column.name);
      const parsed = parseColumnType(column.column_type);
      columnForm.setFieldsValue({
        name: column.name,
        data_type: parsed.dataType,
        length: parsed.length,
        scale: parsed.scale,
        unsigned: parsed.unsigned,
        nullable: column.nullable,
        is_primary: column.key === "PRI",
        default_value: column.default_value ?? "",
        extra: column.extra,
        comment: column.comment,
      });
      setColumnModalOpen(true);
    },
    [columnForm]
  );

  // 打开新增列 Modal
  const handleOpenAddColumn = useCallback(() => {
    setColumnModalMode("add");
    setEditingColumnName("");
    columnForm.setFieldsValue({
      name: "",
      data_type: isSqlite ? "TEXT" : isSqlServer ? "nvarchar" : "varchar",
      length: isSqlite ? "" : "255",
      scale: "",
      unsigned: false,
      nullable: true,
      default_value: "",
      extra: "",
      comment: "",
      after_column: null,
    });
    setColumnModalOpen(true);
  }, [columnForm, isSqlite, isSqlServer]);

  // 保存列 (编辑/新增)
  const handleColumnSave = useCallback(async () => {
    if (!connId || !database || !table) return;
    try {
      const values = await columnForm.validateFields();
      setColumnLoading(true);

      const defaultVal =
        values.default_value?.trim() === ""
          ? null
          : (values.default_value?.trim() ?? null);
      const columnType = buildColumnTypeWithConfig(
        values.data_type,
        values.length || "",
        values.scale || "",
        values.unsigned || false,
        {
          scaleTypes: scaleSet,
          unsignedTypes: unsignedSet,
        }
      );

      if (columnModalMode === "edit") {
        const request: AlterColumnRequest = {
          old_name: editingColumnName,
          new_name: values.name.trim(),
          column_type: columnType,
          nullable: values.nullable,
          default_value: defaultVal,
          extra: values.extra || "",
          comment: values.comment?.trim() || "",
          is_primary: isSqlServer ? undefined : values.is_primary === true,
        };
        await alterColumn(connId, database, table, request);
        messageApi.success(`列 "${editingColumnName}" 修改成功`);
      } else {
        const request: AddColumnRequest = {
          name: values.name.trim(),
          column_type: columnType,
          nullable: values.nullable,
          default_value: defaultVal,
          extra: values.extra || "",
          comment: values.comment?.trim() || "",
          after_column: values.after_column || null,
        };
        await addColumn(connId, database, table, request);
        messageApi.success(`列 "${values.name}" 新增成功`);
      }

      setColumnModalOpen(false);
    } catch (e) {
      messageApi.error(toErrorMessage(e));
    } finally {
      setColumnLoading(false);
    }
  }, [
    connId,
    database,
    table,
    columnForm,
    columnModalMode,
    editingColumnName,
    alterColumn,
    addColumn,
    messageApi,
    isSqlServer,
    scaleSet,
    unsignedSet,
  ]);

  // 删除列
  const handleDropColumn = useCallback(
    async (columnName: string) => {
      if (!connId || !database || !table) return;
      try {
        await dropColumn(connId, database, table, columnName);
        messageApi.success(`列 "${columnName}" 已删除`);
      } catch (e) {
        messageApi.error(toErrorMessage(e));
      }
    },
    [connId, database, table, dropColumn, messageApi]
  );

  /** 列表格的列定义 */
  const columns = useMemo((): ColumnsType<ColumnInfo> => {
    const base: ColumnsType<ColumnInfo> = [
      {
        title: "列名",
        dataIndex: "name",
        key: "name",
        width: 180,
        render: (name: string, record: ColumnInfo) => (
          <Space size={4}>
            {record.key === "PRI" && (
              <KeyOutlined style={{ color: "#faad14", fontSize: 12 }} />
            )}
            <Text strong style={{ color: "var(--text-primary)" }}>
              {name}
            </Text>
          </Space>
        ),
      },
      {
        title: "类型",
        dataIndex: "column_type",
        key: "column_type",
        width: 180,
        render: (type: string) => (
          <Text code style={{ fontSize: 12 }}>
            {type}
          </Text>
        ),
      },
      {
        title: "可空",
        dataIndex: "nullable",
        key: "nullable",
        width: 80,
        align: "center",
        render: (nullable: boolean) =>
          nullable ? (
            <Tag color="default">YES</Tag>
          ) : (
            <Tag color="blue">NO</Tag>
          ),
      },
      {
        title: "键",
        dataIndex: "key",
        key: "key",
        width: 80,
        align: "center",
        render: (key: string) => {
          if (!key) return "-";
          const colorMap: Record<string, string> = {
            PRI: "gold",
            UNI: "green",
            MUL: "cyan",
          };
          return <Tag color={colorMap[key] || "default"}>{key}</Tag>;
        },
      },
      {
        title: "默认值",
        dataIndex: "default_value",
        key: "default_value",
        width: 140,
        render: (value: string | null) =>
          value !== null ? (
            <Text style={{ fontSize: 12 }}>{value || "''"}</Text>
          ) : (
            <Text type="secondary" style={{ fontSize: 12 }}>
              NULL
            </Text>
          ),
      },
      {
        title: "额外",
        dataIndex: "extra",
        key: "extra",
        width: 160,
        render: (extra: string) =>
          extra ? (
            <Tag color="purple" style={{ fontSize: 11 }}>
              {extra}
            </Tag>
          ) : (
            "-"
          ),
      },
      {
        title: "注释",
        dataIndex: "comment",
        key: "comment",
        ellipsis: true,
        render: (comment: string) =>
          comment ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {comment}
            </Text>
          ) : (
            "-"
          ),
      },
      {
        title: "操作",
        key: "actions",
        width: 100,
        align: "center",
        render: (_: unknown, record: ColumnInfo) => (
          <Space size={4}>
            {canAlterColumnDefinition && (
              <Tooltip title={clientReadOnly ? "只读连接无法编辑列" : "编辑列"}>
                <Button
                  type="link"
                  size="small"
                  icon={<EditOutlined />}
                  aria-label="编辑列"
                  disabled={structureReadOnly}
                  onClick={() => handleOpenColumnEdit(record)}
                />
              </Tooltip>
            )}
            <Popconfirm
              title={`确定删除列 "${record.name}" 吗?`}
              description="此操作不可撤销，列数据将永久丢失"
              onConfirm={() => handleDropColumn(record.name)}
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              disabled={structureReadOnly}
            >
              <Tooltip title={clientReadOnly ? "只读连接无法删除列" : "删除列"}>
                <Button
                  type="link"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label="删除列"
                  disabled={structureReadOnly}
                />
              </Tooltip>
            </Popconfirm>
          </Space>
        ),
      },
    ];

    const withoutActionsForView = isView
      ? base.filter((c) => c.key !== "actions")
      : base;

    if (!dragSortEnabled) {
      return withoutActionsForView;
    }

    const dragColumn: ColumnsType<ColumnInfo>[0] = {
      title: (
        <Tooltip title="拖拽手柄调整顺序">
          <HolderOutlined style={{ color: "var(--text-secondary)" }} />
        </Tooltip>
      ),
      key: "__drag_order__",
      width: 48,
      align: "center",
      render: () => <StructureDragHandleCell />,
    };

    return [dragColumn, ...withoutActionsForView];
  }, [
    isView,
    dragSortEnabled,
    structureReadOnly,
    canAlterColumnDefinition,
    clientReadOnly,
    handleOpenColumnEdit,
    handleDropColumn,
  ]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      {contextHolder}

      {/* 表元数据 */}
      {selectedTableInfo && !isView && (
        <Card
          size="small"
          style={{ marginBottom: 12 }}
          extra={
            <Tooltip
              title={clientReadOnly ? "只读连接无法修改表属性" : undefined}
            >
              <Button
                type="link"
                icon={<EditOutlined />}
                size="small"
                disabled={structureReadOnly}
                onClick={handleOpenEditModal}
              >
                编辑表属性
              </Button>
            </Tooltip>
          }
        >
          <Descriptions size="small" column={showEngine ? 5 : 4}>
            {showEngine && (
              <Descriptions.Item label="引擎">
                {selectedTableInfo.engine || "-"}
              </Descriptions.Item>
            )}
            <Descriptions.Item label="预估行数">
              {selectedTableInfo.rows?.toLocaleString() ?? "-"}
            </Descriptions.Item>
            <Descriptions.Item label="数据大小">
              {formatBytes(selectedTableInfo.data_length)}
            </Descriptions.Item>
            <Descriptions.Item label="索引容量">
              {formatBytes(selectedTableInfo.index_length)}
            </Descriptions.Item>
            <Descriptions.Item label="注释">
              {selectedTableInfo.comment || "-"}
            </Descriptions.Item>
          </Descriptions>
        </Card>
      )}

      {/* 错误提示 */}
      {structureError && (
        <Alert
          type="error"
          message="加载表结构失败"
          description={structureError}
          showIcon
          style={{ marginBottom: 12 }}
        />
      )}

      {/* 列结构表格 */}
      <Card
        title={
          <Space>
            <Text strong>列结构</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              ({displayCols.length} 列)
            </Text>
          </Space>
        }
        extra={
          !isView && (
            <Tooltip title={clientReadOnly ? "只读连接无法新增列" : undefined}>
              <Button
                type="primary"
                size="small"
                icon={<PlusOutlined />}
                disabled={structureReadOnly}
                onClick={handleOpenAddColumn}
              >
                新增列
              </Button>
            </Tooltip>
          )
        }
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
        styles={{
          body: {
            flex: 1,
            minHeight: 0,
            padding: 0,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
          },
        }}
      >
        <div
          ref={tableContainerRef}
          style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
        >
          {dragSortEnabled ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleStructureDragEnd}
            >
              <SortableContext
                items={columnSortableIds}
                strategy={verticalListSortingStrategy}
              >
                <Table<ColumnInfo>
                  columns={columns}
                  dataSource={displayCols}
                  rowKey="name"
                  loading={structureLoading}
                  pagination={false}
                  size="small"
                  scroll={
                    tableScrollY != null ? { y: tableScrollY } : undefined
                  }
                  style={{ fontSize: 13 }}
                  components={{
                    body: {
                      row: (
                        rowProps: HTMLAttributes<HTMLTableRowElement> & {
                          "data-row-key"?: string | number;
                        }
                      ) => (
                        <SortableStructureTableRow
                          {...rowProps}
                          dragDisabled={dragRowDisabled}
                        />
                      ),
                    },
                  }}
                />
              </SortableContext>
            </DndContext>
          ) : (
            <Table<ColumnInfo>
              columns={columns}
              dataSource={displayCols}
              rowKey="name"
              loading={structureLoading}
              pagination={false}
              size="small"
              scroll={tableScrollY != null ? { y: tableScrollY } : undefined}
              style={{ fontSize: 13 }}
            />
          )}
        </div>
      </Card>

      {/* 编辑表属性 Modal */}
      <Modal
        title="编辑表属性"
        open={editModalOpen}
        onOk={handleEditSave}
        onCancel={() => setEditModalOpen(false)}
        confirmLoading={editLoading}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical" size="small">
          <Form.Item
            name="tableName"
            label="表名"
            rules={[
              { required: true, message: "表名不能为空" },
              {
                pattern: /^[a-zA-Z_][a-zA-Z0-9_]*$/,
                message: "表名只能包含字母、数字和下划线，且不能以数字开头",
              },
            ]}
          >
            <SafeInput placeholder="请输入新的表名" />
          </Form.Item>
          {showEngine && (
            <Form.Item
              name="engine"
              label="存储引擎"
              rules={[{ required: true, message: "请选择存储引擎" }]}
            >
              <Select
                placeholder="选择存储引擎"
                options={ENGINE_OPTIONS.map((e) => ({ label: e, value: e }))}
                showSearch
              />
            </Form.Item>
          )}
        </Form>
      </Modal>

      {/* 列编辑/新增 Modal */}
      <Modal
        title={
          columnModalMode === "edit"
            ? `编辑列 "${editingColumnName}"`
            : "新增列"
        }
        open={columnModalOpen}
        onOk={handleColumnSave}
        onCancel={() => setColumnModalOpen(false)}
        confirmLoading={columnLoading}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
        width={520}
      >
        <Form form={columnForm} layout="vertical" size="small">
          <Form.Item
            name="name"
            label="列名"
            rules={[{ required: true, message: "列名不能为空" }]}
          >
            <SafeInput placeholder="请输入列名" />
          </Form.Item>
          <Form.Item
            name="data_type"
            label="数据类型"
            rules={[{ required: true, message: "请选择数据类型" }]}
          >
            <Select
              placeholder="选择数据类型"
              options={dataTypeOptions}
              showSearch
              filterOption={(input, option) => {
                const opt = option as {
                  value?: string;
                  options?: { value: string; label: string }[];
                };
                if (opt.value) {
                  return opt.value.toLowerCase().includes(input.toLowerCase());
                }
                if (opt.options) {
                  return opt.options.some(
                    (o) =>
                      o.value.toLowerCase().includes(input.toLowerCase()) ||
                      o.label.toLowerCase().includes(input.toLowerCase())
                  );
                }
                return false;
              }}
              onChange={() => {
                const dt = columnForm.getFieldValue("data_type") as string;
                if (!unsignedSet.has(dt)) {
                  columnForm.setFieldValue("unsigned", false);
                }
              }}
            />
          </Form.Item>
          <Form.Item noStyle dependencies={["data_type"]}>
            {() => {
              const dt = columnForm.getFieldValue("data_type") as string;
              const showLength = lengthSet.has(dt);
              const showScale = scaleSet.has(dt);
              const showUnsigned = unsignedSet.has(dt);
              return (
                <div style={{ display: "flex", gap: 12 }}>
                  {showLength && (
                    <Form.Item
                      name="length"
                      label={showScale ? "总位数 (M)" : "长度"}
                      style={{ flex: 1 }}
                    >
                      <SafeInput placeholder={showScale ? "如 10" : "如 255"} />
                    </Form.Item>
                  )}
                  {showScale && (
                    <Form.Item
                      name="scale"
                      label="小数位数 (D)"
                      style={{ flex: 1 }}
                    >
                      <SafeInput placeholder="如 2" />
                    </Form.Item>
                  )}
                  {showUnsigned && (
                    <Form.Item
                      name="unsigned"
                      label="UNSIGNED"
                      valuePropName="checked"
                    >
                      <Switch />
                    </Form.Item>
                  )}
                </div>
              );
            }}
          </Form.Item>
          <Form.Item name="nullable" label="允许 NULL" valuePropName="checked">
            <Switch />
          </Form.Item>
          {columnModalMode === "edit" && !isSqlite && !isSqlServer && (
            <Form.Item name="is_primary" label="主键" valuePropName="checked">
              <Switch />
            </Form.Item>
          )}
          <Form.Item name="default_value" label="默认值">
            <SafeInput placeholder="留空表示无默认值, 输入 NULL 表示默认 NULL, CURRENT_TIMESTAMP 等" />
          </Form.Item>
          {!isSqlite && (
            <Form.Item name="extra" label="额外属性">
              <Select
                placeholder="选择额外属性"
                options={extraOptions}
                allowClear
              />
            </Form.Item>
          )}
          {!isSqlite && (
            <Form.Item name="comment" label="注释">
              <SafeInput placeholder="列注释 (可选)" />
            </Form.Item>
          )}
          {columnModalMode === "add" && columnReorderingEnabled && (
            <Form.Item name="after_column" label="位置 (在哪个列之后)">
              <Select
                placeholder="默认添加到末尾"
                allowClear
                options={
                  tableStructure?.map((col) => ({
                    label: col.name,
                    value: col.name,
                  })) ?? []
                }
              />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  );
}
