import { useEffect, useCallback, useState, useMemo, useRef } from "react";
import {
  Tree,
  Button,
  Typography,
  Space,
  Spin,
  Tooltip,
  Dropdown,
  Tabs,
} from "antd";
import type { MenuProps } from "antd";
import {
  DatabaseOutlined,
  TableOutlined,
  EyeOutlined,
  ReloadOutlined,
  ArrowLeftOutlined,
  DisconnectOutlined,
  EditOutlined,
  SortAscendingOutlined,
  SortDescendingOutlined,
  StarOutlined,
  StarFilled,
  PlusOutlined,
  CodeOutlined,
} from "@ant-design/icons";
import type { DataNode, EventDataNode } from "antd/es/tree";
import { useDatabaseStore } from "../../stores/databaseStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useTableDataStore } from "../../stores/tableDataStore";
import { useFavoriteStore } from "../../stores/favoriteStore";
import { DatabaseEditModal } from "./DatabaseEditModal";
import { DatabaseCreateModal } from "./DatabaseCreateModal";
import { FavoriteTables } from "./FavoriteTables";
import { SavedSqlDropdown } from "./SavedSqlDropdown";
import { useClientReadOnly } from "../../hooks/useClientReadOnly";
import { getDatabaseCapabilities } from "../../utils/databaseCapabilities";
import { favoriteConnectionKey } from "../../utils/favoriteConnection";

const { Text, Title } = Typography;

function favoriteTableKey(
  connectionId: string,
  database: string,
  table: string
): string {
  return `${connectionId}\n${database}\n${table}`;
}

