# 长文档 SQL 补全增量解析实施计划

> 面向执行代理：逐任务执行时使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，用下列复选框记录进度。本文仅交付计划，不授权开始实现。

**目标：**保留现有补全语义和批量元数据能力，使长文档重复补全与局部编辑不再反复扫描无关历史 SQL。

**架构：**先为现有分析器增加共享 token 的入口，再按 Monaco 模型实例、版本及方言维护语句边界和 token 缓存。编辑仅重扫受影响的词法区间；无法证明安全复用时回退完整解析。缓存只保存语法结构，语义绑定始终使用当前元数据索引。

**技术栈：**TypeScript、Monaco Editor、现有 Vitest 与 rolldown，不新增运行时依赖。

**规格：**[性能优化总计划](./2026-09-30-performance-00-overview.md)。执行前同时阅读总计划和本文。

## 全局约束

- 本次只写计划，不修改业务代码，不执行数据库查询。
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

- [ ] 先写失败测试：同一 SQL 的文本入口与 token 入口在 `statement`、`edit`、作用域及候选上深度相等，覆盖 CTE、嵌套查询、UNION、UPDATE、INSERT 与不完整输入。
- [ ] 运行 `npm test -- src/__tests__/sqlCompletionContext.test.ts src/__tests__/sqlCompletionScopeParser.test.ts src/__tests__/sqlCompletionScopes.test.ts`，确认新增接口缺失导致预期失败。
- [ ] 实现两个 token 入口；保持 token 偏移为全文 UTF-16 坐标，不改变大小写、引用标识符和候选排序规则。
- [ ] 为 `resolveSqlCompletionScopes` 的现有输入增加可选 `syntax: { tokens: readonly SqlToken[]; blocks: readonly ParsedQueryBlock[] }`；当前查询块槽位分析也复用这些 token。
- [ ] 增加断言：提供 `syntax` 后不再调用完整分词器；相同语法输入换入新的 `SqlMetadataIndex`，候选使用新字段，不能复用旧语义结果。
- [ ] 重跑本任务命令并运行 `npm test -- src/__tests__/sqlCompletionCandidates.test.ts src/__tests__/sqlCompletionJoinProvider.test.ts`，全部通过后交付该任务供审查。

### 任务二：实现可证明安全的文档增量缓存

**文件：**新增 DocumentCache 与其测试；修改 Tokenizer；扩展 `src/__tests__/sqlCompletionTokenizer.test.ts`。

**拟新增类型：**`SqlDocumentChange = { rangeOffset: number; rangeLength: number; text: string }`，编辑坐标统一基于变更前文档。

**拟新增接口：**`createSqlCompletionDocumentCache(text: string, version: number, dialect: SqlDialect)` 返回 `applyChanges(changes: readonly SqlDocumentChange[], nextVersion: number): boolean`、`reset(text: string, version: number, dialect: SqlDialect): void`、`getStatement(offset: number): { statement: { start: number; end: number }; tokens: readonly SqlToken[]; blocks: readonly ParsedQueryBlock[] }`、`dispose(): void`。

`getStatement` 返回 `{ statement, tokens, blocks }`，类型采用任务一的绝对坐标结构；`applyChanges` 返回 false 表示事件或版本不能安全衔接，调用方必须用模型全文 reset。

- [ ] 写失败测试：每次编辑后缓存返回的语句范围、token、查询块与完整解析深度相等；覆盖分号增删、语句合并拆分、多光标非重叠编辑、撤销重做、中文与 emoji。
- [ ] 运行 `npm test -- src/__tests__/sqlCompletionDocumentCache.test.ts src/__tests__/sqlCompletionTokenizer.test.ts`，确认新增缓存入口缺失或工作量断言失败。
- [ ] 抽取词法扫描状态：普通文本、行注释、块注释及嵌套深度、引号种类与转义、dollar quote 标签；现有方言行为保持不变。
- [ ] 使用已确认处于普通词法状态的语句起点作为重扫检查点；删除引号或闭合符时向后扩展，直到词法状态与未变化后缀的边界均重新对齐，无法对齐则扫描至文末。
- [ ] 编辑按旧坐标从后向前应用；越界、重叠或版本不连续返回 false，由任务三重置；整篇 flush 由模型订阅直接 reset。多个编辑不得假设相互独立的词法影响。
- [ ] 将 token 存为语句分块的局部坐标，以语句索引维护偏移；仅为当前语句物化绝对坐标，不在每次末尾编辑时复制或遍历整库 token。语句查找使用有序边界二分。
- [ ] 只保留当前文本版本；查询块解析缓存最多 32 个语句，按最近使用淘汰；未变语句可复用语法，发生变化的语句清除其查询块缓存。
- [ ] 增加词法断言：跨行字符串、未闭合注释、嵌套注释、带标签 dollar quote、MySQL `--` 空白规则、反斜杠、SQL Server 独立行 `GO`、`GO` 标识符均与完整路径等价。
- [ ] 增加工作量断言：1MiB 多语句文档末尾普通标识符编辑，不重新扫描前面 19,783 条历史语句；中部编辑若状态不能收敛，允许安全重扫且结果必须正确。
- [ ] 重跑本任务命令；确认 reset、淘汰及 dispose 后无旧查询块可读，再交付任务审查。

