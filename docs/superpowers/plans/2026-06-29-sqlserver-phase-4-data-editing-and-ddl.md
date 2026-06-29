# SQL Server Phase 4 Data Editing And DDL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 SQL Server 开放安全的数据编辑和受控 schema/table/column DDL 子集。

**Architecture:** 数据编辑复用表数据视图的主键定位模型；SQL Server DDL 生成集中到 `sqlserver_ddl.rs`，命令层只做分发和只读拦截。首版只支持当前连接 database 内的 schema/table/column 管理。

**Tech Stack:** Tauri Rust commands, SQL Server DML/DDL, tiberius parameters, React table editing UI, Vitest, Rust unit tests.

---

## 目标

- 支持 SQL Server 表数据新增、单元格更新、批量更新、删除行。
- 无主键或无法唯一定位的表禁止编辑，返回明确中文错误。
- 支持创建/删除/重命名 schema，创建/删除/重命名表，新增/修改/删除列，清空表。
- SQL Server 不支持或高风险能力保持禁用，例如拖拽列顺序、跨 database DDL、任意裸 SQL 片段。

## 文件改动边界

- Create: `src-tauri/src/db/sqlserver_ddl.rs`，集中生成和校验 SQL Server DDL。
- Modify: `src-tauri/src/db/sqlserver.rs`，新增数据编辑、主键读取、DDL 执行辅助函数。
- Modify: `src-tauri/src/commands/data.rs`，接入 SQL Server 新增/更新/批量更新/删除/清空。
- Modify: `src-tauri/src/commands/database/mod.rs` 和 `src-tauri/src/commands/database/column_ops.rs`，接入 SQL Server schema/table/column 管理。
- Modify: `src/utils/databaseCapabilities.ts`，打开 SQL Server `tableDataEditing`、`databaseManagement`、`schemaManagement`，保持 `columnReordering: false`。
- Modify: `src/utils/columnTypeUtils.ts`、`src/utils/createTableFormUtils.ts`，增加 SQL Server 类型建议和表单限制。
- Test: `src/__tests__/tableDataStore.test.ts`、`src/__tests__/editableCell.test.ts`、`src/__tests__/createTable.test.ts`、`src/__tests__/createTableSql.test.ts`、`src/__tests__/TableStructureMetadata.test.tsx`，以及 `sqlserver_ddl.rs` Rust 单元测试。

## 风险控制

- 所有写操作必须使用 `get_database_pool_for_write`，只读连接一律拒绝。
- 编辑行必须基于主键或唯一键定位；无主键表、视图、computed-only 定位不明确的对象禁止编辑。
- DDL 中的 schema、table、column、constraint 名称只允许通过 `SqlServerDialect` 标识符转义。
- 列类型和默认值片段必须白名单校验；禁止包含分号、注释、批处理分隔符、动态执行关键字。
- `TRUNCATE TABLE` 属于高危操作，遵循现有高危 SQL 二次确认策略；不满足条件时退回 `DELETE FROM` 或拒绝。
- 不实现列重排，因为 SQL Server 原生不支持安全的 `ALTER COLUMN ... FIRST/AFTER`。

## 任务清单

- [ ] 在 `sqlserver.rs` 中实现当前表主键/唯一键读取，优先主键，缺失时选择非过滤唯一索引。
- [ ] 实现 insert/update/delete/batch update，所有用户值走参数绑定，不拼接值字面量。
- [ ] 禁止视图编辑，返回“SQL Server 视图暂不支持通过当前入口编辑”。
- [ ] 创建 `sqlserver_ddl.rs`，实现 schema 创建/删除/重命名 SQL 生成。
- [ ] 实现表创建、删除、重命名和清空 SQL 生成；创建表支持常用类型、nullable、默认值、identity 和主键。
- [ ] 实现新增列、修改列、删除列；修改列必须明确保留 nullable/default 语义，无法安全表达时拒绝。
- [ ] `columnTypeUtils` 增加 SQL Server 常用类型：`int`、`bigint`、`bit`、`decimal(18,2)`、`nvarchar(255)`、`varchar(255)`、`datetime2`、`datetimeoffset`、`uniqueidentifier`、`varbinary(max)`。
- [ ] capability 打开 SQL Server 数据编辑和 schema/table/column 管理，保持列重排关闭。
- [ ] 增加 Rust DDL SQL 生成单元测试和前端能力/UI 测试。

## 测试命令

```bash
npm test -- src/__tests__/tableDataStore.test.ts src/__tests__/editableCell.test.ts src/__tests__/createTable.test.ts src/__tests__/createTableSql.test.ts src/__tests__/TableStructureMetadata.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml sqlserver_ddl
cargo test --manifest-path src-tauri/Cargo.toml sqlserver
npm run build
```

## 验收标准

- SQL Server 主键表可以新增、编辑、批量更新和删除数据。
- 无主键或无法唯一定位的表不可编辑，错误信息明确。
- schema/table/column 管理操作可用，且只作用于当前连接 database。
- 只读连接下所有写入口被 UI 禁用，后端直接调用也拒绝。
- 列重排、跨 database DDL 和不支持的 SQL Server 能力没有开放入口。
- MySQL、PostgreSQL、SQLite 的数据编辑和 DDL 行为无回归。
