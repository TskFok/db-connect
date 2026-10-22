import { create } from "zustand";
import * as api from "../services/dataTasks";
import { useConnectionStore } from "./connectionStore";
import { useTableDataStore } from "./tableDataStore";
import {
  isNewerDataTaskSequence,
  isDataTaskTerminal,
} from "../utils/dataTaskProgress";
import type { DataTaskRequest, DataTaskSnapshot } from "../types/dataTasks";

interface DataTaskState {
  tasks: Record<string, DataTaskSnapshot>;
  selectedTaskId: string | null;
  busy: boolean;
  invalidatedTaskIds: string[];
  applySnapshot: (snapshot: DataTaskSnapshot) => void;
  connect: () => Promise<void>;
  refresh: () => Promise<void>;
  startPreview: (request: DataTaskRequest) => Promise<string>;
  execute: (taskId: string, acceptedRiskIds: string[]) => Promise<void>;
  cancel: (taskId: string) => Promise<void>;
  discard: (taskId: string) => Promise<void>;
}
let listener: Promise<unknown> | null = null;
const executions = new Set<string>();
const executionIds = new Map<string, string>();
const configReferences = new Map<string, string>();
function taskConfigIdentity(request: DataTaskRequest): string {
  return JSON.stringify(
    useConnectionStore
      .getState()
      .savedConnections.filter((config) =>
        [
          request.source.saved_connection_id,
          request.target.saved_connection_id,
        ].includes(config.id ?? "")
      )
  );
}
export const useDataTaskStore = create<DataTaskState>((set, get) => ({
  tasks: {},
  selectedTaskId: null,
  busy: false,
  invalidatedTaskIds: [],
  applySnapshot: (snapshot) => {
    const previous = get().tasks[snapshot.task_id];
    if (
      previous &&
      (!isNewerDataTaskSequence(snapshot.sequence, previous.sequence) ||
        (isDataTaskTerminal(previous.status) &&
          !isDataTaskTerminal(snapshot.status)))
    )
      return;
    if (!previous && snapshot.request)
      configReferences.set(
        snapshot.task_id,
        taskConfigIdentity(snapshot.request)
      );
    set((s) => ({ tasks: { ...s.tasks, [snapshot.task_id]: snapshot } }));
    if (
      snapshot.result &&
      ["committed", "partial", "unknown"].includes(snapshot.result.commit_state)
    ) {
      for (const connection of Object.values(
        useConnectionStore.getState().activeConnections
      )) {
        if (
          connection.config.id !== snapshot.request.target.saved_connection_id
        )
          continue;
        for (const mapping of snapshot.request.mappings)
          useTableDataStore
            .getState()
            .markTableDataStale(
              connection.connId,
              snapshot.request.target.database,
              mapping.target_table
            );
      }
    }
  },
  connect: async () => {
    if (!listener)
      listener = api
        .subscribeDataTasks((snapshot) => get().applySnapshot(snapshot))
        .catch((error) => {
          listener = null;
          throw error;
        });
    await listener;
  },
  refresh: async () => {
    await get().connect();
    for (const snapshot of await api.listDataTasks())
      get().applySnapshot(snapshot);
  },
  startPreview: async (request) => {
    if (get().busy) throw new Error("正在启动任务，请稍候");
    set({ busy: true });
    const taskId = crypto.randomUUID();
    try {
      await get().connect();
      set({ selectedTaskId: taskId });
      get().applySnapshot(await api.startDataTaskPreview(taskId, request));
      return taskId;
    } finally {
      set({ busy: false });
    }
  },
  execute: async (taskId, acceptedRiskIds) => {
    const task = get().tasks[taskId];
    if (get().invalidatedTaskIds.includes(taskId))
      throw new Error("保存连接已变更，旧预览已作废，请重新预览");
    if (!task?.preview || task.status !== "ready" || executions.has(taskId))
      return;
    if (BigInt(task.preview.expires_at) <= BigInt(Date.now()))
      throw new Error("预览已过期，请重新预览");
    if (!task.preview.can_execute || task.preview.blockers.length)
      throw new Error("请先解决预检阻塞项");
    if (
      task.preview.risks.some(
        (risk) => risk.required && !acceptedRiskIds.includes(risk.id)
      )
    )
      throw new Error("请确认全部必需风险项");
    executions.add(taskId);
    if (!executionIds.has(taskId))
      executionIds.set(taskId, crypto.randomUUID());
    try {
      await get().connect();
      get().applySnapshot(
        await api.executeDataTask({
          plan_id: task.preview.plan_id,
          fingerprint: task.preview.fingerprint,
          execution_id: executionIds.get(taskId)!,
          accepted_risk_ids: acceptedRiskIds,
        })
      );
    } catch (error) {
      // 命令响应丢失后只查询状态，不自动重发写入。
      try {
        get().applySnapshot(await api.getDataTask(taskId));
      } catch {
        /* 保留当前状态供手动对账 */
      }
      throw error;
    } finally {
      executions.delete(taskId);
    }
  },
  cancel: async (taskId) => {
    get().applySnapshot(await api.cancelDataTask(taskId));
  },
  discard: async (taskId) => {
    const task = get().tasks[taskId];
    if (!task || isDataTaskTerminal(task.status)) return;
    if (task.status === "ready" && task.preview)
      await api.discardDataTaskPreview(task.preview.plan_id);
    else if (
      ["created", "validating", "reading", "comparing"].includes(task.status)
    )
      await get().cancel(taskId);
    else return;
    if (get().selectedTaskId === taskId) set({ selectedTaskId: null });
  },
}));

// 面板关闭后也保护计划身份；前端提示即时作废，后端仍再次校验指纹。
useConnectionStore.subscribe((state, previous) => {
  if (state.savedConnections === previous.savedConnections) return;
  const store = useDataTaskStore.getState();
  const invalidated = Object.values(store.tasks)
    .filter(
      (task) =>
        task.request &&
        !isDataTaskTerminal(task.status) &&
        configReferences.get(task.task_id) !== taskConfigIdentity(task.request)
    )
    .map((task) => task.task_id);
  if (invalidated.length)
    useDataTaskStore.setState({
      invalidatedTaskIds: [
        ...new Set([...store.invalidatedTaskIds, ...invalidated]),
      ],
    });
});
