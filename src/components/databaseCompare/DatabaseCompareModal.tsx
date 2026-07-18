import { EyeOutlined, LoadingOutlined, SwapOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Form, Modal, Select, message } from "antd";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../../services/tauriCommands";
import { useConnectionStore } from "../../stores/connectionStore";
import type {
  DatabaseCompareResult,
  DatabaseSyncExecutionResult,
  DatabaseSyncPreview,
  DatabaseSyncProgress,
  DatabaseSyncRequest,
} from "../../types";
import { normalizeDatabaseType } from "../../utils/connectionConfig";
import { saveDatabaseCompareWorkbook } from "../../utils/databaseCompareExport";
import { normalizeSyncSelection } from "../../utils/databaseSync";
import { DatabaseCompareResults } from "./DatabaseCompareResults";
import { DatabaseSyncPreviewModal } from "./DatabaseSyncPreviewModal";
import "./DatabaseCompareModal.css";

export interface DatabaseCompareModalProps {
  open: boolean;
  onClose: () => void;
}

type LoadingSide = "source" | "target" | null;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "请求失败，请稍后重试";
}

function syncPlanIdentity(
  request: DatabaseSyncRequest,
  planFingerprint: string
): string {
  return JSON.stringify([request, planFingerprint]);
}

export function DatabaseCompareModal({
  open,
  onClose,
}: DatabaseCompareModalProps) {
  const savedConnections = useConnectionStore(
    (state) => state.savedConnections
  );
  const [sourceConnectionId, setSourceConnectionId] = useState<string>();
  const [targetConnectionId, setTargetConnectionId] = useState<string>();
  const [sourceDatabase, setSourceDatabase] = useState<string>();
  const [targetDatabase, setTargetDatabase] = useState<string>();
  const [sourceDatabases, setSourceDatabases] = useState<string[]>([]);
  const [targetDatabases, setTargetDatabases] = useState<string[]>([]);
  const [loadingSide, setLoadingSide] = useState<LoadingSide>(null);
  const [comparing, setComparing] = useState(false);
  const [comparePending, setComparePending] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [executionLocked, setExecutionLocked] = useState(false);
  const [result, setResult] = useState<DatabaseCompareResult | null>(null);
  const [selectedTableNames, setSelectedTableNames] = useState<string[]>([]);
  const [includeDrops, setIncludeDrops] = useState(false);
  const [syncPreview, setSyncPreview] = useState<DatabaseSyncPreview | null>(
    null
  );
  const [syncRequest, setSyncRequest] = useState<DatabaseSyncRequest | null>(
    null
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  const [executionResult, setExecutionResult] =
    useState<DatabaseSyncExecutionResult | null>(null);
  const [syncProgress, setSyncProgress] = useState<DatabaseSyncProgress | null>(
    null
  );
  const [loadErrors, setLoadErrors] = useState<
    Record<Exclude<LoadingSide, null>, string | null>
  >({ source: null, target: null });
  const [compareError, setCompareError] = useState<string | null>(null);

  const sourceLoadId = useRef(0);
  const targetLoadId = useRef(0);
  const compareId = useRef(0);
  const comparePendingRef = useRef(false);
  const activeCompareRequestId = useRef<number | null>(null);
  const exportId = useRef(0);
  const previewRequestId = useRef(0);
  const executionRequestId = useRef(0);
  const activeSyncPlanIdentity = useRef<string | null>(null);
  const syncProgressUnlistenRef = useRef<UnlistenFn | null>(null);
  const isMountedRef = useRef(true);
  const executingRef = useRef(false);
  const executionInFlightRef = useRef(false);

  const stopSyncProgressListener = useCallback(() => {
    const unlisten = syncProgressUnlistenRef.current;
    syncProgressUnlistenRef.current = null;
    unlisten?.();
  }, []);

  const clearSyncProgress = useCallback(() => {
    stopSyncProgressListener();
    setSyncProgress(null);
  }, [stopSyncProgressListener]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopSyncProgressListener();
    };
  }, [stopSyncProgressListener]);

  const clearSyncPreview = useCallback(() => {
    clearSyncProgress();
    previewRequestId.current += 1;
    executionRequestId.current += 1;
    activeSyncPlanIdentity.current = null;
    executingRef.current = false;
    setPreviewing(false);
    setExecuting(false);
    setSyncPreview(null);
    setSyncRequest(null);
    setExecutionResult(null);
    setPreviewOpen(false);
  }, [clearSyncProgress]);

  const resetSyncState = useCallback(() => {
    clearSyncPreview();
    setSelectedTableNames([]);
    setIncludeDrops(false);
  }, [clearSyncPreview]);

  const resetResult = useCallback(() => {
    compareId.current += 1;
    exportId.current += 1;
    setComparing(false);
    setExporting(false);
    setResult(null);
    setCompareError(null);
    resetSyncState();
  }, [resetSyncState]);

  const resetState = useCallback(() => {
    sourceLoadId.current += 1;
    targetLoadId.current += 1;
    compareId.current += 1;
    activeCompareRequestId.current = null;
    comparePendingRef.current = false;
    exportId.current += 1;
    setSourceConnectionId(undefined);
    setTargetConnectionId(undefined);
    setSourceDatabase(undefined);
    setTargetDatabase(undefined);
    setSourceDatabases([]);
    setTargetDatabases([]);
    setLoadingSide(null);
    setComparing(false);
    setComparePending(false);
    setExporting(false);
    setResult(null);
    setLoadErrors({ source: null, target: null });
    setCompareError(null);
    resetSyncState();
  }, [resetSyncState]);

  useEffect(() => {
    if (!open) resetState();
  }, [open, resetState]);

  const sourceConnection = useMemo(
    () =>
      savedConnections.find(
        (connection) => connection.id === sourceConnectionId
      ),
    [savedConnections, sourceConnectionId]
  );

  const targetConnectionOptions = useMemo(() => {
    if (!sourceConnectionId || !sourceConnection) return [];
    const sourceType = normalizeDatabaseType(sourceConnection.database_type);
    return savedConnections
      .filter(
        (connection) =>
          connection.id &&
          connection.id !== sourceConnectionId &&
          normalizeDatabaseType(connection.database_type) === sourceType
      )
      .map((connection) => ({
        label: connection.name,
        value: connection.id as string,
      }));
  }, [savedConnections, sourceConnection, sourceConnectionId]);

  const sourceConnectionOptions = useMemo(
    () =>
      savedConnections
        .filter((connection) => Boolean(connection.id))
        .map((connection) => ({
          label: connection.name,
          value: connection.id as string,
        })),
    [savedConnections]
  );

  const loadDatabases = useCallback(
    async (side: Exclude<LoadingSide, null>, connectionId: string) => {
      const requestRef = side === "source" ? sourceLoadId : targetLoadId;
      const requestId = ++requestRef.current;
      setLoadingSide(side);
      setLoadErrors((current) => ({ ...current, [side]: null }));
      try {
        const databases = await api.listCompareDatabases(connectionId);
        if (requestRef.current !== requestId) return;
        if (side === "source") setSourceDatabases(databases);
        else setTargetDatabases(databases);
      } catch (requestError) {
        if (requestRef.current !== requestId) return;
        if (side === "source") setSourceDatabases([]);
        else setTargetDatabases([]);
        setLoadErrors((current) => ({
          ...current,
          [side]: `加载${side === "source" ? "源端" : "目标端"}数据库/schema 失败：${errorMessage(requestError)}`,
        }));
      } finally {
        if (requestRef.current === requestId) setLoadingSide(null);
      }
    },
    []
  );

  const handleSourceConnectionChange = useCallback(
    (connectionId: string) => {
      sourceLoadId.current += 1;
      targetLoadId.current += 1;
      setSourceConnectionId(connectionId);
      setSourceDatabase(undefined);
      setSourceDatabases([]);
      setTargetConnectionId(undefined);
      setTargetDatabase(undefined);
      setTargetDatabases([]);
      setLoadErrors({ source: null, target: null });
      resetResult();
      void loadDatabases("source", connectionId);
    },
    [loadDatabases, resetResult]
  );

  const handleTargetConnectionChange = useCallback(
    (connectionId: string) => {
      targetLoadId.current += 1;
      setTargetConnectionId(connectionId);
      setTargetDatabase(undefined);
      setTargetDatabases([]);
      resetResult();
      void loadDatabases("target", connectionId);
    },
    [loadDatabases, resetResult]
  );

  const handleCompare = useCallback(async () => {
    if (
      !sourceConnectionId ||
      !sourceDatabase ||
      !targetConnectionId ||
      !targetDatabase ||
      executingRef.current ||
      comparePendingRef.current
    ) {
      return;
    }
    const requestId = ++compareId.current;
    resetSyncState();
    activeCompareRequestId.current = requestId;
    comparePendingRef.current = true;
    setComparePending(true);
    setComparing(true);
    setCompareError(null);
    setResult(null);
    try {
      const comparison = await api.compareDatabases(
        {
          saved_connection_id: sourceConnectionId,
          database: sourceDatabase,
        },
        {
          saved_connection_id: targetConnectionId,
          database: targetDatabase,
        }
      );
      if (compareId.current === requestId) setResult(comparison);
    } catch (compareError) {
      if (compareId.current === requestId) {
        setCompareError(`数据库对比失败：${errorMessage(compareError)}`);
      }
    } finally {
      if (activeCompareRequestId.current === requestId) {
        activeCompareRequestId.current = null;
        comparePendingRef.current = false;
        setComparePending(false);
      }
      if (compareId.current === requestId) setComparing(false);
    }
  }, [
    resetSyncState,
    sourceConnectionId,
    sourceDatabase,
    targetConnectionId,
    targetDatabase,
  ]);

  const handleExport = useCallback(async () => {
    if (!result) return;
    const requestId = ++exportId.current;
    setExporting(true);
    try {
      const saved = await saveDatabaseCompareWorkbook(result);
      if (exportId.current === requestId && saved) {
        message.success("数据库对比结果已导出");
      }
    } catch (exportError) {
      if (exportId.current === requestId) {
        message.error(`导出 Excel 失败：${errorMessage(exportError)}`);
      }
    } finally {
      if (exportId.current === requestId) setExporting(false);
    }
  }, [result]);

  const handleSwap = useCallback(() => {
    if (
      !sourceConnectionId ||
      !targetConnectionId ||
      loadingSide !== null ||
      loadErrors.source !== null ||
      loadErrors.target !== null ||
      comparePendingRef.current ||
      exporting ||
      previewing ||
      executingRef.current
    ) {
      return;
    }
    sourceLoadId.current += 1;
    targetLoadId.current += 1;
    setSourceConnectionId(targetConnectionId);
    setTargetConnectionId(sourceConnectionId);
    setSourceDatabase(targetDatabase);
    setTargetDatabase(sourceDatabase);
    setSourceDatabases(targetDatabases);
    setTargetDatabases(sourceDatabases);
    resetResult();
  }, [
    resetResult,
    exporting,
    loadErrors.source,
    loadErrors.target,
    loadingSide,
    previewing,
    sourceConnectionId,
    sourceDatabase,
    sourceDatabases,
    targetConnectionId,
    targetDatabase,
    targetDatabases,
  ]);

  const handleClose = useCallback(() => {
    if (executingRef.current) return;
    resetState();
    onClose();
  }, [onClose, resetState]);

  const validSelectedTableNames = useMemo(
    () =>
      result
        ? normalizeSyncSelection(
            selectedTableNames,
            result.tables,
            includeDrops
          )
        : [],
    [includeDrops, result, selectedTableNames]
  );

  const handleSelectionChange = useCallback(
    (tableNames: string[]) => {
      clearSyncPreview();
      setSelectedTableNames(tableNames);
    },
    [clearSyncPreview]
  );

  const handleIncludeDropsChange = useCallback(
    (checked: boolean) => {
      clearSyncPreview();
      setIncludeDrops(checked);
    },
    [clearSyncPreview]
  );

  const handlePreviewSync = useCallback(async () => {
    if (
      !result ||
      !sourceConnectionId ||
      !sourceDatabase ||
      !targetConnectionId ||
      !targetDatabase ||
      previewing ||
      executingRef.current
    ) {
      return;
    }
    const normalizedSelection = normalizeSyncSelection(
      selectedTableNames,
      result.tables,
      includeDrops
    );
    if (normalizedSelection.length === 0) {
      message.warning("请至少选择一张可同步的差异表");
      return;
    }
    if (normalizedSelection.length !== new Set(selectedTableNames).size) {
      setSelectedTableNames(normalizedSelection);
      message.warning("选择中包含不可同步的表，请重新确认");
      return;
    }

    const request: DatabaseSyncRequest = {
      source: {
        saved_connection_id: sourceConnectionId,
        database: sourceDatabase,
      },
      target: {
        saved_connection_id: targetConnectionId,
        database: targetDatabase,
      },
      selected_tables: normalizedSelection,
      include_drops: includeDrops,
    };
    const requestId = ++previewRequestId.current;
    executionRequestId.current += 1;
    activeSyncPlanIdentity.current = null;
    setSyncPreview(null);
    setSyncRequest(null);
    setExecutionResult(null);
    setPreviewOpen(false);
    setPreviewing(true);
    try {
      const preview = await api.previewDatabaseSync(request);
      if (previewRequestId.current === requestId) {
        setSyncRequest(request);
        setSyncPreview(preview);
        activeSyncPlanIdentity.current = syncPlanIdentity(
          request,
          preview.plan_fingerprint
        );
        setPreviewOpen(true);
        message.success("同步预览已生成；执行前仍需检查并确认 SQL");
      }
    } catch (previewError) {
      if (previewRequestId.current === requestId) {
        message.error(`生成同步预览失败：${errorMessage(previewError)}`);
      }
    } finally {
      if (previewRequestId.current === requestId) setPreviewing(false);
    }
  }, [
    includeDrops,
    previewing,
    result,
    selectedTableNames,
    sourceConnectionId,
    sourceDatabase,
    targetConnectionId,
    targetDatabase,
  ]);

  const handleExecuteSync = useCallback(async () => {
    if (!syncPreview || !syncRequest || executionInFlightRef.current) return;
    const planFingerprint = syncPreview.plan_fingerprint;
    const identity = syncPlanIdentity(syncRequest, planFingerprint);
    if (activeSyncPlanIdentity.current !== identity) return;

    const requestId = ++executionRequestId.current;
    executingRef.current = true;
    executionInFlightRef.current = true;
    setExecuting(true);
    setExecutionLocked(true);
    setExecutionResult(null);
    clearSyncProgress();
    const isCurrentExecution = () =>
      isMountedRef.current &&
      executionRequestId.current === requestId &&
      activeSyncPlanIdentity.current === identity;
    try {
      let unlisten: UnlistenFn | null = null;
      try {
        unlisten = await listen<DatabaseSyncProgress>(
          "database-sync-progress",
          (event) => {
            if (
              isMountedRef.current &&
              executionRequestId.current === requestId &&
              activeSyncPlanIdentity.current === identity &&
              event.payload.plan_fingerprint === planFingerprint
            ) {
              setSyncProgress(event.payload);
            }
          }
        );
      } catch {
        if (!isCurrentExecution()) return;
        setSyncProgress(null);
      }

      if (!isCurrentExecution()) {
        unlisten?.();
        return;
      }
      if (unlisten) syncProgressUnlistenRef.current = unlisten;

      const execution = await api.executeDatabaseSync({
        request: syncRequest,
        plan_fingerprint: planFingerprint,
      });
      if (!isCurrentExecution()) return;

      setExecutionResult(execution);
      setSelectedTableNames([]);
      setIncludeDrops(false);
      setSyncRequest(null);
      activeSyncPlanIdentity.current = null;
      if (execution.latest_compare_result) {
        setResult(execution.latest_compare_result);
      }
      if (execution.status === "succeeded") {
        message.success("数据库结构已同步");
      }
    } catch (executionError) {
      if (!isCurrentExecution()) return;
      activeSyncPlanIdentity.current = null;
      setSyncPreview(null);
      setSyncRequest(null);
      setExecutionResult(null);
      setPreviewOpen(false);
      message.error(errorMessage(executionError));
    } finally {
      if (!isMountedRef.current) {
        stopSyncProgressListener();
        executionInFlightRef.current = false;
      } else {
        clearSyncProgress();
        executionInFlightRef.current = false;
        setExecutionLocked(false);
        if (executionRequestId.current === requestId) {
          executingRef.current = false;
          setExecuting(false);
        }
      }
    }
  }, [clearSyncProgress, stopSyncProgressListener, syncPreview, syncRequest]);

  const handlePreviewBack = useCallback(() => {
    if (executingRef.current) return;
    clearSyncPreview();
  }, [clearSyncPreview]);

  const handleRecompare = useCallback(() => {
    if (executingRef.current) return;
    const latestCompareResult = executionResult?.latest_compare_result ?? null;
    resetSyncState();
    if (latestCompareResult) {
      setResult(latestCompareResult);
      setCompareError(null);
      return;
    }
    void handleCompare();
  }, [executionResult, handleCompare, resetSyncState]);

  const startDisabled =
    !sourceConnectionId ||
    !sourceDatabase ||
    !targetConnectionId ||
    !targetDatabase ||
    loadingSide !== null ||
    comparePending ||
    exporting ||
    previewing ||
    executing;
  const exportDisabled =
    !result || comparePending || exporting || previewing || executing;
  const previewDisabled =
    !result ||
    validSelectedTableNames.length === 0 ||
    comparePending ||
    exporting ||
    previewing ||
    executing;
  const syncEndpointLocked = previewing || previewOpen || executing;

  return (
    <Modal
      title="数据库结构对比"
      open={open}
      onCancel={handleClose}
      width={1120}
      rootClassName="database-compare-modal"
      destroyOnHidden
      closable={!executing}
      maskClosable={!executing}
      keyboard={!executing}
      footer={[
        <Button
          key="close"
          aria-label="关闭"
          onClick={handleClose}
          disabled={executing}
        >
          关闭
        </Button>,
        <Button
          key="export"
          onClick={() => void handleExport()}
          disabled={exportDisabled}
          loading={exporting}
        >
          导出 Excel
        </Button>,
        ...(result && result.tables.length > 0
          ? [
              <Button
                key="preview-sync"
                className="database-sync-preview-button"
                type="primary"
                icon={previewing ? undefined : <EyeOutlined aria-hidden />}
                aria-label={
                  previewing
                    ? "正在生成同步预览"
                    : `预览同步（${validSelectedTableNames.length}）`
                }
                aria-busy={previewing}
                onClick={() => void handlePreviewSync()}
                disabled={previewDisabled}
                loading={
                  previewing
                    ? {
                        icon: (
                          <LoadingOutlined
                            data-testid="database-sync-preview-loading-icon"
                            aria-hidden
                          />
                        ),
                      }
                    : false
                }
              >
                {previewing
                  ? "正在生成同步预览"
                  : `预览同步（${validSelectedTableNames.length}）`}
              </Button>,
            ]
          : []),
        <Button
          key="compare"
          type={result && result.tables.length > 0 ? "default" : "primary"}
          onClick={() => void handleCompare()}
          disabled={startDisabled}
          loading={comparing}
        >
          开始对比
        </Button>,
      ]}
    >
      <div className="database-compare-modal-body">
        <div className="database-compare-endpoints">
          <Card title="源端" size="small">
            <Form layout="vertical" component="div">
              <Form.Item label="源连接" htmlFor="compare-source-connection">
                <Select
                  id="compare-source-connection"
                  value={sourceConnectionId}
                  options={sourceConnectionOptions}
                  onChange={handleSourceConnectionChange}
                  disabled={syncEndpointLocked}
                  placeholder="请选择已保存连接"
                  showSearch
                  optionFilterProp="label"
                  virtual={false}
                />
              </Form.Item>
              <Form.Item
                label="源数据库/schema"
                htmlFor="compare-source-database"
              >
                <Select
                  id="compare-source-database"
                  value={sourceDatabase}
                  options={sourceDatabases.map((database) => ({
                    label: database,
                    value: database,
                  }))}
                  onChange={(database) => {
                    setSourceDatabase(database);
                    resetResult();
                  }}
                  disabled={!sourceConnectionId || syncEndpointLocked}
                  loading={loadingSide === "source"}
                  placeholder="请选择数据库/schema"
                  showSearch
                  virtual={false}
                />
              </Form.Item>
            </Form>
          </Card>

          <Button
            className="database-compare-swap"
            type="text"
            icon={<SwapOutlined />}
            aria-label="交换源端和目标端"
            title="交换源端和目标端"
            disabled={
              !sourceConnectionId ||
              !targetConnectionId ||
              loadingSide !== null ||
              loadErrors.source !== null ||
              loadErrors.target !== null ||
              comparePending ||
              exporting ||
              previewing ||
              previewOpen ||
              executing
            }
            onClick={handleSwap}
          />

          <Card title="目标端" size="small">
            <Form layout="vertical" component="div">
              <Form.Item label="目标连接" htmlFor="compare-target-connection">
                <Select
                  id="compare-target-connection"
                  value={targetConnectionId}
                  options={targetConnectionOptions}
                  onChange={handleTargetConnectionChange}
                  disabled={
                    !sourceConnectionId ||
                    loadingSide === "source" ||
                    syncEndpointLocked
                  }
                  placeholder="请选择同类型连接"
                  showSearch
                  optionFilterProp="label"
                  virtual={false}
                />
              </Form.Item>
              <Form.Item
                label="目标数据库/schema"
                htmlFor="compare-target-database"
              >
                <Select
                  id="compare-target-database"
                  value={targetDatabase}
                  options={targetDatabases.map((database) => ({
                    label: database,
                    value: database,
                  }))}
                  onChange={(database) => {
                    setTargetDatabase(database);
                    resetResult();
                  }}
                  disabled={!targetConnectionId || syncEndpointLocked}
                  loading={loadingSide === "target"}
                  placeholder="请选择数据库/schema"
                  showSearch
                  virtual={false}
                />
              </Form.Item>
            </Form>
          </Card>
        </div>

        {(["source", "target"] as const).map((side) => {
          const loadError = loadErrors[side];
          const connectionId =
            side === "source" ? sourceConnectionId : targetConnectionId;
          if (!loadError || !connectionId) return null;
          const sideLabel = side === "source" ? "源端" : "目标端";
          return (
            <Alert
              key={side}
              type="error"
              showIcon
              message={loadError}
              action={
                <Button
                  size="small"
                  aria-label={`重试${sideLabel}列表`}
                  onClick={() => void loadDatabases(side, connectionId)}
                  disabled={loadingSide !== null || executing}
                  loading={loadingSide === side}
                >
                  重试
                </Button>
              }
            />
          );
        })}

        {compareError && (
          <Alert
            type="error"
            showIcon
            message={compareError}
            action={
              sourceConnectionId &&
              sourceDatabase &&
              targetConnectionId &&
              targetDatabase ? (
                <Button
                  size="small"
                  aria-label="重试"
                  onClick={() => void handleCompare()}
                  loading={comparing}
                  disabled={executing}
                >
                  重试
                </Button>
              ) : undefined
            }
          />
        )}

        {result && (
          <DatabaseCompareResults
            result={result}
            disabled={comparePending || exporting || previewing || executing}
            selectedTableNames={selectedTableNames}
            includeDrops={includeDrops}
            onSelectionChange={handleSelectionChange}
            onIncludeDropsChange={handleIncludeDropsChange}
          />
        )}
      </div>

      {result && (
        <DatabaseSyncPreviewModal
          open={previewOpen}
          source={result.source}
          target={result.target}
          preview={syncPreview}
          executionResult={executionResult}
          executing={executing}
          progress={syncProgress}
          executionLocked={executionLocked}
          onBack={handlePreviewBack}
          onConfirm={() => void handleExecuteSync()}
          onRecompare={handleRecompare}
        />
      )}
    </Modal>
  );
}
