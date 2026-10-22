import { beforeEach, expect, it, vi } from "vitest";
import { useDataTaskStore } from "../stores/dataTaskStore";
import type { DataTaskSnapshot } from "../types/dataTasks";
vi.mock("../services/dataTasks", () => ({
  subscribeDataTasks: vi.fn(),
  listDataTasks: vi.fn().mockResolvedValue([]),
  startDataTaskPreview: vi.fn(),
  executeDataTask: vi.fn(),
  getDataTask: vi.fn(),
  discardDataTaskPreview: vi.fn().mockResolvedValue(undefined),
  cancelDataTask: vi.fn(),
}));
beforeEach(() =>
  useDataTaskStore.setState({ tasks: {}, selectedTaskId: null })
);
it("丢弃重复和乱序事件，不用 JS Number 比较 sequence", () => {
  const a = {
    task_id: "t",
    sequence: "9007199254740993",
    status: "succeeded",
    result: null,
  } as DataTaskSnapshot;
  useDataTaskStore.getState().applySnapshot(a);
  useDataTaskStore
    .getState()
    .applySnapshot({ ...a, sequence: "9007199254740992", status: "reading" });
  expect(useDataTaskStore.getState().tasks.t.status).toBe("succeeded");
});

it("首次预览先完成订阅再启动，重复启动被锁定", async () => {
  const api = await import("../services/dataTasks");
  const order: string[] = [];
  let release!: () => void;
  vi.mocked(api.subscribeDataTasks).mockImplementationOnce(async () => {
    order.push("subscribe");
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return () => {};
  });
  vi.mocked(api.startDataTaskPreview).mockImplementation(async () => {
    order.push("start");
    return {
      task_id: "started",
      sequence: "1",
      status: "reading",
      result: null,
    } as DataTaskSnapshot;
  });
  const { dataSnapshot } = await import("./dataTaskFixtures");
  const first = useDataTaskStore.getState().startPreview(dataSnapshot.request);
  await expect(
    useDataTaskStore.getState().startPreview(dataSnapshot.request)
  ).rejects.toThrow("正在启动");
  expect(order).toEqual(["subscribe"]);
  release();
  await first;
  expect(order).toEqual(["subscribe", "start"]);
});

it("保存连接改变后立即禁止执行旧预览", async () => {
  const { dataSnapshot } = await import("./dataTaskFixtures");
  const { useConnectionStore } = await import("../stores/connectionStore");
  const config = {
    id: "a",
    name: "source",
  } as import("../types").ConnectionConfig;
  useConnectionStore.setState({ savedConnections: [config] });
  useDataTaskStore.getState().applySnapshot(dataSnapshot);
  useConnectionStore.setState({
    savedConnections: [{ ...config, name: "edited" }],
  });
  await expect(
    useDataTaskStore.getState().execute("t", ["delete"])
  ).rejects.toThrow("保存连接已变更");
});
