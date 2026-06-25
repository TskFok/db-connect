import { Checkbox, Empty, Spin, theme as antdTheme } from "antd";
import type { ColumnType } from "antd/es/table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";

/** 行选择列默认宽度（与原 antd 实现保持一致） */
const DEFAULT_ROW_SELECTION_WIDTH = 48;
const MIN_COL_WIDTH = 60;
const MAX_COL_WIDTH = 800;

/** 默认行高（保持 antd small size 视觉） */
const DEFAULT_ROW_HEIGHT = 32;
const HEADER_HEIGHT = 39;

export interface VirtualDataTableRowSelection {
  selectedRowKeys: string[];
  onChange: (keys: string[]) => void;
  columnWidth?: number;
}

export interface VirtualDataTableProps {
  /** 列定义；与现有 antd ColumnType 保持兼容（render/title/width/key/onHeaderCell） */
  columns: ColumnType<Record<string, unknown>>[];
  /** 行数据 */
  dataSource: Record<string, unknown>[];
  /** 取行 key，需与 rowSelection.selectedRowKeys 中的值一致 */
  rowKey: (record: Record<string, unknown>, index: number) => string;
  loading?: boolean;
  /** 表格主体（不含表头）的可用高度 */
  height: number;
  /** 行高，默认 32 */
  rowHeight?: number;
  /** 列默认宽度（当列未指定 width 时使用） */
  defaultColWidth?: number;
  /** 行选择配置；为 undefined 表示不展示行选择列（如只读连接） */
  rowSelection?: VirtualDataTableRowSelection;
  /** 行内容为空时的占位 */
  emptyText?: ReactNode;
  /** 外部渲染依赖变化时用于穿透 React.memo 的内部修订值 */
  renderRevision?: unknown;
  /** 自定义行 className（与当前实现的 row 样式覆盖） */
  rowClassName?: (record: Record<string, unknown>, index: number) => string;
  /** 用于附加额外属性，比如 data-testid */
  testId?: string;
}

interface ResolvedColumn {
  key: string;
  width: number;
  title: ReactNode;
  /** 列宽调节回调（来自 onHeaderCell({...,onResize}) 或显式 props） */
  onResize?: (newWidth: number) => void;
  /** 单元格渲染函数 */
  render: (record: Record<string, unknown>, rowIndex: number) => ReactNode;
  /** 是否启用文本省略（默认 true，避免内容撑开 cell 高度） */
  ellipsis: boolean;
  /** 是否为内部行选择列；不参与列宽调节也不可隐藏 */
  isSelection?: boolean;
}

/** 统一从 antd ColumnType 中解析出渲染所需信息 */
function resolveColumn(
  col: ColumnType<Record<string, unknown>>,
  defaultColWidth: number
): ResolvedColumn {
  const key = String(col.key ?? col.dataIndex ?? Math.random());
  const width = typeof col.width === "number" ? col.width : defaultColWidth;
  let onResize: ((newWidth: number) => void) | undefined;
  if (typeof col.onHeaderCell === "function") {
    try {
      const props = col.onHeaderCell({} as never) as
        | { onResize?: (w: number) => void }
        | undefined;
      onResize = props?.onResize;
    } catch {
      onResize = undefined;
    }
  }
  const dataIndex =
    typeof col.dataIndex === "string" || typeof col.dataIndex === "number"
      ? col.dataIndex
      : undefined;
  return {
    key,
    width,
    title: col.title as ReactNode,
    onResize,
    render: (record, rowIndex) => {
      if (typeof col.render === "function") {
        const value =
          dataIndex !== undefined ? record[dataIndex as string] : undefined;
        const out = col.render(value, record, rowIndex);
        // antd 的 render 返回值可能是 RenderedCell（带 children/props），这里仅取其 children 渲染
        if (out && typeof out === "object" && "children" in out) {
          return (out as { children?: ReactNode }).children ?? null;
        }
        return out as ReactNode;
      }
      if (dataIndex !== undefined) {
        return record[dataIndex as string] as ReactNode;
      }
      return null;
    },
    ellipsis: col.ellipsis !== false,
  };
}

