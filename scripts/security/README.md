# 依赖安全说明

## Monaco 内嵌 DOMPurify

Monaco Editor 0.55.1 的 ESM 入口内嵌 DOMPurify 3.2.7，`npm overrides` 无法更新这份源码。`patch-monaco-dompurify.mjs` 将该文件替换为直接依赖 `dompurify@3.4.17` 的官方 `dist/purify.es.mjs`，只移除失效的 source map 注释，保留许可证。

- 原始入口：`monaco-editor/esm/vs/base/browser/dompurify/dompurify.js`。
- 原始 SHA-256：`9b2835fc7de5bd37faff156e83bf060067577a1f09c6620d9f37d5fa5e5970b1`。
- 上游来源：[DOMPurify 3.4.17](https://github.com/cure53/DOMPurify/tree/3.4.17)。npm 下载完整性由 `package-lock.json` 记录。
- 版本与内容不符合已审查的契约时，脚本报错并停止，避免升级时悄悄失效。
- 整份 ESM 模块独立执行，Monaco 与 Mermaid 保持各自的 DOMPurify 实例，不共享配置或 hooks。
- `postinstall`、开发、构建和测试命令都会准备补丁；Vite 配置也导入该脚本，因此直接运行 Vite 仍会准备补丁。
- 应用使用 `src/utils/monacoSetup.ts` 的 ESM 导入；不加载 Monaco 包里的预打包 AMD/UMD 文件。后者未修改，不应作为应用的新入口使用。

升级 Monaco 或 DOMPurify 时，重新检查嵌入文件路径、导出 API、独立实例、官方公告与原始 SHA-256，更新脚本中的版本约束后重跑：

```sh
npm ci --no-audit
npm run test:security
npm test
npm run build
npm run lint
```

`sanitizers.node-test.mjs` 执行实际嵌入文件，验证 [GHSA-v2wj-7wpq-c8vv](https://github.com/cure53/DOMPurify/security/advisories/GHSA-v2wj-7wpq-c8vv) 的原始文本上下文逃逸、合法提示内容和 hooks 隔离。补丁前的 3.2.7 在五项逃逸用例上失败，替换后通过。原始文本上下文用例是清洗器安全回归，不能据此推断应用当前存在相同的插入方式。

## Mermaid 与 KaTeX

保留 Mermaid 10.9.8，对其 KaTeX 子依赖定向覆盖到 0.18.2。应用导入的是 `mermaid.core.mjs`，该入口动态导入 npm `katex`，不使用 Mermaid 发布包中另附的旧版 KaTeX 预打包副本。`mermaidSecurity.test.ts` 使用真实 Mermaid、KaTeX 和清洗器渲染关系图、公式及危险 HTML，仅为 jsdom 补齐 SVG 测量。

不通过 `npm audit` 上传依赖树；公告库比对在本地完成。内嵌副本必须额外检查，不能以锁文件没有命中项代替该检查。

## 2026-10-28 复查

本次在保留既有安全补丁和数据库功能的前提下更新以下依赖：

| 依赖 | 原版本 → 修复版本 | 公告与处理 |
| --- | --- | --- |
| Tauri CLI | 2.11.3 → 2.12.4 | [官方发布说明](https://github.com/tauri-apps/tauri/releases/tag/%40tauri-apps%2Fcli-v2.12.4)将内嵌 `zip` 升至 v9，修复 RUSTSEC-2026-0367、0368、0369；同步更新全部 11 个平台包。此依赖位于 CLI 原生二进制内，npm 和应用 Cargo 锁文件的扫描均无法覆盖。 |
| Zod | 4.4.3 → 4.6.7 | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)，修复下限 4.6.6。它由 ESLint React Hooks 插件引入，仅用于开发；通过 override 限制最低安全版本，符合现有使用方版本范围。 |
| crypto-bigint | 0.7.5 → 0.7.9 | [RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html)，修复常量时间运算中的时序问题；跳过已撤回的 0.7.6～0.7.8。 |
| ctutils | 0.4.2 → 0.4.5 | [RUSTSEC-2026-0385](https://rustsec.org/advisories/RUSTSEC-2026-0385.html)，修复掩码生成和 `u128` 比较的时序问题；同时满足新 crypto-bigint 的依赖下限。 |
| Tokio | 1.52.3 → 1.53.3 | [RUSTSEC-2026-0386](https://rustsec.org/advisories/RUSTSEC-2026-0386.html)，修复 `AsyncFd` 构造函数的 I/O 安全问题。 |
| chacha20 | 0.10.1 → 0.10.2 | 原版本因 SSE2 后端错误调用 SSE4.1 指令而存在未定义行为并被撤回；使用[官方修复版本](https://github.com/RustCrypto/stream-ciphers/releases/tag/chacha20-v0.10.2)，见[上游问题与修复](https://github.com/RustCrypto/stream-ciphers/pull/580)。 |
| clipboard-win | 5.4.1 → 5.4.2 | 替换已撤回版本；对比 [5.4.2 官方包](https://crates.io/crates/clipboard-win/5.4.2)源码确认 HTML 片段读取改为范围校验后复制，避免直接按外部偏移读取裸指针。 |

Tauri 应用库保持 2.11.6，已覆盖当前官方 IPC 公告。Monaco / Mermaid 的 DOMPurify 3.4.17 和 KaTeX 0.18.2 保持不变；重新安装后的补丁和实际构建产物均已核对。

### 审计范围与剩余项

- GitHub 公告库于 2026-10-28 下载，归档 SHA-256 为 `cfdb949e4e2af7dddf3b9f01febc9802e380b2e080789ad333de31ffeb50cf02`。本地读取 396268 条公告，对 npm 锁文件全部 518 条依赖记录逐项比较版本范围；修复后无命中、无 JSON 或版本范围解析错误。此结果不是在线 `npm audit` 报告，也不代表不存在未知漏洞。
- RustSec 数据库 commit 为 `99670cfc0bc574433034b75876a4b791ccaa2efb`（2026-10-27）。更新后上述三项公告均不再命中。
- 仍有 [rsa / RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)：上游暂无修复版本，Windows SSH 的 RSA 兼容功能仍需要该依赖。保留显式审计失败，不增加 ignore；依赖命中不等于已证明应用存在可利用路径。
- glib 0.18.5 仍按版本命中 [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)，实际源码已回补，见 `src-tauri/vendor/glib/DB_CONNECT_PATCH.md`。另有 11 条停止维护提示，未作为漏洞修复计数。
- 已撤回版本警告由 3 项降为 0 项；没有新增审计忽略规则。

### 本次验证

- `npm ci --no-audit --no-fund`：干净安装成功，Monaco 补丁自动生效。
- `npm test`：171 个文件、2241 项通过；其前置安全测试 11 项通过。`npm run test:tauri` 的 6 项测试通过。
- `npm run build`、`npm run lint` 通过；实际产物包含独立的 Monaco / Mermaid DOMPurify 3.4.17 与 KaTeX 0.18.2。
- Zod 超长集合验证：同一份 1000 元素输入在旧版生成 1001 条错误，更新后在遍历元素前返回单条 `too_big` 错误。
- 升级后的 Tauri CLI 完成 macOS `build --debug --no-bundle`，复用本次前端产物；未执行多平台安装包发布构建。
- 串行执行 `cargo test --locked --offline` 退出 0：908 项通过、111 项忽略，文档测试通过；忽略项不计作已通过。
- `cargo clippy --locked --offline --all-targets -- -D warnings` 与 Rust 格式检查通过。
- 直接引用 Windows SSH 源码的独立测试程序 12 项通过，覆盖新加密依赖组合的 RSA 密钥、签名验证和主机密钥行为；clipboard-win 在 Windows GNU 目标的独立编译检查通过。这些检查不等于完整 Windows 应用测试。
- glib 既有安全回归在 release 模式通过；Cargo metadata 确认三个 vendor 补丁仍实际生效。

## 2026-11-12 复查

### 修复内容

| 依赖 | 原版本 → 修复版本 | 公告与处理 |
| --- | --- | --- |
| minimatch | 10.2.5 → 11.0.8 | [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)：`optimizationLevel >= 2` 时 `**/..` 模式会产生大量中间模式并触发二次方处理。通过 override 更新所有副本；11.0.1 为公告修复下限，选用后续稳定修订版。新版本要求 Node 20 或 >=22，项目 CI 使用 Node 22。 |
| rusqlite / libsqlite3-sys | 0.38.0 / 0.36.0 → 0.41.1 / 0.39.1 | [RUSTSEC-2026-0459](https://rustsec.org/advisories/RUSTSEC-2026-0459.html)：内嵌 SQLite 更新至 3.54.1，修复恶意数据库 / WAL 页大小不一致导致的未初始化内存泄露。连接池使用仅调整依赖清单的本地适配，详见 `src-tauri/vendor/deadpool-sqlite/DB_CONNECT_PATCH.md`。应用适配列名迭代器与 hooks 的可变借用 API；Rust 最低版本要求提高至 1.89。 |
| rustix | 1.1.4 → 1.1.6 | [RUSTSEC-2026-0486](https://rustsec.org/advisories/RUSTSEC-2026-0486.html)：修复扩展属性接口处理零长度缓冲区时的未定义行为。 |
| async-executor | 1.14.0 → 1.14.1 | 替换已撤回版本；[官方修复](https://github.com/smol-rs/async-executor/pull/164)解决销毁 Executor 期间触发 Waker 导致的 use-after-free。 |

`minimatch.node-test.mjs` 使用实际安装的模块，验证攻击模式超过显式扩展上限时抛出异常，以及常规源码 / 归档路径仍可匹配。攻击用例在旧版失败、新版通过。此用例证明依赖缺陷已修复，不代表项目已被证明存在接收不可信 glob 模式的路径。

### 审计范围与剩余项

- GitHub 公告库于 2026-11-12 下载，归档 SHA-256：`ddc76d9b636f97269c211f673d290d2ba0383a3b88b6ecd896b0fe48387d43f7`。本地读取 404633 条公告，对 npm 锁文件更新后的全部 519 条依赖记录比较版本范围（包括 npm 的 ECOSYSTEM / SEMVER 事件范围），结果无命中、无 JSON / 版本范围解析错误。此结果是公开公告快照的本地比对，不是在线 `npm audit` 报告。
- RustSec 数据库 commit：`1f16cf92c0902aa9c08ad484d7e0998d11cb54c6`，加载 1458 条公告，扫描应用锁文件 735 个依赖。正式漏洞由 2 项降为 1 项，unsound 警告由 2 项降为 1 项，已撤回版本由 1 项降为 0 项。没有新增 ignore。
- 应用仍命中 [RSA / RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)。RSA 已于 2026-11-08 发布修复版 0.10.0，旧记录中“暂无修复版本”的结论已过时。但当前 russh 0.64.1 及官方最新 0.65.1 均精确依赖 `rsa =0.10.0-rc.18`；它们锁定的 ssh-key 0.7.0-rc.11 还启用了 RSA 稳定版已移除的 `sha2` feature，不能仅更新锁文件解决。保留 Windows SSH 的 RSA 功能与显式审计失败，未伪造版本、改写密码算法或删除兼容功能。
- glib 0.18.5 的 [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html) 仍按版本命中 unsound 警告；既有源码安全回补保留。另有 11 项停止维护提示，未计作已修复漏洞。
- Tauri 应用库 2.11.6 已达到[官方 IPC 公告](https://github.com/tauri-apps/tauri/security/advisories/GHSA-w28w-mhc8-qvjv)的修复下限；Tauri CLI 保持官方最新稳定版 2.12.4。CLI 原生二进制不受 npm overrides 或应用 Cargo.lock 控制，需要单独评估。
- 本机 macOS ARM64 CLI 使用 `cargo audit bin` 从 panic 信息恢复出 232 个依赖，发现 RSA 0.9.10 命中上述 RSA 漏洞、Tokio 1.45.1 命中 [RUSTSEC-2026-0386](https://rustsec.org/advisories/RUSTSEC-2026-0386.html)，另有 rustybuzz / ttf-parser 两项停止维护提示。这是部分二进制扫描，部分包缺少本地 registry 索引信息，不能视为完整 SBOM 审计。CLI 需等待上游更新 / 重建原生包；不能用 npm 锁文件无命中宣称其漏洞已清零。其他平台的 CLI 二进制未逐一扫描。

Monaco / Mermaid 的既有 DOMPurify 3.4.17 和 KaTeX 0.18.2 修复保持有效。本次没有升级 Tauri 主版本，也没有更改数据库查询逻辑。

### 验证证据

- `npm ci --no-audit --no-fund` 干净安装成功，Monaco 补丁自动恢复；重装后 13 项安全测试及 ESLint 再次通过。
- `npm test`：175 个文件、2483 项测试通过；`npm run test:tauri`：6 项通过。前端构建通过，保留现有的大 chunk 提示。
- Tauri CLI 完成 macOS `build --debug --no-bundle`，复用已验证的前端产物；没有执行安装包发布。
- `cargo test --manifest-path src-tauri/Cargo.toml --locked`：最终重跑 927 项通过、0 项失败、111 项原有忽略，文档测试通过。SQLite 数据任务、取消、查询预算、表结构及结果读取均在该套件中覆盖。
- `cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings`、Rust 格式检查、`git diff --check` 均通过。修正新版 trace API 的返回值检查，并去除一处原有 SSH 测试中触发 `ok_expect` 的多余 `.ok()`。
- Cargo metadata 确认四个本地补丁生效、应用和连接池共享同一个 rusqlite / libsqlite3-sys，SQLite 启用 `bundled`。独立审查逐字节核对新增 vendor 源码与许可证，并验证实际 `archiver-node.glob()` 内存归档、CommonJS 导出及 ESLint partial match 的兼容性，无重要发现。
- 未执行完整 Windows / Linux 应用构建；未把原有忽略测试或第三方维护提示计作已通过 / 已修复。

修改保留在当前 master 工作区，未提交、未推送。
