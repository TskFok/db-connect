import { describe, expect, it, vi, afterEach } from "vitest";
import {
  buildCrashIssueTitle,
  buildCrashReportBody,
  getConfiguredGithubRepoFull,
  parseGithubOwnerRepo,
  truncateIssueTitle,
} from "../utils/crashReport";

describe("parseGithubOwnerRepo", () => {
  it("parses owner/repo", () => {
    expect(parseGithubOwnerRepo("TskFok/db-connect")).toEqual({
      owner: "TskFok",
      repo: "db-connect",
    });
  });

  it("trims slashes", () => {
    expect(parseGithubOwnerRepo("/o/r/")).toEqual({ owner: "o", repo: "r" });
  });

  it("returns null for invalid", () => {
    expect(parseGithubOwnerRepo("only-one")).toBeNull();
    expect(parseGithubOwnerRepo("")).toBeNull();
  });
});

describe("getConfiguredGithubRepoFull", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns default when env unset", () => {
    expect(getConfiguredGithubRepoFull()).toBe("TskFok/db-connect");
  });

  it("prefers VITE_GITHUB_ISSUE_REPO when set", () => {
    vi.stubEnv("VITE_GITHUB_ISSUE_REPO", "acme/my-fork");
    expect(getConfiguredGithubRepoFull()).toBe("acme/my-fork");
  });

  it("trims slashes in env value", () => {
    vi.stubEnv("VITE_GITHUB_ISSUE_REPO", "/org/repo/");
    expect(getConfiguredGithubRepoFull()).toBe("org/repo");
  });
});

describe("truncateIssueTitle", () => {
  it("leaves short titles unchanged", () => {
    expect(truncateIssueTitle("hello")).toBe("hello");
  });

  it("truncates long titles with ellipsis", () => {
    const long = "a".repeat(250);
    const out = truncateIssueTitle(long, 200);
    expect(out.length).toBe(200);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("buildCrashIssueTitle", () => {
  it("includes version prefix and truncates", () => {
    const t = buildCrashIssueTitle("TypeError", "x".repeat(200), "0.1.0");
    expect(t.startsWith("[Crash] v0.1.0 TypeError:")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(200);
  });

  it("redacts internal identifiers learned from legacy breadcrumbs", () => {
    const breadcrumbs = {
      schema_version: 1,
      last_updated_at: "2026-09-21T00:00:00.000Z",
      last_active_view: {
        view: "table-content",
        details: {
          connection: "Acme Production",
          database: "customer_private",
          table: "secret_orders",
        },
        captured_at: "2026-09-21T00:00:00.000Z",
      },
    };

    const title = buildCrashIssueTitle(
      "QueryError",
      "Acme Production/customer_private/secret_orders failed",
      "0.1.0",
      breadcrumbs
    );

    expect(title).not.toContain("Acme Production");
    expect(title).not.toContain("customer_private");
    expect(title).not.toContain("secret_orders");
    expect(title).toContain("[REDACTED]");
  });
});

describe("buildCrashReportBody", () => {
  it("builds markdown sections", () => {
    const body = buildCrashReportBody({
      appVersion: "0.1.0",
      errorName: "TypeError",
      errorMessage: "hello",
      stack: "at foo\nat bar",
      componentStack: "in Buzz",
      breadcrumbs: {
        schema_version: 1,
        last_updated_at: "t",
      },
    });
    expect(body).toContain("## 摘要");
    expect(body).toContain("## 环境");
    expect(body).toContain("`TypeError`");
    expect(body).toContain("hello");
    expect(body).toContain("at foo");
    expect(body).toContain("React 组件栈");
    expect(body).toContain("诊断面包屑");
    expect(body).toContain('"schema_version": 1');
  });

  it("omits optional sections when missing", () => {
    const body = buildCrashReportBody({
      appVersion: "0.1.0",
      errorName: "Error",
      errorMessage: "n",
    });
    expect(body).not.toContain("Stack trace");
    expect(body).not.toContain("React 组件栈");
  });

  it("only includes safe diagnostics from legacy breadcrumbs", () => {
    const body = buildCrashReportBody({
      appVersion: "0.1.0",
      errorName: "QueryError",
      errorMessage:
        "Acme Production/customer_private/secret_orders query failed",
      stack:
        "QueryError: Acme Production/customer_private/secret_orders query failed\n    at executeQuery (query.ts:42:7)",
      breadcrumbs: {
        schema_version: 1,
        last_updated_at: "2026-09-21T00:00:00.000Z",
        runtime: {
          os_name: "macos",
          os_version: "15.0",
          webkit_version: "619.1",
          arch: "aarch64",
          platform: "MacIntel",
          user_agent: "test-agent",
          captured_at: "2026-09-21T00:00:00.000Z",
        },
        last_active_view: {
          view: "table-content",
          details: {
            connection: "Acme Production",
            database: "customer_private",
            table: "secret_orders",
            tab_id: "tab-internal-42",
            label_id: "finance-label-9",
          },
          captured_at: "2026-09-21T00:00:00.000Z",
        },
        last_copy_action: {
          source: "table-data-copy-json",
          status: "failed",
          details: {
            database: "customer_private",
            table: "secret_orders",
            selected_label: "finance-label-9",
          },
          error: "copy failed for customer_private.secret_orders",
          captured_at: "2026-09-21T00:00:00.000Z",
        },
      },
    });

    expect(body).not.toContain("Acme Production");
    expect(body).not.toContain("customer_private");
    expect(body).not.toContain("secret_orders");
    expect(body).not.toContain("tab-internal-42");
    expect(body).not.toContain("finance-label-9");
    expect(body).not.toContain('"details"');
    expect(body).not.toContain('"error"');
    expect(body).toContain('"os_name": "macos"');
    expect(body).toContain('"view": "table-content"');
    expect(body).toContain('"source": "table-data-copy-json"');
    expect(body).toContain('"status": "failed"');
    expect(body).toContain("at executeQuery (query.ts:42:7)");
  });
});
