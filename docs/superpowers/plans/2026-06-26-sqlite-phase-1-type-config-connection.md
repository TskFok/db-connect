# SQLite Phase 1 Connection Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为项目增加 SQLite 类型、连接配置、连接表单和后端连接生命周期基础，但不开放库表浏览。

**Architecture:** 复用现有 MySQL/PostgreSQL 多数据库分发结构，新增 `sqlite` 类型、`sqlite_path` 字段、SQLite adapter 和连接池分支。SQLite 作为本地文件连接，不展示 host/port/user/password/SSH/TLS 字段。

**Tech Stack:** Tauri Rust commands, serde, deadpool-sqlite, rusqlite bundled, React 18, TypeScript, Zustand, Vitest, Rust unit tests.

---

## 文件结构

- Modify: `src-tauri/Cargo.toml`，加入 SQLite 依赖。
- Modify: `src-tauri/Cargo.lock`，由 Cargo 更新。
- Modify: `src-tauri/src/models/types.rs`，加入 `DatabaseType::Sqlite` 与 `ConnectionConfig.sqlite_path`。
- Modify: `src-tauri/src/db/mod.rs`，导出 `sqlite` 模块。
- Create: `src-tauri/src/db/sqlite.rs`，负责 SQLite pool 构建、测试连接、ping、路径校验。
- Modify: `src-tauri/src/db/adapter.rs`，加入 `SqliteDatabaseAdapter`。
- Modify: `src-tauri/src/db/connection.rs`，加入 SQLite active connection、pool handle、prepare/test/ping/disconnect。
- Modify: `src-tauri/src/commands/connection.rs`，确保保存、导入、导出和连接测试保留 `sqlite_path`。
- Modify: `src/types/index.ts`，同步 `DatabaseType` 与 `sqlite_path`。
- Modify: `src/utils/connectionConfig.ts`，支持 SQLite 类型归一化和端口占位。
- Modify: `src/stores/connectionStore.ts`，连接复用比较纳入 `sqlite_path`。
- Modify: `src/components/connection/ConnectionForm.tsx`，SQLite 表单只展示文件路径、名称、只读和高危 SQL 设置。
- Test: `src/__tests__/ConnectionFormDatabaseType.test.tsx`
- Test: `src/__tests__/connectionStore.test.ts`
- Test: `src-tauri/src/models/types.rs` unit tests
- Test: `src-tauri/src/db/connection.rs` unit tests

## 任务

### Task 1: 前端类型与归一化

- [ ] 修改 `src/types/index.ts`：

```ts
export type DatabaseType = "mysql" | "postgres" | "sqlite";

export interface ConnectionConfig {
  id?: string;
  database_type?: DatabaseType;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  database?: string;
  sqlite_path?: string;
  ssh?: SshConfig;
  ssl_mode?: string;
  ssl_ca_path?: string;
  ssl_pkcs12_path?: string;
  ssl_pkcs12_password?: string;
  ssl_tls_hostname?: string;
  client_charset?: string;
  session_init_commands?: string[];
  read_only?: boolean;
  skip_dangerous_sql_confirm?: boolean;
  group_id?: string;
}
```

- [ ] 修改 `src/utils/connectionConfig.ts`：

```ts
export function normalizeDatabaseType(
  value: DatabaseType | string | null | undefined
): DatabaseType {
  if (value === "postgres") return "postgres";
  if (value === "sqlite") return "sqlite";
  return DEFAULT_DATABASE_TYPE;
}

export function defaultPortForDatabaseType(type: DatabaseType): number {
  if (type === "postgres") return 5432;
  if (type === "sqlite") return 0;
  return 3306;
}
```

- [ ] 增加 Vitest 用例：`normalizeDatabaseType("sqlite")` 返回 `"sqlite"`，未知类型仍返回 `"mysql"`，SQLite 默认端口为 `0`。

Run:

```bash
npm test -- src/__tests__/connectionStore.test.ts
```

Expected: 相关测试通过。

### Task 2: Rust 类型与序列化兼容

- [ ] 修改 `src-tauri/src/models/types.rs`：

