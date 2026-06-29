import { useMemo, useState } from "react";
import {
  Modal,
  Form,
  Select,
  Switch,
  Button,
  Space,
  Typography,
  Alert,
  Checkbox,
} from "antd";
import { SafeInput } from "../common/SafeInput";
import { PlusOutlined, MinusCircleOutlined } from "@ant-design/icons";
import type { CreateTableRequest, CreateTableColumnDef } from "../../types";
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
} from "../../utils/columnTypeUtils";
import { formColumnToDef } from "../../utils/createTableFormUtils";
import { useConnectionStore } from "../../stores/connectionStore";
import { getDatabaseCapabilities } from "../../utils/databaseCapabilities";
import { normalizeDatabaseType } from "../../utils/connectionConfig";

const { Text } = Typography;

/** 常用 MySQL 引擎列表 */
const ENGINE_OPTIONS = ["InnoDB", "MyISAM", "MEMORY", "CSV", "ARCHIVE"];

/** 常用额外属性列表（MySQL） */
const MYSQL_EXTRA_OPTIONS = [
  { label: "(无)", value: "" },
  { label: "auto_increment", value: "auto_increment" },
];

/** PostgreSQL 不通过 extra 字段维护自增；通过 `serial`/`bigserial` 类型实现，故仅保留"(无)"。 */
const POSTGRES_EXTRA_OPTIONS = [{ label: "(无)", value: "" }];

interface CreateTableModalProps {
  open: boolean;
  onCancel: () => void;
  onSuccess: () => void;
  connId: string;
  database: string;
  onCreateTable: (
    connId: string,
    database: string,
    request: CreateTableRequest
  ) => Promise<void>;
}

