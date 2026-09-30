# 结果集与缓存内存实施计划

> 执行说明：使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐任务实施。2026-09-30 已执行；复选框与末尾记录反映验证状态。

**目标：**将表浏览和完整字段回查纳入结果预算，控制跨标签、跨语句结果的可回收内存，同时保护编辑与正在使用的数据。

**架构：**Rust 在单次 SQL 结果流的消费过程中计数，保留现有返回结构与错误路径；前端由共享协调器仅登记估算字节和回收回调，原始行仍由现有 store/执行上下文拥有。UI 明确区分“空结果”和“结果已释放”。

**技术栈：**Rust、各数据库现有驱动、Tauri、TypeScript、Zustand、React、Vitest。

**规格：**[性能优化总计划](2026-09-30-performance-00-overview.md)。本计划先实现内存内预算与释放，不引入磁盘结果存储或 Channels。

## 全局约束与行为

- 沿用总计划：当前分支、禁止循环 SQL、保护数据语义、不自动提交/推送。流式消费已有结果不新增 SQL。
- SQL 编辑器维持单结果 100,000 行/32 MiB；表浏览页大小在后端校验为 1–10,000，表浏览和完整行回查统一使用 32 MiB JSON 字节预算，完整行回查保留 100,000 行防线。
- 超限返回中文错误，不返回“成功但截断”的数据。MySQL 预览字段与真实完整字段分别按实际返回值计数。
- 新增前端 `RESULT_CACHE_BUDGET_BYTES = 128 * 1024 * 1024`，按唯一结果身份估算且只在接收时计算一次；这是软预算，不等同于 JS heap 或进程 RSS。
- 按最近使用时间回收未受保护的行载荷，保留 SQL、列信息、错误/成功摘要、筛选和位置。SQL 结果释放后显示“结果已释放，请重新执行以查看数据”，不自动执行原 SQL。
- 当前可见结果、存在未提交修改的表页及租约中的导出/复制/编辑数据禁止回收；全部受保护时允许暂时超预算并暴露状态，保护解除后重新回收。
- 运行中的多语句 SQL 每条成功结果返回后立即登记；仅保护最近返回的结果，不把整批历史结果全部钉住。释放只影响结果保留，不改变后续语句执行顺序。

## 文件职责

| 路径                                                                                                                                                                | 变更                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `src-tauri/src/db/result_budget.rs`                                                                                                                                 | 复用预算，增加测试用构造器和已接收字节读取            |
| `src-tauri/src/commands/data.rs`                                                                                                                                    | MySQL 表查询/完整行回查、入口页大小校验及错误清理     |
| `src-tauri/src/db/{postgres,sqlite,sqlserver,clickhouse}.rs`                                                                                                        | 对齐表查询/完整行预算，保留 ClickHouse 已有服务端限制 |
| `src/utils/resultCacheBudget.ts`（新增）                                                                                                                            | 无大字符串分配的估算、LRU 决策、保护租约和回收登记    |
| `src/stores/databaseStoreState.ts`、`src/stores/databaseStore.ts`                                                                                                   | SQL 结果身份、释放状态与生命周期                      |
| `src/stores/tableDataStore.ts`                                                                                                                                      | 表快照回收、脏页保护、恢复参数与迟到请求隔离          |
| `src/components/sql/SqlEditor.tsx`、`src/components/table/TableData.tsx`                                                                                            | 已释放状态、进行中结果登记、用户操作租约              |
| `src/__tests__/resultCacheBudget.test.ts`（新增）                                                                                                                   | 预算、估算、租约和唯一身份测试                        |
| `src/__tests__/{tableDataStore,databaseStore}.test.ts`、`SqlEditorMultipleResults.test.tsx`、`SqlEditorExecutionPersistence.test.tsx`、`TableDataDeferred.test.tsx` | 现有行为回归                                          |

## 拟新增接口

