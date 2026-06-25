import {
  RESIZABLE_COL_MAX_WIDTH,
  RESIZABLE_COL_MIN_WIDTH,
} from "../components/common/ResizableTableHeaderCell";

/** 表头文字测量字体（与 antd small table 表头接近） */
export const AUTO_FIT_HEADER_FONT =
  '600 12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** 单元格文字测量字体 */
export const AUTO_FIT_CELL_FONT =
  '12px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** canvas 不可用时的 fallback 字符宽度 */
const FALLBACK_CHAR_WIDTH = 7;

let measureCtx: CanvasRenderingContext2D | null | undefined;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureCtx !== undefined) {
    return measureCtx;
  }
  if (typeof document === "undefined") {
    measureCtx = null;
    return null;
  }
  const canvas = document.createElement("canvas");
  measureCtx = canvas.getContext("2d");
  return measureCtx;
}

/** 重置 canvas 上下文（测试用） */
export function resetAutoFitMeasureContext(): void {
  measureCtx = undefined;
}

/** 用 canvas measureText 估算字符串渲染宽度 */
export function measureTextWidth(text: string, font: string): number {
  const sample = text || "";
  const ctx = getMeasureContext();
  if (!ctx) {
    return sample.length * FALLBACK_CHAR_WIDTH;
  }
  ctx.font = font;
  const width = ctx.measureText(sample).width;
  return width > 0 ? width : sample.length * FALLBACK_CHAR_WIDTH;
}

export interface ComputeAutoFitColumnWidthOptions {
  min?: number;
  max?: number;
  /** 单元格左右 padding */
  cellPadding?: number;
  /** 表头额外占位（拖拽手柄、排序图标等） */
  headerExtra?: number;
}

/**
 * 根据表头与样本单元格文本计算列宽。
 * 取最长文本宽度 + padding，并限制在可调节范围内。
 */
export function computeAutoFitColumnWidth(
  headerText: string,
  cellTexts: readonly string[],
  options?: ComputeAutoFitColumnWidthOptions
): number {
  const min = options?.min ?? RESIZABLE_COL_MIN_WIDTH;
  const max = options?.max ?? RESIZABLE_COL_MAX_WIDTH;
  const cellPadding = options?.cellPadding ?? 24;
  const headerExtra = options?.headerExtra ?? 0;

  let maxContent = 0;
  const headerWidth =
    measureTextWidth(headerText, AUTO_FIT_HEADER_FONT) +
    cellPadding +
    headerExtra;
  maxContent = Math.max(maxContent, headerWidth);

  for (const text of cellTexts) {
    const cellWidth =
      measureTextWidth(text, AUTO_FIT_CELL_FONT) + cellPadding;
    maxContent = Math.max(maxContent, cellWidth);
  }

  return Math.round(Math.min(max, Math.max(min, maxContent)));
}

/** 从 antd 列 title 提取纯文本（复杂 ReactNode 需由调用方提供 headerLabels） */
export function columnTitleToString(title: unknown, fallback = ""): string {
  if (typeof title === "string" || typeof title === "number") {
    return String(title);
  }
  return fallback;
}

export interface CreateListColumnAutoFitOptions {
  /** 复杂表头 JSX 时的纯文本标签 */
  headerLabels?: Record<string, string>;
  /** 可排序/可拖拽表头时的额外宽度 */
  sortableHeaders?: boolean;
  /** 采样行数上限，避免大表卡顿 */
  sampleLimit?: number;
  /** 特定列的最小自适应宽度 */
  minWidths?: Record<string, number>;
}

/**
 * 基于当前数据源生成列宽自适应函数，供双击表头边缘时使用。
 */
export function createListColumnAutoFit<T>(
  definitions: Record<string, { title?: unknown }>,
  dataSource: readonly T[],
  getCellText: (record: T, columnKey: string) => string,
  options?: CreateListColumnAutoFitOptions
): (columnKey: string) => number {
  const sampleLimit = options?.sampleLimit ?? 200;
  const headerExtra = options?.sortableHeaders ? 56 : 28;

  return (columnKey: string) => {
    const def = definitions[columnKey];
    if (!def) {
      return RESIZABLE_COL_MIN_WIDTH;
    }

    const headerText =
      options?.headerLabels?.[columnKey] ??
      columnTitleToString(def.title, columnKey);

    const cellTexts: string[] = [];
    const limit = Math.min(dataSource.length, sampleLimit);
    for (let i = 0; i < limit; i++) {
      const record = dataSource[i];
      if (record != null) {
        cellTexts.push(getCellText(record, columnKey));
      }
    }

    const width = computeAutoFitColumnWidth(headerText, cellTexts, {
      headerExtra,
    });
    const minOverride = options?.minWidths?.[columnKey];
    if (minOverride != null) {
      return Math.max(width, minOverride);
    }
    return width;
  };
}
