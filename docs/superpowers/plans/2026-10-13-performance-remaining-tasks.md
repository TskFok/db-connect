# 性能优化剩余任务清单

> **执行说明：**后续实施时使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，按任务更新复选框及证据。本文件登记收尾任务及执行证据；勾选以完成标准为准，不代表已提交或发布。

**目标：**补齐 2026-09-30 性能计划的验收缺项、仓库检查和状态记录，并单独跟踪已登记的后续设计与扩展验证。

**架构：**保留现有 React/Zustand → Tauri → Rust 数据库适配层及六个专项实现，优先复用已有测量脚本、夹具与回归测试；发现实际缺陷后再针对性修复。

**技术栈：**React、TypeScript、Zustand、Monaco、Tauri、Rust/Tokio、Vitest、现有数据库驱动及系统性能工具。

**依据：**[总计划](2026-09-30-performance-00-overview.md)、[01 内存](2026-09-30-performance-01-result-memory.md)、[02 取消](2026-09-30-performance-02-mysql-cancellation.md)、[03 元数据](2026-09-30-performance-03-metadata-access.md)、[04 补全](2026-09-30-performance-04-sql-completion.md)、[05 前端](2026-09-30-performance-05-frontend-interaction.md)、[06 导出](2026-09-30-performance-06-excel-export.md)及[性能基线](../../performance-baseline.md)。

## 检查起点（2026-10-13）

- 分支 `dd`，检查时 HEAD 为 `7a0f619`；六个专项核心代码均已落地，不重复安排其实现。
- 前端全量：158 个文件、2060 项测试通过；Rust：784 项通过、18 项默认忽略。
- 生产构建、Rust 格式检查通过；全仓 ESLint 仍有 3 项既有错误，Clippy 仍有 1 项既有错误。
- Rust 复验使用已安装的 `MacOSX26.5.sdk`；默认 SDK 27 存在链接兼容问题。协议替身测试需要允许监听本机回环端口，沙箱拒绝监听不能计为功能断言失败，也不能计为通过。
- 03 的实库矩阵与端到端验收未完成；01、05、06 仍有测量缺项。04 本阶段已完成，Worker 是独立后续设计。

## 全局约束与证据规则

- 默认在当前分支执行；不擅自新建分支或工作树，不自动提交、推送、发布或安装升级依赖。
- 禁止循环遍历查询 SQL；批量目录及完整字段使用集合 SQL，不用 `Promise.all(map(查询))`、分块循环或轮询数据库状态绕过限制。
- 仅使用合成数据、内存 SQLite、协议替身及隔离数据库实例，不读取业务凭据或连接业务库。
- 保留只读限制、可信主键、大整数精度、日期/二进制语义、取消行为、待提交编辑及导出租约，不以丢失数据换取性能。
- 新旧比较固定同机、构建模式、数据形状、数据库延迟和采样口径；旧源码只读提取到临时目录，不恢复旧生产路径、不为补基线引入循环 SQL。无法取得合规的旧基线时明确登记缺失，不编造提升比例。
- 沿用各专项已有采样方法；新增延迟组默认 5 次预热、20 次正式样本，内存组至少 3 个独立进程样本。记录全部样本、失败/重试、环境、构建标识和 p50/p95，采用各进程自身单调时钟，不跨时钟相减。
- 原始证据保存到 `docs/performance/`，文件名带实际执行日期；结论写入 `docs/performance-baseline.md` 和对应专项。只记录数量、字节、时间、版本及随机标识，不记录凭据、完整 SQL 或结果内容。
- 先确认工具可测范围：GC 后保留堆不等于全部分配量，定时器/rAF 间隔不等于最长任务，采样 RSS 不等于精确瞬时峰值，React Profiler 的 `actualDuration` 不等于 DOM 提交耗时。
- 缺少环境或测量工具时记录限制与辅助证据，任务保持待验；替代指标不得直接用于勾选原指标。墙钟性能不设跨机器 CI 硬门禁。

## 收尾任务索引

