import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import App from "../App";
import * as api from "../services/tauriCommands";
import { useConnectionStore } from "../stores/connectionStore";
import { useDatabaseStore } from "../stores/databaseStore";

const loads = vi.hoisted(() => ({ intro: 0, shortcuts: 0, compare: 0 }));
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
vi.mock("../components/common/ThemeToggle", () => ({
  ThemeToggle: () => null,
}));
vi.mock("../components/common/IdleTimeoutSetting", () => ({
  IdleTimeoutSetting: () => null,
}));
vi.mock("../components/common/WindowLaunchSetting", () => ({
  WindowLaunchSetting: () => null,
}));

vi.mock("../components/common/ProjectIntroModal", () => {
  loads.intro++;
  return {
    ProjectIntroModal: ({
      open,
      onClose,
    }: {
      open: boolean;
      onClose: () => void;
    }) => (open ? <button onClick={onClose}>关闭功能介绍</button> : null),
  };
});
vi.mock("../components/common/ShortcutsHelpModal", () => {
  loads.shortcuts++;
  return {
    ShortcutsHelpModal: ({
      open,
      onClose,
    }: {
      open: boolean;
      onClose: () => void;
    }) => (open ? <button onClick={onClose}>关闭快捷键帮助</button> : null),
  };
});
vi.mock("../components/databaseCompare/DatabaseCompareModal", () => {
  loads.compare++;
  return {
    DatabaseCompareModal: ({
      open,
      onClose,
    }: {
      open: boolean;
      onClose: () => void;
    }) => (open ? <button onClick={onClose}>关闭结构对比</button> : null),
  };
});

it("启动不导入可选弹窗，实际入口首次打开才加载且再次打开复用", async () => {
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
  render(<App />);
  await act(async () => {});
  expect(loads).toEqual({ intro: 0, shortcuts: 0, compare: 0 });
  fireEvent.click(screen.getByRole("button", { name: "功能介绍" }));
  fireEvent.click(await screen.findByText("关闭功能介绍"));
  expect(loads).toEqual({ intro: 1, shortcuts: 0, compare: 0 });
  fireEvent.click(screen.getByRole("button", { name: "功能介绍" }));
  fireEvent.click(await screen.findByText("关闭功能介绍"));
  expect(loads.intro).toBe(1);
  fireEvent.keyDown(window, { key: "/", ctrlKey: true });
  fireEvent.click(await screen.findByText("关闭快捷键帮助"));
  expect(loads).toEqual({ intro: 1, shortcuts: 1, compare: 0 });
  fireEvent.click(screen.getByRole("button", { name: "数据库对比" }));
  fireEvent.click(await screen.findByText("关闭结构对比"));
  expect(loads).toEqual({ intro: 1, shortcuts: 1, compare: 1 });
});
