import { Tabs } from "antd";
import { TableOutlined, EyeOutlined, CloseOutlined, CodeOutlined } from "@ant-design/icons";
import { useDatabaseStore } from "../../stores/databaseStore";
import { useConnectionStore } from "../../stores/connectionStore";
import { useTableDataStore } from "../../stores/tableDataStore";
import type { OpenTabEntry } from "../../stores/databaseStore";

export function TableTabsBar() {
  const { activeConnection } = useConnectionStore();
  const { removeTableFromCache } = useTableDataStore();
  const {
    openTabs,
    activeTabIndex,
    tableInfos,
    switchTab,
    closeTab,
  } = useDatabaseStore();

  const connId = activeConnection?.connId ?? "";
  if (!connId || openTabs.length === 0) return null;

  const sqlTabCount = openTabs.filter((t) => t.type === "sql").length;
  const items = openTabs.map((entry: OpenTabEntry, index: number) => {
    if (entry.type === "sql") {
      const sqlIdx = openTabs.slice(0, index).filter((t) => t.type === "sql").length + 1;
      const sqlLabel = sqlTabCount > 1 ? `SQL ${sqlIdx}` : "SQL";
      return {
        key: String(index),
        label: (
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <CodeOutlined style={{ color: "#1677ff", fontSize: 12 }} />
            <span style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>
              {sqlLabel}
            </span>
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                closeTab(connId, index);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  closeTab(connId, index);
                }
              }}
              style={{
                marginLeft: 4,
                padding: "0 2px",
                cursor: "pointer",
                color: "var(--text-secondary)",
              }}
              title="关闭"
            >
              <CloseOutlined style={{ fontSize: 10 }} />
            </span>
          </span>
        ),
      };
    }
    const key = `${entry.database}|${entry.table}`;
    const info = tableInfos[key];
    const isView = info?.table_type === "VIEW";
    return {
      key: String(index),
      label: (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          {isView ? (
            <EyeOutlined style={{ color: "#faad14", fontSize: 12 }} />
          ) : (
            <TableOutlined style={{ color: "#52c41a", fontSize: 12 }} />
          )}
          <span style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>
            {entry.table}
          </span>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              closeTab(connId, index);
              removeTableFromCache(connId, entry.database, entry.table);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                closeTab(connId, index);
                removeTableFromCache(connId, entry.database, entry.table);
              }
            }}
            style={{
              marginLeft: 4,
              padding: "0 2px",
              cursor: "pointer",
              color: "var(--text-secondary)",
            }}
            title="关闭"
          >
            <CloseOutlined style={{ fontSize: 10 }} />
          </span>
        </span>
      ),
    };
  });

  return (
    <div
      style={{
        marginBottom: 12,
        borderBottom: "1px solid var(--border-color)",
      }}
    >
      <Tabs
        size="small"
        type="card"
        activeKey={String(activeTabIndex)}
        onChange={(key) => {
          const idx = parseInt(key, 10);
          if (!isNaN(idx) && connId) {
            switchTab(connId, idx);
          }
        }}
        onTabClick={(key, e) => {
          if (e.shiftKey && connId) {
            e.preventDefault();
            e.stopPropagation();
            const idx = parseInt(key, 10);
            if (!isNaN(idx) && idx >= 0 && idx < openTabs.length) {
              const entry = openTabs[idx];
              closeTab(connId, idx);
              if (entry.type === "table") {
                removeTableFromCache(connId, entry.database, entry.table);
              }
            }
          }
        }}
        items={items}
        style={{ marginBottom: 0 }}
      />
    </div>
  );
}
