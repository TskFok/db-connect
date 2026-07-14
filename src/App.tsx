import { useEffect, useCallback, useRef, useState } from "react";
import { DiffOutlined } from "@ant-design/icons";
import { Button, Layout, message } from "antd";
import { ConnectionList } from "./components/connection/ConnectionList";
import { ConnectionForm } from "./components/connection/ConnectionForm";
import { DatabaseTree } from "./components/database/DatabaseTree";
import { DatabaseOverview } from "./components/database/DatabaseOverview";
import { TableContent } from "./components/table/TableContent";
import { TableTabsBar } from "./components/table/TableTabsBar";
import { SqlEditor } from "./components/sql/SqlEditorLazy";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { GlobalLoadingBar } from "./components/common/GlobalLoadingBar";
import { ProjectIntroModal } from "./components/common/ProjectIntroModal";
import { ProjectIntroTrigger } from "./components/common/ProjectIntroTrigger";
import { ShortcutsHelpModal } from "./components/common/ShortcutsHelpModal";
import { ThemeToggle } from "./components/common/ThemeToggle";
import { IdleTimeoutSetting } from "./components/common/IdleTimeoutSetting";
import { DatabaseCompareModal } from "./components/databaseCompare/DatabaseCompareModal";
import { useIdleDisconnect } from "./hooks/useIdleDisconnect";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useGlobalErrorHandler } from "./hooks/useGlobalErrorHandler";
import { useConnectionRecovery } from "./hooks/useConnectionRecovery";
import { useConnectionStore } from "./stores/connectionStore";
import { useDatabaseStore } from "./stores/databaseStore";
import { isConnectionLostError } from "./utils/connectionErrors";
import { setActiveViewBreadcrumb } from "./utils/crashBreadcrumbs";
import {
  useSettingsStore,
  SIDEBAR_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
} from "./stores/settingsStore";

const { Content, Footer } = Layout;

function ConnectedEmptyState({
  connectionName,
  host,
  port,
}: {
  connectionName: string;
  host: string;
  port: number;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        flex: 1,
        minHeight: 0,
        color: "var(--text-secondary)",
      }}
    >
      <h2 style={{ color: "var(--text-primary)", marginBottom: 8 }}>
        已连接到 {connectionName}
      </h2>
      <p>
        {host}:{port}
      </p>
      <p style={{ fontSize: 13, marginTop: 16 }}>
        点击左侧数据库查看表列表，或选择一张表开始浏览
      </p>
    </div>
  );
}

