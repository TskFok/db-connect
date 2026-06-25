# 多数据库功能完整与打磨实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 PostgreSQL 与当前 MySQL 客户端主要能力的追平，并补齐文档、导入导出、错误体验和产品命名评估。

**Architecture:** 在前序 adapter/dialect/capability 基础上补齐 PostgreSQL 文件工具、跨数据库文案和测试矩阵。保持 MySQL 回归稳定，无法等价的 MySQL 专属能力在 PostgreSQL 下保持明确不支持。

**Tech Stack:** Tauri Rust commands, SQL file import/export, React 18, Ant Design, README/docs, Vitest, Rust tests, release checklist.

---

## 交付内容

- PostgreSQL `.sql` 导入，按语句拆分执行并复用现有进度模型。
- PostgreSQL `.sql` 导出，支持结构和可选 INSERT 数据。
- PostgreSQL 导出 DDL 能覆盖 schema、table、view、index、foreign key、trigger、function/procedure。
- 跨数据库错误文案统一，MySQL/PostgreSQL 均返回明确中文错误。
- README、功能介绍弹窗、快捷键说明和安全说明更新为多数据库语境。
- 测试矩阵覆盖 MySQL 与 PostgreSQL 核心路径。
- 产品命名评估：保留 MySQL Connect 或迁移到多数据库客户端名称，并列出必要的包名、图标、README 和 Release Notes 调整。

## 实施步骤

- [x] 实现 PostgreSQL SQL 文件导入，保持只读连接和实例只读拦截。
- [x] 实现 PostgreSQL SQL 文件导出，避免在表循环中逐表查询可批量获取的元数据。
- [x] 增加 PostgreSQL DDL 导出和 INSERT 数据导出测试。
- [x] 梳理所有 MySQL 文案，改为数据库类型中立文案或按类型动态展示。
- [x] 更新 README、项目功能介绍、安全说明和开发说明。
- [x] 建立手工测试矩阵，覆盖 MySQL 与 PostgreSQL 的连接、浏览、SQL、CRUD、DDL、对象管理和导入导出。见 `docs/superpowers/manual-tests/2026-06-23-multi-database-phase-6-matrix.md`。
- [x] 输出产品命名评估结论；本阶段保留 MySQL Connect，不改名，后续如迁移品牌另开独立发布计划。见 `docs/superpowers/decisions/2026-06-23-product-naming-evaluation.md`。

## 验收命令

```bash
npm test
cd src-tauri && cargo test
npm run build
```

## 手工验收

- PostgreSQL 可以导入 `.sql` 文件，错误时展示失败语句摘要。
- PostgreSQL 可以导出结构和数据，导出的 SQL 可重新导入到空 schema。
- MySQL SQL 导入导出仍保持现有行为。
- README 和功能介绍不再把应用描述为仅支持 MySQL，除非命名评估决定暂不改产品名。
- 全部 PostgreSQL 已支持能力在 UI 中可发现，未支持或无等价能力不误展示。
- MySQL 与 PostgreSQL 的关键路径均完成一次完整手工回归。

## 完成标准

- PostgreSQL 主要能力追平当前 MySQL 客户端。
- 多数据库支持在文档、UI、测试和错误体验上闭环。
- 产品命名后续动作有明确结论和独立执行边界。
