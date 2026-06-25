import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(),
}));

import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  copyTextWithBreadcrumb,
  getCrashBreadcrumbs,
  isSensitiveBreadcrumbKey,
  setActiveViewBreadcrumb,
  setRuntimeInfoBreadcrumb,
} from "../utils/crashBreadcrumbs";

const mockedWriteText = vi.mocked(writeText);

describe("crashBreadcrumbs", () => {
  beforeEach(() => {
    localStorage.clear();
    mockedWriteText.mockReset();
  });

  it("识别敏感键名", () => {
    expect(isSensitiveBreadcrumbKey("password")).toBe(true);
    expect(isSensitiveBreadcrumbKey("db_password")).toBe(true);
    expect(isSensitiveBreadcrumbKey("api_key")).toBe(true);
    expect(isSensitiveBreadcrumbKey("github_token")).toBe(true);
    expect(isSensitiveBreadcrumbKey("database")).toBe(false);
    expect(isSensitiveBreadcrumbKey("table")).toBe(false);
  });

  it("持久化最后活跃页面", () => {
    setActiveViewBreadcrumb("table-content", {
      database: "myapp",
      table: "users",
      tab: "data",
    });

    expect(getCrashBreadcrumbs()).toEqual(
      expect.objectContaining({
        schema_version: 1,
        last_active_view: expect.objectContaining({
          view: "table-content",
          details: {
            database: "myapp",
            table: "users",
            tab: "data",
          },
        }),
      })
    );
  });

  it("敏感 details 字段写入前脱敏", () => {
    setActiveViewBreadcrumb("connection-form", {
      host: "db.example.com",
      password: "real-secret",
      api_key: "sk-should-not-appear",
    });

    expect(getCrashBreadcrumbs()?.last_active_view?.details).toEqual({
      host: "db.example.com",
      password: "[REDACTED]",
      api_key: "[REDACTED]",
    });
  });

  it("持久化运行时信息", () => {
    setRuntimeInfoBreadcrumb({
      os_name: "macOS",
      os_version: "26.1",
      webkit_version: "21622.2.11.11.9",
      arch: "aarch64",
    });

    expect(getCrashBreadcrumbs()).toEqual(
      expect.objectContaining({
        runtime: expect.objectContaining({
          os_name: "macOS",
          os_version: "26.1",
          webkit_version: "21622.2.11.11.9",
          arch: "aarch64",
        }),
      })
    );
  });

  it("复制前先记录 attempted，成功后更新为 succeeded", async () => {
    mockedWriteText.mockImplementation(async () => {
      expect(getCrashBreadcrumbs()?.last_copy_action?.status).toBe("attempted");
    });

    await copyTextWithBreadcrumb("CREATE TABLE users (...)", "create-table-sql", {
      database: "myapp",
      table: "users",
    });

    expect(mockedWriteText).toHaveBeenCalledWith("CREATE TABLE users (...)");
    expect(getCrashBreadcrumbs()).toEqual(
      expect.objectContaining({
        last_copy_action: expect.objectContaining({
          source: "create-table-sql",
          status: "succeeded",
          details: {
            database: "myapp",
            table: "users",
          },
        }),
      })
    );
  });

  it("复制失败时记录 failed 和错误信息", async () => {
    mockedWriteText.mockRejectedValue(new Error("clipboard unavailable"));

    await expect(
      copyTextWithBreadcrumb("SELECT 1", "sql-editor", { database: "myapp" })
    ).rejects.toThrow("clipboard unavailable");

    expect(getCrashBreadcrumbs()).toEqual(
      expect.objectContaining({
        last_copy_action: expect.objectContaining({
          source: "sql-editor",
          status: "failed",
          error: "clipboard unavailable",
          details: {
            database: "myapp",
          },
        }),
      })
    );
  });
});
