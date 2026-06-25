import { useState, useRef, useEffect, useMemo, useCallback } from "react";
import {
  Button,
  Space,
  Typography,
  Table,
  Select,
  Alert,
  Spin,
  Empty,
  Modal,
  Input,
  Drawer,
  Tooltip,
  Collapse,
  message,
  Descriptions,
} from "antd";
import {
  PlayCircleOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  SaveOutlined,
  FileExcelOutlined,
  InfoCircleOutlined,
  FileSearchOutlined,
  StopOutlined,
} from "@ant-design/icons";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDatabaseStore } from "../../stores/databaseStore";
import { useThemeStore } from "../../stores/themeStore";
import { useSavedSqlStore } from "../../stores/savedSqlStore";
import {
  filterSavedSqlByConnectionKey,
  savedSqlConnectionKey,
} from "../../utils/savedSqlConnection";
import { SavedSqlDropdown } from "../database/SavedSqlDropdown";
import * as api from "../../services/tauriCommands";
import type { SessionInfo, SqlExecuteResult } from "../../types";
import {
  BULK_EXECUTED_SQL_PREVIEW_CAP,
  BULK_EXECUTED_SQL_UI_THRESHOLD,
  getExecutedSqlPreview,
  splitSqlStatements,
} from "../../utils/sqlUtils";
import { setupMonacoEditor } from "../../utils/monacoSetup";
import { registerSqlCompletionProvider } from "../../utils/sqlCompletion";

setupMonacoEditor();
import type { SqlSchema, SqlDialect } from "../../utils/sqlCompletion";
import { normalizeDatabaseType } from "../../utils/connectionConfig";
import { loadSqlCompletionSchema } from "../../utils/sqlCompletionSchema";
import {
  assertCsvRowWithinLimit,
  buildQueryResultWorkbookBase64,
  saveExcelWithDialog,
} from "../../utils/excelExport";
import { listDangerousSqlStatements } from "../../utils/dangerousSql";
import { supportsExplainAnalyze } from "../../utils/mysqlVersion";

const { Text } = Typography;

const EMPTY_EXECUTED_SQL_LIST: string[] = [];

export interface SqlEditorProps {
  /** 独立 SQL 标签页 id，提供时从 store 读写内容 */
  tabId?: string;
}

