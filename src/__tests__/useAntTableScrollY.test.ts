import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAntTableScrollY } from "../hooks/useAntTableScrollY";
import { ANT_TABLE_HEADER_HEIGHT_SMALL } from "../utils/antTableLayout";

describe("useAntTableScrollY", () => {
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

  it("应返回容器 ref 与 scrollY", () => {
    const { result } = renderHook(() => useAntTableScrollY());
    const el = document.createElement("div");
    el.style.height = "400px";
    mockRect(el, 400);

    act(() => {
      result.current.containerRef(el);
    });

    expect(result.current.containerHeight).toBe(400);
    expect(result.current.scrollY).toBe(400 - ANT_TABLE_HEADER_HEIGHT_SMALL);
  });

  it("remeasureKey 变化时应重新测量", () => {
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useAntTableScrollY({ remeasureKey: key }),
      { initialProps: { key: "a" } }
    );
    const el = document.createElement("div");
    el.style.height = "300px";
    mockRect(el, 300);

    act(() => {
      result.current.containerRef(el);
    });
    expect(result.current.containerHeight).toBe(300);

    mockRect(el, 420);
    rerender({ key: "b" });
    expect(result.current.containerHeight).toBe(420);
  });
});
