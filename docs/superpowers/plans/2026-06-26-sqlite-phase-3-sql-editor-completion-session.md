# SQLite Phase 3 SQL Editor Completion Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 SQLite 开放 SQL 编辑器执行、SQL 补全、会话信息和 EXPLAIN。

**Architecture:** SQLite SQL 执行集中在 `db/sqlite.rs`，用 `rusqlite` statement metadata 判断是否返回结果集，并复用当前 `SqlExecuteResult`。SQL 补全通过批量读取 `sqlite_schema` 与 table-valued PRAGMA 生成，避免在表循环中逐项查询。

**Tech Stack:** Tauri Rust commands, deadpool-sqlite, rusqlite, Monaco completion utilities, React capability map, Vitest, Rust unit tests.

---

## 文件结构

- Modify: `src-tauri/src/db/dialect.rs`，增加 SQLite 只读 SQL 判断。
- Modify: `src-tauri/src/db/sqlite.rs`，增加 SQL 执行、补全元数据、会话信息、EXPLAIN helper。
- Modify: `src-tauri/src/commands/data.rs`，为 `execute_sql`、`get_session_info`、`explain_sql` 分发 SQLite。
- Modify: `src-tauri/src/commands/database/mod.rs`，为 `get_sql_completion_metadata` 分发 SQLite。
- Modify: `src/utils/sqlCompletion.ts`，增加 SQLite 关键词与双引号标识符。
- Modify: `src/utils/sqlCompletionSchema.ts`，接受 SQLite dialect。
- Modify: `src/components/sql/SqlEditor.tsx`，SQLite 文案、EXPLAIN 按钮和会话信息标签。
- Modify: `src/utils/databaseCapabilities.ts`，开放 SQLite `sqlEditor`。
- Test: `src/__tests__/sqlCompletion.test.ts`
- Test: `src/__tests__/sqlCompletionSchema.test.ts`
- Test: `src/__tests__/sqlExecutionCommands.test.ts`
- Test: Rust unit tests in `src-tauri/src/db/sqlite.rs`

## 任务

### Task 1: SQLite 只读 SQL 判断

- [ ] 在 `SqliteDialect` 增加：

```rust
pub fn sql_editor_allowed_on_read_only_connection(&self, sql: &str) -> bool {
    let upper = sql.trim().to_uppercase();
    if upper.starts_with("WITH") {
        return !self.with_statement_contains_write(&upper);
    }
    upper.starts_with("SELECT")
        || upper.starts_with("EXPLAIN")
        || self.is_readonly_pragma(&upper)
}

fn is_readonly_pragma(&self, upper_sql: &str) -> bool {
    let allowed = [
        "PRAGMA DATABASE_LIST",
        "PRAGMA TABLE_LIST",
        "PRAGMA TABLE_INFO",
        "PRAGMA TABLE_XINFO",
        "PRAGMA INDEX_LIST",
        "PRAGMA INDEX_INFO",
        "PRAGMA INDEX_XINFO",
        "PRAGMA FOREIGN_KEY_LIST",
        "PRAGMA QUICK_CHECK",
        "PRAGMA INTEGRITY_CHECK",
    ];
    allowed.iter().any(|prefix| upper_sql.starts_with(prefix))
}
```

- [ ] 增加测试：只读连接允许 `SELECT 1`、`EXPLAIN SELECT 1`、`PRAGMA table_info(users)`；拒绝 `PRAGMA journal_mode=WAL`、`ATTACH`、`VACUUM`、`INSERT`。

### Task 2: SQL 执行结果转换

- [ ] 在 `sqlite.rs` 增加 `run_sql_on_pool(pool, sql, read_only, start)`：

```rust
pub async fn run_sql_on_pool(
    pool: &Pool,
    sql: &str,
    read_only: bool,
    start: std::time::Instant,
) -> Result<SqlExecuteResult, String> {
    if read_only && !SQLITE_DIALECT.sql_editor_allowed_on_read_only_connection(sql) {
        return Err("当前连接为只读模式，仅允许 SELECT/EXPLAIN/安全 PRAGMA 等读操作".to_string());
    }
    let sql = sql.to_string();
    let conn = pool.get().await.map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(move |conn| run_sql_on_conn(conn, &sql, start))
        .await
        .map_err(|e| format!("SQLite SQL 执行任务失败: {}", e))?
}
```