function AppInner() {
  const {
    activeConnection,
    showConnectionForm,
    loading: connectionLoading,
    error,
    clearError,
    loadSavedConnections,
  } = useConnectionStore();

  const {
    selectedDatabase,
    selectedTable,
    openTabs,
    activeTabIndex,
    showDatabaseOverviewWhenSqlActive,
    treeLoading,
    structureLoading,
    tableContentActiveTab,
  } = useDatabaseStore();

  const { sidebarWidth, setSidebarWidth } = useSettingsStore();
  const resizeStartX = useRef<number>(0);
  const resizeStartW = useRef<number>(280);

  const [messageApi, contextHolder] = message.useMessage();
  const [introVisible, setIntroVisible] = useState(false);
  const [compareVisible, setCompareVisible] = useState(false);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizeStartX.current = e.clientX;
      resizeStartW.current = sidebarWidth;
      const onMove = (e: MouseEvent) => {
        const delta = e.clientX - resizeStartX.current;
        setSidebarWidth(resizeStartW.current + delta);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [sidebarWidth, setSidebarWidth]
  );

  // 全局错误监听
  useGlobalErrorHandler(messageApi);

  // 全局快捷键
  const { shortcutsVisible, setShortcutsVisible } = useKeyboardShortcuts();

  // 长时间空闲后自动断开连接，减少凭据驻留时间
  useIdleDisconnect((msg) => messageApi.info(msg));

  // 屏幕休眠 / 网络恢复后探测连接，失效则自动清理，避免页面停留在"已死却显示已连接"状态
  useConnectionRecovery((msg) => messageApi.warning(msg));

  // 初始加载已保存的连接
  useEffect(() => {
    loadSavedConnections();
  }, [loadSavedConnections]);

  // 显示错误信息；若错误形态属于"连接已死"，则同时把当前活跃连接强制清理，
  // 让用户可以直接点击连接重新建立，而不必关闭页面再来。
  useEffect(() => {
    if (!error) return;
    messageApi.error(error);
    if (isConnectionLostError(error)) {
      const { activeConnId, forceCleanupConnection } =
        useConnectionStore.getState();
      if (activeConnId) {
        void forceCleanupConnection(activeConnId);
      }
    }
    clearError();
  }, [error, messageApi, clearError]);

  useEffect(() => {
    if (showConnectionForm) {
      setActiveViewBreadcrumb("connection-form");
      return;
    }

    if (!activeConnection) {
      setActiveViewBreadcrumb("connection-list");
      return;
    }

    const activeTab = openTabs[activeTabIndex];
    if (activeTab?.type === "sql") {
      if (
        showDatabaseOverviewWhenSqlActive &&
        selectedDatabase &&
        !selectedTable
      ) {
        setActiveViewBreadcrumb("database-overview", {
          connection: activeConnection.config.name,
          database: selectedDatabase,
          source: "sql-tab",
        });
        return;
      }
      setActiveViewBreadcrumb("sql-tab", {
        connection: activeConnection.config.name,
        database: selectedDatabase,
        tab_id: activeTab.id,
      });
      return;
    }

    if (activeTab?.type === "table") {
      setActiveViewBreadcrumb("table-content", {
        connection: activeConnection.config.name,
        database: activeTab.database,
        table: activeTab.table,
        tab: tableContentActiveTab,
      });
      return;
    }

    if (selectedDatabase) {
      setActiveViewBreadcrumb("database-overview", {
        connection: activeConnection.config.name,
        database: selectedDatabase,
      });
      return;
    }

    setActiveViewBreadcrumb("connection-home", {
      connection: activeConnection.config.name,
    });
  }, [
    activeConnection,
    activeTabIndex,
    openTabs,
    selectedDatabase,
    selectedTable,
    showConnectionForm,
    showDatabaseOverviewWhenSqlActive,
    tableContentActiveTab,
  ]);

  // 是否有任何全局加载状态
  const isGlobalLoading = connectionLoading || treeLoading || structureLoading;

  return (
    <Layout
      hasSider
      style={{ height: "100vh" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {contextHolder}

      {/* 全局加载条 */}
      <GlobalLoadingBar loading={isGlobalLoading} />

      {/* 快捷键帮助弹窗 */}
      <ShortcutsHelpModal
        open={shortcutsVisible}
        onClose={() => setShortcutsVisible(false)}
      />
      <ProjectIntroModal
        open={introVisible}
        onClose={() => setIntroVisible(false)}
      />
      <DatabaseCompareModal
        open={compareVisible}
        onClose={() => setCompareVisible(false)}
      />

      {/* 左侧边栏（可拖拽调整宽度） */}
      <div
        className="app-resizable-sider"
        style={{
          flex: `0 0 ${sidebarWidth}px`,
          width: sidebarWidth,
          minWidth: SIDEBAR_WIDTH_MIN,
          maxWidth: SIDEBAR_WIDTH_MAX,
          position: "relative",
          background: "var(--bg-secondary)",
          borderRight: "1px solid var(--border-color)",
          overflow: "hidden",
          display: "flex",
        }}
      >
        <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
          {activeConnection && !showConnectionForm ? (
            <DatabaseTree />
          ) : (
            <ConnectionList />
          )}
        </div>
        <div
          className="app-sider-resize-handle"
          onMouseDown={handleResizeStart}
          title="拖拽调整宽度"
        />
      </div>

      {/* 主内容区：Content 不再整体滚动，避免与 Tabs/表格内部滚动叠加导致高度与滚动条反复震荡 */}
      <Layout
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Content
          style={{
            padding: "24px",
            overflow: "hidden",
            background: "var(--bg-primary)",
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {showConnectionForm ? (
            <div className="connection-form-page">
              <ConnectionForm />
            </div>
          ) : activeConnection ? (
            openTabs.length > 0 ? (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <TableTabsBar />
                {(() => {
                  const activeTab = openTabs[activeTabIndex];
                  if (activeTab?.type === "sql") {
                    // 在 SQL 标签页点击数据库时展示表列表，点击 SQL 标签时恢复 SQL 编辑器
                    if (
                      showDatabaseOverviewWhenSqlActive &&
                      selectedDatabase &&
                      !selectedTable
                    ) {
                      return (
                        <div
                          style={{
                            flex: 1,
                            minHeight: 0,
                            display: "flex",
                            flexDirection: "column",
                          }}
                        >
                          <DatabaseOverview />
                        </div>
                      );
                    }
                    return (
                      <div
                        style={{
                          flex: 1,
                          minHeight: 0,
                          display: "flex",
                          flexDirection: "column",
                        }}
                      >
                        <SqlEditor key={activeTab.id} tabId={activeTab.id} />
                      </div>
                    );
                  }
                  if (
                    activeTab?.type === "table" &&
                    selectedDatabase &&
                    selectedTable
                  ) {
                    return (
                      <TableContent
                        key={`${selectedDatabase}|${selectedTable}`}
                      />
                    );
                  }
                  return selectedDatabase ? (
                    <div
                      style={{
                        flex: 1,
                        minHeight: 0,
                        display: "flex",
                        flexDirection: "column",
                      }}
                    >
                      <DatabaseOverview />
                    </div>
                  ) : (
                    <ConnectedEmptyState
                      connectionName={activeConnection.config.name}
                      host={activeConnection.config.host}
                      port={activeConnection.config.port}
                    />
                  );
                })()}
              </div>
            ) : selectedDatabase ? (
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <DatabaseOverview />
              </div>
            ) : (
              <ConnectedEmptyState
                connectionName={activeConnection.config.name}
                host={activeConnection.config.host}
                port={activeConnection.config.port}
              />
            )
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                flex: 1,
                minHeight: 0,
                color: "var(--text-secondary)",
              }}
            >
              <h1
                style={{
                  fontSize: 36,
                  fontWeight: 300,
                  color: "var(--text-primary)",
                  marginBottom: 16,
                }}
              >
                DB Connect
              </h1>
              <p style={{ fontSize: 15 }}>
                点击左侧 "新建连接" 添加 MySQL 或 PostgreSQL，或选择已保存的连接
              </p>
              <p
                style={{
                  fontSize: 12,
                  marginTop: 24,
                  color: "var(--text-muted)",
                }}
              >
                按{" "}
                <span className="shortcut-key">
                  {navigator.platform.includes("Mac") ? "Cmd" : "Ctrl"}
                </span>{" "}
                + <span className="shortcut-key">/</span> 查看所有快捷键
              </p>
            </div>
          )}
        </Content>

        {/* 底部状态栏 */}
        <Footer
          style={{
            padding: "6px 16px",
            background: "var(--bg-secondary)",
            borderTop: "1px solid var(--border-color)",
            fontSize: 12,
            color: "var(--text-secondary)",
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div>
            {activeConnection ? (
              <span>
                <span style={{ color: "var(--status-connected)" }}>●</span>{" "}
                已连接{" "}
                <strong style={{ color: "var(--status-connected)" }}>
                  {activeConnection.config.host}:{activeConnection.config.port}
                </strong>
                {activeConnection.config.database && (
                  <span> / {activeConnection.config.database}</span>
                )}
                {selectedDatabase && selectedTable && (
                  <span style={{ marginLeft: 12 }}>
                    {selectedDatabase}.{selectedTable}
                  </span>
                )}
                {activeConnection.config.ssh && (
                  <span style={{ marginLeft: 12 }}>
                    SSH: {activeConnection.config.ssh.host}
                  </span>
                )}
              </span>
            ) : (
              <span>● 未连接</span>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Button
              type="text"
              size="small"
              icon={<DiffOutlined />}
              aria-label="数据库对比"
              onClick={() => setCompareVisible(true)}
            >
              数据库对比
            </Button>
            <IdleTimeoutSetting />
            <ProjectIntroTrigger onOpen={() => setIntroVisible(true)} />
            <ThemeToggle />
          </div>
        </Footer>
      </Layout>
    </Layout>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <AppInner />
    </ErrorBoundary>
  );
}

export default App;
