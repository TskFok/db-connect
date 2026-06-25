import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { RuntimeInfo } from "../types";

const STORAGE_KEY = "db-connect-crash-breadcrumbs";
const SCHEMA_VERSION = 1;

/** 面包屑 details 中需脱敏的键名（password、token、secret 等） */
const SENSITIVE_DETAIL_KEY =
  /(?:^|_)(?:pass(?:word)?|pwd|token|secret|credential|api[_-]?key|private[_-]?key|auth(?:orization)?)(?:_|$)/i;

export interface BreadcrumbEntry {
  schema_version: number;
  last_updated_at: string;
  runtime?: RuntimeBreadcrumb;
  last_active_view?: ActiveViewBreadcrumb;
  last_copy_action?: CopyActionBreadcrumb;
}

export interface RuntimeBreadcrumb extends RuntimeInfo {
  platform: string;
  user_agent: string;
  captured_at: string;
}

export interface ActiveViewBreadcrumb {
  view: string;
  details?: Record<string, string>;
  captured_at: string;
}

export interface CopyActionBreadcrumb {
  source: string;
  status: "attempted" | "succeeded" | "failed";
  details?: Record<string, string>;
  error?: string;
  captured_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function isSensitiveBreadcrumbKey(key: string): boolean {
  return SENSITIVE_DETAIL_KEY.test(key);
}

function sanitizeDetails(
  details?: Record<string, unknown>
): Record<string, string> | undefined {
  if (!details) return undefined;
  const entries = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) =>
      isSensitiveBreadcrumbKey(key)
        ? ([key, "[REDACTED]"] as const)
        : ([key, String(value)] as const)
    );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function getCrashBreadcrumbs(): BreadcrumbEntry | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BreadcrumbEntry;
  } catch {
    return null;
  }
}

function saveCrashBreadcrumbs(patch: Partial<BreadcrumbEntry>) {
  if (typeof localStorage === "undefined") return;
  const current = getCrashBreadcrumbs();
  const next: BreadcrumbEntry = {
    ...(current ?? {}),
    ...patch,
    schema_version: SCHEMA_VERSION,
    last_updated_at: nowIso(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

export function logStoredCrashBreadcrumbs() {
  const breadcrumbs = getCrashBreadcrumbs();
  if (breadcrumbs) {
    console.info("[crash-breadcrumbs]", breadcrumbs);
  }
}

export function setRuntimeInfoBreadcrumb(runtimeInfo: RuntimeInfo) {
  saveCrashBreadcrumbs({
    runtime: {
      ...runtimeInfo,
      platform: typeof navigator !== "undefined" ? navigator.platform || "unknown" : "unknown",
      user_agent:
        typeof navigator !== "undefined" ? navigator.userAgent || "unknown" : "unknown",
      captured_at: nowIso(),
    },
  });
}

export function setActiveViewBreadcrumb(
  view: string,
  details?: Record<string, unknown>
) {
  saveCrashBreadcrumbs({
    last_active_view: {
      view,
      details: sanitizeDetails(details),
      captured_at: nowIso(),
    },
  });
}

function recordCopyAction(
  source: string,
  status: CopyActionBreadcrumb["status"],
  details?: Record<string, unknown>,
  error?: string
) {
  saveCrashBreadcrumbs({
    last_copy_action: {
      source,
      status,
      details: sanitizeDetails(details),
      error,
      captured_at: nowIso(),
    },
  });
}

export async function copyTextWithBreadcrumb(
  text: string,
  source: string,
  details?: Record<string, unknown>
) {
  recordCopyAction(source, "attempted", details);
  try {
    await writeText(text);
    recordCopyAction(source, "succeeded", details);
  } catch (error) {
    recordCopyAction(
      source,
      "failed",
      details,
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}
