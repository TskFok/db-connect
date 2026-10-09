import { Profiler } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";
import { useSettingsStore } from "../stores/settingsStore";
import * as api from "../services/tauriCommands";

vi.mock("../services/tauriCommands");
// 隔离 App 根订阅：子面板有各自独立的 store 订阅，不能将它们的提交计入 App。
// 保留真实 App、事件 hook、stores、AntD 布局及全局加载条。
vi.mock("../components/connection/ConnectionList", () => ({
  ConnectionList: () => null,
}));
vi.mock("../components/connection/ConnectionForm", () => ({
  ConnectionForm: () => null,
}));
vi.mock("../components/database/DatabaseTree", () => ({
  DatabaseTree: () => null,
}));
vi.mock("../components/database/DatabaseOverview", () => ({
  DatabaseOverview: () => null,
}));
vi.mock("../components/table/TableContent", () => ({
  TableContent: () => null,
}));
vi.mock("../components/table/TableTabsBar", () => ({
  TableTabsBar: () => null,
}));
vi.mock("../components/sql/SqlEditorLazy", () => ({ SqlEditor: () => null }));
vi.mock("../components/common/ProjectIntroModal", () => ({
  ProjectIntroModal: () => null,
}));
vi.mock("../components/common/ProjectIntroTrigger", () => ({
  ProjectIntroTrigger: () => null,
}));
vi.mock("../components/common/ShortcutsHelpModal", () => ({
  ShortcutsHelpModal: () => null,
}));
vi.mock("../components/common/ThemeToggle", () => ({
  ThemeToggle: () => null,
}));
vi.mock("../components/common/IdleTimeoutSetting", () => ({
  IdleTimeoutSetting: () => null,
}));
vi.mock("../components/common/WindowLaunchSetting", () => ({
  WindowLaunchSetting: () => null,
}));
vi.mock("../components/databaseCompare/DatabaseCompareModal", () => ({
  DatabaseCompareModal: () => null,
}));

async function mountApp() {
  const onRender = vi.fn();
  const view = render(
    <Profiler id="app" onRender={onRender}>
      <App />
    </Profiler>
  );
  await act(async () => {});
  onRender.mockClear();
  const storage = vi.spyOn(localStorage, "setItem");
  const settingsWrites = () =>
    storage.mock.calls.filter(([key]) => key === "db-connect-settings");
  return { ...view, onRender, settingsWrites };
}

describe("App 根订阅和侧栏拖动", () => {
  beforeEach(() => {
    vi.mocked(api.listSavedConnections).mockResolvedValue([]);
    useConnectionStore.setState({
      activeConnection: null,
      activeConnId: null,
      activeConnections: {},
      showConnectionForm: false,
      loading: false,
      error: null,
    });
    useDatabaseStore.getState().reset();
    useSettingsStore.setState({
      sidebarWidth: 280,
      listTableSettings: {},
      windowBounds: null,
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["列设置", "窗口尺寸"])("未消费的%s变化不提交 App", async (kind) => {
    const { onRender } = await mountApp();
    act(() => {
      if (kind === "列设置")
        useSettingsStore
          .getState()
          .setListTableColumnWidth("list", "name", 240);
      else
        useSettingsStore
          .getState()
          .setWindowBounds({
            width: 1000,
            height: 800,
            x: 0,
            y: 0,
            maximized: false,
          });
    });
    expect(onRender).not.toHaveBeenCalled();
  });

  it("未消费的连接编辑状态不提交 App", async () => {
    const { onRender } = await mountApp();
    act(() =>
      useConnectionStore.setState({
        editingConnection: {
          id: "saved",
          name: "编辑中",
          host: "localhost",
          port: 3306,
          username: "root",
          database_type: "mysql",
        },
      })
    );
    expect(onRender).not.toHaveBeenCalled();
  });

  it("连接加载和错误仍更新展示", async () => {
    const { container } = await mountApp();
    act(() => useConnectionStore.setState({ loading: true }));
    expect(container.querySelector(".global-loading-bar")).not.toBeNull();
    act(() =>
      useConnectionStore.setState({ error: "测试连接失败", loading: false })
    );
    expect(container.querySelector(".global-loading-bar")).toBeNull();
    expect(document.body.textContent).toContain("测试连接失败");
    expect(useConnectionStore.getState().error).toBeNull();
  });

  it("100 次同帧移动预览不提交 App，松手只写一次真实 persist", async () => {
    let callback: FrameRequestCallback | undefined;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((cb: FrameRequestCallback) => {
        callback = cb;
        return 1;
      })
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn(() => {
        callback = undefined;
      })
    );
    const { container, onRender, settingsWrites } = await mountApp();
    const handle = container.querySelector(".app-sider-resize-handle")!;
    const sider = container.querySelector(
      ".app-resizable-sider"
    ) as HTMLDivElement;
    fireEvent.mouseDown(handle, { clientX: 280 });
    for (let i = 1; i <= 100; i++)
      fireEvent.mouseMove(window, { clientX: 280 + i });
    act(() => callback?.(16));
    expect(sider.style.width).toBe("380px");
    expect(sider.style.flexBasis).toBe("380px");
    expect(onRender).not.toHaveBeenCalled();
    expect(settingsWrites()).toHaveLength(0);
    fireEvent.mouseUp(window, { clientX: 380 });
    expect(useSettingsStore.getState().sidebarWidth).toBe(380);
    expect(settingsWrites()).toHaveLength(1);
    // Profiler 包含 AntD message holder 的独立提交；持久化计数才是完成拖动的契约。
    expect(onRender).toHaveBeenCalled();
  });
  it.each(["未移动", "失焦取消", "卸载取消"])(
    "%s不写持久化，后续 mouseup 无副作用",
    async (kind) => {
      vi.stubGlobal(
        "requestAnimationFrame",
        vi.fn(() => 1)
      );
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      const { container, unmount, settingsWrites } = await mountApp();
      const handle = container.querySelector(".app-sider-resize-handle")!;
      fireEvent.mouseDown(handle, { clientX: 280 });
      if (kind !== "未移动") fireEvent.mouseMove(window, { clientX: 340 });
      if (kind === "失焦取消") fireEvent.blur(window);
      if (kind === "卸载取消") unmount();
      fireEvent.mouseUp(window, { clientX: 340 });
      expect(useSettingsStore.getState().sidebarWidth).toBe(280);
      expect(settingsWrites()).toHaveLength(0);
    }
  );
});
