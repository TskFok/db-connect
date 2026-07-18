import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  LoadingOutlined,
  StopOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Checkbox,
  List,
  Modal,
  Progress,
  Result,
  Statistic,
  Tag,
} from "antd";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  CompareEndpointInfo,
  DatabaseSyncExecutionResult,
  DatabaseSyncOperation,
  DatabaseSyncOperationKind,
  DatabaseSyncProgress,
  DatabaseSyncPreview,
  DatabaseSyncRisk,
} from "../../types";
import { formatSyncRisk } from "../../utils/databaseSync";
import {
  databaseSyncProgressPercent,
  formatDatabaseSyncProgress,
} from "../../utils/databaseSyncProgress";

export interface DatabaseSyncPreviewModalProps {
  open: boolean;
  source: CompareEndpointInfo;
  target: CompareEndpointInfo;
  preview: DatabaseSyncPreview | null;
  executionResult: DatabaseSyncExecutionResult | null;
  executing: boolean;
  progress: DatabaseSyncProgress | null;
  executionLocked: boolean;
  onBack: () => void;
  onConfirm: () => void;
  onRecompare: () => void;
}

const ACKNOWLEDGEMENT_LABEL =
  "我已检查以上 SQL，并理解已成功执行的 DDL 可能无法自动回滚";

const OPERATION_KIND_LABELS: Record<DatabaseSyncOperationKind, string> = {
  create_table: "创建表",
  add_column: "新增字段",
  alter_column: "修改字段",
  replace_primary_key: "替换主键",
  drop_column: "删除字段",
  drop_table: "删除表",
  update_comment: "更新注释",
};

const RISK_TAG_COLORS: Record<DatabaseSyncRisk, string> = {
  normal: "blue",
  high: "orange",
  destructive: "red",
};

function RiskIcon({ risk }: { risk: DatabaseSyncRisk }) {
  if (risk === "destructive") {
    return (
      <DeleteOutlined
        data-testid="database-sync-risk-destructive-icon"
        aria-hidden
      />
    );
  }
  if (risk === "high") {
    return (
      <WarningOutlined data-testid="database-sync-risk-high-icon" aria-hidden />
    );
  }
  return (
    <InfoCircleOutlined
      data-testid="database-sync-risk-normal-icon"
      aria-hidden
    />
  );
}

function operationLabel(operation: DatabaseSyncOperation): string {
  return `${operation.table_name} / ${OPERATION_KIND_LABELS[operation.kind]}`;
}

function findOperation(
  preview: DatabaseSyncPreview | null,
  operationId: string
): DatabaseSyncOperation | undefined {
  return preview?.operations.find((operation) => operation.id === operationId);
}

function completedOperationCount(result: DatabaseSyncExecutionResult): number {
  return new Set(
    result.completed_statements.map((statement) => statement.operation_id)
  ).size;
}

function executionStatusMessage(result: DatabaseSyncExecutionResult): string {
  const statementCount = result.completed_statements.length;
  if (result.status === "succeeded") {
    return `数据库结构同步成功，已完成 ${completedOperationCount(result)} 个操作，共 ${statementCount} 条语句`;
  }
  if (result.status === "partially_succeeded") {
    return `数据库结构同步部分完成，已执行 ${statementCount} 条语句`;
  }
  return "数据库结构同步失败，尚未成功执行语句";
}

function OperationCard({ operation }: { operation: DatabaseSyncOperation }) {
  const kindLabel = OPERATION_KIND_LABELS[operation.kind];
  const riskLabel = formatSyncRisk(operation.risk);

  return (
    <article
      className="database-sync-operation"
      aria-label={`${operation.table_name} ${kindLabel} ${riskLabel}`}
    >
      <div className="database-sync-operation-heading">
        <strong>{operation.table_name}</strong>
        <div className="database-sync-operation-tags">
          <Tag>{kindLabel}</Tag>
          <Tag
            color={RISK_TAG_COLORS[operation.risk]}
            icon={<RiskIcon risk={operation.risk} />}
          >
            {riskLabel}
          </Tag>
        </div>
      </div>
      <p className="database-sync-operation-summary">{operation.summary}</p>
      <div
        className="database-sync-sql-list"
        aria-label={`${operation.table_name} SQL`}
      >
        {operation.sql.map((sql, statementIndex) => (
          <pre key={`${operation.id}-${statementIndex}`} tabIndex={0}>
            <code>{sql}</code>
          </pre>
        ))}
      </div>
    </article>
  );
}

