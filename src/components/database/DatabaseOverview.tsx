import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import {
  Typography,
  Tag,
  Empty,
  Spin,
  Button,
  Space,
  Popconfirm,
  Tooltip,
  message,
  Tabs,
} from "antd";
import { SafeInput } from "../common/SafeInput";
import type { ColumnType } from "antd/es/table";
import {
  DatabaseOutlined,
  TableOutlined,
  EyeOutlined,
  PlusOutlined,
  DeleteOutlined,
  ClearOutlined,
  SearchOutlined,
  CloseOutlined,
  StarOutlined,
  StarFilled,
  EditOutlined,
  FunctionOutlined,
  ClockCircleOutlined,
  FilterOutlined,
} from "@ant-design/icons";
import type { InputRef } from "antd";
import { useShallow } from "zustand/react/shallow";
import { useDatabaseStore } from "../../stores/databaseStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useFavoriteStore } from "../../stores/favoriteStore";
import type { TableInfo } from "../../types";
import { CreateTableModal } from "./CreateTableModal";
import { DatabaseEditModal } from "./DatabaseEditModal";
import { DatabaseSqlFileActions } from "./DatabaseSqlFileActions";
import { isSystemDatabase } from "../../utils/systemDatabase";
import { isConnectionGloballyReadOnly } from "../../utils/sqlFileIoUi";
import { formatTruncateTableError } from "../../utils/truncateTableErrors";
import { RoutineList } from "./RoutineList";
import { EventList } from "./EventList";
import { useClientReadOnly } from "../../hooks/useClientReadOnly";
import { useAntTableScrollY } from "../../hooks/useAntTableScrollY";
import { formatBytes } from "../../utils/formatBytes";
import {
  filterLargeIndexTables,
  getTableTotalSize,
  summarizeTableStorage,
} from "../../utils/tableStorageStats";
import { getDatabaseCapabilities } from "../../utils/databaseCapabilities";
import {
  DEFAULT_TABLE_LIST_COLUMN_ORDER,
  DEFAULT_TABLE_LIST_COLUMN_WIDTHS,
  filterTables,
  getTableListCellText,
} from "../../utils/databaseOverviewUtils";
import { SortableListTable } from "../common/SortableListTable";
import { useListTableSettings } from "../../hooks/useListTableSettings";
import {
  buildOrderedListColumns,
  LIST_TABLE_IDS,
} from "../../utils/listTableColumns";
import { createListColumnAutoFit } from "../../utils/columnAutoFitWidth";
import { favoriteConnectionKey } from "../../utils/favoriteConnection";

const { Title, Text } = Typography;

function favoriteTableKey(
  connectionId: string,
  database: string,
  table: string
): string {
  return `${connectionId}\n${database}\n${table}`;
}