export function CreateTableModal({
  open,
  onCancel,
  onSuccess,
  connId,
  database,
  onCreateTable,
}: CreateTableModalProps) {
  const activeConnection = useConnectionStore((s) => s.activeConnection);
  const capabilities = useMemo(
    () => getDatabaseCapabilities(activeConnection?.config.database_type),
    [activeConnection?.config.database_type]
  );
  const databaseType = normalizeDatabaseType(
    activeConnection?.config.database_type
  );
  const isSqlite = databaseType === "sqlite";
  const showEngine = capabilities.storageEngine;
  const dataTypeOptions = isSqlite
    ? SQLITE_DATA_TYPES
    : showEngine
      ? MYSQL_DATA_TYPES
      : POSTGRES_DATA_TYPES;
  const lengthSet = isSqlite
    ? SQLITE_LENGTH_TYPES
    : showEngine
      ? LENGTH_TYPES
      : POSTGRES_LENGTH_TYPES;
  const scaleSet = isSqlite
    ? SQLITE_SCALE_TYPES
    : showEngine
      ? SCALE_TYPES
      : POSTGRES_SCALE_TYPES;
  const unsignedSet = showEngine ? UNSIGNED_TYPES : new Set<string>();
  const extraOptions = showEngine
    ? MYSQL_EXTRA_OPTIONS
    : POSTGRES_EXTRA_OPTIONS;
  const defaultDataType = isSqlite ? "TEXT" : "varchar";
  const idDefault = showEngine
    ? {
        name: "id",
        data_type: "bigint",
        length: "",
        scale: "",
        unsigned: true,
        nullable: false,
        is_primary: true,
        default_value: "",
        extra: "auto_increment",
        comment: "",
      }
    : isSqlite
      ? {
          name: "id",
          data_type: "INTEGER",
          length: "",
          scale: "",
          unsigned: false,
          nullable: false,
          is_primary: true,
          default_value: "",
          extra: "",
          comment: "",
        }
      : {
          // PostgreSQL 默认主键使用 bigserial（隐含 NOT NULL + 自动序列）
          name: "id",
          data_type: "bigserial",
          length: "",
          scale: "",
          unsigned: false,
          nullable: false,
          is_primary: true,
          default_value: "",
          extra: "",
          comment: "",
        };
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      setError(null);

      const rawColumns: CreateTableColumnDef[] = (
        values.columns as Record<string, unknown>[]
      ).map(formColumnToDef);
      const columns = isSqlite
        ? rawColumns.map((col) => ({
            ...col,
            extra: "",
            comment: "",
          }))
        : rawColumns;

      const primaryKeys: string[] = (values.columns || [])
        .map((col: Record<string, unknown>) => ({
          name: ((col.name as string) || "").trim(),
          isPrimary: col.is_primary === true,
        }))
        .filter(
          (col: { name: string; isPrimary: boolean }) =>
            col.isPrimary && col.name.length > 0
        )
        .map((col: { name: string; isPrimary: boolean }) => col.name);

      const request: CreateTableRequest = {
        table_name: values.table_name.trim(),
        columns,
        primary_keys: primaryKeys,
        // PostgreSQL 不需要 engine，后端读取此字段在 PG 路径下被忽略
        engine: showEngine ? values.engine || "InnoDB" : "",
        comment: isSqlite ? "" : (values.comment || "").trim(),
      };

      await onCreateTable(connId, database, request);
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

  return (
    <Modal
      title={`新建表 — ${database}`}
      open={open}
      onCancel={handleCancel}
      width={1120}
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
          创建
        </Button>,
      ]}
    >
      {error && (
        <Alert
          type="error"
          message="创建失败"
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
          engine: "InnoDB",
          columns: [idDefault],
        }}
      >
        {/* 基本信息 */}
        <Space
          size={16}
          align="start"
          style={{ width: "100%", marginBottom: 8 }}
        >
          <Form.Item
            name="table_name"
            label="表名"
            rules={[
              { required: true, message: "请输入表名" },
              {
                pattern: /^[a-zA-Z_][a-zA-Z0-9_]*$/,
                message: "表名只能包含字母、数字和下划线",
              },
            ]}
            style={{ width: 240 }}
          >
            <SafeInput placeholder="例如: users" />
          </Form.Item>

          {showEngine && (
            <Form.Item name="engine" label="存储引擎" style={{ width: 160 }}>
              <Select
                options={ENGINE_OPTIONS.map((e) => ({ label: e, value: e }))}
                showSearch
              />
            </Form.Item>
          )}

          {!isSqlite && (
            <Form.Item name="comment" label="表注释" style={{ width: 300 }}>
              <SafeInput placeholder="可选" />
            </Form.Item>
          )}
        </Space>

        {/* 列定义 */}
        <Form.Item
          label={
            <Text strong style={{ fontSize: 13 }}>
              列定义
            </Text>
          }
          required
        >
          <Form.List
            name="columns"
            rules={[
              {
                validator: async (_, cols) => {
                  if (!cols || cols.length === 0) {
                    return Promise.reject(new Error("至少需要定义一个列"));
                  }
                },
              },
            ]}
          >
            {(fields, { add, remove }, { errors }) => (
              <>
                {/* 表头 */}
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    marginBottom: 4,
                    paddingLeft: 2,
                    fontSize: 11,
                    color: "var(--text-secondary)",
                  }}
                >
                  <span style={{ width: 130 }}>列名 *</span>
                  <span style={{ width: 130 }}>类型 *</span>
                  <span style={{ width: 70 }}>长度</span>
                  <span style={{ width: 70 }}>小数位</span>
                  {!isSqlite && <span style={{ width: 50 }}>UNSIGNED</span>}
                  <span style={{ width: 50 }}>可空</span>
                  <span style={{ width: 50 }}>主键</span>
                  <span style={{ width: 100 }}>默认值</span>
                  {!isSqlite && <span style={{ width: 110 }}>额外</span>}
                  {!isSqlite && <span style={{ width: 260 }}>注释</span>}
                </div>

                <div style={{ maxHeight: 320, overflow: "auto" }}>
                  {fields.map(({ key, name, ...restField }) => {
                    const currentDataType = form.getFieldValue([
                      "columns",
                      name,
                      "data_type",
                    ]) as string;
                    const showLength = lengthSet.has(currentDataType);
                    const showScale = scaleSet.has(currentDataType);
                    const showUnsigned = unsignedSet.has(currentDataType);

                    return (
                      <div
                        key={key}
                        style={{
                          display: "flex",
                          gap: 6,
                          marginBottom: 6,
                          alignItems: "flex-start",
                        }}
                      >
                        {/* 列名 */}
                        <Form.Item
                          {...restField}
                          name={[name, "name"]}
                          rules={[{ required: true, message: "必填" }]}
                          style={{ marginBottom: 0, width: 130 }}
                        >
                          <SafeInput placeholder="列名" />
                        </Form.Item>

                        {/* 数据类型 */}
                        <Form.Item
                          {...restField}
                          name={[name, "data_type"]}
                          rules={[{ required: true, message: "必选" }]}
                          style={{ marginBottom: 0, width: 130 }}
                        >
                          <Select
                            placeholder="类型"
                            options={dataTypeOptions}
                            showSearch
                            filterOption={(input, option) => {
                              const opt = option as {
                                value?: string;
                                options?: { value: string; label: string }[];
                              };
                              if (opt.value) {
                                return opt.value
                                  .toLowerCase()
                                  .includes(input.toLowerCase());
                              }
                              if (opt.options) {
                                return opt.options.some(
                                  (o) =>
                                    o.value
                                      .toLowerCase()
                                      .includes(input.toLowerCase()) ||
                                    o.label
                                      .toLowerCase()
                                      .includes(input.toLowerCase())
                                );
                              }
                              return false;
                            }}
                            onChange={() => {
                              const dt = form.getFieldValue([
                                "columns",
                                name,
                                "data_type",
                              ]) as string;
                              if (!unsignedSet.has(dt)) {
                                form.setFieldValue(
                                  ["columns", name, "unsigned"],
                                  false
                                );
                              }
                            }}
                          />
                        </Form.Item>

                        {/* 长度 */}
                        <Form.Item
                          {...restField}
                          name={[name, "length"]}
                          style={{ marginBottom: 0, width: 70 }}
                        >
                          <SafeInput
                            placeholder={showLength ? "长度" : "-"}
                            disabled={!showLength}
                          />
                        </Form.Item>

                        {/* 小数位 */}
                        <Form.Item
                          {...restField}
                          name={[name, "scale"]}
                          style={{ marginBottom: 0, width: 70 }}
                        >
                          <SafeInput
                            placeholder={showScale ? "精度" : "-"}
                            disabled={!showScale}
                          />
                        </Form.Item>

                        {/* UNSIGNED */}
                        {!isSqlite && (
                          <Form.Item
                            {...restField}
                            name={[name, "unsigned"]}
                            valuePropName="checked"
                            style={{
                              marginBottom: 0,
                              width: 50,
                              textAlign: "center",
                            }}
                          >
                            <Checkbox disabled={!showUnsigned} />
                          </Form.Item>
                        )}

                        {/* 可空 */}
                        <Form.Item
                          {...restField}
                          name={[name, "nullable"]}
                          valuePropName="checked"
                          style={{
                            marginBottom: 0,
                            width: 50,
                            textAlign: "center",
                          }}
                        >
                          <Switch size="small" />
                        </Form.Item>

                        {/* 主键 */}
                        <Form.Item
                          {...restField}
                          name={[name, "is_primary"]}
                          valuePropName="checked"
                          style={{
                            marginBottom: 0,
                            width: 50,
                            textAlign: "center",
                          }}
                        >
                          <Switch size="small" />
                        </Form.Item>

                        {/* 默认值 */}
                        <Form.Item
                          {...restField}
                          name={[name, "default_value"]}
                          style={{ marginBottom: 0, width: 100 }}
                        >
                          <SafeInput placeholder="默认值" />
                        </Form.Item>

                        {/* 额外属性 */}
                        {!isSqlite && (
                          <Form.Item
                            {...restField}
                            name={[name, "extra"]}
                            style={{ marginBottom: 0, width: 110 }}
                          >
                            <Select
                              placeholder="额外"
                              options={extraOptions}
                              allowClear
                            />
                          </Form.Item>
                        )}

                        {/* 注释 */}
                        {!isSqlite && (
                          <Form.Item
                            {...restField}
                            name={[name, "comment"]}
                            style={{ marginBottom: 0, width: 260 }}
                          >
                            <SafeInput placeholder="注释" />
                          </Form.Item>
                        )}

                        {/* 删除行 */}
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
                      </div>
                    );
                  })}
                </div>

                <Button
                  type="dashed"
                  onClick={() =>
                    add({
                      name: "",
                      data_type: defaultDataType,
                      length: isSqlite ? "" : "255",
                      scale: "",
                      unsigned: false,
                      nullable: true,
                      is_primary: false,
                      default_value: "",
                      extra: "",
                      comment: "",
                    })
                  }
                  icon={<PlusOutlined />}
                  style={{ width: "100%", marginTop: 4 }}
                >
                  添加列
                </Button>
                <Form.ErrorList errors={errors} />
              </>
            )}
          </Form.List>
        </Form.Item>
      </Form>
    </Modal>
  );
}
