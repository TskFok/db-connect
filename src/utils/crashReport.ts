import type { BreadcrumbEntry } from "./crashBreadcrumbs";

/** 构建时可被 VITE_GITHUB_ISSUE_REPO 覆盖（格式 owner/repo） */
const DEFAULT_GITHUB_REPO = "TskFok/db-connect";

export function getConfiguredGithubRepoFull(): string {
  const fromEnv = import.meta.env.VITE_GITHUB_ISSUE_REPO;
  if (typeof fromEnv === "string" && fromEnv.includes("/")) {
    return fromEnv.trim().replace(/^\/+|\/+$/g, "");
  }
  return DEFAULT_GITHUB_REPO;
}

export function parseGithubOwnerRepo(
  full: string
): { owner: string; repo: string } | null {
  const s = full.trim().replace(/^\/+|\/+$/g, "");
  const parts = s.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  return { owner: parts[0], repo: parts[1] };
}

export function truncateIssueTitle(title: string, maxLen = 200): string {
  const t = title.replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 1)}…`;
}

export interface CrashReportBuildInput {
  appVersion: string;
  errorName: string;
  errorMessage: string;
  stack?: string | null;
  componentStack?: string | null;
  breadcrumbs?: BreadcrumbEntry | null;
}

/**
 * 生成符合 GitHub Issue 规范的崩溃报告正文（Markdown）
 */
export function buildCrashReportBody(input: CrashReportBuildInput): string {
  const lines: string[] = [
    "## 摘要",
    "",
    "此 Issue 由 **DB Connect** 客户端崩溃上报功能自动提交。",
    "",
    "## 环境",
    "",
    `- **应用版本**: ${input.appVersion}`,
    `- **User-Agent**: ${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`,
    `- **平台**: ${typeof navigator !== "undefined" ? navigator.platform || "unknown" : "unknown"}`,
    "",
    "## 错误",
    "",
    `- **类型**: \`${input.errorName}\``,
    `- **消息**: ${input.errorMessage}`,
    "",
  ];

  if (input.stack?.trim()) {
    lines.push("### Stack trace", "", "```", input.stack.trim(), "```", "");
  }

  if (input.componentStack?.trim()) {
    lines.push(
      "### React 组件栈",
      "",
      "```",
      input.componentStack.trim(),
      "```",
      ""
    );
  }

  if (input.breadcrumbs) {
    lines.push(
      "### 诊断面包屑（本地）",
      "",
      "```json",
      JSON.stringify(input.breadcrumbs, null, 2),
      "```",
      ""
    );
  }

  lines.push("---", "", "## 补充说明", "", "（可在此继续描述复现步骤）", "");

  return lines.join("\n");
}

export function buildCrashIssueTitle(
  errorName: string,
  errorMessage: string,
  appVersion: string
): string {
  const msg =
    errorMessage.length > 120
      ? `${errorMessage.slice(0, 119)}…`
      : errorMessage;
  return truncateIssueTitle(`[Crash] v${appVersion} ${errorName}: ${msg}`);
}
