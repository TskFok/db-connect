import { useState, useEffect } from "react";
import {
  Modal,
  Form,
  Select,
  Button,
  Space,
  Typography,
  InputNumber,
  Alert,
} from "antd";
import { SafeInput, SafeTextArea } from "../common/SafeInput";
import { PlusOutlined, MinusCircleOutlined } from "@ant-design/icons";
import type { ColumnInfo, CreateIndexRequest, IndexInfo } from "../../types";
import * as api from "../../services/tauriCommands";
import {
  getIndexKind,
  getIndexMethod,
  indexColumnsToFormValues,
} from "../../utils/indexUtils";
import { useConnectionStore } from "../../stores/connectionStore";
import { normalizeDatabaseType } from "../../utils/connectionConfig";

const { Text } = Typography;

interface IndexEditorProps {
  open: boolean;
  onCancel: () => void;
  onSuccess: () => void;
  connId: string;
  database: string;
  table: string;
  tableColumns: ColumnInfo[];
  /** 编辑模式时传入已有索引信息, null 为新建模式 */
  editingIndex?: IndexInfo | null;
}

export function IndexEditor({
  open,
  onCancel,
  onSuccess,
  connId,
  database,
  table,
  tableColumns,
  editingIndex = null,
}: IndexEditorProps) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dbType = useConnectionStore((s) => s.activeConnection?.config.database_type);
  const isPostgres = normalizeDatabaseType(dbType) === "postgres";

  const indexTypeOptions = isPostgres
    ? [
        { label: "普通索引 (INDEX)", value: "INDEX" },
        { label: "唯一索引 (UNIQUE)", value: "UNIQUE" },
      ]
    : [
        { label: "普通索引 (INDEX)", value: "INDEX" },
        { label: "唯一索引 (UNIQUE)", value: "UNIQUE" },
        { label: "全文索引 (FULLTEXT)", value: "FULLTEXT" },
        { label: "空间索引 (SPATIAL)", value: "SPATIAL" },
      ];

  const indexMethodOptions = isPostgres
    ? [
        { label: "BTREE", value: "btree" },
        { label: "HASH", value: "hash" },
        { label: "GIN", value: "gin" },
        { label: "GIST", value: "gist" },
        { label: "SPGIST", value: "spgist" },
        { label: "BRIN", value: "brin" },
      ]
    : [
        { label: "BTREE", value: "BTREE" },
        { label: "HASH", value: "HASH" },
      ];

  const isEdit = !!editingIndex;

  // 编辑模式时预填充表单
  useEffect(() => {
    if (open && editingIndex) {
      form.setFieldsValue({
        index_name: editingIndex.name,
        index_type: getIndexKind(editingIndex),
        index_method: getIndexMethod(editingIndex),
        columns: indexColumnsToFormValues(editingIndex),
        comment: editingIndex.comment || "",
      });
    } else if (open && !editingIndex) {
      form.resetFields();
    }
  }, [open, editingIndex, form]);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      setError(null);

      const request: CreateIndexRequest = {
        index_name: values.index_name,
        index_type: values.index_type,
        index_method: values.index_method || undefined,
        columns: values.columns.map(
          (col: { column_name: string; length?: number; order?: string }) => ({
            column_name: col.column_name,
            length: col.length || undefined,
            order: col.order || undefined,
          })
        ),
        comment: values.comment || undefined,
      };

      // 编辑模式: 先删除旧索引再创建新索引
      if (isEdit && editingIndex) {
        await api.deleteIndex(connId, database, table, editingIndex.name);
      }

      await api.createIndex(connId, database, table, request);
      form.resetFields();
      onSuccess();
    } catch (e) {
      if (typeof e === "string") {
        setError(e);
      } else if (e instanceof Error) {
        setError(e.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    form.resetFields();
    setError(null);
    onCancel();
  };

  // 可选列名
  const columnOptions = tableColumns.map((col) => ({
    label: (
      <Space size={4}>
        <span>{col.name}</span>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {col.column_type}
        </Text>
      </Space>
    ),
    value: col.name,
  }));

  return (
    <Modal
      title={isEdit ? `编辑索引 "${editingIndex?.name}"` : "新建索引"}
      open={open}
      onCancel={handleCancel}
      width={640}
      destroyOnHidden
      footer={[
        <Button key="cancel" onClick={handleCancel}>
          取消
        </Button>,
        <Button
          key="submit"
          type="primary"
          loading={submitting}
          onClick={handleSubmit}
        >
          {isEdit ? "保存" : "创建"}
        </Button>,
      ]}
    >
      {error && (
        <Alert
          type="error"
          message={isEdit ? "保存失败" : "创建失败"}
          description={error}
          showIcon
          closable
          onClose={() => setError(null)}
          style={{ marginBottom: 16 }}
        />
      )}

      <Form
        form={form}
        layout="vertical"
        size="small"
        initialValues={{
          index_type: "INDEX",
          columns: [{ column_name: undefined, length: undefined, order: undefined }],
        }}
      >
        {/* 索引名称 */}
        <Form.Item
          name="index_name"
          label="索引名称"
          rules={[
            { required: true, message: "请输入索引名称" },
            {
              pattern: /^[a-zA-Z_][a-zA-Z0-9_]*$/,
              message: "索引名称只能包含字母、数字和下划线",
            },
          ]}
        >
          <SafeInput placeholder="例如: idx_user_email" />
        </Form.Item>

        <Space size={16} style={{ width: "100%" }}>
          {/* 索引类型 */}
          <Form.Item
            name="index_type"
            label="索引类型"
            rules={[{ required: true }]}
            style={{ width: 200 }}
          >
            <Select options={indexTypeOptions} />
          </Form.Item>

          {/* 索引方法 */}
          <Form.Item
            name="index_method"
            label="索引方法"
            style={{ width: 160 }}
          >
            <Select allowClear placeholder="默认" options={indexMethodOptions} />
          </Form.Item>
        </Space>

        {/* 索引列 */}
        <Form.Item label="索引列" required>
          <Form.List
            name="columns"
            rules={[
              {
                validator: async (_, columns) => {
                  if (!columns || columns.length === 0) {
                    return Promise.reject(new Error("至少需要选择一列"));
                  }
                },
              },
            ]}
          >
            {(fields, { add, remove }, { errors }) => (
              <>
                {fields.map(({ key, name, ...restField }) => (
                  <Space
                    key={key}
                    style={{
                      display: "flex",
                      marginBottom: 8,
                      alignItems: "flex-start",
                    }}
                  >
                    {/* 列名 */}
                    <Form.Item
                      {...restField}
                      name={[name, "column_name"]}
                      rules={[{ required: true, message: "请选择列" }]}
                      style={{ marginBottom: 0, width: 200 }}
                    >
                      <Select
                        placeholder="选择列"
                        options={columnOptions}
                        showSearch
                        filterOption={(input, option) =>
                          (option?.value as string)
                            ?.toLowerCase()
                            .includes(input.toLowerCase()) ?? false
                        }
                      />
                    </Form.Item>

                    {/* 前缀长度 */}
                    <Form.Item
                      {...restField}
                      name={[name, "length"]}
                      style={{ marginBottom: 0, width: 120 }}
                    >
                      <InputNumber
                        placeholder="前缀长度"
                        min={1}
                        style={{ width: "100%" }}
                      />
                    </Form.Item>

                    {/* 排序 */}
                    <Form.Item
                      {...restField}
                      name={[name, "order"]}
                      style={{ marginBottom: 0, width: 100 }}
                    >
                      <Select
                        allowClear
                        placeholder="排序"
                        options={[
                          { label: "ASC", value: "ASC" },
                          { label: "DESC", value: "DESC" },
                        ]}
                      />
                    </Form.Item>

                    {/* 删除按钮 */}
                    {fields.length > 1 && (
                      <MinusCircleOutlined
                        style={{
                          color: "#ff4d4f",
                          fontSize: 16,
                          cursor: "pointer",
                          marginTop: 8,
                        }}
                        onClick={() => remove(name)}
                      />
                    )}
                  </Space>
                ))}

                <Button
                  type="dashed"
                  onClick={() =>
                    add({ column_name: undefined, length: undefined, order: undefined })
                  }
                  icon={<PlusOutlined />}
                  style={{ width: "100%" }}
                >
                  添加列
                </Button>
                <Form.ErrorList errors={errors} />
              </>
            )}
          </Form.List>
        </Form.Item>

        {/* 注释 */}
        <Form.Item name="comment" label="注释">
          <SafeTextArea
            placeholder="索引注释 (可选)"
            autoSize={{ minRows: 1, maxRows: 3 }}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
