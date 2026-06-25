import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useElementHeight } from "../hooks/useElementHeight";

describe("useElementHeight", () => {
  let rafSpy: ReturnType<typeof vi.spyOn>;

  const mockRect = (el: HTMLElement, height: number) => {
    Object.defineProperty(el, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        height,
        width: 200,
        top: 0,
        left: 0,
        right: 200,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
  };

  beforeEach(() => {
    rafSpy = vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    rafSpy.mockRestore();
  });

  it("挂载元素后应返回测量高度", () => {
    const { result } = renderHook(() => useElementHeight());
    const el = document.createElement("div");
    el.style.height = "400px";
    mockRect(el, 400);

    act(() => {
      result.current.ref(el);
    });

    expect(result.current.height).toBe(400);
  });

  it("卸载 ref 后高度保留，再次挂载新元素应重新测量", () => {
    const { result } = renderHook(() => useElementHeight());
    const el = document.createElement("div");
    el.style.height = "100px";
    mockRect(el, 100);

    act(() => {
      result.current.ref(el);
      result.current.ref(null);
    });

    expect(result.current.height).toBe(100);

    const el2 = document.createElement("div");
    el2.style.height = "180px";
    mockRect(el2, 180);
    act(() => {
      result.current.ref(el2);
    });
    expect(result.current.height).toBe(180);
  });

  it("remeasureKey 变化时应重新测量可见高度", () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useElementHeight({ remeasureKey: key }),
      { initialProps: { key: "tab-a" } }
    );
    const el = document.createElement("div");
    el.style.height = "260px";
    mockRect(el, 260);

    act(() => {
      result.current.ref(el);
    });
    expect(result.current.height).toBe(260);

    mockRect(el, 380);
    rerender({ key: "tab-b" });
    expect(result.current.height).toBe(380);
  });
});
