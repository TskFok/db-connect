# MySQL 查询取消与连接池释放实施计划

> **执行者要求：**使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施；使用复选框记录进度。2026-09-30 执行记录见下方复选框及 `docs/performance-baseline.md`。

**目标：**MySQL 业务池耗尽时仍可取消 SQL 编辑器查询，并消除登记线程编号的额外 SQL 往返。

**架构：**查询执行方持有业务连接直至取消清理完成；取消控制按连接和执行标识登记，使用独立短连接发送取消 SQL。新增独立生命周期模块覆盖等待连接、执行、取消和完成状态，不扩大业务连接池。

**技术栈：**Rust、Tokio、mysql_async、Tauri 2、现有 Rust 单元测试及 Vitest。

**Spec：**[性能优化总览](2026-09-30-performance-00-overview.md)。执行前同时阅读总览与本文件。

## 全局约束

- 默认在当前分支修改；未获用户明确要求不得新建分支。
- 禁止在循环遍历中查询 SQL；`Promise.all(map(查询))` 同样不合规。
- 本轮按后续执行指令实施；不自动提交或推送，数据库验证仅使用隔离测试实例。
- 如用户后续授权提交，使用英文 type 加简体中文描述，如 `fix: 修复连接池耗尽时无法取消查询`。
- 保持 MySQL 业务池上限 5、现有 TLS/SSH 配置和会话初始化行为，不通过扩池掩盖问题。
- 取消 I/O 总预算为 2 秒；原业务连接异常关闭另设 2 秒上限；这些是配置上限，不是实测延迟。
- 未传 `execution_id` 的调用维持现有执行方式；不扩展 PostgreSQL、SQLite、SQL Server、ClickHouse 的取消能力。
- 不重试用户 SQL，不将取消超时描述成“服务端已取消”，不回滚其他查询或其他连接。

## 已核实的起点

- [data.rs:1576](../../../src-tauri/src/commands/data.rs) 当前用 `SELECT CONNECTION_ID()` 登记查询。
- [data.rs:1733](../../../src-tauri/src/commands/data.rs) 当前从原业务池借连接发送 `KILL QUERY`。
- [connection.rs:415](../../../src-tauri/src/db/connection.rs) 池上限为 5；慢查询占满时取消也会排队。
- [data.rs:573](../../../src-tauri/src/commands/data.rs) 表浏览已有 `conn.id()` 与独立取消连接，可复用做法。
- [lib.rs:19](../../../src-tauri/src/lib.rs) 的 `RunningQuery::MySqlThread(u64)` 只保存线程编号，现有 map 仅以执行标识为键。

## 五项审查重点

1. 取消先于登记或发生在等待池期间：必须停止后续 SQL，不丢失早到取消；任务 1、3 覆盖。
2. 自然完成与取消同时发生：旧取消不得命中归还池后的下一条查询；任务 1、2 覆盖。
3. 同执行标识用于不同连接或重复请求：隔离连接，拒绝活跃重复登记，完成后的取消幂等；任务 1 覆盖。
4. 独立取消连接认证失败、权限不足或网络停顿：有界返回并报告真实结果，不阻塞业务池；任务 2 覆盖。
5. SSH、TLS 与会话初始化配置：取消连接使用当前物理连接配置，不泄露凭据，也不改变用户 SQL 的初始化；任务 2、4 覆盖。

## 文件责任

- 新增 `src-tauri/src/db/mysql_query.rs`：登记、状态转换、取消 I/O 和可注入测试边界。
- 修改 `src-tauri/src/db/mod.rs`：声明新模块。
- 修改 `src-tauri/src/lib.rs`：增加 MySQL 查询登记器，移除旧 MySQL 线程编号分支。
- 修改 `src-tauri/src/commands/data.rs`：接入新生命周期及 `conn.id()`，保留其他引擎分发。
- 新增 `src-tauri/src/db/mysql_query_bench_tests.rs`：默认忽略的单样本隔离实例基准。
- 新增 `scripts/performance/mysql-cancellation-benchmark.py`：创建并关闭独立临时实例，复现旧/新 × 冷/热采样。
- 新增 `src-tauri/vendor/mysql_async`、修改 `src-tauri/Cargo.toml` / `Cargo.lock`：固定原 0.37.0 的本地补丁，直接丢弃异常连接；原因与影响见该目录 `DB_CONNECT_PATCH.md`。
- 新增 `src-tauri/src/db/mysql_query_tests.rs`：离线生命周期、竞争与传输测试，由新模块通过 `#[cfg(test)]` 引入。
- 回归 `src/__tests__/SqlEditorExecutionPersistence.test.tsx`：取消后的界面状态和执行记录行为。

## 任务 1：建立按连接隔离的取消生命周期

**文件：**新增上述 `mysql_query.rs`、`mysql_query_tests.rs`；修改 `db/mod.rs`、`lib.rs`。

**接口：**