### 任务三：接入模型生命周期并保留实时语义绑定

**文件：**修改 `src/utils/sqlCompletion.ts`、`src/utils/sqlCompletionEditor.ts`；扩展 `src/__tests__/sqlCompletionProvider.test.ts`、`src/__tests__/sqlCompletionEditor.test.ts`。

**接口：**保留 `registerSqlCompletionProvider(monaco, modelUri, getBinding)` 的公开签名；每个绑定模型实例使用任务二的缓存，模型对象身份优先于 URI。

- [ ] 先写失败测试：同一模型同版本连续补全只初始化全文一次；普通内容变更从 `onDidChangeContent` 接收 rangeOffset/rangeLength/text，不在每次候选计算调用 `getValue()`。
- [ ] 运行 `npm test -- src/__tests__/sqlCompletionProvider.test.ts src/__tests__/sqlCompletionEditor.test.ts`，确认现有 provider 尚未满足调用次数断言。
- [ ] 首次绑定按当前全文/版本/方言初始化；注册内容变更和销毁订阅，调用 `applyChanges`。flush、漏事件、版本不匹配或方言改变时从当前模型完整 reset。
- [ ] provider 通过 `getStatement` 将同一份 token/查询块传给任务一入口；候选生成每次读取最新 `binding.index` 和外键快照，禁止缓存带旧元数据的最终候选或语义作用域。
- [ ] 模型切换、provider dispose、模型销毁时同步解绑订阅和清空缓存；保留 requestSequence、取消令牌、sessionId、connectionRevision 与模型版本守卫。
- [ ] 增加断言：相同 URI 新模型不继承旧缓存；版本跳跃只重建一次；取消后不发布候选；反复切换模型后活动订阅数回到基线。
- [ ] 增加断言：方言切换重建语法；相同 SQL 的连接/元数据代次变化立即改变字段与 JOIN 建议，而同方言纯语法缓存仍可复用。
- [ ] 重跑本任务命令，并运行 `npm test -- src/__tests__/SqlEditorCompletion.test.tsx src/__tests__/sqlCompletionCache.test.ts src/__tests__/sqlCompletionForeignKeyCache.test.ts`，全部通过后交付审查。

### 任务四：复测长文档并确定是否需要后续 Worker

**文件：**新增 `src/__tests__/sqlCompletionDocumentPerformance.test.ts`；保留既有 `sqlCompletionPerformance.test.ts`，必要时复用其测试夹具。

**接口：**基准调用实际 provider 或其完整计算链、任务二缓存与真实分析器；元数据源使用 spy，禁止连接真实数据库。

- [ ] 固化上表相同的 49B/100KiB/1MiB 夹具和 1,000 表、50,000 列索引，各档热身 5 次后采样 20 次，输出 p50/p95、运行环境、候选数量。
- [ ] 分别测冷初始化、同版本重复补全、末尾单字符编辑后的补全；编辑场景计时必须包括缓存更新，避免仅将扫描成本移到内容变更回调。
- [ ] 确定性断言进入 CI：同版本额外全文分词为 0；末尾局部编辑不扫描历史前缀；三个档位候选内容等价；100 次热补全不增加元数据请求。
- [ ] 运行 `npm test -- src/__tests__/sqlCompletionDocumentPerformance.test.ts src/__tests__/sqlCompletionPerformance.test.ts`；墙钟结果只记录，不设跨机器脆弱门禁。
- [ ] 在同等本地环境评估目标：1MiB 热路径及末尾编辑路径 p95 均低于 15ms，短脚本无超过 1ms 的绝对退化；首次加载单独报告，不掩盖其线性成本。
- [ ] 运行 `npm test -- src/__tests__/sqlCompletion` 和 `npm run build`；记录既有失败与本次新增失败，所有本次相关测试必须通过。
- [ ] 在实际 WebView 另测候选出现延迟与超过 50ms 的主线程任务；只有长单条 SQL、冷初始化或必须回退全文扫描仍造成可复现长任务时，才另开 Worker 设计任务。

## 验收、交付与回滚

- 语义验收：所有差分测试、现有作用域/投影/JOIN 测试通过；不完整 SQL 的降级行为不倒退。
- 资源验收：每模型仅一个当前文档版本、最多 32 个查询块缓存；关闭全部编辑器后无残留订阅或可达文档缓存。
- 性能验收：分别报告冷/热/编辑基准及 WebView 结果；若未达本地 15ms 目标，列出剩余扫描区间与分配量，不能直接宣称完成或无条件引入 Worker。
- 回滚保持文本入口可用：撤销 provider 的增量缓存接入，恢复完整解析，并撤销对应模型订阅；元数据缓存与批量查询不受影响。
- 交付实现时记录改动文件、验证命令和基准结果；本文阶段不执行实现、提交、推送或依赖变更。