function PreviewContent({ preview }: { preview: DatabaseSyncPreview }) {
  const shortFingerprint = preview.plan_fingerprint.slice(0, 12);
  const noExecutableOperations = preview.operations.length === 0;

  return (
    <>
      <div className="database-sync-plan-meta">
        <div className="database-sync-plan-summary" aria-label="同步计划摘要">
          <Statistic title="已选择表" value={preview.summary.selected_tables} />
          <Statistic
            title="可执行操作"
            value={preview.summary.executable_operations}
          />
          <Statistic
            title="高风险"
            value={preview.summary.high_risk_operations}
          />
          <Statistic
            title="删除"
            value={preview.summary.destructive_operations}
          />
          <Statistic title="已跳过" value={preview.summary.skipped_items} />
          <Statistic title="阻塞" value={preview.summary.blockers} />
        </div>
        <Tag className="database-sync-fingerprint">计划 {shortFingerprint}</Tag>
      </div>

      <Alert
        type="warning"
        showIcon
        message="DDL 不保证整批回滚"
        description="执行遇到首个失败时会立即停止；此前已成功执行的 DDL 可能无法自动回滚。"
      />

      {preview.blockers.length > 0 ? (
        <section aria-label="阻塞项目" className="database-sync-plan-section">
          <Alert
            type="error"
            showIcon
            icon={<StopOutlined aria-hidden />}
            message="无法自动同步"
            description={
              <>
                <List
                  size="small"
                  dataSource={preview.blockers}
                  renderItem={(blocker) => (
                    <List.Item>
                      <div>
                        <strong>{blocker.table_name}</strong>
                        <div>{blocker.summary}</div>
                        <div className="database-sync-item-reason">
                          {blocker.reason}
                        </div>
                      </div>
                    </List.Item>
                  )}
                />
                <p className="database-sync-recovery-path">
                  请返回对比结果，取消选择被阻塞的表，再重新生成预览。
                </p>
              </>
            }
          />
        </section>
      ) : !preview.can_execute ? (
        <Alert
          type="error"
          showIcon
          message="当前计划不可执行"
          description="请返回调整选择或删除设置，然后重新生成预览。"
        />
      ) : noExecutableOperations ? (
        <Alert
          type="info"
          showIcon
          message="没有可执行操作"
          description="请返回调整选择或删除设置，然后重新生成预览。"
        />
      ) : null}

      {preview.skipped_items.length > 0 && (
        <section aria-label="已跳过项目" className="database-sync-plan-section">
          <Alert
            type="info"
            showIcon
            message={`已跳过 ${preview.skipped_items.length} 项`}
            description={
              <>
                <List
                  size="small"
                  dataSource={preview.skipped_items}
                  renderItem={(item) => (
                    <List.Item>
                      <div>
                        <strong>{item.table_name}</strong>
                        <div>{item.summary}</div>
                        <div className="database-sync-item-reason">
                          {item.reason}
                        </div>
                      </div>
                    </List.Item>
                  )}
                />
                <p className="database-sync-recovery-path">
                  如需同步删除，请返回并开启删除操作后重新预览。
                </p>
              </>
            }
          />
        </section>
      )}

      <section aria-label="同步操作" className="database-sync-plan-section">
        <div className="database-sync-section-heading">
          <h3>按执行顺序预览 SQL</h3>
          <span>{preview.operations.length} 个操作</span>
        </div>
        <div className="database-sync-operation-list">
          {preview.operations.map((operation) => (
            <OperationCard key={operation.id} operation={operation} />
          ))}
        </div>
      </section>
    </>
  );
}

function CleanupWarning({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <Alert
      type="warning"
      showIcon
      message="连接清理警告"
      description={
        <List
          size="small"
          dataSource={errors}
          renderItem={(error) => <List.Item>{error}</List.Item>}
        />
      }
    />
  );
}

