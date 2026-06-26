# SQLite Phase 2 Browsing And Readonly Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 SQLite 连接可以展示 database 列表、表/视图列表、表结构，并分页查看只读表数据。

**Architecture:** SQLite 使用 `PRAGMA database_list` 和 `sqlite_schema` 建立两层树，第一层为 `main` / `temp` / attached database，第二层为表和视图。分页数据读取、COUNT、排序和 WHERE 走 SQLite dialect，所有表列表和补全候选必须批量查询，禁止在表循环中逐个查询 SQL。

**Tech Stack:** Rust Tauri commands, deadpool-sqlite, rusqlite, SQLite PRAGMA table-valued functions, React capability map, Vitest, Rust unit tests.

---

## 文件结构

- Modify: `src-tauri/src/db/dialect.rs`，增加 `SqliteDialect`。
- Modify: `src-tauri/src/db/sql_utils.rs`，导出 SQLite 标识符、字符串、分页和 COUNT helper。
- Modify: `src-tauri/src/db/sqlite.rs`，增加列表、结构、COUNT、分页查询和 row 转 JSON。
- Modify: `src-tauri/src/commands/database/mod.rs`，为 `list_databases`、`list_tables`、`get_table_structure` 分发 SQLite。
- Modify: `src-tauri/src/commands/data.rs`，为 `query_table_count`、`query_table_data` 分发 SQLite。
- Modify: `src/utils/databaseCapabilities.ts`，首批开放 SQLite 浏览能力。
- Modify: `src/utils/whereFilterUtils.ts`，SQLite 走双引号标识符和单引号字符串规则。
- Test: `src/__tests__/databaseCapabilities.test.ts`
- Test: `src/__tests__/whereFilterUtils.test.ts`
- Test: Rust unit tests in `src-tauri/src/db/dialect.rs`
- Test: Rust unit tests in `src-tauri/src/db/sqlite.rs`

## 任务

### Task 1: SQLite dialect

- [ ] 在 `src-tauri/src/db/dialect.rs` 增加：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SqliteDialect;

impl SqliteDialect {
    pub fn identifier(&self, name: &str) -> String {
        format!("\"{}\"", name.replace('"', "\"\""))
    }

    pub fn string_literal(&self, value: &str) -> String {
        format!("'{}'", value.replace('\'', "''"))
    }

    pub fn table_ref(&self, schema: &str, table: &str) -> String {
        format!("{}.{}", self.identifier(schema), self.identifier(table))
    }

    pub fn paginated_select(
        &self,
        columns_sql: &str,
        schema: &str,
        table: &str,
        where_sql: &str,
        order_sql: &str,
        limit: u64,
        offset: u64,
    ) -> String {
        format!(
            "SELECT {} FROM {}{}{} LIMIT {} OFFSET {}",
            columns_sql,
            self.table_ref(schema, table),
            where_sql,
            order_sql,
            limit,
            offset
        )
    }

    pub fn count_query(&self, schema: &str, table: &str, where_sql: &str) -> String {
        format!("SELECT COUNT(*) as cnt FROM {}{}", self.table_ref(schema, table), where_sql)
    }
}

pub const SQLITE_DIALECT: SqliteDialect = SqliteDialect;
```

- [ ] 增加测试：双引号转义、`main.users` 表引用、分页 SQL、COUNT SQL。

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml sqlite_
```

Expected: SQLite dialect 测试通过。

### Task 2: SQLite metadata 查询

- [ ] 在 `src-tauri/src/db/sqlite.rs` 增加 database 列表：

```rust
pub async fn list_databases(pool: &Pool) -> Result<Vec<String>, String> {
    let conn = pool.get().await.map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(|conn| {
        let mut stmt = conn.prepare("PRAGMA database_list").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("SQLite 查询任务失败: {}", e))?
}
```

- [ ] 增加表列表查询，使用一次 `sqlite_schema` 查询：

```sql
SELECT name,
       CASE WHEN type = 'view' THEN 'VIEW' ELSE 'TABLE' END AS table_type,
       type,
       sql
FROM "<schema>".sqlite_schema
WHERE type IN ('table', 'view')
  AND name NOT LIKE 'sqlite_%'
ORDER BY name
```