| ID  | 任务                                 | 性质            | 依赖                             |
| --- | ------------------------------------ | --------------- | -------------------------------- |
| T01 | 同步过期文档与进度口径               | 文档收尾        | 无                               |
| T02 | 修复全仓静态检查的既有错误           | 仓库维护        | 无                               |
| T03 | SQL Server/ClickHouse 元数据隔离验收 | 03 验收缺项     | 隔离实例                         |
| T04 | 元数据真实端到端及 PG 分页缓存测量   | 03 验收缺项     | 测量环境；全引擎结论依赖 T03     |
| T05 | 结果内存与预算的真实链路补验         | 01/统一验收缺项 | 完整应用及隔离实例               |
| T06 | 宽表全部分配量指标补验               | 05 明确指标缺项 | 可用分配分析工具                 |
| T07 | 完整应用交互与懒加载手工验收         | 05 验收补齐     | 完整应用                         |
| T08 | Excel 长任务与内存测量补齐           | 06 明确指标缺项 | 可用系统/WebView 分析工具        |
| T09 | Excel 跨平台及系统错误场景补验       | 06 验收边界     | Windows/macOS/Linux 测试设备     |
| T10 | 最终集成与统一验收归档               | 总计划收尾      | T01—T09 的完成证据或明确待验状态 |

优先处理 T01、T02；不同模块可并行只读检查或准备夹具。正式同机性能采样单独运行，避免并行构建、测试或其他基准干扰结果。

### T01：同步过期文档与进度口径

**文件：**`docs/superpowers/plans/2026-09-30-performance-00-overview.md`、`docs/performance-baseline.md`、`src-tauri/vendor/mysql_async/DB_CONNECT_PATCH.md`。

- [x] 修正总览开头“06 尚未实施”，对齐其已实现、macOS 分层验收完成及剩余测量边界。
- [x] 逐条核对总览统一验收复选框：已有脚本或已运行检查补上证据，未完成测量继续保留，不将整段统一勾选。
- [x] 更新驱动补丁说明及基线中的适用范围，覆盖 01 后续接入的表浏览/完整行失败清理；保留正常归还与取消路径的准确区别。
- [x] 给总览增加本清单入口；保留带日期的历史分支/未提交记录，避免把历史描述改写成当前状态。

**完成标准：**总览、专项、基线和补丁说明无当前状态冲突；链接有效，`git diff --check` 通过。

### T02：修复全仓静态检查的既有错误

**文件：**`scripts/release.mjs`、`scripts/release.node-test.mjs`、`src-tauri/src/db/sqlserver_objects.rs`。

- [x] 在两处推送错误重新抛出时保留原错误 `cause`，保持现有中文提示；补充断言验证 cause 与提示，不执行真实发布命令。
- [x] 为发布脚本测试显式引入 `node:url` 的 `URL`，消除 `no-undef`，不放宽全仓规则。
- [x] 为 SQL Server 外键聚合的复杂内部类型引入具名类型，保持排序、完整性和组合外键语义，不用禁用 Clippy 规则代替修复。
- [x] 运行 `npm run test:release`、`npm run lint`、`cargo test --manifest-path src-tauri/Cargo.toml sqlserver_objects`、`npm run fmt:rust`、`npm run lint:rust`。

**完成标准：**3 项 ESLint 和 1 项 Clippy 既有错误消除，相关回归及全仓静态检查通过。此任务是仓库维护，不将这些错误归因于六个性能专项。

### T03：SQL Server/ClickHouse 元数据隔离验收

**复用/涉及文件：**`scripts/performance/metadata-postgres-validation.py` 的隔离运行模式、`src-tauri/src/db/sqlserver.rs`、`src-tauri/src/db/clickhouse.rs`、`src-tauri/src/db/metadata_batch.rs`；新增相应引擎的独立验收夹具与结果文件。

