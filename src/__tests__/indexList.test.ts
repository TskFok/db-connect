import { describe, it, expect, vi, beforeEach } from "vitest";
import type { IndexInfo, CreateIndexRequest, CreateIndexColumn, IndexColumnInfo } from "../types";

// Mock Tauri API
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Mock api service
vi.mock("../services/tauriCommands", () => ({
  listIndexes: vi.fn(),
  createIndex: vi.fn(),
  deleteIndex: vi.fn(),
  // 其他必需的 mock
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

describe("索引管理 API 调用", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listIndexes", () => {
    it("应该调用 listIndexes 并返回索引列表", async () => {
      const mockIndexes: IndexInfo[] = [
        {
          name: "PRIMARY",
          unique: true,
          index_type: "BTREE",
          columns: [
            {
              column_name: "id",
              seq_in_index: 1,
              collation: "A",
              sub_part: null,
            },
          ],
          is_primary: true,
          comment: "",
        },
        {
          name: "idx_email",
          unique: true,
          index_type: "BTREE",
          columns: [
            {
              column_name: "email",
              seq_in_index: 1,
              collation: "A",
              sub_part: null,
            },
          ],
          is_primary: false,
          comment: "邮箱唯一索引",
        },
        {
          name: "idx_name_age",
          unique: false,
          index_type: "BTREE",
          columns: [
            {
              column_name: "name",
              seq_in_index: 1,
              collation: "A",
              sub_part: 20,
            },
            {
              column_name: "age",
              seq_in_index: 2,
              collation: "A",
              sub_part: null,
            },
          ],
          is_primary: false,
          comment: "",
        },
      ];

      mockApi.listIndexes.mockResolvedValue(mockIndexes);

      const result = await api.listIndexes("conn-1", "mydb", "users");

      expect(mockApi.listIndexes).toHaveBeenCalledWith("conn-1", "mydb", "users");
      expect(result).toHaveLength(3);
      expect(result[0].is_primary).toBe(true);
      expect(result[1].unique).toBe(true);
      expect(result[2].columns).toHaveLength(2);
    });

    it("调用失败时应该抛出错误", async () => {
      mockApi.listIndexes.mockRejectedValue("查询索引失败");

      await expect(
        api.listIndexes("conn-1", "mydb", "users")
      ).rejects.toBe("查询索引失败");
    });
  });

  describe("createIndex", () => {
    it("应该调用 createIndex 创建普通索引", async () => {
      mockApi.createIndex.mockResolvedValue(undefined);

      const request: CreateIndexRequest = {
        index_name: "idx_name",
        index_type: "INDEX",
        columns: [{ column_name: "name" }],
      };

      await api.createIndex("conn-1", "mydb", "users", request);

      expect(mockApi.createIndex).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        request
      );
    });

    it("应该调用 createIndex 创建唯一索引", async () => {
      mockApi.createIndex.mockResolvedValue(undefined);

      const request: CreateIndexRequest = {
        index_name: "idx_email_unique",
        index_type: "UNIQUE",
        index_method: "BTREE",
        columns: [{ column_name: "email" }],
        comment: "邮箱唯一索引",
      };

      await api.createIndex("conn-1", "mydb", "users", request);

      expect(mockApi.createIndex).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        expect.objectContaining({
          index_type: "UNIQUE",
          index_method: "BTREE",
          comment: "邮箱唯一索引",
        })
      );
    });

    it("应该调用 createIndex 创建复合索引", async () => {
      mockApi.createIndex.mockResolvedValue(undefined);

      const request: CreateIndexRequest = {
        index_name: "idx_name_age",
        index_type: "INDEX",
        columns: [
          { column_name: "name", length: 20 },
          { column_name: "age", order: "DESC" },
        ],
      };

      await api.createIndex("conn-1", "mydb", "users", request);

      expect(mockApi.createIndex).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        expect.objectContaining({
          columns: expect.arrayContaining([
            expect.objectContaining({ column_name: "name", length: 20 }),
            expect.objectContaining({ column_name: "age", order: "DESC" }),
          ]),
        })
      );
    });

    it("创建失败时应该抛出错误", async () => {
      mockApi.createIndex.mockRejectedValue("创建索引失败: Duplicate key name");

      const request: CreateIndexRequest = {
        index_name: "idx_dup",
        index_type: "INDEX",
        columns: [{ column_name: "name" }],
      };

      await expect(
        api.createIndex("conn-1", "mydb", "users", request)
      ).rejects.toBe("创建索引失败: Duplicate key name");
    });
  });

  describe("deleteIndex", () => {
    it("应该调用 deleteIndex 删除普通索引", async () => {
      mockApi.deleteIndex.mockResolvedValue(undefined);

      await api.deleteIndex("conn-1", "mydb", "users", "idx_name");

      expect(mockApi.deleteIndex).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        "idx_name"
      );
    });

    it("应该调用 deleteIndex 删除主键", async () => {
      mockApi.deleteIndex.mockResolvedValue(undefined);

      await api.deleteIndex("conn-1", "mydb", "users", "PRIMARY");

      expect(mockApi.deleteIndex).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        "PRIMARY"
      );
    });

    it("删除失败时应该抛出错误", async () => {
      mockApi.deleteIndex.mockRejectedValue("删除索引失败");

      await expect(
        api.deleteIndex("conn-1", "mydb", "users", "idx_not_exist")
      ).rejects.toBe("删除索引失败");
    });
  });
});

describe("索引类型定义", () => {
  it("IndexInfo 应该包含所有必要字段", () => {
    const index: IndexInfo = {
      name: "idx_test",
      unique: false,
      index_type: "BTREE",
      columns: [],
      is_primary: false,
      comment: "",
    };

    expect(index.name).toBe("idx_test");
    expect(index.unique).toBe(false);
    expect(index.index_type).toBe("BTREE");
    expect(index.columns).toEqual([]);
    expect(index.is_primary).toBe(false);
    expect(index.comment).toBe("");
  });

  it("IndexColumnInfo 应该正确定义", () => {
    const col: IndexColumnInfo = {
      column_name: "email",
      seq_in_index: 1,
      collation: "A",
      sub_part: 50,
    };

    expect(col.column_name).toBe("email");
    expect(col.seq_in_index).toBe(1);
    expect(col.collation).toBe("A");
    expect(col.sub_part).toBe(50);
  });

  it("CreateIndexRequest 应该支持可选字段", () => {
    // 最小请求
    const minRequest: CreateIndexRequest = {
      index_name: "idx_min",
      index_type: "INDEX",
      columns: [{ column_name: "col1" }],
    };

    expect(minRequest.index_method).toBeUndefined();
    expect(minRequest.comment).toBeUndefined();

    // 完整请求
    const fullRequest: CreateIndexRequest = {
      index_name: "idx_full",
      index_type: "UNIQUE",
      index_method: "BTREE",
      columns: [
        { column_name: "col1", length: 10, order: "ASC" },
        { column_name: "col2" },
      ],
      comment: "测试索引",
    };

    expect(fullRequest.index_method).toBe("BTREE");
    expect(fullRequest.comment).toBe("测试索引");
    expect(fullRequest.columns).toHaveLength(2);
  });

  it("CreateIndexColumn 应该支持可选字段", () => {
    const minCol: CreateIndexColumn = {
      column_name: "col1",
    };

    expect(minCol.length).toBeUndefined();
    expect(minCol.order).toBeUndefined();

    const fullCol: CreateIndexColumn = {
      column_name: "col2",
      length: 20,
      order: "DESC",
    };

    expect(fullCol.length).toBe(20);
    expect(fullCol.order).toBe("DESC");
  });
});
