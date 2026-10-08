# 长文档 SQL 补全增量解析实施计划

> 面向执行代理：逐任务执行时使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，用下列复选框记录进度。计划原为设计交付；2026-09-30 按用户后续指令执行实现，进度与证据记录在本文末尾。

**目标：**保留现有补全语义和批量元数据能力，使长文档重复补全与局部编辑不再反复扫描无关历史 SQL。

**架构：**先为现有分析器增加共享 token 的入口，再按 Monaco 模型实例、版本及方言维护语句边界和 token 缓存。编辑仅重扫受影响的词法区间；无法证明安全复用时回退完整解析。缓存只保存语法结构，语义绑定始终使用当前元数据索引。

**技术栈：**TypeScript、Monaco Editor、现有 Vitest 与 rolldown，不新增运行时依赖。

**规格：**[性能优化总计划](./2026-09-30-performance-00-overview.md)。执行前同时阅读总计划和本文。

## 全局约束

- 本次已按后续执行指令授权实现；补全缓存与性能基准只做本地计算，集成回归仅使用既有内存数据库和协议替身，不连接业务数据库。
- 默认在当前分支修改；用户未明确要求时不得新建分支。
- 禁止在循环遍历中查询 SQL；本计划的解析、缓存和基准必须为纯本地计算。
- 不得自动执行提交、推送，或安装、升级依赖；若未来另获提交授权，使用英文 type 开头、中文描述的 Conventional Commits。
- 保留现有元数据批量读取、60 秒缓存、进行中请求合并、失效代次及 JOIN 显式补全规则。
- 性能目标是待验收标准，不是已取得的收益；正确性与安全回退优先于缓存命中率。

## 五项审查重点

1. 字符串、注释、PostgreSQL dollar quote 内的分号不可成为语句边界；未闭合输入不得污染后续候选，归任务二测试。
2. 方言切换后 MySQL 注释/转义、SQL Server 独立行 `GO`、嵌套注释等规则不得复用旧解释，归任务二、三测试。
3. 多光标编辑、撤销重做、整篇替换及版本跳跃不得套用错误坐标；中文和代理对使用 Monaco UTF-16 偏移，归任务二测试。
4. 相同 URI 的新模型、模型销毁、provider 重绑及取消不得泄漏订阅或复活旧候选，归任务三测试。
5. 元数据或连接代次变化时，不变 SQL 的 CTE、别名、JOIN 和字段候选仍须立即重新绑定，归任务一、三测试。

## 证据与基线

- `src/utils/sqlCompletion.ts:424` 每次读取全文；`src/utils/sqlCompletionContext.ts:47` 先全文分词，再定位当前语句。
- `src/utils/sqlCompletionScopeParser.ts:64` 再次分词当前语句；`src/utils/sqlCompletionScopes.ts:488` 还会重新分析当前查询块。
- `src/__tests__/sqlCompletionPerformance.test.ts:55` 已验证 50,000 列索引的作用域读取与热缓存请求次数，但未覆盖完整解析链。
- 2026-09-30 本地微基准：Node v25.5.0、macOS arm64；rolldown 虚拟模块在内存打包实际解析器，未写仓库、未连接数据库。
- 预建 1,000 表、每表 50 列的索引；末尾活跃语句固定为 `SELECT t.column_0 FROM table_500 AS t WHERE t.col`，各档均返回 50 条候选。
- 历史语句重复 `SELECT id, name FROM historical_table WHERE id = 42;` 加换行，以空格补齐字节数；ASCII 输入的字节数等于 UTF-16 长度。
- 每档热身 5 次、采样 20 次，排序后取第 10 项为 p50、第 19 项为 p95；未强制触发垃圾回收。

| 脚本长度 | 历史语句数 |      p50 |      p95 |       最小—最大 |
| -------- | ---------: | -------: | -------: | --------------: |
| 49B      |          0 |  0.174ms |  0.325ms |   0.156—1.016ms |
| 100KiB   |      1,931 |  4.536ms |  5.280ms |   4.186—5.719ms |
| 1MiB     |     19,783 | 56.591ms | 61.422ms | 55.383—64.330ms |

测量范围仅为 `analyzeSqlCompletion → resolveSqlCompletionScopes → generateSqlCompletionCandidates`。不含索引构建、Monaco `getValue`、WebView、IPC、数据库和界面绘制，因此不是界面端到端延迟。

## 文件与接口边界