- [ ] 确认可用隔离实例，准备普通/受限账号以及空目录、缺失目录、特殊名称、同名表、表/视图和 NULL 统计夹具。
- [ ] 通过生产批量入口验证字段、顺序、分组及权限行为与原单目录语义一致；权限失败不返回误导性的部分成功。
- [ ] 记录数据库侧查询计数：空输入和超出 256 个去重名称时零查询，有效批量一次集合执行，去重保序；查询次数不随目录数量增长。
- [ ] 重跑 Rust `metadata_batch` 定向回归，保存引擎版本、权限矩阵、服务端计数和可复现命令。

**完成标准：**两种引擎各有真实隔离证据；离线 SQL 字符串断言不替代实库权限验收。MySQL 8/9 含空目录最多 2 条 SQL 的既定例外保持不变。

2026-10-17 用户授权下载镜像后，ClickHouse 25.8.33.6（arm64）实库权限、旧单库字段等价及服务端计数通过：1/5/256 目录批次各 1 条 SQL，空输入/257 名称零查询，受限及无授权账号过滤语义一致，专属实例与凭据清理成功。SQL Server 2022 官方 amd64 镜像可在本机模拟启动并初始化专属夹具，但 6 次尝试仍被生产 Tiberius 的 TLS 握手阻断，未进入目录断言；短期容器证书对照和全部失败均保留。因此 T03 继续未完成，不能把 ClickHouse 通过扩成两引擎通过。见 [本轮汇总](../../performance/docker-database-validation-2026-10-17.md)。

### T04：元数据真实端到端及 PG 分页缓存测量

**复用/涉及文件：**`scripts/performance/metadata-access-benchmark.py`、`scripts/performance/metadata-postgres-validation.py`、`src-tauri/src/db/metadata_bench_tests.rs`、`src/__tests__/metadataRequests.performance.test.ts`、`src-tauri/src/db/table_pagination.rs`。

- [ ] 在完整 Tauri 应用测量 1/10/50/100 个目录刷新及同表连续 20 次非游标分页，覆盖总览与专项两种目录规模要求。
- [ ] 分别记录目录 IPC/总 IPC、目录 SQL/分页元数据 SQL、缓存命中率、池等待、数据页/COUNT、前端准备和渲染时间，以及整体 p95；不把现有 invoke 替身耗时当真实 IPC。
- [x] 补 PostgreSQL 服务端分页缓存计数和网络 p95：首次取元数据 1 条，TTL 内连续请求 0 条；显式失效后重新读取，保留可信主键和旧游标失效行为。（2026-10-17：PG 17.11 实库，5 次预热 / 20 次正式，冷/热/失效后计数 `[1,1,0]` / `[0,20,0]` / `[1,1,0]`，见 [原始证据](../../performance/metadata-postgres-pagination-2026-10-17.json)。）
- [ ] 核对并发去重、失败重试、断线/刷新后迟到响应隔离；保存同环境冷/热数据及旧基线是否可取得的明确结论。

**完成标准：**补齐 03 任务 4 的测量证据；旧多库延迟对照缺失时继续单列，不报告端到端加速百分比。无环境的引擎单独保持待验。

2026-10-15 本机续验：新增 PostgreSQL 分页实库夹具及 `--preflight/--suite pagination/--output` 入口，已通过编译；服务端计数、5 次预热与 20 次正式样本均由夹具验证。当前本地缺少 `postgres:17-alpine`，预检退出 2，未拉取镜像、未产生实测样本，以上原验收项保持未完成。见 [夹具与边界](../../performance/remaining-postgres-pagination-2026-10-15.md)。

### T05：结果内存与预算的真实链路补验

**复用/涉及文件：**`scripts/performance/result-memory-benchmark.mjs`、`src-tauri/src/commands/data.rs`、`src-tauri/src/db/result_budget.rs`、`src/utils/resultCacheBudget.ts`、`src/__tests__/resultCacheBudget.test.ts`、`src/__tests__/TableDataDeferred.test.tsx`。

