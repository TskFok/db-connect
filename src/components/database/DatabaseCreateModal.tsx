import { useEffect, useState, useMemo } from "react";
import { Modal, Form, Select, Button, Space, message } from "antd";
import { SafeInput } from "../common/SafeInput";
import { useDatabaseStore } from "../../stores/databaseStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { getDatabaseCapabilities } from "../../utils/databaseCapabilities";

/** 常用 MySQL 字符集及其对应排序规则 */
const CHARSET_COLLATIONS: Record<string, string[]> = {
  utf8mb4: [
    "utf8mb4_general_ci",
    "utf8mb4_unicode_ci",
    "utf8mb4_bin",
    "utf8mb4_0900_ai_ci",
    "utf8mb4_0900_as_cs",
    "utf8mb4_unicode_520_ci",
  ],
  utf8: [
    "utf8_general_ci",
    "utf8_unicode_ci",
    "utf8_bin",
  ],
  latin1: [
    "latin1_swedish_ci",
    "latin1_general_ci",
    "latin1_bin",
  ],
  gbk: [
    "gbk_chinese_ci",
    "gbk_bin",
  ],
  gb2312: [
    "gb2312_chinese_ci",
    "gb2312_bin",
  ],
  ascii: [
    "ascii_general_ci",
    "ascii_bin",
  ],
  binary: [
    "binary",
  ],
};

const CHARSET_OPTIONS = Object.keys(CHARSET_COLLATIONS).map((cs) => ({
  label: cs,
  value: cs,
}));

interface DatabaseCreateModalProps {
  open: boolean;
  connId: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function DatabaseCreateModal({
  open,
  connId,
  onClose,
  onSuccess,
}: DatabaseCreateModalProps) {
  const { createDatabase } = useDatabaseStore();
  const activeConnection = useConnectionStore((s) => s.activeConnection);
  const capabilities = useMemo(
    () => getDatabaseCapabilities(activeConnection?.config.database_type),
    [activeConnection?.config.database_type]
  );
  const noun = capabilities.databaseObjectNoun;
  const showCharset = capabilities.charsetAndCollation;
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [selectedCharset, setSelectedCharset] = useState<string>("utf8mb4");

  useEffect(() => {
    if (open) {
      const defaultCharset = "utf8mb4";
      const collations = CHARSET_COLLATIONS[defaultCharset] ?? [];
      form.setFieldsValue({
        name: "",
        character_set: defaultCharset,
        collation: collations[0] ?? "",
      });
      setSelectedCharset(defaultCharset);
    }
  }, [open, form]);

  const collationOptions = useMemo(() => {
    if (!selectedCharset) return [];
    const collations = CHARSET_COLLATIONS[selectedCharset] ?? [];
    return collations.map((c) => ({ label: c, value: c }));
  }, [selectedCharset]);

  const handleCharsetChange = (value: string) => {
    setSelectedCharset(value);
    const collations = CHARSET_COLLATIONS[value];
    if (collations && collations.length > 0) {
      form.setFieldsValue({ collation: collations[0] });
    } else {
      form.setFieldsValue({ collation: undefined });
    }
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      const name = (values.name as string).trim();
      // PostgreSQL 下后端忽略 charset/collation；保留传参以保持单一后端签名
      const charset = showCharset ? (values.character_set as string) : "";
      const collation = showCharset ? (values.collation as string) : "";

      setSubmitting(true);
      await createDatabase(connId, name, charset, collation);
      message.success(`${noun} "${name}" 创建成功`);
      onSuccess();
    } catch (e) {
      if (e instanceof Error) {
        message.error(e.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    form.resetFields();
    onClose();
  };

  return (
    <Modal
      title={`新建${noun}`}
      open={open}
      onCancel={handleCancel}
      footer={null}
      destroyOnHidden
      width={480}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={handleSubmit}
        initialValues={{
          name: "",
          character_set: "utf8mb4",
          collation: CHARSET_COLLATIONS["utf8mb4"]?.[0] ?? "",
        }}
      >
        <Form.Item
          name="name"
          label={`${noun}名称`}
          rules={[
            { required: true, message: `请输入${noun}名称` },
            {
              pattern: /^[a-zA-Z_][a-zA-Z0-9_]*$/,
              message: `${noun}名称只能包含字母、数字和下划线，且不能以数字开头`,
            },
          ]}
        >
          <SafeInput placeholder={showCharset ? "例如: myapp" : "例如: app"} />
        </Form.Item>

        {showCharset && (
          <>
            <Form.Item
              name="character_set"
              label="字符集"
              rules={[{ required: true, message: "请选择字符集" }]}
            >
              <Select
                options={CHARSET_OPTIONS}
                placeholder="请选择字符集"
                onChange={handleCharsetChange}
                showSearch
              />
            </Form.Item>

            <Form.Item
              name="collation"
              label="排序规则"
              rules={[{ required: true, message: "请选择排序规则" }]}
            >
              <Select
                options={collationOptions}
                placeholder="请先选择字符集"
                disabled={!selectedCharset}
                showSearch
              />
            </Form.Item>
          </>
        )}

        <Form.Item style={{ marginBottom: 0, textAlign: "right" }}>
          <Space>
            <Button onClick={handleCancel}>取消</Button>
            <Button type="primary" htmlType="submit" loading={submitting}>
              创建
            </Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  );
}