```ts
type ResultCacheKey = string;
interface ResultCacheRegistration {
  key: ResultCacheKey;
  estimatedBytes: number;
  evict: () => void; // 释放拥有方的所有行引用；协调器不保存 rows
}
interface ResultCacheController {
  track(entry: ResultCacheRegistration): void; // 同 key 替换登记，不重复计费
  touch(key: ResultCacheKey): void;
  pin(key: ResultCacheKey): () => void; // 返回可重复调用但只释放一次的租约
  remove(key: ResultCacheKey): void;
  enforce(): { retainedBytes: number; overBudget: boolean };
}
```

新增 `createResultCacheController(budgetBytes: number): ResultCacheController` 与 `estimateResultBytes(columns: readonly string[], rows: readonly unknown[][]): number`。估算通过值遍历计算，不用 `JSON.stringify` 构造完整结果副本；只覆盖当前协议中的 JSON 值及已知预览标记。

同模块导出唯一应用级实例 `resultCacheController = createResultCacheController(RESULT_CACHE_BUDGET_BYTES)`；两个 store、内嵌编辑器及进行中的执行上下文均使用它，不能各自创建一份 128 MiB 预算。单测通过工厂创建隔离实例。导出/复制调用 `resultCacheController.pin(cacheKey)`，最终调用返回的 release；没有登记行载荷的操作使用空 release，不伪造另一份缓存记录。

`SqlStatementResult` 新增可选 `cacheKey`、`retention: "resident" | "evicted"`、`retainedRowCount`；旧数据默认 resident。兼容字段 `SqlTabResultState.result` 若引用被释放结果，也须同步清理，避免伪回收。表快照增加相同的驻留标记，页面状态与行载荷分离。

键包含连接运行期 ID、标签/表身份和执行或加载代次。执行上下文到 store 的所有权移交沿用同一个键，更新回收回调，不让闭包继续持有旧行数组。

## 任务 1：预算与早停语义

**文件：**`result_budget.rs`，各驱动文件的现有测试模块，`commands/data.rs`。

**接口：**新增 `ResultBudget::with_limits(max_rows: usize, max_bytes: usize)` 和 `bytes(&self) -> usize`；默认值及现有 `add_columns`/`add_row` 行为保持兼容。

- [x] 补关键测试：恰好达到预算成功，多 1 字节/1 行失败；中文、转义字符、NULL、二进制展示的 JSON 计数正确。用小测试预算验证，不为每个单测分配 32 MiB。
- [x] 验证表入口页大小 0、10,001 在获取连接前被拒绝；1、10,000 合法。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml result_budget`，先确认新断言在未实现时失败，再实现预算接口与入口校验并复跑。
- [x] 记录 API 保持兼容；预算错误文字不能泄露 SQL、字段值或连接信息。

## 任务 2：适配器按单次结果流计数

**文件：**`commands/data.rs`、`db/postgres.rs`、`db/sqlite.rs`、`db/sqlserver.rs`、`db/clickhouse.rs`。

**接口：**保持 `query_table_data`、`query_full_rows` 的现有请求/返回字段；不增加逐行或逐主键 SQL。

- [x] 编写预算早停测试：超限后不继续消费剩余结果，不发布半页；同一池后续查询可成功，取消/超限后的旧句柄不能复用到新查询。
- [x] 将 MySQL `.query/exec → Vec<Row>` 和 PG 全量 `simple_query` 表读取改为各驱动已有的单次结果流路径；SQLite 在行推进时检查，SQL Server 在流推进时检查。保留文本协议展示、反向翻页顺序、空页列名及大整数边界。
- [x] 完整字段回查对请求的主键集合执行一次集合查询并逐行检查；超限时整次复制/导出失败，禁止通过循环小查询绕开上限。
- [x] 保留 ClickHouse 的服务端行/字节限制及客户端校验；检查预算异常后的连接释放/取消，而非通过读取剩余大结果来排空连接。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml`、`npm test -- src/__tests__/TableDataDeferred.test.tsx src/__tests__/tableDataCancellation.test.ts`。在独立 SQLite 内存库及驱动替身上覆盖大字段、无主键、复合键、空表和错误后续查询。

