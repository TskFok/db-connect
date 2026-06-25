import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TriggerInfo, CreateTriggerRequest } from "../types";

// Mock Tauri API
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// Mock api service
vi.mock("../services/tauriCommands", () => ({
  listTriggers: vi.fn(),
  getTriggerDefinition: vi.fn(),
  createTrigger: vi.fn(),
  dropTrigger: vi.fn(),
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
  listIndexes: vi.fn(),
  createIndex: vi.fn(),
  deleteIndex: vi.fn(),
}));

import * as api from "../services/tauriCommands";

const mockApi = vi.mocked(api);

describe("触发器管理 API 调用", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("listTriggers", () => {
    it("应该调用 listTriggers 并返回触发器列表", async () => {
      const mockTriggers: TriggerInfo[] = [
        {
          name: "trg_before_insert",
          event: "INSERT",
          timing: "BEFORE",
          table_name: "users",
          statement: "SET NEW.created_at = NOW()",
          created: "2026-01-01 00:00:00",
          sql_mode: "STRICT_TRANS_TABLES",
          definer: "root@localhost",
        },
        {
          name: "trg_after_update",
          event: "UPDATE",
          timing: "AFTER",
          table_name: "users",
          statement:
            "INSERT INTO audit_log (action, record_id) VALUES ('UPDATE', OLD.id)",
          created: "2026-01-15 10:30:00",
          sql_mode: "STRICT_TRANS_TABLES",
          definer: "admin@%",
        },
      ];

      mockApi.listTriggers.mockResolvedValue(mockTriggers);

      const result = await api.listTriggers("conn-1", "mydb", "users");

      expect(mockApi.listTriggers).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users"
      );
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("trg_before_insert");
      expect(result[0].timing).toBe("BEFORE");
      expect(result[0].event).toBe("INSERT");
      expect(result[1].timing).toBe("AFTER");
      expect(result[1].event).toBe("UPDATE");
    });

    it("应该支持不传表名获取所有触发器", async () => {
      mockApi.listTriggers.mockResolvedValue([]);

      const result = await api.listTriggers("conn-1", "mydb");

      expect(mockApi.listTriggers).toHaveBeenCalledWith("conn-1", "mydb");
      expect(result).toHaveLength(0);
    });

    it("调用失败时应该抛出错误", async () => {
      mockApi.listTriggers.mockRejectedValue("查询触发器列表失败");

      await expect(
        api.listTriggers("conn-1", "mydb", "users")
      ).rejects.toBe("查询触发器列表失败");
    });
  });

  describe("getTriggerDefinition", () => {
    it("应该获取触发器的完整定义", async () => {
      const mockDefinition =
        "CREATE TRIGGER `trg_before_insert` BEFORE INSERT ON `users` FOR EACH ROW SET NEW.created_at = NOW()";

      mockApi.getTriggerDefinition.mockResolvedValue(mockDefinition);

      const result = await api.getTriggerDefinition(
        "conn-1",
        "mydb",
        "trg_before_insert"
      );

      expect(mockApi.getTriggerDefinition).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "trg_before_insert"
      );
      expect(result).toContain("CREATE TRIGGER");
      expect(result).toContain("BEFORE INSERT");
    });

    it("获取不存在的触发器应该抛出错误", async () => {
      mockApi.getTriggerDefinition.mockRejectedValue(
        "触发器 'trg_not_exist' 不存在"
      );

      await expect(
        api.getTriggerDefinition("conn-1", "mydb", "trg_not_exist")
      ).rejects.toBe("触发器 'trg_not_exist' 不存在");
    });
  });

  describe("createTrigger", () => {
    it("应该调用 createTrigger 创建简单触发器", async () => {
      mockApi.createTrigger.mockResolvedValue(undefined);

      const request: CreateTriggerRequest = {
        name: "trg_before_insert",
        timing: "BEFORE",
        event: "INSERT",
        body: "SET NEW.created_at = NOW()",
      };

      await api.createTrigger("conn-1", "mydb", "users", request);

      expect(mockApi.createTrigger).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        request
      );
    });

    it("应该调用 createTrigger 创建包含 BEGIN/END 的触发器", async () => {
      mockApi.createTrigger.mockResolvedValue(undefined);

      const request: CreateTriggerRequest = {
        name: "trg_after_update_audit",
        timing: "AFTER",
        event: "UPDATE",
        body: "BEGIN\n  INSERT INTO audit_log (table_name, action, record_id, changed_at)\n  VALUES ('users', 'UPDATE', OLD.id, NOW());\nEND",
      };

      await api.createTrigger("conn-1", "mydb", "users", request);

      expect(mockApi.createTrigger).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        expect.objectContaining({
          timing: "AFTER",
          event: "UPDATE",
          body: expect.stringContaining("BEGIN"),
        })
      );
    });

    it("应该调用 createTrigger 创建 DELETE 触发器", async () => {
      mockApi.createTrigger.mockResolvedValue(undefined);

      const request: CreateTriggerRequest = {
        name: "trg_before_delete",
        timing: "BEFORE",
        event: "DELETE",
        body: "BEGIN\n  INSERT INTO deleted_records SELECT * FROM users WHERE id = OLD.id;\nEND",
      };

      await api.createTrigger("conn-1", "mydb", "users", request);

      expect(mockApi.createTrigger).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "users",
        expect.objectContaining({
          event: "DELETE",
          timing: "BEFORE",
        })
      );
    });

    it("创建失败时应该抛出错误", async () => {
      mockApi.createTrigger.mockRejectedValue(
        "创建触发器失败: Trigger already exists"
      );

      const request: CreateTriggerRequest = {
        name: "trg_duplicate",
        timing: "BEFORE",
        event: "INSERT",
        body: "SET NEW.created_at = NOW()",
      };

      await expect(
        api.createTrigger("conn-1", "mydb", "users", request)
      ).rejects.toBe("创建触发器失败: Trigger already exists");
    });
  });

  describe("dropTrigger", () => {
    it("应该调用 dropTrigger 删除触发器", async () => {
      mockApi.dropTrigger.mockResolvedValue(undefined);

      await api.dropTrigger("conn-1", "mydb", "trg_before_insert");

      expect(mockApi.dropTrigger).toHaveBeenCalledWith(
        "conn-1",
        "mydb",
        "trg_before_insert"
      );
    });

    it("删除失败时应该抛出错误", async () => {
      mockApi.dropTrigger.mockRejectedValue("删除触发器失败");

      await expect(
        api.dropTrigger("conn-1", "mydb", "trg_not_exist")
      ).rejects.toBe("删除触发器失败");
    });
  });
});