| 文件                                                             | 计划职责                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| `src/utils/sqlCompletionTokenizer.ts`                            | 保留完整分词接口；暴露可安全续扫的词法状态与语句边界 |
| `src/utils/sqlCompletionContext.ts`                              | 增加直接消费 token 的上下文分析入口                  |
| `src/utils/sqlCompletionScopeParser.ts`                          | 增加直接消费 token 的查询块解析入口                  |
| `src/utils/sqlCompletionScopes.ts`                               | 使用共享 token/查询块，避免内部再次分词              |
| `src/utils/sqlCompletionDocumentCache.ts`（新增）                | 文本版本、编辑应用、语句索引、增量失效和语法缓存     |
| `src/utils/sqlCompletion.ts`、`src/utils/sqlCompletionEditor.ts` | 模型生命周期接入、版本核对及已有取消守卫             |
| `src/__tests__/sqlCompletionDocumentCache.test.ts`（新增）       | 增量结果与完整解析的差分断言                         |
| `src/__tests__/sqlCompletionDocumentPerformance.test.ts`（新增） | 冷启动、热调用、局部编辑基准与确定性工作量断言       |

### 任务一：统一 token 消费入口并锁定现有行为

**文件：**修改上述 Context、ScopeParser、Scopes；扩展 `src/__tests__/sqlCompletionContext.test.ts`、`sqlCompletionScopeParser.test.ts`、`sqlCompletionScopes.test.ts`。

**拟新增接口：**`analyzeSqlCompletionTokens(input: { tokens: readonly SqlToken[]; statement: { start: number; end: number }; offset: number; dialect: SqlDialect }): SqlCompletionContext`。

**拟新增接口：**`parseSqlQueryBlocksFromTokens(tokens: readonly SqlToken[], statement: { start: number; end: number }, dialect: SqlDialect): ParsedQueryBlock[]`；现有文本入口保留为完整解析的兼容包装。

- [x] 先写失败测试：同一 SQL 的文本入口与 token 入口在 `statement`、`edit`、作用域及候选上深度相等，覆盖 CTE、嵌套查询、UNION、UPDATE、INSERT 与不完整输入。
- [x] 运行 `npm test -- src/__tests__/sqlCompletionContext.test.ts src/__tests__/sqlCompletionScopeParser.test.ts src/__tests__/sqlCompletionScopes.test.ts`，确认新增接口缺失导致预期失败。
- [x] 实现两个 token 入口；保持 token 偏移为全文 UTF-16 坐标，不改变大小写、引用标识符和候选排序规则。
- [x] 为 `resolveSqlCompletionScopes` 的现有输入增加可选 `syntax: { tokens: readonly SqlToken[]; blocks: readonly ParsedQueryBlock[] }`；当前查询块槽位分析也复用这些 token。
- [x] 增加断言：提供 `syntax` 后不再调用完整分词器；相同语法输入换入新的 `SqlMetadataIndex`，候选使用新字段，不能复用旧语义结果。
- [x] 重跑本任务命令并运行 `npm test -- src/__tests__/sqlCompletionCandidates.test.ts src/__tests__/sqlCompletionJoinProvider.test.ts`，全部通过后交付该任务供审查。

### 任务二：实现可证明安全的文档增量缓存

**文件：**新增 DocumentCache 与其测试；修改 Tokenizer；扩展 `src/__tests__/sqlCompletionTokenizer.test.ts`。

**拟新增类型：**`SqlDocumentChange = { rangeOffset: number; rangeLength: number; text: string }`，编辑坐标统一基于变更前文档。

**拟新增接口：**`createSqlCompletionDocumentCache(text: string, version: number, dialect: SqlDialect)` 返回 `applyChanges(changes: readonly SqlDocumentChange[], nextVersion: number): boolean`、`reset(text: string, version: number, dialect: SqlDialect): void`、`getStatement(offset: number): { statement: { start: number; end: number }; tokens: readonly SqlToken[]; blocks: readonly ParsedQueryBlock[] }`、`dispose(): void`。

`getStatement` 返回 `{ statement, tokens, blocks }`，类型采用任务一的绝对坐标结构；`applyChanges` 返回 false 表示事件或版本不能安全衔接，调用方必须用模型全文 reset。

