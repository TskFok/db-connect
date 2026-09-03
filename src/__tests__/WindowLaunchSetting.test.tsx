import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { WindowLaunchSetting } from "../components/common/WindowLaunchSetting";
import { useSettingsStore } from "../stores/settingsStore";

describe("WindowLaunchSetting", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      windowLaunchMode: "maximized",
    });
  });

  it("应展示启动时最大化选项", () => {
    render(<WindowLaunchSetting />);
    expect(
      screen.getByRole("combobox", { name: "窗口启动方式" })
    ).toBeInTheDocument();
  });

  it("切换为记住窗口大小时应更新 store", async () => {
    render(<WindowLaunchSetting />);
    fireEvent.mouseDown(screen.getByRole("combobox", { name: "窗口启动方式" }));
    fireEvent.click(await screen.findByText("记住窗口大小"));
    expect(useSettingsStore.getState().windowLaunchMode).toBe("remember");
  });
});
