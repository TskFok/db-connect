import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  DataEndpoint,
  DataTaskCapabilities,
  DataTaskRequest,
  DataTaskSnapshot,
  DataDiffPage,
  ExecuteDataTaskInput,
} from "../types/dataTasks";
export const getDataTaskCapabilities = (
  source: DataEndpoint,
  target: DataEndpoint
) =>
  invoke<DataTaskCapabilities>("get_data_task_capabilities", {
    source,
    target,
  });
export const startDataTaskPreview = (
  taskId: string,
  request: DataTaskRequest
) => invoke<DataTaskSnapshot>("start_data_task_preview", { taskId, request });
export const getDataTask = (taskId: string) =>
  invoke<DataTaskSnapshot>("get_data_task", { taskId });
export const getDataTaskDiff = (
  planId: string,
  tableId: string,
  cursor: string | null = null,
  pageSize = 50
) =>
  invoke<DataDiffPage>("get_data_task_diff", {
    planId,
    tableId,
    cursor,
    pageSize: Math.max(1, Math.min(200, Math.floor(pageSize) || 50)),
  });
export const executeDataTask = (input: ExecuteDataTaskInput) =>
  invoke<DataTaskSnapshot>("execute_data_task", { input });
export const cancelDataTask = (taskId: string) =>
  invoke<DataTaskSnapshot>("cancel_data_task", { taskId });
export const listDataTasks = () =>
  invoke<DataTaskSnapshot[]>("list_data_tasks");
export const discardDataTaskPreview = (planId: string) =>
  invoke<void>("discard_data_task_preview", { planId });
export const subscribeDataTasks = (
  handler: (snapshot: DataTaskSnapshot) => void
) =>
  listen<DataTaskSnapshot>("data-task-progress", (event) =>
    handler(event.payload)
  );
export function dataTaskErrorMessage(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  )
    return error.message;
  return typeof error === "string" ? error : "数据任务请求失败，请重试";
}