/** 列宽调节手柄：原生 mousedown 监听以兼容 macOS Tauri */
function ColumnResizer({
  width,
  onResize,
}: {
  width: number;
  onResize: (newWidth: number) => void;
}) {
  const handleRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    const el = handleRef.current;
    if (!el) return;

    const onMouseDown = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (startRef.current) return;
      startRef.current = { x: e.clientX, w: width };

      const onMouseMove = (moveEvent: MouseEvent) => {
        if (!startRef.current) return;
        const delta = moveEvent.clientX - startRef.current.x;
        const newWidth = Math.round(
          Math.max(
            MIN_COL_WIDTH,
            Math.min(MAX_COL_WIDTH, startRef.current.w + delta)
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

    el.addEventListener("mousedown", onMouseDown, true);
    return () => el.removeEventListener("mousedown", onMouseDown, true);
  }, [width, onResize]);

  return (
    <div
      ref={handleRef}
      role="separator"
      aria-orientation="vertical"
      aria-label="拖动调节列宽"
      title="拖动调节列宽"
      className="virtual-data-table-resize-handle"
    />
  );
}

/**
 * 自研虚拟化表格：基于 @tanstack/react-virtual 同时虚拟化行与列。
 *
 * 设计要点：
 * - 单一横向滚动容器，header 与 body 共用，通过 sticky 让表头跟随纵向滚动。
 * - 行虚拟化：rowVirtualizer 监听容器纵向滚动。
 * - 列虚拟化：columnVirtualizer 监听容器横向滚动；header 与 body 共享同一个 virtualizer。
 * - 兼容当前 TableData 的 ColumnType 形态，使 antd 风格的列定义（含 render / onHeaderCell）可直接接入。
 */
function VirtualDataTableInner({
  columns,
  dataSource,
  rowKey,
  loading,
  height,
  rowHeight = DEFAULT_ROW_HEIGHT,
  defaultColWidth = 160,
  rowSelection,
  emptyText,
  rowClassName,
  testId,
}: VirtualDataTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { token } = antdTheme.useToken();

  // 解析列；行选择列作为虚拟列固定在最左，参与虚拟化但其宽度由 rowSelection 决定
  const resolvedColumns: ResolvedColumn[] = useMemo(() => {
    const userCols = columns.map((c) => resolveColumn(c, defaultColWidth));
    if (!rowSelection) return userCols;
    const selectionWidth =
      rowSelection.columnWidth ?? DEFAULT_ROW_SELECTION_WIDTH;
    return [
      {
        key: "__row_selection",
        width: selectionWidth,
        title: null,
        render: () => null,
        ellipsis: false,
        isSelection: true,
      },
      ...userCols,
    ];
  }, [columns, defaultColWidth, rowSelection]);

  const totalWidth = useMemo(
    () => resolvedColumns.reduce((s, c) => s + c.width, 0),
    [resolvedColumns]
  );

  // 行虚拟化
  const rowVirtualizer = useVirtualizer({
    count: dataSource.length,
    getScrollElement: () => containerRef.current,
    estimateSize: () => rowHeight,
    overscan: 6,
  });

  // 列虚拟化
  const columnVirtualizer = useVirtualizer({
    count: resolvedColumns.length,
    horizontal: true,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => resolvedColumns[index]?.width ?? defaultColWidth,
    overscan: 4,
  });

  // 列宽变化时重新测量列虚拟化的尺寸（否则旧 estimateSize 缓存依然生效）
  useLayoutEffect(() => {
    columnVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedColumns]);

  // 选中态：将 selectedRowKeys 转 Set 以便快速查询
  const selectedKeySet = useMemo(
    () => new Set(rowSelection?.selectedRowKeys ?? []),
    [rowSelection?.selectedRowKeys]
  );

  // 表头/表体共享的 cell 基础样式（仅 layout 关键属性，颜色 / border 颜色由 CSS 变量驱动）
  const baseCellStyle: CSSProperties = useMemo(
    () => ({
      position: "absolute",
      top: 0,
      height: "100%",
      boxSizing: "border-box",
      display: "flex",
      alignItems: "center",
      paddingInline: token.paddingXS,
      fontSize: token.fontSizeSM,
      color: token.colorText,
      borderRight: `1px solid var(--vdt-cell-split)`,
      borderBottom: `1px solid var(--vdt-cell-split)`,
      overflow: "hidden",
      whiteSpace: "nowrap",
      textOverflow: "ellipsis",
    }),
    [token.paddingXS, token.fontSizeSM, token.colorText]
  );

  const visibleColumns = columnVirtualizer.getVirtualItems();
  const visibleRows = rowVirtualizer.getVirtualItems();

  // 全选状态计算
  const allDataKeys = useMemo(
    () => dataSource.map((r, i) => rowKey(r, i)),
    [dataSource, rowKey]
  );
  const allSelected =
    rowSelection != null &&
    allDataKeys.length > 0 &&
    allDataKeys.every((k) => selectedKeySet.has(k));
  const indeterminate =
    rowSelection != null &&
    allDataKeys.some((k) => selectedKeySet.has(k)) &&
    !allSelected;

  const handleToggleAll = useCallback(
    (checked: boolean) => {
      if (!rowSelection) return;
      rowSelection.onChange(checked ? allDataKeys : []);
    },
    [rowSelection, allDataKeys]
  );

  const handleToggleRow = useCallback(
    (key: string) => {
      if (!rowSelection) return;
      const next = new Set(rowSelection.selectedRowKeys);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      rowSelection.onChange(Array.from(next));
    },
    [rowSelection]
  );

  const isEmpty = !loading && dataSource.length === 0;

  // 把 antd token 暴露成 CSS 变量，供 App.css 中的 hover/zebra/selected 规则取用，
  // 主题切换时（algorithm: dark <-> default）token 自动重算，CSS 变量也自动跟随。
  // 注意：表头不能直接用 colorFillAlter（半透明 fill token）作为 background，
  // 否则横向滚动时透过去能看到下层 cell。这里把"实色底 colorBgContainer"和
  // "fillAlter mask"作为两个独立变量，CSS 中再用 linear-gradient 复合成不透明背景。
  const themeVars = useMemo(
    () =>
      ({
        "--vdt-bg": token.colorBgContainer,
        "--vdt-header-fill": token.colorFillAlter,
        "--vdt-header-color": token.colorTextHeading,
        "--vdt-cell-split": token.colorBorderSecondary,
        "--vdt-row-hover": token.controlItemBgHover,
        "--vdt-row-selected": token.controlItemBgActive,
        "--vdt-row-selected-hover": token.controlItemBgActiveHover,
        "--vdt-row-zebra": token.colorFillQuaternary,
        "--vdt-resize-handle-hover": token.colorPrimaryBorder,
      }) as CSSProperties,
    [
      token.colorBgContainer,
      token.colorFillAlter,
      token.colorTextHeading,
      token.colorBorderSecondary,
      token.controlItemBgHover,
      token.controlItemBgActive,
      token.controlItemBgActiveHover,
      token.colorFillQuaternary,
      token.colorPrimaryBorder,
    ]
  );

  return (
    <Spin spinning={!!loading} wrapperClassName="virtual-data-table-spin">
      <div
        ref={containerRef}
        data-testid={testId}
        className="virtual-data-table-container"
        style={{
          ...themeVars,
          position: "relative",
          width: "100%",
          height,
          overflow: "auto",
          scrollbarGutter: "stable",
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusLG,
          background: "var(--vdt-bg)",
          color: token.colorText,
          fontSize: token.fontSizeSM,
        }}
      >
        {/* 内容包裹层：宽度=所有列总和，高度=表头 + 所有行 */}
        <div
          style={{
            position: "relative",
            width: totalWidth,
            height: HEADER_HEIGHT + rowVirtualizer.getTotalSize(),
          }}
        >
          {/* 表头：sticky top 让其跟随纵向滚动；背景由 .virtual-data-table-header CSS 类
              使用 "实色底 + fillAlter mask" 的复合 background 注入，确保不透明。 */}
          <div
            className="virtual-data-table-header"
            style={{
              position: "sticky",
              top: 0,
              left: 0,
              width: totalWidth,
              height: HEADER_HEIGHT,
              color: "var(--vdt-header-color)",
              zIndex: 3,
              borderBottom: `1px solid var(--vdt-cell-split)`,
            }}
          >
            {visibleColumns.map((vCol) => {
              const col = resolvedColumns[vCol.index];
              if (!col) return null;
              const headerInner =
                col.isSelection && rowSelection ? (
                  <Checkbox
                    checked={allSelected}
                    indeterminate={indeterminate}
                    onChange={(e) => handleToggleAll(e.target.checked)}
                    aria-label="全选当前页"
                  />
                ) : (
                  col.title
                );
              return (
                <div
                  key={vCol.key}
                  className="virtual-data-table-header-cell"
                  style={{
                    ...baseCellStyle,
                    left: vCol.start,
                    width: col.width,
                    minWidth: col.width,
                    maxWidth: col.width,
                    height: HEADER_HEIGHT,
                    fontWeight: token.fontWeightStrong ?? 600,
                    color: "var(--vdt-header-color)",
                  }}
                >
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      display: "flex",
                      alignItems: "center",
                    }}
                  >
                    {headerInner}
                  </div>
                  {col.onResize && !col.isSelection ? (
                    <ColumnResizer
                      width={col.width}
                      onResize={col.onResize}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>

          {/* 表体：所有可见行 × 可见列 */}
          {!isEmpty &&
            visibleRows.map((vRow) => {
              const record = dataSource[vRow.index];
              if (!record) return null;
              const key = rowKey(record, vRow.index);
              const selected = selectedKeySet.has(key);
              const isOdd = vRow.index % 2 === 1;
              const rowExtraClass = rowClassName?.(record, vRow.index) ?? "";
              const rowClass = [
                "virtual-data-table-row",
                isOdd ? "virtual-data-table-row--odd" : "virtual-data-table-row--even",
                selected ? "virtual-data-table-row--selected" : "",
                rowExtraClass,
              ]
                .filter(Boolean)
                .join(" ");
              return (
                <div
                  key={key}
                  data-row-key={key}
                  className={rowClass}
                  style={{
                    position: "absolute",
                    top: HEADER_HEIGHT + vRow.start,
                    left: 0,
                    width: totalWidth,
                    height: vRow.size,
                  }}
                >
                  {visibleColumns.map((vCol) => {
                    const col = resolvedColumns[vCol.index];
                    if (!col) return null;
                    return (
                      <div
                        key={vCol.key}
                        className="virtual-data-table-cell"
                        style={{
                          ...baseCellStyle,
                          left: vCol.start,
                          width: col.width,
                          minWidth: col.width,
                          maxWidth: col.width,
                          height: vRow.size,
                          whiteSpace: col.ellipsis ? "nowrap" : "normal",
                        }}
                      >
                        {col.isSelection && rowSelection ? (
                          <Checkbox
                            checked={selected}
                            onChange={() => handleToggleRow(key)}
                            aria-label={`选择行 ${key}`}
                          />
                        ) : (
                          <div
                            style={{
                              flex: 1,
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: col.ellipsis ? "nowrap" : "normal",
                            }}
                          >
                            {col.render(record, vRow.index)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}

          {/* 空数据占位 */}
          {isEmpty && (
            <div
              style={{
                position: "absolute",
                top: HEADER_HEIGHT,
                left: 0,
                width: "100%",
                height: Math.max(120, height - HEADER_HEIGHT - 8),
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {emptyText ?? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />
              )}
            </div>
          )}
        </div>
      </div>
    </Spin>
  );
}

export const VirtualDataTable = memo(VirtualDataTableInner);