export function DatabaseOverview() {
  const {
    selectedDatabase,
    tables,
    treeLoading,
    selectTable,
    createTable,
    dropTable,
    truncateTable,
    dropDatabase,
    refresh,
  } = useDatabaseStore(
    useShallow((s) => ({
      selectedDatabase: s.selectedDatabase,
      tables: s.tables,
      treeLoading: s.treeLoading,
      selectTable: s.selectTable,
      createTable: s.createTable,
      dropTable: s.dropTable,
      truncateTable: s.truncateTable,
      dropDatabase: s.dropDatabase,
      refresh: s.refresh,
    }))
  );
  const activeConnection = useConnectionStore((s) => s.activeConnection);
  const databaseType = activeConnection?.config.database_type;
  const capabilities = useMemo(
    () => getDatabaseCapabilities(databaseType),
    [databaseType]
  );
  const favorites = useFavoriteStore((s) => s.favorites);
  const toggleFavorite = useFavoriteStore((s) => s.toggleFavorite);
  const connId = activeConnection?.connId ?? "";
  const connectionId = activeConnection
    ? favoriteConnectionKey(activeConnection.config)
    : "";
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editDbModalOpen, setEditDbModalOpen] = useState(false);
  const [messageApi, contextHolder] = message.useMessage();
  const systemDb = selectedDatabase
    ? isSystemDatabase(selectedDatabase)
    : false;
  const [instanceReadOnly, setInstanceReadOnly] = useState(false);
  const clientReadOnly = useClientReadOnly();
  const writeBlocked = clientReadOnly || instanceReadOnly;
  const favoriteTableKeys = useMemo(
    () =>
      new Set(
        favorites.map((f) =>
          favoriteTableKey(f.connectionId, f.database, f.table)
        )
      ),
    [favorites]
  );
  const {
    getColumnWidth,
    handleColumnResize,
    scrollX: tableListScrollX,
    columnOrder: tableListColumnOrder,
    sortableColumnIds,
    dnd: tableListDnd,
  } = useListTableSettings({
    listId: LIST_TABLE_IDS.DATABASE_TABLE_LIST,
    defaultWidths: DEFAULT_TABLE_LIST_COLUMN_WIDTHS,
    defaultOrder: DEFAULT_TABLE_LIST_COLUMN_ORDER,
  });

  useEffect(() => {
    let cancelled = false;
    if (
      !connId ||
      !selectedDatabase ||
      !(
        capabilities.databaseManagement ||
        capabilities.schemaManagement ||
        capabilities.sqlFileImportExport
      )
    ) {
      setInstanceReadOnly(false);
      return;
    }
    void (async () => {
      try {
        const ro = await isConnectionGloballyReadOnly(
          connId,
          selectedDatabase,
          databaseType
        );
        if (!cancelled) setInstanceReadOnly(ro);
      } catch {
        if (!cancelled) setInstanceReadOnly(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    connId,
    selectedDatabase,
    capabilities.databaseManagement,
    capabilities.schemaManagement,
    capabilities.sqlFileImportExport,
    databaseType,
  ]);

  // 搜索状态
  const [searchVisible, setSearchVisible] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState("");
  const [largeIndexOnly, setLargeIndexOnly] = useState(false);
  const searchInputRef = useRef<InputRef>(null);
  /** 数据库视图：表列表 | 例程 | 事件 */
  const [dbOverviewTab, setDbOverviewTab] = useState<
    "tables" | "routines" | "events"
  >("tables");
  const overviewListRemeasureKey = `${dbOverviewTab}|${selectedDatabase ?? ""}`;
  const { containerRef: tableListContainerRef, scrollY: tableListScrollY } =
    useAntTableScrollY({ remeasureKey: overviewListRemeasureKey });

  // Cmd/Ctrl+F 打开搜索, Escape 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchVisible(true);
        setTimeout(() => searchInputRef.current?.focus(), 50);
      }
      if (e.key === "Escape" && searchVisible) {
        setSearchVisible(false);
        setSearchKeyword("");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [searchVisible]);

  const handleCloseSearch = useCallback(() => {
    setSearchVisible(false);
    setSearchKeyword("");
  }, []);

  const handleDropTable = useCallback(
    async (tableName: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!connId || !selectedDatabase) return;
      if (clientReadOnly) {
        messageApi.warning("当前连接在配置中标记为只读，无法删除表。");
        return;
      }
      if (instanceReadOnly) {
        messageApi.warning(
          "实例处于只读（read_only / super_read_only），无法删除表。"
        );
        return;
      }
      try {
        await dropTable(connId, selectedDatabase, tableName);
        messageApi.success(`表 "${tableName}" 已删除`);
      } catch (err) {
        messageApi.error(
          `删除表失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
    [
      connId,
      selectedDatabase,
      dropTable,
      messageApi,
      clientReadOnly,
      instanceReadOnly,
    ]
  );

  const handleTruncateTable = useCallback(
    async (tableName: string, e: React.MouseEvent) => {
      e.stopPropagation();
      if (!connId || !selectedDatabase) return;
      if (clientReadOnly) {
        messageApi.warning("当前连接在配置中标记为只读，无法 TRUNCATE。");
        return;
      }
      if (
        await isConnectionGloballyReadOnly(
          connId,
          selectedDatabase,
          databaseType
        )
      ) {
        messageApi.warning(
          databaseType === "postgres"
            ? "当前 PostgreSQL 会话处于只读模式，无法执行 TRUNCATE。请切换到可写连接或调整事务只读设置。"
            : "实例处于只读（read_only / super_read_only），无法执行 TRUNCATE。请在可写主库或副本上操作。"
        );
        return;
      }
      try {
        await truncateTable(connId, selectedDatabase, tableName);
        messageApi.success(`表 "${tableName}" 已清空`);
      } catch (err) {
        messageApi.error({
          content: formatTruncateTableError(err),
          duration: 8,
        });
      }
    },
    [
      connId,
      selectedDatabase,
      databaseType,
      truncateTable,
      messageApi,
      clientReadOnly,
    ]
  );

  const columnDefinitions = useMemo<Record<string, ColumnType<TableInfo>>>(
    () => ({
      name: {
        title: "表名",
        dataIndex: "name",
        ellipsis: true,
        sorter: (a: TableInfo, b: TableInfo) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
        sortDirections: ["ascend", "descend"],
        render: (name: string, record: TableInfo) => (
          <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {record.table_type === "VIEW" ? (
              <EyeOutlined style={{ color: "#faad14" }} />
            ) : (
              <TableOutlined style={{ color: "#52c41a" }} />
            )}
            <Text strong>{name}</Text>
          </span>
        ),
      },
      table_type: {
        title: "类型",
        dataIndex: "table_type",
        render: (type: string) => (
          <Tag color={type === "VIEW" ? "orange" : "blue"}>{type}</Tag>
        ),
      },
      engine: {
        title: "引擎",
        dataIndex: "engine",
        render: (engine: string | null) => engine ?? "-",
      },
      rows: {
        title: "行数",
        dataIndex: "rows",
        align: "right",
        sorter: (a: TableInfo, b: TableInfo) => {
          const ra = a.rows ?? -1;
          const rb = b.rows ?? -1;
          return ra - rb;
        },
        sortDirections: ["descend", "ascend"],
        render: (rows: number | null) =>
          rows !== null ? rows.toLocaleString() : "-",
      },
      data_length: {
        title: "数据大小",
        dataIndex: "data_length",
        align: "right",
        sorter: (a: TableInfo, b: TableInfo) => {
          const sa = a.data_length ?? -1;
          const sb = b.data_length ?? -1;
          return sa - sb;
        },
        sortDirections: ["descend", "ascend"],
        render: (size: number | null) => formatBytes(size),
      },
      index_length: {
        title: "索引容量",
        dataIndex: "index_length",
        align: "right",
        sorter: (a: TableInfo, b: TableInfo) => {
          const sa = a.index_length ?? -1;
          const sb = b.index_length ?? -1;
          return sa - sb;
        },
        sortDirections: ["descend", "ascend"],
        render: (size: number | null) => formatBytes(size),
      },
      total_size: {
        title: "总占用",
        align: "right",
        sorter: (a: TableInfo, b: TableInfo) => {
          const sa = getTableTotalSize(a) ?? -1;
          const sb = getTableTotalSize(b) ?? -1;
          return sa - sb;
        },
        sortDirections: ["descend", "ascend"],
        defaultSortOrder: "descend",
        render: (_: unknown, record: TableInfo) =>
          formatBytes(getTableTotalSize(record)),
      },
      comment: {
        title: "注释",
        dataIndex: "comment",
        ellipsis: true,
        render: (comment: string) =>
          comment ? (
            <Text type="secondary">{comment}</Text>
          ) : (
            <Text type="secondary">-</Text>
          ),
      },
      action: {
        title: "操作",
        align: "center",
        render: (_: unknown, record: TableInfo) => {
          const fav = favoriteTableKeys.has(
            favoriteTableKey(connectionId, selectedDatabase ?? "", record.name)
          );
          const isTable = record.table_type !== "VIEW";
          return (
            <Space size={4} onClick={(e) => e.stopPropagation()}>
              {capabilities.favoriteTables && (
                <Tooltip title={fav ? "取消收藏" : "收藏"}>
                  <Button
                    type="text"
                    size="small"
                    icon={
                      fav ? (
                        <StarFilled
                          style={{ color: "#faad14", fontSize: 14 }}
                        />
                      ) : (
                        <StarOutlined
                          style={{
                            color: "var(--text-secondary)",
                            fontSize: 14,
                          }}
                        />
                      )
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      if (selectedDatabase) {
                        toggleFavorite({
                          connectionId,
                          database: selectedDatabase,
                          table: record.name,
                        });
                      }
                    }}
                  />
                </Tooltip>
              )}
              {capabilities.schemaManagement &&
                isTable &&
                (writeBlocked ? (
                  <Tooltip
                    title={
                      clientReadOnly
                        ? "当前连接为只读配置，无法 TRUNCATE"
                        : "只读实例无法 TRUNCATE"
                    }
                  >
                    <span onClick={(e) => e.stopPropagation()}>
                      <Button
                        type="text"
                        size="small"
                        icon={<ClearOutlined />}
                        disabled
                        aria-label={`清空表 ${record.name}`}
                      />
                    </span>
                  </Tooltip>
                ) : (
                  <Popconfirm
                    title="确认清空表"
                    description={`将清空表「${record.name}」的全部数据行且不可恢复；表结构保留。是否继续？`}
                    onConfirm={(e) =>
                      handleTruncateTable(
                        record.name,
                        e as unknown as React.MouseEvent
                      )
                    }
                    onCancel={(e) => e?.stopPropagation()}
                    okText="清空"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    getPopupContainer={() => document.body}
                  >
                    <Tooltip title="清空表">
                      <Button
                        type="text"
                        size="small"
                        icon={<ClearOutlined />}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`清空表 ${record.name}`}
                      />
                    </Tooltip>
                  </Popconfirm>
                ))}
              {capabilities.schemaManagement &&
                (writeBlocked ? (
                  <Tooltip
                    title={
                      clientReadOnly
                        ? "当前连接为只读配置，无法删除表"
                        : "只读实例无法删除表"
                    }
                  >
                    <span onClick={(e) => e.stopPropagation()}>
                      <Button
                        type="text"
                        danger
                        size="small"
                        icon={<DeleteOutlined />}
                        disabled
                      />
                    </span>
                  </Tooltip>
                ) : (
                  <Popconfirm
                    title="确认删除"
                    description={`确定要删除表 "${record.name}" 吗？此操作不可恢复！`}
                    onConfirm={(e) =>
                      handleDropTable(
                        record.name,
                        e as unknown as React.MouseEvent
                      )
                    }
                    onCancel={(e) => e?.stopPropagation()}
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                  >
                    <Tooltip title="删除表">
                      <Button
                        type="text"
                        danger
                        size="small"
                        icon={<DeleteOutlined />}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </Tooltip>
                  </Popconfirm>
                ))}
            </Space>
          );
        },
      },
    }),
    [
      handleDropTable,
      handleTruncateTable,
      writeBlocked,
      clientReadOnly,
      capabilities.favoriteTables,
      capabilities.schemaManagement,
      connectionId,
      selectedDatabase,
      favoriteTableKeys,
      toggleFavorite,
    ]
  );

  const tableList = useMemo(
    () => (selectedDatabase ? (tables[selectedDatabase] ?? []) : []),
    [selectedDatabase, tables]
  );
  const storageSummary = useMemo(
    () => summarizeTableStorage(tableList),
    [tableList]
  );
  const filteredList = useMemo(() => {
    const searched = filterTables(tableList, searchKeyword);
    return largeIndexOnly ? filterLargeIndexTables(searched) : searched;
  }, [tableList, searchKeyword, largeIndexOnly]);

  const getAutoFitWidth = useMemo(
    () =>
      createListColumnAutoFit(
        columnDefinitions,
        filteredList,
        getTableListCellText,
        {
          sortableHeaders: true,
          headerLabels: {
            name: "表名",
            table_type: "类型",
            engine: "引擎",
            rows: "行数",
            data_length: "数据大小",
            index_length: "索引容量",
            total_size: "总占用",
            comment: "注释",
            action: "操作",
          },
          minWidths: { action: DEFAULT_TABLE_LIST_COLUMN_WIDTHS.action },
        }
      ),
    [columnDefinitions, filteredList]
  );

  const columns = useMemo(
    () =>
      buildOrderedListColumns(
        columnDefinitions,
        tableListColumnOrder,
        getColumnWidth,
        handleColumnResize,
        { sortableHeaders: true, getAutoFitWidth }
      ),
    [
      columnDefinitions,
      tableListColumnOrder,
      getColumnWidth,
      handleColumnResize,
      getAutoFitWidth,
    ]
  );

  const handleRowClick = useCallback(
    (record: TableInfo) => {
      if (connId && selectedDatabase) {
        selectTable(connId, selectedDatabase, record.name);
      }
    },
    [connId, selectedDatabase, selectTable]
  );

  const handleEditDbSuccess = useCallback(async () => {
    setEditDbModalOpen(false);
    if (connId) {
      await refresh(connId);
    }
  }, [connId, refresh]);

  const handleDropDatabase = useCallback(async () => {
    if (!connId || !selectedDatabase || systemDb) return;
    const objectNoun = capabilities.databaseObjectNoun;
    if (clientReadOnly) {
      messageApi.warning(`当前连接在配置中标记为只读，无法删除${objectNoun}。`);
      return;
    }
    if (instanceReadOnly) {
      messageApi.warning(
        databaseType === "postgres"
          ? `当前 PostgreSQL 会话处于只读模式，无法删除${objectNoun}。`
          : `实例处于只读（read_only / super_read_only），无法删除${objectNoun}。`
      );
      return;
    }
    try {
      await dropDatabase(connId, selectedDatabase);
      messageApi.success(`${objectNoun}「${selectedDatabase}」已删除`);
    } catch (err) {
      messageApi.error(err instanceof Error ? err.message : String(err));
    }
  }, [
    connId,
    selectedDatabase,
    systemDb,
    dropDatabase,
    messageApi,
    clientReadOnly,
    instanceReadOnly,
    capabilities.databaseObjectNoun,
    databaseType,
  ]);

  if (!selectedDatabase) {
    return null;
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {contextHolder}

      <Tabs
        activeKey={dbOverviewTab}
        onChange={(k) =>
          setDbOverviewTab(k as "tables" | "routines" | "events")
        }
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
        className="full-height-tabs"
        items={[
          {
            key: "tables",
            label: (
              <span>
                <TableOutlined />表
              </span>
            ),
            children: (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  height: "100%",
                  minHeight: 0,
                }}
              >
                <div style={{ marginBottom: 16 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 4,
                    }}
                  >
                    <Space size={8}>
                      <DatabaseOutlined
                        style={{ fontSize: 20, color: "#1677ff" }}
                      />
                      <Title
                        level={4}
                        style={{ margin: 0, color: "var(--text-primary)" }}
                      >
                        {selectedDatabase}
                      </Title>
                    </Space>
                    <Space size={8}>
                      <Tooltip title="搜索表 (⌘F / Ctrl+F)">
                        <Button
                          type="text"
                          size="small"
                          icon={<SearchOutlined />}
                          onClick={() => {
                            setSearchVisible(true);
                            setTimeout(
                              () => searchInputRef.current?.focus(),
                              50
                            );
                          }}
                        />
                      </Tooltip>
                      <Tooltip title="仅显示索引容量偏大或索引超过数据容量的表">
                        <Button
                          type={largeIndexOnly ? "primary" : "default"}
                          size="small"
                          icon={<FilterOutlined />}
                          onClick={() => setLargeIndexOnly((v) => !v)}
                        >
                          大索引
                        </Button>
                      </Tooltip>
                      {capabilities.sqlFileImportExport && (
                        <DatabaseSqlFileActions
                          connId={connId}
                          database={selectedDatabase}
                          disabled={!connId || writeBlocked}
                        />
                      )}
                      {capabilities.databaseManagement && (
                        <Tooltip
                          title={
                            !connId
                              ? "请先连接"
                              : writeBlocked
                                ? clientReadOnly
                                  ? `只读连接无法修改${capabilities.databaseObjectNoun}属性`
                                  : `只读实例下无法修改${capabilities.databaseObjectNoun}属性`
                                : capabilities.charsetAndCollation
                                  ? `编辑${capabilities.databaseObjectNoun}（名称、字符集）`
                                  : `编辑${capabilities.databaseObjectNoun}（仅名称）`
                          }
                        >
                          <Button
                            type="default"
                            size="small"
                            icon={<EditOutlined />}
                            disabled={!connId || writeBlocked}
                            onClick={() => setEditDbModalOpen(true)}
                          />
                        </Tooltip>
                      )}
                      {capabilities.databaseManagement &&
                        (writeBlocked ? (
                          <Tooltip
                            title={
                              systemDb
                                ? `系统${capabilities.databaseObjectNoun}不可删除`
                                : !connId
                                  ? "请先连接"
                                  : clientReadOnly
                                    ? `只读连接无法删除${capabilities.databaseObjectNoun}`
                                    : `只读实例无法删除${capabilities.databaseObjectNoun}`
                            }
                          >
                            <span>
                              <Button
                                type="default"
                                danger
                                size="small"
                                icon={<DeleteOutlined />}
                                disabled={!connId || systemDb || writeBlocked}
                              />
                            </span>
                          </Tooltip>
                        ) : (
                          <Popconfirm
                            title={`删除${capabilities.databaseObjectNoun}`}
                            description={`确定删除${capabilities.databaseObjectNoun}「${selectedDatabase}」吗？将删除其中所有表与数据，且不可恢复。`}
                            okText="删除"
                            cancelText="取消"
                            okButtonProps={{ danger: true }}
                            onConfirm={() => void handleDropDatabase()}
                          >
                            <Tooltip
                              title={
                                systemDb
                                  ? `系统${capabilities.databaseObjectNoun}不可删除`
                                  : !connId
                                    ? "请先连接"
                                    : `删除当前${capabilities.databaseObjectNoun}`
                              }
                            >
                              <span>
                                <Button
                                  type="default"
                                  danger
                                  size="small"
                                  icon={<DeleteOutlined />}
                                  disabled={!connId || systemDb}
                                />
                              </span>
                            </Tooltip>
                          </Popconfirm>
                        ))}
                      {capabilities.schemaManagement && (
                        <Tooltip
                          title={
                            writeBlocked
                              ? clientReadOnly
                                ? "只读连接无法新建表"
                                : "只读实例无法新建表"
                              : undefined
                          }
                        >
                          <Button
                            type="primary"
                            icon={<PlusOutlined />}
                            size="small"
                            disabled={writeBlocked}
                            onClick={() => setCreateModalOpen(true)}
                          >
                            新建表
                          </Button>
                        </Tooltip>
                      )}
                    </Space>
                  </div>

                  {searchVisible && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginBottom: 4,
                        marginTop: 4,
                      }}
                    >
                      <SafeInput
                        ref={searchInputRef}
                        prefix={
                          <SearchOutlined
                            style={{ color: "var(--text-secondary)" }}
                          />
                        }
                        placeholder="搜索表名或注释..."
                        value={searchKeyword}
                        onChange={(e) => setSearchKeyword(e.target.value)}
                        allowClear
                        size="small"
                        style={{ flex: 1 }}
                      />
                      <Button
                        type="text"
                        size="small"
                        icon={<CloseOutlined />}
                        onClick={handleCloseSearch}
                      />
                    </div>
                  )}

                  {tableList.length > 0 && (
                    <Space
                      size={16}
                      wrap
                      style={{ marginTop: 4, marginBottom: 4 }}
                    >
                      <Text type="secondary">
                        数据合计: {formatBytes(storageSummary.totalDataLength)}
                      </Text>
                      <Text type="secondary">
                        索引合计: {formatBytes(storageSummary.totalIndexLength)}
                      </Text>
                      <Text type="secondary">
                        总占用: {formatBytes(storageSummary.totalSize)}
                      </Text>
                    </Space>
                  )}

                  <Text type="secondary">
                    {searchKeyword.trim() || largeIndexOnly
                      ? `找到 ${filteredList.length} / ${tableList.length} 个表/视图${
                          largeIndexOnly ? "（大索引筛选）" : ""
                        }`
                      : `共 ${tableList.length} 个表/视图，点击表名查看详情`}
                  </Text>
                </div>

                <div
                  ref={tableListContainerRef}
                  style={{ flex: 1, minHeight: 0, overflow: "hidden" }}
                >
                  <Spin spinning={treeLoading && tableList.length === 0}>
                    {tableList.length > 0 ? (
                      <SortableListTable<TableInfo>
                        className="database-table-list"
                        columns={columns}
                        dataSource={filteredList}
                        rowKey="name"
                        size="small"
                        pagination={false}
                        virtual
                        sortableColumnIds={sortableColumnIds}
                        sensors={tableListDnd.sensors}
                        onColumnDragEnd={tableListDnd.onDragEnd}
                        onRow={(record) => ({
                          onClick: () => handleRowClick(record),
                          style: { cursor: "pointer" },
                          title: record.comment || "无注释",
                        })}
                        scroll={{
                          x: tableListScrollX,
                          y: tableListScrollY ?? 320,
                        }}
                      />
                    ) : (
                      !treeLoading && (
                        <Empty
                          description="该数据库中没有表"
                          style={{ marginTop: 64 }}
                        />
                      )
                    )}
                  </Spin>
                </div>
              </div>
            ),
          },
          ...(capabilities.routineManagement
            ? [
                {
                  key: "routines",
                  label: (
                    <span>
                      <FunctionOutlined />
                      例程
                    </span>
                  ),
                  children: (
                    <div
                      style={{
                        height: "100%",
                        display: "flex",
                        flexDirection: "column",
                        minHeight: 0,
                        overflow: "hidden",
                      }}
                    >
                      <Space style={{ marginBottom: 8, flexShrink: 0 }}>
                        <DatabaseOutlined />
                        <Title level={5} style={{ margin: 0 }}>
                          {selectedDatabase}
                        </Title>
                        <Text type="secondary">存储过程与函数</Text>
                      </Space>
                      <RoutineList remeasureKey={overviewListRemeasureKey} />
                    </div>
                  ),
                },
              ]
            : []),
          ...(capabilities.eventManagement
            ? [
                {
                  key: "events",
                  label: (
                    <span>
                      <ClockCircleOutlined />
                      事件
                    </span>
                  ),
                  children: (
                    <div
                      style={{
                        height: "100%",
                        display: "flex",
                        flexDirection: "column",
                        minHeight: 0,
                        overflow: "hidden",
                      }}
                    >
                      <Space style={{ marginBottom: 8, flexShrink: 0 }}>
                        <DatabaseOutlined />
                        <Title level={5} style={{ margin: 0 }}>
                          {selectedDatabase}
                        </Title>
                        <Text type="secondary">定时事件（EVENT）</Text>
                      </Space>
                      <EventList remeasureKey={overviewListRemeasureKey} />
                    </div>
                  ),
                },
              ]
            : []),
        ]}
      />

      {/* 新建表对话框 */}
      {capabilities.schemaManagement && (
        <CreateTableModal
          open={createModalOpen}
          onCancel={() => setCreateModalOpen(false)}
          onSuccess={() => {
            setCreateModalOpen(false);
            messageApi.success("表创建成功");
          }}
          connId={connId}
          database={selectedDatabase}
          onCreateTable={createTable}
        />
      )}
      {capabilities.databaseManagement && (
        <DatabaseEditModal
          open={editDbModalOpen}
          database={selectedDatabase}
          connId={connId}
          onClose={() => setEditDbModalOpen(false)}
          onSuccess={handleEditDbSuccess}
        />
      )}
    </div>
  );
}
