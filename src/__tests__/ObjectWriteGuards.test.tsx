import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IndexList } from "../components/index/IndexList";
import { TriggerList } from "../components/trigger/TriggerList";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";
import * as api from "../services/tauriCommands";
import { isConnectionGloballyReadOnly } from "../utils/sqlFileIoUi";

vi.mock("../components/index/IndexEditor", () => ({
  IndexEditor: () => null,
}));

vi.mock("../components/trigger/TriggerEditor", () => ({
  TriggerEditor: () => null,
}));

vi.mock("../services/tauriCommands", () => ({
  listIndexes: vi.fn().mockResolvedValue([]),
  listTriggers: vi.fn().mockResolvedValue([]),
  deleteIndex: vi.fn(),
  dropTrigger: vi.fn(),
  getTriggerDefinition: vi.fn(),
}));

vi.mock("../utils/sqlFileIoUi", () => ({
  isConnectionGloballyReadOnly: vi.fn().mockResolvedValue(false),
}));

const sqlserverConnection = {
  connId: "mssql-1",
  config: {
    id: "mssql-profile",
    name: "SQL Server",
    host: "localhost",
    port: 1433,
    username: "sa",
    database_type: "sqlserver" as const,
  },
};

describe("对象写操作只读 guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listIndexes).mockResolvedValue([]);
    vi.mocked(api.listTriggers).mockResolvedValue([]);
    vi.mocked(isConnectionGloballyReadOnly).mockResolvedValue(true);

    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    useDatabaseStore.getState().reset();
    useConnectionStore.setState({
      activeConnections: { "mssql-1": sqlserverConnection },
      activeConnId: "mssql-1",
      activeConnection: sqlserverConnection,
    });
    useDatabaseStore.setState({
      activeConnId: "mssql-1",
      selectedDatabase: "dbo",
      selectedTable: "orders",
      tableStructure: [],
      tableContentActiveTab: "indexes",
    });
  });

  it("SQL Server 当前 database 只读时禁用新建索引", async () => {
    render(<IndexList />);

    await waitFor(() =>
      expect(isConnectionGloballyReadOnly).toHaveBeenCalledWith(
        "mssql-1",
        "dbo",
        "sqlserver"
      )
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /新建索引/ })).toBeDisabled()
    );
  });

  it("SQL Server 当前 database 只读时禁用新建触发器", async () => {
    useDatabaseStore.setState({ tableContentActiveTab: "triggers" });

    render(<TriggerList />);

    await waitFor(() =>
      expect(isConnectionGloballyReadOnly).toHaveBeenCalledWith(
        "mssql-1",
        "dbo",
        "sqlserver"
      )
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /新建触发器/ })).toBeDisabled()
    );
  });
});
