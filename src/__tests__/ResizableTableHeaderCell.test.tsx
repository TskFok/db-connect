import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ResizableTableHeaderCell } from "../components/common/ResizableTableHeaderCell";

describe("ResizableTableHeaderCell", () => {
  it("无 onResize 时渲染普通 th", () => {
    const { container } = render(
      <table>
        <thead>
          <tr>
            <ResizableTableHeaderCell width={120}>表名</ResizableTableHeaderCell>
          </tr>
        </thead>
      </table>
    );
    const th = container.querySelector("th");
    expect(th).toBeTruthy();
    expect(th?.textContent).toContain("表名");
    expect(
      container.querySelector(".resizable-table-header-handle")
    ).toBeNull();
  });

  it("拖动调节手柄应调用 onResize", () => {
    const onResize = vi.fn();
    const { container } = render(
      <table>
        <thead>
          <tr>
            <ResizableTableHeaderCell width={120} onResize={onResize}>
              表名
            </ResizableTableHeaderCell>
          </tr>
        </thead>
      </table>
    );

    const handle = container.querySelector(
      ".resizable-table-header-handle"
    ) as HTMLElement;
    expect(handle).toBeTruthy();

    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 130 });
    fireEvent.mouseUp(document);

    expect(onResize).toHaveBeenCalled();
    const lastCall = onResize.mock.calls[onResize.mock.calls.length - 1];
    const lastWidth = lastCall?.[0] as number;
    expect(lastWidth).toBeGreaterThan(120);
  });

  it("双击调节手柄应调用 onAutoFit", () => {
    const onAutoFit = vi.fn();
    const { container } = render(
      <table>
        <thead>
          <tr>
            <ResizableTableHeaderCell
              width={120}
              onResize={vi.fn()}
              onAutoFit={onAutoFit}
            >
              表名
            </ResizableTableHeaderCell>
          </tr>
        </thead>
      </table>
    );

    const handle = container.querySelector(
      ".resizable-table-header-handle"
    ) as HTMLElement;
    fireEvent.doubleClick(handle);
    expect(onAutoFit).toHaveBeenCalledTimes(1);
  });
});
