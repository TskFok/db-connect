import { memo, useEffect, useRef, useState } from "react";
import type { InputRef } from "antd";
import { Modal } from "antd";
import { SafeInput, SafeTextArea } from "../common/SafeInput";
import {
  getCellDisplayPreview,
  isLongFieldValue,
  normalizeValue,
} from "./tableDataUtils";
import { TAB_NAVIGATE_EDIT } from "./tableDataEditEvents";
import { TemporalInput } from "./TemporalInput";
import type { TemporalKind } from "../../utils/temporalValue";
import { isDeferredField } from "./deferredFields";

export interface EditableCellProps {
  value: unknown;
  pendingValue: unknown;
  hasPending: boolean;
  onEdit: (newValue: unknown, originalValue?: unknown) => void;
  /** 延迟字段双击后读取完整值；普通字段不会调用。 */
  loadFullValue?: () => Promise<unknown>;
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
  temporalKind?: TemporalKind | null;
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
  temporalKind = null,
  loadFullValue,
}: EditableCellProps) {
  const [editing, setEditing] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const [deferredLoadState, setDeferredLoadState] = useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle");
  const [deferredLoadError, setDeferredLoadError] = useState("");
  const inputRef = useRef<InputRef>(null);
  const tabMovingRef = useRef(false);
  const startEditRef = useRef<() => void>(() => {});
  const activeEditRef = useRef(false);
  const activeEditSessionRef = useRef<{
    value: unknown;
    forceStringSemantics: boolean;
    temporalKind: TemporalKind | null;
    onEdit: (newValue: unknown, originalValue?: unknown) => void;
    deferred: boolean;
  } | null>(null);
  const latestInputValueRef = useRef("");
  const latestValueRef = useRef(value);
  const latestForceStringSemanticsRef = useRef(forceStringSemantics);
  const latestPendingValueRef = useRef(pendingValue);
  const latestHasPendingRef = useRef(hasPending);
  const latestCellKeyRef = useRef(cellKey);
  const mountedRef = useRef(true);
  const deferredModalActiveRef = useRef(false);
  const deferredRequestGenerationRef = useRef(0);
  const deferredRequestRef = useRef<{
    value: unknown;
    cellKey: string | undefined;
    promise: Promise<unknown>;
  } | null>(null);
  const deferredCacheRef = useRef<{
    value: unknown;
    cellKey: string | undefined;
    fullValue: unknown;
  } | null>(null);
  const deferredEnabled = Boolean(loadFullValue);
  const previousIdentityRef = useRef({ value, cellKey, deferredEnabled });

  const displayValue = hasPending ? pendingValue : value;
  const deferredDisplayValue =
    loadFullValue && isDeferredField(displayValue) ? displayValue : null;
  const deferredValue = loadFullValue && isDeferredField(value) ? value : null;
  const deferredViewOnly = Boolean(
    deferredValue && (readOnly || deferredValue.kind === "binary")
  );
  const renderedText = deferredDisplayValue
    ? getCellDisplayPreview(displayText ?? deferredDisplayValue.preview)
    : getCellDisplayPreview(displayText ?? String(displayValue));
  latestValueRef.current = value;
  latestForceStringSemanticsRef.current = forceStringSemantics;
  latestPendingValueRef.current = pendingValue;
  latestHasPendingRef.current = hasPending;
  latestCellKeyRef.current = cellKey;

  const commitInputValue = (text: string) => {
    const session = activeEditSessionRef.current;
    const isTemporal = Boolean(session?.temporalKind ?? temporalKind);
    const originalValue = session ? session.value : latestValueRef.current;
    const newVal =
      isTemporal && text === String(originalValue ?? "")
        ? originalValue
        : isTemporal && text === ""
          ? null
          : normalizeValue(text, originalValue, {
              forceString:
                isTemporal ||
                (session?.forceStringSemantics ??
                  latestForceStringSemanticsRef.current),
            });
    const editHandler = session?.onEdit ?? onEdit;
    if (session?.deferred) {
      editHandler(newVal, originalValue);
    } else {
      editHandler(newVal);
    }
  };

  const openLoadedDeferredValue = (fullValue: unknown) => {
    const textValue = latestHasPendingRef.current
      ? latestPendingValueRef.current
      : fullValue;
    const text = textValue === null ? "" : String(textValue);
    activeEditRef.current = !deferredViewOnly;
    activeEditSessionRef.current = {
      value: fullValue,
      forceStringSemantics,
      temporalKind,
      onEdit,
      deferred: true,
    };
    latestInputValueRef.current = text;
    setInputValue(text);
    setDeferredLoadState("loaded");
  };

  const loadDeferredValue = () => {
    if (!deferredValue || !deferredModalActiveRef.current) return;
    const cached = deferredCacheRef.current;
    if (
      cached?.value === deferredValue &&
      cached.cellKey === latestCellKeyRef.current
    ) {
      openLoadedDeferredValue(cached.fullValue);
      return;
    }
    const pendingRequest = deferredRequestRef.current;
    if (
      pendingRequest?.value === deferredValue &&
      pendingRequest.cellKey === latestCellKeyRef.current
    ) {
      return;
    }

    setDeferredLoadError("");
    setDeferredLoadState("loading");
    activeEditRef.current = false;
    activeEditSessionRef.current = null;
    const generation = ++deferredRequestGenerationRef.current;
    const requestedValue = deferredValue;
    const requestedCellKey = latestCellKeyRef.current;
    let promise: Promise<unknown>;
    try {
      promise = loadFullValue
        ? loadFullValue()
        : Promise.reject(new Error("当前单元格无法加载完整值"));
    } catch (error) {
      promise = Promise.reject(error);
    }
    deferredRequestRef.current = {
      value: requestedValue,
      cellKey: requestedCellKey,
      promise,
    };
    void promise.then(
      (fullValue) => {
        if (
          !mountedRef.current ||
          !deferredModalActiveRef.current ||
          deferredRequestGenerationRef.current !== generation ||
          latestValueRef.current !== requestedValue ||
          latestCellKeyRef.current !== requestedCellKey
        ) {
          return;
        }
        deferredRequestRef.current = null;
        deferredCacheRef.current = {
          value: requestedValue,
          cellKey: requestedCellKey,
          fullValue,
        };
        openLoadedDeferredValue(fullValue);
      },
      (error: unknown) => {
        if (
          !mountedRef.current ||
          !deferredModalActiveRef.current ||
          deferredRequestGenerationRef.current !== generation ||
          latestValueRef.current !== requestedValue ||
          latestCellKeyRef.current !== requestedCellKey
        ) {
          return;
        }
        deferredRequestRef.current = null;
        setDeferredLoadError(
          error instanceof Error ? error.message : String(error)
        );
        setDeferredLoadState("error");
      }
    );
  };

  const startDeferredEdit = () => {
    if (!deferredValue) return;
    deferredModalActiveRef.current = true;
    setModalOpen(true);
    loadDeferredValue();
  };

  const startEdit = () => {
    if (deferredValue) {
      startDeferredEdit();
      return;
    }
    if (readOnly) return;
    const text = displayValue === null ? "" : String(displayValue);
    activeEditRef.current = true;
    activeEditSessionRef.current = {
      value,
      forceStringSemantics,
      temporalKind,
      onEdit,
      deferred: false,
    };
    latestInputValueRef.current = text;
    setInputValue(text);
    if (temporalKind || isLongFieldValue(displayValue)) {
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

  useEffect(() => {
    const previous = previousIdentityRef.current;
    previousIdentityRef.current = { value, cellKey, deferredEnabled };
    if (
      previous.value === value &&
      previous.cellKey === cellKey &&
      previous.deferredEnabled === deferredEnabled
    ) {
      return;
    }
    const previousWasDeferred =
      previous.deferredEnabled && isDeferredField(previous.value);
    if (!previousWasDeferred && !deferredValue) return;
    deferredRequestGenerationRef.current += 1;
    deferredRequestRef.current = null;
    deferredCacheRef.current = null;
    deferredModalActiveRef.current = false;
    activeEditRef.current = false;
    activeEditSessionRef.current = null;
    setDeferredLoadState("idle");
    setDeferredLoadError("");
    setModalOpen(false);
    setEditing(false);
  }, [cellKey, deferredEnabled, deferredValue, value]);

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
    if (deferredValue && (deferredLoadState !== "loaded" || deferredViewOnly)) {
      return;
    }
    activeEditRef.current = false;
    deferredModalActiveRef.current = false;
    setModalOpen(false);
    commitInputValue(latestInputValueRef.current);
    activeEditSessionRef.current = null;
  };

  const cancelModal = () => {
    activeEditRef.current = false;
    activeEditSessionRef.current = null;
    deferredModalActiveRef.current = false;
    deferredRequestGenerationRef.current += 1;
    deferredRequestRef.current = null;
    setModalOpen(false);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      deferredModalActiveRef.current = false;
      deferredRequestGenerationRef.current += 1;
      deferredRequestRef.current = null;
      if (!activeEditRef.current) return;
      activeEditRef.current = false;
      if (activeEditSessionRef.current?.deferred) {
        activeEditSessionRef.current = null;
        return;
      }
      commitInputValue(latestInputValueRef.current);
      activeEditSessionRef.current = null;
    };
    // commitInputValue intentionally reads refs so the unmount cleanup can stay stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cellWrap = (
    <div
      onDoubleClick={readOnly && !deferredValue ? undefined : startEdit}
      data-cell-key={cellKey}
      style={{
        cursor: readOnly && !deferredValue ? "default" : "text",
        minHeight: 22,
        padding: "0 4px",
        borderRadius: 2,
        backgroundColor: hasPending ? "rgba(250, 173, 20, 0.1)" : undefined,
      }}
      title={
        deferredValue
          ? deferredViewOnly
            ? "双击加载完整值并查看"
            : "双击加载完整值并编辑"
          : readOnly
            ? "当前为只读连接，无法编辑单元格"
            : "双击编辑"
      }
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
          {deferredDisplayValue ? (
            <small
              style={{
                marginLeft: 6,
                color: "var(--text-secondary)",
                fontStyle: "italic",
              }}
            >
              按需加载
            </small>
          ) : null}
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
          title={
            deferredViewOnly
              ? fieldLabel
                ? `查看：${fieldLabel}`
                : "查看内容"
              : fieldLabel
                ? `编辑：${fieldLabel}`
                : "编辑内容"
          }
          open
          onOk={finishModalEdit}
          onCancel={cancelModal}
          width={temporalKind ? 480 : 720}
          destroyOnHidden
          okText="确定"
          cancelText="取消"
          focusTriggerAfterClose={false}
          okButtonProps={{
            disabled: Boolean(
              deferredValue &&
              (deferredLoadState !== "loaded" || deferredViewOnly)
            ),
          }}
        >
          {deferredValue && deferredLoadState === "loading" ? (
            <div role="status">正在加载完整值…</div>
          ) : deferredValue && deferredLoadState === "error" ? (
            <div role="alert">
              <div>加载失败：{deferredLoadError}</div>
              <button type="button" onClick={loadDeferredValue}>
                重试
              </button>
            </div>
          ) : temporalKind && !deferredViewOnly ? (
            <TemporalInput
              kind={temporalKind}
              label={fieldLabel}
              value={inputValue}
              onChange={(text) => {
                latestInputValueRef.current = text;
                setInputValue(text);
              }}
              autoFocus
            />
          ) : (
            <SafeTextArea
              value={inputValue}
              onChange={(e) => {
                latestInputValueRef.current = e.target.value;
                setInputValue(e.target.value);
              }}
              autoSize={{ minRows: 10, maxRows: 28 }}
              style={{ fontFamily: "monospace", fontSize: 13 }}
              autoFocus
              readOnly={deferredViewOnly}
            />
          )}
        </Modal>
      ) : null}
    </>
  );
}

export const MemoEditableCell = memo(
  EditableCell,
  (prev, next) =>
    prev.value === next.value &&
    prev.pendingValue === next.pendingValue &&
    prev.hasPending === next.hasPending &&
    prev.onEdit === next.onEdit &&
    prev.loadFullValue === next.loadFullValue &&
    prev.displayText === next.displayText &&
    prev.cellKey === next.cellKey &&
    prev.onTabNavigate === next.onTabNavigate &&
    prev.fieldLabel === next.fieldLabel &&
    prev.readOnly === next.readOnly &&
    prev.forceStringSemantics === next.forceStringSemantics &&
    prev.temporalKind === next.temporalKind
);