- [ ] 在完整应用打开 1/10/30 个固定大结果标签，分别测普通回收及全部持有租约的场景；记录 Rust/WebView 内存、IPC 字节、登记载荷、实际回收量和采样方法。
- [x] 补 Tauri 命令级页大小越界验证，证明拒绝发生在取得数据库连接之前。
- [ ] 用隔离库验证各驱动表页/完整行入口：大字段超预算整次失败，无静默半页，连接后续可用，取消/旧句柄不影响新查询；列出无主键、复合键和空表覆盖情况。
- [ ] 验证脏页和导出保护、释放租约后回收、迟到响应和无自动 SQL 重跑；保存完整应用测量与已有 Node/store 测量的分层结果。

**完成标准：**真实链路有证据，未测引擎明确列出；100,000 行/32 MiB 单结果预算、128 MiB 缓存软预算及保护例外不被误写为进程 RSS 上限。

2026-10-15 本机续验：MySQL 8.4.11 隔离实例通过生产 `query_table_data` / `query_full_rows` / `cancel_table_query` 命令函数验收，覆盖 6×9 MiB 大字段超预算整次失败、后续查询恢复、无键/单键/复合键、空表、连接前取消及旧句柄隔离。真实 IPC/WebView/RSS、活动查询服务端中断和其他驱动仍待验；因此全驱动与完整应用复选框不勾选。见 [验收记录](../../performance/mysql-budget-validation-2026-10-15.md) 与 [原始证据](../../performance/mysql-budget-8.4-2026-10-15.json)。

### T06：宽表全部分配量指标补验

**复用/涉及文件：**`scripts/performance/table-row-source-benchmark.mjs`、`src/components/table/tableRowSource.ts`、`src/__tests__/tableRowSource.test.ts`、`docs/performance-baseline.md`。

- [ ] 确认可测全部分配字节的工具及采样误差；GC 后保留堆、RSS 不可替代该指标。
- [ ] 在同机、同运行时、同构建和 10,000×200 夹具下，比较旧全页记录转换与当前按索引行源，统计相同初始化/转换边界内的全部分配字节。
- [ ] 计算并核对原目标“分配量下降至少 70%”；记录未达标或不可测结果，不能用已有保留堆下降 99.15% 补记达标。

**完成标准：**原指标有可复核证据且达到目标；若不满足，保留未完成状态并根据实测原因建立修复或测量方法任务。

2026-10-14 补验：已交付V8累计托管堆分配脚本和6个正式辅助样本，校准证明可保留已GC对象累计计数，也证明漏计ArrayBuffer外部内存；因此原三项复选框保持未完成。详见 [方法记录](../../performance/remaining-allocation-method-2026-10-14.md) 与 [原始样本](../../performance/table-row-source-allocation-2026-10-14.json)。

新增方法任务：

- [ ] 明确“全部分配”的验收域；若涵盖原生/外部内存，以同版本V8插桩或可归属系统事件补齐累计计数，并处理GC搬迁和分配器/JS对象重复计数。
- [ ] 校准快路径、大对象、外部字符串、ArrayBuffer和C++分配的覆盖/计数宽度，给出误差界后，在相同初始化边界重新成对测量。

### T07：完整应用交互与懒加载手工验收

**复用/涉及文件：**`scripts/performance/frontend-interaction-webview.tsx`、`src/hooks/useSidebarResize.ts`、`src/components/common/DeferredFeatureBoundary.tsx`、`src/__tests__/AppStateSubscriptions.test.tsx`、`src/__tests__/DatabaseCompareResults.test.tsx`、`src/__tests__/DatabaseSyncPreviewModal.test.tsx`。

- [ ] 在完整 Tauri 表格和 SQL 编辑器中各进行约 2 秒真实拖动，分别记录 App 根/子树提交、预览帧和持久化次数；区分渲染时间与提交阶段时间。
- [ ] 验证预览 App 根提交为 0、有效松手最多 1 次持久化、失焦/卸载取消及宽度不变零写入；允许尺寸观察引起必要子树提交，恢复设置后宽度正确。
- [ ] 逐一打开低频懒加载入口，验证加载提示、失败重试、关闭/重开及成功实例保留；补齐完整应用中宽表切页/滚动/切标签和大对比列表的搜索、展开、键盘分页与跨页选择。
- [x] 保存真实应用证据，分别列出与独立 WKWebView 夹具的覆盖差异；初始 JS 统计继续复用 `scripts/report-initial-js.mjs`。（2026-10-16 的部分交互已归档；前三项完整场景仍待验，见 [本机续验](../../performance/remaining-local-validation-2026-10-16.md)。）

