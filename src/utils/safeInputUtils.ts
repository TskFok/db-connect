/**
 * 将 macOS 智能引号（弯引号）还原为直引号，
 * 防止连续输入 "" 时第一个 " 被系统替换为 \u201C。
 */
export function sanitizeQuotes(value: string): string {
  return value.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
}
