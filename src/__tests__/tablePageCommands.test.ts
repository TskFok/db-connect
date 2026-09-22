import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { queryTableData } from "../services/tauriCommands";

describe("表浏览分页命令", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("无导航时发送空 navigation，保持 OFFSET 请求", async () => {
    await queryTableData("conn", "db", "users", 8, 50, undefined);
    expect(invoke).toHaveBeenCalledWith(
      "query_table_data",
      expect.objectContaining({ page: 8, navigation: null })
    );
  });

  it("不解析游标，原样透传导航并返回后端分页信息", async () => {
    const navigation = {
      direction: "previous" as const,
      cursor: "opaque-cursor",
    };
    const result = {
      columns: ["id"],
      rows: [["9007199254740993"]],
      total: 100,
      execution_time_ms: 1,
      pagination: {
        mode: "keyset",
        sort_column: "id",
        sort_order: "ASC",
        previous_cursor: "before",
        next_cursor: "after",
      },
      executed_sql:
        'SELECT * FROM "db"."users" WHERE "id" < 9007199254740994 ORDER BY "id" DESC LIMIT 50',
    };
    vi.mocked(invoke).mockResolvedValue(result);
    const received = await queryTableData(
      "conn",
      "db",
      "users",
      1,
      50,
      undefined,
      undefined,
      undefined,
      true,
      navigation
    );
    expect(invoke).toHaveBeenCalledWith(
      "query_table_data",
      expect.objectContaining({ navigation })
    );
    expect(received).toBe(result);
  });
});
