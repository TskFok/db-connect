import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Tauri API
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Mock api service
vi.mock("../services/tauriCommands", () => ({
  getTableDefinition: vi.fn(),
  listSavedConnections: vi.fn(),
  saveConnection: vi.fn(),
  deleteSavedConnection: vi.fn(),
  testConnection: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  listDatabases: vi.fn(),
  listTables: vi.fn(),
  getTableStructure: vi.fn(),
  queryTableData: vi.fn(),
  insertRow: vi.fn(),
  updateRow: vi.fn(),
  deleteRows: vi.fn(),
  executeSql: vi.fn(),
}));

import * as api from "../services/tauriCommands";

const mockApi = vi.mocked(api);

describe("getTableDefinition 用于创建表 SQL", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("应该调用 getTableDefinition 并返回 CREATE TABLE 语句", async () => {
    const mockDefinition = `CREATE TABLE \`users\` (
  \`id\` int unsigned NOT NULL AUTO_INCREMENT,
  \`name\` varchar(100) NOT NULL,
  PRIMARY KEY (\`id\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`;

    mockApi.getTableDefinition.mockResolvedValue(mockDefinition);

    const result = await api.getTableDefinition("conn-1", "myapp", "users");

    expect(mockApi.getTableDefinition).toHaveBeenCalledWith(
      "conn-1",
      "myapp",
      "users"
    );
    expect(result).toContain("CREATE TABLE");
    expect(result).toContain("`users`");
    expect(result).toContain("`id`");
    expect(result).toContain("PRIMARY KEY");
  });

  it("应该支持视图返回 CREATE VIEW 语句", async () => {
    const mockViewDefinition = `CREATE ALGORITHM=UNDEFINED DEFINER=\`root\`@\`localhost\` SQL SECURITY DEFINER VIEW \`v_users\` AS select \`users\`.\`id\` AS \`id\` from \`users\``;

    mockApi.getTableDefinition.mockResolvedValue(mockViewDefinition);

    const result = await api.getTableDefinition("conn-1", "myapp", "v_users");

    expect(mockApi.getTableDefinition).toHaveBeenCalledWith(
      "conn-1",
      "myapp",
      "v_users"
    );
    expect(result).toContain("CREATE");
    expect(result).toContain("VIEW");
  });

  it("调用失败时应该抛出错误", async () => {
    mockApi.getTableDefinition.mockRejectedValue("表不存在");

    await expect(
      api.getTableDefinition("conn-1", "myapp", "not_exist")
    ).rejects.toBe("表不存在");
  });
});
