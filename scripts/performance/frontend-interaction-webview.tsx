import {
  Profiler,
  useLayoutEffect,
  useMemo,
  useRef,
  useEffect,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { ConfigProvider } from "antd";
import { VirtualDataTable } from "../../src/components/table/VirtualDataTable";
import { VirtualDataTable as BaselineTable } from "./frontend-interaction-baseline.generated";
import { createTableRowSource } from "../../src/components/table/tableRowSource";
import { DatabaseCompareResults } from "../../src/components/databaseCompare/DatabaseCompareResults";
import { DatabaseSyncPreviewModal } from "../../src/components/databaseCompare/DatabaseSyncPreviewModal";
import { useSidebarResize } from "../../src/hooks/useSidebarResize";
import { useSettingsStore } from "../../src/stores/settingsStore";
import type {
  DatabaseCompareResult,
  DatabaseSyncPreview,
  DatabaseSyncExecutionResult,
} from "../../src/types";
import "../../src/App.css";

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: { benchmark?: { postMessage(value: unknown): void } };
    };
  }
}
const post = (payload: unknown) =>
  window.webkit?.messageHandlers?.benchmark?.postMessage(payload);
const progress = (phase: string) => post({ type: "progress", phase });
const root = createRoot(document.getElementById("root")!);
const params = new URLSearchParams(location.search);
const smoke = params.get("smoke") === "1";
const repetitions = smoke ? 3 : 30;
const frame = () =>
  new Promise<number>((resolve) => requestAnimationFrame(resolve));
const settle = async () => {
  await frame();
  await frame();
};
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[
    Math.max(0, Math.ceil(values.length * 0.95) - 1)
  ] ?? 0;
const stats = (values: number[]) => ({
  samples: values.length,
  p95: p95(values),
  median: [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0,
  min: Math.min(...values),
  max: Math.max(...values),
  raw: values,
});
let commits: number[] = [];
const onRender = (_id: string, _phase: string, actualDuration: number) => {
  commits.push(actualDuration);
};
function render(node: ReactNode) {
  flushSync(() =>
    root.render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <Profiler id="measured" onRender={onRender}>
          {node}
        </Profiler>
      </ConfigProvider>
    )
  );
}
async function measure(action: () => void) {
  commits = [];
  const start = performance.now();
  action();
  await settle();
  return {
    interactionToTwoFramesMs: performance.now() - start,
    profilerActualDurationMs: commits.reduce((a, b) => a + b, 0),
    profilerCommits: commits.length,
  };
}