- [x] 写失败测试：每次编辑后缓存返回的语句范围、token、查询块与完整解析深度相等；覆盖分号增删、语句合并拆分、多光标非重叠编辑、撤销重做、中文与 emoji。
- [x] 运行 `npm test -- src/__tests__/sqlCompletionDocumentCache.test.ts src/__tests__/sqlCompletionTokenizer.test.ts`，确认新增缓存入口缺失或工作量断言失败。
- [x] 抽取词法扫描状态：普通文本、行注释、块注释及嵌套深度、引号种类与转义、dollar quote 标签；现有方言行为保持不变。
- [x] 使用已确认处于普通词法状态的语句起点作为重扫检查点；删除引号或闭合符时向后扩展，直到词法状态与未变化后缀的边界均重新对齐，无法对齐则扫描至文末。
- [x] 编辑按旧坐标从后向前应用；越界、重叠或版本不连续返回 false，由任务三重置；整篇 flush 由模型订阅直接 reset。多个编辑不得假设相互独立的词法影响。
- [x] 将 token 存为语句分块的局部坐标，以语句索引维护偏移；仅为当前语句物化绝对坐标，不在每次末尾编辑时复制或遍历整库 token。语句查找使用有序边界二分。
- [x] 只保留当前文本版本；查询块解析缓存最多 32 个语句，按最近使用淘汰；未变语句可复用语法，发生变化的语句清除其查询块缓存。
- [x] 增加词法断言：跨行字符串、未闭合注释、嵌套注释、带标签 dollar quote、MySQL `--` 空白规则、反斜杠、SQL Server 独立行 `GO`、`GO` 标识符均与完整路径等价。
- [x] 增加工作量断言：1MiB 多语句文档末尾普通标识符编辑，不重新扫描前面 19,783 条历史语句；中部编辑若状态不能收敛，允许安全重扫且结果必须正确。
- [x] 重跑本任务命令；确认 reset、淘汰及 dispose 后无旧查询块可读，再交付任务审查。

### 任务三：接入模型生命周期并保留实时语义绑定

**文件：**修改 `src/utils/sqlCompletion.ts`、`src/utils/sqlCompletionEditor.ts`；扩展 `src/__tests__/sqlCompletionProvider.test.ts`、`src/__tests__/sqlCompletionEditor.test.ts`。

**接口：**保留 `registerSqlCompletionProvider(monaco, modelUri, getBinding)` 的公开签名；每个绑定模型实例使用任务二的缓存，模型对象身份优先于 URI。

- [x] 先写失败测试：同一模型同版本连续补全只初始化全文一次；普通内容变更从 `onDidChangeContent` 接收 rangeOffset/rangeLength/text，不在每次候选计算调用 `getValue()`。
- [x] 运行 `npm test -- src/__tests__/sqlCompletionProvider.test.ts src/__tests__/sqlCompletionEditor.test.ts`，确认现有 provider 尚未满足调用次数断言。
- [x] 首次绑定按当前全文/版本/方言初始化；注册内容变更和销毁订阅，调用 `applyChanges`。flush、漏事件、版本不匹配或方言改变时从当前模型完整 reset。
- [x] provider 通过 `getStatement` 将同一份 token/查询块传给任务一入口；候选生成每次读取最新 `binding.index` 和外键快照，禁止缓存带旧元数据的最终候选或语义作用域。
- [x] 模型切换、provider dispose、模型销毁时同步解绑订阅和清空缓存；保留 requestSequence、取消令牌、sessionId、connectionRevision 与模型版本守卫。
- [x] 增加断言：相同 URI 新模型不继承旧缓存；版本跳跃只重建一次；取消后不发布候选；反复切换模型后活动订阅数回到基线。
- [x] 增加断言：方言切换重建语法；相同 SQL 的连接/元数据代次变化立即改变字段与 JOIN 建议，而同方言纯语法缓存仍可复用。
- [x] 重跑本任务命令，并运行 `npm test -- src/__tests__/SqlEditorCompletion.test.tsx src/__tests__/sqlCompletionCache.test.ts src/__tests__/sqlCompletionForeignKeyCache.test.ts`，全部通过后交付审查。

### 任务四：复测长文档并确定是否需要后续 Worker

**文件：**新增 `src/__tests__/sqlCompletionDocumentPerformance.test.ts`；保留既有 `sqlCompletionPerformance.test.ts`，必要时复用其测试夹具。

**接口：**基准调用实际 provider 或其完整计算链、任务二缓存与真实分析器；元数据源使用 spy，禁止连接真实数据库。