```rust
pub enum DatabaseType {
    #[default]
    MySql,
    Postgres,
    Sqlite,
}

pub struct ConnectionConfig {
    pub id: Option<String>,
    #[serde(default)]
    pub database_type: DatabaseType,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub database: Option<String>,
    #[serde(default)]
    pub sqlite_path: Option<String>,
    pub ssh: Option<SshConfig>,
    #[serde(default)]
    pub ssl_mode: Option<String>,
    #[serde(default)]
    pub ssl_ca_path: Option<String>,
    #[serde(default)]
    pub ssl_pkcs12_path: Option<String>,
    #[serde(default)]
    pub ssl_pkcs12_password: Option<String>,
    #[serde(default)]
    pub ssl_tls_hostname: Option<String>,
    #[serde(default)]
    pub client_charset: Option<String>,
    #[serde(default)]
    pub session_init_commands: Option<Vec<String>>,
    #[serde(default)]
    pub read_only: Option<bool>,
    #[serde(default)]
    pub skip_dangerous_sql_confirm: Option<bool>,
    #[serde(default)]
    pub group_id: Option<String>,
}
```

- [ ] 更新 `fmt::Debug for ConnectionConfig`，输出 `sqlite_path`，不脱敏该字段。

- [ ] 新增 Rust 单测：

```rust
#[test]
fn test_connection_config_serializes_sqlite_type_and_path() {
    let json = r#"{"database_type":"sqlite","name":"Local","host":"","port":0,"username":"","password":null,"database":null,"sqlite_path":"/tmp/app.db","ssh":null}"#;
    let c: ConnectionConfig = serde_json::from_str(json).unwrap();
    assert_eq!(c.database_type, DatabaseType::Sqlite);
    assert_eq!(c.sqlite_path.as_deref(), Some("/tmp/app.db"));
}
```

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml test_connection_config_serializes_sqlite_type_and_path
```

Expected: 测试通过。

### Task 3: SQLite 依赖与后端模块

- [ ] 修改 `src-tauri/Cargo.toml`：

```toml
deadpool-sqlite = { version = "0.13", features = ["rt_tokio_1"] }
rusqlite = { version = "0.38", features = ["bundled"] }
```

- [ ] 修改 `src-tauri/src/db/mod.rs`：

```rust
pub mod sqlite;
```

- [ ] 创建 `src-tauri/src/db/sqlite.rs`：

```rust
use crate::models::types::ConnectionConfig;
use deadpool_sqlite::{Config as SqliteConfig, Pool, Runtime};
use std::path::Path;

#[derive(Clone)]
pub struct SqlitePoolHandle {
    pub pool: Pool,
}

pub fn sqlite_path_from_config(config: &ConnectionConfig) -> Result<String, String> {
    let path = config
        .sqlite_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "SQLite 连接需要选择数据库文件".to_string())?;
    Ok(path.to_string())
}

pub fn build_sqlite_pool(config: &ConnectionConfig) -> Result<SqlitePoolHandle, String> {
    let path = sqlite_path_from_config(config)?;
    if !Path::new(&path).exists() {
        return Err("SQLite 数据库文件不存在".to_string());
    }
    let cfg = SqliteConfig::new(path);
    let pool = cfg
        .create_pool(Runtime::Tokio1)
        .map_err(|e| format!("构造 SQLite 连接池失败: {}", e))?;
    Ok(SqlitePoolHandle { pool })
}

pub async fn test_pool(pool: &Pool) -> Result<(), String> {
    let conn = pool
        .get()
        .await
        .map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(|conn| {
        conn.query_row("SELECT 1", [], |_row| Ok(()))
            .map_err(|e| format!("查询测试失败: {}", e))
    })
    .await
    .map_err(|e| format!("SQLite 连接任务失败: {}", e))?
}

pub async fn ping_pool(pool: &Pool) -> bool {
    tokio::time::timeout(std::time::Duration::from_secs(3), test_pool(pool))
        .await
        .is_ok_and(|r| r.is_ok())
}
```

Run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: 编译通过或仅暴露下一任务需要接入的未使用警告。

### Task 4: 连接管理接入 SQLite

- [ ] 修改 `src-tauri/src/db/adapter.rs`，加入 SQLite adapter：

```rust
use deadpool_sqlite::Pool as SqlitePool;

