import { useEffect, useRef } from "react";
import { useConnectionStore } from "../stores/connectionStore";
import * as api from "../services/tauriCommands";

/**
 * 屏幕休眠 / 网络切换后的连接恢复 Hook
 *
 * 触发时机：
 * - `visibilitychange` 由 `hidden` 变 `visible`（盖上盖子后再打开屏幕）。
 * - `online` 事件（网络断开后恢复）。
 * - `focus` 事件（窗口长时间失焦后重新获得焦点）。
 *
 * 行为：依次 ping 每个活跃连接；若任一连接探测失败，则前端无脑把该连接
 * 从活跃列表中移除（同时尽力让后端清理底层资源），避免出现"连接已死、
 * 页面仍显示已连接、任何操作都报『获取连接失败: Connection refused』"
 * 的卡死状态。用户可直接重新点击连接而无需手动关闭页面。
 *
 * 单次触发内会做防抖（连续触发只检测一次），避免 visibilitychange + focus
 * 同时到达时重复 ping。
 */
export function useConnectionRecovery(onConnectionLost?: (message: string) => void) {
  const onConnectionLostRef = useRef(onConnectionLost);
  onConnectionLostRef.current = onConnectionLost;

  useEffect(() => {
    let checking = false;

    const runHealthCheck = async () => {
      if (checking) return;
      checking = true;
      try {
        // 抓取一次快照；下面调用 forceCleanupConnection 会修改 store，但每个 connId 处理后再读最新。
        const { activeConnections } = useConnectionStore.getState();
        const connIds = Object.keys(activeConnections);
        if (connIds.length === 0) return;

        for (const connId of connIds) {
          // 再次确认连接仍在（可能被其它路径同时清理）
          const current = useConnectionStore.getState().activeConnections[connId];
          if (!current) continue;

          let alive = false;
          try {
            alive = await api.pingConnection(connId);
          } catch {
            // ping 自身抛错也视为不可用（例如后端崩溃 / 连接已被空闲超时移除）
            alive = false;
          }
          if (alive) continue;

          const connName = current.config.name;
          await useConnectionStore.getState().forceCleanupConnection(connId);
          onConnectionLostRef.current?.(
            `检测到连接${connName ? ` "${connName}"` : ""}已断开（可能因屏幕休眠或网络中断），已自动清理`
          );
        }
      } finally {
        checking = false;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void runHealthCheck();
      }
    };
    const onOnline = () => {
      void runHealthCheck();
    };
    const onFocus = () => {
      void runHealthCheck();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("focus", onFocus);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
}
