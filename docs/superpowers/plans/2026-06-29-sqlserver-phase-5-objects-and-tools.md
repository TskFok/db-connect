# SQL Server Phase 5 Objects And Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 SQL Server 补齐索引、外键、触发器、存储过程/函数等对象管理与辅助工具能力。

**Architecture:** SQL Server 对象元数据集中到 `sqlserver_objects.rs`；命令层复用现有 index、foreign_key、trigger、routine_event 分发结构。对象管理先覆盖常用 DDL，SQL Server Agent Event 类能力保持关闭。

**Tech Stack:** Tauri Rust commands, SQL Server system catalogs, React object management UI, Vitest, Rust unit tests.

---

## 目标

- 支持 SQL Server 索引列表、创建和删除。
- 支持外键列表、创建和删除。
- 支持触发器列表、查看定义、创建和删除。
- 支持存储过程/函数列表和定义查看；创建/编辑先通过 SQL 编辑器完成，不在对象弹窗中生成复杂过程体。
- SQL Server 没有 MySQL EVENT 等价能力，`eventManagement` 保持关闭。

## 文件改动边界

- Create: `src-tauri/src/db/sqlserver_objects.rs`，集中实现索引、外键、触发器、routine 元数据和对象 DDL。
- Modify: `src-tauri/src/db/mod.rs`，导出 `sqlserver_objects`。
- Modify: `src-tauri/src/commands/index_cmd.rs`，接入 SQL Server 索引分支。
- Modify: `src-tauri/src/commands/foreign_key.rs`，接入 SQL Server 外键分支。
- Modify: `src-tauri/src/commands/trigger.rs`，接入 SQL Server 触发器分支。
- Modify: `src-tauri/src/commands/routine_event.rs`，接入 SQL Server routine 列表和定义查看，事件分支返回不支持。
- Modify: `src/utils/databaseCapabilities.ts`，打开 `indexManagement`、`foreignKeyManagement`、`triggerManagement`、`routineManagement`，保持 `eventManagement: false`。
- Modify: `src/utils/foreignKeySql.ts`、`src/utils/indexUtils.ts`、`src/utils/foreignKeyMermaid.ts`，按需支持 SQL Server 文案和 SQL 预览。
- Test: `src/__tests__/indexList.test.ts`、`src/__tests__/foreignKeyAndRoutineCommands.test.ts`、`src/__tests__/foreignKeySql.test.ts`、`src/__tests__/triggerList.test.ts`、`src/__tests__/DatabaseTreeCapabilities.test.tsx`，以及 `sqlserver_objects.rs` Rust 单元测试。

## 风险控制

- 对象列表查询必须按当前 schema/table 批量读取，禁止对每个索引、外键或触发器逐个查询。
- 创建索引首版只支持普通索引和唯一索引；过滤索引、列存储索引、全文索引、空间索引作为不支持项返回中文错误。
- 外键引用表只允许当前 database 内对象；跨 database 外键不开放。
- 触发器体属于复杂 SQL，创建入口只提供明确模板和后端基础校验；更复杂编辑引导用户使用 SQL 编辑器。
- routine 列表和定义查看为只读工具，不在本阶段生成过程/函数 DDL。
- 所有对象 DDL 受只读连接和权限写能力双重拦截。

## 任务清单

- [ ] `sqlserver_objects.rs` 实现 `list_indexes`，使用 `sys.indexes`、`sys.index_columns`、`sys.columns` 批量聚合索引列。
- [ ] 实现 `create_index` 和 `drop_index`，限制支持普通/唯一索引，拒绝不支持索引类型并返回中文错误。
- [ ] 实现 `list_foreign_keys`，使用 `sys.foreign_keys`、`sys.foreign_key_columns`、`sys.tables`、`sys.schemas`、`sys.columns` 一次性聚合 incoming/outgoing 外键。
- [ ] 实现 `add_foreign_key` 和 `drop_foreign_key`，校验引用动作只允许 `NO ACTION`、`CASCADE`、`SET NULL`、`SET DEFAULT`。
- [ ] 实现 `list_triggers` 和 `drop_trigger`，使用 `sys.triggers`、`sys.trigger_events`、`sys.sql_modules` 返回触发器元数据。
- [ ] 实现 SQL Server 触发器创建模板，支持 AFTER INSERT/UPDATE/DELETE，拒绝 INSTEAD OF 首版入口。
- [ ] 实现 routine 列表和定义查看，覆盖 `P`、`FN`、`IF`、`TF` 等对象类型。
- [ ] capability 打开对象管理能力，保持 `eventManagement: false`。
- [ ] 前端对象列表对 SQL Server 展示合适文案，避免出现 MySQL EVENT 或 PostgreSQL 专属术语。
- [ ] 增加 Rust SQL 生成和聚合逻辑单元测试，以及前端 capability/UI 测试。

## 测试命令

```bash
npm test -- src/__tests__/indexList.test.ts src/__tests__/foreignKeyAndRoutineCommands.test.ts src/__tests__/foreignKeySql.test.ts src/__tests__/triggerList.test.ts src/__tests__/DatabaseTreeCapabilities.test.tsx
cargo test --manifest-path src-tauri/Cargo.toml sqlserver_objects
cargo test --manifest-path src-tauri/Cargo.toml foreign_key
npm run build
```

## 验收标准

- SQL Server 表索引可列表展示，普通/唯一索引可创建和删除。
- SQL Server 外键可展示 incoming/outgoing 关系，新增和删除外键可用。
- SQL Server 触发器可列表展示、查看定义、创建和删除。
- SQL Server 存储过程/函数可列表展示和查看定义。
- MySQL EVENT 入口在 SQL Server 下不可见。
- MySQL、PostgreSQL、SQLite 的对象管理无回归。
