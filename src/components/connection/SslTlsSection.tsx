import { Alert, Checkbox, Divider, Form, Select } from "antd";
import { SafeInput, SafeInputPassword } from "../common/SafeInput";
import { hasEnabledSsl } from "../../utils/connectionConfig";
import { FilePathInput } from "../common/FilePathInput";

const SSL_MODE_OPTIONS = [
  { value: "required", label: "加密连接（系统信任库 + 校验主机名）" },
  {
    value: "verify_ca",
    label: "VERIFY_CA（自定义 CA PEM，不校验证书主机名）",
  },
  {
    value: "verify_identity",
    label: "VERIFY_IDENTITY（自定义 CA + 校验主机名）",
  },
  {
    value: "required_insecure",
    label: "加密但不校验证书（仅调试用，不安全）",
  },
];

interface SslTlsSectionProps {
  enabled: boolean;
  databaseBrand: string;
  onEnabledChange: (enabled: boolean) => void;
}

export function SslTlsSection({
  enabled,
  databaseBrand,
  onEnabledChange,
}: SslTlsSectionProps) {
  const form = Form.useFormInstance();

  return (
    <>
      <Form.Item>
        <Checkbox
          checked={enabled}
          aria-controls={enabled ? "ssl-configuration" : undefined}
          aria-expanded={enabled}
          onChange={(event) => {
            const checked = event.target.checked;
            if (checked && !hasEnabledSsl(form.getFieldValue("sslMode"))) {
              form.setFieldValue("sslMode", "required");
            }
            onEnabledChange(checked);
          }}
        >
          使用 SSL / TLS
        </Checkbox>
      </Form.Item>

      {enabled && (
        <div id="ssl-configuration">
          <Divider orientation="left" style={{ fontSize: 13 }}>
            SSL / TLS 配置（{databaseBrand}）
          </Divider>

          <Form.Item name="sslMode" label="SSL 模式">
            <Select options={SSL_MODE_OPTIONS} />
          </Form.Item>

          <Form.Item
            noStyle
            shouldUpdate={(prev, cur) => prev.sslMode !== cur.sslMode}
          >
            {({ getFieldValue }) =>
              getFieldValue("sslMode") === "required_insecure" ? (
                <Alert
                  type="warning"
                  showIcon
                  message="当前模式不校验服务端证书，仅建议在可信内网调试。"
                  style={{ marginBottom: 16 }}
                />
              ) : null
            }
          </Form.Item>

          <Form.Item
            name="sslCaPath"
            label="CA 证书路径（PEM）"
            rules={[
              ({ getFieldValue }) => ({
                validator(_, value) {
                  const mode = getFieldValue("sslMode");
                  if (
                    (mode === "verify_ca" || mode === "verify_identity") &&
                    !(value && String(value).trim())
                  ) {
                    return Promise.reject(
                      new Error(
                        "VERIFY_CA / VERIFY_IDENTITY 模式下请填写 CA 证书路径"
                      )
                    );
                  }
                  return Promise.resolve();
                },
              }),
            ]}
          >
            <FilePathInput
              placeholder="/path/to/ca.pem（verify_ca / verify_identity 必填）"
              dialogTitle="选择 CA 证书文件"
              buttonLabel="选择 CA 证书文件"
              filters={[{ name: "PEM 证书", extensions: ["pem", "crt"] }]}
            />
          </Form.Item>

          <Form.Item name="sslPkcs12Path" label="客户端 PKCS#12 路径（可选）">
            <FilePathInput
              placeholder="双向 TLS 时的 .p12 / .pfx 文件"
              dialogTitle="选择 PKCS#12 文件"
              buttonLabel="选择 PKCS#12 文件"
              filters={[{ name: "PKCS#12", extensions: ["p12", "pfx"] }]}
            />
          </Form.Item>

          <Form.Item name="sslPkcs12Password" label="PKCS#12 密码（可选）">
            <SafeInputPassword placeholder="若归档有密码请填写" />
          </Form.Item>

          <Form.Item name="sslTlsHostname" label="TLS 校验主机名（可选）">
            <SafeInput placeholder="经 SSH 连接时填 RDS 等在证书上的主机名" />
          </Form.Item>
        </div>
      )}
    </>
  );
}