interface Fixture {
  rows: unknown[][];
  columns: string[];
  reads: number;
  keyReads: number;
}
function fixture(rowCount: number, columnCount: number, page: number): Fixture {
  const target: Fixture = {
    rows: [],
    columns: Array.from({ length: columnCount }, (_, c) => `c${c}`),
    reads: 0,
    keyReads: 0,
  };
  target.rows = Array.from(
    { length: rowCount },
    (_, r) =>
      new Proxy(
        Array.from(
          { length: columnCount },
          (_, c) => page * 10000000 + r * columnCount + c
        ),
        {
          get(values, key, receiver) {
            if (typeof key === "string" && /^\d+$/.test(key)) {
              if (key === "0") target.keyReads++;
              else target.reads++;
            }
            return Reflect.get(values, key, receiver);
          },
        }
      )
  );
  return target;
}
let preparationMs = 0;
let businessProperties = 0;
const noSelection = { selectedRowKeys: [], onChange: () => {} };
function TableCase({
  input,
  mode,
}: {
  input: Fixture;
  mode: "baseline" | "current";
}) {
  const prepared = useMemo(() => {
    const start = performance.now();
    if (mode === "current") {
      const source = createTableRowSource({
        rows: input.rows,
        columns: input.columns,
        primaryKeyColumns: ["c0"],
        scopeKey: "isolated",
        page: 1,
      });
      preparationMs += performance.now() - start;
      return { source };
    }
    const records = input.rows.map((row, index) => {
      const record: Record<string, unknown> = {};
      for (let c = 0; c < input.columns.length; c++)
        record[input.columns[c]] = row[c];
      record._rowKey = index;
      record._selectionKey = `isolated:${row[0]}`;
      return record;
    });
    businessProperties += input.rows.length * input.columns.length;
    preparationMs += performance.now() - start;
    return { records };
  }, [input, mode]);
  const columns = useMemo(
    () =>
      input.columns.map((column) => ({
        key: column,
        dataIndex: column,
        title: column,
        width: 160,
        renderCell: (index: number) =>
          String(prepared.source?.getCell(index, column)),
      })),
    [input, prepared]
  );
  return prepared.source ? (
    <VirtualDataTable
      columns={columns}
      rowSource={prepared.source}
      height={720}
      rowSelection={noSelection}
      testId="measured-table"
    />
  ) : (
    <BaselineTable
      columns={columns}
      dataSource={prepared.records!}
      rowKey={(record) => String(record._selectionKey)}
      height={720}
      rowSelection={noSelection}
      testId="measured-table"
    />
  );
}
function resetCounters(inputs: Fixture[]) {
  inputs.forEach((input) => {
    input.reads = 0;
    input.keyReads = 0;
  });
  preparationMs = 0;
  businessProperties = 0;
}
function counters(inputs: Fixture[]) {
  return {
    nonPrimaryKeyReads: inputs.reduce((sum, input) => sum + input.reads, 0),
    primaryKeyReads: inputs.reduce((sum, input) => sum + input.keyReads, 0),
    rowPreparationMs: preparationMs,
    businessPropertiesMaterialized: businessProperties,
  };
}
async function tableMatrix() {
  const result: unknown[] = [];
  for (const rowCount of smoke ? [100] : [100, 1000, 10000]) {
    for (const columnCount of smoke ? [20] : [20, 200]) {
      const inputs = [
        fixture(rowCount, columnCount, 0),
        fixture(rowCount, columnCount, 1),
      ];
      for (const mode of ["baseline", "current"] as const) {
        render(null);
        await settle();
        resetCounters(inputs);
        const initial = await measure(() =>
          render(<TableCase input={inputs[0]} mode={mode} />)
        );
        const initialReads = counters(inputs);
        assert(
          document.querySelectorAll(".virtual-data-table-row").length > 0,
          "Real virtual table did not render any rows"
        );
        const mountedAtInitial = {
          rows: document.querySelectorAll(".virtual-data-table-row").length,
          cells: document.querySelectorAll(".virtual-data-table-cell").length,
          headerCells: document.querySelectorAll(
            ".virtual-data-table-header-cell"
          ).length,
        };
        const operations: Record<string, unknown> = {};
        for (const operation of [
          "changePage",
          "switchBack",
          "scroll",
        ] as const) {
          const samples: Awaited<ReturnType<typeof measure>>[] = [];
          const reads: number[] = [];
          const prep: number[] = [];
          const properties: number[] = [];
          for (let i = 0; i < repetitions; i++) {
            const target = operation === "switchBack" ? 0 : (i + 1) % 2;
            if (operation === "switchBack") {
              render(<TableCase input={inputs[1]} mode={mode} />);
              await settle();
            }
            resetCounters(inputs);
            samples.push(
              await measure(() => {
                if (operation === "scroll") {
                  const table = document.querySelector<HTMLElement>(
                    '[data-testid="measured-table"]'
                  )!;
                  table.scrollTop = i % 2 ? 0 : Math.min(32000, rowCount * 16);
                  table.scrollLeft = i % 2 ? 0 : columnCount * 80;
                  table.dispatchEvent(new Event("scroll", { bubbles: true }));
                } else render(<TableCase input={inputs[target]} mode={mode} />);
              })
            );
            const counted = counters(inputs);
            reads.push(counted.nonPrimaryKeyReads);
            prep.push(counted.rowPreparationMs);
            properties.push(counted.businessPropertiesMaterialized);
          }
          operations[operation] = {
            interactionToTwoFramesMs: stats(
              samples.map((s) => s.interactionToTwoFramesMs)
            ),
            profilerActualDurationMs: stats(
              samples.map((s) => s.profilerActualDurationMs)
            ),
            profilerCommits: samples.map((s) => s.profilerCommits),
            nonPrimaryKeyReads: stats(reads),
            rowPreparationMs: stats(prep),
            businessPropertiesMaterialized: stats(properties),
          };
        }
        result.push({
          mode,
          rowCount,
          columnCount,
          initial: { ...initial, ...initialReads, mountedAtInitial },
          operations,
        });
        progress(`table ${mode} ${rowCount}x${columnCount}`);
      }
    }
  }
  return result;
}
const endpoint = (name: string) => ({
  connection_id: `synthetic-${name}`,
  connection_name: name,
  database: "synthetic",
});
function comparison(): DatabaseCompareResult {
  const column = {
    name: "value",
    status: "changed" as const,
    changed_fields: ["column_type" as const],
    source: {
      ordinal_position: 1,
      column_type: "int",
      nullable: false,
      default_value: null,
      primary_key: false,
      extra: "",
      comment: "",
    },
    target: {
      ordinal_position: 1,
      column_type: "bigint",
      nullable: false,
      default_value: null,
      primary_key: false,
      extra: "",
      comment: "",
    },
  };
  return {
    database_type: "mysql",
    source: endpoint("source"),
    target: endpoint("target"),
    compared_at: "synthetic",
    summary: {
      source_only_tables: 0,
      target_only_tables: 0,
      changed_tables: 10000,
      different_columns: 10199,
    },
    tables: Array.from({ length: 10000 }, (_, i) => ({
      name: `table_${String(i).padStart(5, "0")}`,
      status: "changed",
      columns:
        i === 0
          ? Array.from({ length: 200 }, (_, c) => ({
              ...column,
              name: `field_${c}`,
            }))
          : [column],
    })),
  };
}
function preview(): DatabaseSyncPreview {
  return {
    plan_fingerprint: "synthetic-fingerprint-not-executable",
    can_execute: false,
    summary: {
      selected_tables: 1000,
      executable_operations: 1000,
      high_risk_operations: 0,
      destructive_operations: 0,
      blockers: 1000,
      skipped_items: 1000,
    },
    operations: Array.from({ length: 1000 }, (_, i) => ({
      id: `operation_${i}`,
      table_name: `table_${i}`,
      kind: "add_column",
      risk: "normal",
      summary: `合成操作 ${i}`,
      sql: [
        `-- SYNTHETIC DISPLAY ONLY\nALTER TABLE table_${i}\n  ADD COLUMN value INT;`,
        `-- SYNTHETIC DISPLAY ONLY\nALTER TABLE table_${i}\n  ADD COLUMN next_value INT;`,
      ],
    })),
    blockers: Array.from({ length: 1000 }, (_, i) => ({
      table_name: `blocked_${i}`,
      summary: "合成阻塞项",
      reason: "不允许执行",
    })),
    skipped_items: Array.from({ length: 1000 }, (_, i) => ({
      table_name: `skipped_${i}`,
      summary: "合成跳过项",
      reason: "仅测展示",
    })),
  };
}
function nextButton(label: string, direction = "next") {
  const nav = document.querySelector<HTMLElement>(`nav[aria-label="${label}"]`);
  assert(nav, `Missing pagination ${label}`);
  const item = nav!.querySelector<HTMLElement>(`.ant-pagination-${direction}`);
  const button = item?.querySelector<HTMLElement>("button") ?? item;
  assert(
    button && !button.hasAttribute("disabled"),
    `Missing enabled ${direction} ${label}`
  );
  return button!;
}
async function paginations(
  labels: string[],
  countMounted: () => Record<string, number>,
  limits: Record<string, number>
) {
  const output: Record<string, unknown> = {};
  for (const label of labels) {
    const samples: Awaited<ReturnType<typeof measure>>[] = [];
    const maxima: Record<string, number> = {};
    for (let i = 0; i < repetitions; i++) {
      samples.push(
        await measure(() => nextButton(label, i % 2 ? "prev" : "next").click())
      );
      const mounted = countMounted();
      for (const [key, value] of Object.entries(mounted)) {
        maxima[key] = Math.max(maxima[key] ?? 0, value);
        assert(value <= limits[key], `${key}: ${value} exceeds ${limits[key]}`);
      }
    }
    output[label] = {
      interactionToTwoFramesMs: stats(
        samples.map((s) => s.interactionToTwoFramesMs)
      ),
      profilerActualDurationMs: stats(
        samples.map((s) => s.profilerActualDurationMs)
      ),
      profilerCommits: samples.map((s) => s.profilerCommits),
      maxMounted: maxima,
    };
  }
  return output;
}
async function compareAndSync() {
  const result = comparison();
  render(null);
  await settle();
  const initialCompare = await measure(() =>
    render(
      <DatabaseCompareResults
        result={result}
        disabled={false}
        selectedTableNames={[]}
        includeDrops={false}
        onSelectionChange={() => {}}
        onIncludeDropsChange={() => {}}
      />
    )
  );
  const compareMounted = () => ({
    outerRows:
      document.querySelectorAll(
        ".database-compare-table-wrap > .ant-table-wrapper .ant-table-tbody > .ant-table-row"
      ).length -
      document.querySelectorAll(
        ".database-compare-expanded-table .ant-table-row"
      ).length,
    expandedRows: document.querySelectorAll(
      ".database-compare-expanded-table .ant-table-row"
    ).length,
  });
  const initialCompareMounted = compareMounted();
  assert(
    initialCompareMounted.outerRows === 50,
    "Compare initial row count must equal 50"
  );
  const comparisonPages = await paginations(["差异表分页"], compareMounted, {
    outerRows: 50,
    expandedRows: 50,
  });
  if (repetitions % 2) {
    nextButton("差异表分页", "prev").click();
    await settle();
  }
  const expand = document.querySelector<HTMLElement>(
    ".ant-table-row-expand-icon"
  );
  assert(expand, "Missing compare expansion");
  const expansion = await measure(() => expand!.click());
  const expandedCount = compareMounted();
  assert(expandedCount.expandedRows === 50, "Expanded row count must equal 50");
  const expandedPages = await paginations(
    [`${result.tables[0].name} 字段分页`],
    compareMounted,
    { outerRows: 50, expandedRows: 50 }
  );
  progress("compare 10000 tables / expanded 200 columns");
  const plan = preview();
  const modal = (executionResult: DatabaseSyncExecutionResult | null) => (
    <DatabaseSyncPreviewModal
      open
      source={endpoint("source")}
      target={endpoint("target")}
      preview={plan}
      executionResult={executionResult}
      executing={false}
      progress={null}
      executionLocked={false}
      onBack={() => {}}
      onConfirm={() => {
        throw new Error("Synthetic harness must never execute SQL");
      }}
      onRecompare={() => {}}
    />
  );
  render(null);
  await settle();
  const initialSync = await measure(() => render(modal(null)));
  await settle();
  const previewMounted = () => ({
    operations: document.querySelectorAll(".database-sync-operation").length,
    blockers: document.querySelectorAll(
      'section[aria-label="阻塞项目"] .ant-list-item'
    ).length,
    skipped: document.querySelectorAll(
      'section[aria-label="已跳过项目"] .ant-list-item'
    ).length,
  });
  const initialPreviewMounted = previewMounted();
  assert(
    initialPreviewMounted.operations === 20,
    "Sync initial operation count must equal 20"
  );
  const syncPages = await paginations(
    ["同步操作分页", "阻塞项目分页", "已跳过项目分页"],
    previewMounted,
    { operations: 20, blockers: 20, skipped: 20 }
  );
  progress("sync preview 1000 operations / blockers / skipped");
  const execution: DatabaseSyncExecutionResult = {
    status: "partially_succeeded",
    completed_statements: Array.from({ length: 1000 }, (_, i) => ({
      operation_id: `operation_${i}`,
      statement_index: 0,
    })),
    failed: {
      operation_id: "operation_0",
      statement_index: 1,
      error: "合成错误，仅测展示",
    },
    pending_operation_ids: plan.operations.map((o) => o.id),
    cleanup_errors: [],
    latest_compare_result: null,
  };
  render(null);
  await settle();
  const initialResult = await measure(() => render(modal(execution)));
  await settle();
  const resultMounted = () => ({
    completed: document.querySelectorAll(
      'section[aria-label="已成功执行的语句"] .ant-list-item'
    ).length,
    pending: document.querySelectorAll(
      'section[aria-label="未执行操作"] .ant-list-item'
    ).length,
  });
  const initialResultMounted = resultMounted();
  const resultPages = await paginations(
    ["已成功执行的语句分页", "未执行操作分页"],
    resultMounted,
    { completed: 20, pending: 20 }
  );
  progress(
    "sync execution result synthetic 1000 statements / pending operations"
  );
  return {
    comparison: {
      tables: 10000,
      initial: initialCompare,
      mountedAtInitial: initialCompareMounted,
      pages: comparisonPages,
      expansion,
      expandedMounted: expandedCount,
      expandedPages,
    },
    syncPreview: {
      operations: 1000,
      blockers: 1000,
      skipped: 1000,
      initial: initialSync,
      mountedAtInitial: initialPreviewMounted,
      pages: syncPages,
    },
    executionResult: {
      completedStatements: 1000,
      pendingOperations: 999,
      initial: initialResult,
      mountedAtInitial: initialResultMounted,
      pages: resultPages,
    },
  };
}
let shellCommits = 0;
let editorInstance:
  | import("monaco-editor").editor.IStandaloneCodeEditor
  | undefined;
