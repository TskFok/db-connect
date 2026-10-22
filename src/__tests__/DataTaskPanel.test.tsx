import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { DataTaskPanel } from "../components/dataTasks/DataTaskPanel";
import { useDataTaskStore } from "../stores/dataTaskStore";
import * as api from "../services/dataTasks";
import { useConnectionStore } from "../stores/connectionStore";
import type { DataTaskRequest } from "../types/dataTasks";
import { dataTaskModeLabels } from "../utils/dataTaskCapabilities";
import type { ConnectionConfig } from "../types";
import { dataSnapshot } from "./dataTaskFixtures";
vi.mock("../services/tauriCommands", () => ({
  listCompareDatabases: vi.fn().mockResolvedValue(["src", "dest"]),
}));
vi.mock("../services/dataTasks", () => ({
  dataTaskErrorMessage: (error: unknown) => String(error),
  getDataTaskCapabilities: vi.fn().mockResolvedValue({
    row_sync: true,
    transfer: true,
    supported_modes: ["merge", "mirror", "append", "replace"],
    blockers: [],
    source_tables: [{ table: "users", columns: ["id"] }],
    target_tables: [{ table: "users", columns: ["id"] }],
  }),
  discardDataTaskPreview: vi.fn().mockResolvedValue(undefined),
  executeDataTask: vi.fn(),
  cancelDataTask: vi.fn(),
  getDataTask: vi.fn(),
  startDataTaskPreview: vi.fn(),
  subscribeDataTasks: vi.fn().mockResolvedValue(() => {}),
  listDataTasks: vi.fn().mockResolvedValue([]),
  getDataTaskDiff: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
}));
it("关闭重开保留任务，提交中不会展示已取消", async () => {
  useDataTaskStore.setState({
    tasks: { t: { ...dataSnapshot, status: "committing", preview: null } },
    selectedTaskId: "t",
  });
  const view = await renderPanel(
    <DataTaskPanel open kind="row_sync" onClose={() => {}} />
  );
  expect(await screen.findByText("正在确认提交结果")).toBeInTheDocument();
  await act(async () =>
    view.rerender(
      <DataTaskPanel open={false} kind="row_sync" onClose={() => {}} />
    )
  );
  await act(async () =>
    view.rerender(<DataTaskPanel open kind="row_sync" onClose={() => {}} />)
  );
  expect(await screen.findByText("正在确认提交结果")).toBeInTheDocument();
});

it("过期预览禁止执行，零变化合并允许明确确认", async () => {
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
  const view = await renderPanel(
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
  await renderPanel(<DataTaskPanel open kind="row_sync" onClose={() => {}} />);
  expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listDataTasks).mockResolvedValue([]);
  useDataTaskStore.setState({
    tasks: {},
    selectedTaskId: null,
    busy: false,
    invalidatedTaskIds: [],
  });
  useConnectionStore.setState({
    savedConnections: [
      { id: "a", name: "源连接" },
      { id: "b", name: "目标连接" },
    ] as ConnectionConfig[],
  });
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

it("传输执行前能复核模式与自定义字段映射", async () => {
  const task = {
    ...dataSnapshot,
    request: {
      ...dataSnapshot.request,
      kind: "transfer" as const,
      mode: "replace" as const,
      mappings: [
        {
          source_table: "users",
          target_table: "people",
          columns: [{ source_column: "name", target_column: "display_name" }],
        },
      ],
    },
    preview: {
      ...dataSnapshot.preview!,
      kind: "transfer" as const,
      mode: "replace" as const,
      tables: dataSnapshot.preview!.tables.map((table) => ({
        ...table,
        target_table: "people",
      })),
    },
  };
  useDataTaskStore.setState({ tasks: { t: task }, selectedTaskId: "t" });
  await renderPanel(<DataTaskPanel open kind="transfer" onClose={() => {}} />);
  expect(
    await screen.findByText("替换（事务内删除后写入）")
  ).toBeInTheDocument();
  expect(screen.getByText("name → display_name")).toBeInTheDocument();
});

it.each(["merge", "mirror", "append", "replace"] as const)(
  "%s 重新预览保留端点、自定义映射和模式",
  async (mode) => {
    const request: DataTaskRequest = {
      ...dataSnapshot.request,
      kind: ["merge", "mirror"].includes(mode) ? "row_sync" : "transfer",
      mode,
      mappings: [
        {
          source_table: "users",
          target_table: "people",
          columns: [{ source_column: "id", target_column: "user_id" }],
        },
      ],
    };
    useDataTaskStore.setState({
      tasks: {
        t: {
          ...dataSnapshot,
          request,
          preview: { ...dataSnapshot.preview!, mode, kind: request.kind },
        },
      },
      selectedTaskId: "t",
    });
    vi.mocked(api.startDataTaskPreview).mockImplementation(
      async (taskId, nextRequest) => ({
        ...dataSnapshot,
        task_id: taskId,
        request: nextRequest,
        status: "reading",
        preview: null,
      })
    );
    const view = await renderPanel(
      <DataTaskPanel open kind={request.kind} onClose={() => {}} />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "修改配置 / 重新预览" })
    );
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "源端保存连接" })
      ).toBeInTheDocument()
    );
    await act(async () =>
      view.rerender(
        <DataTaskPanel open={false} kind={request.kind} onClose={() => {}} />
      )
    );
    await act(async () =>
      view.rerender(
        <DataTaskPanel open kind={request.kind} onClose={() => {}} />
      )
    );
    expect(screen.getByText("源连接")).toBeInTheDocument();
    expect(screen.getByText("目标连接")).toBeInTheDocument();
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("dest")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    await waitFor(() =>
      expect(screen.getByDisplayValue("people")).toBeInTheDocument()
    );
    expect(screen.getByDisplayValue("user_id")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(screen.getByText(dataTaskModeLabels[mode])).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "预检并读取快照" })
      ).toBeEnabled()
    );
    fireEvent.click(screen.getByRole("button", { name: "预检并读取快照" }));
    await waitFor(() => expect(api.startDataTaskPreview).toHaveBeenCalled());
    expect(vi.mocked(api.startDataTaskPreview).mock.calls[0]![1]).toEqual(
      request
    );
  }
);

