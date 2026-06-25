import { useEffect, useRef } from "react";
import { useConnectionStore } from "../stores/connectionStore";
import { useSettingsStore } from "../stores/settingsStore";
import * as api from "../services/tauriCommands";

/** 空闲检测间隔（毫秒） */
const CHECK_INTERVAL_MS = 60_000;

/**
 * 当有活跃连接且启用了空闲超时时，定期检查并在超时后自动断开连接，
 * 减少凭据驻留时间。支持多连接，对每个连接分别检测。
 */
export function useIdleDisconnect(onDisconnected?: (message: string) => void) {
  const { activeConnections, disconnect } = useConnectionStore();
  const idleTimeoutMinutes = useSettingsStore(
    (s) => s.idleTimeoutMinutes
  );
  const onDisconnectedRef = useRef(onDisconnected);
  onDisconnectedRef.current = onDisconnected;

  const activeConnectionIds = Object.keys(activeConnections);
  const connIdsKey = activeConnectionIds.join(",");
  const hasActiveConnections = activeConnectionIds.length > 0;

  useEffect(() => {
    if (!hasActiveConnections || idleTimeoutMinutes <= 0) {
      return;
    }

    const intervalId = setInterval(async () => {
      try {
        const { activeConnections: conns, activeConnId: currentId } =
          useConnectionStore.getState();
        const ids = Object.keys(conns);
        for (const connId of ids) {
          const conn = conns[connId];
          if (!conn) continue;

          const wasDisconnected = await api.checkIdleDisconnect(
            connId,
            idleTimeoutMinutes * 60
          );
          if (wasDisconnected) {
            await disconnect(connId);
            const wasActive = currentId === connId;
            onDisconnectedRef.current?.(
              `连接${wasActive ? "" : ` "${conn.config.name}"`}因长时间空闲（${idleTimeoutMinutes} 分钟）已自动断开`
            );
            break; // 一次只处理一个，下次 interval 会检查其余的
          }
        }
      } catch {
        // 忽略检查失败，可能是连接已失效
      }
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [connIdsKey, hasActiveConnections, idleTimeoutMinutes, disconnect]);
}
