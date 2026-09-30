# 目录批量读取与分页元数据缓存实施计划

> **执行者要求：**使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务实施；使用复选框记录进度。本文只规定计划，不代表接口已经存在或优化已经完成。

**目标：**将跨库目录刷新改为集合查询，合并同键进行中的请求，并让分页元数据缓存独立于游标有效性复用。

**架构：**新增 `list_tables_batch`/`listTablesBatch`，后端按数据库方言一次读取请求集合，前端按连接及规范化请求键合并 promise。分页元数据仍保留可信主键校验和游标 revision，新增独立缓存访问与分级失效，使用 generation 阻止旧请求回填。

**技术栈：**Rust、mysql_async、tokio-postgres、Tiberius、rusqlite、ClickHouse client、Tauri 2、TypeScript、Zustand、Vitest。

**Spec：**[性能优化总览](2026-09-30-performance-00-overview.md)。执行前同时阅读总览和本计划。

## 全局约束

- 默认当前分支；不擅自新建分支。本轮只写计划，不修改业务代码、不自动提交或推送。
- 禁止循环执行 SQL，包括 `Promise.all(map(listTables))`；允许纯内存映射或构造集合条件，禁止用逐库 SQL 分块兜底。
- 批量输入去重后最多 256 个名称；空输入直接返回空集合，超限明确拒绝，不拆成循环查询。这是拟新增边界。
- 不扩大数据库权限、不扫描未请求的数据库、不自动修改连接池或数据库配置。
- PostgreSQL/SQL Server 的 UI `database` 实际表示当前物理数据库中的 schema；SQLite 表示当前物理连接的 main/temp/attached schema。
- 保持 `TableInfo` 字段、估算行数及视图语义；不能为获取精确统计追加逐表 COUNT。
- 分页缓存沿用 TTL 300 秒、元数据最多 256 项、游标最多 4096 项；游标失效仍回退 OFFSET，不信任前端传入主键。
- 后续授权提交时使用项目支持的英文 type 和简体中文描述，如 `refactor: 合并目录查询与分页元数据读取`。
- 真实数据库性能和权限验证仅使用隔离测试实例；当前只核实代码和编写计划，不读取业务凭据。

## 已核实的起点

- [databaseStore.ts:1389](../../../src/stores/databaseStore.ts) 在刷新时并发逐库 `listTables`，仍产生 N 次 IPC 和目录 SQL。
- [tauriCommands.ts:551](../../../src/services/tauriCommands.ts) 只有单库 `list_tables` 包装，`loadTables`/`selectDatabase` 可能重叠请求。
- [database/mod.rs:57](../../../src-tauri/src/commands/database/mod.rs) 已有五种数据库单库分发；MySQL 采用 `SHOW TABLE STATUS`。
- [table_pagination.rs:234](../../../src-tauri/src/db/table_pagination.rs) 仅持有效导航游标才能命中元数据；普通刷新、跳页或不支持游标的表重复读取目录。
- 已有 `SqlCompletionInvalidation` 的 schema-change/refresh/disconnect 事件；扩展元数据失效接入，不混淆补全缓存与分页游标缓存的职责。

## 五项审查重点

1. 空库、缺失库、权限受限库和视图：保留各引擎当前语义，不将权限错误伪装成空列表；任务 1 覆盖。
2. 名称含引号、分隔符、大小写及多个同名表：绑定值或严格标识符转义，结果按原数据库名隔离；任务 1、2 覆盖。
3. SQLite attached schema 仅属于物理连接：批量语句在同一借出连接执行，缺失别名明确失败，不替换成 main；任务 1 覆盖。
4. 刷新、DDL、断线与在途响应交错：旧请求不得回填，也不能删除新一轮 promise；任务 2、4 覆盖。
5. 元数据过期或主键权限变化：缓存失效必须同时废弃对应游标，不削弱真实主键及完整列权限验证；任务 3、4 覆盖。

## 任务 1：新增五种数据库的集合目录命令

**修改文件：**

