import {
  DndContext,
  closestCenter,
  type DragEndEvent,
  type SensorDescriptor,
  type SensorOptions,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Table, type TableProps } from "antd";
import { SortableResizableTableHeaderCell } from "./SortableResizableTableHeaderCell";

export interface SortableListTableProps<T extends object>
  extends TableProps<T> {
  sortableColumnIds: string[];
  sensors: SensorDescriptor<SensorOptions>[];
  onColumnDragEnd: (event: DragEndEvent) => void;
}

/**
 * 带可拖拽排序表头 + 可调节列宽的 antd Table 封装。
 */
export function SortableListTable<T extends object>({
  sortableColumnIds,
  sensors,
  onColumnDragEnd,
  tableLayout = "fixed",
  components,
  ...tableProps
}: SortableListTableProps<T>) {
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onColumnDragEnd}
    >
      <SortableContext
        items={sortableColumnIds}
        strategy={horizontalListSortingStrategy}
      >
        <Table<T>
          {...tableProps}
          tableLayout={tableLayout}
          components={{
            ...components,
            header: {
              ...components?.header,
              cell: SortableResizableTableHeaderCell,
            },
          }}
        />
      </SortableContext>
    </DndContext>
  );
}
