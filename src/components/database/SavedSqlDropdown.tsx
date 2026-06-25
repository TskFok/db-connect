import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Dropdown,
  Button,
  Typography,
  Tooltip,
  Badge,
  Space,
  Modal,
  Input,
  message,
} from "antd";
import type { InputRef } from "antd/es/input";
import {
  FolderOpenOutlined,
  PlayCircleOutlined,
  DeleteOutlined,
} from "@ant-design/icons";
import { useConnectionStore } from "../../stores/connectionStore";
import { useDatabaseStore } from "../../stores/databaseStore";
import { useSavedSqlStore, type SavedSql } from "../../stores/savedSqlStore";
import {
  filterSavedSqlByConnectionKey,
  savedSqlConnectionKey,
} from "../../utils/savedSqlConnection";

const { Text } = Typography;

/** 侧栏中与数据库树区域左边界对齐下拉面板时使用 */
export type DropdownTreeEdgeRefProp = React.RefObject<HTMLElement | null>;

export type SavedSqlDropdownProps =
  | { variant?: "sidebar"; dropdownTreeEdgeRef?: DropdownTreeEdgeRefProp }
  | {
      variant: "embedded";
      setEditorSql: (sql: string) => void;
      requestExecute: () => void;
      dropdownTreeEdgeRef?: DropdownTreeEdgeRefProp;
    };

function isEmbedded(
  props: SavedSqlDropdownProps
): props is Extract<SavedSqlDropdownProps, { variant: "embedded" }> {
  return props.variant === "embedded";
}

