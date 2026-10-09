import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarResize } from "../hooks/useSidebarResize";

const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
function flushFrames() {
  const queued = [...frames.values()];
  frames.clear();
  act(() => queued.forEach((callback) => callback(16)));
}
function Harness({
  width = 280,
  onCommit,
}: {
  width?: number;
  onCommit: (width: number) => void;
}) {
  const { siderRef, onMouseDown } = useSidebarResize({
    width,
    minWidth: 200,
    maxWidth: 480,
    onCommit,
  });
  return (
    <div
      ref={siderRef}
      data-testid="sider"
      style={{ width, flex: `0 0 ${width}px` }}
    >
      <div onMouseDown={onMouseDown} title="调整侧栏" />
    </div>
  );
}
function start(clientX = 280) {
  fireEvent.mouseDown(screen.getByTitle("调整侧栏"), { clientX });
}
function move(clientX: number) {
  fireEvent.mouseMove(window, { clientX });
}

beforeEach(() => {
  frames.clear();
  frameId = 0;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    })
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id))
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

describe("useSidebarResize", () => {
  it("100 次同帧移动只进行一次 DOM 预览，松手前不提交", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    const sider = screen.getByTestId("sider");
    start();
    for (let i = 1; i <= 100; i++) move(280 + i);
    expect(sider.style.width).toBe("280px");
    expect(frames.size).toBe(1);
    flushFrames();
    expect(sider.style.width).toBe("380px");
    expect(sider.style.flexBasis).toBe("380px");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("rAF 前 mouseup 提交最后宽度一次，旧帧不能再改 DOM", () => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    start();
    move(330);
    move(360);
    const staleFrame = [...frames.values()][0];
    fireEvent.mouseUp(window, { clientX: 360 });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(360);
    expect(screen.getByTestId("sider").style.width).toBe("360px");
    expect(frames.size).toBe(0);
    screen.getByTestId("sider").style.width = "390px";
    act(() => staleFrame(16));
    fireEvent.mouseUp(window);
    move(400);
    expect(screen.getByTestId("sider").style.width).toBe("390px");
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it.each([
    [0, 200],
    [1000, 480],
  ])("移动到 %i 时预览和提交都限制到 %i", (x, expected) => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    start();
    move(x);
    flushFrames();
    expect(screen.getByTestId("sider").style.width).toBe(`${expected}px`);
    fireEvent.mouseUp(window, { clientX: x });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it.each(["没有移动", "移动后回到原处"])("%s不提交", (kind) => {
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    start();
    if (kind === "移动后回到原处") {
      move(330);
      flushFrames();
      move(280);
    }
    fireEvent.mouseUp(window, { clientX: 280 });
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByTestId("sider").style.width).toBe("280px");
  });

  it("blur 恢复起始宽度、body 样式并清理事件和旧帧", () => {
    document.body.style.cursor = "crosshair";
    document.body.style.userSelect = "text";
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);
    start();
    move(330);
    flushFrames();
    move(350);
    const staleFrame = [...frames.values()][0];
    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");
    fireEvent.blur(window);
    act(() => staleFrame(16));
    move(450);
    fireEvent.mouseUp(window);
    expect(screen.getByTestId("sider").style.width).toBe("280px");
    expect(screen.getByTestId("sider").style.flexBasis).toBe("280px");
    expect(document.body.style.cursor).toBe("crosshair");
    expect(document.body.style.userSelect).toBe("text");
    expect(frames.size).toBe(0);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("卸载取消拖动，保留 DOM 引用也不会被旧事件或帧写入", () => {
    const onCommit = vi.fn();
    const { unmount } = render(<Harness onCommit={onCommit} />);
    const sider = screen.getByTestId("sider");
    start();
    move(330);
    const staleFrame = [...frames.values()][0];
    unmount();
    const width = sider.style.width;
    act(() => staleFrame(16));
    move(450);
    fireEvent.mouseUp(window);
    expect(sider.style.width).toBe(width);
    expect(frames.size).toBe(0);
    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("重入 mousedown 不创建第二套拖动，StrictMode 清理后可再次开始", () => {
    const onCommit = vi.fn();
    render(
      <StrictMode>
        <Harness onCommit={onCommit} />
      </StrictMode>
    );
    start();
    move(330);
    start(330);
    move(350);
    fireEvent.mouseUp(window, { clientX: 350 });
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(350);
    start();
    move(300);
    fireEvent.mouseUp(window, { clientX: 300 });
    expect(onCommit).toHaveBeenNthCalledWith(2, 300);
  });

  it("重新渲染后下一次拖动使用最新宽度和提交函数", () => {
    const oldCommit = vi.fn();
    const nextCommit = vi.fn();
    const { rerender } = render(<Harness onCommit={oldCommit} />);
    rerender(<Harness width={320} onCommit={nextCommit} />);
    start(320);
    move(350);
    fireEvent.mouseUp(window, { clientX: 350 });
    expect(oldCommit).not.toHaveBeenCalled();
    expect(nextCommit).toHaveBeenCalledExactlyOnceWith(350);
  });
});
