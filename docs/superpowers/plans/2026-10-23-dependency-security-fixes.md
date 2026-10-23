# 依赖漏洞修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-10-22 审计发现的 npm、Tauri/Rust 及内嵌依赖漏洞，保留现有数据库功能。

**Architecture:** 采用上游安全发行版优先、精确范围的依赖升级；上游兼容版本缺失时回补官方安全修复并保留来源及验证。前端和后端独立推进，最终统一检查依赖图、内嵌副本、构建与测试。

**Tech Stack:** React、Vite、Vitest、Tauri 2、Rust、Cargo、npm。

**Spec:** 本聊天中已说明的漏洞清单与修复方案；用户于 2026-10-23 明确要求执行。

## Global Constraints

- 使用当前 master 分支，不创建新分支，不提交或推送。
- 保留数据库、SSH、SQL 编辑器、图表和导出功能，不以禁用现有功能代替修复。
- 不在循环中查询 SQL；不上传项目依赖清单到在线审计接口。
- npm 安装禁用自动 audit；漏洞库下载后本地比对。
- 不通过新增忽略规则掩盖漏洞；本地回补仍匹配版本公告时记录证据。
- 根代理负责整合与审查；每个实施代理仅修改分配范围，Cargo 清单和锁文件由同一代理管理。

## Review Focus

- Monaco 清洗补丁必须覆盖正式打包入口，保持独立 DOMPurify 实例，防止与 Mermaid 的 hooks 相互污染。
- Mermaid/KaTeX 更新后合法图表和公式继续渲染，恶意 HTML 不执行。
- Windows SSH 密码/密钥认证、主机密钥验证、隧道和关闭行为不退化。
- macOS SQL Server TLS 的系统信任、自签证书配置和异步 I/O 语义保持。
- 本地回补的 Linux glib 与上游 GTK ABI 保持兼容，重新安装依赖后修复仍存在。

## Task 1: npm 与内嵌依赖

- [x] 升级 Vite、Vitest、DOMPurify、brace-expansion、source-map-js 与 KaTeX，验证所有锁定副本。
- [x] 为 Monaco 内嵌 DOMPurify 提供可复现的修复，并增加实际清洗行为的回归测试。
- [x] 验证 Mermaid/KaTeX 兼容性、编辑器测试、前端构建和 npm 公告库本地比对。

## Task 2: Tauri、SSH 与现代 TLS

- [x] 调整 Tauri 精确测试依赖，升级 Tauri 和 fs 插件。
- [x] 升级 russh/pageant，适配 Windows SSH API 并检查目标平台编译。
- [x] 更新 rustls 0.23、webpki、根证书、anyhow、event-listener、lru、quinn-proto 和可兼容升级的 XML 消费者。
- [x] 验证 Cargo 图、默认功能及锁文件中剩余公告。

## Task 3: 旧版 TLS 与 Linux 依赖

- [x] 确认 Tiberius 上游路线；必要时维护最小本地补丁以迁移旧 TLS 链，并增加 TLS 配置/握手回归验证。
- [x] 对 glib 无兼容发行版的问题回补官方修复，记录来源、许可证及验证方法。
- [x] 整合路径补丁，确认旧漏洞链被移除或已有明确修复证据。

## Task 4: 集成验证与交付

- [x] 运行相关回归测试、完整前端测试与构建、Rust 测试和 clippy；平台受限验证明确标注。
- [x] 使用最新公开公告库再次审计，并核对内嵌代码与实际构建产物。
- [x] 由独立代理审查最终改动，修复重要发现。
- [x] 交付改动说明、验证结果和确实无法消除的剩余项。

## 实施结果（2026-10-23）

