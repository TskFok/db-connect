# T03—T05 只读核查（2026-10-14）

仓库：`/Volumes/CaseSensitive/workspace/myself/db-connect`。本记录完成时仅做源文件、工具路径、产物存在性及 Docker 只读探测；没有构建、运行测试、性能采样、启动容器、拉取镜像、安装依赖，也没有读取应用保存连接、业务凭据或访问业务库。后续获授权的 T05 命令回归实施另记 [命令补验记录](remaining-command-budget-2026-10-14.md)。

## 本机环境结论

- 经 `require_escalated` 只读执行 `docker version --format '{{json .Server}}'`、`docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}'`、`docker ps -a --format '{{.Image}} {{.State}}'` 成功。
- Docker Desktop 4.94.0，Engine 29.8.2，服务器 `linux/arm64`。本地镜像为 `mysql:8.4`、`mysql:8.0`、`redis:7-alpine`、`php:7.1-cli-alpine`、`moby/buildkit:buildx-stable-1` 及两个同 ID 的 bak 标签；没有 PostgreSQL、SQL Server、ClickHouse 镜像。
- 已有容器只列出运行中的 `moby/buildkit:buildx-stable-1`。未检查其环境变量、挂载、业务内容。
- `docker/cargo/rustc/node/npm` 可定位；`psql/postgres/clickhouse/sqlservr` 未在当前 PATH 发现；Homebrew opt 目录仅找到 `mysql@5.7`，未发现 PostgreSQL/ClickHouse 条目。不能据此断言整个磁盘绝无其他安装。
- `node_modules`、`src-tauri/Cargo.lock`、`src-tauri/target/debug/db-connect` 存在；debug 应用产物时间为 2026-10-13 10:54:10 +0800。release 应用产物不存在。仅存在性不证明产物对应当前源码、可运行或测量链完整。

| 对象 | 当前能否直接开展已有隔离验收 | 精确缺口 |
| --- | --- | --- |
| PostgreSQL | 不能运行现有脚本 | 缺脚本固定要求的 `postgres:17-alpine` 镜像；本次不拉取。脚本和目录权限夹具已有，但分页缓存实库计数及网络 p95 夹具未实现。 |
| SQL Server | 不能 | 缺目标服务/镜像、已验证可在本机 arm64 Docker 上执行的架构方案、专属普通/受限账号夹具、真实服务端计数及结果保存脚本。未验证 amd64 模拟能力，不能承诺镜像到位即可跑通。 |
| ClickHouse | 不能 | 缺目标服务/镜像、专属账号/权限/特殊目录夹具及服务端 query_log 观察方案、独立启动/清理脚本和证据文件。 |
| MySQL | 已有可用环境基础，未启动或测量 | 有两个 Docker 镜像及原生 5.7 路径；现有 5.7/8.4 元数据脚本可作为隔离模式参考。它们不自动提供 T05 全驱动预算验收。 |
| SQLite | 无外部服务器依赖 | bundled rusqlite 已有独立内存库回归；本次未执行。 |

## T03：SQL Server / ClickHouse 元数据

生产命令为 `src-tauri/src/commands/database/mod.rs:92` 的 `list_tables_batch`；公共 `metadata_batch::normalize_databases` 在取连接之前处理空输入与超过 256 个去重名称的请求。驱动入口：SQL Server `sqlserver.rs:314`，ClickHouse `clickhouse.rs:830`。两者均先规范化，再一次集合执行，再内存分组；未发现按目录循环 SQL 的实现。

- SQL Server：`sqlserver.rs:259` 构建参数化 requested CTE，联合 `sys.tables/sys.views`，集合读取 `sys.dm_db_partition_stats` 与注释。`metadata_batch_sqlserver_uses_one_parameterized_schema_set` 只是 SQL 字符串断言，不证明 DMV 权限、NULL 统计或失败整次返回的真实行为。
- ClickHouse：`clickhouse.rs:250` 从 `system.tables` 用 `database IN ?` 集合读取；`metadata_batch_clickhouse_groups_database_and_binds_names` 验证绑定 SQL 与内存分组，不是服务端权限验收。
- 现有两引擎的 `list_tables` 都直接包装新批量入口，因此不能把调用这两个包装器当作独立旧语义对照。新增验收应保留变更前单目录 SQL 的明确快照，与 PG `legacy_tables` 一样显式调用少量对照案例。
- 缺两引擎独立 fixture/test runner/result 文件。需要一次 DDL 初始化普通/受限账号、空/缺失/特殊名称/同名表/表视图/NULL 统计；显式生产调用、一次集合读取计数，并区分观察者 SQL 与被测 SQL。应验证空输入与 257 名称零 SQL、有效请求一次集合执行、去重保序、权限失败不伪装部分成功；不得用离线断言替代。
- 可复用回归命令（本次未执行）：`cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --lib metadata_batch`。MySQL 8/9 含空目录最多 2 条 SQL 的既有例外应保持。

