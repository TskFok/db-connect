# PostgreSQL Schema 与表结构管理实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 PostgreSQL 补齐 schema、table 和 column 级别的可视化管理能力。

**Architecture:** 保持前端现有数据库/表/结构页交互模型，PostgreSQL adapter 提供 PostgreSQL 专属 DDL。MySQL 存储引擎、字符集和排序规则相关入口不在 PostgreSQL 下展示。

**Tech Stack:** Tauri Rust commands, PostgreSQL DDL, React 18, Ant Design forms, Zustand, Vitest, Rust tests.

---

## 交付内容

- PostgreSQL schema 创建、删除、重命名。
- PostgreSQL 表创建、删除、重命名、清空。
- PostgreSQL 列新增、修改、删除，支持类型、nullable、默认值、注释和位置能力的等价处理。
- PostgreSQL 主键新增、删除、调整。
- PostgreSQL 表定义查看，使用 `pg_get_viewdef`、catalog 查询或生成可读 DDL。
- 前端隐藏 MySQL 专属存储引擎编辑，改为 PostgreSQL 适用的 schema/table 文案。

## 实施步骤

- [x] 将现有 database 操作按 capability 区分为 MySQL database 与 PostgreSQL schema 操作。
- [x] 实现 PostgreSQL create/drop/rename schema，阻止删除系统 schema。
- [x] 实现 PostgreSQL create/drop/rename/truncate table，所有标识符走 dialect。
- [x] 实现 PostgreSQL column DDL：ADD COLUMN、ALTER TYPE、SET/DROP NOT NULL、SET/DROP DEFAULT、COMMENT、DROP COLUMN。
- [x] 实现 PostgreSQL primary key DDL，避免在循环中逐列查询。
- [x] 更新表结构 UI，使 PostgreSQL 下不展示 engine 字段，identity/generated 信息只读展示。
- [x] 为 PostgreSQL DDL 错误增加中文可读提示。

## 验收命令

```bash
npm test -- src/__tests__/createTable.test.ts src/__tests__/createTableSql.test.ts src/__tests__/TableStructureMetadata.test.tsx src/__tests__/TableStructureReorderConfirm.test.tsx
cd src-tauri && cargo test
```

## 手工验收

- PostgreSQL 可以创建 schema，刷新后 schema 出现在左侧第一层。
- PostgreSQL 可以创建表、查看结构、重命名表、清空表、删除表。
- PostgreSQL 可以新增列、修改列类型/nullable/default/comment、删除列。
- PostgreSQL 主键调整成功后，数据编辑阶段的更新和删除仍能正确定位。
- PostgreSQL 下不显示 MySQL 存储引擎相关控件。
- MySQL 建库、改字符集、建表、改列、改引擎等现有能力不变。

## 完成标准

- PostgreSQL schema/table/column 的主要结构维护可视化可用。
- PostgreSQL 与 MySQL DDL 差异由 adapter 处理，前端不拼接数据库方言 SQL。

