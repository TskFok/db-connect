# 当前源码完整 Tauri 主应用的隔离验收入口

日期：2026-10-15。此文档说明 T07/T09 的可执行设施；交付设施本身不代表手工场景或性能目标已经通过。

## 隔离边界

普通发行构建没有 `performance-desktop` feature，不编译 `performance_desktop.rs`，不接受通过环境变量打开测试能力；原连接路径、原钥匙串 service、原 App、原 CSP 保持默认实现。测试专用脚本、Vite 转换和控制面板不被普通 `index.html` 引用。

`prepare` 用随机 UUID 在规范系统临时目录创建 `db-connect-desktop-<uuid>`，权限为 0700。生成独立的 identifier、应用名称、可执行文件名称、WKWebView `dataStoreIdentifier` 和 SQLite 夹具。临时数据库为 10,000 行 × 200 列，另有 20 行小表；通过一次 Python `sqlite3.executescript` 和集合递归 CTE 生成，不循环查询 SQL。

feature 构建在创建 Tauri Builder、插件和应用窗口之前验证：目录必须是本次 UUID 对应的规范绝对临时路径，identifier 必须匹配，随机标记文件必须存在且匹配，夹具文件不能经符号链接。参数缺失、生产 identifier 和不匹配标记均拒绝启动。

feature 下连接与列偏好只读写临时 `config/`；加解密使用进程内一次性随机密钥，相关代码不编译系统钥匙串访问。重启后旧的临时加密连接不可恢复，所以自动连接通过无保存 ID 的本次合成配置进行。测试窗口中不要保存连接；它不是持久化凭据测试。

feature 在统一 `ConnectionManager::prepare_connection` / `test_connection` 最早边界检查目标，只接受本次规范路径下的 SQLite，拒绝网络数据库、SSH、密码与证书文件。普通连接、数据库对比/同步的临时连接都经过该守卫；不是只在前端或 IPC 命令层限制。不重设 `HOME`、`CODEX_HOME` 或其他系统目录变量。现有 `/Applications/DB Connect.app`、现有用户配置和当前运行的生产应用均不用于本入口。该硬隔离针对数据库连接目标，不是任意 SQL 或文件操作的沙箱。

导出文件命令仍沿用生产实现。手工导出时只选择本次临时目录；系统保存框取消必须在真实表格导出流程触发。测试控制面板的“保存观测”只写本次 `desktop-observations.json`。本设施不注入磁盘满、不创建测试卷、不关闭生产应用。

## 执行步骤

先完成/冻结源码，再创建独立目录：

```sh
node scripts/performance/desktop-app.mjs prepare
```

输出 `root`、identifier 和后续命令。以下 `<root>` 替换为该命令的绝对目录，构建和启动分别执行，便于协调正式测量：

```sh
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  node scripts/performance/desktop-app.mjs build '<root>'
node scripts/performance/desktop-app.mjs launch '<root>'
```

默认 Rust debug、前端生产 Vite 构建，并仅在独立前端产物启用 React profiling。需要 Release 时给 build 增加 `--release`；必须单列构建模式，不能混合计算性能收益。脚本设置 `CARGO_NET_OFFLINE=true`，不安装升级依赖。使用仓库已有 Cargo target 缓存，构建独立 `.app` 后复制到本次临时目录。

构建前后核对源码 fingerprint；范围包含 `index.html`、`public/`、`src/`、`src-tauri/`（排除 target）、Vite 配置、包清单/锁文件与三个主应用 desktop 构建入口，包含非 ignored 的未跟踪源码；不包含无关 performance 基准脚本，也不声称哈希覆盖已安装依赖二进制和系统工具链。保存 HEAD、源码 fingerprint、可执行文件 SHA-256、CSP 与构建模式到 `build.json`。启动前再次核对源码及可执行文件哈希，通过精确 `.app/Contents/MacOS/<唯一可执行文件>` 启动，并保存 PID 到 `launch.json`。CUA 应按 `build.json` 的完整 `.app` 路径选择应用，禁止用通用 `DB Connect` 名称选择现有生产进程。

如源码在 prepare 后发生变化，脚本拒绝登记/启动，重新 prepare 后构建；不要复用旧安装版或给旧目录覆盖标记。