**完成标准：**原交互行为和手工步骤有完整应用证据，无选择、编辑、复制或同步范围退化；不额外预设冷启动加速目标。

### T08：Excel 长任务与内存测量补齐

**复用/涉及文件：**`scripts/performance/excel-export-webview.ts`、`scripts/performance/excel-export-measure.worker.ts`、`scripts/performance/excel-export-tauri.rs`、`scripts/performance/excel-export-tauri.sh`。

- [ ] 探测系统/WebView 分析工具，明确能否直接测主线程最长任务、归属准确的 Rust/WebContent 内存及峰值精度；避免仅依据“新 PID”推断进程归属。
- [ ] 固定 1 万/10 万行和宽字段夹具，分别测准备、结构化克隆、编码、IPC、写盘，补 Release Rust 与完整应用的测量口径。
- [ ] 单独统计 Worker 输入克隆及保持期内存；保留新路径整体可能更慢、峰值可能上升的真实结果。
- [x] 对无法直接观测的最长任务/瞬时峰值明确记录工具限制和分辨率；定时器最大间隔及采样最大 RSS 继续标为辅助证据。

**完成标准：**06 任务 4 第一项获得符合原口径的证据后才勾选；存在不可测项则继续待验，不以代理指标替代。

### T09：Excel 跨平台及系统错误场景补验

**复用/涉及文件：**`src/utils/excelExport.ts`、`src/workers/excelExport.worker.ts`、`src-tauri/src/commands/file_io.rs`、`src/__tests__/excelExport.test.ts`、`src/__tests__/excelWorkbook.test.ts`及导出测量脚本。

- [ ] 在 Windows/Linux 完整桌面应用验证生产 Worker、CSP、原始二进制 IPC、Unicode/空格路径、覆盖截断、无权限和目录不存在，保存平台及版本矩阵。
- [ ] 在 macOS/Windows/Linux 实际系统保存对话框取消，确认完整字段回查、prepare、Worker 创建和文件登记均为 0。
- [ ] 在完整主应用编码、登记和写入三个阶段关闭窗口，检查 Worker、租约、登记和最终文件状态；写入已开始不能宣称可撤销。
- [ ] 使用受控的小容量测试卷或隔离故障注入验证磁盘满/写入中断，禁止填满系统盘；记录真实错误与残留文件结果，不将模拟异常当作物理设备故障实测。
- [ ] 对各平台输出解压核验 ZIP/XML 的工作表、列顺序、大整数、日期、NULL、Unicode 和末行，不能只检查文件魔数。

**完成标准：**支持平台及上述场景均有明确通过/失败/未测记录；只完成矩阵登记不等于全部验收通过。

### T10：最终集成与统一验收归档

**文件：**`.github/workflows/ci.yml`、各专项计划、`docs/performance-baseline.md`、`docs/performance/`及本文件。

- [x] 核对普通 CI 覆盖 SQL 次数、缓存容量/失效、数据完整性及 DOM 数量；已被全量测试覆盖的项目只补证据，不重复新增等价测试或墙钟门禁。
- [x] 定向检查通过后运行一次集成：`npm test -- --maxWorkers=2`、`npm run test:release`、`npm run build`、`npm run lint`、`npm run test:rust`、`npm run fmt:rust`、`npm run lint:rust`、`git diff --check`。
- [x] 如仍遇本机 SDK 27 链接兼容问题，仅在相应命令设置 `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`；记录环境条件，真实协议测试需允许回环端口，不安装或替换系统 SDK。
- [x] 汇总各任务的命令、退出码、通过/失败/忽略数量、原始样本和未验边界；新旧性能数据同条件复测，避免混合不同机器、系统版本或构建模式。
- [x] 按证据同步总览、专项及本清单；已完成核心实现、待验指标、独立后续设计分别标记。

