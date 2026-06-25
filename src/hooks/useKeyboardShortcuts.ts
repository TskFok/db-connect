import { useEffect, useState, useCallback } from "react";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";
import { useTableDataStore } from "../stores/tableDataStore";
import { useThemeStore } from "../stores/themeStore";

/**
 * 全局键盘快捷键 Hook
 *
 * 支持的快捷键:
 * - Cmd/Ctrl + N: 新建连接
 * - Cmd/Ctrl + R: 刷新 (在数据行页面时刷新数据行，否则刷新数据库树)
 * - Cmd/Ctrl + Shift + R: 刷新分页 (在数据行页面时重新统计总行数)
 * - Cmd/Ctrl + D: 断开连接
 * - Cmd/Ctrl + L: 切换深色/浅色主题
 * - Cmd/Ctrl + /: 显示/隐藏快捷键帮助
 */
export function useKeyboardShortcuts() {
  const [shortcutsVisible, setShortcutsVisible] = useState(false);

  const showNewConnectionForm = useConnectionStore(
    (s) => s.showNewConnectionForm
  );
  const activeConnection = useConnectionStore((s) => s.activeConnection);
  const disconnectFn = useConnectionStore((s) => s.disconnect);
  const refresh = useDatabaseStore((s) => s.refresh);
  const resetDb = useDatabaseStore((s) => s.reset);
  const selectedDatabase = useDatabaseStore((s) => s.selectedDatabase);
  const selectedTable = useDatabaseStore((s) => s.selectedTable);
  const tableContentActiveTab = useDatabaseStore((s) => s.tableContentActiveTab);
  const loadData = useTableDataStore((s) => s.loadData);
  const refreshPagination = useTableDataStore((s) => s.refreshPagination);
  const toggleTheme = useThemeStore((s) => s.toggleTheme);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (!isMod) return;

      // 不拦截输入框中的某些快捷键 (如 Cmd+A, Cmd+C 等)
      const target = e.target as HTMLElement;
      const isEditable =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      switch (e.key.toLowerCase()) {
        case "n":
          // Cmd/Ctrl + N: 新建连接
          e.preventDefault();
          showNewConnectionForm();
          break;

        case "r":
          // Cmd/Ctrl + Shift + R: 刷新分页；Cmd/Ctrl + R: 刷新数据或数据库树
          e.preventDefault();
          if (e.shiftKey) {
            if (
              activeConnection &&
              selectedDatabase &&
              selectedTable &&
              tableContentActiveTab === "data"
            ) {
              void refreshPagination(
                activeConnection.connId,
                selectedDatabase,
                selectedTable
              );
            }
            break;
          }
          if (activeConnection) {
            if (selectedDatabase && selectedTable && tableContentActiveTab === "data") {
              loadData(activeConnection.connId, selectedDatabase, selectedTable);
            } else {
              refresh(activeConnection.connId);
            }
          }
          break;

        case "d":
          // Cmd/Ctrl + D: 断开连接
          if (isEditable) return; // 不在输入框中拦截
          e.preventDefault();
          if (activeConnection) {
            resetDb();
            disconnectFn();
          }
          break;

        case "l":
          // Cmd/Ctrl + L: 切换主题
          if (isEditable) return;
          e.preventDefault();
          toggleTheme();
          break;

        case "/":
          // Cmd/Ctrl + /: 显示快捷键帮助
          e.preventDefault();
          setShortcutsVisible((prev) => !prev);
          break;

        default:
          break;
      }
    },
    [
      showNewConnectionForm,
      activeConnection,
      disconnectFn,
      refresh,
      resetDb,
      toggleTheme,
      selectedDatabase,
      selectedTable,
      tableContentActiveTab,
      loadData,
      refreshPagination,
    ]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleKeyDown]);

  return { shortcutsVisible, setShortcutsVisible };
}
