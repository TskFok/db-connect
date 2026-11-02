# SSH 错误详情与主机密钥缓存清理实施计划

**目标：** SSH 建连失败时展示具体原因，支持用户清除当前服务器在应用中的主机密钥缓存后重新连接。

**需求来源：** 本次用户请求；已确认 macOS SSH 主机密钥冲突被统一显示为退出码 255。

**设计：** 沿用 Rust/Tokio + React/Ant Design。后台持续读取有长度上限的 OpenSSH stderr，失败时返回中文说明和原始详情；界面保留换行。清理接口仅接受 SSH 主机与端口，操作应用自己的 known_hosts；macOS/Linux 用 OpenSSH 工具处理普通及散列记录，Windows 清理现有 JSON 对应条目。

**约束：** 当前分支修改；不删除私钥、不操作终端 known_hosts、不自动绕过主机校验；无新增依赖、无真实数据库测试；不提交或发布。

## 任务与接口

- [x] 错误捕获：修改 `src-tauri/src/db/ssh_tunnel/openssh_tunnel.rs`，覆盖退出码 255、无 stderr、主机密钥冲突、长输出及清理行为。
- [x] 缓存清理：新增 `src-tauri/src/db/ssh_tunnel/known_hosts.rs`，提供 `clear_ssh_known_host(host: String, port: u16) -> Result<bool, String>` Tauri 命令；`true` 表示存在并清除了对应记录，`false` 表示无缓存。校验主机、端口；覆盖无文件、普通/散列主机、非默认端口和其他主机记录保留。
- [x] 界面：`SshTunnelFields` 增加带确认的清理按钮，通过 `invoke<boolean>("clear_ssh_known_host", { host, port })` 调用；展示成功、无缓存和失败反馈；`ConnectionForm` 与全局连接错误完整呈现多行失败详情。覆盖取消、确认时的目标参数、失败反馈。
- [x] 验证：各任务先写失败测试，再实现并运行定向测试；最后执行前端测试、构建、Rust 测试及独立代码审查。

## 审查重点

错误输出不会无限积累或阻塞 SSH；失败/超时不遗留子进程；清理不会影响其他主机、端口或私钥；界面清理使用当前确认的主机；清理后仍维持主机身份校验。

审查修复：普通多主机列表拆行后清理，匹配通配符/否定规则时拒绝修改；握手写缓存与清理共用锁；SSH 建连失败不触发另一活跃数据库连接的断线清理。相关回归均先失败再通过，独立复核无剩余阻断。

## 最终验证

- `npm test`：172 个文件、2265 项测试通过；安全预检 11 项通过。
- `cargo test --manifest-path src-tauri/Cargo.toml`：927 项通过、111 项忽略，文档测试通过。
- `npm run build`：通过；保留现有大体积 chunk 提示。
- 修改的前端文件 ESLint、SSH Rust 文件 rustfmt、`git diff --check`：通过。
- 本机 macOS 验证；Windows JSON 清理逻辑有跨平台单测，未运行 Windows 原生构建。
