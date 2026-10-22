import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { DataTaskResult } from "../components/dataTasks/DataTaskResult";
import type { DataTaskResult as TaskResult } from "../types/dataTasks";

it.each([
  ["rolled_back", "目标业务表数据已回滚"],
  ["unknown", "不要直接重复执行"],
] as const)("%s 结果同时展示失败原因与提交语义", (commit_state, semantic) => {
  render(
    <DataTaskResult
      result={
        {
          status: "failed",
          commit_state,
          tables: [],
          error: {
            code: "verify_failed",
            message: "目标校验失败：字段 name 不一致",
          },
          cleanup_errors: [],
          requires_target_refresh: false,
        } satisfies TaskResult
      }
    />
  );
  expect(
    screen.getByText(/目标校验失败：字段 name 不一致/)
  ).toBeInTheDocument();
  expect(screen.getByText(new RegExp(semantic))).toBeInTheDocument();
});
