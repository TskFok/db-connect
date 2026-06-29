import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ConnectionForm } from "../components/connection/ConnectionForm";
import { useConnectionStore } from "../stores/connectionStore";
import * as api from "../services/tauriCommands";

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

describe("ConnectionForm database type defaults", () => {
  beforeEach(() => {
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
    expect(screen.getByRole("textbox", { name: "主机地址" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "用户名" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "数据库" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "SQLite 文件" })).toBeNull();
    expect(screen.getByText("SSL / TLS（SQL Server）")).toBeInTheDocument();
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
    expect(screen.queryByText("SSH 隧道")).toBeNull();
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