## T04：真实应用与 PostgreSQL 分页缓存

已有证据边界：

- `scripts/performance/metadata-access-benchmark.py` 只支持原生 MySQL 5.7；目录案例 1/10/100，缺 50。每样本 Rust 生产路径计时，不含目录 IPC、WebView、数据页与 COUNT。旧路径只测单库；旧多库只有源码调用次数基线，没有旧多库端到端延迟。
- `metadata_bench_tests.rs:219` 的分页样本真实调用 MySQL 元数据冷/热读取，断言 2/0 条 SQL，但只比较一次热读，不是完整应用同表连续 20 次分页。
- `metadataRequests.performance.test.ts` 明示受控 invoke 替身，案例 1/10/100 和 20 个同键并发；其 p95 不能称 Tauri IPC、数据库或端到端实测。
- `table_pagination.rs:864` 对 MySQL/PG 做 20 次无导航热读的缓存回归，但读取闭包只递增整数并返回合成元数据；PG 的 1/0 是替身计数，不是服务端 SQL 计数。
- `metadata-postgres-validation.py` 已有随机名称容器、`--pull=never`、随机 loopback 端口、普通/受限账号、`pg_stat_statements`、标签校验清理及 0600 临时凭据模式。调用 ignored 测试 `metadata_access_isolated_postgres17`。历史 `docs/performance/metadata-postgres-2026-09-30.json` 记录 PG 17.10，管理员/受限用户目录各 1 条 SQL；不含分页缓存 SQL、网络 p95 或完整应用。
- PG 生产分页路径 `postgres.rs:496` 调 `load_table_metadata`，读取闭包 `fetch_table_page_metadata:458` 只有一条系统目录 SQL。需要用 PG 隔离服务的观察者实测首次 1、TTL 内 20 次 0、失效后 1，并保留可信主键、失效游标断言；显式案例调用，避免循环发 SQL。
- 并发去重、失败后重试、刷新后迟到/断线隔离已有 `metadataRequests.test.ts`、`metadataRefreshReview.test.ts`、`databaseStoreLazyTabs.test.ts`、`table_pagination.rs` 等确定性回归；它们不能替代完整应用网络采样。

尚缺：完整 Tauri 应用的专属隔离配置/启动清理入口；1/10/50/100 目录及连续 20 次分页的统一 trace；目录 IPC/总 IPC、目录 SQL/分页元数据 SQL、池等待、缓存命中、数据页/COUNT、前端准备/渲染、整体 p95 的拆分采样与同环境冷/热原始结果。现有导出/补全的独立 WebView/Tauri 工具不能直接宣称覆盖此链。旧多库端到端对照仍缺，不能报告其加速百分比。

## T05：命令级页大小最小方案

当前 `commands/data.rs:751` 校验 1..=10,000；生产 `query_table_data:764` 第一条语句调用校验，之后才登记执行句柄、锁 manager、取池。已有 `result_budget_page_size_rejects_invalid_boundaries:2002` 只调用私有校验函数，没有经过生产命令，无法阻止未来把校验下移到取连接之后。

最小可实施补验：

1. 仅增加同版 dev-dependency `tauri = { version = "=2.11.3", features = ["test"] }`，启用本地已安装 MockRuntime；不新增/升级 crate，不增加生产测试 helper。本地源码确认 tauri `State` 构造私有，`StateManager::new/set` 也不公开，不能直接构造。
2. `tauri::test::mock_builder().manage(AppState::new()).build(mock_context(noop_assets()))`；用 `tauri::Manager::state` 获取真实 `State<AppState>`。`AppState::new()` 的空 ConnectionManager 不加载保存连接或凭据。
3. 持有 `connection_manager.lock()`，直接调用真实 `query_table_data`，用单次 `futures_util::poll!` 断言 0/10_001/u32::MAX 都立即 Ready，错误为页大小越界；无需定时睡眠或超时性能门槛。
4. 同锁下合法边界 1/10_000 应 Pending；释放锁后继续轮询同一 future，应得到空 manager 的“连接不存在”。这项对照证明测试确实堵住了取连接路径。可用不同执行 ID，避免重复登记影响结论。
5. 先验证现有行为通过，再可逆移除/下移生产校验做负向变异，断言测试失败，然后立即恢复原始生产语句并复测。不得提交变异。

