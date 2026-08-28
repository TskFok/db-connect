import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ConnectionForm } from "../components/connection/ConnectionForm";
import { useConnectionStore } from "../stores/connectionStore";
import * as api from "../services/tauriCommands";
import { open } from "@tauri-apps/plugin-dialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("../services/tauriCommands", () => ({
  listSavedConnections: vi.fn(),
  getDecryptedConnection: vi.fn(),
  saveConnection: vi.fn(),
  deleteSavedConnection: vi.fn(),
  reorderConnections: vi.fn(),
  reorderConnectionGroups: vi.fn(),
  listConnectionGroups: vi.fn(),
  createConnectionGroup: vi.fn(),
  renameConnectionGroup: vi.fn(),
  deleteConnectionGroup: vi.fn(),
  setConnectionGroupCollapsed: vi.fn(),
  moveConnectionToGroup: vi.fn(),
  exportConnections: vi.fn(),
  importConnections: vi.fn(),
  testConnection: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  forceDisconnect: vi.fn(),
  pingConnection: vi.fn(),
  getSessionInfo: vi.fn(),
  getSessionInfoCached: vi.fn(),
  invalidateSessionInfoCache: vi.fn(),
}));

const mockApi = vi.mocked(api);
const mockOpen = vi.mocked(open);

