# SQL Server Phase 1 Type Config Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加 SQL Server 类型、连接表单、依赖和后端连接生命周期基础，但不开放库表浏览。

**Architecture:** 复用现有多数据库连接分发结构，新增 `sqlserver` 类型、`SqlServerActiveConnection`、`DatabasePoolHandle::SqlServer` 和 `src-tauri/src/db/sqlserver.rs`。SQL Server 使用连接配置中的物理 database，后续阶段在该 database 内展示 schema。

**Tech Stack:** Tauri Rust commands, tiberius, bb8-tiberius, native-tls, React 18, TypeScript, Zustand, Vitest, Rust unit tests.

---

## 目标

- 前后端识别并保存 `sqlserver` 数据库类型。
- 连接表单支持 SQL Server，默认端口为 1433，保留 host、port、username、password、database、SSH、TLS、只读和高危 SQL 配置。
- 后端能测试连接、建立连接、断开连接和 ping。
- SQL Server capability 初始只打开连接层需要的基础能力，不开放浏览、编辑、导入导出和对象管理。

## 文件改动边界

- Modify: `src-tauri/Cargo.toml`，加入 SQL Server 驱动和连接池依赖。
- Modify: `src-tauri/Cargo.lock`，由 Cargo 更新依赖锁定。
- Modify: `src-tauri/src/models/types.rs`，加入 `DatabaseType::SqlServer`。
- Modify: `src-tauri/src/db/mod.rs`，导出 `sqlserver` 模块。
- Create: `src-tauri/src/db/sqlserver.rs`，负责构建 SQL Server 连接配置、连接池、测试连接、ping 和错误归一化。
- Modify: `src-tauri/src/db/adapter.rs`，加入 `SqlServerDatabaseAdapter`。
- Modify: `src-tauri/src/db/connection.rs`，加入 SQL Server active connection、pool handle、prepare/test/ping/disconnect。
- Modify: `src-tauri/src/commands/connection.rs`，确保保存、导入、导出和测试连接识别 `sqlserver`。
- Modify: `src/types/index.ts`、`src/utils/connectionConfig.ts`、`src/utils/databaseCapabilities.ts`、`src/components/connection/ConnectionForm.tsx`。
- Test: `src/__tests__/ConnectionFormDatabaseType.test.tsx`、`src/__tests__/connectionStore.test.ts`、`src/__tests__/savedSqlConnection.test.ts`、`src/__tests__/databaseCapabilities.test.ts`，以及 Rust 类型和连接单元测试。

## 风险控制

- 只新增连接基础，不改库表树、数据查询和 DDL 行为。
- SQL Server 依赖只在 `src-tauri/Cargo.toml` 中新增，避免影响前端构建。
- 若 `bb8-tiberius` 与当前 Tokio/native-tls 组合存在兼容问题，本阶段只允许在 `sqlserver.rs` 内替换池封装，不改变命令层接口。
- SSH 隧道逻辑复用 MySQL/PostgreSQL 的锁外建连模式，连接失败时必须关闭已建立隧道。
- 旧连接没有 `database_type` 时仍按 MySQL 反序列化。

## 任务清单

- [ ] Rust `DatabaseType` 增加 `SqlServer`，确认 serde 值为 `"sqlserver"`，补充旧 JSON 默认 MySQL 和 SQL Server JSON 反序列化测试。
- [ ] TypeScript `DatabaseType` 增加 `"sqlserver"`；`normalizeDatabaseType` 识别该值；`defaultPortForDatabaseType("sqlserver")` 返回 `1433`。
- [ ] `ConnectionForm` 增加 SQL Server 选项和品牌文案；SQL Server 使用服务端数据库字段，不显示 SQLite 文件字段。
- [ ] 新增 `SQLSERVER_CAPABILITIES`，Phase 1 仅保守设置 `sqlEditor: false`、`tableBrowsing: false`、写类和对象管理能力全部为 `false`，`databaseObjectNoun: "schema"`。
- [ ] `Cargo.toml` 增加 `tiberius` 与 `bb8-tiberius`；按 2026-06-29 Cargo 元数据优先使用 `tiberius 0.12.3`、`bb8-tiberius 0.16.0`。
- [ ] 创建 `src-tauri/src/db/sqlserver.rs`：从 `ConnectionConfig` 构建 host、port、database、SQL Server 用户密码认证、TLS 模式和连接超时。
- [ ] 在 `sqlserver.rs` 中实现 `test_pool` 和 `ping_pool`，统一执行 `SELECT 1`。
- [ ] `adapter.rs` 加入 `SqlServerDatabaseAdapter`，提供 `pool_clone` 和 `close`。
- [ ] `connection.rs` 加入 `SqlServerActiveConnection`、`DatabasePoolHandle::SqlServer`、`prepare_sqlserver_connection`、`test_sqlserver_connection` 和断开清理。
- [ ] `commands/connection.rs` 的保存、导入、导出测试覆盖 SQL Server 类型不会丢失。
- [ ] 补充前端和 Rust 单元测试，覆盖默认端口、连接表单切换、capability 默认关闭、序列化兼容和连接错误文案。

## 测试命令

```bash
npm test -- src/__tests__/ConnectionFormDatabaseType.test.tsx src/__tests__/connectionStore.test.ts src/__tests__/savedSqlConnection.test.ts src/__tests__/databaseCapabilities.test.ts
cargo test --manifest-path src-tauri/Cargo.toml sqlserver
cargo test --manifest-path src-tauri/Cargo.toml connection_config
npm run build
```

## 验收标准

- 新建 SQL Server 连接时默认端口为 1433，保存后重新编辑仍显示为 SQL Server。
- 旧 MySQL 连接缺省 `database_type` 时仍按 MySQL 展示和连接。
- SQL Server 测试连接成功时返回中文成功消息和耗时；失败时返回包含 SQL Server 上下文的中文错误。
- SQL Server 连接失败不会泄漏 SSH 隧道或活跃连接记录。
- MySQL、PostgreSQL、SQLite 的连接测试和保存行为无回归。
- 前端未展示 SQL Server 尚未实现的库表浏览、编辑、导入导出和对象管理入口。
