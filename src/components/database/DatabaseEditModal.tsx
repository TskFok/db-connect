import { useEffect, useState, useMemo } from "react";
import { Modal, Form, Select, Button, Space, Spin, message, Alert } from "antd";
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

interface DatabaseEditModalProps {
  open: boolean;
  database: string;
  connId: string;
  onClose: () => void;
  onSuccess: () => void;
}

export function DatabaseEditModal({
  open,
  database,
  connId,
  onClose,
  onSuccess,
}: DatabaseEditModalProps) {
  const { databaseInfo, databaseInfoLoading, loadDatabaseInfo, editDatabase, renameDatabase } =
    useDatabaseStore();
  const activeConnection = useConnectionStore((s) => s.activeConnection);
  const capabilities = useMemo(
    () => getDatabaseCapabilities(activeConnection?.config.database_type),
    [activeConnection?.config.database_type]
  );
  const noun = capabilities.databaseObjectNoun;
  const showCharset = capabilities.charsetAndCollation;
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [selectedCharset, setSelectedCharset] = useState<string>("");

  // 仅在需要字符集字段时才主动拉取数据库信息；PG 下省略一次后端请求。
  useEffect(() => {
    if (open && connId && database && showCharset) {
      loadDatabaseInfo(connId, database);
    }
  }, [open, connId, database, loadDatabaseInfo, showCharset]);

  // 数据库信息加载完成后填充表单
  useEffect(() => {
    if (!open) return;
    if (showCharset && databaseInfo) {
      form.setFieldsValue({
        name: databaseInfo.name,
        character_set: databaseInfo.character_set,
        collation: databaseInfo.collation,
      });
      setSelectedCharset(databaseInfo.character_set);
    } else if (!showCharset) {
      form.setFieldsValue({ name: database });
    }
  }, [databaseInfo, open, form, showCharset, database]);

  // 根据选中字符集过滤排序规则
  const collationOptions = useMemo(() => {
    if (!selectedCharset) return [];
    const collations = CHARSET_COLLATIONS[selectedCharset] ?? [];
    return collations.map((c) => ({ label: c, value: c }));
  }, [selectedCharset]);

  // 字符集变更时自动选择默认排序规则
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
      setSubmitting(true);

      const newName = values.name.trim();
      const charset = showCharset ? values.character_set : "";
      const collation = showCharset ? values.collation : "";
      const isRenamed = newName !== database;

      if (isRenamed) {
        // 重命名 schema/数据库；PG 下后端走 ALTER SCHEMA，忽略 charset/collation
        await renameDatabase(connId, database, newName, charset, collation);
        message.success(`${noun}已重命名为 "${newName}"`);
      } else if (showCharset) {
        await editDatabase(connId, database, charset, collation);
        message.success(`${noun}字符集已更新`);
      } else {
        // PostgreSQL 下没有可改的属性，名字也未变 → 直接关闭
        onSuccess();
        return;
      }

      onSuccess();
    } catch (e) {
      if (e instanceof Error) {
        message.error(e.message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title={`编辑${noun} - ${database}`}
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden
      width={480}
    >
      <Spin spinning={databaseInfoLoading}>
        {showCharset && (
          <Alert
            message="重命名数据库会通过迁移所有表来实现，大型数据库可能需要较长时间"
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          initialValues={{
            name: database,
            character_set: "",
            collation: "",
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
            <SafeInput placeholder={`请输入${noun}名称`} />
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
              <Button onClick={onClose}>取消</Button>
              <Button type="primary" htmlType="submit" loading={submitting}>
                保存
              </Button>
            </Space>
          </Form.Item>
        </Form>
      </Spin>
    </Modal>
  );
}