- [x] 固化上表相同的 49B/100KiB/1MiB 夹具和 1,000 表、50,000 列索引，各档热身 5 次后采样 20 次，输出 p50/p95、运行环境、候选数量。
- [x] 分别测冷初始化、同版本重复补全、末尾单字符编辑后的补全；编辑场景计时必须包括缓存更新，避免仅将扫描成本移到内容变更回调。
- [x] 确定性断言进入 CI：同版本额外全文分词为 0；末尾局部编辑不扫描历史前缀；三个档位候选内容等价；100 次热补全不增加元数据请求。
- [x] 运行 `npm test -- src/__tests__/sqlCompletionDocumentPerformance.test.ts src/__tests__/sqlCompletionPerformance.test.ts`；墙钟结果只记录，不设跨机器脆弱门禁。
- [x] 在同等本地环境评估目标：1MiB 热路径及末尾编辑路径 p95 均低于 15ms，短脚本无超过 1ms 的绝对退化；首次加载单独报告，不掩盖其线性成本。
- [x] 运行 `npm test -- src/__tests__/sqlCompletion` 和 `npm run build`；记录既有失败与本次新增失败，所有本次相关测试必须通过。
- [x] 在实际 WebView 另测候选出现延迟与超过 50ms 的主线程任务；只有长单条 SQL、冷初始化或必须回退全文扫描仍造成可复现长任务时，才另开 Worker 设计任务。

## 验收、交付与回滚

- 语义验收：所有差分测试、现有作用域/投影/JOIN 测试通过；不完整 SQL 的降级行为不倒退。
- 资源验收：每模型仅一个当前文档版本、最多 32 个查询块缓存；关闭全部编辑器后无残留订阅或可达文档缓存。
- 性能验收：分别报告冷/热/编辑基准及 WebView 结果；若未达本地 15ms 目标，列出剩余扫描区间与分配量，不能直接宣称完成或无条件引入 Worker。
- 回滚保持文本入口可用：撤销 provider 的增量缓存接入，恢复完整解析，并撤销对应模型订阅；元数据缓存与批量查询不受影响。
- 交付实现时记录改动文件、验证命令和基准结果；本次不提交、推送或变更依赖。


## 2026-09-30 执行记录

### 实现与裁定

