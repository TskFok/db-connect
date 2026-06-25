import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ForeignKeyInfo, AddForeignKeyRequest, RoutineInfo, EventInfo } from "../types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import * as api from "../services/tauriCommands";

describe("tauriCommands 外键与例程/事件", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("listForeignKeys", async () => {
    const mock: ForeignKeyInfo[] = [
      {
        constraint_name: "fk1",
        direction: "outgoing",
        table_schema: "d",
        table_name: "c",
        column_names: ["p"],
        referenced_table_schema: "d",
        referenced_table_name: "p",
        referenced_column_names: ["id"],
        update_rule: "CASCADE",
        delete_rule: "RESTRICT",
      },
    ];
    vi.mocked(invoke).mockResolvedValue(mock);
    const r = await api.listForeignKeys("cid", "d", "c");
    expect(invoke).toHaveBeenCalledWith("list_foreign_keys", {
      connId: "cid",
      database: "d",
      table: "c",
    });
    expect(r[0].constraint_name).toBe("fk1");
  });

  it("addForeignKey", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    const req: AddForeignKeyRequest = {
      constraint_name: "fk",
      columns: ["a"],
      referenced_table: "b",
      referenced_columns: ["id"],
      on_update: "RESTRICT",
      on_delete: "RESTRICT",
    };
    await api.addForeignKey("cid", "d", "t", req);
    expect(invoke).toHaveBeenCalledWith("add_foreign_key", {
      connId: "cid",
      database: "d",
      table: "t",
      request: req,
    });
  });

  it("listRoutines", async () => {
    const rows: RoutineInfo[] = [
      {
        name: "p1",
        routine_type: "PROCEDURE",
        data_type: null,
        definer: "root@%",
        security_type: "DEFINER",
        routine_comment: "",
        created: null,
        last_altered: null,
      },
    ];
    vi.mocked(invoke).mockResolvedValue(rows);
    const r = await api.listRoutines("cid", "d", "PROCEDURE");
    expect(invoke).toHaveBeenCalledWith("list_routines", {
      connId: "cid",
      database: "d",
      routineType: "PROCEDURE",
    });
    expect(r[0].name).toBe("p1");
  });

  it("getRoutineDefinition 透传 PostgreSQL identity arguments", async () => {
    vi.mocked(invoke).mockResolvedValue("CREATE FUNCTION p1() RETURNS int" as never);
    await api.getRoutineDefinition("cid", "d", "p1", "FUNCTION", "a integer");
    expect(invoke).toHaveBeenCalledWith("get_routine_definition", {
      connId: "cid",
      database: "d",
      routineName: "p1",
      routineType: "FUNCTION",
      identityArguments: "a integer",
    });
  });

  it("dropRoutine 透传 PostgreSQL identity arguments", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await api.dropRoutine("cid", "d", "p1", "FUNCTION", "a integer");
    expect(invoke).toHaveBeenCalledWith("drop_routine", {
      connId: "cid",
      database: "d",
      routineName: "p1",
      routineType: "FUNCTION",
      identityArguments: "a integer",
    });
  });

  it("listEvents", async () => {
    const ev: EventInfo[] = [
      {
        name: "ev1",
        definer: "root@%",
        time_zone: "SYSTEM",
        event_type: "RECURRING",
        execute_at: null,
        interval_value: "1",
        interval_field: "DAY",
        starts: null,
        ends: null,
        status: "ENABLED",
        originator: "1",
        character_set_client: "utf8mb4",
        collation_connection: "utf8mb4_uca1400_ai_ci",
        database_collation: "utf8mb4_uca1400_ai_ci",
      },
    ];
    vi.mocked(invoke).mockResolvedValue(ev);
    const r = await api.listEvents("cid", "d");
    expect(invoke).toHaveBeenCalledWith("list_events", { connId: "cid", database: "d" });
    expect(r[0].name).toBe("ev1");
  });

  it("setEventEnabled", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await api.setEventEnabled("cid", "d", "ev1", false);
    expect(invoke).toHaveBeenCalledWith("set_event_enabled", {
      connId: "cid",
      database: "d",
      eventName: "ev1",
      enabled: false,
    });
  });
});
