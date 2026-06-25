import { useEffect, useRef, forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";

export const RESIZABLE_COL_MIN_WIDTH = 60;
export const RESIZABLE_COL_MAX_WIDTH = 800;

export type ResizableTableHeaderCellProps = HTMLAttributes<HTMLTableCellElement> & {
  width?: number;
  onResize?: (newWidth: number) => void;
  /** 双击调节手柄时触发自适应列宽 */
  onAutoFit?: () => void;
  children?: ReactNode;
  /** 表头标题左侧内容（如列顺序拖拽手柄） */
  headerPrefix?: ReactNode;
  /** 合并到 th 的额外样式（如 dnd transform） */
  thStyle?: CSSProperties;
};

/**
 * antd Table 可拖拽调节列宽的表头单元格。
 * 通过 components.header.cell 接入，列定义中 onHeaderCell 返回 { width, onResize }。
 */
export const ResizableTableHeaderCell = forwardRef<
  HTMLTableCellElement,
  ResizableTableHeaderCellProps
>(function ResizableTableHeaderCell(
  {
    width,
    onResize,
    onAutoFit,
    children,
    style,
    className,
    headerPrefix,
    thStyle,
    ...restProps
  },
  ref
) {
  const hasResize = typeof width === "number" && typeof onResize === "function";
  const startRef = useRef<{ x: number; w: number } | null>(null);
  const handleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hasResize || !handleRef.current || !onResize) return;
    const el = handleRef.current;

    const startResize = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (startRef.current) return;
      startRef.current = { x: e.clientX, w: width! };

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!startRef.current) return;
        const delta = moveEvent.clientX - startRef.current.x;
        const newWidth = Math.round(
          Math.max(
            RESIZABLE_COL_MIN_WIDTH,
            Math.min(RESIZABLE_COL_MAX_WIDTH, startRef.current.w + delta)
          )
        );
        onResize(newWidth);
      };

      const onMouseUp = () => {
        startRef.current = null;
        document.removeEventListener("mousemove", onMouseMove, true);
        document.removeEventListener("mouseup", onMouseUp, true);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMouseMove, true);
      document.addEventListener("mouseup", onMouseUp, true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    };

    const onDoubleClick = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onAutoFit?.();
    };

    el.addEventListener("mousedown", startResize, true);
    el.addEventListener("dblclick", onDoubleClick, true);
    return () => {
      el.removeEventListener("mousedown", startResize, true);
      el.removeEventListener("dblclick", onDoubleClick, true);
    };
  }, [hasResize, width, onResize, onAutoFit]);

  const content = (
    <div className="resizable-table-header-content">
      {headerPrefix}
      <span className="resizable-table-header-title">{children}</span>
    </div>
  );

  if (hasResize) {
    return (
      <th
        {...restProps}
        ref={ref}
        className={`${className ?? ""} resizable-table-header`.trim()}
        style={{
          ...style,
          ...thStyle,
          position: "relative",
          width,
          minWidth: width,
          maxWidth: width,
          overflow: "visible",
          userSelect: "none",
          WebkitUserSelect: "none",
        }}
      >
        {content}
        <div
          ref={handleRef}
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调节列宽，双击自适应"
          title="拖动调节列宽，双击自适应"
          className="resizable-table-header-handle"
        />
      </th>
    );
  }

  return (
    <th
      {...restProps}
      ref={ref}
      className={className}
      style={{
        ...style,
        ...thStyle,
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      {content}
    </th>
  );
});
