# ClickHouse 支持落地总体规划

## 目标
在当前 Tauri + React 架构中新增 ClickHouse 支持，使用户能够保存/连接 ClickHouse、浏览数据库与表、查看结构、执行 SQL、读取表数据，并在风险可控的前提下逐步开放写入、DDL 与文件导入导出能力。

## 范围定义
- 首版支持协议：HTTP/HTTPS，默认端口 `8123`。不走 ClickHouse Native TCP `9000`，因为当前官方 Rust `clickhouse` crate 使用 HTTP 传输，Native TCP 仍不是落地前提。
- 首版核心能力：连接管理、测试连接、保存/导入导出连接、数据库/表/列浏览、SQL 补全、分页查询、SQL 编辑器执行、会话信息、收藏表、保存 SQL。
- 受控开放能力：`INSERT`、`CREATE/DROP/TRUNCATE/RENAME DATABASE/TABLE`、SQL 文件导入导出按步骤开放。
- 首版不做 MySQL 等价的行级编辑体验：ClickHouse 面向 OLAP，`UPDATE`/`DELETE` 通常是异步 mutation，不适合直接映射为当前表格单行编辑流程。该能力需要单独设计。
- 明确约束：禁止在循环遍历中查询 SQL。涉及表、列、补全、导出元数据时，必须使用 `system.databases`、`system.tables`、`system.columns` 等批量查询。

## 技术依据
- 官方 Rust 客户端：`clickhouse` crate 当前文档标注为 `0.15.1`，是官方纯 Rust 类型客户端，基于 HTTP 传输，支持 TLS、压缩、select、insert 与 mock。参考：https://docs.rs/clickhouse/latest/clickhouse/
- 动态结果集：`Query::fetch_bytes(format)` 可按指定格式返回原始字节，适合本项目 SQL 编辑器这种列结构运行时才知道的场景。参考：https://docs.rs/clickhouse/latest/clickhouse/query/struct.Query.html
- HTTP 接口：ClickHouse 默认 HTTP 示例使用 `http://localhost:8123`，支持 `FORMAT JSON`、`default_format`、默认 database 参数和认证。参考：https://clickhouse.com/docs/interfaces/http
- 元数据系统表：`system.databases` 提供可见数据库，`system.tables` 提供表/视图与行数/字节等元数据，`system.columns` 提供列名、类型、位置、注释与主键/排序键信息。参考：
  - https://clickhouse.com/docs/operations/system-tables/databases
  - https://clickhouse.com/docs/operations/system-tables/tables
  - https://clickhouse.com/docs/operations/system-tables/columns

## 当前代码接入点
- 前端类型：`src/types/index.ts`
- 前端连接归一化：`src/utils/connectionConfig.ts`
- 前端能力开关：`src/utils/databaseCapabilities.ts`
- 前端连接表单：`src/components/connection/ConnectionForm.tsx`
- SQL 补全/格式化：`src/utils/sqlCompletion.ts`、`src/utils/sqlFormat.ts`
- 后端数据库枚举：`src-tauri/src/models/types.rs`
- 后端适配器和连接分发：`src-tauri/src/db/adapter.rs`、`src-tauri/src/db/connection.rs`
- 后端数据库浏览：`src-tauri/src/commands/database/mod.rs`
- 后端数据查询/SQL 执行：`src-tauri/src/commands/data.rs`
- 后端对象命令：`src-tauri/src/commands/index_cmd.rs`、`foreign_key.rs`、`trigger.rs`、`routine_event.rs`
- SQL 文件导入导出：`src-tauri/src/commands/sql_file.rs`

## 实施步骤
1. `01-frontend-type-capability-plan.md`：前端类型、默认端口、连接表单、能力开关、系统库识别。
2. `02-backend-client-connection-plan.md`：Rust 依赖、ClickHouse client/handle、连接生命周期、保存连接兼容性。
3. `03-metadata-browsing-completion-plan.md`：数据库/表/列浏览、主键/排序键识别、SQL 补全元数据，确保批量查询。
4. `04-sql-execution-session-plan.md`：SQL 编辑器执行、动态 JSON 结果、只读校验、会话信息、取消能力边界。
5. `05-table-data-write-ddl-plan.md`：分页表数据、`INSERT`、受控 DDL、明确不开放行级 update/delete。
6. `06-file-io-regression-release-plan.md`：SQL 文件导入导出、回归测试矩阵、文档与发布收口。

## 总体风险控制
- 每一步都必须先补测试，再改实现；每一步完成后至少运行对应前端单测和 Rust 单测。
- 不在早期步骤开启写能力；前端 capability 与后端错误返回要保持一致。
- 所有 ClickHouse SQL 标识符必须集中转义，不允许散落拼接。
- 查询结果必须设置行数上限，避免 SQL 编辑器一次性把大结果集全部塞进前端。
- 对大整数、日期时间、二进制和 Nullable 类型做 JSON 转换测试，避免前端精度丢失。
- 对系统库 `system`、`INFORMATION_SCHEMA`、`information_schema` 默认只读展示，禁止删除和高危操作。

## 全量验收标准
- `npm test`、`npm run build`、`npm run lint` 通过。
- `npm run test:rust`、`npm run fmt:rust`、`npm run lint:rust` 通过。
- 本地 ClickHouse 实例可完成：连接测试、保存连接、连接复用、列出数据库、列出表、查看结构、分页读取数据、执行 `SELECT 1`、查看 session info。
- 只读连接下 ClickHouse 写类 SQL、DDL、导入、表格写入入口被前端禁用且后端拒绝。
- 不存在循环逐表查询元数据的实现；涉及多表元数据必须是一条批量 SQL 或固定数量 SQL。
