# SQLite Phase 4 Data Editing And DDL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 SQLite 开放表数据新增、更新、批量更新、删除，以及 SQLite 可控 DDL 子集。

**Architecture:** 数据编辑必须使用参数绑定，主键定位来自 `pragma_table_xinfo` 的 `pk` 顺序；无主键表不开放编辑。DDL 只开放 SQLite 原生可靠能力：创建表、删除表、重命名表、清空表、新增列、删除列；改列类型、改列顺序、存储引擎和字符集继续禁用。

**Tech Stack:** Rust Tauri commands, deadpool-sqlite, rusqlite named/positional params, React capability map, Ant Design table UI, Vitest, Rust unit tests.

---

## 文件结构

- Modify: `src-tauri/src/db/sqlite.rs`，增加主键查询、参数绑定、CRUD、DDL helper。
- Modify: `src-tauri/src/commands/data.rs`，为 `insert_row`、`update_row`、`batch_update_rows`、`delete_rows`、`query_full_rows` 分发 SQLite。
- Modify: `src-tauri/src/commands/database/mod.rs`，为 `get_primary_keys`、`create_table`、`drop_table`、`rename_table`、`truncate_table` 分发 SQLite。
- Modify: `src-tauri/src/commands/database/column_ops.rs`，为 `add_column`、`drop_column` 分发 SQLite；`alter_column` 返回明确不支持。
- Modify: `src/utils/databaseCapabilities.ts`，开放 SQLite `tableDataEditing` 和 DDL 子集所需能力。
- Modify: `src/components/table/TableStructure.tsx`，SQLite 下隐藏改列类型、拖拽改列顺序、存储引擎。
- Modify: `src/components/database/CreateTableModal.tsx`，SQLite 下隐藏 MySQL 引擎、字符集和 MySQL 专属额外属性。
- Test: `src/__tests__/databaseCapabilities.test.ts`
- Test: `src/__tests__/TableDataSelection.test.tsx`
- Test: `src/__tests__/PostgresTableStructure.test.tsx` 或新增 SQLite 结构测试文件
- Test: Rust unit tests in `src-tauri/src/db/sqlite.rs`

## 任务

### Task 1: SQLite 主键定位

- [ ] 在 `sqlite.rs` 增加：

```rust
pub async fn get_primary_keys(pool: &Pool, database: &str, table: &str) -> Result<Vec<String>, String> {
    let database = database.to_string();
    let table = table.to_string();
    let conn = pool.get().await.map_err(|e| format!("获取 SQLite 连接失败: {}", e))?;
    conn.interact(move |conn| {
        let mut stmt = conn
            .prepare("SELECT name FROM pragma_table_xinfo(?1, ?2) WHERE pk > 0 ORDER BY pk")
            .map_err(|e| format!("查询主键信息失败: {}", e))?;
        let rows = stmt
            .query_map([table.as_str(), database.as_str()], |row| row.get::<_, String>(0))
            .map_err(|e| format!("查询主键信息失败: {}", e))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("读取主键信息失败: {}", e))?);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("SQLite 查询任务失败: {}", e))?
}
```

- [ ] 无主键时，写操作返回：

```text
SQLite 表没有主键，无法安全定位要修改的行
```

### Task 2: CRUD 参数绑定

- [ ] `insert_row` 构造：

```sql
INSERT INTO "main"."users" ("name", "age") VALUES (?1, ?2)
```

- [ ] `update_row` 构造：

```sql
UPDATE "main"."users" SET "name" = ?1, "age" = ?2 WHERE "id" = ?3
```

- [ ] `delete_rows` 对多行使用事务，并为每行执行参数化 DELETE：

```sql
DELETE FROM "main"."users" WHERE "id" = ?1
```

- [ ] JSON 到 SQLite 值映射规则：

```rust
JsonValue::Null => rusqlite::types::Value::Null
JsonValue::Bool(b) => rusqlite::types::Value::Integer(if b { 1 } else { 0 })
JsonValue::Number(n) => Integer 或 Real
JsonValue::String(s) => Text
其他 JSON => Text(value.to_string())
```

- [ ] 写操作必须通过 `get_database_pool_for_write`，继承只读连接拦截。

### Task 3: 查询完整行

- [ ] `query_full_rows` 在 SQLite 下根据主键列和选中行的主键值查询完整行。

- [ ] 查询 SQL 使用参数绑定：

```sql
SELECT * FROM "main"."users" WHERE "id" = ?1
```

- [ ] 多行查询使用 OR 分组或逐行参数化查询。若使用逐行查询，只允许针对前端选中的有限行集合，不能用于全表元数据遍历。

### Task 4: SQLite 创建表

- [ ] `create_table` 支持列名、类型、可空、默认值、主键。

- [ ] SQLite 下忽略或隐藏 MySQL engine/comment/extra。前端不发送这些字段；后端若收到也不拼入 SQL。

- [ ] 示例生成：

```sql
CREATE TABLE "main"."users" (
  "id" INTEGER NOT NULL,
  "name" TEXT NOT NULL,
  "age" INTEGER,
  PRIMARY KEY ("id")
)
```

- [ ] 表名和列名使用 SQLite dialect 标识符转义，默认值只允许前端已有安全输入；不接受包含分号或注释的默认值。

### Task 5: SQLite 表级 DDL

- [ ] `drop_table`：

```sql
DROP TABLE "main"."users"
```

- [ ] `rename_table`：

```sql
ALTER TABLE "main"."old_name" RENAME TO "new_name"
```

- [ ] `truncate_table`：

```sql
DELETE FROM "main"."users"
```

- [ ] 视图传入表级 DDL 时返回：

```text
SQLite 视图不支持该表操作
```

### Task 6: SQLite 列级 DDL 子集

- [ ] `add_column`：

```sql
ALTER TABLE "main"."users" ADD COLUMN "email" TEXT
```

- [ ] `drop_column`：

```sql
ALTER TABLE "main"."users" DROP COLUMN "email"
```

- [ ] `alter_column` 返回：

```text
SQLite 暂不支持修改列定义，请通过新建表迁移数据完成该操作
```

- [ ] `columnReordering` 保持 `false`，前端不渲染拖拽改列顺序。

### Task 7: capability 与 UI 限制

- [ ] SQLite capability 调整：

```ts
tableDataEditing: true,
schemaManagement: true,
databaseManagement: false,
charsetAndCollation: false,
storageEngine: false,
columnReordering: false,
```

- [ ] `TableStructure.tsx` 中 SQLite 不展示：存储引擎、字符集、列顺序拖拽、改列类型入口。

- [ ] `CreateTableModal.tsx` 中 SQLite 不展示：MySQL engine、auto_increment 额外属性、ON UPDATE 额外属性。

Run:

```bash
npm test -- src/__tests__/databaseCapabilities.test.ts src/__tests__/TableDataSelection.test.tsx
```

Expected: PASS。

### Task 8: 阶段验收

- [ ] 运行阶段测试：

```bash
npm test -- src/__tests__/databaseCapabilities.test.ts src/__tests__/TableDataSelection.test.tsx
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
git commit -m "feat: 支持 SQLite 数据编辑和基础 DDL"
```

