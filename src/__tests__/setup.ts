import "@testing-library/jest-dom";

// jsdom 未实现 document.queryCommandSupported；monaco-editor 在模块加载时会调用 cut/copy/paste 探测。
if (typeof document !== "undefined" && typeof document.queryCommandSupported !== "function") {
  document.queryCommandSupported = () => false;
}

// jsdom 对 getComputedStyle(element, pseudoElt) 只会输出 not implemented 噪声。
// AntD / rc-table 会传 pseudoElt 探测滚动条尺寸；测试里直接忽略第二参即可。
if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
  const originalGetComputedStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = (elt: Element, _pseudoElt?: string | null) =>
    originalGetComputedStyle(elt);
}

// jsdom 默认不实现 canvas 2d context；列宽自适应只需要 measureText。
if (typeof globalThis.HTMLCanvasElement !== "undefined") {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    writable: true,
    value(contextId: string) {
      if (contextId !== "2d") return null;
      return {
        canvas: this,
        font: "",
        measureText(text: string) {
          return { width: String(text ?? "").length * 7 } as TextMetrics;
        },
        clearRect() {},
        fillRect() {},
        save() {},
        restore() {},
        beginPath() {},
        closePath() {},
        moveTo() {},
        lineTo() {},
        stroke() {},
        fill() {},
      } as unknown as CanvasRenderingContext2D;
    },
  });
}

// Mock localStorage for zustand persist middleware
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] ?? null,
  };
})();

Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  writable: true,
});

// jsdom 默认不实现 ResizeObserver；@tanstack/react-virtual 与列虚拟化 hook 都依赖它感知尺寸变化。
// 这里实现一个能立刻 fire 一次 callback 的 mock，让虚拟化首屏可以拿到容器尺寸。
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
  class ResizeObserverMock {
    private callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element): void {
      const rect: DOMRectReadOnly = (target as HTMLElement).getBoundingClientRect() as DOMRectReadOnly;
      const width = (target as HTMLElement).offsetWidth || rect.width || 0;
      const height = (target as HTMLElement).offsetHeight || rect.height || 0;
      const entry = {
        target,
        contentRect: rect,
        borderBoxSize: [{ inlineSize: width, blockSize: height }],
        contentBoxSize: [{ inlineSize: width, blockSize: height }],
        devicePixelContentBoxSize: [{ inlineSize: width, blockSize: height }],
      } as unknown as ResizeObserverEntry;
      // 同步 fire（react-virtual 期望尽快收到）
      this.callback([entry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: ResizeObserverMock,
    writable: true,
  });
}

// jsdom 中 offsetWidth / offsetHeight 默认始终为 0，会导致 @tanstack/react-virtual 计算出 0 个可见项。
// 为测试提供一个 fallback：若 element 上设置了 inline width/height（含 px 数值或 100%），用它，否则给一个合理默认。
if (typeof globalThis.HTMLElement !== "undefined") {
  const parseSize = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const m = value.match(/^(\d+(?:\.\d+)?)px$/);
    if (m) return Math.round(parseFloat(m[1]!));
    return fallback;
  };
  if (
    !Object.prototype.hasOwnProperty.call(HTMLElement.prototype, "__virtualSizeStub")
  ) {
    Object.defineProperty(HTMLElement.prototype, "__virtualSizeStub", {
      value: true,
      writable: false,
    });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
      configurable: true,
      get() {
        return parseSize((this as HTMLElement).style.width, 1024);
      },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        return parseSize((this as HTMLElement).style.height, 600);
      },
    });
  }
}