安全单测（不启动 GUI）：

```sh
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  cargo test --offline --manifest-path src-tauri/Cargo.toml \
  --features performance-desktop performance_desktop::tests
```

## T07 的实际操作与记录

启动后自动加载原始 `src/main.tsx` 和完整 App，通过真实 Tauri IPC 连接临时 SQLite，并打开宽表。控制面板可收起，提供真实 store 的“打开 SQL 标签”“打开宽表”“打开小表”。不替换表格、编辑器、连接 store 或数据库命令。

在宽表与 SQL 编辑器各拖动真实侧栏。每次 mousedown/mousemove/mouseup 要求 `isTrusted`，记录真实持续时间，不预设 CUA 单次拖动已达到两秒。记录释放前后真实 AppInner layout effect 提交计数、`db-connect-settings` 每次实际 `setItem` 次数（`settingsKeyWrites`，同值重复写入也计数）、侧栏宽度值变化次数（`sidebarWidthValueChanges`）、rAF 观察帧、宽度变化观察帧与子树 Profiler 样本。失焦取消、不变宽度与重启宽度恢复均需分别实际操作。有效松手最多一次持久化使用实际 `settingsKeyWrites` 增量判断，不能以宽度值变化次数代替；预览根提交为零由原始记录判断。

`Profiler.actualDuration` 仅为 React 渲染工作量，不是 DOM 提交阶段耗时。App 根的计数来自 `AppInner` 每次提交后的 `useLayoutEffect`。整个 App 树/表格/SQL 编辑器子树提交与根组件提交分开记录。rAF 观察到的宽度变化帧不是生产 hook 的精确 DOM 写入次数；布局观察器引起子树提交不自动视为根组件回归。

独立构建将已有低频动态入口统一延迟 800 ms，便于手工检查加载提示；这属于测试插桩，不能用来报告懒加载速度。控制面板可选择入口并安排下一次受控失败；需在首次打开该入口前设置，然后真实打开、关闭、重开，确认失败回收、成功重试、健康实例保留。原始 lazy 日志记录 requested/injected-failure/loaded，不额外模拟业务结果。

可覆盖的入口包括项目介绍、快捷键帮助、数据库对比弹窗、表格索引/触发器/建表 SQL/外键界面；SQLite 不支持的存储过程、事件和跨引擎比较/同步业务场景仍要单列未测。大对比列表、跨页选择、同步范围等不能因为弹窗可打开就记为通过。

宽表切页、滚动、切标签、选择、编辑和复制通过真实组件操作；是否通过须结合手工记录，不能由脚本自动生成通过结论。

## T09 的系统保存框取消

点击“开始保存框取消观察”，随后从真实表格执行 Excel 导出，在 macOS 系统保存框点击取消，再点击“保存观测”。检查该观察窗口的增量：

- `queryFullRows`：生产 `query_full_rows` IPC 调用次数。
- `exportPrepareCalls`：生产 `exportExcelWithDialog` 中实际 prepare 回调调用次数。
- `excelWorkerCreated`：生产 Excel Worker 构造次数。
- `registrations`：生产 `prepare_binary_export` IPC 调用次数。

四项均应为 0；还需手工确认确实打开并取消了系统保存框，原始 JSON 的 `systemCancelRequiresManualConfirmation` 明确保留这一要求。计数只记录命令名称和数量，不记录 SQL、参数、结果或凭据。

此入口保留生产 CSP、Worker 和二进制 IPC；导出成功、Unicode/空格路径、覆盖截断及 ZIP/XML 语义仍须针对实际输出验证。编码/登记/写入阶段关窗屏障、物理磁盘满和 Windows/Linux 桌面不在本次设施的已验证范围，T09 不能整体勾选。

## 输出及局限

`desktop-observations.json` 包含本次随机身份、源码标识、WebView UA、可信输入、IPC/Worker/存储数量、lazy 事件和 React 样本。没有完整 SQL 和数据内容。所有时间采用 WebView 自身 `performance.now()`，不跨进程相减。

保存的辅助记录不包含主线程最长任务、精确瞬时 RSS 峰值、WebContent PID 归属或 DOM 提交耗时。不存在旧应用对照，不计算端到端收益百分比。完整手工证据应另存带日期的原始记录并更新任务清单；设施、单测和构建成功都不代替真实桌面验收。