function ExecutionResultContent({
  preview,
  result,
}: {
  preview: DatabaseSyncPreview | null;
  result: DatabaseSyncExecutionResult;
}) {
  const completedCount = result.completed_statements.length;
  const failedOperation = result.failed
    ? findOperation(preview, result.failed.operation_id)
    : undefined;
  const completedStatements = result.completed_statements.map((statement) => ({
    ...statement,
    operation: findOperation(preview, statement.operation_id),
  }));
  const failedOperationCompletedCount = result.failed
    ? completedStatements.filter(
        (statement) => statement.operation_id === result.failed?.operation_id
      ).length
    : 0;
  const pendingOperations = result.pending_operation_ids
    .filter((operationId) => operationId !== result.failed?.operation_id)
    .map((operationId) => ({
      id: operationId,
      operation: findOperation(preview, operationId),
    }));

  if (result.status === "succeeded") {
    return (
      <div className="database-sync-execution-result">
        <Result
          status="success"
          icon={<CheckCircleOutlined aria-hidden />}
          title="数据库结构已同步"
          subTitle={`已完成 ${completedOperationCount(result)} 个操作（${completedCount} 条语句）`}
        />
        <CleanupWarning errors={result.cleanup_errors} />
      </div>
    );
  }

  const failedStatementNumber = completedCount + 1;
  const failedSqlNumber = (result.failed?.statement_index ?? 0) + 1;
  const failedOperationRemainingCount = result.failed
    ? Math.max(
        0,
        (failedOperation?.sql.length ?? 0) - result.failed.statement_index - 1
      )
    : 0;
  const resultTitle =
    result.status === "partially_succeeded" ? "同步部分完成" : "同步执行失败";

  return (
    <div className="database-sync-execution-result">
      <Result
        status={result.status === "partially_succeeded" ? "warning" : "error"}
        icon={
          result.status === "partially_succeeded" ? (
            <ExclamationCircleOutlined aria-hidden />
          ) : (
            <CloseCircleOutlined aria-hidden />
          )
        }
        title={resultTitle}
        subTitle={`已执行 ${completedCount} 条语句`}
      />

      {completedStatements.length > 0 && (
        <section
          aria-label="已成功执行的语句"
          className="database-sync-plan-section"
        >
          <div className="database-sync-section-heading">
            <h3>已成功执行的语句</h3>
          </div>
          <List
            size="small"
            bordered
            dataSource={completedStatements}
            renderItem={(statement) => (
              <List.Item>
                {statement.operation
                  ? `${operationLabel(statement.operation)} / 第 ${statement.statement_index + 1} 条 SQL`
                  : `${statement.operation_id} / 第 ${statement.statement_index + 1} 条 SQL`}
              </List.Item>
            )}
          />
        </section>
      )}

      {result.failed && (
        <Alert
          type="error"
          showIcon
          message={`执行在第 ${failedStatementNumber} 条语句停止`}
          description={
            <div className="database-sync-failure-detail">
              <strong>
                失败操作：
                {failedOperation
                  ? operationLabel(failedOperation)
                  : result.failed.operation_id}
              </strong>
              <span>操作内第 {failedSqlNumber} 条 SQL</span>
              {failedOperationCompletedCount > 0 && (
                <span>该操作已完成 {failedOperationCompletedCount} 条 SQL</span>
              )}
              {failedOperationRemainingCount > 0 && (
                <span>
                  该操作另有 {failedOperationRemainingCount} 条 SQL 未执行
                </span>
              )}
              <code>{result.failed.error}</code>
            </div>
          }
        />
      )}

      <section aria-label="未执行操作" className="database-sync-plan-section">
        <div className="database-sync-section-heading">
          <h3>未执行 {pendingOperations.length} 个操作</h3>
        </div>
        <List
          size="small"
          bordered
          dataSource={pendingOperations}
          renderItem={({ id, operation }) => (
            <List.Item>{operation ? operationLabel(operation) : id}</List.Item>
          )}
        />
      </section>

      <Alert
        type="info"
        showIcon
        message="旧计划不能直接重试"
        description="请重新对比目标端的真实结构，再生成新的同步预览。"
      />
      <CleanupWarning errors={result.cleanup_errors} />
    </div>
  );
}