## 任务 3：共享缓存预算与保护租约

**文件：**新增 `resultCacheBudget.ts`/对应测试；修改两个 store 和 `databaseStoreState.ts`。

**接口：**实现本文件定义的协调器；测试注入小预算，生产使用 128 MiB。回收索引只持有元信息，不保留被释放 rows 的副本或闭包引用。

- [x] 编写并观察测试失败：同 key 只计费一次；最旧未保护项先回收；多次 pin 需全部释放；重复 release 幂等；全保护时 `overBudget=true`；解除保护立即可回收。
- [x] 实现估算与协调器，证明普通数字/字符串、Unicode、预览对象的估算稳定；预算变化不触发每帧或每次渲染全量扫描。
- [x] 将表页与 SQL 结果登记到协调器；关闭标签、断线、重跑、失败替换时注销旧代次，迟到响应不得重新登记已关闭对象。
- [x] 表页存在待提交修改时持有租约；已淘汰表恢复只读浏览时按原筛选/排序/页大小重新加载，失效旧游标与行选择，保留可恢复的滚动意图，不能直接把旧行选择应用于新页。
- [x] 运行 `npm test -- src/__tests__/resultCacheBudget.test.ts src/__tests__/tableDataStore.test.ts src/__tests__/databaseStore.test.ts`，检查恢复后不丢编辑、跨连接互不覆盖、重复视图引用不重复收费。

## 任务 4：执行中累计结果与 UI 集成

**文件：**`SqlEditor.tsx`、`TableData.tsx`、现有结果持久化/多结果/延迟字段测试、`docs/query-result-limits.md`。

**接口：**每条已返回的结果使用独立 `cacheKey`；结果释放与 SQL 执行错误分别呈现。复制/导出开始时获取 `pin(key)` 租约，所有成功/异常/取消出口在 `finally` 释放；06 复用这个契约。

- [x] 编写多语句测试：20 个合成 SELECT 结果在执行过程中受预算管理，早期结果可释放且保留摘要，最后结果保留；后续写语句执行顺序不变，不因回收自动执行任何 SQL。
- [x] 实现已释放结果提示，禁用依赖完整行的操作；仅用户明确执行时重跑。内嵌 SQL 编辑器与独立标签走相同保留策略。
- [x] 测试切标签、关闭、查询进行中重挂载、导出租约、编辑脏页、回收期间迟到结果；确保本地执行数组、store 兼容字段及回调均不残留已释放行引用。
- [x] 运行 `npm test -- src/__tests__/SqlEditorMultipleResults.test.tsx src/__tests__/SqlEditorExecutionPersistence.test.tsx src/__tests__/TableDataDeferred.test.tsx` 和 `npm run build`。
- [x] 以相同数据打开 1/10/30 个结果标签，记录 GC 后 JS heap、峰值 RSS 和已登记字节；将软预算、保护例外、释放提示写入文档和 `docs/performance-baseline.md`。

## 审查重点

1. 预算失败后连接仍可复用或安全销毁，无半页成功：任务 1/2。
2. 关闭/断线后迟到结果不能复活缓存：任务 3/4。
3. 待提交编辑和导出租约保护的数据不被淘汰：任务 3/4。
4. 同一结果被多个字段引用时真正释放、只计费一次：任务 3/4。
5. 多语句执行过程中即可回收，SQL 不被跳过或自动重跑：任务 4。

## 验收与回退

