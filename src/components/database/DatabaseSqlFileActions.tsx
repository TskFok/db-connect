import { useState, useCallback, useRef, useEffect } from "react";
import {
  Button,
  Modal,
  Space,
  Tooltip,
  Checkbox,
  InputNumber,
  Typography,
  Progress,
  Spin,
} from "antd";
import { ImportOutlined, ExportOutlined } from "@ant-design/icons";
import { open, save } from "@tauri-apps/plugin-dialog";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as api from "../../services/tauriCommands";
import { useDatabaseStore } from "../../stores/databaseStore";
import { useConnectionStore } from "../../stores/connectionStore";
import {
  buildExportSqlDescription,
  buildImportFailureDetailsText,
  buildImportReadOnlyWarningText,
  buildImportSqlConfirmText,
  isConnectionGloballyReadOnly,
} from "../../utils/sqlFileIoUi";
import type { PreviewSqlFileImportResult } from "../../types";
import {
  type SqlIoProgressPayload,
  sqlIoProgressPercent,
} from "../../utils/sqlIoProgress";

const { Text } = Typography;

function createSqlExportId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function confirmDangerousSqlFileImport(
  preview: PreviewSqlFileImportResult
): Promise<boolean> {
  if (preview.dangerous_statements_total === 0) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const hiddenCount =
      preview.dangerous_statements_total - preview.dangerous_statements.length;
    Modal.confirm({
      title: "确认执行高危语句",
      width: 560,
      content: (
        <div>
          <p style={{ marginBottom: 8 }}>
            SQL 文件中包含可能造成数据或整库不可恢复丢失的语句，是否仍要导入？
          </p>
          <ul
            style={{
              paddingLeft: 20,
              margin: 0,
              maxHeight: 220,
              overflow: "auto",
            }}
          >
            {preview.dangerous_statements.map((stmt) => (
              <li
                key={stmt.statement_index}
                style={{
                  fontFamily: "monospace",
                  fontSize: 12,
                  wordBreak: "break-all",
                }}
              >
                第 {stmt.statement_index} 条/批：{stmt.statement_preview}
              </li>
            ))}
          </ul>
          {hiddenCount > 0 ? (
            <Text type="secondary" style={{ fontSize: 12 }}>
              另有 {hiddenCount} 条高危语句未展开显示。
            </Text>
          ) : null}
        </div>
      ),
      okText: "仍要导入",
      okType: "danger",
      cancelText: "取消",
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

export interface DatabaseSqlFileActionsProps {
  connId: string;
  database: string;
  disabled?: boolean;
}

export function DatabaseSqlFileActions({
  connId,
  database,
  disabled = false,
}: DatabaseSqlFileActionsProps) {
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [exportIncludeData, setExportIncludeData] = useState(false);
  const [exportMaxRows, setExportMaxRows] = useState(100_000);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportCanceling, setExportCanceling] = useState(false);
  const exportIdRef = useRef<string | null>(null);
  const activeConnection = useConnectionStore((s) => s.activeConnection);
  const databaseType = activeConnection?.config.database_type;
  const isClickHouse = databaseType === "clickhouse";
  const [importProgress, setImportProgress] =
    useState<SqlIoProgressPayload | null>(null);
  const [exportProgress, setExportProgress] =
    useState<SqlIoProgressPayload | null>(null);
  const importUnlistenRef = useRef<UnlistenFn | null>(null);
  const exportUnlistenRef = useRef<UnlistenFn | null>(null);

  const cleanupImportListener = useCallback(() => {
    importUnlistenRef.current?.();
    importUnlistenRef.current = null;
  }, []);

  const cleanupExportListener = useCallback(() => {
    exportUnlistenRef.current?.();
    exportUnlistenRef.current = null;
  }, []);

  useEffect(
    () => () => {
      cleanupImportListener();
      cleanupExportListener();
    },
    [cleanupImportListener, cleanupExportListener]
  );

  const handleImportSqlFile = useCallback(async () => {
    if (disabled || !connId) return;

    if (await isConnectionGloballyReadOnly(connId, database, databaseType)) {
      Modal.warning({
        title: "无法导入",
        content: buildImportReadOnlyWarningText(databaseType),
      });
      return;
    }

    const chosen = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    const filePath = Array.isArray(chosen) ? chosen[0] : chosen;
    if (!filePath || typeof filePath !== "string") return;

    let preview: PreviewSqlFileImportResult;
    try {
      preview = await api.previewSqlFileImport(databaseType ?? "mysql", filePath);
    } catch (e) {
      Modal.error({
        title: "导入预检失败",
        content: String(e),
      });
      return;
    }

    const skipDangerConfirm =
      activeConnection?.config.skip_dangerous_sql_confirm === true;
    if (preview.dangerous_statements_total > 0 && !skipDangerConfirm) {
      const confirmed = await confirmDangerousSqlFileImport(preview);
      if (!confirmed) return;
    }

    Modal.confirm({
      title: "确认导入 SQL 文件",
      content: buildImportSqlConfirmText(databaseType),
      okText: "开始导入",
      okType: "danger",
      width: 480,
      onOk: async () => {
        cleanupImportListener();
        setImportProgress(null);
        try {
          importUnlistenRef.current = await listen<SqlIoProgressPayload>(
            "sql-import-progress",
            (e) => {
              setImportProgress({
                current: e.payload.current,
                total: e.payload.total,
              });
            }
          );
        } catch {
          // 监听失败时仍继续导入
        }

        setImporting(true);
        try {
          const r = await api.importSqlFile(connId, database, filePath);
          const store = useDatabaseStore.getState();
          try {
            await store.loadTables(connId, database);
          } catch (err) {
            console.error("导入后刷新表列表失败:", err);
          }
          try {
            await store.refresh(connId);
          } catch (err) {
            console.error("导入后刷新连接视图失败:", err);
          }
          const base = `共 ${r.statements_total} 条，成功 ${r.statements_ok}，失败 ${r.statements_failed}，耗时 ${r.elapsed_ms}ms`;
          if (r.statements_failed === 0) {
            Modal.success({ content: `导入完成：${base}` });
          } else if (r.statements_ok === 0) {
            Modal.error({
              title: "导入失败",
              content: (
                <div
                  style={{
                    whiteSpace: "pre-wrap",
                    maxHeight: 360,
                    overflow: "auto",
                  }}
                >
                  {base}
                  {"\n\n"}
                  {buildImportFailureDetailsText(r)}
                </div>
              ),
            });
          } else {
            Modal.warning({
              title: "导入完成（部分失败）",
              width: 560,
              content: (
                <div
                  style={{
                    whiteSpace: "pre-wrap",
                    maxHeight: 360,
                    overflow: "auto",
                  }}
                >
                  {base}
                  {"\n\n"}
                  {buildImportFailureDetailsText(r)}
                </div>
              ),
            });
          }
        } catch (e) {
          Modal.error({ content: String(e) });
        } finally {
          setImporting(false);
          setImportProgress(null);
          cleanupImportListener();
        }
      },
    });
  }, [
    connId,
    database,
    databaseType,
    disabled,
    activeConnection?.config.skip_dangerous_sql_confirm,
    cleanupImportListener,
  ]);

  const handleOpenExportModal = useCallback(() => {
    if (disabled || !connId) return;
    setExportModalOpen(true);
  }, [connId, disabled]);

  const handleExportConfirm = useCallback(async () => {
    if (disabled || !connId) return;
    const defaultPath = `${database}_export.sql`;
    const outPath = await save({
      defaultPath,
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (!outPath || typeof outPath !== "string") return;

    setExportModalOpen(false);
    cleanupExportListener();
    setExportProgress(null);
    const exportId = isClickHouse ? createSqlExportId() : undefined;
    exportIdRef.current = exportId ?? null;
    try {
      exportUnlistenRef.current = await listen<SqlIoProgressPayload>(
        "sql-export-progress",
        (e) => {
          setExportProgress({
            current: e.payload.current,
            total: e.payload.total,
          });
        }
      );
    } catch {
      // 无进度时仍可导出
    }

    setExporting(true);
    try {
      const r = await api.exportDatabaseToFile(
        connId,
        database,
        outPath,
        exportIncludeData,
        exportMaxRows,
        exportId
      );
      Modal.success({
        content: `已导出：表 ${r.tables_exported}、视图 ${r.views_exported}、触发器 ${r.triggers_exported}、事件 ${r.events_exported}，INSERT 行数约 ${r.insert_rows}，耗时 ${r.elapsed_ms}ms`,
      });
    } catch (e) {
      if (String(e).includes("导出已取消")) {
        Modal.warning({
          title: "导出已取消",
          content: "已停止后续导出；如目标文件已创建，可删除后重新导出。",
        });
        return;
      }
      Modal.error({
        title: "导出失败",
        content: String(e),
      });
    } finally {
      setExporting(false);
      setExportCanceling(false);
      exportIdRef.current = null;
      setExportProgress(null);
      cleanupExportListener();
    }
  }, [
    connId,
    database,
    disabled,
    exportIncludeData,
    exportMaxRows,
    isClickHouse,
    cleanupExportListener,
  ]);

  const handleCancelExport = useCallback(async () => {
    const exportId = exportIdRef.current;
    if (!exportId) return;
    setExportCanceling(true);
    try {
      await api.cancelSqlExport(exportId);
    } catch (e) {
      setExportCanceling(false);
      Modal.error({
        title: "取消导出失败",
        content: String(e),
      });
    }
  }, []);

  const importBlocked = disabled || !connId;
  const importPct = sqlIoProgressPercent(importProgress);
  const importParsing =
    importing && importProgress !== null && importProgress.total === 0;
  const importExecuting =
    importing && importProgress !== null && importProgress.total > 0;

  const exportPct = sqlIoProgressPercent(exportProgress);

  return (
    <>
      <Space size={4}>
        <Tooltip
          title={
            importBlocked
              ? "请先连接数据库"
              : "导入 .sql 文件并执行（当前库上下文）"
          }
        >
          <Button
            type="default"
            size="small"
            icon={<ImportOutlined />}
            disabled={importBlocked}
            onClick={() => void handleImportSqlFile()}
          />
        </Tooltip>
        <Tooltip
          title={importBlocked ? "请先连接数据库" : "导出当前数据库为 .sql"}
        >
          <Button
            type="default"
            size="small"
            icon={<ExportOutlined />}
            loading={exporting}
            disabled={importBlocked}
            onClick={handleOpenExportModal}
          />
        </Tooltip>
      </Space>

      <Modal
        title="正在导入 SQL"
        open={importing}
        footer={null}
        closable={false}
        maskClosable={false}
        destroyOnHidden
      >
        <Text type="secondary" style={{ display: "block", marginBottom: 12 }}>
          大文件解析与执行可能需较长时间，请勿关闭应用。
        </Text>
        {importParsing ? (
          <>
            <Progress percent={0} status="active" showInfo={false} />
            <Text
              type="secondary"
              style={{ fontSize: 12, marginTop: 8, display: "block" }}
            >
              正在解析 SQL 文件…
            </Text>
          </>
        ) : importExecuting && importPct !== undefined ? (
          <>
            <Progress percent={importPct} status="active" />
            <Text
              type="secondary"
              style={{ fontSize: 12, marginTop: 8, display: "block" }}
            >
              已执行 {importProgress!.current} / {importProgress!.total} 条语句
            </Text>
          </>
        ) : (
          <div style={{ textAlign: "center", padding: 16 }}>
            <Spin tip="连接并准备…" />
          </div>
        )}
      </Modal>

      <Modal
        title="正在导出 SQL"
        open={exporting}
        footer={
          exportIdRef.current
            ? [
                <Button
                  key="cancel-export"
                  danger
                  loading={exportCanceling}
                  onClick={() => void handleCancelExport()}
                >
                  取消导出
                </Button>,
              ]
            : null
        }
        closable={false}
        maskClosable={false}
        destroyOnHidden
      >
        <Text type="secondary" style={{ display: "block", marginBottom: 12 }}>
          正在导出表 / 视图 / 数据 / 触发器等对象，请勿关闭应用。
        </Text>
        {exportPct !== undefined ? (
          <>
            <Progress percent={exportPct} status="active" />
            {exportProgress && exportProgress.total > 0 ? (
              <Text
                type="secondary"
                style={{ fontSize: 12, marginTop: 8, display: "block" }}
              >
                进度 {exportProgress.current} / {exportProgress.total}
                （按表、视图和对象分步； 大表写入较慢时数字会暂时停留）
              </Text>
            ) : null}
          </>
        ) : (
          <div style={{ textAlign: "center", padding: 16 }}>
            <Spin tip="准备导出…" />
          </div>
        )}
      </Modal>

      <Modal
        title={`导出数据库「${database}」`}
        open={exportModalOpen}
        okText="选择保存路径"
        onOk={() => void handleExportConfirm()}
        onCancel={() => setExportModalOpen(false)}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {buildExportSqlDescription(databaseType)}
          </Text>
          <Checkbox
            checked={exportIncludeData}
            onChange={(e) => setExportIncludeData(e.target.checked)}
          >
            {isClickHouse
              ? "同时导出表数据（INSERT ... FORMAT Values）"
              : "同时导出表数据（INSERT）"}
          </Checkbox>
          <div>
            <Text style={{ marginRight: 8 }}>每表最多行数</Text>
            <InputNumber
              min={1}
              max={1_000_000}
              value={exportMaxRows}
              onChange={(v) => setExportMaxRows(v ?? 100_000)}
              disabled={!exportIncludeData}
            />
          </div>
        </Space>
      </Modal>
    </>
  );
}
