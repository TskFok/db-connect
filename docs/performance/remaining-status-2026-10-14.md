# 性能剩余任务执行记录（2026-10-14）

本轮已完成 T01 文档同步、T02 全仓静态检查修复、T05 的命令级页大小补验，以及 T10 的 CI 核对、集成检查与归档。**整份性能验收清单仍未完成**：T03—T09 仍有实库、完整主应用、分析工具和跨平台证据缺口。F01—F05 按清单约定独立跟踪，本轮没有扩大范围实施。

当前分支 `dd`，起点 `7a0f619831e87da914362f0b3d7d899a0b808421`；本轮未新建分支/工作树、提交、推送、发布、安装或升级依赖。用户原有未跟踪清单已保留并逐项更新。测试仅使用合成数据、空连接管理器、独立内存 SQLite 及协议替身，没有读取业务凭据或连接业务库。

## 环境与可复现检查

macOS 27.0.1 (26A434)、arm64、Node 25.5.0、npm 11.17.0、Rust/Cargo 1.93.1。默认 SDK 27 在本轮命令回归的 tauri build-script 链接时出现 `arm64e.x1` 架构错误；后续 Rust 命令仅设置 `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`，使用已安装 SDK，未修改系统配置。依赖离线解析，Cargo.lock 未变；tauri 仅为测试启用同版 `=2.11.3` 的 test feature。

集成命令按表中顺序单独执行，回环协议替身获准监听。详细退出码、时长、筛选后的原始测试行、输出哈希及代码差异哈希见 [集成记录](remaining-integration-2026-10-14.json)。忽略的实库测试不计为通过；构建已有大 chunk 及静态/动态混用提示没有被当成失败或消除。

| 命令 | 退出码 | 结果 |
|---|---:|---|
| `npm test -- --maxWorkers=2` | 0 | Test Files  158 passed (158)；Tests  2060 passed (2060) |
| `npm run test:release` | 0 | ℹ tests 42；ℹ pass 42；ℹ fail 0；ℹ skipped 0 |
| `npm run build` | 0 | 通过 |
| `npm run lint` | 0 | 通过 |
| `npm run test:rust` | 0 | test result: ok. 786 passed; 0 failed; 18 ignored; 0 measured; 0 filtered out; finished in 2.49s；test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s；test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s |
| `npm run fmt:rust` | 0 | 通过 |
| `npm run lint:rust` | 0 | 通过 |
| `git diff --check` | 0 | 通过 |

这些是正确性检查耗时，不是正式性能样本；不与旧 macOS 26.5.2 的 p50/p95 混算，也不据此报告新的端到端加速比例。

## 本轮实现与确定性证据

- T01：总览开头与 06 实际状态对齐；新增剩余清单入口；统一验收逐条区分可勾选证据和待测项。补丁说明覆盖 SQL 编辑器、表浏览失败/取消和完整行结果读取/预算失败，明确正常归还不变、KILL QUERY 与 KILL CONNECTION 的区别。历史日期记录保留。
- T02：两处发布推送错误保留原始 cause，完整中文提示不变；测试显式导入 URL。两项 cause 断言先以 undefined 失败，再修复通过；没有执行真实发布命令。SQL Server 外键聚合改为具名结构，排序、对象身份和不完整组合键整体丢弃保持不变。[定向与红绿记录](remaining-static-checks-2026-10-14.md)。
- T05：通过 Tauri MockRuntime 创建真实 AppState，直接调用生产 query_table_data，持锁时非法页大小首次 poll 即拒绝，合法边界等待连接锁、释放后报连接不存在。删除生产校验的负向变异被测试捕获，原始代码逐字节恢复；此为命令函数测试，**不等于真实 IPC 或完整桌面链路**。[命令证据](remaining-command-budget-2026-10-14.md)。

## CI 确定性覆盖核对

`.github/workflows/ci.yml` 在 Ubuntu/macOS/Windows 运行 npm test、Rust 单测、ESLint、rustfmt、Clippy 和 Tauri 构建。已有全量测试覆盖下列约束，没有重复增加等价测试，也没有新增墙钟性能门禁：

| 约束 | 现有测试依据 | 证据边界 |
|---|---|---|
| 集合 SQL、批量容量、去重保序 | `db/metadata_batch.rs` 及各引擎 metadata_batch 测试 | 离线 SQL/分组断言不代表实库权限 |
| 同键请求去重、失败重试、迟到隔离 | `metadataRequests.test.ts`、`metadataRequests.performance.test.ts`、`metadataRefreshReview.test.ts` | invoke 替身计数不代表真实 IPC 时延 |
| 元数据 256 / 游标 4096 / 300秒 TTL、失效和生命周期 | `db/table_pagination.rs` 的 metadata_cache/cursor 测试 | 实库 PG 网络计数待验 |
| 结果预算、整次失败、连接恢复 | result_budget、SQLite 内存库、MySQL/PG 协议替身 | 不是五种远程引擎表页/完整行全矩阵 |
| 缓存软预算、租约、脏页、迟到响应 | `resultCacheBudget.test.ts`、store、`TableDataDeferred.test.tsx` | 不等于完整应用内存测量 |
| 有界 DOM、键盘分页、跨页选择 | `tableRowSource.test.ts`、`DatabaseCompareResults.test.tsx`、`DatabaseSyncPreviewModal.test.tsx` | jsdom 交互不等于原生手工操作 |
| 导出精度、ZIP/XML、二进制文件与清理 | `excelExport.test.ts`、`excelWorkbook.test.ts`、Rust file_io | 不等于其他平台实机与系统磁盘故障 |

