import { useState, useEffect } from "react";
import {
  Form,
  InputNumber,
  Button,
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
import { SslTlsSection } from "./SslTlsSection";
import { SshTunnelFields, type SshTunnelFormValues } from "./SshTunnelFields";
import {
  SaveOutlined,
  ApiOutlined,
  ThunderboltOutlined,
  ArrowLeftOutlined,
} from "@ant-design/icons";
import { useConnectionStore } from "../../stores/connectionStore";
import type { ConnectionConfig, DatabaseType } from "../../types";
import {
  defaultPortForDatabaseType,
  hasEnabledSsl,
  normalizeDatabaseType,
  normalizeSslMode,
} from "../../utils/connectionConfig";

const { Title } = Typography;

const DATABASE_TYPE_OPTIONS: Array<{
  value: DatabaseType;
  label: string;
  disabled?: boolean;
}> = [
  { value: "mysql", label: "MySQL" },
  { value: "postgres", label: "PostgreSQL" },
  { value: "sqlite", label: "SQLite" },
  { value: "sqlserver", label: "SQL Server" },
  { value: "clickhouse", label: "ClickHouse" },
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
  const [sshForm] = Form.useForm<SshTunnelFormValues>();
  const [useSslTls, setUseSslTls] = useState(
    hasEnabledSsl(editingConnection?.ssl_mode)
  );
  const [useSshTunnel, setUseSshTunnel] = useState(!!editingConnection?.ssh);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
  } | null>(null);
  const [testing, setTesting] = useState(false);

  const isEditing = !!editingConnection;
  const watchedDatabaseType = Form.useWatch("databaseType", form);
  const currentDatabaseType = normalizeDatabaseType(
    watchedDatabaseType ?? editingConnection?.database_type
  );
  const databaseBrand =
    currentDatabaseType === "postgres"
      ? "PostgreSQL"
      : currentDatabaseType === "sqlite"
        ? "SQLite"
        : currentDatabaseType === "sqlserver"
          ? "SQL Server"
          : currentDatabaseType === "clickhouse"
            ? "ClickHouse"
            : "MySQL";

  // editingConnection 变化时同步表单值（解决：先点新建再点编辑时配置不显示的问题）
  useEffect(() => {
    if (editingConnection) {
      const sslMode = normalizeSslMode(editingConnection.ssl_mode);
      setUseSslTls(sslMode !== "disabled");
      setUseSshTunnel(!!editingConnection.ssh);
      form.setFieldsValue({
        databaseType: normalizeDatabaseType(editingConnection.database_type),
        name: editingConnection.name,
        host: editingConnection.host,
        port: editingConnection.port,
        username: editingConnection.username,
        password: editingConnection.password,
        database: editingConnection.database,
        sqlitePath: editingConnection.sqlite_path,
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
      sshForm.setFieldsValue(
        editingConnection.ssh
          ? {
              sshHost: editingConnection.ssh.host,
              sshPort: editingConnection.ssh.port,
              sshUsername: editingConnection.ssh.username,
              sshPassword: editingConnection.ssh.password,
              sshKeyPath: editingConnection.ssh.private_key_path,
            }
          : {
              sshHost: undefined,
              sshPort: 22,
              sshUsername: undefined,
              sshPassword: undefined,
              sshKeyPath: undefined,
            }
      );
    } else {
      setUseSslTls(false);
      setUseSshTunnel(false);
      form.setFieldsValue({
        databaseType: "mysql",
        name: undefined,
        host: undefined,
        port: defaultPortForDatabaseType("mysql"),
        username: undefined,
        password: undefined,
        database: undefined,
        sqlitePath: undefined,
        sslMode: "required",
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
    if (databaseType === "sqlite") {
      return {
        id: editingConnection?.id,
        database_type: "sqlite",
        name: values.name,
        host: "",
        port: 0,
        username: "",
        password: undefined,
        database: undefined,
        sqlite_path: values.sqlitePath?.trim(),
        read_only: values.readOnlyConn === true,
        skip_dangerous_sql_confirm: values.skipDangerousSql === true,
      };
    }

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

    if (useSshTunnel) {
      const sshValues = sshForm.getFieldsValue();
      config.ssh = {
        host: sshValues.sshHost,
        port: sshValues.sshPort,
        username: sshValues.sshUsername,
        password: sshValues.sshPassword || undefined,
        private_key_path: sshValues.sshKeyPath || undefined,
      };
    }

    const selectedSslMode = normalizeSslMode(values.sslMode);
    const sslMode =
      selectedSslMode === "disabled" ? "required" : selectedSslMode;
    if (useSslTls) {
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
      if (useSshTunnel && currentDatabaseType !== "sqlite") {
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
      if (useSshTunnel && currentDatabaseType !== "sqlite") {
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
      if (useSshTunnel && currentDatabaseType !== "sqlite") {
        await sshForm.validateFields();
      }
    } catch {
      return;
    }

    const config = buildConfig();
    await saveConnection(config);
    await connect(config);
  };

  const safetyFields = (
    <>
      <Form.Item name="readOnlyConn" valuePropName="checked" label="只读连接">
        <Checkbox aria-label="只读连接">
          禁止写操作（表结构编辑、导入、SQL 编辑器的 DML/DDL 等；仅允许查询与
          USE）
        </Checkbox>
      </Form.Item>
      <Form.Item
        name="skipDangerousSql"
        valuePropName="checked"
        label="高危 SQL"
        tooltip="未勾选时：在 SQL 编辑器执行批量语句前，若含 TRUNCATE、DROP DATABASE / SCHEMA，将弹出二次确认。勾选后跳过该确认（生产环境不推荐）"
      >
        <Checkbox aria-label="高危 SQL">
          跳过 TRUNCATE / DROP DATABASE 等二次确认
        </Checkbox>
      </Form.Item>
    </>
  );

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
            if (value === "sqlite") {
              setUseSslTls(false);
              setUseSshTunnel(false);
            }
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

      {currentDatabaseType === "sqlite" ? (
        <>
          <Form.Item
            name="sqlitePath"
            label="SQLite 文件"
            rules={[{ required: true, message: "请选择 SQLite 数据库文件" }]}
          >
            <SafeInput placeholder="/path/to/database.sqlite" />
          </Form.Item>
          {safetyFields}
        </>
      ) : (
        <>
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
              placeholder={String(
                defaultPortForDatabaseType(currentDatabaseType)
              )}
            />
          </Form.Item>

          <Form.Item
            name="username"
            label="用户名"
            rules={[{ required: true, message: "请输入用户名" }]}
          >
            <SafeInput
              placeholder={
                currentDatabaseType === "postgres"
                  ? "postgres"
                  : currentDatabaseType === "sqlserver"
                    ? "sa"
                    : currentDatabaseType === "clickhouse"
                      ? "default"
                      : "root"
              }
            />
          </Form.Item>

          <Form.Item name="password" label="密码">
            <SafeInputPassword placeholder="数据库密码 (可选)" />
          </Form.Item>

          <Form.Item
            name="database"
            label={
              currentDatabaseType === "postgres" ||
              currentDatabaseType === "sqlserver" ||
              currentDatabaseType === "clickhouse"
                ? "数据库"
                : "默认数据库"
            }
          >
            <SafeInput
              placeholder={
                currentDatabaseType === "postgres"
                  ? "PostgreSQL 物理 database，例如 postgres"
                  : currentDatabaseType === "sqlserver"
                    ? "SQL Server 物理 database，例如 master"
                    : currentDatabaseType === "clickhouse"
                      ? "ClickHouse database，例如 default"
                      : "可选，连接后自动选择的数据库"
              }
            />
          </Form.Item>
        </>
      )}

      {currentDatabaseType !== "sqlite" && (
        <Collapse
          bordered={false}
          style={{ marginBottom: 8 }}
          items={[
            {
              key: "advanced",
              label:
                currentDatabaseType !== "mysql"
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
                          placeholder={
                            "每行一条 SQL\nSET SESSION max_execution_time = 30000"
                          }
                        />
                      </Form.Item>
                    </>
                  )}
                  {safetyFields}
                </>
              ),
            },
          ]}
        />
      )}

      {currentDatabaseType !== "sqlite" && (
        <>
          <Divider orientation="left" style={{ fontSize: 13 }}>
            连接选项
          </Divider>

          <SslTlsSection
            enabled={useSslTls}
            databaseBrand={databaseBrand}
            onEnabledChange={setUseSslTls}
          />

          <Form.Item style={{ marginBottom: 0 }}>
            <Checkbox
              checked={useSshTunnel}
              aria-controls="ssh-configuration"
              aria-expanded={useSshTunnel}
              onChange={(event) => setUseSshTunnel(event.target.checked)}
            >
              使用 SSH 隧道
            </Checkbox>
          </Form.Item>
        </>
      )}
    </>
  );

  return (
    <div className="connection-form-wrapper">
      <div
        className="connection-form-header"
        style={{
          display: "flex",
          alignItems: "center",
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

      <Card className="connection-form-card">
        <div className="connection-form-scroll">
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
                    sqlitePath: editingConnection.sqlite_path,
                    sslMode: normalizeSslMode(editingConnection.ssl_mode),
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
                    sqlitePath: undefined,
                    sslMode: "required",
                    readOnlyConn: false,
                    skipDangerousSql: false,
                  }
            }
          >
            {mysqlFields}
          </Form>

          <div hidden={!useSshTunnel || currentDatabaseType === "sqlite"}>
            <SshTunnelFields
              form={sshForm}
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
            />
          </div>
        </div>

        <div className="connection-form-actions">
          {testResult && (
            <Alert
              type={testResult.success ? "success" : "error"}
              message={testResult.message}
              showIcon
              closable
              onClose={() => setTestResult(null)}
              style={{ marginBottom: 12 }}
            />
          )}

          <Space wrap>
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
        </div>
      </Card>
    </div>
  );
}
