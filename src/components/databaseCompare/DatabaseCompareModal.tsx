import { SwapOutlined } from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Result,
  Segmented,
  Select,
  Statistic,
  Table,
  Tag,
  message,
} from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ColumnsType } from "antd/es/table";
import * as api from "../../services/tauriCommands";
import { useConnectionStore } from "../../stores/connectionStore";
import type {
  ColumnDiff,
  DatabaseCompareResult,
  SchemaDiffStatus,
  TableDiff,
} from "../../types";
import { normalizeDatabaseType } from "../../utils/connectionConfig";
import {
  filterTableDiffs,
  formatChangedFields,
  formatColumnSideValues,
  formatSchemaDiffStatus,
} from "../../utils/databaseCompare";
import { saveDatabaseCompareWorkbook } from "../../utils/databaseCompareExport";
import "./DatabaseCompareModal.css";

export interface DatabaseCompareModalProps {
  open: boolean;
  onClose: () => void;
}

type LoadingSide = "source" | "target" | null;
type StatusFilter = "all" | SchemaDiffStatus;

const STATUS_TAG_COLORS: Record<SchemaDiffStatus, string> = {
  source_only: "gold",
  target_only: "blue",
  changed: "purple",
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function DiffStatusTag({ status }: { status: SchemaDiffStatus }) {
  return (
    <Tag color={STATUS_TAG_COLORS[status]}>
      {formatSchemaDiffStatus(status)}
    </Tag>
  );
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
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<DatabaseCompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [search, setSearch] = useState("");

  const sourceLoadId = useRef(0);
  const targetLoadId = useRef(0);
  const compareId = useRef(0);
  const exportId = useRef(0);

  const resetResult = useCallback(() => {
    compareId.current += 1;
    exportId.current += 1;
    setComparing(false);
    setExporting(false);
    setResult(null);
    setError(null);
    setStatusFilter("all");
    setSearch("");
  }, []);

  const resetState = useCallback(() => {
    sourceLoadId.current += 1;
    targetLoadId.current += 1;
    compareId.current += 1;
    exportId.current += 1;
    setSourceConnectionId(undefined);
    setTargetConnectionId(undefined);
    setSourceDatabase(undefined);
    setTargetDatabase(undefined);
    setSourceDatabases([]);
    setTargetDatabases([]);
    setLoadingSide(null);
    setComparing(false);
    setExporting(false);
    setResult(null);
    setError(null);
    setStatusFilter("all");
    setSearch("");
  }, []);

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
      try {
        const databases = await api.listCompareDatabases(connectionId);
        if (requestRef.current !== requestId) return;
        if (side === "source") setSourceDatabases(databases);
        else setTargetDatabases(databases);
      } catch (requestError) {
        if (requestRef.current !== requestId) return;
        if (side === "source") setSourceDatabases([]);
        else setTargetDatabases([]);
        setError(
          `加载${side === "source" ? "源端" : "目标端"}数据库/schema 失败：${errorMessage(requestError)}`
        );
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
      !targetDatabase
    ) {
      return;
    }
    const requestId = ++compareId.current;
    setComparing(true);
    setError(null);
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
        setError(`数据库对比失败：${errorMessage(compareError)}`);
      }
    } finally {
      if (compareId.current === requestId) setComparing(false);
    }
  }, [sourceConnectionId, sourceDatabase, targetConnectionId, targetDatabase]);

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
    if (!sourceConnectionId || !targetConnectionId) return;
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
    sourceConnectionId,
    sourceDatabase,
    sourceDatabases,
    targetConnectionId,
    targetDatabase,
    targetDatabases,
  ]);

  const handleClose = useCallback(() => {
    resetState();
    onClose();
  }, [onClose, resetState]);

  const filteredTables = useMemo(
    () => (result ? filterTableDiffs(result.tables, statusFilter, search) : []),
    [result, search, statusFilter]
  );

  const columnColumns = useMemo<ColumnsType<ColumnDiff>>(
    () => [
      { title: "字段名", dataIndex: "name", key: "name", width: 160 },
      {
        title: "差异状态",
        dataIndex: "status",
        key: "status",
        width: 120,
        render: (status: SchemaDiffStatus) => <DiffStatusTag status={status} />,
      },
      {
        title: "变化属性",
        dataIndex: "changed_fields",
        key: "changed_fields",
        width: 180,
        render: (fields: ColumnDiff["changed_fields"]) =>
          formatChangedFields(fields),
      },
      {
        title: "源端值",
        key: "source",
        width: 300,
        render: (_value, column) => formatColumnSideValues(column, "source"),
      },
      {
        title: "目标端值",
        key: "target",
        width: 300,
        render: (_value, column) => formatColumnSideValues(column, "target"),
      },
    ],
    []
  );

  const tableColumns = useMemo<ColumnsType<TableDiff>>(
    () => [
      { title: "表名", dataIndex: "name", key: "name" },
      {
        title: "差异状态",
        dataIndex: "status",
        key: "status",
        width: 140,
        render: (status: SchemaDiffStatus) => <DiffStatusTag status={status} />,
      },
    ],
    []
  );

  const startDisabled =
    !sourceConnectionId ||
    !sourceDatabase ||
    !targetConnectionId ||
    !targetDatabase ||
    loadingSide !== null ||
    comparing;
  const exportDisabled = !result || comparing || exporting;

  return (
    <Modal
      title="数据库结构对比"
      open={open}
      onCancel={handleClose}
      width={1120}
      destroyOnHidden
      footer={[
        <Button key="close" aria-label="关闭" onClick={handleClose}>
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
        <Button
          key="compare"
          type="primary"
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
                  disabled={!sourceConnectionId}
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
            disabled={!sourceConnectionId || !targetConnectionId}
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
                  disabled={!sourceConnectionId}
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
                  disabled={!targetConnectionId}
                  loading={loadingSide === "target"}
                  placeholder="请选择数据库/schema"
                  showSearch
                  virtual={false}
                />
              </Form.Item>
            </Form>
          </Card>
        </div>

        {error && (
          <Alert
            type="error"
            showIcon
            message={error}
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
                >
                  重试
                </Button>
              ) : undefined
            }
          />
        )}

        {result && (
          <div className="database-compare-results">
            <div className="database-compare-summary">
              <Statistic
                title="仅源端表"
                value={result.summary.source_only_tables}
              />
              <Statistic
                title="仅目标端表"
                value={result.summary.target_only_tables}
              />
              <Statistic
                title="结构变化表"
                value={result.summary.changed_tables}
              />
              <Statistic
                title="差异字段"
                value={result.summary.different_columns}
              />
            </div>

            {result.tables.length === 0 ? (
              <Result status="success" title="两个数据库结构一致" />
            ) : (
              <>
                <div className="database-compare-toolbar">
                  <Input.Search
                    aria-label="搜索表名"
                    allowClear
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索表名"
                  />
                  <Segmented<StatusFilter>
                    aria-label="差异状态筛选"
                    value={statusFilter}
                    onChange={setStatusFilter}
                    options={[
                      { label: "全部", value: "all" },
                      { label: "仅源端", value: "source_only" },
                      { label: "仅目标端", value: "target_only" },
                      { label: "结构变化", value: "changed" },
                    ]}
                  />
                </div>
                <div className="database-compare-table-wrap">
                  <Table<TableDiff>
                    rowKey="name"
                    size="small"
                    pagination={false}
                    columns={tableColumns}
                    dataSource={filteredTables}
                    scroll={{ x: 520 }}
                    expandable={{
                      rowExpandable: (table) => table.status === "changed",
                      expandedRowRender: (table) => (
                        <div className="database-compare-expanded-table">
                          <Table<ColumnDiff>
                            rowKey="name"
                            size="small"
                            pagination={false}
                            columns={columnColumns}
                            dataSource={table.columns}
                            scroll={{ x: 1060 }}
                          />
                        </div>
                      ),
                    }}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
