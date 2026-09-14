import { Alert, Button, Modal, Spin, message } from "antd";
import { CopyOutlined } from "@ant-design/icons";
import { copyTextWithBreadcrumb } from "../../utils/crashBreadcrumbs";

interface SqlPreviewModalProps {
  open: boolean;
  loading: boolean;
  sql: string[];
  error: string | null;
  onClose: () => void;
}

export function SqlPreviewModal({
  open,
  loading,
  sql,
  error,
  onClose,
}: SqlPreviewModalProps) {
  const [messageApi, contextHolder] = message.useMessage();
  const sqlText = sql
    .map((statement) => `${statement.trim().replace(/;+$/, "")};`)
    .join("\n\n");
  const handleCopy = async () => {
    try {
      await copyTextWithBreadcrumb(sqlText, "schema-sql-preview");
      messageApi.success("SQL 已复制");
    } catch {
      messageApi.error("复制失败");
    }
  };

  return (
    <Modal
      title="SQL 预览"
      open={open}
      onCancel={onClose}
      width={760}
      style={{ top: 48, paddingBottom: 32 }}
      styles={{
        body: { maxHeight: "calc(100dvh - 220px)", overflowY: "auto" },
      }}
      destroyOnHidden
      footer={[
        <Button key="close" onClick={onClose}>
          关闭
        </Button>,
        <Button
          key="copy"
          icon={<CopyOutlined />}
          disabled={loading || !!error || !sqlText}
          onClick={() => void handleCopy()}
        >
          复制 SQL
        </Button>,
      ]}
    >
      {contextHolder}
      {loading ? (
        <div style={{ padding: 32, textAlign: "center" }}>
          <Spin aria-label="正在生成 SQL" />
        </div>
      ) : error ? (
        <Alert
          type="error"
          showIcon
          message="SQL 预览失败"
          description={error}
        />
      ) : sqlText ? (
        <>
          <Alert
            type="info"
            showIcon
            message="以下 SQL 尚未执行，请返回表单保存后生效。"
            style={{ marginBottom: 12 }}
          />
          <pre
            style={{
              margin: 0,
              padding: 12,
              fontSize: 12,
              fontFamily: "monospace",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              background: "var(--bg-elevated)",
              borderRadius: 6,
            }}
          >
            {sqlText}
          </pre>
        </>
      ) : (
        <Alert type="info" showIcon message="没有需要执行的 SQL" />
      )}
    </Modal>
  );
}
