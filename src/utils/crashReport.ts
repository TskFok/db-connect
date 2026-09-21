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

const INTERNAL_CONTEXT_KEY =
  /connection|database|schema|table|column|tab|label|(?:^|_)id(?:_|$)|name/i;

function getKnownInternalValues(
  breadcrumbs?: BreadcrumbEntry | null
): string[] {
  if (!breadcrumbs) return [];
  const detailGroups = [
    breadcrumbs.last_active_view?.details,
    breadcrumbs.last_copy_action?.details,
  ];
  const values = new Set<string>();

  for (const details of detailGroups) {
    if (!details) continue;
    for (const [key, rawValue] of Object.entries(details)) {
      if (!INTERNAL_CONTEXT_KEY.test(key)) continue;
      const value = String(rawValue).trim();
      // 极短值（如表别名 "t"）无法安全地在普通错误文本中全局替换。
      if (value.length >= 3) values.add(value);
    }
  }

  return [...values].sort((a, b) => b.length - a.length);
}

function redactKnownInternalValues(
  text: string,
  breadcrumbs?: BreadcrumbEntry | null
): string {
  return getKnownInternalValues(breadcrumbs).reduce(
    (result, value) => result.split(value).join("[REDACTED]"),
    text
  );
}

/**
 * 崩溃面包屑来自 localStorage，可能包含旧版本保存的自由文本。
 * 外发时仅挑选稳定的诊断字段，绝不直接序列化原对象。
 */
function buildSafeBreadcrumbs(breadcrumbs: BreadcrumbEntry): BreadcrumbEntry {
  const safe: BreadcrumbEntry = {
    schema_version: breadcrumbs.schema_version,
    last_updated_at: breadcrumbs.last_updated_at,
  };

  if (breadcrumbs.runtime) {
    safe.runtime = {
      os_name: breadcrumbs.runtime.os_name,
      os_version: breadcrumbs.runtime.os_version,
      webkit_version: breadcrumbs.runtime.webkit_version,
      arch: breadcrumbs.runtime.arch,
      platform: breadcrumbs.runtime.platform,
      user_agent: breadcrumbs.runtime.user_agent,
      captured_at: breadcrumbs.runtime.captured_at,
    };
  }

  if (breadcrumbs.last_active_view) {
    safe.last_active_view = {
      view: breadcrumbs.last_active_view.view,
      captured_at: breadcrumbs.last_active_view.captured_at,
    };
  }

  if (breadcrumbs.last_copy_action) {
    safe.last_copy_action = {
      source: breadcrumbs.last_copy_action.source,
      status: breadcrumbs.last_copy_action.status,
      captured_at: breadcrumbs.last_copy_action.captured_at,
    };
  }

  return safe;
}

/**
 * 生成符合 GitHub Issue 规范的崩溃报告正文（Markdown）
 */
export function buildCrashReportBody(input: CrashReportBuildInput): string {
  const redact = (text: string) =>
    redactKnownInternalValues(text, input.breadcrumbs);
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
    `- **消息**: ${redact(input.errorMessage)}`,
    "",
  ];

  if (input.stack?.trim()) {
    lines.push(
      "### Stack trace",
      "",
      "```",
      redact(input.stack.trim()),
      "```",
      ""
    );
  }

  if (input.componentStack?.trim()) {
    lines.push(
      "### React 组件栈",
      "",
      "```",
      redact(input.componentStack.trim()),
      "```",
      ""
    );
  }

  if (input.breadcrumbs) {
    lines.push(
      "### 诊断面包屑（本地）",
      "",
      "```json",
      JSON.stringify(buildSafeBreadcrumbs(input.breadcrumbs), null, 2),
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
  appVersion: string,
  breadcrumbs?: BreadcrumbEntry | null
): string {
  const redactedMessage = redactKnownInternalValues(errorMessage, breadcrumbs);
  const msg =
    redactedMessage.length > 120
      ? `${redactedMessage.slice(0, 119)}…`
      : redactedMessage;
  return truncateIssueTitle(`[Crash] v${appVersion} ${errorName}: ${msg}`);
}
