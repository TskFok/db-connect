import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  Button,
  Typography,
  Popconfirm,
  Space,
  Tag,
  Tooltip,
  Spin,
  Modal,
  Input,
  message,
} from "antd";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  DeleteOutlined,
  EditOutlined,
  LinkOutlined,
  DisconnectOutlined,
  SwapOutlined,
  CloudServerOutlined,
  DatabaseOutlined,
  HolderOutlined,
  FolderAddOutlined,
  FolderOpenOutlined,
  FolderOutlined,
  DownOutlined,
  RightOutlined,
  DownloadOutlined,
  UploadOutlined,
  ClusterOutlined,
  FileTextOutlined,
  WindowsOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useConnectionStore } from "../../stores/connectionStore";
import type { ConnectionConfig, DatabaseType } from "../../types";
import { normalizeDatabaseType } from "../../utils/connectionConfig";
import {
  canDragConnectionGroup,
  connectionDropId,
  getSortableGroupSectionStyle,
  groupConnections,
  groupDropId,
  groupIdFromSortId,
  groupSortId,
  moveConnectionInGroups,
  reorderConnectionGroupsByDrag,
  UNGROUPED_GROUP_ID,
  type ConnectionGroupView,
} from "../../utils/connectionGroups";

const { Text, Title } = Typography;

const DATABASE_TYPE_ICON_META: Record<
  DatabaseType,
  { label: string; color: string; icon: ReactNode }
> = {
  mysql: {
    label: "MySQL",
    color: "#1677ff",
    icon: <DatabaseOutlined aria-hidden />,
  },
  postgres: {
    label: "PostgreSQL",
    color: "#0958d9",
    icon: <ClusterOutlined aria-hidden />,
  },
  sqlite: {
    label: "SQLite",
    color: "#8c8c8c",
    icon: <FileTextOutlined aria-hidden />,
  },
  sqlserver: {
    label: "SQL Server",
    color: "#2f54eb",
    icon: <WindowsOutlined aria-hidden />,
  },
  clickhouse: {
    label: "ClickHouse",
    color: "#fa8c16",
    icon: <ThunderboltOutlined aria-hidden />,
  },
};

function DatabaseTypeIcon({
  databaseType,
}: {
  databaseType: ConnectionConfig["database_type"];
}) {
  const normalizedType = normalizeDatabaseType(databaseType);
  const meta = DATABASE_TYPE_ICON_META[normalizedType];

  return (
    <Tooltip title={meta.label}>
      <span
        role="img"
        aria-label={`数据库类型：${meta.label}`}
        title={meta.label}
        style={{
          color: meta.color,
          display: "inline-flex",
          alignItems: "center",
          flexShrink: 0,
          fontSize: 14,
          lineHeight: 1,
        }}
      >
        {meta.icon}
      </span>
    </Tooltip>
  );
}

