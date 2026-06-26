import { create } from "zustand";
import type {
  ActiveConnection,
  ConnectionConfig,
  ConnectionGroup,
  ConnectionImportResult,
} from "../types";
import * as api from "../services/tauriCommands";
import { useDatabaseStore } from "./databaseStore";
import { useTableDataStore } from "./tableDataStore";
import {
  normalizeConnectionConfig,
  normalizeDatabaseType,
} from "../utils/connectionConfig";

/** 判断两个配置是否表示同一连接（用于连接复用） */
function configMatches(a: ConnectionConfig, b: ConnectionConfig): boolean {
  const typeA = normalizeDatabaseType(a.database_type);
  const typeB = normalizeDatabaseType(b.database_type);
  if (typeA !== typeB) return false;
  if (typeA === "sqlite") {
    const idsMatch = !a.id || !b.id || a.id === b.id;
    return (
      idsMatch &&
      (a.sqlite_path ?? "").trim() === (b.sqlite_path ?? "").trim() &&
      (a.read_only === true) === (b.read_only === true) &&
      (a.skip_dangerous_sql_confirm === true) ===
        (b.skip_dangerous_sql_confirm === true)
    );
  }
  if (a.id && b.id) return a.id === b.id;
  const sslA = `${a.ssl_mode ?? ""}|${a.ssl_ca_path ?? ""}|${a.ssl_pkcs12_path ?? ""}|${a.ssl_tls_hostname ?? ""}`;
  const sslB = `${b.ssl_mode ?? ""}|${b.ssl_ca_path ?? ""}|${b.ssl_pkcs12_path ?? ""}|${b.ssl_tls_hostname ?? ""}`;
  const advA = `${a.client_charset ?? ""}|${JSON.stringify(a.session_init_commands ?? [])}|${a.read_only === true}|${a.skip_dangerous_sql_confirm === true}`;
  const advB = `${b.client_charset ?? ""}|${JSON.stringify(b.session_init_commands ?? [])}|${b.read_only === true}|${b.skip_dangerous_sql_confirm === true}`;
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.username === b.username &&
    sslA === sslB &&
    advA === advB
  );
}

/** 根据 config 在 activeConnections 中查找已存在的 connId */
function findExistingConnId(
  connections: Record<string, ActiveConnection>,
  config: ConnectionConfig
): string | null {
  for (const [connId, conn] of Object.entries(connections)) {
    if (configMatches(conn.config, config)) return connId;
  }
  return null;
}

interface ConnectionState {
  /** 已保存的连接列表 */
  savedConnections: ConnectionConfig[];
  /** 连接分组列表 */
  connectionGroups: ConnectionGroup[];
  /** 所有已建立的连接 (connId -> 连接) */
  activeConnections: Record<string, ActiveConnection>;
  /** 当前激活的 connId */
  activeConnId: string | null;
  /** 当前活跃的连接（派生：activeConnections[activeConnId]） */
  activeConnection: ActiveConnection | null;
  /** 是否正在加载 */
  loading: boolean;
  /** 错误信息 */
  error: string | null;
  /** 是否显示连接表单 */
  showConnectionForm: boolean;
  /** 正在编辑的连接 (null 表示新建) */
  editingConnection: ConnectionConfig | null;

  // Actions
  /** 加载已保存的连接 */
  loadSavedConnections: () => Promise<void>;
  /** 保存连接配置 */
  saveConnection: (config: ConnectionConfig) => Promise<void>;
  /** 删除已保存的连接 */
  deleteSavedConnection: (id: string) => Promise<void>;
  /** 按指定顺序重新排列连接 */
  reorderConnections: (ids: string[]) => Promise<void>;
  /** 导出所有连接和分组到指定文件 */
  exportConnections: (path: string, password: string) => Promise<number>;
  /** 从指定文件导入连接和分组 */
  importConnections: (
    path: string,
    password: string
  ) => Promise<ConnectionImportResult>;
  /** 加载连接分组 */
  loadConnectionGroups: () => Promise<void>;
  /** 创建连接分组 */
  createConnectionGroup: (name: string) => Promise<void>;
  /** 重命名连接分组 */
  renameConnectionGroup: (id: string, name: string) => Promise<void>;
  /** 删除连接分组；组内连接回到未分组 */
  deleteConnectionGroup: (id: string) => Promise<void>;
  /** 设置连接分组折叠状态 */
  setConnectionGroupCollapsed: (
    id: string,
    collapsed: boolean
  ) => Promise<void>;
  /** 按指定顺序重新排列连接分组 */
  reorderConnectionGroups: (ids: string[]) => Promise<void>;
  /** 移动连接到分组并保存新的全局顺序 */
  moveConnectionToGroup: (
    connectionId: string,
    groupId: string | null,
    orderedIds: string[]
  ) => Promise<void>;
  /** 测试连接 */
  testConnection: (
    config: ConnectionConfig
  ) => Promise<{ success: boolean; message: string }>;
  /** 建立连接（若已存在则复用并切换） */
  connect: (config: ConnectionConfig) => Promise<void>;
  /** 断开连接（不传 connId 时断开当前激活连接） */
  disconnect: (connId?: string) => Promise<void>;
  /**
   * 强制清理连接：用于底层连接已被对端 / 系统休眠 / 网络切换掐断的场景，
   * 前端无脑清掉活跃连接状态，并尽力让后端释放底层资源（不抛错）。
   * 与 `disconnect` 的区别：不会因为后端断开报错而残留状态；不会设置 `error`。
   */
  forceCleanupConnection: (connId: string) => Promise<void>;
  /** 切换到指定连接（不断开） */
  switchActive: (connId: string) => void;
  /** 显示新建连接表单 */
  showNewConnectionForm: () => void;
  /** 显示编辑连接表单（根据 id 获取解密后的配置） */
  showEditConnectionForm: (id: string) => Promise<void>;
  /** 隐藏连接表单 */
  hideConnectionForm: () => void;
  /** 清除错误 */
  clearError: () => void;
}