export function DatabaseSyncPreviewModal({
  open,
  source,
  target,
  preview,
  executionResult,
  executing,
  progress,
  executionLocked,
  onBack,
  onConfirm,
  onRecompare,
}: DatabaseSyncPreviewModalProps) {
  const confirmationKey = preview
    ? JSON.stringify([
        source.connection_id,
        source.database,
        target.connection_id,
        target.database,
        preview.plan_fingerprint,
      ])
    : null;
  const [acknowledgedKey, setAcknowledgedKey] = useState<string | null>(null);
  const [confirmRequestedKey, setConfirmRequestedKey] = useState<string | null>(
    null
  );
  const recompareButtonRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (!open || executionResult) {
      setAcknowledgedKey(null);
      setConfirmRequestedKey(null);
    }
  }, [executionResult, open]);

  useEffect(() => {
    if (open && executionResult && !executing) {
      recompareButtonRef.current?.focus();
    }
  }, [executionResult, executing, open]);

  useEffect(() => {
    if (!executing) setConfirmRequestedKey(null);
  }, [executing]);

  const destructive = useMemo(
    () =>
      preview?.operations.some(
        (operation) => operation.risk === "destructive"
      ) ?? false,
    [preview]
  );
  const acknowledged =
    confirmationKey !== null && acknowledgedKey === confirmationKey;
  const confirmRequested =
    confirmationKey !== null && confirmRequestedKey === confirmationKey;
  const confirmDisabled =
    executing ||
    executionLocked ||
    confirmRequested ||
    !preview?.can_execute ||
    preview.operations.length === 0 ||
    !acknowledged;
  const canAcknowledge =
    open &&
    !executionResult &&
    Boolean(preview?.can_execute && preview.operations.length > 0);
  const confirmLabel = destructive ? "确认并执行删除同步" : "确认执行";
  const progressPercent = databaseSyncProgressPercent(progress);
  const progressMessage = formatDatabaseSyncProgress(progress);
  const handleCancel = () => {
    if (executing) return;
    if (executionResult) {
      onRecompare();
    } else {
      onBack();
    }
  };
  const handleConfirm = () => {
    if (confirmDisabled || !confirmationKey) return;
    setConfirmRequestedKey(confirmationKey);
    onConfirm();
  };
  return (
    <Modal
      title={executionResult ? "同步执行结果" : "同步 SQL 预览"}
      open={open}
      onCancel={handleCancel}
      width={960}
      rootClassName="database-sync-preview-modal"
      styles={{
        content: {
          display: "flex",
          flexDirection: "column",
          maxHeight: "calc(100dvh - 48px)",
        },
        body: {
          flex: "1 1 auto",
          minHeight: 0,
          overflowY: "auto",
          scrollbarGutter: "stable",
        },
      }}
      destroyOnHidden
      closable={
        executing
          ? false
          : {
              "aria-label": executionResult
                ? "关闭结果并重新对比"
                : "关闭同步预览",
            }
      }
      maskClosable={!executing}
      keyboard={!executing}
      footer={
        executionResult
          ? [
              <Button
                key="recompare"
                ref={recompareButtonRef}
                type="primary"
                className="database-sync-footer-action"
                onClick={onRecompare}
                disabled={executing}
              >
                重新对比
              </Button>,
            ]
          : [
              <Button
                key="back"
                className="database-sync-footer-action"
                onClick={onBack}
                disabled={executing}
              >
                返回对比结果
              </Button>,
              <Button
                key="confirm"
                type="primary"
                danger={destructive}
                className="database-sync-confirm-action"
                aria-label={executing ? "正在执行同步" : confirmLabel}
                aria-busy={executing}
                onClick={handleConfirm}
                disabled={confirmDisabled}
                loading={
                  executing
                    ? {
                        icon: (
                          <LoadingOutlined
                            data-testid="database-sync-execution-loading-icon"
                            aria-hidden
                          />
                        ),
                      }
                    : false
                }
              >
                {executing ? "正在执行同步" : confirmLabel}
              </Button>,
            ]
      }
    >
      <div className="database-sync-preview-body">
        {!executing && (
          <div
            className="database-sync-live-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {executionResult ? executionStatusMessage(executionResult) : ""}
          </div>
        )}
        <header className="database-sync-direction">
          <strong>
            {source.connection_name} / {source.database} →{" "}
            {target.connection_name} / {target.database}
          </strong>
          <span>目标数据库：{target.database}</span>
        </header>

        {executing && (
          <section
            className={`database-sync-progress ${
              progressPercent === undefined
                ? "database-sync-progress--indeterminate"
                : ""
            }`}
            aria-label="同步执行进度"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <Progress
              aria-label="数据库结构同步进度"
              aria-valuenow={progressPercent}
              percent={progressPercent}
              showInfo={progressPercent !== undefined}
              status="active"
            />
            <span>{progressMessage}</span>
          </section>
        )}

        {executionResult ? (
          <ExecutionResultContent preview={preview} result={executionResult} />
        ) : preview ? (
          <>
            {executionLocked && !executing && (
              <Alert
                type="info"
                showIcon
                message="上一同步请求仍在处理中"
                description="等待上一请求完成后，才能执行新的同步计划。"
              />
            )}
            <PreviewContent preview={preview} />
          </>
        ) : (
          <Alert
            type="info"
            showIcon
            message="同步预览尚未生成"
            description="请返回对比结果并重新生成同步预览。"
          />
        )}

        {canAcknowledge && (
          <div className="database-sync-confirmation">
            {destructive && (
              <Alert
                type="error"
                showIcon
                icon={
                  <DeleteOutlined
                    data-testid="database-sync-destructive-warning-icon"
                    aria-hidden
                  />
                }
                message="删除操作不可由本工具自动恢复"
                description="请确认目标端表或字段可以永久删除，并已自行准备必要的备份。"
              />
            )}
            <Checkbox
              checked={acknowledged}
              disabled={executing}
              onChange={(event) =>
                setAcknowledgedKey(
                  event.target.checked ? confirmationKey : null
                )
              }
            >
              {ACKNOWLEDGEMENT_LABEL}
            </Checkbox>
          </div>
        )}
      </div>
    </Modal>
  );
}
