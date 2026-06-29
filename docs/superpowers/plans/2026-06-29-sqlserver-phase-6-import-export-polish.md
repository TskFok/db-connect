# SQL Server Phase 6 Import Export Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 SQL Server SQL 文件导入导出、保存 SQL、收藏表、文档、手工测试矩阵和跨数据库体验打磨。

**Architecture:** 导入导出复用现有 `sql_file` 命令入口，SQL Server DDL 导出集中在 `sqlserver_objects.rs` 或独立导出函数中；前端 polish 只通过 capability 和文案映射调整，不引入新的状态模型。

**Tech Stack:** Tauri Rust commands, SQL Server metadata scripting, React UI, Vitest, manual QA.

---

## 目标

- SQL Server 支持 SQL 文件执行导入，遵守只读连接和高危 SQL 拦截。
- SQL Server 支持当前 schema/table 的基础 DDL 导出和数据导出。
- 评估并打开 saved SQL、favorite tables。
- 增加 README、功能说明和 SQL Server 手工测试矩阵。
- 完成 MySQL、PostgreSQL、SQLite、SQL Server 跨数据库回归。

## 文件改动边界

- Modify: `src-tauri/src/commands/sql_file.rs`，接入 SQL Server 导入导出分支。
- Modify: `src-tauri/src/db/sqlserver.rs`、`src-tauri/src/db/sqlserver_objects.rs`，增加导出 DDL、批量执行 SQL 文件和安全拆分逻辑。
- Modify: `src/utils/databaseCapabilities.ts`，按验收结果打开 `sqlFileImportExport`、`savedSql`、`favoriteTables`。
- Modify: `src/utils/sqlFileIoUi.ts`、`src/components/database/DatabaseSqlFileActions.tsx`、`src/components/database/SavedSqlDropdown.tsx`、`src/components/database/FavoriteTables.tsx`。
- Modify: `README.md`，补充 SQL Server 支持范围和限制。
- Create: `docs/superpowers/manual-tests/2026-06-29-sqlserver-support-matrix.md`，记录手工测试矩阵。
- Test: `src/__tests__/sqlFileIoUi.test.ts`、`src/__tests__/DatabaseSqlFileActions.test.tsx`、`src/__tests__/SavedSqlDropdown.test.tsx`、`src/__tests__/FavoriteTables.test.tsx`、`src/__tests__/databaseCapabilities.test.ts`，以及 Rust SQL 文件命令单元测试。

## 风险控制

- SQL Server SQL 文件导入默认逐批执行，识别 `GO` 批处理分隔符；字符串和注释中的 `GO` 不应被错误拆分。
- 只读连接禁止导入、导出中的写类执行和高危操作。
- DDL 导出首版覆盖 schema/table/index/foreign key/trigger/routine 定义；无法无损导出的属性在文档中列为限制，不生成误导性 SQL。
- 数据导出沿用现有 CSV/Excel/SQL 行数和内存限制。
- saved SQL 和 favorite tables 只在连接类型、schema/table 标识可稳定序列化后打开。
- 文档必须明确 SQL Server 当前使用“连接 database 内 schema 树”，不是 server 级 database 管理工具。

## 任务清单

- [ ] `sql_file.rs` 接入 SQL Server SQL 文件导入，支持 `GO` 批处理拆分和逐批错误定位。
- [ ] SQL Server SQL 文件导入复用 SQL 编辑器只读判断和高危 SQL 确认策略。
- [ ] 实现 SQL Server 表 DDL 导出，覆盖列、nullable、identity、default、primary key、普通/唯一索引、外键和触发器。
- [ ] 实现 SQL Server 数据导出为 INSERT 语句，字符串、日期、二进制、NULL 和大整数转义正确。
- [ ] 打开 `sqlFileImportExport`，通过测试后打开 `savedSql` 和 `favoriteTables`。
- [ ] 更新前端 SQL 文件按钮、保存 SQL 下拉和收藏表文案，避免 SQL Server 下出现 MySQL 专属描述。
- [ ] 更新 `README.md`，写明 SQL Server 支持能力、限制、TLS/SSH 说明和三层树非目标。
- [ ] 创建 SQL Server 手工测试矩阵，覆盖连接、浏览、SQL 编辑器、编辑、DDL、对象、导入导出和跨库回归。
- [ ] 运行全量前端、Rust 和构建测试，记录任何环境依赖失败原因。

## 测试命令

```bash
npm test -- src/__tests__/sqlFileIoUi.test.ts src/__tests__/DatabaseSqlFileActions.test.tsx src/__tests__/SavedSqlDropdown.test.tsx src/__tests__/FavoriteTables.test.tsx src/__tests__/databaseCapabilities.test.ts
cargo test --manifest-path src-tauri/Cargo.toml sql_file
cargo test --manifest-path src-tauri/Cargo.toml sqlserver
npm test
npm run test:rust
npm run build
```

## 验收标准

- SQL Server SQL 文件可导入，`GO` 批处理拆分正确，失败时能定位批次和错误。
- SQL Server 表结构和数据可导出，导出的 SQL 能在同一 database/schema 下重放。
- saved SQL 和 favorite tables 在 SQL Server 下行为稳定，跨连接不串数据。
- README 和手工测试矩阵完整说明支持范围、限制和回归步骤。
- 全量测试和构建通过；若本机缺少真实 SQL Server，只允许把真实连接验证记录在手工矩阵中，不跳过自动化测试。
- MySQL、PostgreSQL、SQLite、SQL Server 的能力矩阵和 UI 入口一致，没有误开放未实现功能。