**完成标准：**全仓检查通过，T01—T09 适用验收项有完整证据。仍有工具/平台限制、未达指标或缺失旧基线时如实保留，不能仅因代码测试通过就宣称全部原计划验收完成。

## 独立后续与非阻断维护

以下任务单独跟踪，不将其反算为已完成专项的核心代码缺失，也不自动追加到本轮收尾的完成条件。

### F01：SQL 补全冷路径方案设计

**来源：**04 的“Worker 后续设计任务”；触发证据为 1 MiB 冷 provider 20/20 次同步调用超过 50 ms，p95 为 79 ms。

**复用文件：**`scripts/performance/sql-completion-webview.ts`、`scripts/performance/sql-completion-benchmark.mjs`、`src/utils/sqlCompletionDocumentCache.ts`、`src/utils/sqlCompletion.ts`。

- [ ] 补真实打包应用、长单条 SQL、未闭合字符串/注释导致重扫至文末的基线，分别测候选菜单延迟、同步阻塞和缓存内存。
- [ ] 比较 Worker 首次扫描、主线程分片、按需语句扫描，计入文本/token 传输、序列化、合并、初始化及峰值成本。
- [ ] 设计模型身份、文档版本、方言、取消和销毁守卫，候选继续绑定最新元数据；保留原 Node 热补全/末尾编辑 p95 目标及短脚本退化限制。
- [ ] 输出独立设计文档、证据和取舍结论，再根据结论生成实现任务；本任务不直接要求引入 Worker。

### F02：扩展数据库与网络兼容矩阵

- [ ] 在隔离环境按实际支持需求补测 MySQL/MariaDB 版本、collation、角色/代理账号/运行时角色切换及真实 SSH/TLS，分别记录 02 取消和 03 目录权限的适用范围。
- [ ] 区分原始 MySQL 5.7 取消验收已完成与其他环境尚未覆盖；不得把全版本兼容作为未经范围定义的完成承诺。

### F03：扩展前端启动与系统呈现基线

- [ ] 按需补完整 Tauri 冷启动、启动恢复、连接切换及原生 OS 呈现延迟，单独定义起止点与环境。
- [ ] 分开报告初始 JS 字节、首次可交互、WebView/OS 呈现指标，不把资源下降 2.15% 推导为冷启动时间下降；05 原计划没有预设冷启动加速目标。

### F04：连接生命周期标记安全回收

- [ ] 设计历史连接小标记的有界保留与安全回收，覆盖长期高频重连和极晚响应；不得直接 TTL 删除后让旧请求重建缓存。
- [ ] 在 `src-tauri/src/db/table_pagination.rs` 相关生命周期回归中证明旧请求仍被拒绝，保持元数据 256 项、游标 4096 项及 300 秒 TTL 不变。

### F05：整理 service 动态导入依赖方向

- [x] 核查 `src/services/tauriCommands.ts` 与 `src/stores/connectionStore.ts` 的静态/动态依赖，形成最小整理方案，避免顺带大规模重构。
- [x] 验证连接切换、失效事件和启动顺序不变，重新构建并记录初始静态依赖闭包；消除提示不能以初始资源或行为退化为代价。

2026-10-19 完成：新增 `src/services/databaseSync.ts` 编排同步命令与目标连接元数据失效，`tauriCommands.ts` 恢复纯同步 IPC 包装并移除对连接 store 的反向依赖。对比窗口调用编排服务，在判断界面结果是否过期前完成失效；关闭或卸载不影响已成功执行语句的失效通知。连接匹配在命令完成后读取当前活动连接，覆盖同一保存配置的所有活动连接；遍历只发送内存事件，不查询 SQL。

