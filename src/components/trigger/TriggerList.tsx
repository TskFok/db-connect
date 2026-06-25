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
  Modal,
} from "antd";
import {
  ReloadOutlined,
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDatabaseStore } from "../../stores/databaseStore";
import type { TriggerInfo } from "../../types";
import * as api from "../../services/tauriCommands";
import { TriggerEditor } from "./TriggerEditor";
import { useClientReadOnly } from "../../hooks/useClientReadOnly";
import { useAntTableScrollY } from "../../hooks/useAntTableScrollY";

const { Text } = Typography;

/** 事件类型对应的 Tag 颜色 */
const eventColorMap: Record<string, string> = {
  INSERT: "green",
  UPDATE: "blue",
  DELETE: "red",
};

/** 时机对应的 Tag 颜色 */
const timingColorMap: Record<string, string> = {
  BEFORE: "orange",
  AFTER: "purple",
};

export function TriggerList() {
  const { activeConnection } = useConnectionStore();
  const clientReadOnly = useClientReadOnly();
  const { selectedDatabase, selectedTable, tableContentActiveTab } = useDatabaseStore();

  const { containerRef, scrollY } = useAntTableScrollY({
    remeasureKey: `${tableContentActiveTab}|${selectedDatabase}|${selectedTable}`,
  });

  const [triggers, setTriggers] = useState<TriggerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingTrigger, setEditingTrigger] = useState<TriggerInfo | null>(null);
  const [definitionModal, setDefinitionModal] = useState<{
    open: boolean;
    title: string;
    content: string;
    loading: boolean;
  }>({ open: false, title: "", content: "", loading: false });
  const [messageApi, contextHolder] = message.useMessage();

  const connId = activeConnection?.connId ?? "";
  const database = selectedDatabase ?? "";
  const table = selectedTable ?? "";

  // 加载触发器列表
  const loadTriggers = useCallback(async () => {
    if (!connId || !database || !table) return;
    try {
      setLoading(true);
      setError(null);
      const data = await api.listTriggers(connId, database, table);
      setTriggers(data);
    } catch (e) {
      const msg = String(e);
      console.error("加载触发器列表失败:", msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [connId, database, table]);

  // 表切换时加载触发器
  useEffect(() => {
    loadTriggers();
  }, [loadTriggers]);

  // 查看触发器定义
  const handleViewDefinition = async (triggerName: string) => {
    setDefinitionModal({
      open: true,
      title: triggerName,
      content: "",
      loading: true,
    });
    try {
      const definition = await api.getTriggerDefinition(
        connId,
        database,
        triggerName,
        table
      );
      setDefinitionModal((prev) => ({
        ...prev,
        content: definition,
        loading: false,
      }));
    } catch (e) {
      setDefinitionModal((prev) => ({
        ...prev,
        content: `获取定义失败: ${e}`,
        loading: false,
      }));
    }
  };

  // 删除触发器
  const handleDelete = async (triggerName: string) => {
    try {
      await api.dropTrigger(connId, database, triggerName, table);
      messageApi.success(`触发器 "${triggerName}" 已删除`);
      loadTriggers();
    } catch (e) {
      messageApi.error(`删除失败: ${e}`);
    }
  };

  // 创建/编辑触发器成功后刷新
  const handleEditorSuccess = () => {
    const msg = editingTrigger
      ? `触发器 "${editingTrigger.name}" 修改成功`
      : "触发器创建成功";
    setEditorOpen(false);
    setEditingTrigger(null);
    loadTriggers();
    messageApi.success(msg);
  };

  // 打开新建
  const handleOpenCreate = () => {
    setEditingTrigger(null);
    setEditorOpen(true);
  };

  // 打开编辑
  const handleOpenEdit = (trigger: TriggerInfo) => {
    setEditingTrigger(trigger);
    setEditorOpen(true);
  };

  // 关闭编辑器
  const handleEditorCancel = () => {
    setEditorOpen(false);
    setEditingTrigger(null);
  };

  // 表格列定义
  const columns: ColumnsType<TriggerInfo> = [
    {
      title: "触发器名称",
      dataIndex: "name",
      key: "name",
      width: 200,
      render: (name: string) => (
        <Space size={4}>
          <ThunderboltOutlined style={{ color: "#faad14", fontSize: 12 }} />
          <Text strong style={{ color: "var(--text-primary)" }}>
            {name}
          </Text>
        </Space>
      ),
    },
    {
      title: "时机",
      dataIndex: "timing",
      key: "timing",
      width: 100,
      align: "center",
      render: (timing: string) => (
        <Tag color={timingColorMap[timing] || "default"}>{timing}</Tag>
      ),
    },
    {
      title: "事件",
      dataIndex: "event",
      key: "event",
      width: 100,
      align: "center",
      render: (event: string) => (
        <Tag color={eventColorMap[event] || "default"}>{event}</Tag>
      ),
    },
    {
      title: "语句",
      dataIndex: "statement",
      key: "statement",
      ellipsis: true,
      render: (statement: string) => (
        <Text
          code
          style={{
            fontSize: 12,
            maxWidth: "100%",
            display: "inline-block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {statement}
        </Text>
      ),
    },
    {
      title: "定义者",
      dataIndex: "definer",
      key: "definer",
      width: 160,
      ellipsis: true,
      render: (definer: string) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {definer}
        </Text>
      ),
    },
    {
      title: "创建时间",
      dataIndex: "created",
      key: "created",
      width: 170,
      render: (created: string | null) =>
        created ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {created}
          </Text>
        ) : (
          "-"
        ),
    },
    {
      title: "操作",
      key: "action",
      width: 130,
      align: "center",
      render: (_: unknown, record: TriggerInfo) => (
        <Space size={4}>
          <Tooltip
            title={clientReadOnly ? "只读连接无法编辑触发器" : "编辑触发器"}
          >
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              disabled={clientReadOnly}
              onClick={() => handleOpenEdit(record)}
            />
          </Tooltip>
          <Tooltip title="查看完整定义">
            <Button
              type="text"
              size="small"
              icon={<EyeOutlined />}
              onClick={() => handleViewDefinition(record.name)}
            />
          </Tooltip>
          <Popconfirm
            title={`确定删除触发器 "${record.name}"?`}
            description="删除后无法恢复，确认继续?"
            onConfirm={() => handleDelete(record.name)}
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            disabled={clientReadOnly}
          >
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              danger
              disabled={clientReadOnly}
            />
          </Popconfirm>
        </Space>
      ),
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
          <Tooltip title="刷新触发器列表">
            <Button
              icon={<ReloadOutlined />}
              size="small"
              onClick={loadTriggers}
              loading={loading}
            />
          </Tooltip>
          <Tooltip
            title={clientReadOnly ? "只读连接无法新建触发器" : undefined}
          >
            <Button
              icon={<PlusOutlined />}
              size="small"
              type="primary"
              disabled={clientReadOnly}
              onClick={handleOpenCreate}
            >
              新建触发器
            </Button>
          </Tooltip>
        </Space>

        <Text type="secondary" style={{ fontSize: 12 }}>
          共 {triggers.length} 个触发器
        </Text>
      </div>

      {/* 错误提示 */}
      {error && (
        <Alert
          type="error"
          message="加载触发器列表失败"
          description={error}
          showIcon
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 12 }}
        />
      )}

      {/* 触发器表格 */}
      <Card
        style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
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
          <Table<TriggerInfo>
            columns={columns}
            dataSource={triggers}
            rowKey="name"
            loading={loading}
            pagination={false}
            size="small"
            scroll={scrollY != null ? { y: scrollY } : undefined}
            style={{ fontSize: 13 }}
          />
        </div>
      </Card>

      {/* 创建/编辑触发器对话框 */}
      <TriggerEditor
        open={editorOpen}
        onCancel={handleEditorCancel}
        onSuccess={handleEditorSuccess}
        connId={connId}
        database={database}
        table={table}
        editingTrigger={editingTrigger}
      />

      {/* 查看触发器定义对话框 */}
      <Modal
        title={
          <Space>
            <ThunderboltOutlined style={{ color: "#faad14" }} />
            <span>触发器定义 - {definitionModal.title}</span>
          </Space>
        }
        open={definitionModal.open}
        onCancel={() =>
          setDefinitionModal((prev) => ({ ...prev, open: false }))
        }
        footer={[
          <Button
            key="close"
            onClick={() =>
              setDefinitionModal((prev) => ({ ...prev, open: false }))
            }
          >
            关闭
          </Button>,
        ]}
        width={720}
      >
        {definitionModal.loading ? (
          <div style={{ textAlign: "center", padding: 24 }}>加载中...</div>
        ) : (
          <pre
            style={{
              background: "var(--bg-elevated)",
              color: "var(--text-primary)",
              padding: 16,
              borderRadius: 6,
              fontSize: 13,
              lineHeight: 1.6,
              overflow: "auto",
              maxHeight: 500,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {definitionModal.content}
          </pre>
        )}
      </Modal>
    </div>
  );
}