- `src-tauri/src/commands/database/mod.rs`、`src-tauri/src/lib.rs`：新命令与注册。
- `src-tauri/src/models/types.rs`、`src/types/index.ts`：新增批量结果类型，复用现有 `TableInfo`。
- `src-tauri/src/db/postgres.rs`、`src-tauri/src/db/sqlserver.rs`、`src-tauri/src/db/sqlite.rs`、`src-tauri/src/db/clickhouse.rs`：适配器集合 SQL 与结果映射。
- 新增 `src-tauri/src/commands/database/batch_tests.rs`，由 `database/mod.rs` 引入；各适配器在已有测试模块补充方言断言。

**拟新增接口：**

- Rust `DatabaseTableList { database: String, tables: Vec<TableInfo> }`，派生 `Serialize`；TypeScript 同名接口对应 `database: string; tables: TableInfo[]`。
- Tauri `async fn list_tables_batch(state: State<'_, AppState>, conn_id: String, databases: Vec<String>) -> Result<Vec<DatabaseTableList>, String>`。
- PG 新增 `async fn list_tables_batch(pool: &deadpool_postgres::Pool, databases: &[String]) -> Result<Vec<DatabaseTableList>, String>`；SQL Server 的池参数为 `&SqlServerPool`，SQLite 为 `&deadpool_sqlite::Pool`，ClickHouse 为 `&clickhouse::Client`；其余参数和返回类型相同。
- 去重后按首次出现顺序输出，每个请求名称恰好一个结果；单库 `list_tables` 保持签名并委托同一实现，禁止两套映射逐渐分叉。

- [ ] 编写 `metadata_batch_contract`：空输入 0 次数据库调用；重复库去重；257 个不同库失败且 0 次查询；返回顺序与空库条目正确。
- [ ] 编写 `metadata_batch_preserves_types_and_permissions`：表/视图、NULL 统计及注释映射与单库基线相同；MySQL 缺失/不可见库返回明确错误，PG/SQL Server 保留当前目录可见性行为。
- [ ] 编写 `metadata_batch_quoted_names`：含单引号、反引号、双引号、方括号的名称不能成为 SQL 结构；同名表按库正确归组。
- [ ] 运行 `cargo test --manifest-path src-tauri/Cargo.toml metadata_batch`，确认接口和新断言未实现时失败。
- [ ] MySQL 用请求集合连接 `INFORMATION_SCHEMA.SCHEMATA/TABLES`，以 `TABLE_SCHEMA` 分组并映射原 `TableInfo`；不使用循环 `SHOW TABLE STATUS`，记录旧 SHOW 与目录权限语义的差异并测试。
- [ ] PostgreSQL 用 schema 名数组条件扩展当前 `pg_class/pg_namespace` 查询；SQL Server 用参数化 schema 集合扩展 `sys.tables/sys.views` 查询；ClickHouse 用 `system.tables` 集合条件及 database 列归组。
- [ ] SQLite 在同一 `interact` 内构造并执行单条安全转义的 `UNION ALL` 查询；用请求序号保序，补齐空 schema 条目。仅构造 SQL 时循环，执行调用固定一次。
- [ ] 编写本地 SQLite `metadata_batch_attached_connection_scope`：同一连接 ATTACH 两库、同名表、空库和带引号别名正确；换连接没有该别名时明确失败，不重试逐库查询。
- [ ] 对 SQLite authorizer 拒绝访问、缺失 attached 别名测试整批失败且不返回部分成功；确认主库、temp 与 attached 过滤规则与原实现一致。
- [ ] 重跑 `cargo test --manifest-path src-tauri/Cargo.toml metadata_batch`，测试通过后人工审查五种路径 SQL 调用数，暂不提交。

## 任务 2：前端批量刷新与同键进行中去重

**修改文件：**`src/services/tauriCommands.ts`、`src/stores/databaseStore.ts`。

**测试文件：**新增 `src/__tests__/metadataRequests.test.ts`；修改现有 `src/__tests__/databaseStore.test.ts`。

**拟新增接口：**

- `listTablesBatch(connId: string, databases: string[]): Promise<DatabaseTableList[]>`。
- `invalidateMetadataRequests(connId: string, database?: string): void`，递增作用域 generation 并清理对应 in-flight 条目。
- 保持 `listTables(connId, database): Promise<TableInfo[]>` 签名，内部走单名称批量请求；完成值仍由现有 Zustand `connectionStates` 持有，不新增无限结果缓存。
- 请求键用 `JSON.stringify([connId, sortedUniqueDatabases, generation])`，禁止通过 `|` 拼接；单库与单元素批量请求共用键。

