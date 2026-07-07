import { useMemo, useState } from "react";
import {
  Modal,
  Form,
  Select,
  AutoComplete,
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
  SQLSERVER_DATA_TYPES,
  SQLSERVER_LENGTH_TYPES,
  SQLSERVER_SCALE_TYPES,
  SQLSERVER_UNSIGNED_TYPES,
  CLICKHOUSE_DATA_TYPES,
  CLICKHOUSE_LENGTH_TYPES,
  CLICKHOUSE_SCALE_TYPES,
  CLICKHOUSE_UNSIGNED_TYPES,
} from "../../utils/columnTypeUtils";
import { formColumnToDef } from "../../utils/createTableFormUtils";
import { useConnectionStore } from "../../stores/connectionStore";
import { getDatabaseCapabilities } from "../../utils/databaseCapabilities";
import { normalizeDatabaseType } from "../../utils/connectionConfig";

const { Text } = Typography;

/** 常用 MySQL 引擎列表 */
const ENGINE_OPTIONS = ["InnoDB", "MyISAM", "MEMORY", "CSV", "ARCHIVE"];
const CLICKHOUSE_ENGINE_OPTIONS = [
  "MergeTree",
  "ReplacingMergeTree",
  "SummingMergeTree",
  "AggregatingMergeTree",
  "CollapsingMergeTree",
];

/** 常用额外属性列表（MySQL） */
const MYSQL_EXTRA_OPTIONS = [
  { label: "(无)", value: "" },
  { label: "auto_increment", value: "auto_increment" },
];

/** PostgreSQL 不通过 extra 字段维护自增；通过 `serial`/`bigserial` 类型实现，故仅保留"(无)"。 */
const POSTGRES_EXTRA_OPTIONS = [{ label: "(无)", value: "" }];

