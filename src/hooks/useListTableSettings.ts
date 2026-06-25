import { useCallback, useMemo } from "react";
import {
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useSettingsStore } from "../stores/settingsStore";
import {
  computeListTableScrollX,
  reorderListColumnKeys,
  resolveListColumnOrder,
  resolveListColumnWidth,
  type ListTableId,
} from "../utils/listTableColumns";

export interface UseListTableSettingsOptions {
  listId: ListTableId;
  defaultWidths: Record<string, number>;
  defaultOrder: readonly string[];
}

const EMPTY_COLUMN_WIDTHS: Record<string, number> = {};

export function useListTableSettings({
  listId,
  defaultWidths,
  defaultOrder,
}: UseListTableSettingsOptions) {
  const storedSettings = useSettingsStore(
    (s) => s.listTableSettings[listId]
  );
  const setListTableColumnWidth = useSettingsStore(
    (s) => s.setListTableColumnWidth
  );
  const setListTableColumnOrder = useSettingsStore(
    (s) => s.setListTableColumnOrder
  );

  const storedWidths = storedSettings?.columnWidths ?? EMPTY_COLUMN_WIDTHS;
  const columnOrder = useMemo(
    () =>
      resolveListColumnOrder(defaultOrder, storedSettings?.columnOrder),
    [defaultOrder, storedSettings?.columnOrder]
  );

  const getColumnWidth = useCallback(
    (columnKey: string) =>
      resolveListColumnWidth(columnKey, storedWidths, defaultWidths),
    [storedWidths, defaultWidths]
  );

  const handleColumnResize = useCallback(
    (columnKey: string) => (newWidth: number) => {
      setListTableColumnWidth(listId, columnKey, newWidth);
    },
    [listId, setListTableColumnWidth]
  );

  const scrollX = useMemo(
    () => computeListTableScrollX(columnOrder, getColumnWidth),
    [columnOrder, getColumnWidth]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    })
  );

  const handleColumnDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;
      const nextOrder = reorderListColumnKeys(
        columnOrder,
        String(active.id),
        String(over.id)
      );
      if (nextOrder) {
        setListTableColumnOrder(listId, nextOrder);
      }
    },
    [columnOrder, listId, setListTableColumnOrder]
  );

  return {
    columnOrder,
    getColumnWidth,
    handleColumnResize,
    scrollX,
    sortableColumnIds: columnOrder,
    dnd: {
      sensors,
      onDragEnd: handleColumnDragEnd,
    },
  };
}
