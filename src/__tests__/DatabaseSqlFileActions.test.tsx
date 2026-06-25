import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Modal } from "antd";
import type { ModalFuncProps } from "antd/es/modal/interface";
import { DatabaseSqlFileActions } from "../components/database/DatabaseSqlFileActions";
import { emptyConnState, useDatabaseStore } from "../stores/databaseStore";
import { useConnectionStore } from "../stores/connectionStore";
import * as api from "../services/tauriCommands";
import type { ActiveConnection, SqlExecuteResult } from "../types";

vi.mock("../services/tauriCommands", () => ({
  listDatabases: vi.fn(),
  listTables: vi.fn(),
  getTableStructure: vi.fn(),
  getDatabaseInfo: vi.fn(),
  executeSql: vi.fn(),
  importSqlFile: vi.fn(),
  alterDatabaseCharset: vi.fn(),
  createDatabase: vi.fn(),
  dropDatabase: vi.fn(),
  renameDatabase: vi.fn(),
  renameTable: vi.fn(),
  alterTableEngine: vi.fn(),
  alterColumn: vi.fn(),
  addColumn: vi.fn(),
  dropColumn: vi.fn(),
  createTable: vi.fn(),
  dropTable: vi.fn(),
  truncateTable: vi.fn(),
  getPrimaryKeys: vi.fn(),
  listSavedConnections: vi.fn(),
  saveConnection: vi.fn(),
  deleteSavedConnection: vi.fn(),
  testConnection: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(vi.fn())),
}));

const mockApi = vi.mocked(api);

import { open } from "@tauri-apps/plugin-dialog";

const notReadonlySelect: SqlExecuteResult = {
  result_type: "select",
  columns: ["ro", "sro"],
  rows: [[0, 0]],
  affected_rows: null,
  message: "",
  execution_time_ms: 0,
};

const mockActiveConnection: ActiveConnection = {
  connId: "conn-1",
  config: {
    id: "conn-1",
    database_type: "mysql",
    name: "MySQL 测试",
    host: "localhost",
    port: 3306,
    username: "root",
  },
};

function setupStoreWithDb(database: string) {
  useDatabaseStore.getState().reset();
  useDatabaseStore.setState({
    activeConnId: "conn-1",
    connectionStates: {
      "conn-1": {
        ...emptyConnState(),
        selectedDatabase: database,
      },
    },
  });
  useDatabaseStore.getState().switchToConnection("conn-1");
}

describe("DatabaseSqlFileActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Modal, "confirm").mockImplementation((opts: ModalFuncProps) => {
      void Promise.resolve().then(() => opts.onOk?.());
      return { destroy: vi.fn(), update: vi.fn() };
    });
    setupStoreWithDb("mydb");
    useConnectionStore.setState({
      activeConnections: { "conn-1": mockActiveConnection },
      activeConnId: "conn-1",
      activeConnection: mockActiveConnection,
    });
    mockApi.executeSql.mockResolvedValue(notReadonlySelect);
    mockApi.importSqlFile.mockResolvedValue({
      statements_total: 2,
      statements_ok: 1,
      statements_failed: 1,
      failures: [{ statement_index: 2, error: "syntax" }],
      elapsed_ms: 10,
    });
    mockApi.listTables.mockResolvedValue([]);
    mockApi.listDatabases.mockResolvedValue(["mydb"]);
    vi.mocked(open).mockResolvedValue("/tmp/fake.sql" as unknown as string);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("导入结束后（含部分失败）会刷新当前库表列表并刷新连接视图", async () => {
    const loadTablesSpy = vi.spyOn(useDatabaseStore.getState(), "loadTables");
    const refreshSpy = vi.spyOn(useDatabaseStore.getState(), "refresh");

    render(<DatabaseSqlFileActions connId="conn-1" database="mydb" />);

    const importBtn = screen.getAllByRole("button")[0];
    fireEvent.click(importBtn);

    await waitFor(() => {
      expect(mockApi.importSqlFile).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "/tmp/fake.sql"
      );
    });

    await waitFor(() => {
      expect(loadTablesSpy).toHaveBeenCalledWith("conn-1", "mydb");
      expect(refreshSpy).toHaveBeenCalledWith("conn-1");
    });
  });
});