## 待验项目与继续所需条件

| 任务 | 本轮结论 | 后续所需条件 |
|---|---|---|
| T03 | 未完成；Docker 29.8.2 / linux arm64 可用，但无 SQL Server/ClickHouse 实例或镜像 | 专属实例、普通/受限账号夹具、服务端计数、两引擎独立 runner；SQL Server 还需核实执行架构 |
| T04 | 未完成；缺 PostgreSQL 镜像和分页实库计数；既有替身/历史数据不能充当本轮端到端样本 | PG 17 隔离实例、完整主应用 trace、1/10/50/100 目录与20次分页；旧多库端到端基线仍单列缺失 |
| T05 | 部分完成：页大小命令回归已补；全驱动/1、10、30标签完整链仍待验 | 当前完整隔离应用、各驱动大字段/主键/空表矩阵、Rust/WebView 归属与 IPC 字节计数 |
| T06 | V8累计托管堆辅助测量完成，中位数下降97.6915%；全部分配原指标仍未验 | 先证明工具覆盖目标的全部分配域与误差，再比较同机同构建的10000×200初始化边界 |
| T07 | 未完成；安装版1.12.0与仓库1.13.0不同，无本轮完整主应用交互证据 | 当前源码隔离应用配置、App根/子树/持久化观测、真实拖动与完整懒加载/列表操作 |
| T08 | 已完成当前可调用工具的探测与限制记录；综合工具确认项及原指标仍待验 | 完整 Xcode/可用 WebView 时间线、可信进程关联、Release与完整主应用阶段测量；当前只有CLT，xctrace不可录制 |
| T09 | 未完成；平台矩阵已登记，不能据此声称通过 | Windows/Linux实际桌面；各平台系统保存取消/三阶段关窗；受控小容量卷或明确标注的隔离故障注入 |
| T10 | CI核对、全仓检查和归档完成；整体原计划验收仍未完成 | T03—T09全部适用证据及缺失旧基线补齐后复核 |

数据库细节及逐驱动覆盖见 [数据库审计](remaining-database-audit-2026-10-14.md)；工具、WebView、平台与各指标的范围见 [测量审计](remaining-measurement-audit-2026-10-14.md)。原始历史 JSON 原样保留，没有把未运行、默认忽略、模拟异常或代理指标写成实测通过。

## T06 新增辅助样本与具体后续方法

独立脚本 `scripts/performance/table-row-source-allocation-benchmark.mjs` 已校准累计分配、GC后对象和外部ArrayBuffer差异。正式样本在全部构建/测试结束后单独执行；10000×200数字矩阵、旧/新各3个独立Node进程，旧V8累计托管堆分配中位数250,970,960 B，新值5,793,664 B，下降97.6915%。全部样本、校准、环境和代码哈希见 [原始证据](table-row-source-allocation-2026-10-14.json)，方法及命令见 [方法记录](remaining-allocation-method-2026-10-14.md)。

它覆盖已被GC回收的托管堆对象，但不计ArrayBuffer外部backing store，不能排除瞬态原生分配；`originalCriterionVerified=false`，原“全部分配下降70%”保持未验。后续需先确定全部分配域，用对应V8版本插桩或可归属的原生/外部累计事件补覆盖、校准误差并避免重复计数，再做同边界成对验证。不能将本次97.6915%或历史保留堆99.15%转写成原指标达标。

新脚本的node语法、Prettier、定向ESLint均通过；正式采样结束后又运行全仓 `npm run lint`，2026-10-14 15:38:12 +0800开始、15:38:18前结束，退出0。该补查覆盖在原集成检查后新增的脚本，没有与采样并行。

### 当前系统 WebView 能力补探针（2026-10-14）

在独立、nonPersistent WKWebView 仅读取内联HTML，实际WebKit为22625.1.29.11.28；PerformanceObserver存在，但supportedEntryTypes未宣告longtask，performance.memory和GC接口未暴露。本次原生进程已正常退出并回收，未运行性能基准、未读取业务配置。见 [接口能力JSON](remaining-webview-capabilities-2026-10-14.json) 和 [探针方法/源码](remaining-webview-capabilities-2026-10-14.md)。

这只核实当前隔离WebView公开API，不证明没有长任务，也不证明Inspector/系统工具不可观测。Inspector逐task事件、WebContent进程归属、完整主应用、最长任务和峰值仍未验证，因此T08第一综合探测项及原性能指标继续保留待验。此前只读审计中“尚未启动当前WebView”的描述是该审计阶段的历史状态，由本段的接口探针补充；其其他边界保持有效。
