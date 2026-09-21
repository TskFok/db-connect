import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { CrashIssueUploadModal } from "../components/common/CrashIssueUploadModal";
import { copyTextWithBreadcrumb } from "../utils/crashBreadcrumbs";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../utils/crashBreadcrumbs", () => ({
  copyTextWithBreadcrumb: vi.fn().mockResolvedValue(undefined),
}));

const defaultProps = {
  open: true,
  onClose: vi.fn(),
  owner: "TskFok",
  repo: "db-connect",
  issueTitle: "原始标题",
  issueBody: "原始正文",
};

function setTauri(enabled: boolean) {
  if (enabled) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    return;
  }
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
}

describe("CrashIssueUploadModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    setTauri(false);
  });

  it("submits the edited title and body through the desktop API", async () => {
    setTauri(true);
    vi.mocked(invoke).mockResolvedValue(
      "https://github.com/TskFok/db-connect/issues/1"
    );
    render(<CrashIssueUploadModal {...defaultProps} />);

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Issue 标题"), {
      target: { value: "用户编辑标题" },
    });
    fireEvent.change(within(dialog).getByLabelText("Issue 正文"), {
      target: { value: "用户编辑正文" },
    });
    fireEvent.change(
      within(dialog).getByPlaceholderText("请输入 GitHub 个人访问令牌"),
      { target: { value: "github-token" } }
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "提交 Issue" }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("create_github_issue", {
        owner: "TskFok",
        repo: "db-connect",
        token: "github-token",
        title: "用户编辑标题",
        body: "用户编辑正文",
      })
    );
  });

  it("locks the submitted title and body while the desktop request is pending", async () => {
    setTauri(true);
    vi.mocked(invoke).mockImplementation(() => new Promise(() => {}));
    render(<CrashIssueUploadModal {...defaultProps} />);

    const dialog = await screen.findByRole("dialog");
    const titleInput = within(dialog).getByLabelText("Issue 标题");
    const bodyInput = within(dialog).getByLabelText("Issue 正文");
    fireEvent.change(
      within(dialog).getByPlaceholderText("请输入 GitHub 个人访问令牌"),
      { target: { value: "github-token" } }
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "提交 Issue" }));

    await waitFor(() => {
      expect(titleInput).toBeDisabled();
      expect(bodyInput).toBeDisabled();
    });
  });

  it("copies and opens the edited content in browser fallback mode", async () => {
    setTauri(false);
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    render(<CrashIssueUploadModal {...defaultProps} />);

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Issue 标题"), {
      target: { value: "浏览器编辑标题" },
    });
    fireEvent.change(within(dialog).getByLabelText("Issue 正文"), {
      target: { value: "浏览器编辑正文" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "复制正文并打开 Issue 页面",
      })
    );

    await waitFor(() =>
      expect(copyTextWithBreadcrumb).toHaveBeenCalledWith(
        "浏览器编辑正文",
        "crash-report-open-issue",
        { owner: "TskFok", repo: "db-connect" }
      )
    );
    const openedUrl = openSpy.mock.calls[0]?.[0];
    expect(openedUrl).toEqual(expect.any(String));
    const parsedUrl = new URL(String(openedUrl));
    expect(parsedUrl.searchParams.get("title")).toBe("浏览器编辑标题");
    expect(parsedUrl.searchParams.get("body")).toBe("浏览器编辑正文");

    openSpy.mockRestore();
  });

  it("prevents closing during a request and allows cancel after failure", async () => {
    setTauri(true);
    let rejectRequest!: (error: Error) => void;
    vi.mocked(invoke).mockImplementation(
      () =>
        new Promise((_, reject) => {
          rejectRequest = reject;
        })
    );
    const onClose = vi.fn();
    render(<CrashIssueUploadModal {...defaultProps} onClose={onClose} />);

    const dialog = await screen.findByRole("dialog");
    fireEvent.change(
      within(dialog).getByPlaceholderText("请输入 GitHub 个人访问令牌"),
      { target: { value: "github-token" } }
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "提交 Issue" }));
    const cancel = within(dialog).getByRole("button", { name: "取 消" });

    await waitFor(() => expect(cancel).toBeDisabled());
    fireEvent.click(cancel);
    expect(onClose).not.toHaveBeenCalled();

    rejectRequest(new Error("请求失败"));
    await screen.findByText("请求失败");
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("resets drafts and token when reopened", async () => {
    setTauri(true);
    const { rerender } = render(<CrashIssueUploadModal {...defaultProps} />);

    let dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Issue 标题"), {
      target: { value: "临时标题" },
    });
    fireEvent.change(within(dialog).getByLabelText("Issue 正文"), {
      target: { value: "临时正文" },
    });
    fireEvent.change(
      within(dialog).getByPlaceholderText("请输入 GitHub 个人访问令牌"),
      { target: { value: "temporary-token" } }
    );

    rerender(<CrashIssueUploadModal {...defaultProps} open={false} />);
    rerender(<CrashIssueUploadModal {...defaultProps} open />);

    dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Issue 标题")).toHaveValue("原始标题");
    expect(within(dialog).getByLabelText("Issue 正文")).toHaveValue("原始正文");
    expect(
      within(dialog).getByPlaceholderText("请输入 GitHub 个人访问令牌")
    ).toHaveValue("");
  });
});