验证：两个关闭/卸载回归用例先失败后通过，新增编排服务 10 项回归；全量前端 161 文件 / 2189 项通过，修改文件 ESLint、格式及 `git diff --check` 通过，独立代码审查未发现问题。`npm run build` 通过且不再出现 `INEFFECTIVE_DYNAMIC_IMPORT`，原有大 chunk 提示保留。同配置重构前后，入口 `imports` 的递归静态 JS 闭包均为 6 个文件（入口、antd、dnd、core、image、rolldown-runtime），总大小从 1,696,327 字节变为 1,696,064 字节，未增加初始加载资源。

## 2026-10-14 执行记录

当前 `dd`，起点 `7a0f619`；未提交/推送、未新建分支/工作树、未安装升级依赖。**本轮仓库修复和集成检查完成，不代表整份性能清单或原性能计划验收完成。** T03—T09 的原始指标没有被代理指标替代；F01—F05 按上述约定独立保留。

| 日期 | 任务 ID | 状态 | 环境/构建标识 | 验证命令与结果 | 证据文件 | 剩余限制 |
|---|---|---|---|---|---|---|
| 2026-10-14 | T01 | 完成 | dd / 7a0f619 + 工作区 | 当前状态和补丁调用点已核对；本地链接/空白检查通过 | [执行归档](../../performance/remaining-status-2026-10-14.md) | 历史记录保留，未把历史未提交描述改成当前状态 |
| 2026-10-14 | T02 | 完成 | macOS 27.0.1 / SDK 26.5 | release 42/42；SQL Server对象15/15；ESLint/rustfmt/Clippy通过；cause先失败再通过 | [修复证据](../../performance/remaining-static-checks-2026-10-14.md) | 仓库维护，不归因于六个性能专项 |
| 2026-10-14 | T03 | 待验 | Docker 29.8.2 / linux arm64 | 只读镜像探测；全量Rust覆盖metadata_batch离线回归 | [数据库审计](../../performance/remaining-database-audit-2026-10-14.md) | 无SQL Server/ClickHouse隔离实例及独立权限/计数夹具 |
| 2026-10-14 | T04 | 待验 | macOS当前工作区 | 已核对既有替身/历史证据的范围 | [数据库审计](../../performance/remaining-database-audit-2026-10-14.md) | 缺PG镜像、真实分页计数和完整应用trace；旧多库端到端基线仍缺 |
| 2026-10-14 | T05 | 部分完成 | Tauri 2.11.3 MockRuntime | 页大小定向3/3；删除校验变异如期失败、恢复后通过；全量Rust786通过 | [命令证据](../../performance/remaining-command-budget-2026-10-14.md) | 完整应用内存与各远程驱动表页/完整行实库矩阵待验 |
| 2026-10-14 | T06 | 原指标待验 | Node 25.5.0 / V8 14.1 | 旧/新各3进程V8累计分配辅助样本，中位数下降97.6915% | [方法与证据](../../performance/remaining-allocation-method-2026-10-14.md) | V8托管堆不覆盖全部外部/原生分配，原70%目标不得勾选 |
| 2026-10-14 | T07 | 待验 | 安装版1.12.0 / 仓库1.13.0 | 全量确定性交互回归通过；没有启动旧安装版冒充HEAD | [测量审计](../../performance/remaining-measurement-audit-2026-10-14.md) | 缺当前完整隔离主应用的真实拖动、懒加载与列表手工记录 |
| 2026-10-14 | T08 | 部分完成、原指标待验 | CLT / xctrace不可录制 | 当前隔离WKWebView未宣告longtask；综合工具能力仍待验 | [探针记录](../../performance/remaining-webview-capabilities-2026-10-14.md) | 缺完整Xcode/有效时间线、归属准确内存、Release与完整应用测量 |
| 2026-10-14 | T09 | 待验 | 仅核实macOS | 已登记系统保存框、关窗、磁盘错误和ZIP/XML的平台矩阵 | [测量审计](../../performance/remaining-measurement-audit-2026-10-14.md) | Windows/Linux与系统场景无实机证据；登记矩阵不等于通过 |
| 2026-10-14 | T10 | 归档和检查完成、总体验收待验 | dd / SDK 26.5 | 前端158文件2060项；release42项；Rust786通过18忽略；构建/lint/fmt/Clippy/diff全部退出0 | [原始集成记录](../../performance/remaining-integration-2026-10-14.json) | T03—T09仍缺原指标/平台/完整链证据，不宣称全部完成 |