- [ ] `TableInfo` 映射规则：`engine = Some("SQLite")` 仅用于普通表；视图为 `None`；`rows`、`data_length`、`index_length` 为 `None`；`comment` 为空字符串。

### Task 3: 表结构查询

- [ ] 在 `sqlite.rs` 增加 `get_table_structure(pool, database, table)`，读取当前选中表：

```sql
SELECT name,
       type,
       "notnull",
       dflt_value,
       pk,
       hidden
FROM pragma_table_xinfo(?1, ?2)
ORDER BY cid
```

- [ ] `ColumnInfo` 映射规则：

```rust
ColumnInfo {
    name,
    column_type: declared_type,
    nullable: notnull == 0 && pk == 0,
    key: if pk > 0 { "PRI".to_string() } else { String::new() },
    default_value,
    extra: if hidden != 0 { "generated".to_string() } else { String::new() },
    comment: String::new(),
}
```

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml sqlite
```

Expected: 元数据映射测试通过。

### Task 4: 数据查询与 JSON 转换

- [ ] 在 `sqlite.rs` 增加 `sqlite_value_to_json`，覆盖 `Null`、`Integer`、`Real`、`Text`、`Blob`。整数超过 JavaScript 安全整数范围时转字符串，Blob 显示为 `[binary N bytes]`。

- [ ] 增加 `query_table_count`：

```rust
let count_sql = sqlite_count_query(database, table, &where_sql);
```

- [ ] 增加 `query_table_data`：

```rust
let offset = (page.saturating_sub(1) as u64) * page_size as u64;
let select_sql = sqlite_paginated_select(&select_part, database, table, &where_sql, &order_sql, page_size as u64, offset);
```

- [ ] `select_columns` 为空时使用 `*`；不为空时逐个用 SQLite dialect 标识符转义。

- [ ] 排序字段用 SQLite dialect 标识符转义，排序方向只允许 `ASC` / `DESC`。

### Task 5: 命令层分发

- [ ] 在 `src-tauri/src/commands/database/mod.rs` 为以下命令增加 SQLite 分支：

```rust
DatabasePoolHandle::Sqlite(handle) => return sqlite::list_databases(&handle.pool).await,
DatabasePoolHandle::Sqlite(handle) => return sqlite::list_tables(&handle.pool, &database).await,
DatabasePoolHandle::Sqlite(handle) => return sqlite::get_table_structure(&handle.pool, &database, &table).await,
```

- [ ] 在 `src-tauri/src/commands/data.rs` 为 `query_table_count` 和 `query_table_data` 增加 SQLite 分支。

- [ ] 不支持写操作的命令先保持未接入，直接返回明确错误：

```rust
DatabasePoolHandle::Sqlite(_) => Err("SQLite 暂不支持该写操作".to_string())
```

### Task 6: 前端 capability 与 WHERE 方言

- [ ] 修改 `src/utils/databaseCapabilities.ts`，增加：

```ts
const SQLITE_CAPABILITIES: DatabaseCapabilities = {
  sqlEditor: false,
  databaseManagement: false,
  tableBrowsing: true,
  tableDataEditing: false,
  schemaManagement: false,
  routineManagement: false,
  eventManagement: false,
  triggerManagement: false,
  indexManagement: false,
  foreignKeyManagement: false,
  sqlFileImportExport: false,
  savedSql: false,
  favoriteTables: false,
  charsetAndCollation: false,
  storageEngine: false,
  columnReordering: false,
  databaseObjectNoun: "database",
};
```

- [ ] 修改 `getDatabaseCapabilities`，`normalizeDatabaseType(databaseType) === "sqlite"` 时返回 SQLite capability。

- [ ] 修改 `src/utils/whereFilterUtils.ts`，SQLite 与 PostgreSQL 一样使用双引号标识符和单引号字符串转义。

Run:

```bash
npm test -- src/__tests__/databaseCapabilities.test.ts src/__tests__/whereFilterUtils.test.ts
```

Expected: SQLite capability 和 WHERE 生成测试通过。

### Task 7: 阶段验收

- [ ] 运行阶段测试：

```bash
npm test -- src/__tests__/databaseCapabilities.test.ts src/__tests__/whereFilterUtils.test.ts
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
git commit -m "feat: 支持 SQLite 库表浏览"
```

