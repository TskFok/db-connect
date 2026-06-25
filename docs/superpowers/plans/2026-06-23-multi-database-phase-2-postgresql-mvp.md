# PostgreSQL MVP 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 PostgreSQL 在当前客户端中达到可连接、可浏览、可查询和可只读查看数据的 MVP 状态。

**Architecture:** PostgreSQL 使用独立 adapter 和 dialect。连接配置中的 `database` 表示 PostgreSQL 物理 database，左侧树第一层展示 schema，并复用现有“数据库 > 表”两层 UI。

**Tech Stack:** Tauri Rust commands, tokio-postgres, deadpool-postgres, React 18, Zustand, Ant Design, Vitest, Rust tests.

---

## 交付内容

- PostgreSQL 直连、SSH 隧道连接、测试连接、断开、ping、空闲超时清理。
- PostgreSQL SQL 编辑器执行，支持结果集和非结果集语句。
- PostgreSQL 取消查询，使用 `tokio-postgres` cancel token。
- `list_databases` 在 PostgreSQL 下返回 schema 列表，排除 `pg_catalog`、`information_schema`、`pg_toast` 等系统 schema。
- `list_tables` 返回指定 schema 下普通表和视图。
- `get_table_structure` 返回列名、类型、nullable、默认值、主键信息和 identity/generated 信息。
- `query_table_data` 与 `query_table_count` 支持 PostgreSQL schema/table、排序、分页和安全 where 子句。
- 前端连接表单支持 MySQL/PostgreSQL 类型切换，PostgreSQL 默认端口 5432。

## 实施步骤

- [x] 增加 PostgreSQL Rust 依赖和连接配置构造，复用 SSH 隧道本地端口。
- [x] 实现 PostgreSQL adapter 的连接、测试连接、断开、ping、取消查询。
- [x] 实现 PostgreSQL dialect：双引号标识符、字符串字面量、schema.table 拼接、LIMIT/OFFSET、COUNT 包装。
- [x] 实现 schema、table、column 元数据批量查询，避免在循环中查询 SQL。
- [x] 实现 PostgreSQL 表数据分页读取和 SQL 编辑器结果转换。
- [x] 前端连接表单按类型动态切换端口、文案和 SSL 可用项。
- [x] PostgreSQL capability 开启连接、浏览、结构只读、数据只读、SQL 执行；关闭表格 CRUD、DDL、对象管理和导入导出。

## 验收命令

```bash
npm test -- src/__tests__/connectionStore.test.ts src/__tests__/databaseStore.test.ts src/__tests__/tableDataStore.test.ts src/__tests__/sqlExecutionCommands.test.ts
cd src-tauri && cargo test
```

## 手工验收

- PostgreSQL 直连测试成功，连接后能看到 schema 列表。
- PostgreSQL 通过 SSH 隧道连接成功，schema/table 浏览正常。
- 选择 schema 后能看到表和视图，打开表后能查看结构和分页数据。
- SQL 编辑器执行 `SELECT 1`、`EXPLAIN SELECT 1`、普通 DDL/DML 语句时能给出结果或影响行数。
- 长查询可以取消，取消后连接仍能继续执行新查询。
- PostgreSQL 下新增、编辑、删除行、索引、外键、触发器、导入导出等入口不显示或禁用。
- MySQL 连接、库表浏览、数据查看和 SQL 编辑器仍按原有方式工作。

## 完成标准

- PostgreSQL MVP 可用于日常只读浏览和 SQL 查询。
- 不支持功能有明确 UI 隐藏和后端错误保护。
- MySQL 回归通过。
