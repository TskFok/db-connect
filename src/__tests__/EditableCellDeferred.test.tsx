import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { EditableCell } from "../components/table/EditableCell";

type DeferredValue = {
  __deferred_field: true;
  preview: string;
  byte_length: number;
  kind: "text" | "binary";
};

function marker(
  preview: string,
  kind: DeferredValue["kind"] = "text"
): DeferredValue {
  return {
    __deferred_field: true,
    preview,
    byte_length: 8192,
    kind,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function renderDeferredCell(
  value: DeferredValue,
  overrides: Partial<React.ComponentProps<typeof EditableCell>> = {}
) {
  const onEdit = vi.fn();
  const loadFullValue = vi.fn<() => Promise<unknown>>();
  const result = render(
    <EditableCell
      value={value}
      pendingValue={undefined}
      hasPending={false}
      onEdit={onEdit}
      loadFullValue={loadFullValue}
      fieldLabel="content"
      cellKey="0:content"
      {...overrides}
    />
  );
  return { ...result, onEdit, loadFullValue };
}

describe("EditableCell 延迟字段", () => {
  it("点击前仅显示预览和按需加载提示，不请求完整值", () => {
    const value = marker("文章开头…");
    const { loadFullValue } = renderDeferredCell(value);

    expect(screen.getByText("文章开头…")).toBeInTheDocument();
    expect(screen.getByText("按需加载")).toBeInTheDocument();
    expect(screen.queryByText("[object Object]")).not.toBeInTheDocument();
    expect(loadFullValue).not.toHaveBeenCalled();
  });

  it("加载成功后允许编辑，并把完整原值交给 onEdit", async () => {
    const value = marker("短预览");
    const pendingLoad = deferred<unknown>();
    const { loadFullValue, onEdit } = renderDeferredCell(value);
    loadFullValue.mockReturnValue(pendingLoad.promise);

    fireEvent.doubleClick(screen.getByTitle("双击加载完整值并编辑"));

    expect(screen.getByRole("dialog")).toHaveTextContent("正在加载完整值");
    expect(screen.getByRole("button", { name: "确 定" })).toBeDisabled();
    expect(loadFullValue).toHaveBeenCalledTimes(1);

    await act(async () => pendingLoad.resolve("完整原始正文"));
    const textarea = await screen.findByRole("textbox");
    expect(textarea).toHaveValue("完整原始正文");
    fireEvent.change(textarea, { target: { value: "编辑后的正文" } });
    fireEvent.click(screen.getByRole("button", { name: "确 定" }));

    expect(onEdit).toHaveBeenCalledExactlyOnceWith(
      "编辑后的正文",
      "完整原始正文"
    );
  });

  it("加载失败时可重试，成功前绝不提交", async () => {
    const value = marker("预览");
    const { loadFullValue, onEdit } = renderDeferredCell(value);
    loadFullValue
      .mockRejectedValueOnce(new Error("网络中断"))
      .mockResolvedValueOnce("重试后的完整值");

    fireEvent.doubleClick(screen.getByTitle("双击加载完整值并编辑"));

    expect(await screen.findByText(/网络中断/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确 定" })).toBeDisabled();
    expect(onEdit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("textbox")).toHaveValue("重试后的完整值");
    expect(loadFullValue).toHaveBeenCalledTimes(2);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it("取消或卸载后忽略迟到结果且不提交", async () => {
    const firstLoad = deferred<unknown>();
    const value = marker("预览");
    const first = renderDeferredCell(value);
    first.loadFullValue.mockReturnValue(firstLoad.promise);

    fireEvent.doubleClick(screen.getByTitle("双击加载完整值并编辑"));
    fireEvent.click(screen.getByRole("button", { name: "取 消" }));
    await act(async () => firstLoad.resolve("取消后才返回"));
    expect(first.onEdit).not.toHaveBeenCalled();
    expect(screen.queryByText("取消后才返回")).not.toBeInTheDocument();
    first.unmount();

    const secondLoad = deferred<unknown>();
    const second = renderDeferredCell(value);
    second.loadFullValue.mockReturnValue(secondLoad.promise);
    fireEvent.doubleClick(screen.getByTitle("双击加载完整值并编辑"));
    second.unmount();
    await act(async () => secondLoad.resolve("卸载后才返回"));
    expect(second.onEdit).not.toHaveBeenCalled();
  });

  it("只读和二进制延迟字段均可查看完整值但不能修改或提交", async () => {
    const readonly = renderDeferredCell(marker("只读预览"), {
      readOnly: true,
      loadFullValue: vi.fn().mockResolvedValue("只读完整值"),
    });
    fireEvent.doubleClick(screen.getByTitle("双击加载完整值并查看"));
    const readonlyText = await screen.findByRole("textbox");
    expect(readonlyText).toHaveValue("只读完整值");
    expect(readonlyText).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "确 定" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "取 消" }));
    expect(readonly.onEdit).not.toHaveBeenCalled();
    readonly.unmount();

    const binary = renderDeferredCell(marker("0x89504e47…", "binary"), {
      loadFullValue: vi.fn().mockResolvedValue("0x89504e470d0a"),
    });
    fireEvent.doubleClick(screen.getByTitle("双击加载完整值并查看"));
    const binaryText = await screen.findByRole("textbox");
    expect(binaryText).toHaveValue("0x89504e470d0a");
    expect(binaryText).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: "确 定" })).toBeDisabled();
    expect(binary.onEdit).not.toHaveBeenCalled();
  });

  it("value 或 cellKey 变化会关闭弹窗并使旧请求失效", async () => {
    const firstValue = marker("第一条预览");
    const secondValue = marker("第二条预览");
    const firstLoad = deferred<unknown>();
    const secondLoad = deferred<unknown>();
    const onEdit = vi.fn();
    const loadFirst = vi.fn(() => firstLoad.promise);
    const loadSecond = vi.fn(() => secondLoad.promise);
    const { rerender } = render(
      <EditableCell
        value={firstValue}
        pendingValue={undefined}
        hasPending={false}
        onEdit={onEdit}
        loadFullValue={loadFirst}
        cellKey="0:content"
      />
    );

    fireEvent.doubleClick(screen.getByTitle("双击加载完整值并编辑"));
    rerender(
      <EditableCell
        value={secondValue}
        pendingValue={undefined}
        hasPending={false}
        onEdit={onEdit}
        loadFullValue={loadSecond}
        cellKey="1:content"
      />
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => firstLoad.resolve("第一条完整值"));
    expect(screen.queryByText("第一条完整值")).not.toBeInTheDocument();
    expect(onEdit).not.toHaveBeenCalled();

    fireEvent.doubleClick(screen.getByTitle("双击加载完整值并编辑"));
    await act(async () => secondLoad.resolve("第二条完整值"));
    expect(await screen.findByRole("textbox")).toHaveValue("第二条完整值");
  });

  it("连续双击复用同一个请求，成功后的再次打开复用当前值缓存", async () => {
    const value = marker("预览");
    const pendingLoad = deferred<unknown>();
    const { loadFullValue } = renderDeferredCell(value);
    loadFullValue.mockReturnValue(pendingLoad.promise);
    const cell = screen.getByTitle("双击加载完整值并编辑");

    fireEvent.doubleClick(cell);
    fireEvent.doubleClick(cell);
    expect(loadFullValue).toHaveBeenCalledTimes(1);
    await act(async () => pendingLoad.resolve("完整值"));
    expect(await screen.findByRole("textbox")).toHaveValue("完整值");
    fireEvent.click(screen.getByRole("button", { name: "取 消" }));

    fireEvent.doubleClick(screen.getByTitle("双击加载完整值并编辑"));
    expect(await screen.findByRole("textbox")).toHaveValue("完整值");
    expect(loadFullValue).toHaveBeenCalledTimes(1);
  });

  it("已有 pendingValue 时编辑 pending 文本，但原值固定为首次加载的完整值", async () => {
    const value = marker("原始预览");
    const onEdit = vi.fn();
    const loadFullValue = vi.fn().mockResolvedValue("完整原值");
    render(
      <EditableCell
        value={value}
        pendingValue="上次待提交文本"
        hasPending
        onEdit={onEdit}
        loadFullValue={loadFullValue}
      />
    );

    fireEvent.doubleClick(screen.getByTitle("双击加载完整值并编辑"));
    const textarea = await screen.findByRole("textbox");
    expect(textarea).toHaveValue("上次待提交文本");
    fireEvent.change(textarea, { target: { value: "再次编辑" } });
    fireEvent.click(screen.getByRole("button", { name: "确 定" }));

    expect(onEdit).toHaveBeenCalledExactlyOnceWith("再次编辑", "完整原值");
  });

  it("完整原值为 null 时确认空内容仍以 null 作为新旧值", async () => {
    const value = marker("NULL 预览");
    const onEdit = vi.fn();
    render(
      <EditableCell
        value={value}
        pendingValue={undefined}
        hasPending={false}
        onEdit={onEdit}
        loadFullValue={vi.fn().mockResolvedValue(null)}
      />
    );

    fireEvent.doubleClick(screen.getByTitle("双击加载完整值并编辑"));
    expect(await screen.findByRole("textbox")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "确 定" }));

    expect(onEdit).toHaveBeenCalledExactlyOnceWith(null, null);
  });

  it("完整值加载并修改后卸载也不自动提交，必须明确确认", async () => {
    const value = marker("预览");
    const onEdit = vi.fn();
    const { unmount } = render(
      <EditableCell
        value={value}
        pendingValue={undefined}
        hasPending={false}
        onEdit={onEdit}
        loadFullValue={vi.fn().mockResolvedValue("完整原值")}
      />
    );

    fireEvent.doubleClick(screen.getByTitle("双击加载完整值并编辑"));
    const textarea = await screen.findByRole("textbox");
    fireEvent.change(textarea, { target: { value: "未确认的修改" } });
    unmount();

    expect(onEdit).not.toHaveBeenCalled();
  });

  it("React StrictMode 重建 effect 后仍能完成加载", async () => {
    const value = marker("严格模式预览");
    render(
      <StrictMode>
        <EditableCell
          value={value}
          pendingValue={undefined}
          hasPending={false}
          onEdit={vi.fn()}
          loadFullValue={vi.fn().mockResolvedValue("严格模式完整值")}
        />
      </StrictMode>
    );

    fireEvent.doubleClick(screen.getByTitle("双击加载完整值并编辑"));

    expect(await screen.findByRole("textbox")).toHaveValue("严格模式完整值");
  });
});