describe("ConnectionForm database type defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOpen.mockReset();
    if (!window.matchMedia) {
      vi.stubGlobal("matchMedia", () => ({
        matches: false,
        media: "",
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));
    }
    useConnectionStore.setState({
      savedConnections: [],
      connectionGroups: [],
      activeConnections: {},
      activeConnId: null,
      activeConnection: null,
      loading: false,
      error: null,
      showConnectionForm: true,
      editingConnection: null,
    });
  });

  it("新建连接默认选择 MySQL 并使用 3306 端口", () => {
    render(<ConnectionForm />);

    expect(screen.getByText("MySQL")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "端口" })).toHaveValue(
      "3306"
    );
  }, 20_000);

  it("新建服务端连接默认通过复选框隐藏 SSL 与 SSH 配置", () => {
    render(<ConnectionForm />);

    const sslToggle = screen.getByRole("checkbox", {
      name: "使用 SSL / TLS",
    });
    expect(sslToggle).not.toBeChecked();
    expect(sslToggle).not.toHaveAttribute("aria-controls");
    expect(
      screen.getByRole("checkbox", { name: "使用 SSH 隧道" })
    ).not.toBeChecked();
    expect(screen.queryByRole("tab", { name: "直接连接" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "SSH 隧道" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "SSL 模式" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "SSH 服务器" })).toBeNull();
  });

  it("勾选使用 SSL 后显示 SSL 配置", () => {
    render(<ConnectionForm />);

    const sslToggle = screen.getByRole("checkbox", {
      name: "使用 SSL / TLS",
    });
    fireEvent.click(sslToggle);

    expect(sslToggle).toHaveAttribute("aria-controls", "ssl-configuration");
    expect(
      screen.getByRole("combobox", { name: "SSL 模式" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("加密连接（系统信任库 + 校验主机名）")
    ).toBeInTheDocument();
  });

  it("选择 CA 证书后将系统文件路径回填到输入框", async () => {
    mockOpen.mockResolvedValue("/certs/company-ca.pem");
    render(<ConnectionForm />);

    fireEvent.click(screen.getByRole("checkbox", { name: "使用 SSL / TLS" }));
    fireEvent.click(screen.getByRole("button", { name: "选择 CA 证书文件" }));

    await waitFor(() => {
      expect(
        screen.getByRole("textbox", { name: "CA 证书路径（PEM）" })
      ).toHaveValue("/certs/company-ca.pem");
    });
    expect(mockOpen).toHaveBeenCalledWith({
      title: "选择 CA 证书文件",
      multiple: false,
      directory: false,
      filters: [{ name: "PEM 证书", extensions: ["pem", "crt"] }],
    });
  });

  it("选择 PKCS#12 文件后将系统文件路径回填到输入框", async () => {
    mockOpen.mockResolvedValue("/certs/client.p12");
    render(<ConnectionForm />);

    fireEvent.click(screen.getByRole("checkbox", { name: "使用 SSL / TLS" }));
    fireEvent.click(screen.getByRole("button", { name: "选择 PKCS#12 文件" }));

    await waitFor(() => {
      expect(
        screen.getByRole("textbox", {
          name: "客户端 PKCS#12 路径（可选）",
        })
      ).toHaveValue("/certs/client.p12");
    });
    expect(mockOpen).toHaveBeenCalledWith({
      title: "选择 PKCS#12 文件",
      multiple: false,
      directory: false,
      filters: [{ name: "PKCS#12", extensions: ["p12", "pfx"] }],
    });
  });

  it("勾选使用 SSH 隧道后显示 SSH 配置", () => {
    render(<ConnectionForm />);

    fireEvent.click(screen.getByRole("checkbox", { name: "使用 SSH 隧道" }));

    expect(
      screen.getByRole("textbox", { name: "SSH 服务器" })
    ).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "SSH 端口" })).toHaveValue(
      "22"
    );
  });

  it("选择 SSH 私钥后回填路径且不限制文件扩展名", async () => {
    mockOpen.mockResolvedValue("/Users/demo/.ssh/id_ed25519");
    render(<ConnectionForm />);

    fireEvent.click(screen.getByRole("checkbox", { name: "使用 SSH 隧道" }));
    fireEvent.click(screen.getByRole("button", { name: "选择 SSH 私钥文件" }));

    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "SSH 私钥路径" })).toHaveValue(
        "/Users/demo/.ssh/id_ed25519"
      );
    });
    expect(mockOpen).toHaveBeenCalledWith({
      title: "选择 SSH 私钥文件",
      multiple: false,
      directory: false,
    });
  });

  it("取消系统文件选择时保留手动输入的路径", async () => {
    mockOpen.mockResolvedValue(null);
    render(<ConnectionForm />);

    fireEvent.click(screen.getByRole("checkbox", { name: "使用 SSH 隧道" }));
    const keyPathInput = screen.getByRole("textbox", {
      name: "SSH 私钥路径",
    });
    fireEvent.change(keyPathInput, {
      target: { value: "/manually-entered/id_rsa" },
    });
    fireEvent.click(screen.getByRole("button", { name: "选择 SSH 私钥文件" }));

    await waitFor(() => expect(mockOpen).toHaveBeenCalledTimes(1));
    expect(keyPathInput).toHaveValue("/manually-entered/id_rsa");
  });

  it("系统文件选择失败时保留原路径并提示失败原因", async () => {
    mockOpen.mockRejectedValue(new Error("permission denied"));
    render(<ConnectionForm />);

    fireEvent.click(screen.getByRole("checkbox", { name: "使用 SSH 隧道" }));
    const keyPathInput = screen.getByRole("textbox", {
      name: "SSH 私钥路径",
    });
    fireEvent.change(keyPathInput, {
      target: { value: "/manually-entered/id_rsa" },
    });
    fireEvent.click(screen.getByRole("button", { name: "选择 SSH 私钥文件" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "选择 SSH 私钥文件失败：permission denied"
    );
    expect(keyPathInput).toHaveValue("/manually-entered/id_rsa");
  });

  it("编辑已有 SSL 与 SSH 配置时自动勾选并回填", () => {
    useConnectionStore.setState({
      editingConnection: {
        id: "secured",
        database_type: "postgres",
        name: "Secured PostgreSQL",
        host: "db.internal",
        port: 5432,
        username: "postgres",
        ssl_mode: "required",
        ssh: {
          host: "jump.internal",
          port: 22,
          username: "deploy",
        },
      },
    });

    render(<ConnectionForm />);

    expect(
      screen.getByRole("checkbox", { name: "使用 SSL / TLS" })
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "使用 SSH 隧道" })
    ).toBeChecked();
    expect(
      screen.getByRole("combobox", { name: "SSL 模式" })
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "SSH 服务器" })).toHaveValue(
      "jump.internal"
    );
  });

  it("切换到无 SSH 的编辑连接时清空上一个 SSH 配置", async () => {
    useConnectionStore.setState({
      editingConnection: {
        id: "with-ssh",
        database_type: "postgres",
        name: "With SSH",
        host: "db.internal",
        port: 5432,
        username: "postgres",
        ssh: {
          host: "jump.internal",
          port: 2202,
          username: "deploy",
          password: "secret",
          private_key_path: "/tmp/id_rsa",
        },
      },
    });
    render(<ConnectionForm />);

    act(() => {
      useConnectionStore.setState({
        editingConnection: {
          id: "direct",
          database_type: "postgres",
          name: "Direct",
          host: "direct.internal",
          port: 5432,
          username: "postgres",
        },
      });
    });

    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", { name: "使用 SSH 隧道" })
      ).not.toBeChecked();
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "使用 SSH 隧道" }));

    expect(screen.getByRole("textbox", { name: "SSH 服务器" })).toHaveValue("");
    expect(screen.getByRole("spinbutton", { name: "SSH 端口" })).toHaveValue(
      "22"
    );
    expect(screen.getByRole("textbox", { name: "SSH 用户名" })).toHaveValue("");
    expect(screen.getByLabelText("SSH 密码")).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "SSH 私钥路径" })).toHaveValue(
      ""
    );
  });

  it.each(["disabled", " DISABLED ", "off", " NONE "])(
    "编辑禁用 SSL 模式 %s 时保持未勾选",
    (sslMode) => {
      useConnectionStore.setState({
        editingConnection: {
          id: "ssl-disabled",
          database_type: "postgres",
          name: "SSL Disabled",
          host: "db.internal",
          port: 5432,
          username: "postgres",
          ssl_mode: sslMode,
        },
      });

      render(<ConnectionForm />);

      expect(
        screen.getByRole("checkbox", { name: "使用 SSL / TLS" })
      ).not.toBeChecked();
      expect(screen.queryByRole("combobox", { name: "SSL 模式" })).toBeNull();
    }
  );

  it("编辑带空格和大写的 SSL 模式时规范化并正确回填", () => {
    useConnectionStore.setState({
      editingConnection: {
        id: "ssl-required",
        database_type: "postgres",
        name: "SSL Required",
        host: "db.internal",
        port: 5432,
        username: "postgres",
        ssl_mode: " REQUIRED ",
      },
    });

    render(<ConnectionForm />);

    expect(
      screen.getByRole("checkbox", { name: "使用 SSL / TLS" })
    ).toBeChecked();
    expect(
      screen.getByText("加密连接（系统信任库 + 校验主机名）")
    ).toBeInTheDocument();
  });

  it("取消 SSL 与 SSH 选项后保存时移除原配置", async () => {
    mockApi.saveConnection.mockResolvedValue(undefined);
    mockApi.listSavedConnections.mockResolvedValue([]);
    useConnectionStore.setState({
      editingConnection: {
        id: "secured",
        database_type: "postgres",
        name: "Secured PostgreSQL",
        host: "db.internal",
        port: 5432,
        username: "postgres",
        ssl_mode: "required",
        ssh: {
          host: "jump.internal",
          port: 22,
          username: "deploy",
        },
      },
    });
    render(<ConnectionForm />);

    fireEvent.click(screen.getByRole("checkbox", { name: "使用 SSL / TLS" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "使用 SSH 隧道" }));
    fireEvent.click(screen.getByRole("button", { name: /保存$/ }));

    await waitFor(() => {
      expect(mockApi.saveConnection).toHaveBeenCalledWith({
        id: "secured",
        database_type: "postgres",
        name: "Secured PostgreSQL",
        host: "db.internal",
        port: 5432,
        username: "postgres",
        password: undefined,
        database: undefined,
      });
    });
  });

  it("开启 SSL 并填写证书配置后保存时提交完整 SSL 字段", async () => {
    mockApi.saveConnection.mockResolvedValue(undefined);
    mockApi.listSavedConnections.mockResolvedValue([]);
    render(<ConnectionForm />);

    fireEvent.change(screen.getByRole("textbox", { name: "连接名称" }), {
      target: { value: "TLS MySQL" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "主机地址" }), {
      target: { value: "db.example.com" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "用户名" }), {
      target: { value: "root" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "使用 SSL / TLS" }));

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "SSL 模式" }));
    fireEvent.click(
      await screen.findByText("VERIFY_IDENTITY（自定义 CA + 校验主机名）")
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "CA 证书路径（PEM）" }),
      { target: { value: " /certs/ca.pem " } }
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "客户端 PKCS#12 路径（可选）" }),
      { target: { value: " /certs/client.p12 " } }
    );
    fireEvent.change(screen.getByLabelText("PKCS#12 密码（可选）"), {
      target: { value: "secret" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "TLS 校验主机名（可选）" }),
      { target: { value: " db.internal " } }
    );
    fireEvent.click(screen.getByRole("button", { name: /保存$/ }));

    await waitFor(() => {
      expect(mockApi.saveConnection).toHaveBeenCalledWith({
        database_type: "mysql",
        name: "TLS MySQL",
        host: "db.example.com",
        port: 3306,
        username: "root",
        password: undefined,
        database: undefined,
        ssl_mode: "verify_identity",
        ssl_ca_path: "/certs/ca.pem",
        ssl_pkcs12_path: "/certs/client.p12",
        ssl_pkcs12_password: "secret",
        ssl_tls_hostname: "db.internal",
      });
    });
  });

  it("VERIFY_CA 模式缺少 CA 路径时阻止保存", async () => {
    render(<ConnectionForm />);

    fireEvent.change(screen.getByRole("textbox", { name: "连接名称" }), {
      target: { value: "Invalid TLS" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "主机地址" }), {
      target: { value: "db.example.com" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "用户名" }), {
      target: { value: "root" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "使用 SSL / TLS" }));
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "SSL 模式" }));
    fireEvent.click(
      await screen.findByText("VERIFY_CA（自定义 CA PEM，不校验证书主机名）")
    );
    fireEvent.click(screen.getByRole("button", { name: /保存$/ }));

    expect(
      await screen.findByText(
        "VERIFY_CA / VERIFY_IDENTITY 模式下请填写 CA 证书路径"
      )
    ).toBeInTheDocument();
    expect(mockApi.saveConnection).not.toHaveBeenCalled();
  });

  it("开启 SSH 并填写隧道配置后保存时提交嵌套 SSH 对象", async () => {
    mockApi.saveConnection.mockResolvedValue(undefined);
    mockApi.listSavedConnections.mockResolvedValue([]);
    render(<ConnectionForm />);

    fireEvent.change(screen.getByRole("textbox", { name: "连接名称" }), {
      target: { value: "SSH MySQL" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "主机地址" }), {
      target: { value: "db.internal" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "用户名" }), {
      target: { value: "root" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "使用 SSH 隧道" }));
    fireEvent.change(screen.getByRole("textbox", { name: "SSH 服务器" }), {
      target: { value: "jump.example.com" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "SSH 端口" }), {
      target: { value: "2202" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "SSH 用户名" }), {
      target: { value: "deploy" },
    });
    fireEvent.change(screen.getByLabelText("SSH 密码"), {
      target: { value: "ssh-secret" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "SSH 私钥路径" }), {
      target: { value: "/keys/id_ed25519" },
    });
    fireEvent.click(screen.getByRole("button", { name: /保存$/ }));

    await waitFor(() => {
      expect(mockApi.saveConnection).toHaveBeenCalledWith({
        database_type: "mysql",
        name: "SSH MySQL",
        host: "db.internal",
        port: 3306,
        username: "root",
        password: undefined,
        database: undefined,
        ssh: {
          host: "jump.example.com",
          port: 2202,
          username: "deploy",
          password: "ssh-secret",
          private_key_path: "/keys/id_ed25519",
        },
      });
    });
  });

  it("编辑缺少 database_type 的旧连接时按 MySQL 显示", () => {
    useConnectionStore.setState({
      editingConnection: {
        id: "legacy",
        name: "Legacy",
        host: "localhost",
        port: 3306,
        username: "root",
      },
    });

    render(<ConnectionForm />);

    expect(screen.getByText("MySQL")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "端口" })).toHaveValue(
      "3306"
    );
  });

  it("新建连接可选择 PostgreSQL 并自动切换到 5432 端口", async () => {
    render(<ConnectionForm />);

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "数据库类型" }));
    fireEvent.click(await screen.findByText("PostgreSQL"));

    await waitFor(() => {
      expect(screen.getByRole("spinbutton", { name: "端口" })).toHaveValue(
        "5432"
      );
    });
  });

  it("新建连接可选择 SQL Server，自动切换到 1433 端口并保留服务端数据库字段", async () => {
    render(<ConnectionForm />);

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "数据库类型" }));
    fireEvent.click(await screen.findByText("SQL Server"));

    await waitFor(() => {
      expect(screen.getByRole("spinbutton", { name: "端口" })).toHaveValue(
        "1433"
      );
    });
    expect(
      screen.getByRole("textbox", { name: "主机地址" })
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "用户名" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "数据库" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "SQLite 文件" })).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: "使用 SSL / TLS" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "使用 SSH 隧道" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("高级：只读与安全"));
    expect(screen.getByLabelText("只读连接")).toBeInTheDocument();
    expect(screen.getByLabelText("高危 SQL")).toBeInTheDocument();
  });

  it("新建连接可选择 ClickHouse，自动切换到 8123 端口并保留服务端连接字段", async () => {
    render(<ConnectionForm />);

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "数据库类型" }));
    fireEvent.click(await screen.findByText("ClickHouse"));

    await waitFor(() => {
      expect(screen.getByRole("spinbutton", { name: "端口" })).toHaveValue(
        "8123"
      );
    });
    expect(
      screen.getByRole("textbox", { name: "主机地址" })
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "用户名" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "数据库" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "SQLite 文件" })).toBeNull();
    expect(
      screen.getByRole("checkbox", { name: "使用 SSL / TLS" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "使用 SSH 隧道" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText("高级：只读与安全"));
    expect(screen.getByLabelText("只读连接")).toBeInTheDocument();
    expect(screen.getByLabelText("高危 SQL")).toBeInTheDocument();
  });

  it("保存 SQL Server 连接时提交 sqlserver 类型和常规服务端配置", async () => {
    mockApi.saveConnection.mockResolvedValue(undefined);
    mockApi.listSavedConnections.mockResolvedValue([]);
    render(<ConnectionForm />);

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "数据库类型" }));
    fireEvent.click(await screen.findByText("SQL Server"));
    fireEvent.change(screen.getByRole("textbox", { name: "连接名称" }), {
      target: { value: "SQL Server Dev" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "主机地址" }), {
      target: { value: "sql.example.com" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "用户名" }), {
      target: { value: "sa" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "数据库" }), {
      target: { value: "appdb" },
    });
    fireEvent.click(screen.getByText("高级：只读与安全"));
    fireEvent.click(screen.getByLabelText("只读连接"));
    fireEvent.click(screen.getByRole("button", { name: /保存$/ }));

    await waitFor(() => {
      expect(mockApi.saveConnection).toHaveBeenCalledWith({
        database_type: "sqlserver",
        name: "SQL Server Dev",
        host: "sql.example.com",
        port: 1433,
        username: "sa",
        password: undefined,
        database: "appdb",
        read_only: true,
      });
    });
  });

  it("保存 ClickHouse 连接时提交 clickhouse 类型和常规服务端配置", async () => {
    mockApi.saveConnection.mockResolvedValue(undefined);
    mockApi.listSavedConnections.mockResolvedValue([]);
    render(<ConnectionForm />);

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "数据库类型" }));
    fireEvent.click(await screen.findByText("ClickHouse"));
    fireEvent.change(screen.getByRole("textbox", { name: "连接名称" }), {
      target: { value: "ClickHouse Dev" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "主机地址" }), {
      target: { value: "clickhouse.example.com" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "用户名" }), {
      target: { value: "default" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "数据库" }), {
      target: { value: "analytics" },
    });
    fireEvent.click(screen.getByText("高级：只读与安全"));
    fireEvent.click(screen.getByLabelText("只读连接"));
    fireEvent.click(screen.getByRole("button", { name: /保存$/ }));

    await waitFor(() => {
      expect(mockApi.saveConnection).toHaveBeenCalledWith({
        database_type: "clickhouse",
        name: "ClickHouse Dev",
        host: "clickhouse.example.com",
        port: 8123,
        username: "default",
        password: undefined,
        database: "analytics",
        read_only: true,
      });
    });
  });

  it("新建连接可选择 SQLite 并仅显示文件路径和安全设置", async () => {
    render(<ConnectionForm />);

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "数据库类型" }));
    fireEvent.click(await screen.findByText("SQLite"));

    expect(
      await screen.findByRole("textbox", { name: "SQLite 文件" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "端口" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "主机地址" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "用户名" })).toBeNull();
    expect(screen.getByLabelText("只读连接")).toBeInTheDocument();
    expect(screen.getByLabelText("高危 SQL")).toBeInTheDocument();
    expect(screen.queryByText(/SSL \/ TLS/)).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "使用 SSL / TLS" })
    ).toBeNull();
    expect(
      screen.queryByRole("checkbox", { name: "使用 SSH 隧道" })
    ).toBeNull();
  });

  it("保存 SQLite 连接时提交本地文件配置", async () => {
    mockApi.saveConnection.mockResolvedValue(undefined);
    mockApi.listSavedConnections.mockResolvedValue([]);
    render(<ConnectionForm />);

    fireEvent.mouseDown(screen.getByRole("combobox", { name: "数据库类型" }));
    fireEvent.click(await screen.findByText("SQLite"));
    fireEvent.change(screen.getByRole("textbox", { name: "连接名称" }), {
      target: { value: "Local SQLite" },
    });
    fireEvent.change(
      await screen.findByRole("textbox", { name: "SQLite 文件" }),
      {
        target: { value: " /tmp/app.db " },
      }
    );
    fireEvent.click(screen.getByLabelText("只读连接"));
    fireEvent.click(screen.getByRole("button", { name: /保存$/ }));

    await waitFor(() => {
      expect(mockApi.saveConnection).toHaveBeenCalledWith({
        database_type: "sqlite",
        name: "Local SQLite",
        host: "",
        port: 0,
        username: "",
        password: undefined,
        database: undefined,
        sqlite_path: "/tmp/app.db",
        read_only: true,
        skip_dangerous_sql_confirm: false,
      });
    });
  });

  it("连接表单操作按钮固定在独立底部区域，不放入滚动内容", () => {
    const { container } = render(<ConnectionForm />);

    const scrollArea = container.querySelector(".connection-form-scroll");
    const actions = container.querySelector(".connection-form-actions");
    const saveAndConnectButton = screen.getByRole("button", {
      name: /保存并连接/,
    });

    expect(scrollArea).toBeInTheDocument();
    expect(actions).toBeInTheDocument();
    expect(actions).toContainElement(saveAndConnectButton);
    expect(scrollArea).not.toContainElement(saveAndConnectButton);
  });
});
