import { useEffect, useState, useCallback } from "react";
import {
  Table,
  Button,
  Space,
  Typography,
  Tag,
  Alert,
  Popconfirm,
  message,
  Tooltip,
  Card,
} from "antd";
import {
  ReloadOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  KeyOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDatabaseStore } from "../../stores/databaseStore";
import type { IndexInfo } from "../../types";
import * as api from "../../services/tauriCommands";
import { IndexEditor } from "./IndexEditor";
import { useClientReadOnly } from "../../hooks/useClientReadOnly";
import { useAntTableScrollY } from "../../hooks/useAntTableScrollY";
import { normalizeDatabaseType } from "../../utils/connectionConfig";
import { isConnectionGloballyReadOnly } from "../../utils/sqlFileIoUi";

const { Text } = Typography;

export function IndexList() {
  const { activeConnection } = useConnectionStore();
  const clientReadOnly = useClientReadOnly();
  const {
    selectedDatabase,
    selectedTable,
    tableStructure,
    tableContentActiveTab,
  } = useDatabaseStore();

  const { containerRef, scrollY } = useAntTableScrollY({
    remeasureKey: `${tableContentActiveTab}|${selectedDatabase}|${selectedTable}`,
  });

  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState<IndexInfo | null>(null);
  const [messageApi, contextHolder] = message.useMessage();

  const connId = activeConnection?.connId ?? "";
  const database = selectedDatabase ?? "";
  const table = selectedTable ?? "";
  const databaseType = activeConnection?.config.database_type;
  const normalizedDbType = normalizeDatabaseType(databaseType);
  const isSqlite = normalizedDbType === "sqlite";
  const [readOnlyDb, setReadOnlyDb] = useState(false);
  const writeBlocked = clientReadOnly || readOnlyDb;

  // 加载索引列表
  const loadIndexes = useCallback(async () => {
    if (!connId || !database || !table) return;
    try {
      setLoading(true);
      setError(null);
      const data = await api.listIndexes(connId, database, table);
      setIndexes(data);
    } catch (e) {
      const msg = String(e);
      console.error("加载索引列表失败:", msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [connId, database, table]);

  // 表切换时加载索引
  useEffect(() => {
    loadIndexes();
  }, [loadIndexes]);

  // 表结构变化时自动刷新索引（例如在“结构”页修改主键后）
  useEffect(() => {
    if (!tableStructure) return;
    loadIndexes();
  }, [tableStructure, loadIndexes]);

  useEffect(() => {
    let cancel = false;
    if (!connId || !database || isSqlite) {
      setReadOnlyDb(false);
      return;
    }
    void (async () => {
      try {
        const ro = await isConnectionGloballyReadOnly(
          connId,
          database,
          databaseType
        );
        if (!cancel) setReadOnlyDb(ro);
      } catch {
        if (!cancel) setReadOnlyDb(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [connId, database, databaseType, isSqlite]);

  // 删除索引
  const handleDelete = async (indexName: string) => {
    if (writeBlocked) {
      messageApi.warning(
        clientReadOnly ? "只读连接无法删除索引" : "当前数据库只读，无法删除索引"
      );
      return;
    }
    try {
      await api.deleteIndex(connId, database, table, indexName);
      messageApi.success(`索引 "${indexName}" 已删除`);
      loadIndexes();
    } catch (e) {
      messageApi.error(`删除失败: ${e}`);
    }
  };

  // 创建/编辑索引成功后刷新
  const handleEditorSuccess = () => {
    const msg = editingIndex
      ? `索引 "${editingIndex.name}" 修改成功`
      : "索引创建成功";
    setEditorOpen(false);
    setEditingIndex(null);
    loadIndexes();
    messageApi.success(msg);
  };

  // 打开新建
  const handleOpenCreate = () => {
    if (writeBlocked) {
      messageApi.warning(
        clientReadOnly ? "只读连接无法新建索引" : "当前数据库只读，无法新建索引"
      );
      return;
    }
    setEditingIndex(null);
    setEditorOpen(true);
  };

  // 打开编辑
  const handleOpenEdit = (index: IndexInfo) => {
    if (writeBlocked) {
      messageApi.warning(
        clientReadOnly ? "只读连接无法编辑索引" : "当前数据库只读，无法编辑索引"
      );
      return;
    }
    setEditingIndex(index);
    setEditorOpen(true);
  };

  // 关闭编辑器
  const handleEditorCancel = () => {
    setEditorOpen(false);
    setEditingIndex(null);
  };

  // 表格列定义
  const columns: ColumnsType<IndexInfo> = [
    {
      title: "索引名称",
      dataIndex: "name",
      key: "name",
      width: 200,
      render: (name: string, record: IndexInfo) => (
        <Space size={4}>
          {record.is_primary && (
            <KeyOutlined style={{ color: "#faad14", fontSize: 12 }} />
          )}
          <Text strong style={{ color: "var(--text-primary)" }}>
            {name}
          </Text>
          {record.is_primary && (
            <Tag color="gold" style={{ fontSize: 10, lineHeight: "16px" }}>
              主键
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: "类型",
      dataIndex: "index_type",
      key: "index_type",
      width: 120,
      render: (type: string) => (
        <Text code style={{ fontSize: 12 }}>
          {type}
        </Text>
      ),
    },
    {
      title: "唯一",
      dataIndex: "unique",
      key: "unique",
      width: 80,
      align: "center",
      render: (unique: boolean) =>
        unique ? <Tag color="green">YES</Tag> : <Tag color="default">NO</Tag>,
    },
    {
      title: "包含列",
      dataIndex: "columns",
      key: "columns",
      render: (_: unknown, record: IndexInfo) => (
        <Space size={[0, 4]} wrap>
          {record.columns.map((col, idx) => (
            <Tag key={col.column_name} color="blue" style={{ fontSize: 12 }}>
              {idx + 1}. {col.column_name}
              {col.sub_part ? `(${col.sub_part})` : ""}
              {col.collation === "D" ? " DESC" : ""}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: "注释",
      dataIndex: "comment",
      key: "comment",
      width: 160,
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
      key: "action",
      width: 100,
      align: "center",
      render: (_: unknown, record: IndexInfo) => {
        const isSqliteInternalIndex =
          isSqlite && record.name.startsWith("sqlite_autoindex_");
        if (isSqliteInternalIndex) {
          return (
            <Tooltip title="SQLite 内部索引由主键或唯一约束维护，不能直接编辑或删除">
              <Text type="secondary" style={{ fontSize: 12 }}>
                系统维护
              </Text>
            </Tooltip>
          );
        }

        return (
          <Space size={4}>
            {!record.is_primary && (
              <Tooltip
                title={
                  writeBlocked
                    ? clientReadOnly
                      ? "只读连接无法编辑索引"
                      : "当前数据库只读，无法编辑索引"
                    : "编辑索引"
                }
              >
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  disabled={writeBlocked}
                  onClick={() => handleOpenEdit(record)}
                />
              </Tooltip>
            )}
            {record.is_primary ? (
              <Tooltip title="主键索引不建议直接删除">
                <Popconfirm
                  title="确定删除主键?"
                  description="删除主键可能导致严重后果，确认继续?"
                  onConfirm={() => handleDelete(record.name)}
                  okText="确认删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  disabled={writeBlocked}
                >
                  <Button
                    type="text"
                    size="small"
                    icon={<DeleteOutlined />}
                    danger
                    disabled={writeBlocked}
                  />
                </Popconfirm>
              </Tooltip>
            ) : (
              <Popconfirm
                title={`确定删除索引 "${record.name}"?`}
                onConfirm={() => handleDelete(record.name)}
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                disabled={writeBlocked}
              >
                <Button
                  type="text"
                  size="small"
                  icon={<DeleteOutlined />}
                  danger
                  disabled={writeBlocked}
                />
              </Popconfirm>
            )}
          </Space>
        );
      },
    },
  ];

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

      {/* 工具栏 */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <Space>
          <Tooltip title="刷新索引列表">
            <Button
              icon={<ReloadOutlined />}
              size="small"
              onClick={loadIndexes}
              loading={loading}
            />
          </Tooltip>
          <Tooltip
            title={
              writeBlocked
                ? clientReadOnly
                  ? "只读连接无法新建索引"
                  : "当前数据库只读，无法新建索引"
                : undefined
            }
          >
            <Button
              icon={<PlusOutlined />}
              size="small"
              type="primary"
              disabled={writeBlocked}
              onClick={handleOpenCreate}
            >
              新建索引
            </Button>
          </Tooltip>
        </Space>

        <Text type="secondary" style={{ fontSize: 12 }}>
          共 {indexes.length} 个索引
        </Text>
      </div>

      {/* 错误提示 */}
      {error && (
        <Alert
          type="error"
          message="加载索引列表失败"
          description={error}
          showIcon
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 12 }}
        />
      )}

      {/* 索引表格 */}
      <Card
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
          ref={containerRef}
          style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
        >
          <Table<IndexInfo>
            columns={columns}
            dataSource={indexes}
            rowKey="name"
            loading={loading}
            pagination={false}
            size="small"
            scroll={scrollY != null ? { y: scrollY } : undefined}
            style={{ fontSize: 13 }}
          />
        </div>
      </Card>

      {/* 创建/编辑索引对话框 */}
      <IndexEditor
        open={editorOpen}
        onCancel={handleEditorCancel}
        onSuccess={handleEditorSuccess}
        connId={connId}
        database={database}
        table={table}
        tableColumns={tableStructure ?? []}
        editingIndex={editingIndex}
      />
    </div>
  );
}