- 用户后续要求完成本计划，已在当前 `master` 实现；未创建分支或工作树，未提交/推送，未安装或升级依赖，未连接真实数据库；补全与性能基准无数据库查询。
- 任务一：保留文本兼容入口，新增共享 token 的上下文和查询块入口；作用域解析的输入类型要求至少提供文本或语法，预解析路径完全省略全文。语义绑定每次消费当前元数据。
- 任务二：新增文档缓存，普通词法状态的分隔符末尾是安全重扫点，只有最后一次编辑之后与未变后缀边界对齐才复用后缀。scanner 保留全文行上下文，避免 SQL Server GO 被分段文本误判；字符串/注释/dollar quote 的状态保留在原子扫描循环中，不需要跨 token 挂起状态。局部坐标、二分查找、32 项 LRU 及末尾原地更新已实现。
- 任务三：provider 首次有效补全时绑定实际模型对象并读取全文，后续订阅内容和销毁事件。版本跳跃、漏事件、flush 和方言改变安全 reset；不同模型对象（包括相同 URI）、销毁和 provider 重绑释放旧订阅。取消、序列号、session、连接代次和版本守卫保留，并在返回候选前复核。
- 任务四：新增完整计算链基准、确定性工作量测试和可复现 Node 脚本。Node 正式采样环境、原始数据、冷/热/编辑路径和限制见 [性能基线](../../performance-baseline.md#04长文档-sql-补全2026-09-30)。

### 验证与审查

- 执行前 SQL 目录基线：15 文件、349 项通过。
- 任务一新增入口先出现 21 个预期失败；实现后定向测试通过。独立审查发现输入参数可能同时缺少文本和语法，已用联合类型和先失败后通过的类型回归修复。
- 任务二先因缓存入口缺失失败，最终 24 项定向测试通过。独立审查另外执行 50,000 次五方言多编辑历史差分、50,000 个旧 tokenizer 对照和 6 项复杂查询块平移，未发现阻断缺陷。
- 任务三新增 8 项失败暴露全文重复读取、无生命周期订阅及计算中取消后仍返回候选；接入后通过。覆盖相同 URI 新模型、漏事件/版本跳跃、订阅释放、CTE 元数据更换、方言规则及 JOIN 快照代次更新。
- 全量首轮 149 文件/1,977 项，其中 6 项失败来自旧 `sqlCompletion.test.ts` 模型替身缺少事件接口，已改用支持真实事件契约的公共测试夹具；其余 1,971 项通过。修复后 SQL 目录 17 文件、407 项通过。
- `npm run build` 通过，保留既有大 chunk 和 ineffective dynamic import 提示；`npm run fmt:rust` 通过。

- 资源补验发现并修复 P1：token 的全文切片保留旧全文背板，400 次不同语句编辑后堆增长约 408 MiB。最终只在新 token 入库时复制 UTF-16 文本；25 项缓存/分词测试、独立 Node GC 回归及 JSC 对照通过，详见性能基线。最终正式性能采样已在修复后的代码上重跑。
- 修复前后 Node 原始样本保存在 `docs/performance/sql-completion-2026-09-30.json`：1 MiB 热 p95 由 61.889 ms 降至 0.119 ms，末尾编辑 p95 由 63.405 ms 降至 0.304 ms；冷初始化 p95 由 63.567 ms 变为 74.535 ms，单独报告且不作为热路径收益。49 B 最大 p95 绝对增加 0.688 ms，小于 1 ms。
- 最终资源补修后再次运行前端全量：**149 文件、1,978 项全部通过**；最终 `npm run build`、新增/修改 TS 与 Node 脚本的定向 ESLint、Prettier 检查及 `git diff --check` 通过。
- Rust 默认沙箱首轮 13 个 loopback 协议替身测试因禁止 bind 失败；允许测试监听本地端口后 `npm run test:rust` **771 项通过、18 项默认忽略**，未启用真实数据库忽略测试。
- 全仓 `npm run lint` 仍有 3 个既有错误：`scripts/release.mjs:203,211` 的 `preserve-caught-error` 和 `scripts/release.node-test.mjs:382` 的 `no-undef`；`npm run lint:rust` 仍受 `src-tauri/src/db/sqlserver_objects.rs:629` 既有 `type_complexity` 阻塞。这些文件未在本次修改。

### 2026-10-08 WebView 验收

- 真实 Monaco 与生产 provider 在独立 WKWebView 完成三档冷/热/编辑采样，每组 5 次热身、20 次正式样本，225 次有效触发均返回 50 项候选并显示真实菜单。49 B 热组另有 1 次失焦样本按有上限的策略重试，原始失败记录保留；其余组无丢弃。
- 1 MiB 热补全和末尾编辑的菜单出现延迟 p95 为 105/106 ms；同步 provider p95 均为 1 ms，编辑 `applyEdits` p95 为 1 ms。菜单耗时包含 Monaco 调度，不属于 Node 15 ms 计算链目标。
- 1 MiB 冷初始化的菜单 p95 为 190 ms，单次同步 provider p50/p95 为 73/79 ms、最大 96 ms，20/20 项均超过 50 ms，满足后续 Worker 设计条件。首次完整扫描成本没有被热路径收益掩盖。
- 环境为 macOS 26.5.2、WebKit `21624.2.5.11.8`。该运行时不支持 Long Task 和 JS heap API；同步调用计时可证明已发生的阻塞，但不能排除未测渲染阶段的长任务。夹具关闭单词高亮等非补全功能，未测完整打包 Tauri、长单条 SQL 和必须全文回退的编辑。
- 本次补验仅调整独立测量脚本与文档；脚本的 ESLint、独立 TypeScript、Prettier、`bash -n` 检查及 Swift 编译/完整执行通过。焦点握手、模型切换引发的高亮取消异常已在测量工具中处理，未修改业务源码或吞掉全局异常。
- 独立复核逐项重算 WebView 原始样本，p50/p95/最大值/超过 50 ms 的计数均与汇总一致。启动脚本增加本次 Vite 成功监听日志及进程存活校验；使用已占用的本地端口验证，脚本以状态 2 退出且没有启动 WebView、没有误用旧服务。
- 原始数据见 [WebView 证据](../../performance/sql-completion-webview-2026-09-30.json)，完整定义及复现命令见 [性能基线](../../performance-baseline.md#wkwebview-补验2026-10-08)。至此本计划四项实现和本地验收完成，保留上述测量边界与既有仓库 lint 问题。

### Worker 后续设计任务（待开展）

触发证据为本次 WKWebView 的 1 MiB 冷组连续 20 项同步调用超过 50 ms；本节登记独立后续设计工作，本次不实现 Worker，也不创建新聊天或分支。

- [ ] 比较 Worker 首次扫描、主线程分片与按需语句扫描的成本，测量文本/token 传输、结果合并及峰值内存，避免仅将阻塞转移到序列化。
- [ ] 沿用模型身份、文档版本、方言与取消守卫；语义候选继续绑定最新元数据，明确异步结果过期和 Worker 销毁策略。
- [ ] 补充长单条 SQL、未闭合字符串/注释导致重扫至文末，以及真实打包应用的冷路径基线；热补全和末尾局部编辑不得倒退。
- [ ] 用同一三档夹具和真实 WebView 比较候选延迟及同步阻塞，形成设计后再决定是否实施，不以 Node 墙钟替代界面测量。
