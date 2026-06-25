import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export const ELEMENT_HEIGHT_MEASURE_TRUST_MIN = 8;

const REMEASURE_MAX_FRAMES = 15;

export interface UseElementHeightOptions {
  /** 测量结果的下限（像素） */
  minHeight?: number;
  /** 变化时主动重测（如 Tab 切换、面板从 display:none 变为可见） */
  remeasureKey?: unknown;
}

/**
 * 用 ResizeObserver 跟踪元素 contentRect 高度，供表格 scroll.y 等布局计算使用。
 */
export function useElementHeight(options?: UseElementHeightOptions) {
  const minHeight = options?.minHeight ?? 0;
  const [height, setHeight] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  const elementRef = useRef<HTMLElement | null>(null);

  const applyHeight = useCallback(
    (raw: number) => {
      if (!Number.isFinite(raw) || raw < ELEMENT_HEIGHT_MEASURE_TRUST_MIN) return;
      const next = Math.max(Math.round(raw), minHeight);
      setHeight((prev) => (Math.abs(prev - next) < 0.5 ? prev : next));
    },
    [minHeight]
  );

  const measureNow = useCallback(() => {
    const node = elementRef.current;
    if (!node) return;
    requestAnimationFrame(() => applyHeight(node.getBoundingClientRect().height));
  }, [applyHeight]);

  const ref = useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      elementRef.current = node;

      if (!node) return;

      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        requestAnimationFrame(() => applyHeight(entry.contentRect.height));
      });
      observer.observe(node);
      observerRef.current = observer;
      measureNow();
    },
    [applyHeight, measureNow]
  );

  useLayoutEffect(() => {
    if (options?.remeasureKey === undefined) return;
    let cancelled = false;
    let frames = 0;

    const tick = () => {
      if (cancelled) return;
      const el = elementRef.current;
      if (!el) return;
      const raw = el.getBoundingClientRect().height;
      if (raw >= ELEMENT_HEIGHT_MEASURE_TRUST_MIN) {
        applyHeight(raw);
        return;
      }
      frames += 1;
      if (frames < REMEASURE_MAX_FRAMES) {
        requestAnimationFrame(tick);
      }
    };

    tick();
    return () => {
      cancelled = true;
    };
  }, [options?.remeasureKey, applyHeight]);

  useEffect(() => () => observerRef.current?.disconnect(), []);

  return { ref, height, measureNow };
}
