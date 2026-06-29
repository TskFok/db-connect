# SQL Server Phase 2 Browsing Readonly Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 SQL Server 指定 database 内支持 schema/table 浏览、表结构查看和分页只读数据查看。

**Architecture:** `list_databases` 对 SQL Server 返回 schema 列表，以适配现有两层树模型；`database` 参数在 SQL Server 分支中表示 schema。所有元数据读取集中到 `sqlserver.rs`，使用系统视图批量查询。

**Tech Stack:** Tauri Rust commands, tiberius, SQL Server system catalogs, React 18, TypeScript, Vitest, Rust unit tests.

---

## 目标

- SQL Server 连接后左侧第一层展示 schema，默认包含 `dbo`，排除 `sys` 和 `INFORMATION_SCHEMA`。
- 第二层展示普通表和视图，能区分 `"TABLE"` 与 `"VIEW"`。
- 表结构能展示列名、数据类型、NULL、主键信息、默认值、identity/computed 等额外信息。
- 表数据支持分页查询、COUNT 查询、WHERE 过滤和基础排序。
- 本阶段不开放数据编辑和 DDL。

## 文件改动边界

- Create/Modify: `src-tauri/src/db/sqlserver.rs`，新增 `list_schemas`、`list_tables`、`get_table_structure`、`query_table_data`、`count_table_rows` 和 SQL Server 值到 JSON 的转换。
- Modify: `src-tauri/src/db/dialect.rs`，新增 `SqlServerDialect`。
- Modify: `src-tauri/src/db/sql_utils.rs`，新增 `sqlserver_id`、`sqlserver_str`、`sqlserver_paginated_select`、`sqlserver_count_query`。
- Modify: `src-tauri/src/commands/database/mod.rs`，SQL Server 分支接入 schema/table/column 读取。
- Modify: `src-tauri/src/commands/data.rs`，SQL Server 分支接入只读分页数据和 COUNT。
- Modify: `src/utils/databaseCapabilities.ts`，打开 SQL Server `tableBrowsing`，保持写类能力关闭。
- Test: `src/__tests__/databaseCapabilities.test.ts`、`src/__tests__/DatabaseTreeCapabilities.test.tsx`、`src/__tests__/listTableColumns.test.ts`、`src/__tests__/tableDataPagination.test.tsx`，以及 `dialect.rs` 和 `sqlserver.rs` Rust 单元测试。

## 风险控制

- 不改变 `database` 参数的外部命名，但在 SQL Server 文档和实现中明确该参数表示 schema。
- 列表查询必须批量完成，禁止在 schema/table/column 循环中逐项查询 SQL。
- SQL Server 标识符统一使用方括号并转义 `]`；不得复用 MySQL 反引号或 PostgreSQL 双引号。
- 分页必须生成稳定 SQL；无显式排序时使用主键列，找不到主键时使用所有可见列或 `(SELECT 0)` 作为保底排序。
- 大整数、decimal、datetimeoffset、uniqueidentifier、binary/varbinary 返回 JSON 时必须避免 JS 精度丢失和二进制乱码。

## 任务清单

- [ ] 在 `SqlServerDialect` 中实现 `identifier`、`string_literal`、`table_ref(schema, table)`、`paginated_select`、`count_query`。
- [ ] `list_schemas` 使用 `sys.schemas` 批量查询用户 schema，排序稳定，排除系统 schema。
- [ ] `list_tables` 使用 `sys.tables`、`sys.views`、`sys.schemas` 和 `sys.dm_db_partition_stats` 批量查询当前 schema 的表/视图、预估行数、数据大小和注释。
- [ ] `get_table_structure` 使用 `sys.columns`、`sys.types`、`sys.default_constraints`、`sys.identity_columns`、`sys.computed_columns`、`sys.indexes`、`sys.index_columns` 批量生成列信息。
- [ ] `commands/database/mod.rs` 接入 SQL Server 分支，保持 MySQL、PostgreSQL、SQLite 分支不变。
- [ ] `commands/data.rs` 接入 SQL Server 只读分页查询和 COUNT 查询。
- [ ] 实现 SQL Server 数据值到 JSON 转换：安全整数范围内返回 number，超出范围的整数和 decimal 返回 string，二进制返回 `"[binary N bytes]"`。
- [ ] 前端 capability 打开 `tableBrowsing: true`，保持 `tableDataEditing: false`、`schemaManagement: false`、`databaseManagement: false`。
- [ ] 增加单元测试覆盖 SQL 生成、schema 过滤、列类型格式化、分页 SQL 和 capability 状态。

## 测试命令

```bash
npm test -- src/__tests__/databaseCapabilities.test.ts src/__tests__/DatabaseTreeCapabilities.test.tsx src/__tests__/listTableColumns.test.ts src/__tests__/tableDataPagination.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml sqlserver
cargo test --manifest-path src-tauri/Cargo.toml dialect
npm run build
```

## 验收标准

- SQL Server 连接后能看到当前 database 下的 schema 和表/视图。
- 表结构列信息完整，主键、nullable、默认值、identity、computed 信息显示合理。
- 分页查看数据、切换页码、WHERE 过滤和 COUNT 可用。
- 视图可以查看结构和数据，但不显示编辑入口。
- 未实现的编辑、DDL、索引、外键、触发器和导入导出入口仍不可用。
- MySQL、PostgreSQL、SQLite 的库表浏览和分页数据无回归。
