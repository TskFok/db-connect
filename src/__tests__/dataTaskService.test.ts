import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { getDataTaskDiff } from "../services/dataTasks";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it("差异分页限制为 200 且不将计数转为 Number", async () => {
  vi.mocked(invoke).mockResolvedValue({
    plan_id: "p",
    table_id: "t",
    items: [],
    next_cursor: null,
  });
  await getDataTaskDiff("p", "t", null, 10000);
  expect(invoke).toHaveBeenCalledWith("get_data_task_diff", {
    planId: "p",
    tableId: "t",
    cursor: null,
    pageSize: 200,
  });
});