- `MysqlQueryRegistry::register(&self, conn_id: &str, execution_id: &str) -> Result<MysqlQueryGuard, String>`。
- `MysqlQueryRegistry::cancel(&self, conn_id: &str, execution_id: &str) -> impl Future<Output = Result<bool, String>>`。
- `MysqlQueryGuard::is_cancelled(&self) -> bool`，以及 `run<T>(&self, future: impl Future<Output = Result<T, String>>) -> Result<T, String>` 的异步方法。
- `AppState.mysql_queries: MysqlQueryRegistry`；其他引擎继续使用现有 `running_queries`。
- 内部状态为待登记取消、等待连接、执行中、取消清理中、已完成；待登记/完成墓碑最多 256 条、保留 60 秒，沿用表查询登记器的有界思路。

- [x] 编写失败测试 `mysql_query_early_cancel_stops_acquisition`：先取消再登记，模拟取连接 future 调用次数为 0。
- [x] 编写 `mysql_query_registry_scopes_and_rejects_duplicates`：两个连接相同执行标识互不影响；同连接活跃重复登记返回错误。
- [x] 编写 `mysql_query_finished_token_is_idempotent`：完成后重复取消返回 `false`，不会再次调用取消传输；过期墓碑可淘汰。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml mysql_query_`，确认新增断言在接口未实现时失败。
- [x] 实现状态机；用短临界区完成状态转换，网络 future 不持有登记器锁；guard 析构注销，不把同键的更新登记误删。
- [x] 明确兼容语义：`cancel_query` 仍返回 `Result<bool, String>`；未登记的有效 MySQL 执行标识可记为待取消并返回 `true`，已完成返回 `false`；正在取消的重复请求共享同一结果。
- [x] 重跑上述命令，要求全部通过；将状态转换和墓碑上限列入任务审查，暂不提交。

## 任务 2：实现独立且有界的取消传输

**文件：**修改新建的 `mysql_query.rs`、`mysql_query_tests.rs`；参考现有 `commands/data.rs` 的 `finish_mysql_table_query`，不改变该表浏览路径的行为。

**接口：**

- `MysqlQueryGuard::attach_connection(&self, thread_id: u64, opts: mysql_async::Opts) -> Result<(), String>`，只接收从真实连接取得的编号和配置。
- `async fn kill_mysql_query(opts: mysql_async::Opts, thread_id: u64) -> Result<(), String>`：在独立物理连接上只发送一次 `KILL QUERY <u64>`。
- `async fn finish_mysql_execution<T>(conn: mysql_async::Conn, result: Result<T, String>, guard: &MysqlQueryGuard) -> Result<T, String>`：同步完成与取消，决定归还或丢弃连接。
- 取消传输结果由登记器发布给等待的 `cancel` 调用；正常完成抢先成功则不发送取消 SQL。

- [x] 编写 `mysql_query_cancel_bypasses_busy_pool`：注入永远占满的业务池边界，独立连接工厂仍只调用一次；业务池借用计数不增加。
- [x] 编写 `mysql_query_cancel_timeout_is_bounded`：使用 Tokio 时间控制或短测试预算模拟建连/发送停顿，断言超时错误、没有无限重试。
- [x] 编写 `mysql_query_completion_race_keeps_original_lease`：通过屏障暂停取消发送，原业务连接在取消完成前不得释放；自然完成先赢时取消传输为 0 次。
- [x] 编写 `mysql_query_cancel_failure_discards_connection`：认证错误、无 KILL 权限、超时分别保留错误上下文，原连接不得重入池。
- [x] 先运行 `cargo test --manifest-path src-tauri/Cargo.toml mysql_query_` 记录失败，再实现最小传输与租约规则。
- [x] 将独立建连、KILL 和取消连接关闭纳入同一个 2 秒预算；异常业务连接关闭使用另一个 2 秒预算。
- [x] 从原连接克隆配置，保留 TLS/隧道端点；取消辅助连接不重放用户自定义会话 SQL，避免额外副作用，测试只检查配置属性、不打印密码。
- [x] 重跑测试；断言所有失败路径都唤醒等待者、清理登记；用户 SQL 不被再次执行，暂不提交。

## 任务 3：接入 SQL 编辑器命令并去掉登记 SQL

**文件：**修改 `src-tauri/src/commands/data.rs`、`src-tauri/src/lib.rs`，补充新模块测试。

**接口衔接：**保持 Tauri `execute_sql`、`cancel_query` 的参数和序列化返回类型；MySQL 执行使用任务 1 的 guard 和任务 2 的 finish helper。

- [x] 编写 `mysql_query_execution_uses_driver_thread_id`：捕获模拟协议调用，登记读取 `conn.id()`，没有 `SELECT CONNECTION_ID()`。
- [x] 编写 `mysql_query_cancel_during_wait_or_use_prevents_sql`：取消发生于池等待或设置数据库期间，用户 SQL 执行计数为 0。
- [x] 编写 `mysql_query_error_and_success_unregister`：执行成功、执行报错、结果预算超限都完成注销；错误连接仍丢弃。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml mysql_query_`，确认新增场景先失败。
- [x] 在等待池之前完成 MySQL 登记；取到连接后读取 `id()` 并绑定取消配置；设置数据库及执行 SQL 均检查取消状态。
- [x] 将 MySQL `cancel_query` 分发到新登记器，按 `conn_id` 确认数据库类型；删除旧 `MySqlThread` 分支，不改变其他引擎错误文案和能力。
- [x] 原执行结果错误优先保留；取消清理失败追加可理解的上下文；查询未确认终止时明确提示刷新确认，不能声称未执行或未提交。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml mysql_query_` 和 `cargo test --manifest-path src-tauri/Cargo.toml table_query`，全部通过后审查差异，暂不提交。

## 任务 4：验证端到端行为并采集性能证据

**文件：**回归现有 `src/__tests__/SqlEditorExecutionPersistence.test.tsx`；必要测试放入新建 `mysql_query_tests.rs`，不增加生产遥测系统。

- [x] 增加界面断言：取消确认与取消失败分别显示真实状态，旧执行结果不能覆盖新执行；未传执行标识仍可正常执行。
- [x] 运行 `npm test -- src/__tests__/SqlEditorExecutionPersistence.test.tsx`，要求通过。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml mysql_query_`、`npm run fmt:rust` 和 `git diff --check`，要求通过。
- [x] 使用可注入连接工厂、局部测试服务器或受控测试环境记录取消时长及租约释放；真实数据库压测仅使用隔离测试实例，不读取生产凭据。
- [x] 在隔离测试环境同时占满 5 个业务连接，记录取消请求 p50/p95、目标查询终止时间、连接池可用数恢复时间，以及普通查询执行前 SQL 数。
- [x] 将夹具、样本数、配置及结果补充到总览约定的 `docs/performance-baseline.md`，只写数量和时间，不记录凭据、完整 SQL 或结果。
- [x] 对照实现前后数据、五项审查重点和以下验收线检查；遇失败修正对应任务，不能仅靠提高超时或扩大连接池过关。

