import { useState, useEffect } from "react";
import { Modal, Form, Select, Button, Space, Typography, Alert } from "antd";
import { SafeInput } from "../common/SafeInput";
import Editor from "@monaco-editor/react";
import type { CreateTriggerRequest, TriggerInfo } from "../../types";
import * as api from "../../services/tauriCommands";
import { useThemeStore } from "../../stores/themeStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { normalizeDatabaseType } from "../../utils/connectionConfig";
import { setupMonacoEditor } from "../../utils/monacoSetup";

setupMonacoEditor();

const { Text } = Typography;

interface TriggerEditorProps {
  open: boolean;
  onCancel: () => void;
  onSuccess: () => void;
  connId: string;
  database: string;
  table: string;
  /** 编辑模式时传入已有触发器信息, null 为新建模式 */
  editingTrigger?: TriggerInfo | null;
}

/** 默认触发器语句体模板（MySQL） */
const DEFAULT_TRIGGER_BODY = `BEGIN
  -- 在此编写触发器逻辑
  -- 可以使用 NEW.column_name 引用新行的值 (INSERT/UPDATE)
  -- 可以使用 OLD.column_name 引用旧行的值 (UPDATE/DELETE)
  
END`;

/** 默认触发器语句体模板（PostgreSQL：必须调用已存在的触发器函数） */
const DEFAULT_PG_TRIGGER_BODY = "EXECUTE FUNCTION function_name()";

/** 默认触发器语句体模板（SQLite） */
const DEFAULT_SQLITE_TRIGGER_BODY = `BEGIN
  SELECT RAISE(IGNORE);
END`;

