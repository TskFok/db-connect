import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeferredFeature } from "../components/common/DeferredFeatureBoundary";

type FeatureProps = { open: boolean; onClose: () => void };
const errorListeners: ((event: ErrorEvent) => void)[] = [];

// 仅忽略本用例主动制造且被功能边界捕获的错误，保留其它错误的报告。
function expectCaughtError(error: Error, componentName: string) {
  const onError = (event: ErrorEvent) => {
    if (event.error === error) event.preventDefault();
  };
  errorListeners.push(onError);
  window.addEventListener("error", onError);
  const originalError = console.error;
  vi.spyOn(console, "error").mockImplementation((...args) => {
    if (
      typeof args[0] === "string" &&
      args[0].startsWith(
        `The above error occurred in the <${componentName}>`
      ) &&
      args[0].includes("DeferredFeatureBoundary")
    )
      return;
    originalError(...args);
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("可选功能加载边界", () => {
  afterEach(() => {
    for (const listener of errorListeners.splice(0))
      window.removeEventListener("error", listener);
    vi.restoreAllMocks();
  });

  it("未打开不加载，加载期间关闭后旧响应不会重新打开", async () => {
    const pending = deferred<{ default: React.ComponentType<FeatureProps> }>();
    const loader = vi.fn(() => pending.promise);
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>打开功能</button>
          <DeferredFeature
            active={open}
            loader={loader}
            onClose={() => setOpen(false)}
          >
            {(Feature) => (
              <Feature open={open} onClose={() => setOpen(false)} />
            )}
          </DeferredFeature>
        </>
      );
    }
    render(<Host />);
    expect(loader).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("打开功能"));
    expect(loader).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("正在加载");
    fireEvent.click(screen.getByRole("button", { name: /关\s*闭/ }));
    await act(async () => pending.resolve({ default: () => <p>旧功能</p> }));
    expect(screen.queryByText("旧功能")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("失败只显示局部错误，重新打开使用新加载尝试", async () => {
    const error = new Error("chunk unavailable");
    expectCaughtError(error, "DeferredFeatureBoundary");
    const loader = vi
      .fn<() => Promise<{ default: React.ComponentType<FeatureProps> }>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce({
        default: ({ open }) => (open ? <p>功能内容</p> : null),
      });
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <p>主界面</p>
          <button onClick={() => setOpen(true)}>打开功能</button>
          <DeferredFeature
            active={open}
            loader={loader}
            onClose={() => setOpen(false)}
          >
            {(Feature) => (
              <Feature open={open} onClose={() => setOpen(false)} />
            )}
          </DeferredFeature>
        </>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByText("打开功能"));
    expect(await screen.findByRole("alert")).toHaveTextContent("功能加载失败");
    expect(screen.getByText("主界面")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /关\s*闭/ }));
    fireEvent.click(screen.getByText("打开功能"));
    expect(await screen.findByText("功能内容")).toBeVisible();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "导入成功但首次渲染失败时可关闭并重新打开恢复（modal=%s）",
    async (modal) => {
      const error = new Error("render failed");
      expectCaughtError(error, "BrokenFeature");
      function BrokenFeature(): never {
        throw error;
      }
      const loader = vi
        .fn<() => Promise<{ default: React.ComponentType<FeatureProps> }>>()
        .mockResolvedValueOnce({ default: BrokenFeature })
        .mockResolvedValueOnce({
          default: ({ open }) => (open ? <p>恢复后的功能</p> : null),
        });
      function Host() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <button onClick={() => setOpen(true)}>打开功能</button>
            <DeferredFeature
              active={open}
              loader={loader}
              onClose={() => setOpen(false)}
              modal={modal}
            >
              {(Feature) => (
                <Feature open={open} onClose={() => setOpen(false)} />
              )}
            </DeferredFeature>
          </>
        );
      }
      render(<Host />);
      fireEvent.click(screen.getByText("打开功能"));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "功能加载失败"
      );
      fireEvent.click(screen.getByRole("button", { name: /关\s*闭/ }));
      await waitFor(() =>
        expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      fireEvent.click(screen.getByText("打开功能"));
      expect(await screen.findByText("恢复后的功能")).toBeVisible();
      expect(loader).toHaveBeenCalledTimes(2);
    }
  );

  it.each([false, true])(
    "健康实例后续渲染失败时关闭销毁且重开恢复（modal=%s）",
    async (modal) => {
      const error = new Error("update render failed");
      expectCaughtError(error, "UpdatingFeature");
      function UpdatingFeature({ open }: FeatureProps) {
        const [broken, setBroken] = useState(false);
        if (broken) throw error;
        return open ? (
          <button onClick={() => setBroken(true)}>触发渲染异常</button>
        ) : null;
      }
      const loader = vi.fn(async () => ({ default: UpdatingFeature }));
      function Host() {
        const [open, setOpen] = useState(false);
        return (
          <>
            <button onClick={() => setOpen(true)}>打开功能</button>
            <DeferredFeature
              active={open}
              loader={loader}
              onClose={() => setOpen(false)}
              modal={modal}
            >
              {(Feature) => (
                <Feature open={open} onClose={() => setOpen(false)} />
              )}
            </DeferredFeature>
          </>
        );
      }
      render(<Host />);
      fireEvent.click(screen.getByText("打开功能"));
      fireEvent.click(await screen.findByText("触发渲染异常"));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "功能加载失败"
      );
      fireEvent.click(screen.getByRole("button", { name: /关\s*闭/ }));
      await waitFor(() =>
        expect(screen.queryByRole("alert")).not.toBeInTheDocument()
      );
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      fireEvent.click(screen.getByText("打开功能"));
      expect(await screen.findByText("触发渲染异常")).toBeVisible();
      expect(loader).toHaveBeenCalledTimes(2);
    }
  );

  it("成功后关闭保留实例，运行中由功能自身决定能否关闭", async () => {
    const unmount = vi.fn();
    function Feature({ open, onClose }: FeatureProps) {
      const [running, setRunning] = useState(false);
      useEffect(() => () => unmount(), []);
      return open ? (
        <>
          <button onClick={() => setRunning(true)}>开始同步</button>
          <p>{running ? "同步中" : "空闲"}</p>
          <button
            onClick={() => {
              if (!running) onClose();
            }}
          >
            关闭功能
          </button>
          <button onClick={() => setRunning(false)}>结束同步</button>
        </>
      ) : null;
    }
    const loader = vi.fn(async () => ({ default: Feature }));
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>打开功能</button>
          <DeferredFeature
            active={open}
            loader={loader}
            onClose={() => setOpen(false)}
          >
            {(Loaded) => <Loaded open={open} onClose={() => setOpen(false)} />}
          </DeferredFeature>
        </>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByText("打开功能"));
    fireEvent.click(await screen.findByText("开始同步"));
    fireEvent.click(screen.getByText("关闭功能"));
    expect(screen.getByText("同步中")).toBeVisible();
    expect(unmount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("结束同步"));
    fireEvent.click(screen.getByText("关闭功能"));
    await waitFor(() =>
      expect(screen.queryByText("空闲")).not.toBeInTheDocument()
    );
    expect(unmount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("打开功能"));
    expect(await screen.findByText("空闲")).toBeVisible();
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
