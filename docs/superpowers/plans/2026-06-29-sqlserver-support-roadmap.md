# SQL Server 支持完整落地规划

## 背景

当前项目已经支持 MySQL、PostgreSQL 与 SQLite，后端具备 `DatabaseType`、`DatabasePoolHandle`、`ActiveDatabaseConnection`、adapter、dialect 与按类型分发的命令层；前端具备连接类型、连接表单、库表树、表数据视图、SQL 编辑器和 capability map。

SQL Server 支持应落在现有多数据库架构内，不新建分支、不拆独立应用、不重写前端状态模型。落地时必须遵守项目约束：禁止在循环遍历中查询 SQL，所有列表和元数据读取优先使用系统视图批量查询。

## 总目标

在当前客户端中渐进增加 SQL Server 支持，最终具备以下能力：

- 保存、测试、连接、断开 SQL Server 连接，支持默认 1433 端口、SQL Server 用户密码认证、SSH 隧道和 TLS 配置。
- 在连接配置指定的物理 database 内浏览 schema、表、视图和列结构。
- 分页查看表数据，执行 SQL，获取 SQL 补全元数据、会话信息和执行计划。
- 在能力矩阵明确开放后支持数据编辑、受控 DDL、索引、外键、触发器、存储过程/函数查看和 SQL 文件导入导出。
- 所有未实现或 SQL Server 不适配的能力在 UI 上隐藏或禁用，直接调用后端命令时返回明确中文错误。

## 核心架构决策

- 数据库类型新增 `sqlserver`。Rust `DatabaseType::SqlServer` 经 serde 序列化为 `"sqlserver"`，TypeScript `DatabaseType` 同步增加 `"sqlserver"`。
- `ConnectionConfig.database` 表示 SQL Server 物理 database。库表树第一层展示该 database 下的 schema，第二层展示 schema 内的表和视图；不在本路线图内改造成 server -> database -> schema -> table 三层树。
- `databaseObjectNoun` 对 SQL Server 使用 `"schema"`，前端继续通过 capability map 控制入口。
- 连接字段复用现有 `host`、`port`、`username`、`password`、`database`、`ssh`、`ssl_mode`、`ssl_ca_path`、`ssl_tls_hostname`、`read_only` 和高危 SQL 配置。首版不新增 SQL Server 专属连接字段。
- 驱动首选 `tiberius` + `bb8-tiberius`。2026-06-29 通过 `cargo info` 验证的当前版本为 `tiberius 0.12.3`、`bb8-tiberius 0.16.0`；不使用 ODBC 或系统 SQL Server Native Client，降低跨平台安装风险。
- 新增 `SqlServerDialect` 集中处理方括号标识符、字符串字面量、schema/table 引用、`OFFSET/FETCH` 分页、COUNT 查询、只读 SQL 判断和 DDL 片段生成。
- SQL Server 元数据查询统一放入 `src-tauri/src/db/sqlserver.rs`，使用 `sys.schemas`、`sys.tables`、`sys.views`、`sys.columns`、`sys.types`、`sys.indexes`、`sys.foreign_keys`、`sys.sql_modules` 等系统视图批量读取。

## 非目标

- 不在本路线图内实现跨物理 database 的三层树或任意 database 切换。
- 不支持 Windows Integrated Authentication。若以后需要，应作为独立规划处理。
- 不支持 SQL Server Agent Job、Linked Server、Replication、Always On 管理等 DBA 工具。
- 不把 SQL Server 专属逻辑写进 React 组件或通用命令层的零散分支；能力差异必须落到 adapter、dialect、capability 或 `sqlserver.rs`。
- 不在未完成后端命令前提前打开前端 capability。

## 阶段拆分

1. [Phase 1：类型、配置与连接基础](./2026-06-29-sqlserver-phase-1-type-config-connection.md)
2. [Phase 2：Schema/Table 浏览与只读数据](./2026-06-29-sqlserver-phase-2-browsing-readonly-data.md)
3. [Phase 3：SQL 编辑器、补全、会话信息与执行计划](./2026-06-29-sqlserver-phase-3-sql-editor-completion-session.md)
4. [Phase 4：数据编辑与安全 DDL 子集](./2026-06-29-sqlserver-phase-4-data-editing-and-ddl.md)
5. [Phase 5：对象管理与工具能力](./2026-06-29-sqlserver-phase-5-objects-and-tools.md)
6. [Phase 6：导入导出、文档与体验打磨](./2026-06-29-sqlserver-phase-6-import-export-polish.md)

## 全局文件改动边界

- Rust 类型与连接生命周期：`src-tauri/src/models/types.rs`、`src-tauri/src/db/adapter.rs`、`src-tauri/src/db/connection.rs`、`src-tauri/src/db/mod.rs`、`src-tauri/src/db/sqlserver.rs`。
- Rust 方言与 SQL 工具：`src-tauri/src/db/dialect.rs`、`src-tauri/src/db/sql_utils.rs`，必要时新增 `src-tauri/src/db/sqlserver_ddl.rs`、`src-tauri/src/db/sqlserver_objects.rs`。
- Rust 命令分发：`src-tauri/src/commands/connection.rs`、`src-tauri/src/commands/database/mod.rs`、`src-tauri/src/commands/data.rs`、`src-tauri/src/commands/index_cmd.rs`、`src-tauri/src/commands/foreign_key.rs`、`src-tauri/src/commands/trigger.rs`、`src-tauri/src/commands/routine_event.rs`、`src-tauri/src/commands/sql_file.rs`。
- 前端类型、能力和连接表单：`src/types/index.ts`、`src/utils/connectionConfig.ts`、`src/utils/databaseCapabilities.ts`、`src/components/connection/ConnectionForm.tsx`。
- 前端视图和工具按阶段小范围修改：`src/components/database/*`、`src/components/table/*`、`src/utils/sqlCompletion*.ts`、`src/utils/columnTypeUtils.ts`、`src/utils/createTableFormUtils.ts`。
- 测试：`src/__tests__/*` 和 Rust 单元测试放在对应模块内。
- 依赖：`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 仅在 Phase 1 更新。

## 全局风险控制

- 每个阶段先保持 MySQL、PostgreSQL、SQLite 原有行为不变，再打开 SQL Server 的对应能力。
- SQL Server support 不和无关重构绑定；如果命令层文件过大，仅抽取 SQL Server 专属模块，不重排已有 MySQL/PostgreSQL/SQLite 实现。
- 元数据读取禁止在循环遍历中逐表或逐列查 SQL；如必须查询单表详情，只允许针对当前用户选中的单个对象执行一次查询。
- 所有用户输入的标识符必须通过 `SqlServerDialect` 转义，不拼接未校验 SQL 片段。
- 写操作必须经过 `get_database_pool_for_write` 和只读连接拦截；SQL 编辑器必须复用 SQL Server 只读判断。
- capability 默认保守关闭，阶段验收通过后再逐项打开。

## 全局验收基线

每个阶段完成后至少运行：

```bash
npm test
npm run test:rust
npm run build
```

每个阶段还需要手工验收：

- MySQL 旧连接仍能连接、浏览和执行 SQL。
- PostgreSQL 旧连接仍能连接、浏览和执行 SQL。
- SQLite 旧连接仍能连接、浏览和执行 SQL。
- SQL Server 当前阶段能力可用；未实现能力不可误点，后端直接调用返回明确中文错误。
- 没有新增“循环遍历中查询 SQL”的元数据实现。