这证明真实命令函数先校验、后取连接；MockRuntime 不是真实 IPC/WebView 性能证据。拟定定向命令为 `cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --lib result_budget_page_size`，以实施后的真实测试名为准。本记录时未运行。

## T05：五驱动当前覆盖与剩余缺口

| 驱动 | 生产预算接入 | 已有测试性质 | 表页/完整行、无主键/复合键/空表与真实链缺口 |
| --- | --- | --- | --- |
| MySQL | `data.rs` 表页约 969、完整行约 1510 逐行 budget；失败立即断开有未读结果连接 | `mysql_query_tests.rs:617` 协议替身测 SQL 编辑器行超限、停滞多结果及池恢复；取消/旧句柄有协议及状态回归 | `mysql_deferred_fields.rs:462` ignored 隔离测试测大字段预览和复合主键回源，需显式测试 URL；无主键/隐藏主键/复合键另有 SQL 构建回归。没有已核实的真实表页/完整行超预算、空表、取消与新查询组合验收证据。 |
| PostgreSQL | `postgres.rs:555` 表页、`:1296` 完整行接 budget，失败丢弃连接 | `postgres_query_tests.rs:546/573` 本地协议替身测 100001 行/33 MiB、丢弃与替换连接；`:607/655/692` 取消/旧句柄/COUNT；`:481` 空结果列描述 | 没有实库表页/完整行大字段预算组合。分页主键可信度、无主键/复合键降级主要是共享离线回归；完整行生产命令此分支只接单列主键和值，不传 `primary_keys` map，不能报告复合键回源已覆盖。 |
| SQLite | 内存库真实 SQLite，表页/完整行共用逐行预算 | `sqlite.rs:2407` 独立内存表页及完整行超字节失败、空无主键表、后续 SELECT 成功；`:2393` 超行先于后续 SQL 错误；`:2978/2983/3092/3137` 表页/COUNT 取消及复用 | `:3195` 真实内存库复合主键完整行；`:3164` 无主键编辑拒绝。已有真实引擎回归，但本次未运行，也不代表 Tauri IPC/桌面内存测量。 |
| SQL Server | `sqlserver.rs:614` 表页、`:1701` 完整行经 `collect_query_stream:1743`/ResultBudget，错误 discard transport | `:1971/1999` 内存 duplex 传输关闭和池 broken 检查；公共 ResultBudget 合成 stream 测整次失败；复合 locator 为 SQL 构建/映射测试 | 没有真实 SQL Server 的表页/完整行超预算、后续连接、空表/无键/复合键或旧句柄验收。SQL 编辑器取消仍显式不支持；表查询协作取消也未实库验证，不能宣称服务器端终止已测。 |
| ClickHouse | `clickhouse.rs` 表页/完整行都经 HTTP body 限额与 JSON ResultBudget | `:1300` 合成 JSON 超行；`:1572` SQL 编辑器合成 JSON 超字节；`:1606` 响应块预算；`:1726` 无 locator 拒绝/复合 map SQL；`:1818` 取消设置兼容性闭包替身 | 只有 ignored `clickhouse_connection_manager_connects_to_local_instance` 的现成连接 smoke；没有隔离自建 fixture、真实表页/完整行超预算、空表/无键/复合键、取消与后续查询验收。 |

前端已有缓存预算/保护/释放/迟到隔离回归：`resultCacheBudget.test.ts`、`TableDataDeferred.test.tsx`、`tableDataStore.test.ts`、`tableDataCancellation.test.ts`。它们调用替身服务；`result-memory-benchmark.mjs` 是生产 Zustand store 的独立 Node/V8 采样，不含 React、WebView、Rust、IPC、数据库。缺完整应用 1/10/30 大结果标签、普通回收与全部租约保护的 Rust/WebView 内存、IPC 字节、登记载荷、实际回收量和采样归属证据。

100,000 行/32 MiB 为单结果 JSON 预算，128 MiB 为前端缓存软预算；租约/脏页/导出保护可使登记量超软预算，任何数值都不能作为进程 RSS 上限。

## 未执行项

本轮审计没有跑测试，因此不报告新增通过数或实库通过；没有生产性能新样本，也没有把历史 JSON 当本机本轮复测。仓库出现的其他修改来自并行任务；本轮只读部分没有修改仓库文件。
