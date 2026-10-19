// 只用于独立 performance Vite 构建，不修改已安装依赖或 Tauri 只读内部对象。
export function instrumentDesktopInvoke(source) {
  const signature = "async function invoke(cmd, args = {}, options) {";
  if (source.split(signature).length !== 2) {
    throw new Error("真实 Tauri API invoke 必须恰好匹配一次；拒绝遗漏 IPC 观测的构建");
  }
  return source.replace(signature, `${signature}
    const metrics = globalThis.__desktopMetrics;
    if (!metrics) throw new Error("隔离入口未初始化 IPC 观测，拒绝调用");
    metrics.commands[cmd] = (metrics.commands[cmd] ?? 0) + 1;`);
}
