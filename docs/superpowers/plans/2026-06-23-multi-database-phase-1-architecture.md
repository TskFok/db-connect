# 多数据库架构基础实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为当前项目建立 MySQL/PostgreSQL 可扩展架构，同时保持 MySQL 现有行为不变。

**Architecture:** 在 Rust 后端引入数据库类型、连接池枚举、adapter 与 dialect；在前端引入数据库类型与 capability map。该阶段以 MySQL 迁移到新抽象为主，不要求 PostgreSQL 完整连接可用。

**Tech Stack:** Tauri Rust commands, mysql_async, serde, React 18, TypeScript, Zustand, Vitest, Rust unit tests.

---

## 交付内容

- `ConnectionConfig` 增加 `database_type`，Rust/TypeScript 同步定义 `"mysql" | "postgres"`。
- Rust serde 对旧连接配置提供默认值：缺省 `database_type` 等同 MySQL。
- `ConnectionManager` 从单一 MySQL pool 演进为按数据库类型分发的活跃连接结构。
- 新增 MySQL adapter/dialect，先承接现有 MySQL 行为。
- 新增 capability map，前端可根据连接类型判断功能是否展示。
- PostgreSQL capability 初始只声明未来支持矩阵，不开放未实现入口。

## 实施步骤

- [x] 增加 Rust 与 TypeScript 数据库类型定义，并补充旧连接默认 MySQL 的测试。
- [x] 将连接配置脱敏、保存、导入导出、编辑表单和连接 store 接入 `database_type`。
- [x] 抽出 MySQL dialect：identifier 转义、字符串转义、schema/table 全限定名、分页、COUNT、只读 SQL 判断。
- [x] 将 `ConnectionManager` 的 pool 字段改为连接枚举，并保留 MySQL 分支现有连接、断开、ping、空闲超时行为。
- [x] 增加前端 capability map，并让 MySQL capability 全量开启、PostgreSQL capability 默认关闭未实现功能。
- [x] 更新测试覆盖旧连接兼容、MySQL capability、MySQL dialect 和连接表单默认值。

## 验收命令

```bash
npm test -- src/__tests__/connectionStore.test.ts src/__tests__/savedSqlConnection.test.ts src/__tests__/databaseStore.test.ts
cd src-tauri && cargo test
```

## 手工验收

- 新建 MySQL 连接时默认端口仍为 3306，未显式选择数据库类型也能保存和连接。
- 编辑旧连接时识别为 MySQL，不丢失密码、SSH、SSL、只读和分组配置。
- MySQL 下所有现有入口仍显示；PostgreSQL 类型连接在未实现阶段不显示 MySQL 专属入口。

## 完成标准

- MySQL 现有测试不因架构抽象退化。
- 旧连接数据向后兼容。
- 后续阶段可在 PostgreSQL adapter 中逐步实现命令，而不需要再改前端整体状态模型。
