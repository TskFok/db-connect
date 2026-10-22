import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { availableDataTaskModes } from "../utils/dataTaskCapabilities";
import { dataSnapshot } from "./dataTaskFixtures";
it("同步和传输模式只能来自后端已验证能力", () => {
  expect(availableDataTaskModes(null, "row_sync")).toEqual([]);
  expect(
    availableDataTaskModes(
      {
        row_sync: false,
        transfer: true,
        supported_modes: ["append"],
        blockers: [],
        source_tables: [],
        target_tables: [],
      },
      "row_sync"
    )
  ).toEqual([]);
  expect(
    availableDataTaskModes(
      {
        row_sync: true,
        transfer: true,
        supported_modes: ["merge", "append"],
        blockers: [],
        source_tables: [],
        target_tables: [],
      },
      "transfer"
    )
  ).toEqual(["append"]);
});
it("任务统计与计时使用十进制字符串，前端未持久化行内容", () => {
  for (const key of [
    "sequence",
    "created_at",
    "updated_at",
    "read_rows",
    "written_rows",
    "verified_rows",
    "bytes",
    "elapsed_ms",
  ] as const)
    expect(dataSnapshot[key]).toMatch(/^\d+$/);
  const store = readFileSync("src/stores/dataTaskStore.ts", "utf8");
  expect(store).not.toContain("localStorage");
});
it("默认同名物理表和一对一同名字段映射，不猜测缺失目标", async () => {
  const { defaultDataTaskMappings } =
    await import("../utils/dataTaskCapabilities");
  expect(
    defaultDataTaskMappings({
      row_sync: true,
      transfer: true,
      supported_modes: ["append"],
      blockers: [],
      source_tables: [
        { table: "users", columns: ["id", "name", "old"] },
        { table: "missing", columns: ["id"] },
      ],
      target_tables: [{ table: "users", columns: ["id", "name", "generated"] }],
    })
  ).toEqual([
    {
      source_table: "users",
      target_table: "users",
      columns: [
        { source_column: "id", target_column: "id" },
        { source_column: "name", target_column: "name" },
      ],
    },
  ]);
});
