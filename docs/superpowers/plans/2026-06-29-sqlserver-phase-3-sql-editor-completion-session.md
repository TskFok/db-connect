# SQL Server Phase 3 SQL Editor Completion Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 SQL Server 打开 SQL 编辑器、SQL 补全、会话信息、执行计划和查询取消能力。

**Architecture:** SQL 编辑器执行走 `sqlserver.rs` 专属函数，结果集转换与行数上限保持和现有数据库一致；补全元数据用系统视图一次性拉取；只读连接由 `SqlServerDialect` 判断允许语句。

**Tech Stack:** Tauri Rust commands, tiberius query APIs, SQL Server catalog views, React SQL editor, Vitest, Rust unit tests.

---

## 目标

- SQL Server 连接打开 SQL 编辑器入口。
- 支持执行 SELECT、WITH SELECT、系统视图查询、DML/DDL，并正确返回查询结果或影响行数。
- 只读连接仅允许安全读语句，拒绝 INSERT、UPDATE、DELETE、MERGE、CREATE、ALTER、DROP、TRUNCATE、EXEC 等写类或副作用语句。
- SQL 补全返回 schema、表、视图和列。
- 会话信息展示版本、主机名、当前 database、连接 ID、只读状态和权限写能力。
- 支持 SQL Server 执行计划；查询取消能力在可实现范围内接入，不可实现时返回明确中文错误。

## 文件改动边界

- Modify: `src-tauri/src/db/sqlserver.rs`，新增 `run_sql_on_pool`、`explain_sql_on_pool`、`get_sql_completion_metadata`、`get_session_info`、`cancel_query` 支撑函数。
- Modify: `src-tauri/src/db/dialect.rs`，完善 SQL Server 只读 SQL 判断。
- Modify: `src-tauri/src/db/sql_utils.rs`，暴露 SQL Server 只读判断辅助函数。
- Modify: `src-tauri/src/commands/data.rs`，SQL 编辑器、执行计划、会话信息、取消查询接入 SQL Server 分支。
- Modify: `src-tauri/src/commands/database/mod.rs`，SQL 补全元数据接入 SQL Server 分支。
- Modify: `src/utils/databaseCapabilities.ts`，打开 SQL Server `sqlEditor`。
- Test: `src/__tests__/sqlExecutionCommands.test.ts`、`src/__tests__/sqlCompletion.test.ts`、`src/__tests__/sqlCompletionSchema.test.ts`、`src/__tests__/databaseCapabilities.test.ts`，以及 Rust SQL Server 执行和只读判断单元测试。

## 风险控制

- SQL 编辑器结果集行数上限与现有数据库一致，超过上限返回中文错误，避免内存爆炸。
- 只读判断必须保守：无法明确判定为读操作的语句一律拒绝。
- `WITH` 语句只允许最终主语句为 SELECT，并拒绝 CTE 内部包含 INSERT、UPDATE、DELETE、MERGE。
- `EXEC` 和 `sp_` 调用首版在只读连接中一律拒绝，因为存储过程副作用不可静态判断。
- 补全元数据必须通过一次系统视图查询批量获取，不对每张表单独查询列。
- 查询取消如果依赖驱动能力不稳定，UI 仍应能显示“SQL Server 暂不支持取消当前查询”，不能让取消按钮静默失败。

## 任务清单

- [ ] `SqlServerDialect` 增加 `sql_editor_allowed_on_read_only_connection` 单元测试，覆盖 SELECT、WITH SELECT、EXPLAIN/SHOWPLAN、INSERT、UPDATE、DELETE、MERGE、TRUNCATE、DROP、ALTER、EXEC。
- [ ] `run_sql_on_pool` 支持 SQL Server 查询结果和影响行数，复用 `MAX_EXECUTE_SQL_SELECT_ROWS` 语义。
- [ ] 实现 SQL Server 行值转换，覆盖 null、字符串、整数、decimal、float、bit、date/time/datetimeoffset、uniqueidentifier、binary。
- [ ] `get_sql_completion_metadata` 使用 `sys.schemas`、`sys.objects`、`sys.columns`、`sys.types` 批量返回当前 database 的 schema、表/视图和列。
- [ ] `get_session_info` 查询 `@@VERSION`、`@@SERVERNAME`、`DB_NAME()`、`@@SPID`、`DATABASEPROPERTYEX(DB_NAME(), 'Updateability')` 和权限写能力。
- [ ] 权限写能力通过 `fn_my_permissions` 或等价系统函数批量判断，失败时保守返回可写，避免误禁用。
- [ ] `explain_sql_on_pool` 使用 `SET SHOWPLAN_TEXT ON` 或 `SET SHOWPLAN_XML ON` 包裹单条语句，返回可展示结果集；不默认执行 `ANALYZE` 类真实执行计划。
- [ ] `commands/data.rs` 和 `commands/database/mod.rs` 接入 SQL Server 分支。
- [ ] capability 打开 `sqlEditor: true`，保持写类和对象管理能力关闭。
- [ ] 补充前端测试确保 SQL Server SQL 编辑器入口展示，未实现的写类入口仍隐藏。

## 测试命令

```bash
npm test -- src/__tests__/sqlExecutionCommands.test.ts src/__tests__/sqlCompletion.test.ts src/__tests__/sqlCompletionSchema.test.ts src/__tests__/databaseCapabilities.test.ts
cargo test --manifest-path src-tauri/Cargo.toml sqlserver
cargo test --manifest-path src-tauri/Cargo.toml read_only
npm run build
```

## 验收标准

- SQL Server SQL 编辑器能执行查询并返回列名、行数据和耗时。
- 修改类 SQL 在非只读连接中返回影响行数，在只读连接中被拒绝。
- SQL 补全能基于当前 schema 提供表、视图和列。
- 会话信息能展示 SQL Server 版本、主机、database 和连接 ID。
- 执行计划入口可返回 SQL Server 计划结果；取消查询不可用时有明确中文提示。
- MySQL、PostgreSQL、SQLite 的 SQL 编辑器、补全和会话信息无回归。
