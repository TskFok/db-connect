import { Divider, Form, InputNumber, type FormInstance } from "antd";
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

export function SshTunnelFields({ form, initialValues }: SshTunnelFieldsProps) {
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
    </Form>
  );
}