function syncActiveConnection(
  connections: Record<string, ActiveConnection>,
  activeId: string | null
): ActiveConnection | null {
  if (!activeId) return null;
  return connections[activeId] ?? null;
}

export const useConnectionStore = create<ConnectionState>((set, get) => {
  /** 根据 get_session_info 写入 grant_write_capable，供只读账号 UI 灰显 */
  const patchSessionGrantWriteCapable = async (connId: string) => {
    const conn = get().activeConnections[connId];
    if (!conn) return;
    try {
      const info = await api.getSessionInfoCached(
        connId,
        conn.config.database ?? null
      );
      const sessionGrantWriteCapable = info.grant_write_capable;
      set((state) => {
        const c = state.activeConnections[connId];
        if (!c) return state;
        const updated: ActiveConnection = { ...c, sessionGrantWriteCapable };
        return {
          activeConnections: { ...state.activeConnections, [connId]: updated },
          activeConnection:
            state.activeConnId === connId ? updated : state.activeConnection,
        };
      });
    } catch {
      /* 拉取失败时不写入，避免误判为只读 */
    }
  };

  return {
    savedConnections: [],
    connectionGroups: [],
    activeConnections: {},
    activeConnId: null,
    activeConnection: null,
    loading: false,
    error: null,
    showConnectionForm: false,
    editingConnection: null,

    loadSavedConnections: async () => {
      try {
        set({ loading: true, error: null });
        const connections = (await api.listSavedConnections()).map(
          normalizeConnectionConfig
        );
        set({ savedConnections: connections, loading: false });
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    saveConnection: async (config: ConnectionConfig) => {
      try {
        set({ loading: true, error: null });
        const configToSave = normalizeConnectionConfig(config);
        await api.saveConnection(configToSave);
        const connections = (await api.listSavedConnections()).map(
          normalizeConnectionConfig
        );
        const { activeConnections, activeConnId } = get();

        // 若正在编辑当前活跃连接的配置，更新其配置并选中新的默认数据库
        const activeConn = activeConnId
          ? activeConnections[activeConnId]
          : null;
        if (
          activeConn &&
          configToSave.id &&
          activeConn.config.id === configToSave.id
        ) {
          const updatedConn: ActiveConnection = {
            ...activeConn,
            config: { ...configToSave, id: activeConn.config.id },
          };
          const newConnections = {
            ...activeConnections,
            [activeConn.connId]: updatedConn,
          };
          const newActive = syncActiveConnection(newConnections, activeConnId);
          set({
            savedConnections: connections,
            loading: false,
            showConnectionForm: false,
            editingConnection: null,
            activeConnections: newConnections,
            activeConnection: newActive,
          });
          if (configToSave.database) {
            const { connectionStates, selectDatabase } =
              useDatabaseStore.getState();
            const state = activeConnId ? connectionStates[activeConnId] : null;
            if (state?.databases.includes(configToSave.database)) {
              await selectDatabase(activeConn.connId, configToSave.database);
            }
          }
        } else {
          set({
            savedConnections: connections,
            loading: false,
            showConnectionForm: false,
            editingConnection: null,
          });
        }
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    deleteSavedConnection: async (id: string) => {
      try {
        set({ loading: true, error: null });
        const { activeConnections, activeConnId } = get();

        // 查找使用该配置 id 的连接并断开
        const connToDisconnect = Object.entries(activeConnections).find(
          ([_, c]) => c.config.id === id
        );
        if (connToDisconnect) {
          const [connId] = connToDisconnect;
          await api.disconnect(connId);
          api.invalidateSessionInfoCache(connId);
          const newConnections = { ...activeConnections };
          delete newConnections[connId];
          const newActiveId =
            activeConnId === connId
              ? (Object.keys(newConnections)[0] ?? null)
              : activeConnId;
          const newActive = syncActiveConnection(newConnections, newActiveId);
          set({
            activeConnections: newConnections,
            activeConnId: newActiveId,
            activeConnection: newActive,
          });
          useDatabaseStore.getState().removeConnectionState(connId);
          useTableDataStore.getState().removeConnectionCache(connId);
        }

        await api.deleteSavedConnection(id);
        const connections = (await api.listSavedConnections()).map(
          normalizeConnectionConfig
        );
        set({ savedConnections: connections, loading: false });
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    reorderConnections: async (ids: string[]) => {
      try {
        set({ loading: true, error: null });
        await api.reorderConnections(ids);
        const connections = (await api.listSavedConnections()).map(
          normalizeConnectionConfig
        );
        set({ savedConnections: connections, loading: false });
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    exportConnections: async (path: string, password: string) => {
      try {
        set({ loading: true, error: null });
        const count = await api.exportConnections(path, password);
        set({ loading: false });
        return count;
      } catch (e) {
        set({ error: String(e), loading: false });
        throw e;
      }
    },

    importConnections: async (path: string, password: string) => {
      try {
        set({ loading: true, error: null });
        const result = await api.importConnections(path, password);
        const [groups, rawConnections] = await Promise.all([
          api.listConnectionGroups(),
          api.listSavedConnections(),
        ]);
        const connections = rawConnections.map(normalizeConnectionConfig);
        set({
          connectionGroups: groups,
          savedConnections: connections,
          loading: false,
        });
        return result;
      } catch (e) {
        set({ error: String(e), loading: false });
        throw e;
      }
    },

    loadConnectionGroups: async () => {
      try {
        set({ loading: true, error: null });
        const groups = await api.listConnectionGroups();
        set({ connectionGroups: groups, loading: false });
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    createConnectionGroup: async (name: string) => {
      try {
        set({ loading: true, error: null });
        await api.createConnectionGroup(name);
        const groups = await api.listConnectionGroups();
        set({ connectionGroups: groups, loading: false });
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    renameConnectionGroup: async (id: string, name: string) => {
      try {
        set({ loading: true, error: null });
        await api.renameConnectionGroup(id, name);
        const groups = await api.listConnectionGroups();
        set({ connectionGroups: groups, loading: false });
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    deleteConnectionGroup: async (id: string) => {
      try {
        set({ loading: true, error: null });
        await api.deleteConnectionGroup(id);
        const [groups, rawConnections] = await Promise.all([
          api.listConnectionGroups(),
          api.listSavedConnections(),
        ]);
        const connections = rawConnections.map(normalizeConnectionConfig);
        set({
          connectionGroups: groups,
          savedConnections: connections,
          loading: false,
        });
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    setConnectionGroupCollapsed: async (id: string, collapsed: boolean) => {
      try {
        set({ loading: true, error: null });
        await api.setConnectionGroupCollapsed(id, collapsed);
        const groups = await api.listConnectionGroups();
        set({ connectionGroups: groups, loading: false });
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    reorderConnectionGroups: async (ids: string[]) => {
      try {
        set({ loading: true, error: null });
        await api.reorderConnectionGroups(ids);
        const groups = await api.listConnectionGroups();
        set({ connectionGroups: groups, loading: false });
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    moveConnectionToGroup: async (
      connectionId: string,
      groupId: string | null,
      orderedIds: string[]
    ) => {
      try {
        set({ loading: true, error: null });
        await api.moveConnectionToGroup(connectionId, groupId, orderedIds);
        const connections = (await api.listSavedConnections()).map(
          normalizeConnectionConfig
        );
        set({ savedConnections: connections, loading: false });
      } catch (e) {
        set({ error: String(e), loading: false });
        try {
          const [groups, rawConnections] = await Promise.all([
            api.listConnectionGroups(),
            api.listSavedConnections(),
          ]);
          const connections = rawConnections.map(normalizeConnectionConfig);
          set({ connectionGroups: groups, savedConnections: connections });
        } catch {
          /* keep original error */
        }
      }
    },

    testConnection: async (config: ConnectionConfig) => {
      try {
        const result = await api.testConnection(
          normalizeConnectionConfig(config)
        );
        return { success: result.success, message: result.message };
      } catch (e) {
        return { success: false, message: String(e) };
      }
    },

    connect: async (config: ConnectionConfig) => {
      try {
        set({ loading: true, error: null });
        let configToUse = config;
        if (config.id) {
          configToUse = await api.getDecryptedConnection(config.id);
        }
        configToUse = normalizeConnectionConfig(configToUse);

        const { activeConnections } = get();
        const existingConnId = findExistingConnId(
          activeConnections,
          configToUse
        );

        if (existingConnId) {
          // 已存在该连接，直接切换
          const newActive = activeConnections[existingConnId];
          if (newActive.sessionGrantWriteCapable === undefined) {
            void patchSessionGrantWriteCapable(existingConnId);
          }
          set({
            activeConnId: existingConnId,
            activeConnection: newActive,
            loading: false,
            showConnectionForm: false,
          });
          useDatabaseStore.getState().switchToConnection(existingConnId);
          return;
        }

        const connId = await api.connect(configToUse);
        let sessionGrantWriteCapable: boolean | undefined;
        try {
          const info = await api.getSessionInfoCached(
            connId,
            configToUse.database ?? null
          );
          sessionGrantWriteCapable = info.grant_write_capable;
        } catch {
          sessionGrantWriteCapable = undefined;
        }
        const newConn: ActiveConnection = {
          connId,
          config: configToUse,
          sessionGrantWriteCapable,
        };
        const newConnections = { ...activeConnections, [connId]: newConn };
        const newActive = syncActiveConnection(newConnections, connId);

        set({
          activeConnections: newConnections,
          activeConnId: connId,
          activeConnection: newActive,
          loading: false,
          showConnectionForm: false,
        });
        useDatabaseStore.getState().switchToConnection(connId);
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    disconnect: async (connId?: string) => {
      const { activeConnections, activeConnId } = get();
      const toDisconnect = connId ?? activeConnId;
      if (!toDisconnect || !activeConnections[toDisconnect]) return;

      try {
        set({ loading: true, error: null });
        await api.disconnect(toDisconnect);
        api.invalidateSessionInfoCache(toDisconnect);

        const newConnections = { ...activeConnections };
        delete newConnections[toDisconnect];

        let newActiveId = activeConnId;
        if (activeConnId === toDisconnect) {
          newActiveId = Object.keys(newConnections)[0] ?? null;
        }
        const newActive = syncActiveConnection(newConnections, newActiveId);

        set({
          activeConnections: newConnections,
          activeConnId: newActiveId,
          activeConnection: newActive,
          loading: false,
        });

        useDatabaseStore.getState().removeConnectionState(toDisconnect);
        useTableDataStore.getState().removeConnectionCache(toDisconnect);
        if (newActiveId) {
          useDatabaseStore.getState().switchToConnection(newActiveId);
        }
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    forceCleanupConnection: async (connId: string) => {
      const { activeConnections, activeConnId } = get();
      if (!activeConnections[connId]) return;

      // 后端尽力释放底层资源（隧道 / 连接池），即便失败也不影响前端清理。
      try {
        await api.forceDisconnect(connId);
      } catch {
        /* ignore */
      }
      api.invalidateSessionInfoCache(connId);

      const newConnections = { ...activeConnections };
      delete newConnections[connId];

      let newActiveId = activeConnId;
      if (activeConnId === connId) {
        newActiveId = Object.keys(newConnections)[0] ?? null;
      }
      const newActive = syncActiveConnection(newConnections, newActiveId);

      set({
        activeConnections: newConnections,
        activeConnId: newActiveId,
        activeConnection: newActive,
      });

      useDatabaseStore.getState().removeConnectionState(connId);
      useTableDataStore.getState().removeConnectionCache(connId);
      if (newActiveId) {
        useDatabaseStore.getState().switchToConnection(newActiveId);
      }
    },

    switchActive: (connId: string) => {
      const { activeConnections } = get();
      if (!activeConnections[connId]) return;

      const newActive = activeConnections[connId];
      if (newActive.sessionGrantWriteCapable === undefined) {
        void patchSessionGrantWriteCapable(connId);
      }
      set({
        activeConnId: connId,
        activeConnection: newActive,
      });
      useDatabaseStore.getState().switchToConnection(connId);
    },

    showNewConnectionForm: () => {
      set({ showConnectionForm: true, editingConnection: null });
    },

    showEditConnectionForm: async (id: string) => {
      try {
        set({ loading: true, error: null });
        const config = normalizeConnectionConfig(
          await api.getDecryptedConnection(id)
        );
        set({
          showConnectionForm: true,
          editingConnection: config,
          loading: false,
        });
      } catch (e) {
        set({ error: String(e), loading: false });
      }
    },

    hideConnectionForm: () => {
      set({ showConnectionForm: false, editingConnection: null });
    },

    clearError: () => {
      set({ error: null });
    },
  };
});
