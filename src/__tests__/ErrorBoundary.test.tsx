import { render, screen, fireEvent, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../components/common/ErrorBoundary";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../utils/crashBreadcrumbs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/crashBreadcrumbs")>();
  return {
    ...actual,
    copyTextWithBreadcrumb: vi.fn().mockResolvedValue(undefined),
    getCrashBreadcrumbs: vi.fn().mockReturnValue(null),
  };
});

function ThrowingChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error("boom-boundary");
  }
  return <span>ok</span>;
}

describe("ErrorBoundary", () => {
  it("shows recovery actions and crash details when child throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow />
      </ErrorBoundary>
    );

    expect(
      await screen.findByRole("heading", { name: /应用遇到了错误/ })
    ).toBeInTheDocument();
    expect(screen.getAllByText(/boom-boundary/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /上传到 GitHub/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /上传到 GitHub/ }));
    const dialog = await screen.findByRole("dialog", {
      name: /上传崩溃报告到 GitHub/,
    });
    expect(dialog).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /取\s*消/ }));

    spy.mockRestore();
  });

  it("renders children when no error", () => {
    render(
      <ErrorBoundary>
        <ThrowingChild shouldThrow={false} />
      </ErrorBoundary>
    );
    expect(screen.getByText("ok")).toBeInTheDocument();
  });
});
