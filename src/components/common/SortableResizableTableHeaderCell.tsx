import { HolderOutlined } from "@ant-design/icons";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ResizableTableHeaderCell,
  type ResizableTableHeaderCellProps,
} from "./ResizableTableHeaderCell";

export type SortableResizableTableHeaderCellProps =
  ResizableTableHeaderCellProps & {
    columnKey?: string;
    sortable?: boolean;
  };

/**
 * 支持列顺序拖拽 + 列宽调节的 antd 表头单元格。
 * 列定义 onHeaderCell 需返回 { columnKey, sortable: true, width, onResize }。
 */
export function SortableResizableTableHeaderCell({
  columnKey,
  sortable,
  thStyle,
  headerPrefix,
  ...rest
}: SortableResizableTableHeaderCellProps) {
  const canSort = sortable === true && !!columnKey;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: columnKey ?? "__invalid__",
    disabled: !canSort,
  });

  const mergedStyle = {
    ...thStyle,
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 4 : thStyle?.zIndex,
    opacity: isDragging ? 0.85 : thStyle?.opacity,
  };

  const dragHandle = canSort ? (
    <span
      className="resizable-table-header-drag"
      {...attributes}
      {...listeners}
      title="拖动调整列顺序"
      aria-label="拖动调整列顺序"
      onClick={(e) => e.stopPropagation()}
    >
      <HolderOutlined style={{ fontSize: 11 }} />
    </span>
  ) : null;

  return (
    <ResizableTableHeaderCell
      {...rest}
      ref={canSort ? setNodeRef : undefined}
      thStyle={mergedStyle}
      headerPrefix={
        <>
          {dragHandle}
          {headerPrefix}
        </>
      }
    />
  );
}
