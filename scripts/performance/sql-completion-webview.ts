import * as monaco from "monaco-editor/esm/vs/editor/editor.api.js";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import {
  registerSqlCompletionProvider,
  type SqlCompletionBinding,
} from "../../src/utils/sqlCompletion";
import { buildSqlMetadataIndex } from "../../src/utils/sqlCompletionMetadataIndex";
import {
  activeSql,
  historicalSql,
  documentSizes,
  completionDocument,
  completionLargeSchema,
} from "../../src/__tests__/fixtures/sqlCompletionDocumentFixtures";

declare global {
  interface Window {
    webkit?: {
      messageHandlers?: { benchmark?: { postMessage(value: unknown): void } };
    };
  }
}

self.MonacoEnvironment = { getWorker: () => new editorWorker() };

const key = {
  connId: "webview-memory-only",
  database: "app",
  dialect: "mysql" as const,
  connectionRevision: 1,
};
const schema = completionLargeSchema();
const index = buildSqlMetadataIndex(schema, key);
const binding: SqlCompletionBinding = { key, index, revision: 1 };
const editor = monaco.editor.create(document.getElementById("editor")!, {
  language: "sql",
  automaticLayout: false,
  minimap: { enabled: false },
  quickSuggestions: false,
  suggestOnTriggerCharacters: false,
  // Replacing benchmark models must not cancel WordHighlighter's unrelated
  // 50 ms delayed decoration promise, which Monaco leaves unhandled.
  occurrencesHighlight: "off",
});

type Sample = {
  providerMs?: number;
  providerMaxMs?: number;
  providerCalls?: number;
  providerItems?: number;
  editMs?: number;
  widgetMs?: number;
  widgetItems?: number;
  frameGapMs?: number;
  focusedAtWidget?: boolean;
  timeout?: string;
  widgetState?: {
    className: string;
    rows: number;
    focused: boolean;
    documentFocused: boolean;
  };
};
let activeSample: Sample | undefined;
// The provider uses only languages; the minimal Monaco entry omits unrelated
// language bundles present in the production module's namespace type.
const wrappedMonaco = Object.create(monaco) as Parameters<
  typeof registerSqlCompletionProvider
>[0];
const wrappedLanguages = Object.create(
  monaco.languages
) as typeof monaco.languages;
wrappedLanguages.registerCompletionItemProvider = ((
  selector: Parameters<
    typeof monaco.languages.registerCompletionItemProvider
  >[0],
  provider: Parameters<
    typeof monaco.languages.registerCompletionItemProvider
  >[1]
) =>
  monaco.languages.registerCompletionItemProvider(selector, {
    ...provider,
    provideCompletionItems(...args) {
      const start = performance.now();
      const result = provider.provideCompletionItems(...args);
      if (activeSample) {
        const duration = performance.now() - start;
        activeSample.providerMs = (activeSample.providerMs ?? 0) + duration;
        activeSample.providerMaxMs = Math.max(
          activeSample.providerMaxMs ?? 0,
          duration
        );
        activeSample.providerCalls = (activeSample.providerCalls ?? 0) + 1;
        if (result && typeof result === "object" && "suggestions" in result) {
          activeSample.providerItems = result.suggestions.length;
        }
      }
      return result;
    },
  })) as typeof monaco.languages.registerCompletionItemProvider;
Object.defineProperty(wrappedMonaco, "languages", { value: wrappedLanguages });

