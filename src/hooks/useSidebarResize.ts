import { useCallback, useEffect, useRef } from "react";
import type { MouseEventHandler, RefObject } from "react";

interface SidebarResizeOptions {
  width: number;
  minWidth: number;
  maxWidth: number;
  onCommit: (width: number) => void;
}

interface ResizeSession {
  cancel: () => void;
}

/** 拖动只按帧预览 DOM，完成后提交一次；取消时恢复已提交宽度。 */
export function useSidebarResize({
  width,
  minWidth,
  maxWidth,
  onCommit,
}: SidebarResizeOptions): {
  siderRef: RefObject<HTMLDivElement>;
  onMouseDown: MouseEventHandler<HTMLDivElement>;
} {
  const siderRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<ResizeSession | null>(null);

  useEffect(() => () => sessionRef.current?.cancel(), []);

  const onMouseDown = useCallback<MouseEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.button !== 0 || sessionRef.current || !siderRef.current) return;
      event.preventDefault();
      const element = siderRef.current;
      const startX = event.clientX;
      const startWidth = width;
      let lastWidth = startWidth;
      let frame: number | null = null;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;

      const preview = (nextWidth: number) => {
        element.style.width = `${nextWidth}px`;
        element.style.flexBasis = `${nextWidth}px`;
      };
      const clear = () => {
        sessionRef.current = null;
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onBlur);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
      };
      const session: ResizeSession = {
        cancel: () => {
          clear();
          preview(startWidth);
        },
      };
      const onMove = (moveEvent: MouseEvent) => {
        lastWidth = Math.min(
          maxWidth,
          Math.max(minWidth, startWidth + moveEvent.clientX - startX)
        );
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
          // 取消或完成后，旧帧即使被调度也不能覆盖 React 的最新提交。
          if (sessionRef.current !== session) return;
          frame = null;
          preview(lastWidth);
        });
      };
      const onUp = () => {
        clear();
        preview(lastWidth);
        if (lastWidth !== startWidth) onCommit(lastWidth);
      };
      const onBlur = () => session.cancel();

      sessionRef.current = session;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      window.addEventListener("blur", onBlur);
    },
    [width, minWidth, maxWidth, onCommit]
  );

  return { siderRef, onMouseDown };
}
