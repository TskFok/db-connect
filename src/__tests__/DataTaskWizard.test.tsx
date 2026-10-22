import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import * as api from "../services/dataTasks";
import { useConnectionStore } from "../stores/connectionStore";
import { useDataTaskStore } from "../stores/dataTaskStore";
import type { ConnectionConfig } from "../types";
import { dataSnapshot } from "./dataTaskFixtures";
import { DataTaskWizard } from "../components/dataTasks/DataTaskWizard";
vi.mock("../services/tauriCommands", () => ({
  listCompareDatabases: vi.fn().mockResolvedValue(["main"]),
}));
vi.mock("../services/dataTasks", () => ({
  getDataTaskCapabilities: vi.fn(),
  startDataTaskPreview: vi.fn(),
  subscribeDataTasks: vi.fn().mockResolvedValue(() => {}),
  dataTaskErrorMessage: (error: unknown) => String(error),
}));
it("未取得后端能力前不能创建预览", () => {
  render(<DataTaskWizard kind="transfer" onStarted={() => {}} />);
  expect(screen.getByRole("button", { name: "预检并读取快照" })).toBeDisabled();
  expect(screen.getByText(/目标物理表必须已存在/)).toBeInTheDocument();
});

beforeEach(() => {
  vi.clearAllMocks();
  useConnectionStore.setState({ savedConnections: [] });
  useDataTaskStore.setState({
    tasks: {},
    selectedTaskId: null,
    busy: false,
    invalidatedTaskIds: [],
  });

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

async function selectOption(label: string, option: string) {
  fireEvent.mouseDown(screen.getByRole("combobox", { name: label }));
  const selected = await screen.findByRole("option", { name: option });
  await act(async () => {
    fireEvent.click(selected);
  });
}
it.each([
  { kind: "row_sync", mode: "merge" },
  { kind: "transfer", mode: "append" },
] as const)(
  "从 $kind 入口进入后主动选表，仅为选中的表启动快照",
  async ({ kind, mode }) => {
    useConnectionStore.setState({
      savedConnections: [
        { id: "a", name: "源 SQLite" },
        { id: "b", name: "目标 SQLite" },
      ] as ConnectionConfig[],
    });
    vi.mocked(api.getDataTaskCapabilities).mockResolvedValue({
      row_sync: true,
      transfer: true,
      supported_modes: [mode],
      blockers: [],
      source_tables: [
        { table: "users", columns: ["id", "name"] },
        { table: "orders", columns: ["id"] },
      ],
      target_tables: [
        { table: "users", columns: ["id", "name"] },
        { table: "orders", columns: ["id"] },
      ],
    });
    vi.mocked(api.startDataTaskPreview).mockImplementation(
      async (taskId, request) => ({
        ...dataSnapshot,
        task_id: taskId,
        request,
        status: "reading",
        preview: null,
      })
    );
    render(
      <DataTaskWizard
        kind={kind}
        seed={{ source: { saved_connection_id: "a", database: "main" } }}
        onStarted={() => {}}
      />
    );
    await selectOption("目标端保存连接", "目标 SQLite");
    await selectOption("目标端数据库 / schema", "main");
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    const tablePicker = await screen.findByRole("combobox", {
      name: "选择源表",
    });
    expect(screen.getByRole("button", { name: "下一步" })).toBeDisabled();
    expect(screen.queryByDisplayValue("users")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("orders")).not.toBeInTheDocument();
    expect(api.startDataTaskPreview).not.toHaveBeenCalled();
    fireEvent.mouseDown(tablePicker);
    fireEvent.click(
      await screen.findByText("users", {
        selector: ".ant-select-item-option-content",
      })
    );
    await waitFor(() =>
      expect(screen.getAllByDisplayValue("id")).toHaveLength(2)
    );
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    fireEvent.click(screen.getByRole("button", { name: "预检并读取快照" }));
    await waitFor(() => expect(api.startDataTaskPreview).toHaveBeenCalled());
    const request = vi.mocked(api.startDataTaskPreview).mock.calls[0]![1];
    expect(request.kind).toBe(kind);
    expect(request.mode).toBe(mode);
    expect(request.mappings).toEqual([
      {
        source_table: "users",
        target_table: "users",
        columns: [
          { source_column: "id", target_column: "id" },
          { source_column: "name", target_column: "name" },
        ],
      },
    ]);
  }
);