export function TriggerEditor({
  open,
  onCancel,
  onSuccess,
  connId,
  database,
  table,
  editingTrigger = null,
}: TriggerEditorProps) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const themeMode = useThemeStore((s) => s.mode);
  const dbType = useConnectionStore(
    (s) => s.activeConnection?.config.database_type
  );
  const normalizedDbType = normalizeDatabaseType(dbType);
  const isPostgres = normalizedDbType === "postgres";
  const isSqlite = normalizedDbType === "sqlite";
  const defaultBody = isPostgres
    ? DEFAULT_PG_TRIGGER_BODY
    : isSqlite
      ? DEFAULT_SQLITE_TRIGGER_BODY
      : DEFAULT_TRIGGER_BODY;
  const [triggerBody, setTriggerBody] = useState(defaultBody);

  const isEdit = !!editingTrigger;

  // 编辑模式时预填充表单
  useEffect(() => {
    if (open && editingTrigger) {
      form.setFieldsValue({
        name: editingTrigger.name,
        timing: editingTrigger.timing,
        event: editingTrigger.event,
      });
      setTriggerBody(editingTrigger.statement || defaultBody);
    } else if (open && !editingTrigger) {
      form.resetFields();
      setTriggerBody(defaultBody);
    }
  }, [open, editingTrigger, form, defaultBody]);

  // 构建预览 SQL（按方言切换标识符引用与语法）
  const buildPreviewSql = (): string => {
    const timing = form.getFieldValue("timing") || "BEFORE";
    const event = form.getFieldValue("event") || "INSERT";
    const name = form.getFieldValue("name") || "<trigger_name>";
    if (isPostgres) {
      return `CREATE TRIGGER "${name}" ${timing} ${event} ON "${database}"."${table}"\nFOR EACH ROW\n${triggerBody}`;
    }
    if (isSqlite) {
      return `CREATE TRIGGER "${name}"\n${timing} ${event} ON "${database}"."${table}"\n${triggerBody}`;
    }
    return `CREATE TRIGGER \`${database}\`.\`${name}\`\n${timing} ${event} ON \`${database}\`.\`${table}\`\nFOR EACH ROW\n${triggerBody}`;
  };

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      setError(null);

      const request: CreateTriggerRequest = {
        name: values.name,
        timing: values.timing,
        event: values.event,
        body: triggerBody,
      };

      if (!triggerBody.trim()) {
        setError(
          isPostgres
            ? "触发器执行动作不能为空（PostgreSQL 需指定 EXECUTE FUNCTION ...）"
            : "触发器语句体不能为空"
        );
        setSubmitting(false);
        return;
      }

      // 编辑模式: 先删除旧触发器再创建新触发器
      if (isEdit && editingTrigger) {
        await api.dropTrigger(connId, database, editingTrigger.name, table);
      }

      await api.createTrigger(connId, database, table, request);
      form.resetFields();
      setTriggerBody(defaultBody);
      setError(null);
      onSuccess();
    } catch (e) {
      if (typeof e === "string") {
        setError(e);
      } else if (e instanceof Error) {
        setError(e.message);
      }
      // form validation error — 不设置 error
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    form.resetFields();
    setTriggerBody(defaultBody);
    setError(null);
    onCancel();
  };

  return (
    <Modal
      title={isEdit ? `编辑触发器 "${editingTrigger?.name}"` : "新建触发器"}
      open={open}
      onCancel={handleCancel}
      width={800}
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
          timing: "BEFORE",
          event: "INSERT",
        }}
      >
        {/* 触发器名称 */}
        <Form.Item
          name="name"
          label="触发器名称"
          rules={[
            { required: true, message: "请输入触发器名称" },
            {
              pattern: /^[a-zA-Z_][a-zA-Z0-9_]*$/,
              message: "名称只能包含字母、数字和下划线，且以字母或下划线开头",
            },
          ]}
        >
          <SafeInput placeholder="例如: trg_before_insert_users" />
        </Form.Item>

        <Space size={16} style={{ width: "100%" }}>
          {/* 触发时机 */}
          <Form.Item
            name="timing"
            label="触发时机"
            rules={[{ required: true }]}
            style={{ width: 200 }}
          >
            <Select
              options={[
                { label: "BEFORE (执行前)", value: "BEFORE" },
                { label: "AFTER (执行后)", value: "AFTER" },
                ...(isPostgres
                  ? [{ label: "INSTEAD OF (视图)", value: "INSTEAD OF" }]
                  : []),
              ]}
            />
          </Form.Item>

          {/* 触发事件 */}
          <Form.Item
            name="event"
            label="触发事件"
            rules={[{ required: true }]}
            style={{ width: 200 }}
          >
            <Select
              options={[
                { label: "INSERT", value: "INSERT" },
                { label: "UPDATE", value: "UPDATE" },
                { label: "DELETE", value: "DELETE" },
                ...(isPostgres
                  ? [{ label: "TRUNCATE", value: "TRUNCATE" }]
                  : []),
              ]}
            />
          </Form.Item>

          {/* 目标表 (只读) */}
          <Form.Item label="目标表" style={{ width: 200 }}>
            <SafeInput value={`${database}.${table}`} disabled />
          </Form.Item>
        </Space>

        {/* 触发器语句体 - Monaco Editor */}
        <Form.Item
          label={
            <Space>
              <span>{isPostgres ? "执行动作" : "触发器语句体"}</span>
              <Text type="secondary" style={{ fontSize: 11 }}>
                {isPostgres
                  ? "(PostgreSQL 需调用已存在的触发器函数，如 EXECUTE FUNCTION fn())"
                  : "(支持 SQL 语法高亮)"}
              </Text>
            </Space>
          }
          required
        >
          <div
            style={{
              border: "1px solid var(--border-color)",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <Editor
              height="260px"
              language="sql"
              theme={themeMode === "dark" ? "vs-dark" : "light"}
              value={triggerBody}
              onChange={(value) => setTriggerBody(value ?? "")}
              options={{
                fontSize: 13,
                minimap: { enabled: false },
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                wordWrap: "on",
                automaticLayout: true,
                tabSize: 2,
                suggestOnTriggerCharacters: true,
                quickSuggestions: true,
                contextmenu: false,
              }}
            />
          </div>
        </Form.Item>

        {/* SQL 预览 */}
        <Form.Item label="SQL 预览">
          <pre
            style={{
              background: "var(--bg-elevated)",
              color: "var(--color-primary)",
              padding: 12,
              borderRadius: 4,
              fontSize: 12,
              lineHeight: 1.5,
              overflow: "auto",
              maxHeight: 140,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              margin: 0,
            }}
          >
            {buildPreviewSql()}
          </pre>
        </Form.Item>
      </Form>
    </Modal>
  );
}
