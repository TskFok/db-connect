import { useMemo } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnType } from "antd/es/table";
import { VirtualDataTable } from "../components/table/VirtualDataTable";
import { useTableColumnSettingsStore } from "../stores/tableColumnSettingsStore";
import { saveTableColumnSettings } from "../services/tauriCommands";

vi.mock("../services/tauriCommands", () => ({
  getTableColumnSettings: vi.fn().mockResolvedValue(null),
  saveTableColumnSettings: vi.fn().mockResolvedValue(undefined),
  deleteTableColumnSettings: vi.fn().mockResolvedValue(undefined),
}));

const rows = [{ id: 1, name: "示例" }];
const rowKey = () => "1";

function PersistedTable({ table = "users", revision = 0 }) {
  const width = useTableColumnSettingsStore(
    (state) => state.settings[`conn|db|${table}`]?.columnWidths.id ?? 120
  );
  const columns = useMemo<ColumnType<Record<string, unknown>>[]>(
    () => [
      {
        key: "id",
        dataIndex: "id",
        title: "编号",
        width,
        onHeaderCell: () =>
          ({
            onResize: (nextWidth: number) =>
              useTableColumnSettingsStore
                .getState()
                .setColumnWidth("conn", "db", table, "id", nextWidth),
          }) as React.HTMLAttributes<HTMLElement>,
      },
      { key: "name", dataIndex: "name", title: "名称", width: 160 },
    ],
    [table, width]
  );
  return (
    <VirtualDataTable
      key={table}
      columns={columns}
      dataSource={rows}
      rowKey={rowKey}
      height={400}
      renderRevision={revision}
    />
  );
}

describe("VirtualDataTable 列宽拖动持久化", () => {
  let frames: Map<number, FrameRequestCallback>;
  let frameId: number;

  beforeEach(() => {
    frames = new Map();
    frameId = 0;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frames.set(++frameId, callback);
        return frameId;
      })
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => frames.delete(id))
    );
    useTableColumnSettingsStore.setState({ settings: {} });
    vi.mocked(saveTableColumnSettings).mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  });

  function flushFrames() {
    act(() => {
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(0));
    });
  }

  it("多次移动合并为一帧，表头和单元格实时布局且松手只保存一次", () => {
    const { container, getByRole } = render(<PersistedTable />);
    fireEvent.mouseDown(getByRole("separator"), { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 130 });
    fireEvent.mouseMove(document, { clientX: 160 });
    expect(saveTableColumnSettings).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    expect(
      container.querySelector(".virtual-data-table-header-cell")
    ).toHaveStyle({ width: "120px" });

    flushFrames();
    const headers = container.querySelectorAll(
      ".virtual-data-table-header-cell"
    );
    expect(headers[0]).toHaveStyle({ width: "180px" });
    expect(headers[1]).toHaveStyle({ left: "180px" });
    expect(
      container.querySelector(".virtual-data-table-row")?.firstElementChild
    ).toHaveStyle({ width: "180px" });
    expect(saveTableColumnSettings).not.toHaveBeenCalled();

    fireEvent.mouseMove(document, { clientX: 190 });
    fireEvent.mouseUp(document);
    expect(saveTableColumnSettings).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(vi.mocked(saveTableColumnSettings).mock.calls[0][0]).state
        .settings["conn|db|users"].columnWidths.id
    ).toBe(210);
    expect(headers[0]).toHaveStyle({ width: "210px" });
    expect(frames.size).toBe(0);
    flushFrames();
    expect(saveTableColumnSettings).toHaveBeenCalledTimes(1);
  });

  it("首帧前快速松手仍保存最后移动位置", () => {
    const { getByRole } = render(<PersistedTable />);
    fireEvent.mouseDown(getByRole("separator"), { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 170 });
    fireEvent.mouseMove(document, { clientX: 180 });
    fireEvent.mouseUp(document);
    expect(saveTableColumnSettings).toHaveBeenCalledTimes(1);
    expect(
      useTableColumnSettingsStore.getState().getSettings("conn", "db", "users")
        .columnWidths.id
    ).toBe(200);
    expect(frames.size).toBe(0);
  });

  it("未移动或拖回起点不保存", () => {
    const { getByRole } = render(<PersistedTable />);
    const handle = getByRole("separator");
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseUp(document);
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 100 });
    expect(frames.size).toBe(0);
    fireEvent.mouseMove(document, { clientX: 160 });
    flushFrames();
    fireEvent.mouseMove(document, { clientX: 100 });
    fireEvent.mouseUp(document);
    expect(saveTableColumnSettings).not.toHaveBeenCalled();
  });

  it("卸载取消待执行帧和 document 监听并恢复原来的光标样式", () => {
    document.body.style.cursor = "crosshair";
    document.body.style.userSelect = "text";
    const { getByRole, unmount } = render(<PersistedTable />);
    fireEvent.mouseDown(getByRole("separator"), { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 180 });
    unmount();
    expect(frames.size).toBe(0);
    expect(document.body.style.cursor).toBe("crosshair");
    expect(document.body.style.userSelect).toBe("text");
    fireEvent.mouseMove(document, { clientX: 200 });
    fireEvent.mouseUp(document);
    flushFrames();
    expect(saveTableColumnSettings).not.toHaveBeenCalled();
  });

  it("切表中止旧拖动，不会把旧宽度保存到任一表", () => {
    const { getByRole, rerender, container } = render(<PersistedTable />);
    fireEvent.mouseDown(getByRole("separator"), { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 180 });
    flushFrames();
    rerender(<PersistedTable table="orders" />);
    fireEvent.mouseMove(document, { clientX: 200 });
    fireEvent.mouseUp(document);
    expect(saveTableColumnSettings).not.toHaveBeenCalled();
    expect(
      container.querySelector(".virtual-data-table-header-cell")
    ).toHaveStyle({ width: "120px" });
  });

  it("拖动跨过普通重渲染仍连续生效，提交后接受外部自动列宽", () => {
    const { getByRole, rerender, container } = render(<PersistedTable />);
    fireEvent.mouseDown(getByRole("separator"), { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 160 });
    flushFrames();
    rerender(<PersistedTable revision={1} />);
    fireEvent.mouseMove(document, { clientX: 190 });
    fireEvent.mouseUp(document);
    expect(saveTableColumnSettings).toHaveBeenCalledTimes(1);
    act(() =>
      useTableColumnSettingsStore
        .getState()
        .setColumnWidth("conn", "db", "users", "id", 250)
    );
    expect(
      container.querySelector(".virtual-data-table-header-cell")
    ).toHaveStyle({ width: "250px" });
  });

  it.each([
    [2000, 800],
    [-2000, 60],
  ])("拖动到 %s 时保留列宽边界 %s", (clientX, expectedWidth) => {
    const { getByRole } = render(<PersistedTable />);
    fireEvent.mouseDown(getByRole("separator"), { clientX: 100 });
    fireEvent.mouseMove(document, { clientX });
    fireEvent.mouseUp(document);
    expect(
      useTableColumnSettingsStore.getState().getSettings("conn", "db", "users")
        .columnWidths.id
    ).toBe(expectedWidth);
  });
});
