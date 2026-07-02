import { useEffect, useState, useCallback, useMemo } from "react";
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
  Form,
  Select,
  Collapse,
} from "antd";
import {
  ReloadOutlined,
  PlusOutlined,
  DeleteOutlined,
  LinkOutlined,
} from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDatabaseStore } from "../../stores/databaseStore";
import type { AddForeignKeyRequest, ForeignKeyInfo } from "../../types";
import * as api from "../../services/tauriCommands";
import { SafeInput } from "../common/SafeInput";
import { MermaidBlock } from "../common/MermaidBlock";
import { buildForeignKeyMermaidDiagram } from "../../utils/foreignKeyMermaid";
import { previewAddForeignKeySql } from "../../utils/foreignKeySql";
import { isConnectionGloballyReadOnly } from "../../utils/sqlFileIoUi";
import { useClientReadOnly } from "../../hooks/useClientReadOnly";
import { useAntTableScrollY } from "../../hooks/useAntTableScrollY";
import { normalizeDatabaseType } from "../../utils/connectionConfig";

const { Text } = Typography;

/** 外键列表 Card 保底高度，避免关系图展开后表格区域被压到不可见 */
const FK_TABLE_MIN_HEIGHT = 120;

const ACTION_OPTIONS = [
  "RESTRICT",
  "CASCADE",
  "SET NULL",
  "NO ACTION",
  "SET DEFAULT",
];

const SQLSERVER_ACTION_OPTIONS = [
  "NO ACTION",
  "CASCADE",
  "SET NULL",
  "SET DEFAULT",
];

function formatFkTableRef(fk: ForeignKeyInfo): string {
  return `${fk.table_schema}.${fk.table_name}`;
}

function formatParentRef(fk: ForeignKeyInfo): string {
  return `${fk.referenced_table_schema}.${fk.referenced_table_name}`;
}

