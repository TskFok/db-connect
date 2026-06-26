# SQLite Phase 5 Objects Import Export Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐 SQLite 索引、外键、触发器、SQL 文件导入导出、文档和回归矩阵。

**Architecture:** SQLite 对象管理继续复用当前对象页签，但 routine/event 保持禁用。索引、外键、触发器读取必须使用 `sqlite_schema` 与 table-valued PRAGMA 批量查询；SQL 导出使用 SQLite 方言生成 schema 和 INSERT。

**Tech Stack:** Rust Tauri commands, deadpool-sqlite, rusqlite, SQLite sqlite_schema, PRAGMA table-valued functions, React capability map, Vitest, Rust unit tests.

---

## 文件结构

- Modify: `src-tauri/src/db/sqlite.rs`，增加索引、外键、触发器、SQL 文件导入导出 helper。
- Modify: `src-tauri/src/commands/index_cmd.rs`，为 `list_indexes`、`create_index`、`delete_index` 分发 SQLite。
- Modify: `src-tauri/src/commands/foreign_key.rs`，为 `list_foreign_keys` 分发 SQLite；新增/删除外键返回明确不支持。
- Modify: `src-tauri/src/commands/trigger.rs`，为 `list_triggers`、`get_trigger_definition`、`drop_trigger` 分发 SQLite；创建触发器按 SQLite 语法处理。
- Modify: `src-tauri/src/commands/sql_file.rs`，为 SQLite 导入导出分支生成和执行 SQL。
- Modify: `src/utils/databaseCapabilities.ts`，开放 SQLite 索引、外键查看、触发器和导入导出能力。
- Modify: `src/components/index/IndexEditor.tsx`，SQLite 索引方法和索引类型选项。
- Modify: `src/components/foreignKey/ForeignKeyList.tsx`，SQLite 下只读展示外键。
- Modify: `src/components/trigger/TriggerEditor.tsx`，SQLite 触发器模板。
- Modify: `README.md`，增加 SQLite 能力说明。
- Create: `docs/superpowers/manual-tests/2026-06-26-sqlite-support-matrix.md`
- Test: `src/__tests__/databaseCapabilities.test.ts`
- Test: `src/__tests__/indexList.test.ts`
- Test: `src/__tests__/foreignKeyAndRoutineCommands.test.ts`
- Test: `src/__tests__/triggerList.test.ts`
- Test: `src/__tests__/sqlIoProgress.test.ts`
- Test: Rust unit tests in `src-tauri/src/db/sqlite.rs`

## 任务

### Task 1: SQLite 索引列表

- [ ] `list_indexes` 对当前表使用：

```sql
SELECT il.name,
       il."unique",
       il.origin,
       il.partial,
       ix.seqno,
       ix.cid,
       ix.name AS column_name,
       ix.desc,
       ix.coll
FROM pragma_index_list(?1, ?2) AS il
LEFT JOIN pragma_index_xinfo(il.name, ?2) AS ix
ORDER BY il.seq, ix.seqno
```

- [ ] 映射规则：

```rust
IndexInfo {
    name,
    unique: unique_flag != 0,
    index_type: "BTREE".to_string(),
    columns,
    is_primary: origin == "pk",
    comment: if partial != 0 { "partial".to_string() } else { String::new() },
}
```

- [ ] 隐藏 SQLite 内部索引 `sqlite_autoindex_%` 的删除入口。

### Task 2: SQLite 创建/删除索引

- [ ] `create_index` 支持普通索引和唯一索引：

```sql
CREATE INDEX "idx_users_name" ON "main"."users" ("name" ASC)
CREATE UNIQUE INDEX "idx_users_email" ON "main"."users" ("email" ASC)
```

- [ ] 不支持 FULLTEXT/SPATIAL 时返回：

```text
SQLite 暂不支持通过当前入口创建 FULLTEXT 或 SPATIAL 索引
```

- [ ] `delete_index`：

```sql
DROP INDEX "main"."idx_users_name"
```

### Task 3: SQLite 外键查看

- [ ] `list_foreign_keys` 使用一次批量查询：

```sql
SELECT m.name AS table_name,
       fk.id,
       fk.seq,
       fk."table" AS referenced_table,
       fk."from" AS column_name,
       fk."to" AS referenced_column,
       fk.on_update,
       fk.on_delete
FROM "<schema>".sqlite_schema AS m
JOIN pragma_foreign_key_list(m.name, "<schema>") AS fk
WHERE m.type = 'table'
ORDER BY m.name, fk.id, fk.seq
```

- [ ] `add_foreign_key` 和 `drop_foreign_key` 返回：

