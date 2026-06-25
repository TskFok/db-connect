import { memo, useEffect, useRef, useState } from "react";
import type { InputRef } from "antd";
import { Modal } from "antd";
import { SafeInput, SafeTextArea } from "../common/SafeInput";
import { isLongFieldValue, normalizeValue } from "./tableDataUtils";
import { TAB_NAVIGATE_EDIT } from "./tableDataEditEvents";

export interface EditableCellProps {
  value: unknown;
  pendingValue: unknown;
  hasPending: boolean;
  onEdit: (newValue: unknown) => void;
  /** 仅用于显示层覆盖文本，不影响编辑原始值 */
  displayText?: string;
  cellKey?: string;
  onTabNavigate?: (cellKey: string, direction: "next" | "prev") => void;
  /** 弹窗标题中展示的字段名 */
  fieldLabel?: string;
  /** 为 true 时禁止进入行内/弹窗编辑（如连接级只读） */
  readOnly?: boolean;
  /** varchar/text 等：避免纯数字被归一成 Number 后经 JSON 精度丢失 */
  forceStringSemantics?: boolean;
}

/** 可编辑单元格，编辑后由父组件集中管理待提交状态。 */
export function EditableCell({
  value,
  pendingValue,
  hasPending,
  onEdit,
  displayText,
  cellKey,
  onTabNavigate,
  fieldLabel,
  readOnly = false,
  forceStringSemantics = false,
}: EditableCellProps) {
  const [editing, setEditing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const inputRef = useRef<InputRef>(null);
  const tabMovingRef = useRef(false);
  const startEditRef = useRef<() => void>(() => {});
  const activeEditRef = useRef(false);
  const activeEditSessionRef = useRef<{
    value: unknown;
    forceStringSemantics: boolean;
    onEdit: (newValue: unknown) => void;
  } | null>(null);
  const latestInputValueRef = useRef("");
  const latestValueRef = useRef(value);
  const latestForceStringSemanticsRef = useRef(forceStringSemantics);

  const displayValue = hasPending ? pendingValue : value;
  const renderedText = displayText ?? String(displayValue);
  latestValueRef.current = value;
  latestForceStringSemanticsRef.current = forceStringSemantics;

  const commitInputValue = (text: string) => {
    const session = activeEditSessionRef.current;
    const newVal = normalizeValue(text, session?.value ?? latestValueRef.current, {
      forceString:
        session?.forceStringSemantics ?? latestForceStringSemanticsRef.current,
    });
    (session?.onEdit ?? onEdit)(newVal);
  };

  const startEdit = () => {
    if (readOnly) return;
    const text = displayValue === null ? "" : String(displayValue);
    activeEditRef.current = true;
    activeEditSessionRef.current = {
      value,
      forceStringSemantics,
      onEdit,
    };
    latestInputValueRef.current = text;
    setInputValue(text);
    if (isLongFieldValue(displayValue)) {
      setModalOpen(true);
    } else {
      setEditing(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  startEditRef.current = startEdit;

  useEffect(() => {
    if (!cellKey) return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail === cellKey) startEditRef.current();
    };
    document.addEventListener(TAB_NAVIGATE_EDIT, handler);
    return () => document.removeEventListener(TAB_NAVIGATE_EDIT, handler);
  }, [cellKey]);

  const finishEdit = () => {
    activeEditRef.current = false;
    setEditing(false);
    commitInputValue(latestInputValueRef.current);
    activeEditSessionRef.current = null;
  };

  const cancel = () => {
    activeEditRef.current = false;
    activeEditSessionRef.current = null;
    setEditing(false);
  };

  const handleBlur = () => {
    if (tabMovingRef.current) {
      tabMovingRef.current = false;
      return;
    }
    finishEdit();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      cancel();
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      tabMovingRef.current = true;
      finishEdit();
      if (cellKey && onTabNavigate) {
        onTabNavigate(cellKey, e.shiftKey ? "prev" : "next");
      }
    }
  };

  const finishModalEdit = () => {
    activeEditRef.current = false;
    setModalOpen(false);
    commitInputValue(latestInputValueRef.current);
    activeEditSessionRef.current = null;
  };

  const cancelModal = () => {
    activeEditRef.current = false;
    activeEditSessionRef.current = null;
    setModalOpen(false);
  };

  useEffect(() => {
    return () => {
      if (!activeEditRef.current) return;
      activeEditRef.current = false;
      commitInputValue(latestInputValueRef.current);
      activeEditSessionRef.current = null;
    };
    // commitInputValue intentionally reads refs so the unmount cleanup can stay stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cellWrap = (
    <div
      onDoubleClick={readOnly ? undefined : startEdit}
      data-cell-key={cellKey}
      style={{
        cursor: readOnly ? "default" : "text",
        minHeight: 22,
        padding: "0 4px",
        borderRadius: 2,
        backgroundColor: hasPending ? "rgba(250, 173, 20, 0.1)" : undefined,
      }}
      title={readOnly ? "当前为只读连接，无法编辑单元格" : "双击编辑"}
    >
      {displayValue === null ? (
        <span
          style={{
            fontSize: 12,
            color: hasPending ? "#faad14" : "var(--text-secondary)",
            fontStyle: "italic",
          }}
        >
          NULL
        </span>
      ) : (
        <span
          style={{
            fontSize: 12,
            color: hasPending ? "#faad14" : undefined,
            overflow: "hidden",
            textOverflow: "ellipsis",
            display: "block",
          }}
        >
          {renderedText}
        </span>
      )}
    </div>
  );

  if (editing) {
    return (
      <SafeInput
        ref={inputRef}
        size="small"
        value={inputValue}
        onChange={(e) => {
          latestInputValueRef.current = e.target.value;
          setInputValue(e.target.value);
        }}
        onPressEnter={finishEdit}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        style={{ width: "100%", minWidth: 60 }}
      />
    );
  }

  return (
    <>
      {cellWrap}
      {modalOpen ? (
        <Modal
          title={fieldLabel ? `编辑：${fieldLabel}` : "编辑内容"}
          open
          onOk={finishModalEdit}
          onCancel={cancelModal}
          width={720}
          destroyOnHidden
          okText="确定"
          cancelText="取消"
          focusTriggerAfterClose={false}
        >
          <SafeTextArea
            value={inputValue}
            onChange={(e) => {
              latestInputValueRef.current = e.target.value;
              setInputValue(e.target.value);
            }}
            autoSize={{ minRows: 10, maxRows: 28 }}
            style={{ fontFamily: "monospace", fontSize: 13 }}
            autoFocus
          />
        </Modal>
      ) : null}
    </>
  );
}

export const MemoEditableCell = memo(EditableCell, (prev, next) =>
  prev.value === next.value &&
  prev.pendingValue === next.pendingValue &&
  prev.hasPending === next.hasPending &&
  prev.displayText === next.displayText &&
  prev.cellKey === next.cellKey &&
  prev.onTabNavigate === next.onTabNavigate &&
  prev.fieldLabel === next.fieldLabel &&
  prev.readOnly === next.readOnly &&
  prev.forceStringSemantics === next.forceStringSemantics
);
