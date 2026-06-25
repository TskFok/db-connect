import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectIntroModal } from "../components/common/ProjectIntroModal";

describe("ProjectIntroModal", () => {
  it("open 为 true 时显示对话框标题与核心段落", () => {
    render(<ProjectIntroModal open onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("功能介绍")).toBeInTheDocument();
    expect(
      screen.getByText(
        /DB Connect 是基于 Tauri 与 React 的跨平台数据库桌面客户端，支持 MySQL 与 PostgreSQL/
      )
    ).toBeInTheDocument();
    expect(screen.getByText("连接管理")).toBeInTheDocument();
    expect(screen.getByText("SQL 编辑器")).toBeInTheDocument();
  });

  it("点击关闭区域时调用 onClose", () => {
    const onClose = vi.fn();
    render(<ProjectIntroModal open onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
