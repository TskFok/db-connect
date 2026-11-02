import { useRef, useState } from "react";
import {
  Alert,
  Button,
  Divider,
  Form,
  InputNumber,
  Modal,
  type FormInstance,
} from "antd";
import { invoke } from "@tauri-apps/api/core";
import { SafeInput, SafeInputPassword } from "../common/SafeInput";
import { FilePathInput } from "../common/FilePathInput";

export interface SshTunnelFormValues {
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshPassword?: string;
  sshKeyPath?: string;
}

interface SshTunnelFieldsProps {
  form: FormInstance<SshTunnelFormValues>;
  initialValues?: Partial<SshTunnelFormValues>;
}

interface KnownHostTarget {
  host: string;
  port: number;
}

function formatKnownHostTarget({ host, port }: KnownHostTarget): string {
  return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

export function SshTunnelFields({ form, initialValues }: SshTunnelFieldsProps) {
  const sshHost = Form.useWatch("sshHost", form) as string | undefined;
  const sshPort = Form.useWatch("sshPort", form) as number | undefined;
  const host = sshHost?.trim() ?? "";
  const validHost =
    host.length > 0 &&
    !host.startsWith("-") &&
    !Array.from(host).some(
      (char) =>
        /\s/.test(char) ||
        char.charCodeAt(0) < 32 ||
        (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159) ||
        "\\/,[]*?!|".includes(char)
    );
  const validTarget =
    validHost &&
    typeof sshPort === "number" &&
    Number.isInteger(sshPort) &&
    sshPort >= 1 &&
    sshPort <= 65535;
  const [clearTarget, setClearTarget] = useState<KnownHostTarget | null>(null);
  const [clearing, setClearing] = useState(false);
  const clearingRef = useRef(false);
  const [clearResult, setClearResult] = useState<{
    type: "success" | "info" | "error";
    message: string;
  } | null>(null);

  const handleClearKnownHost = async () => {
    if (!clearTarget || clearingRef.current) return;
    clearingRef.current = true;
    setClearing(true);
    setClearResult(null);
    const targetLabel = formatKnownHostTarget(clearTarget);
    try {
      const removed = await invoke<boolean>("clear_ssh_known_host", {
        host: clearTarget.host,
        port: clearTarget.port,
      });
      setClearResult({
        type: removed ? "success" : "info",
        message: removed
          ? `已清除 ${targetLabel} 的主机密钥缓存，下次连接将重新记录。`
          : `${targetLabel} 无主机密钥缓存记录，无需清理。`,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setClearResult({
        type: "error",
        message: `清除 ${targetLabel} 的主机密钥缓存失败：${detail}`,
      });
    } finally {
      clearingRef.current = false;
      setClearing(false);
      setClearTarget(null);
    }
  };

  return (
    <Form
      id="ssh-configuration"
      form={form}
      layout="vertical"
      initialValues={initialValues ?? { sshPort: 22 }}
    >
      <Divider orientation="left" style={{ fontSize: 13 }}>
        SSH 隧道配置
      </Divider>

      <Form.Item
        name="sshHost"
        label="SSH 服务器"
        rules={[{ required: true, message: "请输入 SSH 服务器地址" }]}
      >
        <SafeInput placeholder="SSH 服务器 IP 或域名" />
      </Form.Item>

      <Form.Item
        name="sshPort"
        label="SSH 端口"
        rules={[{ required: true, message: "请输入 SSH 端口" }]}
      >
        <InputNumber
          min={1}
          max={65535}
          style={{ width: "100%" }}
          placeholder="22"
        />
      </Form.Item>

      <Form.Item
        name="sshUsername"
        label="SSH 用户名"
        rules={[{ required: true, message: "请输入 SSH 用户名" }]}
      >
        <SafeInput placeholder="SSH 登录用户名" />
      </Form.Item>

      <Form.Item name="sshPassword" label="SSH 密码">
        <SafeInputPassword placeholder="SSH 密码 (密码认证时填写)" />
      </Form.Item>

      <Form.Item name="sshKeyPath" label="SSH 私钥路径">
        <FilePathInput
          placeholder="例如: /Users/you/.ssh/id_rsa"
          dialogTitle="选择 SSH 私钥文件"
          buttonLabel="选择 SSH 私钥文件"
        />
      </Form.Item>

      <Form.Item style={{ marginBottom: clearResult ? 12 : 0 }}>
        <Button
          disabled={!validTarget || clearing || clearTarget !== null}
          loading={clearing}
          onClick={() => {
            if (validTarget && sshPort !== undefined && !clearingRef.current) {
              setClearTarget({ host, port: sshPort });
            }
          }}
        >
          清除主机密钥缓存
        </Button>
      </Form.Item>
      {clearResult && (
        <Alert
          type={clearResult.type}
          showIcon
          message={clearResult.message}
          style={{
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            maxHeight: 240,
            overflowY: "auto",
          }}
        />
      )}
      <Modal
        title="清除主机密钥缓存"
        open={clearTarget !== null}
        okText="确认清除"
        cancelText="取消"
        confirmLoading={clearing}
        okButtonProps={{ danger: true, disabled: clearing }}
        cancelButtonProps={{ disabled: clearing, "aria-label": "取消清理" }}
        closable={!clearing}
        maskClosable={!clearing}
        keyboard={!clearing}
        onOk={() => void handleClearKnownHost()}
        onCancel={() => {
          if (!clearingRef.current) setClearTarget(null);
        }}
      >
        <p style={{ overflowWrap: "anywhere" }}>
          即将清除 {clearTarget ? formatKnownHostTarget(clearTarget) : ""}
          的主机密钥缓存。
        </p>
        <p>
          仅在确认服务器身份后清理；下次连接时将重新记录该服务器的主机密钥。
        </p>
        <p>仅清除本应用的缓存，不删除私钥或系统 known_hosts 文件。</p>
      </Modal>
    </Form>
  );
}