it("逐项确认风险后仅发送计划身份，连续点击只执行一次", async () => {
  useDataTaskStore.setState({
    tasks: { t: dataSnapshot },
    selectedTaskId: "t",
  });
  let finish!: (value: typeof dataSnapshot) => void;
  vi.mocked(api.executeDataTask).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  await renderPanel(<DataTaskPanel open kind="row_sync" onClose={() => {}} />);
  const execute = screen.getByRole("button", { name: "确认执行" });
  expect(execute).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/删除目标数据/));
  expect(execute).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/确认目标范围/));
  expect(execute).toBeDisabled();
  fireEvent.click(screen.getByLabelText(/空源将清空/));
  expect(execute).toBeEnabled();
  fireEvent.click(execute);
  fireEvent.click(execute);
  await waitFor(() => expect(api.executeDataTask).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.executeDataTask).mock.calls[0]![0]).toEqual({
    plan_id: "p",
    fingerprint: "f",
    execution_id: expect.any(String),
    accepted_risk_ids: ["delete"],
  });
  await act(async () =>
    finish({ ...dataSnapshot, sequence: "2", status: "executing" })
  );
  expect(screen.getByRole("button", { name: /取消任务/ })).toBeEnabled();
});

it("取消请求确认后等待后端终态，期间不能再次取消", async () => {
  const running = {
    ...dataSnapshot,
    status: "executing" as const,
    preview: null,
  };
  useDataTaskStore.setState({ tasks: { t: running }, selectedTaskId: "t" });
  vi.mocked(api.cancelDataTask).mockResolvedValue({
    ...running,
    sequence: "2",
    status: "cancelling",
  });
  await renderPanel(<DataTaskPanel open kind="row_sync" onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /取消任务/ }));
  await screen.findByText("正在取消，等待回滚");
  expect(screen.getByRole("button", { name: /取消任务/ })).toBeDisabled();
  expect(screen.queryByText("已取消")).not.toBeInTheDocument();
  act(() =>
    useDataTaskStore.getState().applySnapshot({
      ...running,
      sequence: "3",
      status: "cancelled",
      result: {
        status: "cancelled",
        commit_state: "rolled_back",
        tables: [],
        error: null,
        cleanup_errors: [],
        requires_target_refresh: false,
      },
    })
  );
  expect(screen.getAllByText("已取消").length).toBeGreaterThan(0);
  expect(screen.getByText(/目标业务表数据已回滚/)).toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: /取消任务/ })
  ).not.toBeInTheDocument();
});

it("执行响应丢失后查询后端结果，手动重新查询也不会重放写入", async () => {
  const task = {
    ...dataSnapshot,
    preview: { ...dataSnapshot.preview!, mode: "merge" as const, risks: [] },
  };
  useDataTaskStore.setState({ tasks: { t: task }, selectedTaskId: "t" });
  vi.mocked(api.executeDataTask).mockRejectedValue(new Error("执行响应丢失"));
  const unknown = {
    ...task,
    sequence: "2",
    status: "outcome_unknown" as const,
    result: {
      status: "outcome_unknown" as const,
      commit_state: "unknown" as const,
      tables: [],
      error: { code: "connection_lost", message: "提交连接断开" },
      cleanup_errors: [],
      requires_target_refresh: true,
    },
  };
  vi.mocked(api.getDataTask).mockResolvedValue(unknown);
  await renderPanel(<DataTaskPanel open kind="row_sync" onClose={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
  await screen.findByText(/不要直接重复执行/);
  expect(screen.getByText("提交连接断开")).toBeInTheDocument();
  expect(api.getDataTask).toHaveBeenCalledWith("t");
  expect(api.executeDataTask).toHaveBeenCalledTimes(1);
  vi.mocked(api.listDataTasks).mockResolvedValue([unknown]);
  fireEvent.click(screen.getByRole("button", { name: "重新查询任务" }));
  await waitFor(() =>
    expect(screen.queryByText("Error: 执行响应丢失")).not.toBeInTheDocument()
  );
  expect(api.executeDataTask).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("button", { name: "确认执行" })
  ).not.toBeInTheDocument();
});

async function renderPanel(element: Parameters<typeof render>[0]) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(element);
  });
  return view;
}

