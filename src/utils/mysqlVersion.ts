/**
 * 基于 `SELECT @@version` / `VERSION()` 常见返回串，判断是否可能支持 `EXPLAIN ANALYZE`。
 * - MySQL：8.0.18+（近似）
 * - MariaDB：10.7+（近似）
 * 无法识别时返回 true，由执行时报错兜底。
 */
export function supportsExplainAnalyze(versionStr: string): boolean {
  const v = versionStr.trim();
  if (!v) return true;

  /** 「MariaDB-1.2.3」或「10.6-MariaDB-log」等常见 @@version 形式 */
  let mariaVer: string | null = null;
  const mariaAfterKeyword = v.match(/(?:mariadb|MariaDB)[\s-]+([\d.]+)/i);
  if (mariaAfterKeyword) {
    mariaVer = mariaAfterKeyword[1];
  } else if (/mariadb/i.test(v)) {
    const lead = v.match(/^([\d.]+)/);
    if (lead) mariaVer = lead[1];
  }
  if (mariaVer) {
    return compareDottedVersion(mariaVer, "10.7.0") >= 0;
  }

  const lead = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (lead) {
    const major = Number(lead[1]);
    const minor = Number(lead[2]);
    const patch = Number(lead[3]);
    if (major < 8) return false;
    if (major === 8 && minor === 0 && patch < 18) return false;
    return true;
  }

  return true;
}

/** &lt;0: a&lt;b, 0: eq, &gt;0: a&gt;b */
export function compareDottedVersion(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}