interface SortableConnectionItemProps {
  item: ConnectionConfig;
  isActive: boolean;
  isConnected: boolean;
  connId: string | null;
  onConnect: (config: ConnectionConfig) => void;
  onSwitch: (connId: string) => void;
  onGoToDatabase: (connId: string) => void;
  onDisconnect: (connId: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}

function SortableConnectionItem({
  item,
  isActive,
  isConnected,
  connId,
  onConnect,
  onSwitch,
  onGoToDatabase,
  onDisconnect,
  onEdit,
  onDelete,
}: SortableConnectionItemProps) {
  const id = item.id ?? "";
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: connectionDropId(id) });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const handleClick = () => {
    if (isConnected && !isActive) onSwitch(connId!);
    else if (isConnected && isActive) onGoToDatabase(connId!);
    else if (!isConnected) onConnect(item);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`connection-item ${isActive ? "active" : ""}`}
      onClick={handleClick}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            flex: 1,
            minWidth: 0,
          }}
        >
          <div
            {...attributes}
            {...listeners}
            title="拖拽移动连接"
            style={{
              cursor: "grab",
              padding: "4px 4px 4px 0",
              color: "var(--text-secondary)",
              touchAction: "none",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <HolderOutlined style={{ fontSize: 12 }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <DatabaseTypeIcon databaseType={item.database_type} />
              <Text strong style={{ color: "var(--text-primary)" }} ellipsis>
                {item.name}
              </Text>
              {item.ssh && (
                <Tooltip title="SSH 隧道">
                  <CloudServerOutlined
                    aria-label={`SSH 隧道：${item.name}`}
                    style={{
                      color: "#1677ff",
                      flexShrink: 0,
                      fontSize: 12,
                    }}
                  />
                </Tooltip>
              )}
              {isConnected && (
                <Tag color="green" style={{ marginLeft: 4 }}>
                  {isActive ? "当前" : "已连接"}
                </Tag>
              )}
            </div>
          </div>
        </div>

        <Space size={4} onClick={(e) => e.stopPropagation()}>
          {isActive ? (
            <Tooltip title="断开连接">
              <Button
                type="text"
                size="small"
                danger
                icon={<DisconnectOutlined />}
                onClick={() => connId && onDisconnect(connId)}
              />
            </Tooltip>
          ) : isConnected && connId ? (
            <Tooltip title="切换到此连接">
              <Button
                type="text"
                size="small"
                icon={<SwapOutlined />}
                onClick={() => onSwitch(connId)}
              />
            </Tooltip>
          ) : (
            <Tooltip title="连接">
              <Button
                type="text"
                size="small"
                icon={<LinkOutlined />}
                onClick={() => onConnect(item)}
              />
            </Tooltip>
          )}
          <Tooltip title="编辑">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => item.id && onEdit(item.id)}
            />
          </Tooltip>
          <Popconfirm
            title="确认删除"
            description="确定要删除这个连接配置吗？"
            onConfirm={() => item.id && onDelete(item.id)}
            okText="删除"
            cancelText="取消"
          >
            <Tooltip title="删除">
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      </div>
    </div>
  );
}

interface GroupSectionHeaderProps {
  group: ConnectionGroupView;
  collapsed: boolean;
  dragAttributes?: ReturnType<typeof useSortable>["attributes"];
  dragListeners?: ReturnType<typeof useSortable>["listeners"];
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
}

function GroupSectionHeader({
  group,
  collapsed,
  dragAttributes,
  dragListeners,
  onToggle,
  onRename,
  onDelete,
}: GroupSectionHeaderProps) {
  const { setNodeRef, isOver } = useDroppable({ id: groupDropId(group.id) });
  const canEdit = group.id !== UNGROUPED_GROUP_ID;
  const canDrag = canDragConnectionGroup(group);

  return (
    <div
      ref={setNodeRef}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "6px 12px",
        minHeight: 36,
        background: isOver ? "var(--hover-bg)" : "transparent",
        borderTop: "1px solid var(--border-color)",
        transition: "background-color 160ms ease, border-color 160ms ease",
      }}
    >
      {canDrag && (
        <Tooltip title="拖拽排序分组">
          <Button
            type="text"
            size="small"
            icon={<HolderOutlined />}
            {...dragAttributes}
            {...dragListeners}
            onClick={(event) => event.stopPropagation()}
            style={{
              cursor: "grab",
              color: "var(--text-secondary)",
              touchAction: "none",
            }}
          />
        </Tooltip>
      )}
      <Button
        type="text"
        size="small"
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          minWidth: 0,
          flex: 1,
          justifyContent: "flex-start",
          padding: "0 4px",
        }}
      >
        {collapsed ? <RightOutlined /> : <DownOutlined />}
        {collapsed ? <FolderOutlined /> : <FolderOpenOutlined />}
        <Text strong ellipsis style={{ maxWidth: 120 }}>
          {group.name}
        </Text>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {group.connections.length}
        </Text>
      </Button>
      {canEdit && (
        <Space size={2}>
          <Tooltip title="重命名分组">
            <Button
              aria-label={`重命名分组 ${group.name}`}
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={onRename}
            />
          </Tooltip>
          <Button
            aria-label={`删除分组 ${group.name}`}
            data-testid={`delete-group-${group.id}`}
            title="删除分组"
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={onDelete}
          />
        </Space>
      )}
    </div>
  );
}

interface SortableGroupSectionProps {
  group: ConnectionGroupView;
  collapsed: boolean;
  children: ReactNode;
  onToggle: () => void;
  onRename: () => void;
  onDelete: () => void;
}