export function SavedSqlDropdown(props: SavedSqlDropdownProps = {}) {
  const embedded = isEmbedded(props);
  const variant = embedded ? "embedded" : "sidebar";
  const sidebarEdgeProps = props as {
    dropdownTreeEdgeRef?: DropdownTreeEdgeRefProp;
  };
  const treeEdgeRef = sidebarEdgeProps.dropdownTreeEdgeRef;
  const alignToTreeEdgeSidebar =
    !embedded && sidebarEdgeProps.dropdownTreeEdgeRef !== undefined;

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<InputRef>(null);
  const [popupAlignOffset, setPopupAlignOffset] = useState<[number, number]>([
    0, 0,
  ]);
  const triggerWrapRef = useRef<HTMLDivElement>(null);
  const { activeConnection } = useConnectionStore();
  const connId = activeConnection?.connId ?? "";

  const openSqlTab = useDatabaseStore((s) => s.openSqlTab);
  const requestSqlTabExecute = useDatabaseStore((s) => s.requestSqlTabExecute);

  const { remove: removeSavedSql, getAll: getSavedSqlList } = useSavedSqlStore();
  const savedList = getSavedSqlList();
  const currentSavedSqlKey = useMemo(
    () => (activeConnection ? savedSqlConnectionKey(activeConnection.config) : ""),
    [activeConnection]
  );
  const savedListForCurrent = useMemo(
    () => filterSavedSqlByConnectionKey(savedList, currentSavedSqlKey),
    [savedList, currentSavedSqlKey]
  );

  useEffect(() => {
    if (open) {
      const id = window.requestAnimationFrame(() => {
        searchRef.current?.input?.focus();
      });
      return () => window.cancelAnimationFrame(id);
    }
    return undefined;
  }, [open]);

  useLayoutEffect(() => {
    if (
      embedded ||
      !open ||
      !treeEdgeRef?.current ||
      !triggerWrapRef.current
    ) {
      return;
    }
    const treeLeft = treeEdgeRef.current.getBoundingClientRect().left;
    const trigLeft = triggerWrapRef.current.getBoundingClientRect().left;
    setPopupAlignOffset([Math.round(treeLeft - trigLeft), 0]);
  }, [embedded, open, treeEdgeRef]);

  const filteredSaved = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return savedListForCurrent;
    return savedListForCurrent.filter((item) => {
      const blob = `${item.name}\n${item.sql}`.toLowerCase();
      return blob.includes(q);
    });
  }, [savedListForCurrent, search]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };

  const applySqlContent = (sql: string, runAfterLoad?: boolean) => {
    const trimmed = sql.trim();
    if (!trimmed) return;

    if (embedded) {
      props.setEditorSql(trimmed);
      setOpen(false);
      if (runAfterLoad) {
        setTimeout(() => props.requestExecute(), 100);
      }
      return;
    }

    if (!connId || !activeConnection) {
      message.warning("请先建立数据库连接");
      return;
    }

    // 侧边栏始终新开 SQL 标签并写入内容；保持下拉展开便于连续载入多条
    openSqlTab(connId, trimmed);
    if (runAfterLoad) {
      const st = useDatabaseStore.getState();
      const idx = st.activeTabIndex;
      const t = st.openTabs[idx];
      if (t?.type === "sql") {
        requestSqlTabExecute(connId, t.id);
      }
    }
  };

  const tryLoadSavedSql = (item: SavedSql, runAfterLoad?: boolean) => {
    if (!connId || !activeConnection) {
      message.warning("请先建立数据库连接");
      return;
    }
    const currentKey = savedSqlConnectionKey(activeConnection.config);
    if (!item.connectionKey) {
      Modal.confirm({
        title: "未关联连接的保存项",
        content:
          "该条目在旧版本中保存，未记录所属连接。请确认当前连接与预期一致后再加载，避免在错误环境执行。",
        okText: "仍要加载",
        cancelText: "取消",
        onOk: () => {
          applySqlContent(item.sql, runAfterLoad);
        },
      });
      return;
    }
    if (item.connectionKey !== currentKey) {
      message.error(
        `该 SQL 保存在连接「${
          item.connectionLabel ?? "其他"
        }」下，与当前连接不一致，已阻止加载。`
      );
      return;
    }
    applySqlContent(item.sql, runAfterLoad);
  };

  if (variant === "sidebar" && !activeConnection) {
    return null;
  }

  const loadBlocked = !connId || !activeConnection;
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
        <Text strong style={{ fontSize: 13 }}>
          已保存的 SQL
        </Text>
        <Input.Search
          ref={searchRef}
          allowClear
          size="small"
          placeholder="搜索名称或 SQL…"
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
        {!currentSavedSqlKey ? (
          <div
            style={{
              textAlign: "center",
              padding: "24px 8px",
              color: "var(--text-placeholder)",
            }}
          >
            <FolderOpenOutlined
              style={{ fontSize: 28, color: "#1677ff", marginBottom: 8 }}
            />
            <div style={{ fontSize: 13 }}>请先建立数据库连接</div>
          </div>
        ) : savedListForCurrent.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "24px 8px",
              color: "var(--text-placeholder)",
            }}
          >
            <FolderOpenOutlined
              style={{ fontSize: 28, color: "#1677ff", marginBottom: 8 }}
            />
            <div style={{ fontSize: 13 }}>当前连接下暂无保存的 SQL</div>
            <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
              在 SQL 编辑器中编写后点击「保存」或工具栏磁盘图标即可添加至此列表
            </Text>
            {savedList.length > 0 && (
              <Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 12 }}>
                其他连接下仍有 {savedList.length} 条已保存项，切换对应连接后即可查看
              </Text>
            )}
          </div>
        ) : filteredSaved.length === 0 ? (
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
              gap: 8,
            }}
          >
            {filteredSaved.map((item) => (
                <div
                  key={item.id}
                  style={{
                    padding: "10px 12px",
                    border: "1px solid var(--border-color)",
                    borderRadius: 6,
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <Text strong style={{ fontSize: 13 }}>
                      {item.name}
                    </Text>
                    <Space size={4}>
                      <Tooltip title={loadBlocked ? "请先建立连接" : "加载"}>
                        <span>
                          <Button
                            type="text"
                            size="small"
                            icon={<FolderOpenOutlined />}
                            disabled={Boolean(loadBlocked)}
                            aria-label="加载已保存的 SQL"
                            onClick={() => tryLoadSavedSql(item)}
                          />
                        </span>
                      </Tooltip>
                      <Tooltip title={loadBlocked ? "请先建立连接" : "加载并运行"}>
                        <span>
                          <Button
                            type="text"
                            size="small"
                            icon={<PlayCircleOutlined />}
                            disabled={Boolean(loadBlocked)}
                            aria-label="加载并运行已保存的 SQL"
                            onClick={() => tryLoadSavedSql(item, true)}
                          />
                        </span>
                      </Tooltip>
                      <Tooltip title="删除">
                        <Button
                          type="text"
                          size="small"
                          danger
                          icon={<DeleteOutlined />}
                          aria-label="删除已保存的 SQL"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeSavedSql(item.id);
                          }}
                        />
                      </Tooltip>
                    </Space>
                  </div>
                  <Tooltip title={item.sql} placement="topLeft">
                    <Text
                      ellipsis
                      type="secondary"
                      style={{
                        fontSize: 11,
                        fontFamily: "monospace",
                        maxHeight: 36,
                        overflow: "hidden",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {item.sql}
                    </Text>
                  </Tooltip>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );

  const count = savedListForCurrent.length;
  const buttonDisabled =
    embedded && (!connId || !activeConnection);

  const button = (
    <Tooltip title={`已保存的 SQL (${count})`}>
      <span style={{ display: "inline-flex" }}>
        <Badge
          count={count}
          size="small"
          offset={[-6, 4]}
          showZero={false}
        >
          <Button
            type="default"
            size="small"
            icon={<FolderOpenOutlined />}
            aria-label={`已保存的 SQL (${count})`}
            disabled={buttonDisabled}
          />
        </Badge>
      </span>
    </Tooltip>
  );

  return (
    <Dropdown
      open={open}
      onOpenChange={handleOpenChange}
      trigger={["click"]}
      placement="bottomLeft"
      align={
        alignToTreeEdgeSidebar
          ? {
              offset: popupAlignOffset,
              overflow: { adjustX: true, adjustY: true },
            }
          : undefined
      }
      popupRender={() => dropdownPanel}
      /** 侧栏滚动容器 overflow:auto，挂载到祖先会被裁切 */
      getPopupContainer={() => document.body}
    >
      <div ref={triggerWrapRef} style={{ display: "inline-flex" }}>
        {button}
      </div>
    </Dropdown>
  );
}