const SQLSERVER_EXTRA_OPTIONS = [
  { label: "(无)", value: "" },
  { label: "identity", value: "identity" },
];

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
  const isSqlServer = databaseType === "sqlserver";
  const isClickHouse = databaseType === "clickhouse";
  const showEngine = capabilities.storageEngine || isClickHouse;
  const showMysqlEngine = capabilities.storageEngine && !isClickHouse;
  const dataTypeOptions = isSqlite
    ? SQLITE_DATA_TYPES
    : isClickHouse
      ? CLICKHOUSE_DATA_TYPES
      : isSqlServer
        ? SQLSERVER_DATA_TYPES
        : showMysqlEngine
          ? MYSQL_DATA_TYPES
          : POSTGRES_DATA_TYPES;
  const lengthSet = isSqlite
    ? SQLITE_LENGTH_TYPES
    : isClickHouse
      ? CLICKHOUSE_LENGTH_TYPES
      : isSqlServer
        ? SQLSERVER_LENGTH_TYPES
        : showMysqlEngine
          ? LENGTH_TYPES
          : POSTGRES_LENGTH_TYPES;
  const scaleSet = isSqlite
    ? SQLITE_SCALE_TYPES
    : isClickHouse
      ? CLICKHOUSE_SCALE_TYPES
      : isSqlServer
        ? SQLSERVER_SCALE_TYPES
        : showMysqlEngine
          ? SCALE_TYPES
          : POSTGRES_SCALE_TYPES;
  const unsignedSet = isSqlServer
    ? SQLSERVER_UNSIGNED_TYPES
    : isClickHouse
      ? CLICKHOUSE_UNSIGNED_TYPES
      : showMysqlEngine
      ? UNSIGNED_TYPES
      : new Set<string>();
  const extraOptions = showMysqlEngine
    ? MYSQL_EXTRA_OPTIONS
    : isSqlServer
      ? SQLSERVER_EXTRA_OPTIONS
      : POSTGRES_EXTRA_OPTIONS;
  const defaultDataType = isSqlite
    ? "TEXT"
    : isClickHouse
      ? "String"
    : isSqlServer
      ? "nvarchar"
      : "varchar";
  const idDefault = showMysqlEngine
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
    : isClickHouse
      ? {
          name: "id",
          data_type: "UInt64",
          length: "",
          scale: "",
          unsigned: false,
          nullable: false,
          is_primary: false,
          default_value: "",
          extra: "",
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
      : isSqlServer
        ? {
            name: "id",
            data_type: "bigint",
            length: "",
            scale: "",
            unsigned: false,
            nullable: false,
            is_primary: true,
            default_value: "",
            extra: "identity",
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
  const watchedColumns = Form.useWatch("columns", form) as
    | Record<string, unknown>[]
    | undefined;
  const orderByOptions = useMemo(
    () =>
      (watchedColumns ?? [])
        .map((col) => ((col?.name as string) || "").trim())
        .filter((name) => name.length > 0)
        .map((name) => ({ label: name, value: name })),
    [watchedColumns]
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      setError(null);

      const typeConfig = {
        scaleTypes: scaleSet,
        unsignedTypes: unsignedSet,
      };
      const rawColumns: CreateTableColumnDef[] = (
        values.columns as Record<string, unknown>[]
      ).map((col) => formColumnToDef(col, typeConfig));
      const columns = isSqlite
        ? rawColumns.map((col) => ({
            ...col,
            extra: "",
            comment: "",
          }))
        : isClickHouse
          ? rawColumns.map((col) => ({
              ...col,
              extra: "",
              comment: "",
            }))
        : rawColumns;

      const primaryKeys: string[] = isClickHouse
        ? []
        : (values.columns || [])
            .map((col: Record<string, unknown>) => ({
              name: ((col.name as string) || "").trim(),
              isPrimary: col.is_primary === true,
            }))
            .filter(
              (col: { name: string; isPrimary: boolean }) =>
                col.isPrimary && col.name.length > 0
            )
            .map((col: { name: string; isPrimary: boolean }) => col.name);
      const orderBy = ((values.order_by as string[] | undefined) ?? [])
        .map((name) => name.trim())
        .filter((name) => name.length > 0);

      const request: CreateTableRequest = {
        table_name: values.table_name.trim(),
        columns,
        primary_keys: primaryKeys,
        // PostgreSQL/SQLite 不需要 engine，后端读取此字段在对应路径下被忽略
        engine: isClickHouse
          ? values.engine || "MergeTree"
          : showMysqlEngine
            ? values.engine || "InnoDB"
            : "",
        order_by: isClickHouse ? orderBy : undefined,
        comment: isSqlite || isClickHouse ? "" : (values.comment || "").trim(),
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
          engine: isClickHouse ? "MergeTree" : "InnoDB",
          order_by: [],
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
            <Form.Item
              name="engine"
              label={isClickHouse ? "ClickHouse 引擎" : "存储引擎"}
              style={{ width: isClickHouse ? 220 : 160 }}
            >
              {isClickHouse ? (
                <AutoComplete
                  options={CLICKHOUSE_ENGINE_OPTIONS.map((e) => ({
                    label: e,
                    value: e,
                  }))}
                  filterOption={(input, option) =>
                    String(option?.value ?? "")
                      .toLowerCase()
                      .includes(input.toLowerCase())
                  }
                />
              ) : (
                <Select
                  options={ENGINE_OPTIONS.map((e) => ({ label: e, value: e }))}
                  showSearch
                />
              )}
            </Form.Item>
          )}

          {isClickHouse && (
            <Form.Item name="order_by" label="ORDER BY" style={{ width: 260 }}>
              <Select
                mode="tags"
                options={orderByOptions}
                tokenSeparators={[","]}
                placeholder="默认 tuple()"
              />
            </Form.Item>
          )}

          {!isSqlite && !isClickHouse && (
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
                  {!isSqlite && !isClickHouse && (
                    <span style={{ width: 50 }}>UNSIGNED</span>
                  )}
                  <span style={{ width: 50 }}>可空</span>
                  {!isClickHouse && <span style={{ width: 50 }}>主键</span>}
                  <span style={{ width: 100 }}>默认值</span>
                  {!isSqlite && !isClickHouse && (
                    <span style={{ width: 110 }}>额外</span>
                  )}
                  {!isSqlite && !isClickHouse && (
                    <span style={{ width: 260 }}>注释</span>
                  )}
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
                        {!isSqlite && !isClickHouse && (
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
                        {!isClickHouse && (
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
                        )}

                        {/* 默认值 */}
                        <Form.Item
                          {...restField}
                          name={[name, "default_value"]}
                          style={{ marginBottom: 0, width: 100 }}
                        >
                          <SafeInput placeholder="默认值" />
                        </Form.Item>

                        {/* 额外属性 */}
                        {!isSqlite && !isClickHouse && (
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
                        {!isSqlite && !isClickHouse && (
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
                      length: isSqlite || isClickHouse ? "" : "255",
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