let monacoReady = false;
function MonacoCase() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const monaco = await import("monaco-editor/esm/vs/editor/editor.api.js");
      const worker =
        await import("monaco-editor/esm/vs/editor/editor.worker?worker");
      await import("monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js");
      self.MonacoEnvironment = { getWorker: () => new worker.default() };
      if (!alive) return;
      editorInstance = monaco.editor.create(container.current!, {
        value: Array.from(
          { length: 10000 },
          (_, i) => `-- synthetic editor line ${i}\nSELECT ${i};`
        ).join("\n"),
        language: "sql",
        automaticLayout: true,
        minimap: { enabled: false },
        occurrencesHighlight: "off",
      });
      monacoReady = true;
    })();
    return () => {
      alive = false;
      editorInstance?.dispose();
      editorInstance = undefined;
      monacoReady = false;
    };
  }, []);
  return <div ref={container} style={{ height: 720, width: "100%" }} />;
}
function DragShell({
  mode,
  input,
}: {
  mode: "table" | "monaco";
  input: Fixture;
}) {
  const width = useSettingsStore((s) => s.sidebarWidth);
  const setWidth = useSettingsStore((s) => s.setSidebarWidth);
  const { siderRef, onMouseDown } = useSidebarResize({
    width,
    minWidth: 200,
    maxWidth: 480,
    onCommit: setWidth,
  });
  useLayoutEffect(() => {
    shellCommits++;
  });
  return (
    <div style={{ display: "flex", height: "100%", width: "100%" }}>
      <div
        ref={siderRef}
        data-testid="sider"
        style={{ width, flexBasis: width, flexShrink: 0, background: "#eee" }}
      >
        合成侧栏
      </div>
      <div
        data-testid="drag-handle"
        role="separator"
        onMouseDown={onMouseDown}
        style={{
          width: 6,
          flexShrink: 0,
          cursor: "col-resize",
          background: "#999",
        }}
      />
      <div data-testid="main-content" style={{ flex: 1, minWidth: 0 }}>
        {mode === "table" ? (
          <TableCase input={input} mode="current" />
        ) : (
          <MonacoCase />
        )}
      </div>
    </div>
  );
}
let storageWrites = 0;
const originalSetItem = Storage.prototype.setItem;
Storage.prototype.setItem = function (key: string, value: string) {
  if (key === "db-connect-settings") storageWrites++;
  return originalSetItem.call(this, key, value);
};
async function nativeResize(width: number, height: number) {
  const done = new Promise<void>((resolve) =>
    window.addEventListener("benchmark-native-resized", () => resolve(), {
      once: true,
    })
  );
  post({ type: "resize", width, height });
  await Promise.race([
    done,
    sleep(3000).then(() => {
      throw new Error("Native resize acknowledgement timed out");
    }),
  ]);
  await settle();
  return {
    viewport: { width: innerWidth, height: innerHeight },
    mainContentWidth: document
      .querySelector('[data-testid="main-content"]')!
      .getBoundingClientRect().width,
    tableWidth:
      document
        .querySelector('[data-testid="measured-table"]')
        ?.getBoundingClientRect().width ?? null,
    monacoWidth: editorInstance?.getLayoutInfo().width ?? null,
  };
}
async function dragCases() {
  const result = [];
  const input = fixture(10000, 200, 0);
  for (const mode of ["table", "monaco"] as const) {
    render(null);
    await settle();
    useSettingsStore.getState().setSidebarWidth(280);
    render(<DragShell mode={mode} input={input} />);
    await settle();
    if (mode === "monaco") {
      const start = performance.now();
      while (!monacoReady) {
        assert(performance.now() - start < 30000, "Monaco did not initialize");
        await sleep(50);
      }
    }
    await sleep(250);
    await settle();
    const handle = document.querySelector<HTMLElement>(
      '[data-testid="drag-handle"]'
    )!;
    storageWrites = 0;
    shellCommits = 0;
    commits = [];
    const start = performance.now();
    const intervals: number[] = [];
    let last = start;
    let moveEvents = 0;
    handle.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 280 })
    );
    while (performance.now() - start < 2000) {
      const now = await frame();
      intervals.push(now - last);
      last = now;
      const next = 200 + 140 * (1 + Math.sin((now - start) / 180));
      for (let event = 0; event < 4; event++) {
        window.dispatchEvent(
          new MouseEvent("mousemove", { bubbles: true, clientX: next })
        );
        moveEvents++;
      }
    }
    window.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 360 })
    );
    moveEvents++;
    const beforeMouseUp = {
      persistWrites: storageWrites,
      shellReactCommits: shellCommits,
      subtreeProfilerCommits: commits.length,
    };
    window.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, button: 0, clientX: 360 })
    );
    await settle();
    const completed = {
      persistWrites: storageWrites,
      shellReactCommits: shellCommits,
      subtreeProfilerCommits: commits.length,
      profilerActualDurationMs: commits.reduce((a, b) => a + b, 0),
      finalSidebarWidth: useSettingsStore.getState().sidebarWidth,
    };
    assert(
      beforeMouseUp.persistWrites === 0 &&
        beforeMouseUp.shellReactCommits === 0,
      `${mode}: drag preview persisted or committed shell`
    );
    assert(
      completed.persistWrites === 1 && completed.finalSidebarWidth === 360,
      `${mode}: completed drag did not persist once`
    );
    const resizeDown = await nativeResize(1000, 700);
    const resizeRestored = await nativeResize(1200, 800);
    assert(
      resizeDown.viewport.width === 1000 &&
        resizeRestored.viewport.width === 1200,
      "Native window resize did not change viewport"
    );
    if (mode === "table")
      assert(
        resizeDown.tableWidth === resizeDown.mainContentWidth &&
          resizeRestored.tableWidth === resizeRestored.mainContentWidth,
        "Table resize layout mismatch"
      );
    else
      assert(
        Math.abs(resizeDown.monacoWidth! - resizeDown.mainContentWidth) <= 1 &&
          Math.abs(
            resizeRestored.monacoWidth! - resizeRestored.mainContentWidth
          ) <= 1,
        "Monaco automaticLayout mismatch"
      );
    // Also verify cancellation and an unchanged width against real persist storage.
    storageWrites = 0;
    shellCommits = 0;
    handle.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 360 })
    );
    window.dispatchEvent(new MouseEvent("mousemove", { clientX: 440 }));
    await settle();
    window.dispatchEvent(new Event("blur"));
    await settle();
    const cancelled = {
      persistWrites: storageWrites,
      shellReactCommits: shellCommits,
      domWidth: document
        .querySelector('[data-testid="sider"]')!
        .getBoundingClientRect().width,
    };
    assert(
      cancelled.persistWrites === 0 && cancelled.domWidth === 360,
      "Cancelled drag wrote storage or failed restoration"
    );
    handle.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0, clientX: 360 })
    );
    window.dispatchEvent(
      new MouseEvent("mouseup", { button: 0, clientX: 360 })
    );
    await settle();
    assert(storageWrites === 0, "Unchanged width persisted");
    result.push({
      mode,
      durationMs: last - start,
      moveEvents,
      beforeMouseUp,
      completed,
      frameIntervalMs: stats(intervals),
      frameGapsOver50ms: intervals.filter((n) => n > 50).length,
      longTaskAPIAvailable:
        typeof PerformanceObserver !== "undefined" &&
        PerformanceObserver.supportedEntryTypes.includes("longtask"),
      resizeDown,
      resizeRestored,
      cancelled,
      unchangedWidthPersistWrites: storageWrites,
    });
    progress(`drag ${mode} 2 seconds / native window resize / blur cancel`);
  }
  render(null);
  await settle();
  Storage.prototype.setItem = originalSetItem;
  return result;
}
(async () => {
  assert(
    innerWidth === 1200 && innerHeight === 800,
    `Viewport must be 1200x800, got ${innerWidth}x${innerHeight}`
  );
  const result = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    environment: {
      userAgent: navigator.userAgent,
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio,
      mode: "Vite development React 18, no StrictMode",
      baselineCommit: params.get("baseline"),
      isolatedWKWebView: true,
      nativeHumanInput: false,
      sqlExecuted: false,
    },
    methodology: {
      repetitions,
      warmup:
        "Initial mount and two animation frames before repeated measurements; first mount reported separately",
      interactionLatency:
        "Start immediately before flushSync render or DOM scroll/click; finish after two requestAnimationFrame callbacks. Includes frame wait; not CPU-only time or OS presentation timestamp.",
      profiler:
        "Sum React Profiler actualDuration across commits during each operation; React development build with instrumentation",
      reads:
        "Proxy numeric reads from synthetic raw arrays, c0 is sole primary key; setup fixture generation excluded",
      baseline:
        "Actual baselineCommit VirtualDataTable plus equivalent full-page raw-array-to-record conversion in harness; does not mount HEAD TableData",
      allocationBytes: null,
      allocationReason:
        "WKWebView has no exposed allocation-byte API; materialized business property counts are analytical counts, not measured heap bytes",
      longTasks:
        "WebKit longtask API support is recorded per drag; rAF gaps over 50ms are frame gaps, not measured long tasks",
      input:
        "Programmatic DOM MouseEvent, scroll, click in real WKWebView. Resize uses native NSWindow setContentSize. No Tauri backend or database.",
    },
    tables: await tableMatrix(),
    lists: await compareAndSync(),
    drag: await dragCases(),
    unmeasured: [
      "Measured allocation/heap bytes and >=70% allocation-byte reduction",
      "Full Tauri App React commit counts / native pointer trace",
      "Native OS presentation latency and Tauri cold start",
      "Long tasks where WebKit longtask PerformanceObserver is unavailable",
      "Keyboard pagination and full App tab/connection restoration",
    ],
  };
  post({ type: "result", result });
})().catch((error) =>
  post({ type: "error", message: String(error), stack: error?.stack })
);