let provider: monaco.IDisposable | undefined;
let model: monaco.editor.ITextModel | undefined;
let modelId = 0;
function createModel(text: string): void {
  provider?.dispose();
  model?.dispose();
  model = monaco.editor.createModel(
    text,
    "sql",
    monaco.Uri.parse(`inmemory://benchmark/${++modelId}.sql`)
  );
  editor.setModel(model);
  provider = registerSqlCompletionProvider(
    wrappedMonaco,
    model.uri.toString(),
    () => binding
  );
  editor.setPosition(model.getPositionAt(model.getValueLength()));
  editor.revealPositionInCenterIfOutsideViewport(editor.getPosition()!);
}
function waitFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
async function closeWidget(): Promise<void> {
  editor.trigger("benchmark", "hideSuggestWidget", {});
  await waitFrame();
  await waitFrame();
}
async function ensureNativeFocus(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      window.removeEventListener("benchmark-native-focus", ready);
      reject(new Error("native WKWebView focus acknowledgement timed out"));
    }, 2_000);
    function ready() {
      window.clearTimeout(timer);
      resolve();
    }
    window.addEventListener("benchmark-native-focus", ready, { once: true });
    window.webkit?.messageHandlers?.benchmark?.postMessage({ type: "focus" });
  });
  editor.focus();
  if (!editor.hasTextFocus())
    throw new Error(
      "Monaco did not gain text focus after native focus acknowledgement"
    );
}
async function trigger(
  beforeTrigger?: (sample: Sample) => void
): Promise<Sample> {
  const sample: Sample = {};
  await ensureNativeFocus();
  activeSample = sample;
  const started = performance.now();
  let lastFrame = started;
  let rafId: number;
  const frame = (time: number) => {
    sample.frameGapMs = Math.max(sample.frameGapMs ?? 0, time - lastFrame);
    lastFrame = time;
    rafId = requestAnimationFrame(frame);
  };
  rafId = requestAnimationFrame(frame);
  beforeTrigger?.(sample);
  editor.trigger("benchmark", "editor.action.triggerSuggest", {});
  await new Promise<void>((resolve) => {
    const observer = new MutationObserver(check);
    const timeoutId = window.setTimeout(() => {
      const widget = editor.getDomNode()?.querySelector(".suggest-widget");
      sample.widgetState = {
        className: widget?.className ?? "missing",
        rows: widget?.querySelectorAll(".monaco-list-row").length ?? 0,
        focused: editor.hasTextFocus(),
        documentFocused: document.hasFocus(),
      };
      sample.timeout = "suggest widget did not show within 5s";
      finish();
    }, 5_000);
    function finish() {
      observer.disconnect();
      window.clearTimeout(timeoutId);
      resolve();
    }
    function check() {
      const widget = editor
        .getDomNode()
        ?.querySelector(".suggest-widget.visible");
      const rows = widget?.querySelectorAll(".monaco-list-row").length ?? 0;
      if (rows > 0) {
        sample.widgetMs = performance.now() - started;
        sample.widgetItems = rows;
        sample.focusedAtWidget = editor.hasTextFocus();
        finish();
      }
    }
    observer.observe(editor.getDomNode()!, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    check();
  });
  cancelAnimationFrame(rafId);
  activeSample = undefined;
  await closeWidget();
  return sample;
}
function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(values.length * fraction) - 1];
}
function summary(samples: Sample[]) {
  const collect = (field: keyof Sample) =>
    samples
      .map((sample) => sample[field])
      .filter((x): x is number => typeof x === "number");
  return Object.fromEntries(
    (
      [
        "providerMs",
        "providerMaxMs",
        "editMs",
        "widgetMs",
        "frameGapMs",
      ] as const
    ).map((field) => {
      const values = collect(field);
      return [
        field,
        {
          p50: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          max: values.length ? Math.max(...values) : null,
          over50: values.filter((x) => x > 50).length,
        },
      ];
    })
  );
}
async function runCase(text: string, mode: "cold" | "hot" | "edit") {
  if (mode !== "cold") {
    createModel(text);
    await waitFrame();
    await waitFrame();
  }
  const samples: Sample[] = [];
  const discardedFocusSamples: {
    sampleIndex: number;
    reason: string;
    sample: Sample;
  }[] = [];
  for (let i = 0; i < 25; i++) {
    if (mode === "cold") {
      createModel(text);
      await waitFrame();
      await waitFrame();
    }
    if (mode === "edit") {
      samples.push(
        await trigger((sample) => {
          const end = model!.getValueLength();
          const start = performance.now();
          model!.applyEdits([
            {
              range: monaco.Range.fromPositions(
                model!.getPositionAt(end - 1),
                model!.getPositionAt(end)
              ),
              text: "",
            },
          ]);
          sample.editMs = performance.now() - start;
          editor.setPosition(model!.getPositionAt(model!.getValueLength()));
        })
      );
      model!.applyEdits([
        {
          range: monaco.Range.fromPositions(
            model!.getPositionAt(model!.getValueLength())
          ),
          text: "l",
        },
      ]);
      editor.setPosition(model!.getPositionAt(model!.getValueLength()));
      editor.revealPositionInCenterIfOutsideViewport(editor.getPosition()!);
    } else {
      samples.push(await trigger());
    }
    const latest = samples.at(-1)!;
    if (
      (latest.timeout && latest.widgetState?.focused === false) ||
      latest.focusedAtWidget === false
    ) {
      discardedFocusSamples.push({
        sampleIndex: i,
        reason: latest.timeout
          ? "editor lost focus before widget timeout"
          : "editor lost focus before widget became visible",
        sample: latest,
      });
      if (discardedFocusSamples.length > 5)
        throw new Error(
          `${mode}: more than 5 samples lost focus; last ${JSON.stringify(latest)}`
        );
      samples.pop();
      i--;
      continue;
    }
    if (latest.timeout || latest.providerItems !== 50)
      throw new Error(
        `${mode} sample ${i}: invalid suggestions ${JSON.stringify(latest)}`
      );
  }
  const measured = samples.slice(5);
  return {
    warmups: 5,
    measured: 20,
    focusDiscarded: discardedFocusSamples.length,
    discardedFocusSamples,
    candidateCount: measured[0].providerItems,
    metrics: summary(measured),
    warmupRaw: samples.slice(0, 5),
    raw: measured,
  };
}
async function main() {
  const memoryApiSupported =
    typeof (
      performance as Performance & { memory?: { usedJSHeapSize: number } }
    ).memory?.usedJSHeapSize === "number";
  const supportedEntries = PerformanceObserver.supportedEntryTypes ?? [];
  const longTasks: { duration: number; startTime: number }[] = [];
  let longTaskObserver: PerformanceObserver | undefined;
  if (supportedEntries.includes("longtask")) {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const item of list.getEntries())
        longTasks.push({ duration: item.duration, startTime: item.startTime });
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  }
  const cases = [];
  const chosenBytes = new URLSearchParams(location.search).get("bytes");
  for (const size of documentSizes.filter(
    (value) => !chosenBytes || value === Number(chosenBytes)
  )) {
    const text = completionDocument(size);
    const modes = {} as Record<string, Awaited<ReturnType<typeof runCase>>>;
    for (const mode of ["cold", "hot", "edit"] as const) {
      modes[mode] = await runCase(text, mode);
      window.webkit?.messageHandlers?.benchmark?.postMessage({
        type: "progress",
        bytes: size,
        mode,
      });
    }
    cases.push({
      bytes: size,
      historicalStatements:
        size === 49
          ? 0
          : Math.floor((size - activeSql.length) / historicalSql.length),
      modes,
    });
  }
  longTaskObserver?.disconnect();
  return {
    source: "real Monaco + registerSqlCompletionProvider in isolated WKWebView",
    recordedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    fixture: {
      dialect: "mysql",
      tables: 1000,
      columnsPerTable: 50,
      expectedCandidates: 50,
    },
    editorConfiguration: {
      quickSuggestions: false,
      suggestOnTriggerCharacters: false,
      occurrencesHighlight: "off",
      minimap: false,
    },
    focusPolicy:
      "Native window activation and Monaco text focus before each sample, outside timing; at most 5 explicitly unfocused samples retried per size/mode; focused timeout is a failure",
    memoryApiSupported,
    longTaskApiSupported: supportedEntries.includes("longtask"),
    longTasks,
    timingDefinitions: {
      providerMs:
        "sum of synchronous provideCompletionItems calls during sample",
      providerMaxMs: "longest single synchronous provider call during sample",
      editMs:
        "synchronous Monaco applyEdits including onDidChangeContent callbacks",
      widgetMs:
        "cold/hot: trigger to first visible row; edit: applyEdits start to first visible row",
      widgetItems: "visible DOM rows; virtualized, not total candidate count",
      candidateCount: "provider return suggestions length",
      frameGapMs:
        "largest requestAnimationFrame interval during trigger; not a Long Task API entry; can miss a task before the first frame",
    },
    cases,
  };
}
main()
  .then((result) =>
    window.webkit?.messageHandlers?.benchmark?.postMessage({
      type: "result",
      result,
    })
  )
  .catch((error) =>
    window.webkit?.messageHandlers?.benchmark?.postMessage({
      type: "error",
      message: String(error),
      stack: error?.stack,
    })
  );
