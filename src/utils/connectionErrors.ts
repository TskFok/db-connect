/**
 * 连接级错误识别工具
 *
 * 当 MySQL 连接（直连或 SSH 隧道）被对端 / 中间设备 / 系统休眠掐断后，
 * 后续的 `pool.get_conn()` / 查询会以下面这些典型 IO 错误形态返回：
 * - `Connection refused (os error 61)`（SSH 隧道本地监听端口已死）
 * - `Input/output error`（驱动层的复合 IO 错误）
 * - `Broken pipe (os error 32)`（写入半关闭的 socket）
 * - `connection closed`（驱动观察到 TCP 关闭）
 * - `Connection reset by peer (os error 54)`（对端 RST）
 * - `getaddrinfo / Name or service not known`（DNS / 网络栈尚未恢复）
 * - `unexpected end of file`（TLS 半路掉线）
 *
 * 命中以上模式时，应认为该连接已死、前端需要把连接从活跃列表中清理掉，
 * 而不是把错误抛给用户、要求其手动关闭页面再重连。
 */

const CONNECTION_LOST_PATTERNS: RegExp[] = [
  /connection refused/i,
  /input\/output error/i,
  /broken pipe/i,
  /connection closed/i,
  /connection reset/i,
  /unexpected end of file/i,
  /name or service not known/i,
  /no route to host/i,
  /host is down/i,
  /network is unreachable/i,
  /tls handshake/i,
  // 后端封装的中文错误：`获取连接失败: ...` 通常出现在连接已死的场景
  /获取连接失败/,
];

/**
 * 判断错误消息是否表示"连接已死、需要客户端重建"。
 * 接受任意 unknown，内部转 string 后做正则匹配，便于直接处理 invoke 抛出的字符串错误。
 */
export function isConnectionLostError(err: unknown): boolean {
  if (err == null) return false;
  const msg = typeof err === "string" ? err : (err as { message?: unknown })?.message;
  const text = typeof msg === "string" && msg.length > 0 ? msg : String(err);
  if (!text) return false;
  return CONNECTION_LOST_PATTERNS.some((p) => p.test(text));
}