pub struct SqliteDatabaseAdapter {
    pool: SqlitePool,
}

impl SqliteDatabaseAdapter {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub fn pool_clone(&self) -> SqlitePool {
        self.pool.clone()
    }
}

impl DatabaseAdapter for SqliteDatabaseAdapter {
    fn database_type(&self) -> DatabaseType {
        DatabaseType::Sqlite
    }
}
```

- [ ] 修改 `src-tauri/src/db/connection.rs`：

```rust
pub struct SqliteActiveConnection {
    pub adapter: SqliteDatabaseAdapter,
}

pub enum DatabasePoolHandle {
    MySql(Pool),
    Postgres(PostgresPoolHandle),
    Sqlite(sqlite::SqlitePoolHandle),
}

pub enum ActiveDatabaseConnection {
    MySql(MySqlActiveConnection),
    Postgres(PostgresActiveConnection),
    Sqlite(SqliteActiveConnection),
}
```

- [ ] 在 `prepare_connection` 和 `test_connection` 中增加 `DatabaseType::Sqlite` 分支，调用 `sqlite::build_sqlite_pool` 与 `sqlite::test_pool`。

- [ ] 在 `ping`、`pool_for_ping`、`disconnect`、`force_disconnect` 中增加 SQLite 分支。

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml test_active_database_connection_exposes_mysql_adapter_type
```

Expected: 既有测试继续通过。

### Task 5: 连接表单接入 SQLite

- [ ] 修改 `src/components/connection/ConnectionForm.tsx` 的数据库类型选项：

```ts
const DATABASE_TYPE_OPTIONS = [
  { value: "mysql", label: "MySQL" },
  { value: "postgres", label: "PostgreSQL" },
  { value: "sqlite", label: "SQLite" },
] satisfies Array<{ value: DatabaseType; label: string; disabled?: boolean }>;
```

- [ ] 当 `currentDatabaseType === "sqlite"` 时：

```tsx
<Form.Item name="sqlitePath" label="SQLite 文件" rules={[{ required: true, message: "请选择 SQLite 数据库文件" }]}>
  <SafeInput placeholder="/path/to/database.sqlite" />
</Form.Item>
```

- [ ] SQLite 模式下隐藏 host、port、username、password、database、SSL/TLS、SSH 隧道配置；保留连接名称、SQLite 文件、只读连接、高危 SQL 设置。

- [ ] `buildConfig` 为 SQLite 写入：

```ts
if (databaseType === "sqlite") {
  return {
    id: editingConnection?.id,
    database_type: "sqlite",
    name: values.name,
    host: "",
    port: 0,
    username: "",
    password: undefined,
    database: undefined,
    sqlite_path: values.sqlitePath?.trim(),
    read_only: values.readOnlyConn === true,
    skip_dangerous_sql_confirm: values.skipDangerousSql === true,
  };
}
```

- [ ] 更新连接复用逻辑，`database_type === "sqlite"` 时比较 `sqlite_path`、`read_only`、`skip_dangerous_sql_confirm` 和连接 `id`。

Run:

```bash
npm test -- src/__tests__/ConnectionFormDatabaseType.test.tsx src/__tests__/connectionStore.test.ts
```

Expected: SQLite 选项、默认值、保存配置和连接复用测试通过。

### Task 6: 阶段验收

- [ ] 运行前端相关测试：

```bash
npm test -- src/__tests__/ConnectionFormDatabaseType.test.tsx src/__tests__/connectionStore.test.ts
```

Expected: PASS。

- [ ] 运行 Rust 连接相关测试：

```bash
cargo test --manifest-path src-tauri/Cargo.toml connection
```

Expected: PASS。

- [ ] 合并前运行完整测试：

```bash
npm test
npm run test:rust
```

Expected: PASS。

- [ ] 提交建议：

```bash
git add src src-tauri
git commit -m "feat: 增加 SQLite 连接基础"
```
