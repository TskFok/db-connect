import { useState, useEffect } from "react";
import {
  Form,
  InputNumber,
  Button,
  Tabs,
  Card,
  Space,
  Typography,
  Divider,
  Alert,
  Spin,
  Select,
  Collapse,
  Input,
  Checkbox,
} from "antd";
import { SafeInput, SafeInputPassword } from "../common/SafeInput";
import {
  SaveOutlined,
  ApiOutlined,
  ThunderboltOutlined,
  ArrowLeftOutlined,
} from "@ant-design/icons";
import { useConnectionStore } from "../../stores/connectionStore";
import type { ConnectionConfig, ConnectionType, DatabaseType } from "../../types";
import {
  defaultPortForDatabaseType,
  normalizeDatabaseType,
} from "../../utils/connectionConfig";

const { Title } = Typography;

const DATABASE_TYPE_OPTIONS: Array<{
  value: DatabaseType;
  label: string;
  disabled?: boolean;
}> = [
  { value: "mysql", label: "MySQL" },
  { value: "postgres", label: "PostgreSQL" },
];

const SSL_MODE_OPTIONS = [
  { value: "disabled", label: "关闭（默认，不加密）" },
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

export function ConnectionForm() {
  const {
    editingConnection,
    loading,
    hideConnectionForm,
    saveConnection,
    connect,
    testConnection,
  } = useConnectionStore();

  const [form] = Form.useForm();
  const [sshForm] = Form.useForm();
  const [connectionType, setConnectionType] = useState<ConnectionType>(
    editingConnection?.ssh ? "ssh" : "direct"
  );
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const isEditing = !!editingConnection;
  const currentDatabaseType = normalizeDatabaseType(
    Form.useWatch("databaseType", form)
  );
  const databaseBrand =
    currentDatabaseType === "postgres" ? "PostgreSQL" : "MySQL";

  // editingConnection 变化时同步表单值（解决：先点新建再点编辑时配置不显示的问题）
  useEffect(() => {
    if (editingConnection) {
      setConnectionType(editingConnection.ssh ? "ssh" : "direct");
      const sslMode =
        editingConnection.ssl_mode &&
        editingConnection.ssl_mode.trim() !== "" &&
        editingConnection.ssl_mode !== "disabled"
          ? editingConnection.ssl_mode
          : "disabled";
      form.setFieldsValue({
        databaseType: normalizeDatabaseType(editingConnection.database_type),
        name: editingConnection.name,
        host: editingConnection.host,
        port: editingConnection.port,
        username: editingConnection.username,
        password: editingConnection.password,
        database: editingConnection.database,
        sslMode,
        sslCaPath: editingConnection.ssl_ca_path,
        sslPkcs12Path: editingConnection.ssl_pkcs12_path,
        sslPkcs12Password: editingConnection.ssl_pkcs12_password,
        sslTlsHostname: editingConnection.ssl_tls_hostname,
        clientCharset: editingConnection.client_charset,
        sessionInitLines: editingConnection.session_init_commands?.join("\n"),
        readOnlyConn: editingConnection.read_only === true,
        skipDangerousSql: editingConnection.skip_dangerous_sql_confirm === true,
      });
      if (editingConnection.ssh) {
        sshForm.setFieldsValue({
          sshHost: editingConnection.ssh.host,
          sshPort: editingConnection.ssh.port,
          sshUsername: editingConnection.ssh.username,
          sshPassword: editingConnection.ssh.password,
          sshKeyPath: editingConnection.ssh.private_key_path,
        });
      }
    } else {
      setConnectionType("direct");
      form.setFieldsValue({
        databaseType: "mysql",
        name: undefined,
        host: undefined,
        port: defaultPortForDatabaseType("mysql"),
        username: undefined,
        password: undefined,
        database: undefined,
        sslMode: "disabled",
        sslCaPath: undefined,
        sslPkcs12Path: undefined,
        sslPkcs12Password: undefined,
        sslTlsHostname: undefined,
        clientCharset: undefined,
        sessionInitLines: undefined,
        readOnlyConn: false,
        skipDangerousSql: false,
      });
      sshForm.setFieldsValue({
        sshHost: undefined,
        sshPort: 22,
        sshUsername: undefined,
        sshPassword: undefined,
        sshKeyPath: undefined,
      });
    }
    setTestResult(null);
  }, [editingConnection, form, sshForm]);

  // 从表单构建连接配置
  const buildConfig = (): ConnectionConfig => {
    const values = form.getFieldsValue();
    const databaseType = normalizeDatabaseType(values.databaseType);
    const config: ConnectionConfig = {
      id: editingConnection?.id,
      database_type: databaseType,
      name: values.name,
      host: values.host,
      port: values.port,
      username: values.username,
      password: values.password,
      database: values.database || undefined,
    };

    if (connectionType === "ssh") {
      const sshValues = sshForm.getFieldsValue();
      config.ssh = {
        host: sshValues.sshHost,
        port: sshValues.sshPort,
        username: sshValues.sshUsername,
        password: sshValues.sshPassword || undefined,
        private_key_path: sshValues.sshKeyPath || undefined,
      };
    }

    const sslMode = (values.sslMode as string | undefined) ?? "disabled";
    if (sslMode !== "disabled") {
      config.ssl_mode = sslMode;
      if (sslMode === "verify_ca" || sslMode === "verify_identity") {
        const ca = values.sslCaPath?.trim();
        if (ca) config.ssl_ca_path = ca;
      }
      const p12 = values.sslPkcs12Path?.trim();
      if (p12) {
        config.ssl_pkcs12_path = p12;
        const p12pw = values.sslPkcs12Password as string | undefined;
        if (p12pw) config.ssl_pkcs12_password = p12pw;
      }
      const tlsHost = values.sslTlsHostname?.trim();
      if (tlsHost) config.ssl_tls_hostname = tlsHost;
    }

    const clientCharset = (values.clientCharset as string | undefined)?.trim();
    if (clientCharset) {
      config.client_charset = clientCharset;
    }

    const sessionLines = values.sessionInitLines as string | undefined;
    const cmds = sessionLines
      ?.split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (cmds?.length) {
      config.session_init_commands = cmds;
    }

    if (values.readOnlyConn === true) {
      config.read_only = true;
    }

    if (values.skipDangerousSql === true) {
      config.skip_dangerous_sql_confirm = true;
    }

    return config;
  };

  // 测试连接
  const handleTest = async () => {
    try {
      await form.validateFields();
      if (connectionType === "ssh") {
        await sshForm.validateFields();
      }
    } catch {
      return;
    }

    setTesting(true);
    setTestResult(null);

    const config = buildConfig();
    const result = await testConnection(config);
    setTestResult(result);
    setTesting(false);
  };

  // 保存连接
  const handleSave = async () => {
    try {
      await form.validateFields();
      if (connectionType === "ssh") {
        await sshForm.validateFields();
      }
    } catch {
      return;
    }

    const config = buildConfig();
    await saveConnection(config);
  };

  // 保存并连接
  const handleSaveAndConnect = async () => {
    try {
      await form.validateFields();
      if (connectionType === "ssh") {
        await sshForm.validateFields();
      }
    } catch {
      return;
    }

    const config = buildConfig();
    await saveConnection(config);
    await connect(config);
  };

  // MySQL 连接表单字段
  const mysqlFields = (
    <>
      <Form.Item
        name="databaseType"
        label="数据库类型"
        rules={[{ required: true, message: "请选择数据库类型" }]}
      >
        <Select
          options={DATABASE_TYPE_OPTIONS}
          onChange={(value: DatabaseType) => {
            if (!isEditing) {
              form.setFieldValue("port", defaultPortForDatabaseType(value));
            }
          }}
        />
      </Form.Item>

      <Form.Item
        name="name"
        label="连接名称"
        rules={[{ required: true, message: "请输入连接名称" }]}
      >
        <SafeInput placeholder="例如: 本地开发数据库" />
      </Form.Item>

      <Form.Item
        name="host"
        label="主机地址"
        rules={[{ required: true, message: "请输入主机地址" }]}
      >
        <SafeInput placeholder="localhost 或 IP 地址" />
      </Form.Item>

      <Form.Item
        name="port"
        label="端口"
        rules={[{ required: true, message: "请输入端口" }]}
      >
        <InputNumber
          min={1}
          max={65535}
          style={{ width: "100%" }}
          placeholder={String(defaultPortForDatabaseType(currentDatabaseType))}
        />
      </Form.Item>

      <Form.Item
        name="username"
        label="用户名"
        rules={[{ required: true, message: "请输入用户名" }]}
      >
        <SafeInput
          placeholder={currentDatabaseType === "postgres" ? "postgres" : "root"}
        />
      </Form.Item>

      <Form.Item name="password" label="密码">
        <SafeInputPassword placeholder="数据库密码 (可选)" />
      </Form.Item>

      <Form.Item
        name="database"
        label={currentDatabaseType === "postgres" ? "数据库" : "默认数据库"}
      >
        <SafeInput
          placeholder={
            currentDatabaseType === "postgres"
              ? "PostgreSQL 物理 database，例如 postgres"
              : "可选，连接后自动选择的数据库"
          }
        />
      </Form.Item>

      <Divider orientation="left" style={{ fontSize: 13 }}>
        SSL / TLS（{databaseBrand}）
      </Divider>

      <Form.Item name="sslMode" label="SSL 模式" initialValue="disabled">
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
              const m = getFieldValue("sslMode");
              if (
                (m === "verify_ca" || m === "verify_identity") &&
                !(value && String(value).trim())
              ) {
                return Promise.reject(
                  new Error("VERIFY_CA / VERIFY_IDENTITY 模式下请填写 CA 证书路径")
                );
              }
              return Promise.resolve();
            },
          }),
        ]}
      >
        <SafeInput placeholder="/path/to/ca.pem（verify_ca / verify_identity 必填）" />
      </Form.Item>

      <Form.Item name="sslPkcs12Path" label="客户端 PKCS#12 路径（可选）">
        <SafeInput placeholder="双向 TLS 时的 .p12 / .pfx 文件" />
      </Form.Item>

      <Form.Item name="sslPkcs12Password" label="PKCS#12 密码（可选）">
        <SafeInputPassword placeholder="若归档有密码请填写" />
      </Form.Item>

      <Form.Item name="sslTlsHostname" label="TLS 校验主机名（可选）">
        <SafeInput placeholder="经 SSH 连接时填 RDS 等在证书上的主机名" />
      </Form.Item>

      <Collapse
        bordered={false}
        style={{ marginBottom: 8 }}
        items={[
          {
            key: "advanced",
            label:
              currentDatabaseType === "postgres"
                ? "高级：只读与安全"
                : "高级：字符集 / 会话 SQL / 只读与安全",
            children: (
              <>
                {currentDatabaseType === "mysql" && (
                  <>
                    <Form.Item
                      name="clientCharset"
                      label="客户端字符集（SET NAMES）"
                      tooltip="留空时后端默认 utf8mb4；仅允许字母、数字、下划线与连字符"
                    >
                      <SafeInput placeholder="例如 utf8mb4" />
                    </Form.Item>
                    <Form.Item
                      name="sessionInitLines"
                      label="连接后执行的会话 SQL"
                      tooltip="每行一条，例如 SET SESSION max_execution_time = 30000"
                    >
                      <Input.TextArea
                        rows={4}
                        placeholder={"每行一条 SQL\nSET SESSION max_execution_time = 30000"}
                      />
                    </Form.Item>
                  </>
                )}
                <Form.Item
                  name="readOnlyConn"
                  valuePropName="checked"
                  label="只读连接"
                >
                  <Checkbox>
                    禁止写操作（表结构编辑、导入、SQL 编辑器的 DML/DDL 等；仅允许查询与 USE）
                  </Checkbox>
                </Form.Item>
                <Form.Item
                  name="skipDangerousSql"
                  valuePropName="checked"
                  label="高危 SQL"
                  tooltip="未勾选时：在 SQL 编辑器执行批量语句前，若含 TRUNCATE、DROP DATABASE / SCHEMA，将弹出二次确认。勾选后跳过该确认（生产环境不推荐）"
                >
                  <Checkbox>跳过 TRUNCATE / DROP DATABASE 等二次确认</Checkbox>
                </Form.Item>
              </>
            ),
          },
        ]}
      />
    </>
  );

  // SSH 配置表单字段
  const sshFields = (
    <Form
      form={sshForm}
      layout="vertical"
      initialValues={
        editingConnection?.ssh
          ? {
              sshHost: editingConnection.ssh.host,
              sshPort: editingConnection.ssh.port,
              sshUsername: editingConnection.ssh.username,
              sshPassword: editingConnection.ssh.password,
              sshKeyPath: editingConnection.ssh.private_key_path,
            }
          : { sshPort: 22 }
      }
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
        <SafeInput placeholder="例如: /Users/you/.ssh/id_rsa" />
      </Form.Item>
    </Form>
  );

  return (
    <div className="connection-form-wrapper">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          marginBottom: 24,
          gap: 12,
        }}
      >
        <Button
          type="text"
          icon={<ArrowLeftOutlined />}
          onClick={hideConnectionForm}
        />
        <Title level={4} style={{ margin: 0 }}>
          {isEditing ? "编辑连接" : "新建连接"}
        </Title>
      </div>

      <Card>
        <Tabs
          activeKey={connectionType}
          onChange={(key) => setConnectionType(key as ConnectionType)}
          items={[
            { key: "direct", label: "直接连接" },
            { key: "ssh", label: "SSH 隧道" },
          ]}
        />

        <Form
          form={form}
          layout="vertical"
          initialValues={
            editingConnection
              ? {
                  databaseType: normalizeDatabaseType(
                    editingConnection.database_type
                  ),
                  name: editingConnection.name,
                  host: editingConnection.host,
                  port: editingConnection.port,
                  username: editingConnection.username,
                  password: editingConnection.password,
                  database: editingConnection.database,
                  sslMode:
                    editingConnection.ssl_mode &&
                    editingConnection.ssl_mode.trim() !== "" &&
                    editingConnection.ssl_mode !== "disabled"
                      ? editingConnection.ssl_mode
                      : "disabled",
                  sslCaPath: editingConnection.ssl_ca_path,
                  sslPkcs12Path: editingConnection.ssl_pkcs12_path,
                  sslPkcs12Password: editingConnection.ssl_pkcs12_password,
                  sslTlsHostname: editingConnection.ssl_tls_hostname,
                  clientCharset: editingConnection.client_charset,
                  sessionInitLines:
                    editingConnection.session_init_commands?.join("\n"),
                  readOnlyConn: editingConnection.read_only === true,
                  skipDangerousSql:
                    editingConnection.skip_dangerous_sql_confirm === true,
                }
              : {
                  databaseType: "mysql",
                  port: defaultPortForDatabaseType("mysql"),
                  sslMode: "disabled",
                  readOnlyConn: false,
                  skipDangerousSql: false,
                }
          }
        >
          {mysqlFields}
        </Form>

        {connectionType === "ssh" && sshFields}

        {/* 测试结果 */}
        {testResult && (
          <Alert
            type={testResult.success ? "success" : "error"}
            message={testResult.message}
            showIcon
            closable
            onClose={() => setTestResult(null)}
            style={{ marginBottom: 16 }}
          />
        )}

        {/* 操作按钮 */}
        <Divider />
        <Space>
          <Spin spinning={testing}>
            <Button icon={<ApiOutlined />} onClick={handleTest}>
              测试连接
            </Button>
          </Spin>
          <Button
            icon={<SaveOutlined />}
            onClick={handleSave}
            loading={loading}
          >
            保存
          </Button>
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            onClick={handleSaveAndConnect}
            loading={loading}
          >
            保存并连接
          </Button>
        </Space>
      </Card>
    </div>
  );
}