function SortableGroupSection({
  group,
  collapsed,
  children,
  onToggle,
  onRename,
  onDelete,
}: SortableGroupSectionProps) {
  const dragDisabled = !canDragConnectionGroup(group);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: groupSortId(group.id),
    disabled: dragDisabled,
  });
  const style = getSortableGroupSectionStyle({
    transform: CSS.Transform.toString(transform),
    transition,
    isDragging,
  });

  return (
    <div ref={setNodeRef} style={style}>
      <GroupSectionHeader
        group={group}
        collapsed={collapsed}
        dragAttributes={attributes}
        dragListeners={listeners}
        onToggle={onToggle}
        onRename={onRename}
        onDelete={onDelete}
      />
      {children}
    </div>
  );
}

/** 根据 config.id 在 activeConnections 中查找 connId */
function findConnIdByConfigId(
  activeConnections: Record<string, { config: ConnectionConfig }>,
  configId: string
): string | null {
  for (const [connId, conn] of Object.entries(activeConnections)) {
    if (conn.config.id === configId) return connId;
  }
  return null;
}

function idFromSortableConnectionId(id: string): string | null {
  const prefix = "connection:";
  return id.startsWith(prefix) ? id.slice(prefix.length) : null;
}

type ConnectionTransferMode = "export" | "import";

