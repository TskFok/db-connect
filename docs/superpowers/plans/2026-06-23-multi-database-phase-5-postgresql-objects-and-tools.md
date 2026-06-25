# PostgreSQL 对象与工具实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 PostgreSQL 补齐索引、外键、触发器、函数/过程和 SQL 工具能力。

**Architecture:** 对象管理继续复用当前页签结构，但后端以 PostgreSQL catalog 查询和 PostgreSQL DDL 实现。MySQL Event 无 PostgreSQL 等价物，PostgreSQL 下明确不展示事件页签。

**Tech Stack:** Tauri Rust commands, PostgreSQL catalog queries, Mermaid, Monaco SQL completion, React 18, Vitest, Rust tests.

---

## 交付内容

- PostgreSQL 索引列表、创建、删除，支持普通、唯一和常用方法。
- PostgreSQL 外键列表、关系图、新建和删除。
- PostgreSQL 触发器列表、定义查看、创建和删除。
- PostgreSQL function/procedure 列表、定义查看和删除。
- PostgreSQL SQL completion 支持 schema、table、column。
- PostgreSQL EXPLAIN 与 EXPLAIN ANALYZE。
- PostgreSQL 会话信息：版本、当前 database、当前 schema、server address、只读事务状态、连接进程 ID。
- PostgreSQL 权限与只读探测，用于 UI 写入口灰显。

## 实施步骤

- [x] 实现 PostgreSQL index catalog 查询和 DDL，前端按 capability 打开索引页签。
- [x] 实现 PostgreSQL foreign key catalog 查询，复用 Mermaid 关系图数据结构。
- [x] 实现 PostgreSQL add/drop foreign key DDL。
- [x] 实现 PostgreSQL trigger 查询、定义读取、创建和删除。
- [x] 实现 PostgreSQL function/procedure 查询、定义读取和删除；PostgreSQL 下不展示 MySQL Event。
- [x] 扩展 SQL completion 数据源，按 PostgreSQL schema/table/column 批量加载。
- [x] 实现 PostgreSQL explain、session info、权限/只读探测。

## 验收命令

```bash
npm test -- src/__tests__/indexList.test.ts src/__tests__/foreignKeyAndRoutineCommands.test.ts src/__tests__/foreignKeyMermaid.test.ts src/__tests__/triggerList.test.ts src/__tests__/sqlCompletion.test.ts
cd src-tauri && cargo test
```

## 手工验收

- PostgreSQL 表能查看索引，创建普通/唯一索引并删除。
- PostgreSQL 表能查看外键，关系图正确显示引用方向，新增和删除外键成功。
- PostgreSQL 触发器能列表、查看定义、创建和删除。
- PostgreSQL function/procedure 能列表、查看定义和删除。
- PostgreSQL SQL 编辑器补全 schema、table、column。
- PostgreSQL EXPLAIN/EXPLAIN ANALYZE 可执行并展示结果集。
- PostgreSQL 权限不足或只读状态下写入口灰显。
- MySQL 索引、外键、触发器、例程和事件能力不变。

## 完成标准

- PostgreSQL 常见数据库对象可以在 UI 中管理。
- MySQL Event 在 PostgreSQL 下不会误展示。
- SQL 工具能力按数据库类型正确分发。

