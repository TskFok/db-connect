import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Modal,
  Progress,
  Select,
  Space,
  Spin,
  Typography,
} from "antd";
import { useDataTaskStore } from "../../stores/dataTaskStore";
import { dataTaskErrorMessage, getDataTask } from "../../services/dataTasks";
import {
  describeDataTaskProgress,
  formatDataCount,
  isDataTaskTerminal,
  dataTaskPercent,
} from "../../utils/dataTaskProgress";
import type { DataTaskKind, DataTaskSeed } from "../../types/dataTasks";
import { DataTaskWizard } from "./DataTaskWizard";
import { DataSyncPreview } from "./DataSyncPreview";
import { requiredPreviewConfirmations } from "../../utils/dataTaskCapabilities";
import { DataTransferPreview } from "./DataTransferPreview";
import { DataTaskResult } from "./DataTaskResult";
export interface DataTaskPanelProps {
  open: boolean;
  onClose: () => void;
  kind: DataTaskKind;
  seed?: DataTaskSeed;
}
export function DataTaskPanel({
  open,
  onClose,
  kind,
  seed,
}: DataTaskPanelProps) {
  const tasks = useDataTaskStore((s) => s.tasks);
  const invalidatedIds = useDataTaskStore((s) => s.invalidatedTaskIds);
  const selectedId = useDataTaskStore((s) => s.selectedTaskId);
  const task = selectedId ? tasks[selectedId] : undefined;
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [wizardKey, setWizardKey] = useState(0);
  useEffect(() => {
    if (!open) return;
    void useDataTaskStore
      .getState()
      .refresh()
      .catch((e) => setError(dataTaskErrorMessage(e)));
    const timer = window.setInterval(() => {
      setNow(Date.now());
      const current = useDataTaskStore.getState();
      for (const active of Object.values(current.tasks)) {
        if (!isDataTaskTerminal(active.status))
          void getDataTask(active.task_id)
            .then((snapshot) => current.applySnapshot(snapshot))
            .catch((e) => setError(dataTaskErrorMessage(e)));
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [open]);
  useEffect(() => {
    setAccepted([]);
  }, [task?.preview?.plan_id]);
  const invalidate = useCallback(() => {
    const id = useDataTaskStore.getState().selectedTaskId;
    if (id)
      void useDataTaskStore
        .getState()
        .discard(id)
        .catch((e) => setError(dataTaskErrorMessage(e)));
    setAccepted([]);
  }, []);
  const act = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(dataTaskErrorMessage(e));
    } finally {
      setPending(false);
    }
  };
  const invalidated = !!selectedId && invalidatedIds.includes(selectedId);
  const expired =
    !!task?.preview && BigInt(task.preview.expires_at) <= BigInt(now);
  const running =
    !!task && !isDataTaskTerminal(task.status) && task.status !== "ready";
  const Preview =
    task?.request.kind === "transfer" ? DataTransferPreview : DataSyncPreview;
  return (
    <Modal
      open={open}
      title={kind === "row_sync" ? "数据同步" : "数据传输"}
      onCancel={onClose}
      width={1000}
      footer={<Button onClick={onClose}>关闭面板（任务继续运行）</Button>}
    >
      <Space direction="vertical" style={{ width: "100%" }}>
        {!!Object.keys(tasks).length && (
          <Space wrap>
            <Select
              aria-label="数据任务历史"
              placeholder="选择任务查看进度与结果"
              value={selectedId ?? undefined}
              style={{ minWidth: 420 }}
              options={Object.values(tasks)
                .sort((a, b) =>
                  BigInt(a.created_at) > BigInt(b.created_at) ? -1 : 1
                )
                .map((t) => ({
                  value: t.task_id,
                  label: `${t.request.target.database} · ${describeDataTaskProgress(t.status)} · ${t.task_id.slice(0, 8)}`,
                }))}
              onChange={(id) =>
                useDataTaskStore.setState({ selectedTaskId: id })
              }
            />
            <Button
              onClick={() =>
                void act(async () => {
                  if (selectedId)
                    await useDataTaskStore.getState().discard(selectedId);
                  useDataTaskStore.setState({ selectedTaskId: null });
                  setWizardKey((k) => k + 1);
                })
              }
            >
              新建任务
            </Button>
          </Space>
        )}
        {!task && (
          <DataTaskWizard
            key={`${kind}:${wizardKey}:${JSON.stringify(seed)}`}
            kind={kind}
            seed={seed}
            onInvalidate={invalidate}
            onStarted={(id) =>
              useDataTaskStore.setState({ selectedTaskId: id })
            }
          />
        )}
        {task && (
          <>
            <Typography.Text strong>
              {describeDataTaskProgress(task.status)}
            </Typography.Text>
            <Typography.Text>
              已读取 {formatDataCount(task.read_rows)} 行 · 已写入{" "}
              {formatDataCount(task.written_rows)} 行 · 已验证{" "}
              {formatDataCount(task.verified_rows)} 行 ·{" "}
              {formatDataCount(task.bytes)} 字节 ·{" "}
              {formatDataCount(task.elapsed_ms)} 毫秒
            </Typography.Text>
            {running && (
              <>
                {dataTaskPercent(task) === null ? (
                  <Spin size="small" />
                ) : (
                  <Progress percent={dataTaskPercent(task)!} status="active" />
                )}
                <Button
                  loading={pending || task.status === "cancelling"}
                  disabled={["committing", "cancelling"].includes(task.status)}
                  onClick={() =>
                    void act(() =>
                      useDataTaskStore.getState().cancel(task.task_id)
                    )
                  }
                >
                  取消任务
                </Button>
              </>
            )}
            {task.preview && task.status === "ready" && (
              <>
                <Preview
                  preview={task.preview}
                  accepted={accepted}
                  onAcceptedChange={setAccepted}
                />
                {invalidated && (
                  <Alert
                    type="warning"
                    message="保存连接已变更，旧预览已作废，请重新预览"
                  />
                )}
                {expired && (
                  <Alert
                    type="warning"
                    message="预览已过期，请新建任务重新预览"
                  />
                )}
                <Space>
                  <Button
                    onClick={() =>
                      void act(async () => {
                        await useDataTaskStore.getState().discard(task.task_id);
                        setWizardKey((k) => k + 1);
                      })
                    }
                  >
                    修改配置 / 重新预览
                  </Button>
                  <Button
                    type="primary"
                    danger={["mirror", "replace"].includes(task.preview.mode)}
                    loading={pending}
                    disabled={
                      expired ||
                      invalidated ||
                      !task.preview.can_execute ||
                      !!task.preview.blockers.length ||
                      requiredPreviewConfirmations(task.preview).some(
                        (id) => !accepted.includes(id)
                      )
                    }
                    onClick={() =>
                      void act(() =>
                        useDataTaskStore.getState().execute(
                          task.task_id,
                          accepted.filter((id) => !id.startsWith("ui:"))
                        )
                      )
                    }
                  >
                    确认执行
                  </Button>
                </Space>
              </>
            )}
            {task.result && <DataTaskResult result={task.result} />}
          </>
        )}
        {error && (
          <Alert
            type="error"
            showIcon
            message={error}
            action={
              <Button
                size="small"
                onClick={() =>
                  void act(() => useDataTaskStore.getState().refresh())
                }
              >
                重新查询任务
              </Button>
            }
          />
        )}
      </Space>
    </Modal>
  );
}