export function ConnectionList() {
  const {
    savedConnections,
    connectionGroups,
    activeConnections,
    activeConnId,
    loading,
    loadSavedConnections,
    loadConnectionGroups,
    showNewConnectionForm,
    showEditConnectionForm,
    deleteSavedConnection,
    createConnectionGroup,
    renameConnectionGroup,
    deleteConnectionGroup,
    setConnectionGroupCollapsed,
    reorderConnectionGroups,
    moveConnectionToGroup,
    exportConnections,
    importConnections,
    connect,
    disconnect,
    switchActive,
    hideConnectionForm,
  } = useConnectionStore();

  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [ungroupedCollapsed, setUngroupedCollapsed] = useState(false);
  const [transferModalMode, setTransferModalMode] =
    useState<ConnectionTransferMode | null>(null);
  const [transferImportPath, setTransferImportPath] = useState<string | null>(
    null
  );
  const [transferPassword, setTransferPassword] = useState("");
  const [transferPasswordConfirm, setTransferPasswordConfirm] = useState("");

  useEffect(() => {
    void loadSavedConnections();
    void loadConnectionGroups();
  }, [loadSavedConnections, loadConnectionGroups]);

  const groupedConnections = useMemo(
    () => groupConnections(connectionGroups, savedConnections),
    [connectionGroups, savedConnections]
  );

  const handleConnect = useCallback(
    async (config: ConnectionConfig) => {
      await connect(config);
    },
    [connect]
  );

  const handleSwitch = useCallback(
    (connId: string) => {
      switchActive(connId);
      hideConnectionForm();
    },
    [switchActive, hideConnectionForm]
  );

  const handleGoToDatabase = useCallback(
    (_connId: string) => {
      hideConnectionForm();
    },
    [hideConnectionForm]
  );

  const handleDisconnect = useCallback(
    async (connId: string) => {
      await disconnect(connId);
    },
    [disconnect]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const handleOpenCreateGroup = () => {
    setEditingGroupId(null);
    setGroupName("");
    setGroupModalOpen(true);
  };

  const handleOpenRenameGroup = (group: ConnectionGroupView) => {
    setEditingGroupId(group.id);
    setGroupName(group.name);
    setGroupModalOpen(true);
  };

  const handleSaveGroup = async () => {
    const name = groupName.trim();
    if (!name) return;
    if (editingGroupId) {
      await renameConnectionGroup(editingGroupId, name);
    } else {
      await createConnectionGroup(name);
    }
    setGroupModalOpen(false);
    setEditingGroupId(null);
    setGroupName("");
  };

  const resetTransferModal = () => {
    setTransferModalMode(null);
    setTransferImportPath(null);
    setTransferPassword("");
    setTransferPasswordConfirm("");
  };

  const handleExportConnections = () => {
    setTransferModalMode("export");
    setTransferImportPath(null);
    setTransferPassword("");
    setTransferPasswordConfirm("");
  };

  const handleImportConnections = async () => {
    try {
      const chosen = await open({
        title: "导入连接",
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      const path = Array.isArray(chosen) ? chosen[0] : chosen;
      if (!path) return;
      setTransferImportPath(path);
      setTransferModalMode("import");
      setTransferPassword("");
      setTransferPasswordConfirm("");
    } catch (e) {
      message.error(`导入失败：${String(e)}`);
    }
  };

  const handleConfirmTransfer = async () => {
    const password = transferPassword;
    if (!password.trim()) {
      message.error("请输入导入导出密码");
      return;
    }
    if (
      transferModalMode === "export" &&
      password !== transferPasswordConfirm
    ) {
      message.error("两次输入的密码不一致");
      return;
    }

    try {
      if (transferModalMode === "export") {
        const path = await save({
          title: "导出连接",
          defaultPath: "db-connect-connections.json",
          filters: [{ name: "JSON", extensions: ["json"] }],
        });
        if (!path) return;
        const count = await exportConnections(path, password);
        message.success(`已导出 ${count} 个连接`);
        resetTransferModal();
        return;
      }

      if (transferModalMode === "import" && transferImportPath) {
        const result = await importConnections(transferImportPath, password);
        message.success(
          `已导入 ${result.imported_connections} 个连接、${result.imported_groups} 个分组`
        );
        resetTransferModal();
      }
    } catch (e) {
      message.error(
        `${transferModalMode === "export" ? "导出" : "导入"}失败：${String(e)}`
      );
    }
  };

  const handleToggleGroup = async (group: ConnectionGroupView) => {
    const nextCollapsed = !group.collapsed;
    if (group.id === UNGROUPED_GROUP_ID) {
      setUngroupedCollapsed((value) => !value);
      return;
    }
    await setConnectionGroupCollapsed(group.id, nextCollapsed);
  };

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const activeGroupId = groupIdFromSortId(String(active.id));
      if (activeGroupId) {
        const orderedGroupIds = reorderConnectionGroupsByDrag({
          activeGroupId,
          overId: String(over.id),
          groups: groupedConnections,
        });
        if (!orderedGroupIds) return;
        await reorderConnectionGroups(orderedGroupIds);
        return;
      }

      const activeConnectionId = idFromSortableConnectionId(String(active.id));
      if (!activeConnectionId) return;

      const result = moveConnectionInGroups({
        activeConnectionId,
        overId: String(over.id),
        groups: groupedConnections,
      });
      if (!result) return;

      await moveConnectionToGroup(
        result.connectionId,
        result.groupId,
        result.orderedIds
      );
    },
    [groupedConnections, moveConnectionToGroup, reorderConnectionGroups]
  );

  const groupSortableIds = groupedConnections.map((group) =>
    groupSortId(group.id)
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          padding: "16px 16px 8px",
          borderBottom: "1px solid var(--border-color)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <Title level={5} style={{ margin: 0, color: "var(--text-primary)" }}>
            连接列表
          </Title>
          <Space size={8}>
            <Tooltip title="导入连接">
              <Button
                aria-label="导入连接"
                data-testid="import-connections"
                size="small"
                icon={<UploadOutlined />}
                onClick={() => void handleImportConnections()}
              />
            </Tooltip>
            <Tooltip title="导出连接">
              <Button
                aria-label="导出连接"
                data-testid="export-connections"
                size="small"
                icon={<DownloadOutlined />}
                onClick={handleExportConnections}
              />
            </Tooltip>
            <Tooltip title="新建分组">
              <Button
                aria-label="新建分组"
                data-testid="create-connection-group"
                size="small"
                icon={<FolderAddOutlined />}
                onClick={handleOpenCreateGroup}
              />
            </Tooltip>
            <Tooltip title="新建连接">
              <Button
                aria-label="新建连接"
                data-testid="create-connection"
                type="primary"
                size="small"
                icon={<DatabaseOutlined />}
                onClick={showNewConnectionForm}
              />
            </Tooltip>
          </Space>
        </div>
      </div>

      <div style={{ flex: 1, overflow: "auto", padding: "8px 0" }}>
        <Spin spinning={loading}>
          {savedConnections.length === 0 && connectionGroups.length === 0 ? (
            <div
              style={{
                padding: "32px 16px",
                textAlign: "center",
                color: "var(--text-placeholder)",
              }}
            >
              <CloudServerOutlined
                style={{ fontSize: 32, marginBottom: 12, display: "block" }}
              />
              <Text type="secondary">暂无保存的连接</Text>
              <br />
              <Text type="secondary" style={{ fontSize: 12 }}>
                点击 "新建" 添加连接
              </Text>
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={groupSortableIds}
                strategy={verticalListSortingStrategy}
              >
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 4 }}
                >
                  {groupedConnections.map((group) => {
                    const collapsed =
                      group.id === UNGROUPED_GROUP_ID
                        ? ungroupedCollapsed
                        : group.collapsed === true;
                    return (
                      <SortableGroupSection
                        key={group.id}
                        group={{ ...group, collapsed }}
                        collapsed={collapsed}
                        onToggle={() =>
                          void handleToggleGroup({ ...group, collapsed })
                        }
                        onRename={() => handleOpenRenameGroup(group)}
                        onDelete={() => {
                          Modal.confirm({
                            title: "删除分组？",
                            content: `删除分组“${group.name}”？组内连接会回到未分组。`,
                            okText: "删除",
                            cancelText: "取消",
                            okButtonProps: { danger: true },
                            onOk: () => {
                              void deleteConnectionGroup(group.id);
                            },
                          });
                        }}
                      >
                        {!collapsed && (
                          <SortableContext
                            items={group.connections
                              .map((connection) => connection.id)
                              .filter((id): id is string => !!id)
                              .map(connectionDropId)}
                            strategy={verticalListSortingStrategy}
                          >
                            <div
                              style={{
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                                padding: "0 0 4px",
                              }}
                            >
                              {group.connections.length === 0 ? (
                                <div
                                  style={{
                                    padding: "8px 16px 10px 36px",
                                    color: "var(--text-placeholder)",
                                    fontSize: 12,
                                  }}
                                >
                                  拖动连接到此分组
                                </div>
                              ) : (
                                group.connections.map((item) => {
                                  if (!item.id) return null;
                                  const connId = findConnIdByConfigId(
                                    activeConnections,
                                    item.id
                                  );
                                  const isConnected = !!connId;
                                  const isActive =
                                    connId !== null && activeConnId === connId;
                                  return (
                                    <SortableConnectionItem
                                      key={item.id}
                                      item={item}
                                      isActive={isActive}
                                      isConnected={isConnected}
                                      connId={connId}
                                      onConnect={handleConnect}
                                      onSwitch={handleSwitch}
                                      onGoToDatabase={handleGoToDatabase}
                                      onDisconnect={handleDisconnect}
                                      onEdit={showEditConnectionForm}
                                      onDelete={deleteSavedConnection}
                                    />
                                  );
                                })
                              )}
                            </div>
                          </SortableContext>
                        )}
                      </SortableGroupSection>
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </Spin>
      </div>

      <Modal
        title={editingGroupId ? "重命名分组" : "新建分组"}
        open={groupModalOpen}
        okText={editingGroupId ? "保存" : "创建"}
        cancelText="取消"
        onOk={() => void handleSaveGroup()}
        onCancel={() => setGroupModalOpen(false)}
        okButtonProps={{ disabled: groupName.trim().length === 0 }}
      >
        <Input
          autoFocus
          value={groupName}
          maxLength={40}
          placeholder="分组名称"
          onChange={(event) => setGroupName(event.target.value)}
          onPressEnter={() => void handleSaveGroup()}
        />
      </Modal>

      <Modal
        title={transferModalMode === "export" ? "设置导出密码" : "输入导入密码"}
        open={transferModalMode !== null}
        okText={transferModalMode === "export" ? "导出" : "导入"}
        cancelText="取消"
        onOk={() => void handleConfirmTransfer()}
        onCancel={resetTransferModal}
        okButtonProps={{
          "aria-label": transferModalMode === "export" ? "导出" : "导入",
        }}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <Text type="secondary">
            {transferModalMode === "export"
              ? "导出文件将使用此密码加密。请妥善保存密码，丢失后无法恢复。"
              : "请输入导出时设置的密码，密码正确后才会导入连接。"}
          </Text>
          <Input.Password
            aria-label={
              transferModalMode === "export" ? "导出密码" : "导入密码"
            }
            placeholder={
              transferModalMode === "export" ? "导出密码" : "导入密码"
            }
            value={transferPassword}
            onChange={(event) => setTransferPassword(event.target.value)}
            autoFocus
          />
          {transferModalMode === "export" && (
            <Input.Password
              aria-label="确认密码"
              placeholder="确认密码"
              value={transferPasswordConfirm}
              onChange={(event) =>
                setTransferPasswordConfirm(event.target.value)
              }
            />
          )}
        </Space>
      </Modal>
    </div>
  );
}