describe("触发器类型定义", () => {
  it("TriggerInfo 应该包含所有必要字段", () => {
    const trigger: TriggerInfo = {
      name: "trg_test",
      event: "INSERT",
      timing: "BEFORE",
      table_name: "users",
      statement: "SET NEW.created_at = NOW()",
      created: "2026-01-01 00:00:00",
      sql_mode: "STRICT_TRANS_TABLES",
      definer: "root@localhost",
    };

    expect(trigger.name).toBe("trg_test");
    expect(trigger.event).toBe("INSERT");
    expect(trigger.timing).toBe("BEFORE");
    expect(trigger.table_name).toBe("users");
    expect(trigger.statement).toBe("SET NEW.created_at = NOW()");
    expect(trigger.created).toBe("2026-01-01 00:00:00");
    expect(trigger.sql_mode).toBe("STRICT_TRANS_TABLES");
    expect(trigger.definer).toBe("root@localhost");
  });

  it("TriggerInfo 应该支持 created 为 null", () => {
    const trigger: TriggerInfo = {
      name: "trg_test",
      event: "UPDATE",
      timing: "AFTER",
      table_name: "orders",
      statement: "SET NEW.updated_at = NOW()",
      created: null,
      sql_mode: "",
      definer: "admin@%",
    };

    expect(trigger.created).toBeNull();
    expect(trigger.sql_mode).toBe("");
  });

  it("CreateTriggerRequest 应该包含所有必要字段", () => {
    const request: CreateTriggerRequest = {
      name: "trg_before_insert",
      timing: "BEFORE",
      event: "INSERT",
      body: "SET NEW.created_at = NOW()",
    };

    expect(request.name).toBe("trg_before_insert");
    expect(request.timing).toBe("BEFORE");
    expect(request.event).toBe("INSERT");
    expect(request.body).toBe("SET NEW.created_at = NOW()");
  });

  it("CreateTriggerRequest 应该支持多行语句体", () => {
    const request: CreateTriggerRequest = {
      name: "trg_complex",
      timing: "AFTER",
      event: "DELETE",
      body: "BEGIN\n  INSERT INTO deleted_log (id, deleted_at)\n  VALUES (OLD.id, NOW());\n  UPDATE stats SET delete_count = delete_count + 1;\nEND",
    };

    expect(request.body).toContain("BEGIN");
    expect(request.body).toContain("END");
    expect(request.body).toContain("INSERT INTO deleted_log");
    expect(request.body).toContain("UPDATE stats");
  });

  it("应该支持所有有效的事件类型", () => {
    const events = ["INSERT", "UPDATE", "DELETE"];
    events.forEach((event) => {
      const trigger: TriggerInfo = {
        name: `trg_${event.toLowerCase()}`,
        event,
        timing: "BEFORE",
        table_name: "test",
        statement: "SELECT 1",
        created: null,
        sql_mode: "",
        definer: "root@localhost",
      };
      expect(trigger.event).toBe(event);
    });
  });

  it("应该支持所有有效的时机类型", () => {
    const timings = ["BEFORE", "AFTER"];
    timings.forEach((timing) => {
      const trigger: TriggerInfo = {
        name: `trg_${timing.toLowerCase()}`,
        event: "INSERT",
        timing,
        table_name: "test",
        statement: "SELECT 1",
        created: null,
        sql_mode: "",
        definer: "root@localhost",
      };
      expect(trigger.timing).toBe(timing);
    });
  });
});
