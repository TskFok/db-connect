import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DataTaskPanel } from "../components/dataTasks/DataTaskPanel";
import { useDataTaskStore } from "../stores/dataTaskStore";
import { dataSnapshot } from "./dataTaskFixtures";
vi.mock("../services/dataTasks", () => ({
  subscribeDataTasks: vi.fn().mockResolvedValue(() => {}),
  listDataTasks: vi.fn().mockResolvedValue([]),
  getDataTaskDiff: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
}));
it("关闭重开保留任务，提交中不会展示已取消", async () => {
  useDataTaskStore.setState({
    tasks: { t: { ...dataSnapshot, status: "committing", preview: null } },
    selectedTaskId: "t",
  });
  const view = render(
    <DataTaskPanel open kind="row_sync" onClose={() => {}} />
  );
  expect(await screen.findByText("正在确认提交结果")).toBeInTheDocument();
  view.rerender(
    <DataTaskPanel open={false} kind="row_sync" onClose={() => {}} />
  );
  view.rerender(<DataTaskPanel open kind="row_sync" onClose={() => {}} />);
  expect(await screen.findByText("正在确认提交结果")).toBeInTheDocument();
});

it("过期预览禁止执行，零变化合并允许明确确认", () => {
  const preview = {
    ...dataSnapshot.preview!,
    mode: "merge" as const,
    risks: [],
    expires_at: "1",
  };
  useDataTaskStore.setState({
    tasks: { t: { ...dataSnapshot, preview } },
    selectedTaskId: "t",
  });
  const view = render(
    <DataTaskPanel open kind="row_sync" onClose={() => {}} />
  );
  expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
  expect(screen.getByText(/预览已过期/)).toBeInTheDocument();
  view.unmount();
  useDataTaskStore.setState({
    tasks: {
      t: {
        ...dataSnapshot,
        preview: {
          ...preview,
          expires_at: "9999999999999",
          tables: preview.tables.map((table) => ({
            ...table,
            counts: {
              ...table.counts,
              inserted: "0",
              updated: "0",
              deleted: "0",
            },
          })),
        },
      },
    },
    selectedTaskId: "t",
  });
  render(<DataTaskPanel open kind="row_sync" onClose={() => {}} />);
  expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled();
});

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});