| 范围 | 最终处理 |
| --- | --- |
| npm | Vite 8.3.5、Vitest / mocker 4.1.12、DOMPurify 3.4.17、brace-expansion 5.0.12、source-map-js 1.2.2、KaTeX 0.18.2 |
| Monaco | 保持 0.55.1；对实际使用的 ESM 内嵌 DOMPurify 应用可重装的源码替换，校验版本和原始 SHA，保持独立实例；说明见 `scripts/security/README.md` |
| Tauri / SSH | Tauri 2.11.6、fs 2.5.2、russh 0.64.1、pageant 0.2.4；适配主机公钥接口并保留 RSA 功能 |
| Rust 传递依赖 | rustls 0.23.46、rustls-webpki 0.103.16、webpki-roots 1.0.10、anyhow 1.0.104、event-listener 5.4.2、lru 0.18.5、quinn-proto 0.11.19；quick-xml 0.39 已移除，保留 0.41 / 0.42 |
| SQL Server TLS | 最小回补 Tiberius 0.12.3 到现代 TLS，移除 rustls 0.21 / webpki 0.101 旧链；保留系统根、仅指定 CA、主机名及显式 trust_cert 策略；来源见 `src-tauri/vendor/tiberius/PATCHES.md` |
| Linux glib | 保持 GTK3 兼容的 0.18.5，回补官方 #1343 的两行 FFI 修复；来源见 `src-tauri/vendor/glib/DB_CONNECT_PATCH.md` |

Tiberius 官方 0.13 已更新 TLS，但当前 bb8-tiberius 只接受 0.12，且 0.13 改变自定义 CA 的信任范围，因此采用最小回补。没有新增审计忽略规则，并移除了原 RSA 忽略项。

### 复查与剩余项

- 下载完整 GitHub 公告库后本地比对全部锁定包：npm 518 项记录无命中；Rust 735 项仅命中已回补的 glib 版本，解析错误为 0。下载日期为 2026-10-23，归档 SHA-256：`71f664d27acd3722d8a8f231cc7f372fe0a7a8208128ef159a57f6cfb44cdfc8`。
- RustSec 数据库 commit `c244ff02630e2e4e1eb69e01914b14a37dad7cbb`，本地扫描仍有 1 条正式漏洞：[rsa / RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)。上游明确 `rsa 0.10.0-rc.18` 仍无修复；为保留 Windows SSH 的 RSA 登录能力，没有删除该 feature。此为依赖命中，不等同于已证明应用存在可利用路径。
- glib / RUSTSEC-2024-0429 因仍使用 0.18.5 包版本被标记为 unsound；实际源码已回补，release 回归从 SIGSEGV 转为通过。未伪造版本或增加 ignore。
- 另有 11 条停止维护提示：paste、proc-macro-error、rustls-pemfile、5 个 unic 包、zbus_names、zvariant、zvariant_derive。它们未被冒充为已修复，也不计入正式漏洞数量。
- 公告扫描的“无命中”仅适用于本次公开数据库快照和已核对的实际 ESM 产物，不代表不存在未知漏洞。Monaco / Mermaid 包中未使用的预打包副本不属于应用入口，未作替换。

### 验证证据

- `npm ci --offline --no-audit`：重装后补丁自动生效。
- `npm test`：171 个文件、2233 项通过；`npm run test:security`：11 项通过。原内嵌清洗器曾在真实清洗用例中失败，替换后通过。
- `npm run build`、直接 Vite build、`npm run lint`：通过。正式产物确认 Monaco / Mermaid 的 DOMPurify 为 3.4.17，KaTeX 为 0.18.2。
- 最终 Tiberius 调整后重新执行 `cargo test --manifest-path src-tauri/Cargo.toml --locked --offline`：908 项通过、0 失败、111 项忽略；`cargo clippy --all-targets --locked --offline -- -D warnings`、`cargo fmt --all --check` 通过。
- Tiberius 库：rustls 130 项、native-tls 117 项通过，含 13 项新增真实内存 TLS 回归。按 `git ls-files --cached --others --exclude-standard` 复制可交付文件后，干净副本的 rustls 130 项再次全部通过。
- glib：release 模式回补前 SIGSEGV，回补后通过；仅测试 debug 模式不足以证明该问题已修复。
- Windows SSH 真实源码在本机独立 harness 编译，5 项测试覆盖密码 / RSA 登录、通道数据、关闭监听、主机密钥变化拒绝。Windows GNU 目标检查受本机缺少 MinGW 编译器限制；没有声称完成 Windows 目标编译。
- 尚未执行真实 SQL Server 服务端的 TDS 协商和登录测试；本次验证覆盖库的 TLS 握手和流行为。原有 111 个忽略测试没有被计作通过。

所有改动保留在当前 master 工作区，未提交、未推送。

独立审查确认当前快照可交付，无未解决的重要问题。审查发现 TLS 公共 CA 测试夹具被全局忽略，已在 vendor/tiberius/.gitignore 仅为两个夹具增加例外，并用实际可交付文件的干净副本重新验证。
