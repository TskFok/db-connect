import { arrayMove } from "@dnd-kit/sortable";
import type {
  AlterColumnPlacement,
  AlterColumnRequest,
  ColumnInfo,
} from "../types";

/** 将 FIRST / AFTER 换成用于确认对话框的简短说明文案 */
export function describeColumnReorderPlacement(
  placement: AlterColumnPlacement
): string {
  if (placement.kind === "first") return "移动到第一列";
  return `移动到列「${placement.column}」之后`;
}

/**
 * 根据拖动后的下标计算该列对应的 FIRST / AFTER 放置方式。
 */
export function computeReorderPlacementAfterMove(
  cols: ColumnInfo[],
  oldIndex: number,
  newIndex: number
): { column: ColumnInfo; placement: AlterColumnPlacement } | null {
  if (
    oldIndex === newIndex ||
    oldIndex < 0 ||
    newIndex < 0 ||
    oldIndex >= cols.length ||
    newIndex >= cols.length
  ) {
    return null;
  }
  const moved = cols[oldIndex];
  const reordered = arrayMove(cols, oldIndex, newIndex);
  const idx = reordered.findIndex((c) => c.name === moved.name);
  if (idx < 0) {
    return null;
  }
  if (idx === 0) {
    return { column: moved, placement: { kind: "first" } };
  }
  return {
    column: moved,
    placement: { kind: "after", column: reordered[idx - 1].name },
  };
}

/** 不改变列定义、仅物理重排时使用 */
export function columnInfoToReorderAlterRequest(
  col: ColumnInfo,
  placement: AlterColumnPlacement
): AlterColumnRequest {
  return {
    old_name: col.name,
    new_name: col.name,
    column_type: col.column_type,
    nullable: col.nullable,
    default_value: col.default_value,
    extra: col.extra ?? "",
    comment: col.comment ?? "",
    column_placement: placement,
  };
}