it("关闭恢复草稿后改从传输入口打开，使用新入口的类型、模式和种子", async () => {
  const view = await restoreSyncDraft();
  await act(async () =>
    view.rerender(
      <DataTaskPanel open={false} kind="row_sync" onClose={() => {}} />
    )
  );
  await act(async () =>
    view.rerender(
      <DataTaskPanel
        open
        kind="transfer"
        seed={{
          source: { saved_connection_id: "a", database: "src" },
          tables: ["users"],
        }}
        onClose={() => {}}
      />
    )
  );
  expect(screen.getByRole("dialog", { name: "数据传输" })).toBeInTheDocument();
  expect(screen.queryByText("dest")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
  await selectPanelOption("目标端保存连接", "目标连接");
  await selectPanelOption("目标端数据库 / schema", "dest");
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  await waitFor(() =>
    expect(screen.getAllByDisplayValue("users")).toHaveLength(2)
  );
  expect(screen.queryByDisplayValue("user_id")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  expect(screen.getByText("追加（唯一冲突时失败）")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "预检并读取快照" }));
  await waitFor(() => expect(api.startDataTaskPreview).toHaveBeenCalled());
  expect(vi.mocked(api.startDataTaskPreview).mock.calls[0]![1]).toMatchObject({
    kind: "transfer",
    mode: "append",
    source: { saved_connection_id: "a", database: "src" },
  });
});

it("关闭恢复草稿后同类型新种子覆盖旧源端和映射，后台任务保留", async () => {
  const view = await restoreSyncDraft();
  const background = {
    ...dataSnapshot,
    task_id: "background",
    status: "executing" as const,
    preview: null,
  };
  act(() => useDataTaskStore.getState().applySnapshot(background));
  await act(async () =>
    view.rerender(
      <DataTaskPanel open={false} kind="row_sync" onClose={() => {}} />
    )
  );
  await act(async () =>
    view.rerender(
      <DataTaskPanel
        open
        kind="row_sync"
        seed={{
          source: { saved_connection_id: "b", database: "dest" },
          tables: ["users"],
        }}
        onClose={() => {}}
      />
    )
  );
  expect(screen.getByText("目标连接")).toBeInTheDocument();
  expect(screen.queryByText("源连接")).not.toBeInTheDocument();
  expect(screen.queryByText("src")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
  await selectPanelOption("目标端保存连接", "源连接");
  await selectPanelOption("目标端数据库 / schema", "src");
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  await waitFor(() =>
    expect(screen.getAllByDisplayValue("users")).toHaveLength(2)
  );
  expect(screen.queryByDisplayValue("people")).not.toBeInTheDocument();
  expect(screen.queryByDisplayValue("user_id")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "下一步" }));
  expect(screen.getByText("合并（保留目标独有行）")).toBeInTheDocument();
  expect(useDataTaskStore.getState().tasks.background).toEqual(background);
  expect(api.cancelDataTask).not.toHaveBeenCalled();
});

async function selectPanelOption(label: string, option: string) {
  fireEvent.mouseDown(screen.getByRole("combobox", { name: label }));
  const selected = await screen.findByRole("option", { name: option });
  await act(async () => {
    fireEvent.click(selected);
  });
}

async function restoreSyncDraft() {
  const request = {
    ...dataSnapshot.request,
    mappings: [
      {
        source_table: "users",
        target_table: "people",
        columns: [{ source_column: "id", target_column: "user_id" }],
      },
    ],
  };
  useDataTaskStore.setState({
    tasks: { t: { ...dataSnapshot, request } },
    selectedTaskId: "t",
  });
  vi.mocked(api.startDataTaskPreview).mockImplementation(
    async (taskId, nextRequest) => ({
      ...dataSnapshot,
      task_id: taskId,
      request: nextRequest,
      status: "reading",
      preview: null,
    })
  );
  const view = await renderPanel(
    <DataTaskPanel open kind="row_sync" onClose={() => {}} />
  );
  fireEvent.click(screen.getByRole("button", { name: "修改配置 / 重新预览" }));
  await screen.findByRole("combobox", { name: "源端保存连接" });
  return view;
}