```text
SQLite 暂不支持通过当前入口新增或删除外键，请通过重建表结构完成该操作
```

- [ ] 前端 capability 增加只读外键展示，不展示新增/删除按钮。

### Task 4: SQLite 触发器

- [ ] `list_triggers`：

```sql
SELECT name, tbl_name, sql
FROM "<schema>".sqlite_schema
WHERE type = 'trigger'
ORDER BY name
```

- [ ] 从 trigger SQL 中解析 `BEFORE` / `AFTER`、`INSERT` / `UPDATE` / `DELETE`；解析失败时返回空字段但保留定义查看。

- [ ] `get_trigger_definition` 返回 `sqlite_schema.sql`。

- [ ] `create_trigger` 模板：

```sql
CREATE TRIGGER "trg_users_ai"
AFTER INSERT ON "main"."users"
BEGIN
  SELECT RAISE(IGNORE);
END
```

- [ ] `drop_trigger`：

```sql
DROP TRIGGER "main"."trg_users_ai"
```

### Task 5: SQL 文件导入

- [ ] `import_sql_file` SQLite 分支复用现有文件读取和拆句逻辑。

- [ ] SQLite 导入前不执行 `USE`；如果前端选中 database 为 `main` 或 `temp`，导入 SQL 原样执行。

- [ ] 每条语句通过 `sqlite::run_one_statement` 执行，失败记录 `ImportSqlStatementFailure`，进度事件保持不变。

- [ ] 只读连接通过 `get_database_pool_for_write` 拦截。

### Task 6: SQL 文件导出

- [ ] SQLite 导出结构从 `sqlite_schema` 读取：

```sql
SELECT type, name, tbl_name, sql
FROM "<schema>".sqlite_schema
WHERE type IN ('table', 'view', 'index', 'trigger')
  AND name NOT LIKE 'sqlite_%'
ORDER BY CASE type
  WHEN 'table' THEN 1
  WHEN 'view' THEN 2
  WHEN 'index' THEN 3
  WHEN 'trigger' THEN 4
  ELSE 5
END, name
```

- [ ] 导出数据时按表批量读取行并生成 SQLite INSERT：

```sql
INSERT INTO "users" ("id", "name") VALUES (1, 'Alice');
```

- [ ] 字符串用 SQLite dialect 转义，Blob 导出为十六进制字面量：

```sql
X'ABCD'
```

- [ ] 导出文件头包含：

```sql
-- DB Connect SQLite export
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE "users" ("id" INTEGER PRIMARY KEY, "name" TEXT);
INSERT INTO "users" ("id", "name") VALUES (1, 'Alice');
COMMIT;
PRAGMA foreign_keys=ON;
```

### Task 7: capability、文档和手工矩阵

- [ ] SQLite capability 调整：

```ts
indexManagement: true,
foreignKeyManagement: true,
triggerManagement: true,
sqlFileImportExport: true,
savedSql: true,
favoriteTables: true,
routineManagement: false,
eventManagement: false,
```

- [ ] 更新 `README.md` 支持列表，从 “MySQL / MariaDB 与 PostgreSQL” 改为包含 SQLite，并在功能说明中标注 SQLite 不支持 routine/event、字符集、存储引擎。

- [ ] 新建 `docs/superpowers/manual-tests/2026-06-26-sqlite-support-matrix.md`，覆盖：

| 场景 | SQLite 预期 |
|------|-------------|
| 打开文件 | 选择 `.db` / `.sqlite` 文件后连接成功 |
| 库表树 | 展示 `main` 与表/视图 |
| 表结构 | 展示列类型、可空、主键、默认值 |
| 数据浏览 | 分页、排序、WHERE 可用 |
| SQL 编辑器 | SELECT、PRAGMA table_info、EXPLAIN QUERY PLAN 可用 |
| 数据编辑 | 有主键表可增删改，无主键表提示不可编辑 |
| 索引 | 可查看、创建、删除普通/唯一索引 |
| 外键 | 可查看，不展示新增/删除入口 |
| 触发器 | 可查看定义、创建、删除 |
| 导入导出 | 导出的 SQL 可导入空 SQLite 文件 |

### Task 8: 阶段验收

- [ ] 运行阶段测试：

```bash
npm test -- src/__tests__/databaseCapabilities.test.ts src/__tests__/indexList.test.ts src/__tests__/foreignKeyAndRoutineCommands.test.ts src/__tests__/triggerList.test.ts src/__tests__/sqlIoProgress.test.ts
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
git add README.md docs src src-tauri
git commit -m "feat: 补齐 SQLite 对象管理和导入导出"
```
