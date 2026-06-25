import type { Key } from "react";

/** 标准化输入值。超出 Number 安全范围的整数保留为字符串，避免 3258946454736595494 被转为 3258946454736595500 */
export function normalizeValue(
  inputValue: string,
  originalValue: unknown,
  options?: { forceString?: boolean }
): unknown {
  if (inputValue === "" && originalValue === null) return null;
  if (inputValue === "") return "";
  // 原值是字符串时保持字符串语义，避免 "0200..." 失焦后被转数字吞掉前导 0
  // varchar/text 等列即使从 JSON 以 number 形式展示，编辑后也必须保持字符串，避免大整数经 Number/JSON 变成 98860078801500000000
  if (typeof originalValue === "string" || options?.forceString) return inputValue;

  const trimmed = inputValue.trim();
  // 纯整数字符串：用 BigInt 判断是否超出安全范围，避免 Number 精度丢失
  if (/^-?\d+$/.test(trimmed)) {
    try {
      const big = BigInt(trimmed);
      if (big < Number.MIN_SAFE_INTEGER || big > Number.MAX_SAFE_INTEGER) {
        return trimmed;
      }
      return Number(big);
    } catch {
      return trimmed;
    }
  }
  const num = Number(trimmed);
  return isNaN(num) ? trimmed : num;
}

/** 超过此字符数（按展示值计）时用弹窗 TextArea 编辑，避免表格内极长文本撑乱布局 */
export const LONG_TEXT_MODAL_MIN_LEN = 120;

/** 是否应使用弹窗编辑（null 用行内空编辑） */
export function isLongFieldValue(displayValue: unknown): boolean {
  if (displayValue === null || displayValue === undefined) return false;
  return String(displayValue).length > LONG_TEXT_MODAL_MIN_LEN;
}

/** 格式化值用于显示 - 导出供单元测试使用 */
export function displayVal(v: unknown): string {
  if (v === null) return "NULL";
  if (v === "") return "(空字符串)";
  return String(v);
}

/** 将不可见字符转为可见符号，便于排查脏数据（仅用于显示层） */
export function visualizeInvisibleChars(input: string): string {
  return Array.from(input)
    .map((ch) => {
      switch (ch) {
        case " ":
          return "␠";
        case "\t":
          return "⇥";
        case "\n":
          return "↵";
        case "\r":
          return "␍";
        case "\u00A0":
          return "⍽";
        case "\u200B":
          return "⟪ZWSP⟫";
        case "\u200C":
          return "⟪ZWNJ⟫";
        case "\u200D":
          return "⟪ZWJ⟫";
        case "\uFEFF":
          return "⟪BOM⟫";
        default:
          return ch;
      }
    })
    .join("");
}

/** 根据隐藏列集合过滤可见列 */
export function filterVisibleColumns<T extends { key?: Key }>(
  allColumns: T[],
  hiddenColumns: Set<string>
): T[] {
  if (hiddenColumns.size === 0) return allColumns;
  return allColumns.filter((col) => !hiddenColumns.has(col.key as string));
}

/** 搜索匹配列名 */
export function searchColumns(columns: string[], searchText: string): string[] {
  if (!searchText) return columns;
  const lower = searchText.toLowerCase();
  return columns.filter((col) => col.toLowerCase().includes(lower));
}

/** 用户拖拽 resize bar 设定的表格高度持久化 key（全局共享，无关具体连接/表）。*/
export const TABLE_HEIGHT_STORAGE_KEY = "mysqlc:table-height-px";
export const TABLE_HEIGHT_MIN = 200;
export const TABLE_HEIGHT_MAX = 4000;
export const TABLE_RESIZE_BAR_HEIGHT = 6;

/** 从 localStorage 读取用户设定的表格高度；非数值或越界返回 null。 */
export function loadStoredUserTableHeight(): number | null {
  try {
    const raw = localStorage.getItem(TABLE_HEIGHT_STORAGE_KEY);
    if (raw == null) return null;
    const v = Number.parseInt(raw, 10);
    if (!Number.isFinite(v)) return null;
    if (v < TABLE_HEIGHT_MIN || v > TABLE_HEIGHT_MAX) return null;
    return v;
  } catch {
    return null;
  }
}

/** 持久化用户设定的表格高度；传 null 表示重置为自动撑满模式。 */
export function saveUserTableHeight(value: number | null): void {
  try {
    if (value == null) {
      localStorage.removeItem(TABLE_HEIGHT_STORAGE_KEY);
    } else {
      localStorage.setItem(TABLE_HEIGHT_STORAGE_KEY, String(Math.round(value)));
    }
  } catch {
    /* 忽略 localStorage 写失败（隐私模式等场景）*/
  }
}

/** 把用户拖拽的高度 clamp 到 [TABLE_HEIGHT_MIN, TABLE_HEIGHT_MAX]。 */
export function clampUserTableHeight(value: number): number {
  return Math.max(TABLE_HEIGHT_MIN, Math.min(TABLE_HEIGHT_MAX, Math.round(value)));
}

/**
 * 小于此值的 slot 高度视为未布局完成或仍处于 display:none（如 Tabs 非激活面板），不可写入 state。
 * 若用 Math.max 把 0 抬到「最小 slot」会覆盖此前正确高度，导致切回数据 Tab 后表格被压到最矮。
 */
export const TABLE_SLOT_MEASURE_TRUST_MIN = 8;

export function isTrustedTableSlotMeasure(raw: number): boolean {
  return Number.isFinite(raw) && raw >= TABLE_SLOT_MEASURE_TRUST_MIN;
}

/**
 * ResizeObserver 传入的 contentRect 在亚像素边界上可能来回抖动；忽略微差可避免 setState → 重排 → 再观测的死循环。
 */
export function stabilizeTableSlotHeight(
  prev: number,
  next: number,
  epsilon = 0.5
): number {
  if (prev > 0 && Math.abs(prev - next) < epsilon) return prev;
  return next;
}

/**
 * 由 slot 像素高度推导用户可拖拽表格的最大高度；slot 未布局完成（过小）时返回 null，调用方不得写入 ref/state。
 */
export function tableSlotMaxUserHeightOrNull(tableSlotHeight: number): number | null {
  if (!isTrustedTableSlotMeasure(tableSlotHeight)) return null;
  return Math.max(
    TABLE_HEIGHT_MIN,
    Math.min(TABLE_HEIGHT_MAX, tableSlotHeight - TABLE_RESIZE_BAR_HEIGHT)
  );
}

/**
 * 跨 TableData 卸载/挂载保留最近一次可信 slot 高度（如顶栏从 SQL 标签切回表标签时会整树卸载），
 * 用于首帧高度回退，避免 max ref 被 0 污染或自动模式长期卡在默认 400px。
 */
let lastTrustedTableSlotHeightModule = 0;

export function getLastTrustedTableSlotHeight(): number {
  return lastTrustedTableSlotHeightModule;
}

export function setLastTrustedTableSlotHeight(value: number): void {
  lastTrustedTableSlotHeightModule = value;
}

/** 单测之间清理模块级 slot 缓存，避免相互污染 */
export function resetTableSlotHeightModuleCacheForTests(): void {
  lastTrustedTableSlotHeightModule = 0;
}