- 自动化硬断言是预算、调用次数和生命周期；不承诺 128 MiB RSS 上限，单条驱动协议消息的分配也可能先于应用检查。
- 实测关注标签数增加后的可回收行载荷是否受约束，以及回收后实际堆内存是否下降；全保护状态须单独列出。
- 后端预算与前端缓存分别落地、分别回退；前端回收出现兼容问题时可保留显式清理和预算提示，不能丢编辑。回退不扩大后端已建立的结果上限。
- 每任务完成后按总计划运行适用检查。若随后获准提交，建议标题：`fix: 限制表查询与多标签结果内存`；本计划不执行提交。


## 2026-09-30 执行记录

已在当前 `master` 完成实现和独立代码审查，未新建分支/工作树，未提交或推送，未安装依赖。

- 后端表浏览与完整字段回查纳入现有结果预算；MySQL/PG 改为单次流消费，SQLite/SQL Server 逐行校验，ClickHouse 保留服务端和 HTTP 上限并补展示结果预算。MySQL 异常直接断开，避免排空大结果；预览字段转换索引每个结果只计算一次。
- 前端采用唯一 128 MiB 软预算实例，新增 `transfer(key, evict)` 以免所有权移交时重复估算。表页与 SQL 行载荷按 LRU 回收，保留摘要与恢复参数；兼容字段及执行上下文别名同步释放。
- 可见页、脏页、复制/导出及整个单元格编辑会话有租约保护。为覆盖隐藏但仍挂载的编辑弹窗，最小扩展 `EditableCell.tsx` 的 `acquireEditLease` 接口。
- 每条 SQL 结果返回即登记，关闭/断线/卸载立即清理，迟到响应不复活数据；独立审查发现并修复旧 EXPLAIN 覆盖新脚本的竞态。EXPLAIN 前端请求标识不传给后端取消接口。
- 旧分页测试调整为接收估算完成后设置读取哨兵，并验证重渲染不扫描后续页；结果状态测试保留跨连接/结果选择/单结果替换断言并明确新增缓存元信息。

| 检查 | 最终结果 |
| --- | --- |
| `npm test -- --maxWorkers=2` | 142 文件、1820 项通过；首轮 4 项旧测试契约冲突已对齐并完整复跑 |
| `npm run build` | 通过，保留既有大 chunk 提示；首轮 3 处新测试 fixture 类型错误已修复 |
| `cargo test --manifest-path src-tauri/Cargo.toml --offline` | 739 通过、13 忽略；首次沙箱限制回环端口的 13 项失败在允许端口后全量复跑通过 |
| 后端预算回归 | 11 项通过，包含精确边界、早停、SQLite 大字段与同池后续查询 |
| `npm run fmt:rust`、`git diff --check` | 通过 |
| 修改的前端文件与基准脚本 ESLint / Prettier | 通过 |
| `npm run lint` | 仅 3 条既有错误：release.mjs 两处 error cause、release.node-test.mjs 的 URL；文件未修改 |
| `npm run lint:rust` | 仅既有 sqlserver_objects.rs:629 type_complexity；本次 2 处 clone_on_copy 已修复 |
| 独立代码审查与 EXPLAIN 定点复审 | 任务 1–4 的规格与代码质量均通过，无未解决阻断项 |

性能测量见 [性能基线](../../performance-baseline.md) 和 [39 份原始样本](../../performance/result-memory-2026-09-30.json)。相同生产 store 合成夹具下，30 标签 GC 后 V8 堆从约 432.18 MiB 降至 189.74 MiB，驻留 13 份、登记 126.71 MiB；全保护时允许超预算，解除后回收。峰值 RSS 未稳定下降，不宣称进程内存硬上限。

验证边界：1/10/30 标签测量在真实生产 Zustand store 的独立 Node/V8 进程完成，不包含 React/WebView/Rust/IPC；真实远程数据库及桌面应用整体内存未实测。页大小校验早于连接获取由源码顺序确认，没有构造 Tauri 命令端到端状态测试。早停由 SQLite 真实内存库、生产共享流替身及既有协议替身覆盖，未为每个表页/完整行入口新增真实数据库端到端测试；13 项默认忽略不计为通过。
