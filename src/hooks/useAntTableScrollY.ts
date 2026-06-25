import { useElementHeight } from "./useElementHeight";
import { computeAntTableScrollY } from "../utils/antTableLayout";

export interface UseAntTableScrollYOptions {
  /** 变化时主动重测（如 Tab 切换、面板从 display:none 变为可见） */
  remeasureKey?: unknown;
  minHeight?: number;
}

/**
 * 测量表格容器高度并计算 antd Table 的 scroll.y。
 */
export function useAntTableScrollY(options?: UseAntTableScrollYOptions) {
  const { ref: containerRef, height: containerHeight } = useElementHeight({
    minHeight: options?.minHeight,
    remeasureKey: options?.remeasureKey,
  });
  const scrollY = computeAntTableScrollY(containerHeight);

  return { containerRef, scrollY, containerHeight };
}
