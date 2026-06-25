import { useConnectionStore } from "../stores/connectionStore";

/**
 * 当前活跃连接是否应按只读对待界面（写按钮灰显等）：
 * - 连接配置中勾选「只读连接」
 * - 或 `SHOW GRANTS` 推断当前账号无写类权限（仅 SELECT/USAGE 等）
 */
export function useClientReadOnly(): boolean {
  return useConnectionStore((s) => {
    const ac = s.activeConnection;
    if (!ac) return false;
    if (ac.config.read_only === true) return true;
    if (ac.sessionGrantWriteCapable === false) return true;
    return false;
  });
}
