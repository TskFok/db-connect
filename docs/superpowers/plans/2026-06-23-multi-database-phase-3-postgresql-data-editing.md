# PostgreSQL 数据编辑实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 PostgreSQL 表格数据页补齐新增行、编辑行、批量更新和删除行能力。

**Architecture:** 复用当前表格交互和 Zustand 状态，后端在 PostgreSQL adapter 中实现参数化 INSERT/UPDATE/DELETE。所有定位写操作依赖主键或可唯一定位的行标识；无法安全定位时拒绝写入。

**Tech Stack:** Tauri Rust commands, PostgreSQL driver params, React 18, Ant Design Table, Zustand, Vitest, Rust tests.

---

## 交付内容

- PostgreSQL `insert_row`，支持基础标量、null、bool、number、string、date/time/json 文本输入。
- PostgreSQL `update_row` 与 `batch_update_rows`，基于主键生成 WHERE 条件。
- PostgreSQL `delete_rows`，基于主键批量删除。
- 无主键表在 UI 中禁用编辑和删除，并显示明确提示。
- 只读连接继续阻止所有表格写操作。
- PostgreSQL 参数绑定使用 `$1`、`$2` 形式，不拼接用户输入值。

## 实施步骤

- [x] 扩展 PostgreSQL 主键查询，打开表时一次性获取主键列。
- [x] 实现 PostgreSQL JSON value 到参数值的转换规则，覆盖 null、bool、整数、浮点、字符串和日期时间文本。
- [x] 实现 `insert_row`，返回影响行数并刷新当前页。
- [x] 实现 `update_row` 与批量更新（事务内逐行 prepare_typed，失败立即回滚），WHERE 条件只使用主键列。
- [x] 实现 `delete_rows`，多行删除使用参数化 `IN ($1, $2, ...)`。
- [x] 前端 capability 打开 PostgreSQL 数据页新增、编辑、删除入口。
- [x] 在无主键、只读连接、实例只读或权限不足时禁用入口并展示中文原因。

## 验收命令

```bash
npm test -- --run src/__tests__/TableDataSelection.test.tsx src/__tests__/editableCell.test.ts src/__tests__/tableDataStore.test.ts src/__tests__/copyAsInsert.test.ts src/__tests__/databaseCapabilities.test.ts src/__tests__/tableDataColumnHints.test.ts
cd src-tauri && cargo test
```

## 手工验收

- PostgreSQL 有主键表可以新增、编辑、批量提交和删除行。
- PostgreSQL 无主键表仍可浏览，但编辑和删除入口不可用。
- PostgreSQL 只读连接下所有表格写入口禁用。
- 写入失败时保留未提交编辑状态，并显示后端错误。
- MySQL 表格新增、编辑、批量更新和删除行为不变。

## 完成标准

- PostgreSQL 常规数据维护可通过表格 UI 完成。
- 参数化写入覆盖所有用户输入值。
- 无主键表不会产生误更新或误删除风险。

