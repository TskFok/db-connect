import {
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import { Modal } from "antd";
import type { ModalFuncProps } from "antd/es/modal/interface";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionList } from "../components/connection/ConnectionList";
import { useConnectionStore } from "../stores/connectionStore";
import * as api from "../services/tauriCommands";
import { open, save } from "@tauri-apps/plugin-dialog";
import { getSortableGroupSectionStyle } from "../utils/connectionGroups";
import type { ConnectionConfig } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("../services/tauriCommands", () => ({
  listSavedConnections: vi.fn().mockResolvedValue([]),
  listConnectionGroups: vi.fn().mockResolvedValue([]),
  getDecryptedConnection: vi.fn(),
  saveConnection: vi.fn(),
  deleteSavedConnection: vi.fn(),
  reorderConnections: vi.fn(),
  createConnectionGroup: vi.fn(),
  renameConnectionGroup: vi.fn(),
  deleteConnectionGroup: vi.fn(),
  setConnectionGroupCollapsed: vi.fn(),
  reorderConnectionGroups: vi.fn(),
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

vi.mock("../stores/tableDataStore", () => ({
  useTableDataStore: {
    getState: () => ({ removeConnectionCache: vi.fn() }),
  },
}));

vi.mock("../stores/databaseStore", () => ({
  useDatabaseStore: {
    getState: () => ({
      connectionStates: {},
      switchToConnection: vi.fn(),
      removeConnectionState: vi.fn(),
    }),
  },
}));

describe("ConnectionList groups", () => {
  const connections = [
    {
      id: "conn-1",
      name: "Local",
      host: "localhost",
      port: 3306,
      username: "root",
    },
    {
      id: "conn-2",
      name: "Dev",
      host: "dev.mysql",
      port: 3306,
      username: "root",
      group_id: "group-1",
    },
  ];
  const groups = [{ id: "group-1", name: "开发库" }];

  beforeEach(() => {
    vi.mocked(api.listSavedConnections).mockResolvedValue(connections);
    vi.mocked(api.listConnectionGroups).mockResolvedValue(groups);
    useConnectionStore.setState({
      savedConnections: connections,
      connectionGroups: groups,
      activeConnections: {},
      activeConnId: null,
      activeConnection: null,
      loading: false,
      error: null,
      showConnectionForm: false,
      editingConnection: null,
    });
    vi.clearAllMocks();
    vi.mocked(api.listSavedConnections).mockResolvedValue(connections);
    vi.mocked(api.listConnectionGroups).mockResolvedValue(groups);
    vi.mocked(open).mockResolvedValue(null);
    vi.mocked(save).mockResolvedValue(null);
  });

  it("渲染未分组、自定义组和新建分组入口", () => {
    render(<ConnectionList />);

    expect(screen.getByText("未分组")).toBeInTheDocument();
    expect(screen.getByText("开发库")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建分组" })
    ).toBeInTheDocument();
  });

  it("标题栏图标按钮仅显示图标并保留可访问名称", () => {
    render(<ConnectionList />);

    expect(
      screen.getByRole("button", { name: "导入连接" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "导出连接" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建分组" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "新建连接" })
    ).toBeInTheDocument();
    expect(screen.getByTestId("import-connections")).toHaveTextContent("");
    expect(screen.getByTestId("export-connections")).toHaveTextContent("");
    expect(screen.getByTestId("create-connection-group")).toHaveTextContent("");
    expect(screen.getByTestId("create-connection")).toHaveTextContent("");
  });

  it("为当前支持的连接类型渲染数据库类型主图标并保留 SSH 辅助图标", () => {
    const typedConnections: ConnectionConfig[] = [
      {
        id: "mysql",
        name: "MySQL Dev",
        database_type: "mysql",
        host: "mysql.local",
        port: 3306,
        username: "root",
      },
      {
        id: "postgres",
        name: "PostgreSQL SSH",
        database_type: "postgres",
        host: "pg.local",
        port: 5432,
        username: "postgres",
        ssh: {
          host: "jump.local",
          port: 22,
          username: "deploy",
        },
      },
      {
        id: "sqlite",
        name: "SQLite Local",
        database_type: "sqlite",
        host: "",
        port: 0,
        username: "",
        sqlite_path: "/tmp/app.db",
      },
      {
        id: "sqlserver",
        name: "SQL Server Dev",
        database_type: "sqlserver",
        host: "mssql.local",
        port: 1433,
        username: "sa",
      },
      {
        id: "clickhouse",
        name: "ClickHouse Dev",
        database_type: "clickhouse",
        host: "click.local",
        port: 8123,
        username: "default",
      },
    ];
    vi.mocked(api.listSavedConnections).mockResolvedValue(typedConnections);
    useConnectionStore.setState({ savedConnections: typedConnections });

    render(<ConnectionList />);

    expect(screen.getByLabelText("数据库类型：MySQL")).toBeInTheDocument();
    expect(screen.getByLabelText("数据库类型：PostgreSQL")).toBeInTheDocument();
    expect(screen.getByLabelText("数据库类型：SQLite")).toBeInTheDocument();
    expect(screen.getByLabelText("数据库类型：SQL Server")).toBeInTheDocument();
    expect(screen.getByLabelText("数据库类型：ClickHouse")).toBeInTheDocument();
    expect(screen.getByText("PostgreSQL SSH")).toBeInTheDocument();
    expect(screen.getByLabelText("SSH 隧道：PostgreSQL SSH")).toBeInTheDocument();
    expect(screen.queryByText("pg.local:5432")).not.toBeInTheDocument();
    expect(screen.queryByText("SSH: jump.local:22")).not.toBeInTheDocument();
  });

  it("删除分组需要二次确认后才调用 store action", async () => {
    const deleteConnectionGroup = vi.fn().mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(Modal, "confirm").mockImplementation(() => {
      return {
        destroy: vi.fn(),
        update: vi.fn(),
      };
    });
    useConnectionStore.setState({ deleteConnectionGroup });

    render(<ConnectionList />);

    await screen.findByText("开发库");
    await act(async () => {
      fireEvent.click(screen.getByTestId("delete-group-group-1"));
    });

    expect(deleteConnectionGroup).not.toHaveBeenCalled();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const options = confirmSpy.mock.calls[0]?.[0] as ModalFuncProps | undefined;
    if (!options) {
      throw new Error("Modal.confirm should receive options");
    }
    expect(options.title).toBe("删除分组？");

    options.onCancel?.(() => undefined);
    expect(deleteConnectionGroup).not.toHaveBeenCalled();

    await act(async () => {
      await options.onOk?.(() => undefined);
    });

    await waitFor(() => {
      expect(deleteConnectionGroup).toHaveBeenCalledWith("group-1");
    });
  });

  it("分组拖动时当前项不缩放且不对 transform 做兜底过渡", () => {
    expect(
      getSortableGroupSectionStyle({
        transform: "translate3d(0px, 40px, 0)",
        transition: undefined,
        isDragging: true,
      })
    ).toMatchObject({
      transform: "translate3d(0px, 40px, 0)",
      transition: "opacity 120ms ease, box-shadow 120ms ease",
      opacity: 0.9,
      zIndex: 2,
      boxShadow: "0 8px 18px rgba(0, 0, 0, 0.16)",
    });

    expect(
      getSortableGroupSectionStyle({
        transform: "translate3d(0px, -36px, 0)",
        transition: "transform 200ms ease",
        isDragging: false,
      })
    ).toMatchObject({
      transform: "translate3d(0px, -36px, 0)",
      transition: "transform 200ms ease",
      opacity: 1,
    });
  });

  it("导出连接时密码确认不一致不打开保存对话框", async () => {
    render(<ConnectionList />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导出连接" }));
    });

    fireEvent.change(await screen.findByLabelText("导出密码"), {
      target: { value: "one-password" },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: "another-password" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导出" }));
    });

    expect(save).not.toHaveBeenCalled();
    expect(api.exportConnections).not.toHaveBeenCalled();
  });

  it("导出连接时输入一致密码后选择文件并调用导出", async () => {
    vi.mocked(save).mockResolvedValue("/tmp/db-connect-connections.json");
    vi.mocked(api.exportConnections).mockResolvedValue(2);

    render(<ConnectionList />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导出连接" }));
    });

    fireEvent.change(await screen.findByLabelText("导出密码"), {
      target: { value: "迁移密码" },
    });
    fireEvent.change(screen.getByLabelText("确认密码"), {
      target: { value: "迁移密码" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导出" }));
    });

    await waitFor(() => {
      expect(api.exportConnections).toHaveBeenCalledWith(
        "/tmp/db-connect-connections.json",
        "迁移密码"
      );
    });
  });

  it("导入连接时未输入密码不调用导入", async () => {
    vi.mocked(open).mockResolvedValue("/tmp/db-connect-connections.json");

    render(<ConnectionList />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导入连接" }));
    });

    await screen.findByLabelText("导入密码");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导入" }));
    });

    expect(api.importConnections).not.toHaveBeenCalled();
  });

  it("导入连接时输入密码后调用导入并刷新", async () => {
    vi.mocked(open).mockResolvedValue("/tmp/db-connect-connections.json");
    vi.mocked(api.importConnections).mockResolvedValue({
      imported_connections: 1,
      imported_groups: 1,
    });

    render(<ConnectionList />);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导入连接" }));
    });

    fireEvent.change(await screen.findByLabelText("导入密码"), {
      target: { value: "迁移密码" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "导入" }));
    });

    await waitFor(() => {
      expect(api.importConnections).toHaveBeenCalledWith(
        "/tmp/db-connect-connections.json",
        "迁移密码"
      );
    });
  });
});
