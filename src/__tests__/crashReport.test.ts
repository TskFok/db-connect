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
});