- [ ] `run_sql_on_conn` 判断 `stmt.column_count() > 0` 时按结果集处理；否则执行写类语句并返回 affected rows。

- [ ] 结果集行数超过 `MAX_EXECUTE_SQL_SELECT_ROWS` 时返回：

```text
查询结果超过最大行数 100000（与 Excel 导出行上限一致），请使用 LIMIT 或缩小范围后重试
```

### Task 3: 命令层执行分发

- [ ] 在 `src-tauri/src/commands/data.rs` 的 `execute_sql` 中增加：

```rust
DatabasePoolHandle::Sqlite(handle) => {
    let start = Instant::now();
    sqlite::run_sql_on_pool(&handle.pool, &sql, read_only, start).await
}
```

- [ ] SQLite 本阶段不登记 `RunningQuery`。用户取消正在运行的 SQLite 查询时，`cancel_query` 返回 `false`，前端保留现有“未取消或已完成”的处理。

- [ ] 在 `explain_sql` 中增加 SQLite 分支，`analyze` 参数为 true 时返回：

```rust
Err("SQLite 暂不支持 EXPLAIN ANALYZE".to_string())
```

`analyze` 为 false 时执行 `EXPLAIN QUERY PLAN <sql>`。

### Task 4: SQL 补全元数据

- [ ] 在 `sqlite.rs` 增加 `get_sql_completion_metadata(pool, database)`。

- [ ] database 为空时返回 `list_databases(pool)`，tables/columns 为空。

- [ ] database 非空时使用单条批量查询：

```sql
SELECT m.name AS table_name,
       x.name AS column_name,
       x.type AS column_type
FROM "<schema>".sqlite_schema AS m
LEFT JOIN pragma_table_xinfo(m.name, "<schema>") AS x
WHERE m.type IN ('table', 'view')
  AND m.name NOT LIKE 'sqlite_%'
ORDER BY m.name, x.cid
```

- [ ] 对 `table_name` 去重生成 `SqlCompletionTable`，`column_name` 非空时生成 `SqlCompletionColumn`。

### Task 5: 会话信息

- [ ] 在 `sqlite.rs` 增加：

```rust
pub async fn get_session_info(pool: &Pool, database: Option<String>, path: Option<String>, read_only: bool) -> Result<SessionInfo, String>
```

- [ ] 字段映射：

```rust
SessionInfo {
    version: sqlite_version(),
    hostname: "local".to_string(),
    server_read_only: read_only,
    max_execution_time_ms: 0,
    time_zone: "local".to_string(),
    database,
    connection_id: 0,
    grant_write_capable: !read_only,
}
```

- [ ] `database` 优先使用前端传入的选中 database；为空时使用 `"main"`。

### Task 6: 前端 SQL 编辑器与补全

- [ ] 修改 `src/utils/sqlCompletion.ts`：

```ts
export type SqlDialect = "mysql" | "postgres" | "sqlite";
```

- [ ] SQLite 关键词包含：

```ts
const SQLITE_KEYWORDS = [
  "SELECT", "FROM", "WHERE", "INSERT", "UPDATE", "DELETE", "CREATE", "ALTER",
  "DROP", "TABLE", "VIEW", "INDEX", "TRIGGER", "PRAGMA", "EXPLAIN",
  "QUERY PLAN", "WITH", "RETURNING", "ON CONFLICT", "VACUUM", "ATTACH", "DETACH"
];
```

- [ ] `quoteIdentifier` 中 `postgres` 与 `sqlite` 都使用双引号。

- [ ] `SqlEditor.tsx` 中 SQLite 的会话标签显示：`sqlite_version()`、`local`、`read_only`、`database`。

- [ ] `getDatabaseCapabilities("sqlite").sqlEditor` 改为 `true`。

Run:

```bash
npm test -- src/__tests__/sqlCompletion.test.ts src/__tests__/sqlCompletionSchema.test.ts src/__tests__/sqlExecutionCommands.test.ts
```

Expected: PASS。

### Task 7: 阶段验收

- [ ] 运行阶段测试：

```bash
npm test -- src/__tests__/sqlCompletion.test.ts src/__tests__/sqlCompletionSchema.test.ts src/__tests__/sqlExecutionCommands.test.ts
cargo test --manifest-path src-tauri/Cargo.toml sqlite
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
git commit -m "feat: 支持 SQLite SQL 编辑器"
```