## 验收指标与回滚

- 离线测试中，池满取消不得调用业务池取连接；2 秒取消预算到期后必须报告超时，另有最多 2 秒业务连接清理。
- 受控低延迟环境目标：池满时取消确认 p95 不超过 500 ms；这是验收目标，不能未经测试写成已实现收益。
- MySQL 每次带执行标识的正常 SQL 少一条 `SELECT CONNECTION_ID()`；取消不会重放初始化 SQL，也不会重试用户 SQL。
- 竞争测试至少覆盖取消先到、登记后等待、执行中、自然完成先到、取消先赢、旧标识重复调用；误取消新查询次数为 0。
- 回滚按本计划的模块和命令接入整体撤销，保留既有结果预算及表浏览取消；恢复原 `RunningQuery` 结构必须同步恢复调用点。
- 回滚后明确记录“池满取消可能等待”的原有局限，不用扩大连接池作为替代回滚；没有数据迁移或持久化格式变化。
- 本计划全部复选框完成、测试通过且指标记录后，才能声称优化已实现；是否提交由用户后续决定。


## 实施调整与验证记录

- 按用户约束在当前 `master` 修改，未另建分支或工作树，未提交或推送。
- 生命周期、传输和命令接入串行完成；独立前端回归、隔离夹具准备及最终只读审查由子代理并行开展。旧 `MySqlThread` 在命令迁移后删除，保持中间步骤可编译。
- 带执行标识的实际查询由独立 Tokio 任务持有 guard 和原连接，调用方丢弃等待 future 时仍完成取消和清理。代价为一次任务调度。
- 协议替身复现原驱动 `disconnect()` 的多结果集问题：第二结果流停顿时，2 秒关闭超时后池槽仍被后台排空占用。原库没有公开强制关闭 API，因此保留同版本源码并仅新增 `disconnect_immediately`；没有新增依赖、升级版本、扩池或额外发送 KILL。代价是维护约 668 KiB 的上游源码快照及一个接口补丁。上游提供对应能力后可移除补丁。
- 修正清理阶段的状态转换：原连接关闭完成前，重复取消继续共享第一次取消结果，避免把取消失败误报为已结束。
- 任务 1/2/3 的接口缺失红灯均记录于执行 ledger；驱动多结果集和重复取消清理竞争均先复现失败，再修复通过。当前定向测试 16 项通过；默认忽略的真实实例基准单独运行。
- 独立最终审查未发现阻断问题，已核实 vendor 唯一源码差异。非阻断建议：未来可扩充取消建连、KILL、辅助关闭逐阶段停顿测试；当前整体 pending 用例及统一外层超时已验证总预算。

- 任务 4 隔离测量：旧/新 × 冷/热各 20 样本全部通过，取消 p95 从旧冷 1451.701 ms、旧热 1450.606 ms 降至新冷 1.263 ms、新热 1.437 ms。完整条件、服务端终止与容量恢复口径、集成检查限制见 [性能基线](../../performance-baseline.md)。临时服务已关闭。

- 最终集成：前端 1771/1771、Rust 732/732 通过（13 项显式环境测试默认忽略）；build/fmt/diff 检查通过。全仓 ESLint 的 3 条发布脚本错误及 Clippy 的 1 条 SQL Server 类型复杂度错误属于未修改文件的既有问题，完整位置见基线。