- [ ] 编写 `metadata_requests_share_same_key`：并发相同请求、乱序相同集合、单库与单元素批量只调用一次 invoke；不同连接不能共用 promise。
- [ ] 编写 `metadata_requests_retry_after_failure`：失败后清理 promise，下一次实际重发；空输入不 invoke，超限在调用前拒绝。
- [ ] 编写 `metadata_requests_stale_finally_cannot_delete_new_request`：失效后新请求先启动，旧请求 finally 不得删除新 promise；旧响应不得更新 store。
- [ ] 运行 `npm test -- src/__tests__/metadataRequests.test.ts src/__tests__/databaseStore.test.ts`，确认新增断言先失败。
- [ ] 实现进行中去重；规范化集合用于键，响应按各调用者的首次请求顺序重排；只删除仍指向当前 promise 的条目。
- [ ] 将 `refresh` 中逐库 `Promise.all(map(...))` 替换为一次 `listTablesBatch`；纯内存归组更新 `tables`，一次 set，保留选中项、已开标签页与错误状态。
- [ ] `loadTables`、`selectDatabase` 和需要补齐 tableInfo 的路径复用单库包装；完成前检查连接 generation 和当前选择，避免旧快照覆盖用户的新选择。
- [ ] 增加 store 断言：刷新 1/10/100 个目录均只调用一次批量命令；已有非当前连接状态保留；失败不局部覆盖旧目录。
- [ ] 重跑两个 Vitest 文件，要求通过；不把不同键请求加入循环 SQL“限流队列”作为实现，暂不提交。

## 任务 3：分页元数据缓存与游标校验解耦

**修改文件：**`src-tauri/src/db/table_pagination.rs`、`src-tauri/src/commands/data.rs`、`src-tauri/src/db/postgres.rs`；测试放现有 Rust 测试模块。

**拟新增接口：**

- `cached_table_metadata(context: &PageContext) -> Option<TableMetadata>`：按表标识和 TTL 读取未失效元数据，不要求 navigation；generation 仅阻止在途写回，不让单表失效清空其他已缓存表。
- `metadata_generation(connection: &str) -> u64`；`remember_metadata_if_current(context: &PageContext, metadata: TableMetadata, generation: u64) -> Option<TableMetadata>`。
- `invalidate_table_metadata(connection: &str, database: Option<&str>, table: Option<&str>)`：按粒度删除元数据及相关游标；递增连接 generation，拒绝失效前的在途写回。
- 现有 `cached_metadata_for_navigation`/`valid_cursor` 继续校验查询上下文、页号、方向、revision 和期限；不降低 `PagePlan` 的主键限制。

- [ ] 编写 `metadata_cache_without_navigation`：UUID、复合主键、其他排序和普通跳页可复用元数据，游标能力与原先一致。
- [ ] 编写 `metadata_cache_invalidation_drops_cursors`：单表失效只删除该表数据及游标；旧 token 回退 OFFSET，其他表仍可命中。
- [ ] 编写 `metadata_cache_stale_fetch_cannot_repopulate`：读 generation 后触发失效，旧 `remember` 返回 None；当前请求重新取元数据一次，不使用旧结果生成游标；再次被失效则返回可重试错误，禁止无限重查。
- [ ] 编写 `metadata_cache_ttl_and_capacity`：300 秒边界、256 项元数据、4096 游标上限与权限不完整主键回退行为保持。
- [ ] 运行 `cargo test --manifest-path src-tauri/Cargo.toml metadata_cache`，确认失败后实现独立缓存访问及失效 API。
- [ ] MySQL/PG 表查询先独立读元数据缓存，再单独校验 navigation；未命中只调用原有安全元数据查询，不删 MySQL `SHOW INDEX` 证据检查。
- [ ] 使用注入读取器测试同表无导航连续请求：首次 MySQL 2 条元数据 SQL、PG 1 条，后续 TTL 内 0 条；失效后再次读取。
- [ ] 重跑上述测试和 `cargo test --manifest-path src-tauri/Cargo.toml table_pagination`，保留空页、整数边界和反向游标回归，暂不提交。

