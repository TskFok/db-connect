import { useShallow } from "zustand/react/shallow";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Typography,
  Tooltip,
  Badge,
  Dropdown,
  Input,
  Space,
  Modal,
} from "antd";
import type { InputRef } from "antd/es/input";
import {
  StarFilled,
  TableOutlined,
  FolderOpenOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDatabaseStore } from "../../stores/databaseStore";
import { useFavoriteStore } from "../../stores/favoriteStore";
import type { FavoriteTable } from "../../stores/favoriteStore";
import { favoriteConnectionKey } from "../../utils/favoriteConnection";
import { getDatabaseCapabilities } from "../../utils/databaseCapabilities";

const { Text } = Typography;

export interface FavoriteTablesProps {
  /** 对齐时下拉面板的左边缘与该元素（数据库树容器）左边缘对齐 */
  dropdownTreeEdgeRef?: React.RefObject<HTMLElement | null>;
}

export function FavoriteTables({
  dropdownTreeEdgeRef,
}: FavoriteTablesProps = {}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<InputRef>(null);
  const { activeConnection } = useConnectionStore();
  const { tables, openTableTabs } = useDatabaseStore(
    useShallow((s) => ({
      tables: s.tables,
      openTableTabs: s.openTableTabs,
    }))
  );
  const removeFavorite = useFavoriteStore((s) => s.removeFavorite);
  const clearFavoritesForConnection = useFavoriteStore(
    (s) => s.clearFavoritesForConnection
  );
  const favoritesFromStore = useFavoriteStore((s) => s.favorites);

  useEffect(() => {
    if (open) {
      const id = window.requestAnimationFrame(() => {
        searchRef.current?.input?.focus();
      });
      return () => window.cancelAnimationFrame(id);
    }
    return undefined;
  }, [open]);

  const [popupAlignOffset, setPopupAlignOffset] = useState<[number, number]>([
    0, 0,
  ]);
  const triggerWrapRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !dropdownTreeEdgeRef?.current || !triggerWrapRef.current) {
      return;
    }
    const treeLeft = dropdownTreeEdgeRef.current.getBoundingClientRect().left;
    const trigLeft = triggerWrapRef.current.getBoundingClientRect().left;
    setPopupAlignOffset([Math.round(treeLeft - trigLeft), 0]);
  }, [open, dropdownTreeEdgeRef]);

  const connectionId = activeConnection
    ? favoriteConnectionKey(activeConnection.config)
    : "";
  const connId = activeConnection?.connId ?? "";
  const isSchema =
    getDatabaseCapabilities(activeConnection?.config.database_type)
      .databaseObjectNoun === "schema";
  const searchPlaceholder = isSchema
    ? "搜索 schema 或表名…"
    : "搜索库名或表名…";
  const emptyHint = isSchema
    ? "在 schema 概览的表列表中点击星标可添加收藏"
    : "在数据库概览的表列表中点击星标可添加收藏";
  const favorites = useMemo(() => {
    if (!activeConnection || !connectionId) return [];
    return favoritesFromStore.filter((f) => f.connectionId === connectionId);
  }, [activeConnection, connectionId, favoritesFromStore]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return favorites;
    return favorites.filter((item) => {
      const label = `${item.database}.${item.table}`.toLowerCase();
      return label.includes(q);
    });
  }, [favorites, search]);

  const handleSelectTable = (item: FavoriteTable) => {
    if (!connId) return;
    openTableTabs(connId, [item]);
  };

  const handleOpenAllFavorites = () => {
    if (!connId || favorites.length === 0) return;
    openTableTabs(connId, favorites);
  };

  const handleClearAllClick = () => {
    if (!connectionId || favorites.length === 0) return;

    Modal.confirm({
      title: "确定清空当前连接的收藏吗？",
      content: (
        <>
          <Text>将移除当前连接下的 {favorites.length} 个收藏的表。</Text>
          <br />
          <Text type="secondary" style={{ fontSize: 12 }}>
            仅影响本连接收藏；可随时在概览的表列表中点击星标再次添加。
          </Text>
        </>
      ),
      okText: "清空",
      okType: "danger",
      cancelText: "保留",
      onOk: () => {
        clearFavoritesForConnection(connectionId);
      },
    });
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };

  const dropdownPanel = (
    <div
      style={{
        background: "var(--bg-secondary)",
        border: "1px solid var(--border-color)",
        borderRadius: 8,
        boxShadow: "0 6px 16px rgba(0,0,0,0.12)",
        minWidth: 280,
        maxWidth: "min(520px, calc(100vw - 32px))",
        maxHeight: 360,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "10px 12px 0" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            minWidth: 0,
          }}
        >
          <Text strong style={{ fontSize: 13, flexShrink: 0 }}>
            收藏的表
          </Text>
          {favorites.length > 0 ? (
            <Space size={0} style={{ flexShrink: 0 }}>
              <Tooltip title="打开全部收藏">
                <Button
                  type="text"
                  size="small"
                  icon={<FolderOpenOutlined />}
                  aria-label="打开全部收藏"
                  disabled={!connId}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOpenAllFavorites();
                  }}
                />
              </Tooltip>
              <Tooltip title="取消全部收藏">
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  aria-label="取消全部收藏"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClearAllClick();
                  }}
                />
              </Tooltip>
            </Space>
          ) : null}
        </div>
        <Input.Search
          ref={searchRef}
          allowClear
          size="small"
          placeholder={searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ marginTop: 8 }}
        />
      </div>
      <div
        style={{
          padding: "8px 12px 12px",
          overflowY: "auto",
          flex: 1,
          minHeight: 0,
        }}
      >
        {favorites.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "24px 8px",
              color: "var(--text-placeholder)",
            }}
          >
            <StarFilled
              style={{ fontSize: 28, color: "#faad14", marginBottom: 8 }}
            />
            <div style={{ fontSize: 13 }}>暂无收藏</div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {emptyHint}
            </Text>
          </div>
        ) : filtered.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: 24,
              color: "var(--text-placeholder)",
              fontSize: 13,
            }}
          >
            无匹配结果
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            {filtered.map((item) => {
              const tableInfo = tables[item.database]?.find(
                (t) => t.name === item.table
              );
              const comment = tableInfo?.comment;
              return (
                <div
                  key={`${item.database}.${item.table}`}
                  className="connection-item"
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    padding: "8px 10px",
                    borderRadius: 6,
                    gap: 8,
                    border: "1px solid var(--border-color)",
                    cursor: "pointer",
                  }}
                  onClick={() => handleSelectTable(item)}
                >
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                      flex: 1,
                      minWidth: 0,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 6,
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      <TableOutlined
                        style={{
                          color: "#52c41a",
                          fontSize: 12,
                          flexShrink: 0,
                          marginTop: 3,
                        }}
                      />
                      <Text
                        style={{
                          fontSize: 13,
                          color: "var(--text-primary)",
                          display: "block",
                          lineHeight: 1.4,
                          minWidth: 0,
                          flex: 1,
                          whiteSpace: "normal",
                          wordBreak: "break-word",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {item.database}.{item.table}
                      </Text>
                    </div>
                    {comment ? (
                      <Text
                        type="secondary"
                        style={{
                          fontSize: 11,
                          display: "block",
                          lineHeight: 1.3,
                          paddingLeft: 18,
                          minWidth: 0,
                          whiteSpace: "normal",
                          wordBreak: "break-word",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {comment}
                      </Text>
                    ) : null}
                  </div>
                  <span style={{ flexShrink: 0 }}>
                    <Tooltip title="取消收藏">
                      <Button
                        type="text"
                        size="small"
                        aria-label={`取消收藏 ${item.database}.${item.table}`}
                        icon={
                          <StarFilled
                            style={{ color: "#faad14", fontSize: 12 }}
                          />
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFavorite(
                            item.connectionId,
                            item.database,
                            item.table
                          );
                        }}
                      />
                    </Tooltip>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );

  if (!activeConnection) return null;

  return (
    <Dropdown
      open={open}
      onOpenChange={handleOpenChange}
      trigger={["click"]}
      placement="bottomLeft"
      align={
        dropdownTreeEdgeRef
          ? {
              offset: popupAlignOffset,
              overflow: { adjustX: true, adjustY: true },
            }
          : undefined
      }
      popupRender={() => dropdownPanel}
      getPopupContainer={
        dropdownTreeEdgeRef
          ? () => document.body
          : (n) => n.parentElement ?? document.body
      }
    >
      <div ref={triggerWrapRef} style={{ display: "inline-flex" }}>
        <Tooltip title={`收藏的表 (${favorites.length})`}>
          <Badge
            count={favorites.length}
            size="small"
            offset={[-6, 4]}
            showZero={false}
          >
            <Button
              type="default"
              size="small"
              icon={<StarFilled style={{ color: "#faad14", fontSize: 14 }} />}
              aria-label={`收藏 (${favorites.length})`}
            />
          </Badge>
        </Tooltip>
      </div>
    </Dropdown>
  );
}
