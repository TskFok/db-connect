/** antd Table size="small" 表头行高约 39px */
export const ANT_TABLE_HEADER_HEIGHT_SMALL = 39;

const MEASURE_TRUST_MIN = 8;

/**
 * 根据容器高度计算 antd Table 的 scroll.y（表体最大高度）。
 * 容器未布局完成时返回 undefined，避免使用错误的 viewport 估算值。
 */
export function computeAntTableScrollY(
  containerHeight: number,
  headerHeight = ANT_TABLE_HEADER_HEIGHT_SMALL
): number | undefined {
  if (!Number.isFinite(containerHeight) || containerHeight < MEASURE_TRUST_MIN) {
    return undefined;
  }
  const bodyHeight = containerHeight - headerHeight;
  if (bodyHeight <= 0) return undefined;
  return bodyHeight;
}