## 任务 4：连接失效事件并验证跨层一致性

**修改文件：**`src/utils/sqlCompletionInvalidation.ts`、`src/stores/databaseStore.ts`、`src/stores/connectionStore.ts`、`src/services/tauriCommands.ts`；后端 `src-tauri/src/commands/database/mod.rs`、`src-tauri/src/commands/database/column_ops.rs`、`src-tauri/src/commands/data.rs`、`src-tauri/src/commands/connection.rs`、`src-tauri/src/commands/database_sync.rs`、`src-tauri/src/lib.rs`。

**拟新增接口：**Tauri `invalidate_table_metadata_cache(state: State<'_, AppState>, conn_id: String, database: Option<String>, table: Option<String>) -> Result<(), String>`；前端 `invalidateTableMetadataCache(connId: string, database?: string, table?: string): Promise<void>`。接入现有事件时保留 `SqlCompletionInvalidation` 名称和原监听者行为。

- [ ] 新增断言：DDL 成功后失效目标表/库，DDL 失败不清空有效元数据；改名使旧名与新名均失效；结构同步成功按涉及库失效。
- [ ] 新增断言：显式刷新先等待后端失效，再批量刷新；断线先递增前端 generation，旧请求返回也不能重建连接状态。
- [ ] 新增断言：SQL 编辑器成功的修改类结果保守失效该连接分页元数据，覆盖任意 DDL；只读结果不失效。此处包含 DML 的额外失效是兼容取舍，不声称精确解析所有 DDL。
- [ ] 运行 `npm test -- src/__tests__/metadataRequests.test.ts src/__tests__/databaseStore.test.ts src/__tests__/connectionStore.test.ts` 与 Rust `metadata_cache` 测试，确认新增断言先失败。
- [ ] 在后端 DDL 成功分支及断线路径调用任务 3 API；分页缓存失效与网络 I/O 分离，不在全局连接锁内等待数据库。
- [ ] 将现有 schema-change/refresh/disconnect 事件接到前端请求失效；刷新采用可等待的后端 API，不依赖无法 await 的事件订阅器建立顺序。
- [ ] 旧结果检测失败仅丢弃旧响应；用户当前选中表/新请求不能被重置。数据库外部 DDL 最迟由 TTL 或手动刷新感知。
- [ ] 运行三个 Vitest 文件、`cargo test --manifest-path src-tauri/Cargo.toml metadata_batch`、`cargo test --manifest-path src-tauri/Cargo.toml table_pagination`、`npx tsc --noEmit`、`npm run fmt:rust`、`git diff --check`，全部通过。
- [ ] 记录 1/10/100 个目录及同表 20 次非游标翻页的 IPC 数、目录 SQL 数、命中率和 p95；真实库指标仅从隔离测试实例采集。
- [ ] 将夹具、样本数、权限边界及结果补充到总览约定的 `docs/performance-baseline.md`，不记录凭据、完整 SQL 或结果内容。

## 验收指标与回滚

- 远程引擎批量读取请求集合时目录 SQL 固定 1 次；SQLite 每批同一物理连接执行一次组合查询；禁止逐库执行或超限循环兜底。
- 同键并发调用底层 invoke 恰好 1 次；失败可重试；失效后旧请求写回次数为 0。
- TTL 内同表非游标查询，MySQL/PG 后续分页元数据 SQL 为 0；DDL/刷新后必须重新校验真实主键，旧游标不得继续使用。
- 数据库表字段、可见性、排序、统计含义与当前行为一致；权限/attached 语义未验证的引擎不得声称兼容完成。
- 不预设吞吐提升百分比；网络 p95、SQL 数和缓存命中率须有前后同环境记录。
- 以任务边界回退失效或去重变更，保留已经验证的集合目录命令；批量适配器出现兼容问题时暂禁用多库刷新并明确报错，禁止恢复逐库循环 SQL。单库接口仍可用于单次用户操作。
- 缓存回滚可清空进程缓存再恢复原读取逻辑，不涉及数据迁移；保留主键完整性、权限检查和查询取消保护。
- 所有任务验证通过并完成五项审查后，才可宣称此计划已经实施；提交、推送仍由用户后续授权。