全部命令、环境、失败/恢复及未验边界见 [本轮执行归档](../../performance/remaining-status-2026-10-14.md)。本轮没有混合旧系统性能样本，也没有报告新的端到端加速百分比。

### 2026-10-15 续查

当前仍为 `dd` / `7a0f619`；相关代码差异哈希与2026-10-14集成检查时一致，新增分配脚本哈希也未变，因此不重复执行全量测试。只读复查Docker仍缺PostgreSQL、SQL Server和ClickHouse隔离镜像，未安装或拉取。最终独立审查及WebView探针限定复审通过，无未解决P0—P3问题；T08第一综合探测项已按证据恢复待验。整体清单仍未完成。见 [续查状态](../../performance/remaining-status-2026-10-15.json) 与 [审查记录](../../performance/remaining-review-2026-10-15.md)。

## 2026-10-15—17 本机续验归档

本轮起点已为 `dd` / `e43940a`。用户确认没有额外隔离数据库及 Windows/Linux 环境，先推进本机；未新建分支、提交推送、拉取镜像或安装升级依赖。测量发生于10月15—16日，10月17日归档。

| 任务 | 本轮新增证据 | 当前剩余边界 |
|---|---|---|
| T03 | 无新增实库样本 | SQL Server/ClickHouse隔离权限和服务端计数 |
| T04 | PG分页计数/采样夹具编译通过，缺镜像预检退出2 | PG实测、完整应用元数据分段p95及旧同环境基线 |
| T05 | MySQL8.4.11生产表页/完整行预算与恢复通过 | 其他驱动、活动查询中断、实际IPC/RSS、1/10/30大结果标签 |
| T06 | 沿用已有工具校准和辅助证据 | 全部分配字节原指标未补齐 |
| T07 | 当前源码完整隔离主应用；40/14ms短拖动、切表/翻页/滚动、功能介绍失败重开及其他模块加载；证据归档项完成 | 约2秒持续拖动、失焦/卸载/同宽/恢复、完整懒加载矩阵及大对比列表 |
| T08 | 显式Release最小Tauri example，每组5预热20正式，40条IPC及40条写盘样本 | 完整大导出、主线程最长任务、克隆内存及归属准确峰值 |
| T09 | 完整应用macOS系统保存框Cancel四项零增量；Release生产Worker和两表17坐标XML/文件错误验证 | Windows/Linux、三阶段关窗、受控磁盘满/中断 |
| T10 | 前端2060、发布42、Rust库786通过20忽略；bins/doc各0用例成功；构建/lint/fmt/默认及隔离feature Clippy通过；证据与文档同步 | 总体验收仍受上述原指标/环境缺口限制 |

命令、构建身份、独立审查、真实操作与失败/重试边界见 [本机续验记录](../../performance/remaining-local-validation-2026-10-16.md) 和 [集成归档](../../performance/remaining-integration-2026-10-17.json)。未取得符合原标准证据的复选框继续保留；F01—F05仍是独立后续，不扩为本轮实现任务。

## 2026-10-17：授权下载镜像后的隔离数据库补验

上述“未拉取/缺镜像”是授权前归档状态。本轮新增官方 PostgreSQL 17、ClickHouse 25.8、SQL Server 2022 镜像和可复现隔离入口。T03 的 ClickHouse 子项通过，SQL Server 因生产 TLS 握手阻断仍待验；T04 的 PG 实库分页子项已勾选，完整 Tauri 目录刷新/分页分段测量、整体 p95 和旧同环境基线仍缺。T05—T09 和 F01—F05 没有被本轮数据库结果替代。证据、复现及失败边界见 [Docker 补验汇总](../../performance/docker-database-validation-2026-10-17.md)。
