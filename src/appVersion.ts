/** 由 Vite / Vitest 的 define 注入；未注入时与 package.json 默认版本对齐 */
declare const __APP_VERSION__: string | undefined;

export function getAppVersion(): string {
  return typeof __APP_VERSION__ === "string" && __APP_VERSION__.length > 0
    ? __APP_VERSION__
    : "1.0.4";
}