## 设施验证记录

2026-10-15，主代理实际执行安全定向 `cargo test --features performance-desktop performance_desktop::tests`，3 项通过，未启动 GUI。主代理复核三份 desktop 脚本的 `node --check`（两份 `.mjs`）及 ESLint，均退出 0。

独立入口实际类型检查退出 0：

```sh
./node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext \
  --moduleResolution Bundler --jsx react-jsx --esModuleInterop \
  --skipLibCheck --lib ES2022,DOM,DOM.Iterable \
  scripts/performance/desktop-entry.tsx src/vite-env.d.ts
```

最初独立命令遗漏 `DOM.Iterable`，在原 `src/main.tsx` 的 NodeList 遍历处报告两项 TS2488；补齐与项目配置一致的 lib 后通过，未为此修改源码。以上是安全与编译检查，尚不代表 `.app` 构建、真实拖动、懒加载或系统保存框取消已完成。

## 首轮构建问题及修复边界

按 `systematic-debugging` 核实两处根因：原 Vite 普通 `transformIndexHtml` 在 HTML 模块转换后执行，`/src/main.tsx` 已变为资源 URL，所以初版产物缺少 desktop 入口，只有 App 里的观测调用。插件的 `enforce: pre` 不控制 HTML hook；修为 `transformIndexHtml: { order: pre, handler }`，同时要求 HTML、根组件、根/表格/编辑器 Profiler、导出 prepare 与十处 lazy 导入全部匹配预期数量，检查真实 Rollup 产物确有入口和全局初始化；任何遗漏直接失败。成功构建额外输出 `frontend-instrumentation.json`。

新增真实生产前端构建回归 `node --test scripts/performance/desktop-frontend.node-test.mjs`：修复前实际失败“必须实际打包 desktop-entry 的指标初始化”，修复后 1 项通过，验证所有入口/插桩计数及真实资源。该测试只构建前端，没有启动 GUI。

本机锁定的 `tauri-utils 2.8.3` 在 `config.rs:3577` 对 `Option<[u8;16]>` 使用 `opt_vec_lit`，生成 `Vec<u8>`，因此 JSON `dataStoreIdentifier` 导致 `generate_context!` E0308。未升级或修改依赖；专用 JSON 移除此字段，feature 在身份守卫成功后使用 `Context::config_mut()` 为唯一 main 窗口赋值本次 UUID 的原生 `[u8;16]`，发生在 Builder 与窗口创建前。仍由原 Tauri 配置创建完整主窗口，没有退回共享存储。原生数组赋值与错误窗口配置的单测已加入，最终 Rust 编译/执行由主代理统一验证。

### 2026-10-16：只读 IPC 内部属性的启动阻断

本机 Tauri `scripts/core.js:81` 用 `Object.defineProperty` 定义内部 `invoke`，仅设置 value，writable/configurable 默认均为 false。初版 desktop 入口尝试替换此属性，ES 模块严格模式会在加载原始 main 前抛出 TypeError，因此仅凭前端成功打包不足以证明能启动。

修复移除了对内部 `invoke` 的赋值。独立 Vite 构建只在真实 `node_modules/@tauri-apps/api/core.js` 的公开 `async function invoke(cmd, args = {}, options)` 函数入口注入数量记录，不修改 node_modules 文件或运行时只读对象。该替换必须命中一次，否则拒绝构建；额外记录 `apiInvoke: 1` 并检查真实产物包含观测守卫。保存观测文件也调用公开 API。默认生产构建仍不使用这套转换。新 helper `desktop-tauri-invoke.mjs` 纳入本次源码 fingerprint。

轻量行为回归先在精确只读属性描述符下复现入口初始化 TypeError，再验证移除赋值后入口初始化、面板创建均成功。第二项读取实际安装的公开 API 源码，应用与构建相同转换后执行真实 invoke 函数，验证只读内部对象不变、计数准确、二进制参数/options 引用原样转发、返回值/拒绝原因不变，且未初始化或匹配不到真实入口时拒绝运行。

本轮行为测试通过不等于主应用窗口已显示；修复后的实际 `.app` 构建和 CUA 启动由主代理在独占采样结束后执行。