export function ForeignKeyList() {
  const { activeConnection } = useConnectionStore();
  const clientReadOnly = useClientReadOnly();
  const {
    selectedDatabase,
    selectedTable,
    tableStructure,
    tableContentActiveTab,
  } = useDatabaseStore();
  const [fks, setFks] = useState<ForeignKeyInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardLoading, setWizardLoading] = useState(false);
  const [readOnlyDb, setReadOnlyDb] = useState(false);
  const [form] = Form.useForm<{
    constraint_name: string;
    columns: string[];
    referenced_table: string;
    referenced_columns_text: string;
    on_update: string;
    on_delete: string;
  }>();

  const connId = activeConnection?.connId ?? "";
  const databaseType = activeConnection?.config.database_type;
  const database = selectedDatabase ?? "";
  const table = selectedTable ?? "";
  const isSqlite = normalizeDatabaseType(databaseType) === "sqlite";
  const isSqlServer = normalizeDatabaseType(databaseType) === "sqlserver";
  const actionOptions = isSqlServer ? SQLSERVER_ACTION_OPTIONS : ACTION_OPTIONS;
  const dropForeignKeyVerb = isSqlServer ? "DROP CONSTRAINT" : "DROP FOREIGN KEY";
  const writeBlocked = clientReadOnly || readOnlyDb;

  const [diagramExpanded, setDiagramExpanded] = useState(false);

  const mermaidText = useMemo(() => buildForeignKeyMermaidDiagram(fks), [fks]);
  const { containerRef: tableContainerRef, scrollY: tableScrollY } =
    useAntTableScrollY({
      remeasureKey: `${tableContentActiveTab}|${selectedDatabase}|${selectedTable}|${diagramExpanded}`,
    });

  const loadForeignKeys = useCallback(async () => {
    if (!connId || !database || !table) return;
    try {
      setLoading(true);
      setError(null);
      const data = await api.listForeignKeys(connId, database, table);
      setFks(data);
    } catch (e) {
      const msg = String(e);
      console.error("加载外键失败:", msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [connId, database, table]);

  useEffect(() => {
    loadForeignKeys();
  }, [loadForeignKeys]);

  useEffect(() => {
    let cancel = false;
    if (!connId || !database) {
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
  }, [connId, database, databaseType]);

  const handleDrop = async (fk: ForeignKeyInfo) => {
    if (writeBlocked) {
      messageApi.warning(
        clientReadOnly ? "只读连接无法删除外键" : "实例只读，无法删除外键"
      );
      return;
    }
    try {
      await api.dropForeignKey(
        connId,
        fk.table_schema,
        fk.table_name,
        fk.constraint_name
      );
      messageApi.success(`已删除外键约束 "${fk.constraint_name}"`);
      loadForeignKeys();
    } catch (e) {
      messageApi.error(`删除失败: ${e}`);
    }
  };

  const openWizard = () => {
    form.resetFields();
    form.setFieldsValue({
      constraint_name: "",
      columns: [],
      referenced_table: "",
      referenced_columns_text: "",
      on_update: isSqlServer ? "NO ACTION" : "RESTRICT",
      on_delete: isSqlServer ? "NO ACTION" : "RESTRICT",
    });
    setWizardOpen(true);
  };

  const handleWizardOk = async () => {
    if (writeBlocked) {
      messageApi.warning(
        clientReadOnly ? "只读连接无法添加外键" : "实例只读，无法添加外键"
      );
      return;
    }
    try {
      const v = await form.validateFields();
      const refCols = v.referenced_columns_text
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const req: AddForeignKeyRequest = {
        constraint_name: v.constraint_name.trim(),
        columns: v.columns,
        referenced_table: v.referenced_table.trim(),
        referenced_columns: refCols,
        on_update: v.on_update,
        on_delete: v.on_delete,
      };
      let preview: string;
      try {
        preview = previewAddForeignKeySql(
          database,
          table,
          req,
          isSqlServer ? "sqlserver" : undefined
        );
      } catch (err) {
        messageApi.error(err instanceof Error ? err.message : String(err));
        return;
      }

      Modal.confirm({
        title: "确认执行以下 DDL？",
        width: 640,
        content: (
          <div>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="外键会锁表并可能失败（类型不兼容、已有脏数据等）。请在低峰期操作并确保有备份。"
            />
            <pre
              style={{
                maxHeight: 220,
                overflow: "auto",
                fontSize: 12,
                margin: 0,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {preview}
            </pre>
          </div>
        ),
        okText: "执行",
        cancelText: "取消",
        okButtonProps: { danger: true },
        onOk: async () => {
          setWizardLoading(true);
          try {
            await api.addForeignKey(connId, database, table, req);
            messageApi.success("外键已添加");
            setWizardOpen(false);
            loadForeignKeys();
          } catch (e) {
            messageApi.error(`执行失败: ${e}`);
            throw e;
          } finally {
            setWizardLoading(false);
          }
        },
      });
    } catch {
      /* validate */
    }
  };

  const columns: ColumnsType<ForeignKeyInfo> = [
    {
      title: "约束名",
      dataIndex: "constraint_name",
      key: "constraint_name",
      width: 140,
      render: (name: string) => (
        <Text code style={{ fontSize: 12 }}>
          {name}
        </Text>
      ),
    },
    {
      title: "方向",
      dataIndex: "direction",
      key: "direction",
      width: 100,
      render: (d: string) =>
        d === "outgoing" ? (
          <Tag color="blue">本表引用他表</Tag>
        ) : (
          <Tag color="purple">他表引用本表</Tag>
        ),
    },
    {
      title: "子表",
      key: "child",
      width: 160,
      ellipsis: true,
      render: (_: unknown, fk: ForeignKeyInfo) => (
        <Text style={{ fontSize: 12 }}>{formatFkTableRef(fk)}</Text>
      ),
    },
    {
      title: "本地列",
      key: "cols",
      width: 120,
      ellipsis: true,
      render: (_: unknown, fk: ForeignKeyInfo) => fk.column_names.join(", "),
    },
    {
      title: "父表",
      key: "parent",
      width: 160,
      ellipsis: true,
      render: (_: unknown, fk: ForeignKeyInfo) => (
        <Text style={{ fontSize: 12 }}>{formatParentRef(fk)}</Text>
      ),
    },
    {
      title: "引用列",
      key: "rcols",
      width: 120,
      ellipsis: true,
      render: (_: unknown, fk: ForeignKeyInfo) =>
        fk.referenced_column_names.join(", "),
    },
    {
      title: "ON UPDATE / DELETE",
      key: "rules",
      width: 140,
      render: (_: unknown, fk: ForeignKeyInfo) => (
        <Text type="secondary" style={{ fontSize: 11 }}>
          {fk.update_rule} / {fk.delete_rule}
        </Text>
      ),
    },
    {
      title: "操作",
      key: "act",
      width: 88,
      fixed: "right",
      render: (_: unknown, fk: ForeignKeyInfo) => (
        <Popconfirm
          title="删除此外键？"
          description={`将在子表 ${formatFkTableRef(fk)} 上执行 ${dropForeignKeyVerb}「${fk.constraint_name}」。`}
          okText="删除"
          cancelText="取消"
          okButtonProps={{ danger: true }}
          disabled={writeBlocked}
          onConfirm={() => handleDrop(fk)}
        >
          <Tooltip
            title={
              writeBlocked
                ? clientReadOnly
                  ? "只读连接无法在子表上删除外键"
                  : "只读实例"
                : "在子表上删除此外键"
            }
          >
            <Button
              type="link"
              size="small"
              danger
              icon={<DeleteOutlined />}
              disabled={writeBlocked}
            />
          </Tooltip>
        </Popconfirm>
      ),
    },
  ];

  const colOptions =
    tableStructure?.map((c) => ({ label: c.name, value: c.name })) ?? [];

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
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message={
          isSqlite
            ? "SQLite 外键可在此查看；新增或删除外键需要通过重建表结构完成。"
            : "外键在子表上定义。「他表引用本表」时，删除操作作用于对方子表上的约束。"
        }
      />

      {error && (
        <Alert
          type="error"
          message={error}
          showIcon
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 12 }}
        />
      )}

      <div
        data-testid="fk-diagram-section"
        className={
          diagramExpanded
            ? "foreign-key-diagram-section foreign-key-diagram-section--expanded"
            : "foreign-key-diagram-section"
        }
      >
        <Collapse
          size="small"
          activeKey={diagramExpanded ? ["diagram"] : []}
          onChange={(keys) => {
            const next = Array.isArray(keys) ? keys : [keys];
            setDiagramExpanded(next.includes("diagram"));
          }}
          items={[
            {
              key: "diagram",
              label: (
                <Space>
                  <LinkOutlined />
                  <Text strong>关系图</Text>
                  <Text
                    type="secondary"
                    style={{ fontSize: 12, fontWeight: 400 }}
                  >
                    （默认折叠，展开后可在下方查看外键列表）
                  </Text>
                </Space>
              ),
              children: (
                <>
                  <Text
                    type="secondary"
                    style={{ fontSize: 12, display: "block", marginBottom: 8 }}
                  >
                    由 Mermaid 在本地渲染；可展开查看源码以便复制到文档。
                  </Text>
                  <MermaidBlock chart={mermaidText} minHeight={120} />
                  <Collapse
                    size="small"
                    style={{ marginTop: 8 }}
                    items={[
                      {
                        key: "src",
                        label: "Mermaid 源码",
                        children: (
                          <pre
                            style={{
                              margin: 0,
                              maxHeight: 160,
                              overflow: "auto",
                              fontSize: 12,
                              whiteSpace: "pre-wrap",
                            }}
                          >
                            {mermaidText}
                          </pre>
                        ),
                      },
                    ]}
                  />
                </>
              ),
            },
          ]}
        />
      </div>

      <Card
        title={<Text strong>外键列表</Text>}
        extra={
          <Space>
            <Button
              icon={<ReloadOutlined />}
              size="small"
              onClick={loadForeignKeys}
            >
              刷新
            </Button>
            {!isSqlite && (
              <Tooltip
                title={clientReadOnly ? "只读连接无法添加外键" : undefined}
              >
                <Button
                  type="primary"
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={openWizard}
                  disabled={writeBlocked}
                >
                  添加外键向导
                </Button>
              </Tooltip>
            )}
          </Space>
        }
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
        style={{
          flex: 1,
          minHeight: FK_TABLE_MIN_HEIGHT,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          ref={tableContainerRef}
          style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
        >
          <Table<ForeignKeyInfo>
            columns={
              isSqlite
                ? columns.filter((column) => column.key !== "act")
                : columns
            }
            dataSource={fks}
            rowKey={(r) =>
              `${r.constraint_name}@${r.table_schema}.${r.table_name}`
            }
            loading={loading}
            pagination={false}
            size="small"
            scroll={{
              x: 1000,
              ...(tableScrollY != null ? { y: tableScrollY } : {}),
            }}
          />
        </div>
      </Card>

      <Modal
        title="添加外键（向导）"
        open={wizardOpen}
        onCancel={() => setWizardOpen(false)}
        onOk={() => void handleWizardOk()}
        confirmLoading={wizardLoading}
        okText="生成并确认"
        width={560}
        destroyOnHidden
      >
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="请先确认列类型、索引与数据一致；失败时数据库会返回具体错误。"
        />
        <Form form={form} layout="vertical" size="small">
          <Form.Item
            name="constraint_name"
            label="约束名"
            rules={[{ required: true, message: "请输入约束名" }]}
          >
            <SafeInput placeholder="如 fk_orders_user_id" />
          </Form.Item>
          <Form.Item
            name="columns"
            label="本表列（顺序与引用列对应）"
            rules={[{ required: true, message: "请选择至少一列" }]}
          >
            <Select
              mode="multiple"
              placeholder="选择列"
              options={colOptions}
              showSearch
              optionFilterProp="label"
            />
          </Form.Item>
          <Form.Item
            name="referenced_table"
            label="被引用表"
            rules={[
              {
                required: true,
                message: isSqlServer
                  ? "请输入表名或 schema.表"
                  : "请输入表名或 库.表",
              },
            ]}
          >
            <SafeInput
              placeholder={
                isSqlServer ? "users 或 sales.users" : "users 或 other_db.users"
              }
            />
          </Form.Item>
          <Form.Item
            name="referenced_columns_text"
            label="引用列（逗号分隔，顺序与上面一致）"
            rules={[{ required: true, message: "请输入引用列" }]}
          >
            <SafeInput placeholder="id 或 a,b,c" />
          </Form.Item>
          <Space style={{ width: "100%" }} size={16}>
            <Form.Item
              name="on_update"
              label="ON UPDATE"
              style={{ flex: 1 }}
              rules={[{ required: true }]}
            >
              <Select
                options={actionOptions.map((v) => ({ value: v, label: v }))}
              />
            </Form.Item>
            <Form.Item
              name="on_delete"
              label="ON DELETE"
              style={{ flex: 1 }}
              rules={[{ required: true }]}
            >
              <Select
                options={actionOptions.map((v) => ({ value: v, label: v }))}
              />
            </Form.Item>
          </Space>
        </Form>
        <Collapse
          size="small"
          items={[
            {
              key: "hint",
              label: "为何需要二次确认？",
              children: (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  外键 ALTER 可能影响线上写入；向导在执行前展示完整
                  DDL，避免误点。
                </Text>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  );
}