export function SqlEditor({ tabId }: SqlEditorProps) {
  const { activeConnection } = useConnectionStore();
  const {
    databases,
    selectedDatabase,
    sqlTabContents,
    sqlTabResults,
    setSqlTabContent,
    setSqlTabResult,
  } = useDatabaseStore();
  const themeMode = useThemeStore((s) => s.mode);
  const { add: addSavedSql, getAll: getSavedSqlList } = useSavedSqlStore();

  const [currentDb, setCurrentDb] = useState<string | null>(
    selectedDatabase
  );
  const [executing, setExecuting] = useState(false);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [saveModalName, setSaveModalName] = useState("");
  /** 批量已执行 SQL 折叠面板展开的 key（antd Collapse） */
  const [bulkExecutedPanelKeys, setBulkExecutedPanelKeys] = useState<string[]>([]);
  const [sessionDrawerOpen, setSessionDrawerOpen] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  /** 连接或库切换时预取，用于禁用不兼容的 EXPLAIN ANALYZE */
  const [prefetchedVersion, setPrefetchedVersion] = useState<string | null>(null);
  /** 已完成版本探测的 connId+db key；不一致时视为仍在探测 */
  const [prefetchedVersionReadyKey, setPrefetchedVersionReadyKey] = useState("");
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  /** 当前正在执行语句的取消令牌（用于「停止」按钮取消运行中的查询） */
  const currentExecutionIdRef = useRef<string | null>(null);

  const connId = activeConnection?.connId ?? "";
  const databaseType = normalizeDatabaseType(activeConnection?.config.database_type);
  const versionProbeKey = `${connId}::${currentDb ?? ""}`;
  const prefetchedVersionLoading =
    !!connId && prefetchedVersionReadyKey !== versionProbeKey;
  const contentFromStore = tabId ? (sqlTabContents[tabId] ?? "") : undefined;

  // 独立 SQL 标签页：从 store 读取执行结果（切换 tab 时保留）；表内嵌 SQL：使用本地 state
  const tabResult = tabId ? sqlTabResults[tabId] : null;
  const [localResult, setLocalResult] = useState<SqlExecuteResult | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localExecutedSqlList, setLocalExecutedSqlList] = useState<string[]>([]);

  const result = tabId ? (tabResult?.result ?? null) : localResult;
  const error = tabId ? (tabResult?.error ?? null) : localError;
  const executedSqlList = tabId
    ? (tabResult?.executedSqlList ?? EMPTY_EXECUTED_SQL_LIST)
    : localExecutedSqlList;

  const executedPreview = useMemo(
    () =>
      getExecutedSqlPreview(
        executedSqlList,
        BULK_EXECUTED_SQL_UI_THRESHOLD,
        BULK_EXECUTED_SQL_PREVIEW_CAP
      ),
    [executedSqlList]
  );

  useEffect(() => {
    setBulkExecutedPanelKeys([]);
  }, [executedSqlList]);

  useEffect(() => {
    if (!connId) {
      setPrefetchedVersion(null);
      setPrefetchedVersionReadyKey("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const info = await api.getSessionInfoCached(connId, currentDb);
        if (!cancelled) {
          setPrefetchedVersion(info.version);
        }
      } catch {
        if (!cancelled) {
          setPrefetchedVersion(null);
        }
      } finally {
        if (!cancelled) {
          setPrefetchedVersionReadyKey(versionProbeKey);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connId, currentDb, versionProbeKey]);

  const explainAnalyzeSupported = useMemo(
    () =>
      databaseType === "postgres"
        ? true
        : supportsExplainAnalyze(prefetchedVersion ?? ""),
    [databaseType, prefetchedVersion]
  );

  const handleContentChange = useCallback(
    (value: string | undefined) => {
      if (tabId && connId) {
        setSqlTabContent(connId, tabId, value ?? "");
      }
    },
    [tabId, connId, setSqlTabContent]
  );

  // 使用 ref 保存最新的执行参数，解决 Monaco addAction 闭包过期问题
  const execParamsRef = useRef({ connId, currentDb });
  useEffect(() => {
    execParamsRef.current = { connId, currentDb };
  }, [connId, currentDb]);

  // SQL 补全用的 schema 缓存 (数据库/表/列)
  const schemaRef = useRef<SqlSchema>({
    databases: [],
    tables: [],
    columns: [],
  });

  // SQL 补全方言（随连接类型动态更新，供 Monaco 回调读取最新值）
  const dialectRef = useRef<SqlDialect>("mysql");
  useEffect(() => {
    dialectRef.current =
      databaseType === "postgres" ? "postgres" : "mysql";
  }, [databaseType]);

  useEffect(() => {
    if (!connId) {
      schemaRef.current = { databases: [], tables: [], columns: [] };
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        const schema = await loadSqlCompletionSchema(
          api,
          connId,
          currentDb,
          dialectRef.current
        );
        if (cancelled) return;
        schemaRef.current = schema;
      } catch {
        schemaRef.current = {
          databases: [],
          tables: [],
          columns: [],
        };
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [connId, currentDb]);

  // 结果区域容器 ref + 动态高度
  const resultContainerRef = useRef<HTMLDivElement>(null);
  const [resultHeight, setResultHeight] = useState(300);

  useEffect(() => {
    const container = resultContainerRef.current;
    if (!container) return;
    const bulkCollapsed =
      executedPreview.isBulk && bulkExecutedPanelKeys.length === 0;
    const reserved = bulkCollapsed ? 220 : 335;
    const applyHeight = (contentHeight: number) => {
      const height = Math.max(contentHeight - reserved, 150);
      requestAnimationFrame(() => setResultHeight(height));
    };
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      applyHeight(entry.contentRect.height);
    });
    observer.observe(container);
    applyHeight(container.getBoundingClientRect().height);
    return () => observer.disconnect();
  }, [executedPreview.isBulk, bulkExecutedPanelKeys.length]);

  const savedList = getSavedSqlList();
  const currentSavedSqlKey = useMemo(
    () => (activeConnection ? savedSqlConnectionKey(activeConnection.config) : ""),
    [activeConnection]
  );
  const savedListForCurrent = useMemo(
    () => filterSavedSqlByConnectionKey(savedList, currentSavedSqlKey),
    [savedList, currentSavedSqlKey]
  );

  const handleSaveSql = useCallback(() => {
    if (!connId || !activeConnection) {
      message.warning("请先建立数据库连接后再保存 SQL");
      return;
    }
    const sql = editorRef.current?.getValue()?.trim() ?? "";
    if (!sql) return;
    setSaveModalName("");
    setSaveModalOpen(true);
  }, [connId, activeConnection]);

  const handleSaveModalOk = useCallback(() => {
    if (!activeConnection) return;
    const sql = editorRef.current?.getValue()?.trim() ?? "";
    if (!sql) return;
    addSavedSql(
      saveModalName.trim() || `SQL ${savedListForCurrent.length + 1}`,
      sql,
      activeConnection.config
    );
    setSaveModalOpen(false);
    setSaveModalName("");
  }, [addSavedSql, saveModalName, savedListForCurrent.length, activeConnection]);

  const loadSessionInfo = useCallback(async () => {
    const { connId: cid, currentDb: db } = execParamsRef.current;
    if (!cid) return;
    setSessionLoading(true);
    setSessionInfo(null);
    try {
      const info = await api.getSessionInfoCached(cid, db, { force: true });
      setSessionInfo(info);
    } catch (e) {
      message.error(String(e));
    } finally {
      setSessionLoading(false);
    }
  }, []);

  const openSessionDrawer = useCallback(() => {
    setSessionDrawerOpen(true);
    void loadSessionInfo();
  }, [loadSessionInfo]);

  /** 取编辑器选中内容，否则全文（与执行逻辑一致） */
  const getEditorSqlSnippet = useCallback((): string => {
    const ed = editorRef.current;
    if (!ed) return "";
    const selection = ed.getSelection();
    const sql =
      selection && !selection.isEmpty()
        ? (ed.getModel()?.getValueInRange(selection) ?? "")
        : ed.getValue();
    return sql.trim();
  }, []);

  const doExplain = useCallback(
    async (analyze: boolean) => {
      const { connId: cid, currentDb: db } = execParamsRef.current;
      if (!cid) return;
      const sql = getEditorSqlSnippet();
      if (!sql) {
        message.warning("请先输入或选中要解释的 SQL");
        return;
      }
      setExecuting(true);
      if (tabId && cid) {
        setSqlTabResult(cid, tabId, null, null, []);
      } else {
        setLocalError(null);
        setLocalResult(null);
      }
      try {
        const res = await api.explainSql(cid, db, sql, analyze);
        if (tabId && cid) {
          setSqlTabResult(cid, tabId, res, null, []);
        } else {
          setLocalResult(res);
        }
      } catch (e) {
        const err = String(e);
        if (tabId && cid) {
          setSqlTabResult(cid, tabId, null, err, []);
        } else {
          setLocalError(err);
        }
      } finally {
        setExecuting(false);
      }
    },
    [getEditorSqlSnippet, tabId, setSqlTabResult]
  );

  const doExecute = useCallback(async () => {
    const ed = editorRef.current;
    const { connId: cid, currentDb: db } = execParamsRef.current;
    if (!ed || !cid) return;

    const selection = ed.getSelection();
    const rawSql =
      selection && !selection.isEmpty()
        ? (ed.getModel()?.getValueInRange(selection) ?? "")
        : ed.getValue();

    const sql = rawSql.trim();
    if (!sql) return;

    const statements = splitSqlStatements(sql);
    const skipDangerConfirm =
      activeConnection?.config.skip_dangerous_sql_confirm === true;
    const dangerousStmts = listDangerousSqlStatements(statements);
    if (dangerousStmts.length > 0 && !skipDangerConfirm) {
      const confirmed = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: "确认执行高危语句",
          width: 560,
          content: (
            <div>
              <p style={{ marginBottom: 8 }}>
                以下语句可能造成数据或整库不可恢复地丢失，是否仍要执行？
              </p>
              <ul
                style={{
                  paddingLeft: 20,
                  margin: 0,
                  maxHeight: 220,
                  overflow: "auto",
                }}
              >
                {dangerousStmts.map((s, i) => (
                  <li
                    key={i}
                    style={{
                      fontFamily: "monospace",
                      fontSize: 12,
                      wordBreak: "break-all",
                    }}
                  >
                    {s.length > 500 ? `${s.slice(0, 500)}…` : s}
                  </li>
                ))}
              </ul>
            </div>
          ),
          okText: "仍要执行",
          okType: "danger",
          cancelText: "取消",
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
      if (!confirmed) return;
    }

    setExecuting(true);
    if (tabId && connId) {
      setSqlTabResult(connId, tabId, null, null, []);
    } else {
      setLocalError(null);
      setLocalResult(null);
      setLocalExecutedSqlList([]);
    }
    const successfulSql: string[] = [];
    let lastResult: SqlExecuteResult | null = null;
    let execError: string | null = null;

    try {
      for (let i = 0; i < statements.length; i++) {
        const stmt = statements[i];
        const execId = `${tabId ?? "local"}-${Date.now()}-${i}`;
        currentExecutionIdRef.current = execId;
        const res = await api.executeSql(cid, db, stmt, execId);
        successfulSql.push(stmt);
        lastResult = res;
      }
    } catch (e) {
      execError = String(e);
      if (successfulSql.length > 0 && lastResult) {
        // 部分成功，保留已执行的结果
      }
    } finally {
      currentExecutionIdRef.current = null;
      setExecuting(false);
      if (tabId && cid) {
        setSqlTabResult(cid, tabId, lastResult, execError, successfulSql);
      } else {
        setLocalError(execError);
        setLocalResult(lastResult);
        setLocalExecutedSqlList(successfulSql);
      }
    }
  }, [
    tabId,
    connId,
    setSqlTabResult,
    activeConnection?.config.skip_dangerous_sql_confirm,
  ]);

  /** 停止：取消（KILL QUERY）当前正在执行的语句 */
  const handleStop = useCallback(async () => {
    const { connId: cid } = execParamsRef.current;
    const execId = currentExecutionIdRef.current;
    if (!cid || !execId) return;
    try {
      const canceled = await api.cancelQuery(cid, execId);
      if (canceled) {
        message.info("已请求取消当前查询");
      } else {
        message.warning("查询可能已结束，无需取消");
      }
    } catch (e) {
      message.error(`取消查询失败: ${String(e)}`);
    }
  }, []);

  const tabExecuteNonce = useDatabaseStore((s) =>
    tabId ? (s.sqlTabExecuteNonce ?? {})[tabId] ?? 0 : 0
  );
  const tabExecuteNonceSyncedRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    tabExecuteNonceSyncedRef.current = undefined;
  }, [tabId]);

  useEffect(() => {
    if (!tabId || !connId) return;
    const n = tabExecuteNonce;
    const prev = tabExecuteNonceSyncedRef.current;
    if (prev === undefined) {
      tabExecuteNonceSyncedRef.current = n;
      return;
    }
    if (n > prev) {
      tabExecuteNonceSyncedRef.current = n;
      void doExecute();
    }
  }, [tabExecuteNonce, tabId, connId, doExecute]);

  const completionDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const doExecuteRef = useRef<() => void>(() => {});

  useEffect(() => {
    doExecuteRef.current = () => {
      void doExecute();
    };
  }, [doExecute]);

  const handleEditorMount: OnMount = useCallback(
    (ed: editor.IStandaloneCodeEditor, monaco) => {
      editorRef.current = ed;

      ed.addAction({
        id: "execute-sql",
        label: "执行 SQL",
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
        run: () => {
          doExecuteRef.current();
        },
      });

      // 注册 SQL 补全 (按方言提供关键词 + 数据库/表/列，标识符按方言加引号)
      completionDisposableRef.current?.dispose();
      completionDisposableRef.current = registerSqlCompletionProvider(
        monaco,
        async () => ({ ...schemaRef.current }),
        () => ({ dialect: dialectRef.current })
      );
    },
    []
  );

  useEffect(() => {
    return () => {
      completionDisposableRef.current?.dispose();
      completionDisposableRef.current = null;
    };
  }, []);

  // 构建结果表格列
  const resultColumns = useMemo(
    () =>
      result?.columns?.map((col) => ({
        title: col,
        dataIndex: col,
        key: col,
        ellipsis: true,
        width: 160,
        render: (val: unknown) =>
          val === null ? (
            <Text type="secondary" italic style={{ fontSize: 12 }}>
              NULL
            </Text>
          ) : (
            <Text style={{ fontSize: 12 }}>{String(val)}</Text>
          ),
      })) ?? [],
    [result?.columns]
  );

  // 转换结果行
  const resultData = useMemo<Record<string, unknown>[]>(
    () =>
      result?.rows?.map((row, rowIdx) => {
        const record: Record<string, unknown> = { _key: rowIdx };
        result.columns?.forEach((col, colIdx) => {
          record[col] = row[colIdx];
        });
        return record;
      }) ?? [],
    [result?.rows, result?.columns]
  );

  const hasSelectResult =
    result?.result_type === "select" &&
    result.columns !== null &&
    result.columns.length > 0;

  const handleExportSqlExcel = useCallback(async () => {
    if (!result?.columns?.length || !result.rows?.length) {
      message.warning("没有可导出的查询结果");
      return;
    }
    try {
      assertCsvRowWithinLimit(result.rows.length);
      const b64 = await buildQueryResultWorkbookBase64(
        result.columns,
        result.rows,
        "query_result"
      );
      const ok = await saveExcelWithDialog("query_result.xlsx", b64);
      if (ok) message.success("已导出结果为 Excel");
    } catch (e) {
      message.error(String(e));
    }
  }, [result]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 工具栏 */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <Space>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            size="small"
            onClick={doExecute}
            loading={executing}
          >
            执行
          </Button>
          {executing && (
            <Tooltip title="停止当前查询（KILL QUERY）">
              <Button
                danger
                size="small"
                icon={<StopOutlined />}
                onClick={() => void handleStop()}
              >
                停止
              </Button>
            </Tooltip>
          )}
          <Text type="secondary" style={{ fontSize: 11 }}>
            Cmd/Ctrl + Enter
          </Text>
          <Tooltip
            title={!connId || !activeConnection ? "请先建立数据库连接" : "保存当前 SQL"}
          >
            <Button
              type="default"
              size="small"
              icon={<SaveOutlined />}
              onClick={handleSaveSql}
              disabled={!connId || !activeConnection}
            />
          </Tooltip>
          {!tabId && (
            <SavedSqlDropdown
              variant="embedded"
              setEditorSql={(sql) => editorRef.current?.setValue(sql)}
              requestExecute={() => void doExecute()}
            />
          )}
          <Tooltip title="EXPLAIN 当前语句或选中内容">
            <Button
              type="default"
              size="small"
              icon={<FileSearchOutlined />}
              onClick={() => void doExplain(false)}
              disabled={!connId || executing}
            />
          </Tooltip>
          <Tooltip
            title={
              prefetchedVersionLoading
                ? "正在检测数据库版本，请稍候"
                : explainAnalyzeSupported
                ? databaseType === "postgres"
                  ? "EXPLAIN ANALYZE（PostgreSQL）"
                  : "EXPLAIN ANALYZE（MySQL 8.0.18+ / MariaDB 10.7+ 等）"
                : `当前版本「${prefetchedVersion ?? "未知"}」可能不支持 EXPLAIN ANALYZE，请使用左侧 EXPLAIN 或升级实例`
            }
          >
            <Button
              type="default"
              size="small"
              onClick={() => void doExplain(true)}
              disabled={!connId || executing || prefetchedVersionLoading || !explainAnalyzeSupported}
            >
              ANALYZE
            </Button>
          </Tooltip>
          <Tooltip
            title={
              databaseType === "postgres"
                ? "查看 PostgreSQL 版本、连接 ID、只读状态等"
                : "查看 @@version、连接 ID、@@read_only 等"
            }
          >
            <Button
              type="default"
              size="small"
              icon={<InfoCircleOutlined />}
              onClick={openSessionDrawer}
              disabled={!connId}
            />
          </Tooltip>
        </Space>

        <Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            数据库:
          </Text>
          <Select
            size="small"
            value={currentDb}
            onChange={setCurrentDb}
            style={{ width: 180 }}
            allowClear
            placeholder="选择数据库"
            options={databases.map((db) => ({ value: db, label: db }))}
          />
        </Space>
      </div>

      {/* Monaco 编辑器 */}
      <div
        style={{
          flex: "0 0 240px",
          border: "1px solid var(--border-color)",
          borderRadius: 4,
          overflow: "hidden",
          marginBottom: 8,
        }}
      >
        <Editor
          height="240px"
          language="sql"
          theme={themeMode === "dark" ? "vs-dark" : "light"}
          value={tabId ? contentFromStore : undefined}
          defaultValue={tabId ? undefined : ""}
          onChange={tabId ? handleContentChange : undefined}
          onMount={handleEditorMount}
          options={{
            fontSize: 13,
            minimap: { enabled: false },
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            wordWrap: "on",
            automaticLayout: true,
            tabSize: 2,
            suggestOnTriggerCharacters: true,
            quickSuggestions: true,
            contextmenu: false,
          }}
        />
      </div>

      {/* 结果区域 */}
      <div
        ref={resultContainerRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {executing && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              padding: 32,
            }}
          >
            <Spin tip="执行中..." />
          </div>
        )}

        {error && (
          <Alert
            type="error"
            message="执行失败"
            description={error}
            showIcon
            closable
            style={{ marginBottom: 8 }}
          />
        )}

        {result && (
          <>
            {/* 结果头 */}
            <div
              style={{
                padding: "4px 0",
                marginBottom: 4,
                fontSize: 12,
                display: "flex",
                gap: 16,
                alignItems: "center",
                color: "var(--text-secondary)",
                flexShrink: 0,
              }}
            >
              <span>
                <CheckCircleOutlined
                  style={{ color: "#52c41a", marginRight: 4 }}
                />
                {result.message}
              </span>
              <span>
                <ClockCircleOutlined style={{ marginRight: 4 }} />
                {result.execution_time_ms}ms
              </span>
              {hasSelectResult && (
                <Button
                  size="small"
                  type="link"
                  icon={<FileExcelOutlined />}
                  style={{ marginLeft: "auto", paddingInline: 4 }}
                  onClick={() => void handleExportSqlExcel()}
                >
                  导出 Excel
                </Button>
              )}
            </div>

            {/* SELECT / EXPLAIN 结果表格 */}
            {hasSelectResult && (
              <Table
                columns={resultColumns}
                dataSource={resultData}
                rowKey="_key"
                size="small"
                virtual
                pagination={{
                  pageSize: 100,
                  showSizeChanger: true,
                  pageSizeOptions: ["50", "100", "200", "500"],
                  showTotal: (t) => `共 ${t} 行`,
                  size: "small",
                }}
                scroll={{ x: "max-content", y: resultHeight }}
                style={{ fontSize: 12 }}
              />
            )}

            {/* SELECT 返回 0 行 */}
            {result.result_type === "select" &&
              (!result.columns || result.columns.length === 0) && (
                <Empty
                  description="查询成功，返回 0 行数据"
                  style={{ padding: 32 }}
                />
              )}

            {/* DML 结果 */}
            {result.result_type === "modify" && (
              <div
                style={{
                  padding: 16,
                  textAlign: "center",
                  color: "#52c41a",
                  fontSize: 14,
                }}
              >
                影响 {result.affected_rows ?? 0} 行
              </div>
            )}
          </>
        )}

        {/* 已成功执行的 SQL 列表 */}
        {executedSqlList.length > 0 && !executedPreview.isBulk && (
          <div
            style={{
              marginTop: 16,
              paddingTop: 12,
              borderTop: "1px solid var(--border-color)",
              flexShrink: 0,
            }}
          >
            <Text
              type="secondary"
              style={{ fontSize: 12, marginBottom: 8, display: "block" }}
            >
              已成功执行 {executedSqlList.length} 条 SQL:
            </Text>
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                maxHeight: 200,
                overflowY: "auto",
              }}
            >
              {executedSqlList.map((stmt, idx) => (
                <div
                  key={idx}
                  style={{
                    padding: "8px 12px",
                    fontSize: 12,
                    fontFamily: "monospace",
                    backgroundColor: "var(--bg-elevated)",
                    borderRadius: 6,
                    overflowX: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-all",
                  }}
                  title={stmt}
                >
                  <Text type="secondary" style={{ fontSize: 11, marginRight: 8 }}>
                    [{idx + 1}]
                  </Text>
                  <code style={{ fontSize: 12 }}>{stmt}</code>
                </div>
              ))}
            </div>
          </div>
        )}

        {executedSqlList.length > 0 && executedPreview.isBulk && (
          <div
            style={{
              marginTop: 16,
              paddingTop: 12,
              borderTop: "1px solid var(--border-color)",
              flexShrink: 0,
            }}
          >
            <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
              已成功执行 {executedPreview.total} 条 SQL。语句较多时已默认折叠列表，展开后仅展示前{" "}
              {executedPreview.visibleSlice.length} 条以避免界面卡顿。
            </Text>
            <Collapse
              activeKey={bulkExecutedPanelKeys}
              onChange={(keys) =>
                setBulkExecutedPanelKeys(Array.isArray(keys) ? keys : [keys])
              }
              items={[
                {
                  key: "executed-bulk",
                  label: `查看已执行语句（预览 ${executedPreview.visibleSlice.length} / 共 ${executedPreview.total} 条）`,
                  children: (
                    <div
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 6,
                        maxHeight: 280,
                        overflowY: "auto",
                      }}
                    >
                      {executedPreview.visibleSlice.map((stmt, idx) => (
                        <div
                          key={idx}
                          style={{
                            display: "flex",
                            alignItems: "flex-start",
                            gap: 8,
                            padding: "6px 10px",
                            backgroundColor: "var(--bg-elevated)",
                            borderRadius: 6,
                            minWidth: 0,
                          }}
                        >
                          <Text type="secondary" style={{ fontSize: 11, flexShrink: 0 }}>
                            [{idx + 1}]
                          </Text>
                          <Text
                            ellipsis={{ tooltip: stmt }}
                            style={{
                              flex: 1,
                              minWidth: 0,
                              fontSize: 12,
                              fontFamily: "monospace",
                            }}
                          >
                            {stmt}
                          </Text>
                        </div>
                      ))}
                      {executedPreview.hiddenCount > 0 && (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          … 另有 {executedPreview.hiddenCount}{" "}
                          条未在此列出，请在上方面板查看或搜索原始脚本。
                        </Text>
                      )}
                    </div>
                  ),
                },
              ]}
            />
          </div>
        )}

        {/* 空状态 */}
        {!executing && !error && !result && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              flex: 1,
              color: "var(--text-muted)",
              fontSize: 13,
            }}
          >
            输入 SQL 语句并按 Cmd/Ctrl+Enter 执行
          </div>
        )}
      </div>

      {/* 保存 SQL 弹窗 */}
      <Modal
        title="保存 SQL"
        open={saveModalOpen}
        onOk={handleSaveModalOk}
        onCancel={() => {
          setSaveModalOpen(false);
          setSaveModalName("");
        }}
        okText="保存"
        destroyOnHidden
      >
        <div style={{ marginBottom: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            为当前 SQL 起一个名称；将绑定到当前连接，避免在其他连接下误加载。
          </Text>
        </div>
        <Input
          placeholder="例如：查询用户列表"
          value={saveModalName}
          onChange={(e) => setSaveModalName(e.target.value)}
          autoFocus
        />
      </Modal>

      <Drawer
        title="会话信息"
        placement="right"
        width={400}
        open={sessionDrawerOpen}
        onClose={() => {
          setSessionDrawerOpen(false);
          setSessionInfo(null);
        }}
        styles={{ body: { padding: "12px 16px" } }}
      >
        <Spin spinning={sessionLoading}>
          {sessionInfo ? (
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label={databaseType === "postgres" ? "version()" : "@@version"}>
                {sessionInfo.version}
              </Descriptions.Item>
              <Descriptions.Item label={databaseType === "postgres" ? "server_host" : "@@hostname"}>
                {sessionInfo.hostname}
              </Descriptions.Item>
              <Descriptions.Item
                label={databaseType === "postgres" ? "transaction_read_only" : "@@read_only"}
              >
                {sessionInfo.server_read_only ? "是" : "否"}
              </Descriptions.Item>
              <Descriptions.Item label="SHOW GRANTS（可写）">
                {sessionInfo.grant_write_capable ? "是（含 DML/DDL 等）" : "否（仅 SELECT/USAGE 等，界面已按只读灰显）"}
              </Descriptions.Item>
              <Descriptions.Item label="会话查询超时 (ms)">
                {sessionInfo.max_execution_time_ms}
                <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>
                  {databaseType === "postgres"
                    ? "PostgreSQL 当前返回 0（未配置客户端侧统一超时）"
                    : "MySQL: max_execution_time；MariaDB: max_statement_time"}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label={databaseType === "postgres" ? "TimeZone" : "@@time_zone"}>
                {sessionInfo.time_zone}
              </Descriptions.Item>
              <Descriptions.Item label={databaseType === "postgres" ? "current_schema" : "DATABASE()"}>
                {sessionInfo.database ?? "—"}
              </Descriptions.Item>
              <Descriptions.Item label="CONNECTION_ID()">
                {sessionInfo.connection_id}
              </Descriptions.Item>
            </Descriptions>
          ) : !sessionLoading ? (
            <Text type="secondary">暂无数据</Text>
          ) : null}
        </Spin>
      </Drawer>
    </div>
  );
}