export function DatabaseTree() {
  const {
    activeConnection,
    activeConnections,
    activeConnId,
    disconnect,
    switchActive,
    showNewConnectionForm,
  } = useConnectionStore();
  const {
    databases,
    tables,
    selectedDatabase,
    selectedTable,
    openTabs,
    treeLoading,
    databaseSortOrder,
    tableSortOrder,
    loadDatabases,
    loadTables,
    selectDatabase,
    selectTable,
    closeTab,
    refresh,
    expandedKeys,
    setExpandedKeys,
    setDatabaseSortOrder,
    setTableSortOrder,
    connectionStates,
    openSqlTab,
  } = useDatabaseStore();
  const { removeTableFromCache } = useTableDataStore();

  const connId = activeConnection?.connId ?? "";
  const connectionId = activeConnection
    ? favoriteConnectionKey(activeConnection.config)
    : "";
  const favorites = useFavoriteStore((s) => s.favorites);
  const toggleFavorite = useFavoriteStore((s) => s.toggleFavorite);
  const clientReadOnly = useClientReadOnly();
  const capabilities = useMemo(
    () => getDatabaseCapabilities(activeConnection?.config.database_type),
    [activeConnection?.config.database_type]
  );
  const favoriteTableKeys = useMemo(
    () =>
      new Set(
        favorites.map((f) =>
          favoriteTableKey(f.connectionId, f.database, f.table)
        )
      ),
    [favorites]
  );

  // 树容器高度 (用于虚拟滚动)
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const [treeHeight, setTreeHeight] = useState(400);
  // Shift+点击时用于关闭已打开的表 tab
  const lastMouseDownShiftRef = useRef(false);

  useEffect(() => {
    const container = treeContainerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const height = Math.max(entry.contentRect.height - 8, 200);
      requestAnimationFrame(() => setTreeHeight(height));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // 右键菜单状态
  const [contextMenuDb, setContextMenuDb] = useState<string | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  // 编辑数据库弹窗状态
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingDb, setEditingDb] = useState<string | null>(null);
  // 新建数据库弹窗状态
  const [createModalOpen, setCreateModalOpen] = useState(false);

  // 连接后自动加载数据库列表（若尚无缓存）；若有默认数据库则自动选中
  useEffect(() => {
    if (connId && capabilities.tableBrowsing) {
      const state = connectionStates[connId];
      if (!state || state.databases.length === 0) {
        const defaultDb = activeConnection?.config.database ?? undefined;
        loadDatabases(connId, defaultDb);
      }
    }
  }, [
    connId,
    capabilities.tableBrowsing,
    loadDatabases,
    activeConnection?.config.database,
    connectionStates,
  ]);

  // 构建树数据 (memoize 避免大量表时重复渲染)，应用排序
  const treeData: DataNode[] = useMemo(() => {
    if (!capabilities.tableBrowsing) return [];

    const sortedDatabases = [...databases].sort((a, b) => {
      const cmp = a.localeCompare(b, undefined, { sensitivity: "base" });
      return databaseSortOrder === "asc" ? cmp : -cmp;
    });

    return sortedDatabases.map((db) => {
      const dbTables = tables[db];
      const sortedTables = dbTables
        ? [...dbTables].sort((a, b) => {
            const cmp = a.name.localeCompare(b.name, undefined, {
              sensitivity: "base",
            });
            return tableSortOrder === "asc" ? cmp : -cmp;
          })
        : undefined;
      const children: DataNode[] | undefined = sortedTables
        ? sortedTables.map((t) => {
            const fav = favoriteTableKeys.has(
              favoriteTableKey(connectionId, db, t.name)
            );
            return {
              title: (
                <span
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                    width: "100%",
                    minWidth: 0,
                  }}
                >
                  {/* 第一行：表名（可截断） */}
                  <Tooltip title={t.comment || "无注释"} placement="topLeft">
                    <Text
                      style={{ fontSize: 13, display: "block" }}
                      ellipsis={{ tooltip: t.name }}
                    >
                      {t.name}
                    </Text>
                  </Tooltip>
                  {/* 第二行：行数 + 收藏按钮（始终可见） */}
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                    }}
                  >
                    {t.rows !== null && (
                      <Text
                        type="secondary"
                        style={{ fontSize: 11, whiteSpace: "nowrap" }}
                      >
                        {t.rows.toLocaleString()} 行
                      </Text>
                    )}
                    {capabilities.favoriteTables && (
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite({
                            connectionId,
                            database: db,
                            table: t.name,
                          });
                        }}
                        style={{
                          cursor: "pointer",
                          padding: "0 2px",
                          marginLeft: "auto",
                        }}
                        title={fav ? "取消收藏" : "收藏"}
                      >
                        {fav ? (
                          <StarFilled
                            style={{ color: "#faad14", fontSize: 12 }}
                          />
                        ) : (
                          <StarOutlined
                            style={{
                              color: "var(--text-secondary)",
                              fontSize: 12,
                            }}
                          />
                        )}
                      </span>
                    )}
                  </span>
                </span>
              ),
              key: `table:${db}:${t.name}`,
              icon:
                t.table_type === "VIEW" ? (
                  <EyeOutlined style={{ color: "#faad14" }} />
                ) : (
                  <TableOutlined style={{ color: "#52c41a" }} />
                ),
              isLeaf: true,
            };
          })
        : undefined;

      return {
        title: (
          <Text strong style={{ fontSize: 13 }}>
            {db}
          </Text>
        ),
        key: `db:${db}`,
        icon: <DatabaseOutlined style={{ color: "#1677ff" }} />,
        children,
      };
    });
  }, [
    databases,
    tables,
    databaseSortOrder,
    tableSortOrder,
    capabilities.tableBrowsing,
    capabilities.favoriteTables,
    connectionId,
    favoriteTableKeys,
    toggleFavorite,
  ]);

  // 展开节点时懒加载表列表
  const onLoadData = useCallback(
    async (node: EventDataNode<DataNode>) => {
      const key = node.key as string;
      if (key.startsWith("db:") && connId && capabilities.tableBrowsing) {
        const db = key.substring(3);
        if (!tables[db]) {
          await loadTables(connId, db);
        }
      }
    },
    [connId, capabilities.tableBrowsing, tables, loadTables]
  );

  // 选中节点 (左键)。Shift+点击已打开的表 → 关闭该 tab
  const onSelect = useCallback(
    (_keys: React.Key[], info: { node: EventDataNode<DataNode> }) => {
      const key = info.node.key as string;
      if (!capabilities.tableBrowsing) return;
      if (key.startsWith("db:") && connId) {
        const db = key.substring(3);
        selectDatabase(connId, db);
      } else if (key.startsWith("table:") && connId) {
        const parts = key.split(":");
        const db = parts[1];
        const table = parts.slice(2).join(":"); // 表名可能含冒号
        if (lastMouseDownShiftRef.current) {
          const idx = openTabs.findIndex(
            (e) => e.type === "table" && e.database === db && e.table === table
          );
          if (idx >= 0) {
            closeTab(connId, idx);
            removeTableFromCache(connId, db, table);
            return;
          }
        }
        selectTable(connId, db, table);
      }
    },
    [
      connId,
      capabilities.tableBrowsing,
      openTabs,
      selectDatabase,
      selectTable,
      closeTab,
      removeTableFromCache,
    ]
  );

  // 展开/收起
  const onExpand = useCallback(
    (keys: React.Key[]) => {
      setExpandedKeys(keys as string[]);
    },
    [setExpandedKeys]
  );

  // 右键点击节点 (阻止浏览器默认菜单，只显示自定义菜单)
  const onRightClick = useCallback(
    (info: { event: React.MouseEvent; node: EventDataNode<DataNode> }) => {
      info.event.preventDefault();
      const key = info.node.key as string;
      if (key.startsWith("db:")) {
        const db = key.substring(3);
        setContextMenuDb(db);
        setContextMenuPosition({
          x: info.event.clientX,
          y: info.event.clientY,
        });
      }
    },
    []
  );

  // 关闭右键菜单
  const closeContextMenu = useCallback(() => {
    setContextMenuDb(null);
    setContextMenuPosition(null);
  }, []);

  // 右键菜单项
  const contextMenuItems: MenuProps["items"] = [
    {
      key: "edit-database",
      label: `编辑${capabilities.databaseObjectNoun}`,
      icon: <EditOutlined />,
      disabled: clientReadOnly || !capabilities.databaseManagement,
      onClick: () => {
        if (contextMenuDb) {
          setEditingDb(contextMenuDb);
          setEditModalOpen(true);
        }
        closeContextMenu();
      },
    },
  ];

  // 断开连接
  const handleDisconnect = useCallback(async () => {
    if (connId) await disconnect(connId);
  }, [connId, disconnect]);

  // 编辑弹窗关闭后的回调
  const handleEditModalClose = useCallback(() => {
    setEditModalOpen(false);
    setEditingDb(null);
  }, []);

  // 编辑成功后刷新
  const handleEditSuccess = useCallback(() => {
    if (connId) {
      refresh(connId);
    }
    setEditModalOpen(false);
    setEditingDb(null);
  }, [connId, refresh]);

  // 选中的 key (memoize 避免每次渲染创建新数组)
  const selectedKeys = useMemo(
    () =>
      selectedDatabase && selectedTable
        ? [`table:${selectedDatabase}:${selectedTable}`]
        : selectedDatabase && !selectedTable
          ? [`db:${selectedDatabase}`]
          : [],
    [selectedDatabase, selectedTable]
  );

  const connectionEntries = Object.entries(activeConnections);
  const hasMultipleConnections = connectionEntries.length > 1;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 连接切换器（多连接时显示 Tab） */}
      {hasMultipleConnections && (
        <div
          style={{
            padding: "4px 12px 0",
            borderBottom: "1px solid var(--border-color)",
          }}
        >
          <Tabs
            size="small"
            activeKey={activeConnId ?? undefined}
            onChange={(key) => switchActive(key)}
            items={connectionEntries.map(([cId, conn]) => ({
              key: cId,
              label: (
                <span
                  style={{
                    maxWidth: 120,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {conn.config.name}
                </span>
              ),
            }))}
          />
        </div>
      )}

      {/* 连接信息头部 */}
      <div
        style={{
          padding: "12px 16px",
          borderBottom: "1px solid var(--border-color)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 4,
          }}
        >
          <Title
            level={5}
            style={{ margin: 0, color: "var(--text-primary)", fontSize: 14 }}
          >
            {activeConnection?.config.name}
          </Title>
          <Space size={4}>
            <Tooltip
              title={
                !capabilities.databaseManagement
                  ? `当前数据库类型暂不支持新建${capabilities.databaseObjectNoun}`
                  : clientReadOnly
                    ? `只读连接无法新建${capabilities.databaseObjectNoun}`
                    : `新建${capabilities.databaseObjectNoun}`
              }
            >
              <Button
                type="text"
                size="small"
                icon={<PlusOutlined />}
                onClick={() => connId && setCreateModalOpen(true)}
                disabled={
                  !connId || clientReadOnly || !capabilities.databaseManagement
                }
              />
            </Tooltip>
            <Dropdown
              menu={{
                items: [
                  {
                    key: "db-asc",
                    label: "数据库 A→Z",
                    icon: <SortAscendingOutlined />,
                    onClick: () => setDatabaseSortOrder("asc"),
                  },
                  {
                    key: "db-desc",
                    label: "数据库 Z→A",
                    icon: <SortDescendingOutlined />,
                    onClick: () => setDatabaseSortOrder("desc"),
                  },
                  { type: "divider" },
                  {
                    key: "table-asc",
                    label: "表 A→Z",
                    icon: <SortAscendingOutlined />,
                    onClick: () => setTableSortOrder("asc"),
                  },
                  {
                    key: "table-desc",
                    label: "表 Z→A",
                    icon: <SortDescendingOutlined />,
                    onClick: () => setTableSortOrder("desc"),
                  },
                ],
              }}
              trigger={["click"]}
            >
              <Tooltip title="排序">
                <Button
                  type="text"
                  size="small"
                  icon={
                    databaseSortOrder === "asc" && tableSortOrder === "asc" ? (
                      <SortAscendingOutlined />
                    ) : (
                      <SortDescendingOutlined />
                    )
                  }
                />
              </Tooltip>
            </Dropdown>
            <Tooltip
              title={
                capabilities.tableBrowsing
                  ? "刷新"
                  : "当前数据库类型暂不支持对象浏览"
              }
            >
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => connId && refresh(connId)}
                loading={treeLoading}
                disabled={!connId || !capabilities.tableBrowsing}
              />
            </Tooltip>
            <Tooltip title="管理连接">
              <Button
                type="text"
                size="small"
                icon={<ArrowLeftOutlined />}
                onClick={showNewConnectionForm}
              />
            </Tooltip>
            <Tooltip title="断开连接">
              <Button
                type="text"
                size="small"
                danger
                icon={<DisconnectOutlined />}
                onClick={handleDisconnect}
              />
            </Tooltip>
          </Space>
        </div>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {activeConnection?.config.host}:{activeConnection?.config.port}
          {activeConnection?.config.ssh && " (SSH)"}
        </Text>
        <div
          style={{
            display: "flex",
            gap: 8,
            marginTop: 8,
            alignItems: "center",
          }}
        >
          <Tooltip title="新建 SQL 标签页">
            <span style={{ display: "inline-flex" }}>
              <Button
                type="default"
                size="small"
                icon={<CodeOutlined />}
                aria-label="新建 SQL 标签页"
                onClick={() => connId && openSqlTab(connId)}
                disabled={!connId || !capabilities.sqlEditor}
              />
            </span>
          </Tooltip>
          {capabilities.favoriteTables && (
            <FavoriteTables dropdownTreeEdgeRef={treeContainerRef} />
          )}
          {capabilities.savedSql && (
            <SavedSqlDropdown dropdownTreeEdgeRef={treeContainerRef} />
          )}
        </div>
      </div>

      {/* 数据库树 */}
      <div
        ref={treeContainerRef}
        style={{ flex: 1, overflow: "hidden", padding: "4px 0" }}
        onMouseDown={(e) => {
          lastMouseDownShiftRef.current = e.shiftKey;
        }}
      >
        <Spin spinning={treeLoading && databases.length === 0}>
          {!capabilities.tableBrowsing ? (
            <div
              style={{
                padding: "32px 16px",
                textAlign: "center",
                color: "var(--text-placeholder)",
              }}
            >
              <DatabaseOutlined
                style={{ fontSize: 32, marginBottom: 12, display: "block" }}
              />
              <Text type="secondary">当前数据库类型暂不支持对象浏览</Text>
            </div>
          ) : databases.length > 0 ? (
            <>
              <Tree
                showIcon
                treeData={treeData}
                loadData={onLoadData}
                expandedKeys={expandedKeys}
                selectedKeys={selectedKeys}
                onExpand={onExpand}
                onSelect={onSelect}
                onRightClick={onRightClick}
                virtual
                height={treeHeight}
                style={{ background: "transparent" }}
              />
              {/* 右键上下文菜单 */}
              {contextMenuDb && contextMenuPosition && (
                <Dropdown
                  menu={{ items: contextMenuItems }}
                  open={true}
                  onOpenChange={(open) => {
                    if (!open) closeContextMenu();
                  }}
                  trigger={["contextMenu"]}
                >
                  <div
                    style={{
                      position: "fixed",
                      left: contextMenuPosition.x,
                      top: contextMenuPosition.y,
                      width: 1,
                      height: 1,
                    }}
                  />
                </Dropdown>
              )}
            </>
          ) : (
            !treeLoading && (
              <div
                style={{
                  padding: "32px 16px",
                  textAlign: "center",
                  color: "var(--text-placeholder)",
                }}
              >
                <DatabaseOutlined
                  style={{ fontSize: 32, marginBottom: 12, display: "block" }}
                />
                <Text type="secondary">无可用数据库</Text>
              </div>
            )
          )}
        </Spin>
      </div>

      {/* 编辑数据库弹窗 */}
      {editingDb && (
        <DatabaseEditModal
          open={editModalOpen}
          database={editingDb}
          connId={connId}
          onClose={handleEditModalClose}
          onSuccess={handleEditSuccess}
        />
      )}
      {/* 新建数据库弹窗 */}
      {capabilities.databaseManagement && (
        <DatabaseCreateModal
          open={createModalOpen}
          connId={connId}
          onClose={() => setCreateModalOpen(false)}
          onSuccess={() => setCreateModalOpen(false)}
        />
      )}
    </div>
  );
}
