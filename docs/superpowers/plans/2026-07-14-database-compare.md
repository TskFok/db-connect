# 数据库对比功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增跨两个同类型已保存连接的数据库/schema 结构对比能力，列出物理表和字段差异，并导出三工作表 Excel。

**Architecture:** Rust 后端通过临时连接批量采集两侧元数据并计算稳定的结构化差异，临时连接不注册到当前工作区。React 前端只负责选择端点、展示/筛选后端差异结果，以及使用现有 `write-excel-file` 能力导出 Excel。

**Tech Stack:** Tauri 2、Rust、Tokio、mysql_async、deadpool-postgres、deadpool-sqlite/rusqlite、bb8-tiberius、clickhouse-rs、React 18、TypeScript、Ant Design 5、Vitest、Testing Library、write-excel-file。

## Global Constraints

- 默认在当前 `master` 分支修改，不创建新分支。
- Git 提交必须使用 Conventional Commits，英文 type 加简体中文描述。
- 禁止在循环遍历中查询 SQL；每一侧数据库/schema 的物理表与字段必须由固定次数的批量查询完成。
- 支持 MySQL/MariaDB、PostgreSQL、SQLite、SQL Server、ClickHouse，但只允许两个不同的同类型保存连接互相比较。
- 只比较物理表，以及字段顺序、类型、可空、默认值、主键、额外属性和注释；不比较视图、索引、外键、触发器、例程、事件、权限或数据。
- 后端负责元数据采集和差异计算；前端不得重新实现第二套差异算法。
- 临时连接不得注册进 `ConnectionManager`，不得切换或断开当前工作区连接；解密凭据不得返回前端或写入日志。
- 表名和字段名精确匹配，不做跨数据库类型归一化；结果必须稳定排序，完全一致的表不返回。
- 实现必须遵循 TDD；开始功能实现时使用 `superpowers:test-driven-development`，宣称完成前使用 `superpowers:verification-before-completion`。

## File Structure

- `src-tauri/src/models/types.rs`：新增对外序列化的对比请求、快照、状态、差异和汇总类型。
- `src-tauri/src/db/schema_compare/mod.rs`：内部快照行模型、批量行分组、纯差异算法、数据库类型分发。
- `src-tauri/src/db/schema_compare/mysql.rs`：MySQL/MariaDB 批量元数据查询与映射。
- `src-tauri/src/db/schema_compare/postgres.rs`：PostgreSQL 批量元数据查询与映射。
- `src-tauri/src/db/schema_compare/sqlite.rs`：SQLite 批量元数据查询、映射和临时库集成测试。
- `src-tauri/src/db/schema_compare/sqlserver.rs`：SQL Server 批量元数据查询与映射。
- `src-tauri/src/db/schema_compare/clickhouse.rs`：ClickHouse 批量元数据查询与映射。
- `src-tauri/src/commands/database_compare.rs`：保存连接解析、临时连接生命周期、库/schema 列表和对比 Tauri 命令。
- `src/types/index.ts`：前端数据库对比契约。
- `src/services/tauriCommands.ts`：两个新 Tauri 命令的类型安全封装。
- `src/utils/databaseCompare.ts`：前端状态文案、筛选、属性格式化等纯函数。
- `src/utils/databaseCompareExport.ts`：三工作表数据组装和 Excel 生成。
- `src/utils/excelExport.ts`：抽取可复用的多工作表 Base64 生成器，保留现有单工作表 API。
- `src/components/databaseCompare/DatabaseCompareModal.tsx`：端点选择、结果摘要、筛选、表/字段差异展示和导出交互。
- `src/components/databaseCompare/DatabaseCompareModal.css`：对比窗口响应式布局与差异状态样式。
- `src/__tests__/databaseCompare.test.ts`：前端纯函数测试。
- `src/__tests__/databaseCompareExport.test.ts`：Excel 工作表数据测试。
- `src/__tests__/DatabaseCompareModal.test.tsx`：对比窗口交互测试。
- `src/App.tsx`：底部状态栏入口和对比窗口开关。
- `README.md`：功能说明。

---

### Task 1: 后端差异契约与纯算法

**Files:**
- Modify: `src-tauri/src/models/types.rs`
- Modify: `src-tauri/src/db/mod.rs`
- Create: `src-tauri/src/db/schema_compare/mod.rs`

**Interfaces:**
- Consumes: 现有 `DatabaseType`。
- Produces: `DatabaseCompareEndpointRequest`、`CompareEndpointInfo`、`ColumnSnapshot`、`SchemaDiffStatus`、`ColumnDiff`、`TableDiff`、`DatabaseCompareSummary`、`DatabaseCompareResult`；内部 `SnapshotRow`、`TableSnapshot`、`rows_to_tables()` 和 `compare_schema_snapshots()`。

- [ ] **Step 1: 写差异算法失败测试**

在 `src-tauri/src/db/schema_compare/mod.rs` 先声明模块测试，覆盖整表单侧存在、字段单侧存在、七项字段属性变化、稳定排序、汇总计数和完全一致不返回：

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::types::{CompareEndpointInfo, DatabaseType};

    fn endpoint(id: &str, name: &str, database: &str) -> CompareEndpointInfo {
        CompareEndpointInfo {
            connection_id: id.to_string(),
            connection_name: name.to_string(),
            database: database.to_string(),
        }
    }

    fn row(table: &str, column: &str, position: u32, column_type: &str) -> SnapshotRow {
        SnapshotRow {
            table_name: table.to_string(),
            column_name: column.to_string(),
            details: ColumnSnapshot {
                ordinal_position: position,
                column_type: column_type.to_string(),
                nullable: false,
                default_value: None,
                primary_key: column == "id",
                extra: String::new(),
                comment: String::new(),
            },
        }
    }

    #[test]
    fn compare_reports_table_and_column_differences_in_stable_order() {
        let source = rows_to_tables(vec![
            row("users", "name", 2, "varchar(100)"),
            row("users", "id", 1, "bigint"),
            row("source_only", "id", 1, "bigint"),
        ]);
        let target = rows_to_tables(vec![
            row("target_only", "id", 1, "bigint"),
            row("users", "id", 1, "bigint"),
            row("users", "email", 2, "varchar(255)"),
        ]);

        let result = compare_schema_snapshots(
            DatabaseType::MySql,
            endpoint("source", "源端", "app"),
            endpoint("target", "目标端", "app"),
            "2026-07-14T00:00:00Z".to_string(),
            source,
            target,
        );

        assert_eq!(
            result.tables.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(),
            vec!["source_only", "target_only", "users"]
        );
        assert_eq!(result.summary.source_only_tables, 1);
        assert_eq!(result.summary.target_only_tables, 1);
        assert_eq!(result.summary.changed_tables, 1);
        assert_eq!(result.summary.different_columns, 2);
        assert_eq!(result.tables[2].columns[0].name, "email");
        assert_eq!(result.tables[2].columns[1].name, "name");
    }

    #[test]
    fn compare_omits_identical_tables_and_lists_all_changed_fields() {
        let base = row("users", "id", 1, "bigint");
        let mut changed = base.clone();
        changed.details = ColumnSnapshot {
            ordinal_position: 2,
            column_type: "int".to_string(),
            nullable: true,
            default_value: Some("0".to_string()),
            primary_key: false,
            extra: "identity".to_string(),
            comment: "新注释".to_string(),
        };

        let result = compare_schema_snapshots(
            DatabaseType::MySql,
            endpoint("source", "源端", "app"),
            endpoint("target", "目标端", "app"),
            "2026-07-14T00:00:00Z".to_string(),
            rows_to_tables(vec![base]),
            rows_to_tables(vec![changed]),
        );

        assert_eq!(result.tables.len(), 1);
        assert_eq!(
            result.tables[0].columns[0].changed_fields,
            vec![
                "ordinal_position", "column_type", "nullable", "default_value",
                "primary_key", "extra", "comment"
            ]
        );

        let identical = compare_schema_snapshots(
            DatabaseType::MySql,
            endpoint("source", "源端", "app"),
            endpoint("target", "目标端", "app"),
            "2026-07-14T00:00:00Z".to_string(),
            rows_to_tables(vec![row("same", "id", 1, "bigint")]),
            rows_to_tables(vec![row("same", "id", 1, "bigint")]),
        );
        assert!(identical.tables.is_empty());
    }
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_compare::tests -- --nocapture`

Expected: FAIL，提示 `schema_compare` 模块或对比类型/函数不存在。

- [ ] **Step 3: 增加序列化类型和最小纯算法**

在 `src-tauri/src/models/types.rs` 增加：

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseCompareEndpointRequest {
    pub saved_connection_id: String,
    pub database: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CompareEndpointInfo {
    pub connection_id: String,
    pub connection_name: String,
    pub database: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ColumnSnapshot {
    pub ordinal_position: u32,
    pub column_type: String,
    pub nullable: bool,
    pub default_value: Option<String>,
    pub primary_key: bool,
    pub extra: String,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SchemaDiffStatus {
    SourceOnly,
    TargetOnly,
    Changed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ColumnDiff {
    pub name: String,
    pub status: SchemaDiffStatus,
    pub changed_fields: Vec<String>,
    pub source: Option<ColumnSnapshot>,
    pub target: Option<ColumnSnapshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TableDiff {
    pub name: String,
    pub status: SchemaDiffStatus,
    pub columns: Vec<ColumnDiff>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct DatabaseCompareSummary {
    pub source_only_tables: usize,
    pub target_only_tables: usize,
    pub changed_tables: usize,
    pub different_columns: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DatabaseCompareResult {
    pub database_type: DatabaseType,
    pub source: CompareEndpointInfo,
    pub target: CompareEndpointInfo,
    pub compared_at: String,
    pub summary: DatabaseCompareSummary,
    pub tables: Vec<TableDiff>,
}
```

在 `src-tauri/src/db/mod.rs` 注册 `pub mod schema_compare;`。在新模块中实现：

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SnapshotRow {
    pub table_name: String,
    pub column_name: String,
    pub details: ColumnSnapshot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TableSnapshot {
    pub name: String,
    pub columns: Vec<(String, ColumnSnapshot)>,
}

pub(crate) fn rows_to_tables(rows: Vec<SnapshotRow>) -> Vec<TableSnapshot> {
    let mut tables: BTreeMap<String, Vec<(String, ColumnSnapshot)>> = BTreeMap::new();
    for row in rows {
        tables.entry(row.table_name).or_default().push((row.column_name, row.details));
    }
    tables
        .into_iter()
        .map(|(name, mut columns)| {
            columns.sort_by(|a, b| {
                a.1.ordinal_position.cmp(&b.1.ordinal_position).then_with(|| a.0.cmp(&b.0))
            });
            TableSnapshot { name, columns }
        })
        .collect()
}

fn changed_fields(source: &ColumnSnapshot, target: &ColumnSnapshot) -> Vec<String> {
    let checks = [
        ("ordinal_position", source.ordinal_position != target.ordinal_position),
        ("column_type", source.column_type != target.column_type),
        ("nullable", source.nullable != target.nullable),
        ("default_value", source.default_value != target.default_value),
        ("primary_key", source.primary_key != target.primary_key),
        ("extra", source.extra != target.extra),
        ("comment", source.comment != target.comment),
    ];
    checks.into_iter().filter_map(|(name, changed)| changed.then(|| name.to_string())).collect()
}
```

`compare_schema_snapshots()` 必须用 `BTreeMap` 做表和字段匹配；整表单侧存在时返回空 `columns`；同名表只返回差异字段；字段排序键为两侧可用的最小 `ordinal_position` 后接字段名，并据此填写四个汇总值。

- [ ] **Step 4: 运行算法测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_compare::tests -- --nocapture`

Expected: PASS，两个测试均通过。

- [ ] **Step 5: 提交差异模型和算法**

```bash
git add src-tauri/src/models/types.rs src-tauri/src/db/mod.rs src-tauri/src/db/schema_compare/mod.rs
git commit -m "feat: 增加数据库结构差异模型"
```

---

### Task 2: MySQL/MariaDB 与 PostgreSQL 批量结构采集

**Files:**
- Create: `src-tauri/src/db/schema_compare/mysql.rs`
- Create: `src-tauri/src/db/schema_compare/postgres.rs`
- Modify: `src-tauri/src/db/schema_compare/mod.rs`

**Interfaces:**
- Consumes: `SnapshotRow`、`rows_to_tables()`、`TableSnapshot`；`mysql_async::Pool`；`deadpool_postgres::Pool`。
- Produces: `mysql::load_snapshot(&Pool, &str)`、`postgres::load_snapshot(&PgPool, &str)`。

- [ ] **Step 1: 写批量查询契约失败测试**

分别在两个新模块内增加测试，要求查询只按 schema 过滤一次、包含物理表过滤和字段顺序，不含逐表占位参数：

```rust
#[test]
fn mysql_snapshot_query_reads_all_base_table_columns_once() {
    let sql = snapshot_sql();
    assert!(sql.contains("information_schema.TABLES"));
    assert!(sql.contains("information_schema.COLUMNS"));
    assert!(sql.contains("TABLE_TYPE = 'BASE TABLE'"));
    assert!(sql.contains("t.TABLE_SCHEMA = :schema"));
    assert!(!sql.contains(":table"));
}

#[test]
fn postgres_snapshot_query_reads_all_physical_table_columns_once() {
    let sql = snapshot_sql();
    assert!(sql.contains("information_schema.columns"));
    assert!(sql.contains("cls.relkind IN ('r', 'p')"));
    assert!(sql.contains("cols.table_schema = $1"));
    assert!(!sql.contains("table_name = $2"));
}
```

- [ ] **Step 2: 运行查询测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_compare:: -- --nocapture`

Expected: FAIL，提示两个子模块或 `snapshot_sql()` 不存在。

- [ ] **Step 3: 实现 MySQL/MariaDB 单次批量查询**

`mysql.rs` 使用以下固定投影，`TABLE_SCHEMA` 只绑定一次：

```rust
pub(crate) fn snapshot_sql() -> &'static str {
    "SELECT t.TABLE_NAME AS table_name, \
            c.COLUMN_NAME AS column_name, \
            c.ORDINAL_POSITION AS ordinal_position, \
            c.COLUMN_TYPE AS column_type, \
            c.IS_NULLABLE = 'YES' AS nullable, \
            c.COLUMN_DEFAULT AS default_value, \
            c.COLUMN_KEY = 'PRI' AS primary_key, \
            c.EXTRA AS extra, \
            c.COLUMN_COMMENT AS comment \
     FROM information_schema.TABLES t \
     JOIN information_schema.COLUMNS c \
       ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME \
     WHERE t.TABLE_SCHEMA = :schema \
       AND t.TABLE_TYPE = 'BASE TABLE' \
     ORDER BY t.TABLE_NAME, c.ORDINAL_POSITION, c.COLUMN_NAME"
}

pub(crate) async fn load_snapshot(pool: &Pool, schema: &str) -> Result<Vec<TableSnapshot>, String> {
    let mut conn = get_conn_with_retry(pool).await?;
    let rows: Vec<mysql_async::Row> = conn
        .exec(snapshot_sql(), params! { "schema" => schema })
        .await
        .map_err(|e| format!("查询 MySQL 对比元数据失败: {}", e))?;
    let mapped = rows.into_iter().map(|row| SnapshotRow {
        table_name: row.get::<String, _>("table_name").unwrap_or_default(),
        column_name: row.get::<String, _>("column_name").unwrap_or_default(),
        details: ColumnSnapshot {
            ordinal_position: row.get::<u32, _>("ordinal_position").unwrap_or_default(),
            column_type: row.get::<String, _>("column_type").unwrap_or_default(),
            nullable: row.get::<i8, _>("nullable").unwrap_or_default() != 0,
            default_value: row.get::<Option<String>, _>("default_value").flatten(),
            primary_key: row.get::<i8, _>("primary_key").unwrap_or_default() != 0,
            extra: row.get::<String, _>("extra").unwrap_or_default(),
            comment: row.get::<String, _>("comment").unwrap_or_default(),
        },
    }).collect();
    Ok(rows_to_tables(mapped))
}
```

- [ ] **Step 4: 实现 PostgreSQL 单次批量查询**

`postgres.rs` 的查询以 `pg_class` 的 `r/p` 物理表为驱动，并一次关联全部字段、主键和注释：

```rust
pub(crate) fn snapshot_sql() -> &'static str {
    "SELECT cls.relname AS table_name, cols.column_name, cols.ordinal_position, \
            CASE \
              WHEN cols.data_type = 'USER-DEFINED' THEN cols.udt_name \
              WHEN cols.character_maximum_length IS NOT NULL THEN cols.data_type || '(' || cols.character_maximum_length || ')' \
              WHEN cols.numeric_precision IS NOT NULL AND cols.numeric_scale IS NOT NULL THEN cols.data_type || '(' || cols.numeric_precision || ',' || cols.numeric_scale || ')' \
              WHEN cols.numeric_precision IS NOT NULL THEN cols.data_type || '(' || cols.numeric_precision || ')' \
              ELSE cols.data_type \
            END AS column_type, \
            cols.is_nullable = 'YES' AS nullable, cols.column_default, \
            pk.column_name IS NOT NULL AS primary_key, \
            trim(concat_ws(' ', \
              CASE WHEN cols.is_identity = 'YES' THEN 'identity' END, \
              CASE WHEN cols.is_generated <> 'NEVER' THEN lower(cols.is_generated) || ' generated' END \
            )) AS extra, \
            COALESCE(description.description, '') AS comment \
     FROM pg_catalog.pg_class cls \
     JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace \
     JOIN information_schema.columns cols \
       ON cols.table_schema = ns.nspname AND cols.table_name = cls.relname \
     LEFT JOIN ( \
       SELECT kcu.table_schema, kcu.table_name, kcu.column_name \
       FROM information_schema.table_constraints tc \
       JOIN information_schema.key_column_usage kcu \
         ON kcu.constraint_schema = tc.constraint_schema \
        AND kcu.constraint_name = tc.constraint_name \
        AND kcu.table_schema = tc.table_schema \
        AND kcu.table_name = tc.table_name \
       WHERE tc.constraint_type = 'PRIMARY KEY' \
     ) pk ON pk.table_schema = cols.table_schema \
         AND pk.table_name = cols.table_name AND pk.column_name = cols.column_name \
     LEFT JOIN pg_catalog.pg_attribute attr \
       ON attr.attrelid = cls.oid AND attr.attname = cols.column_name \
     LEFT JOIN pg_catalog.pg_description description \
       ON description.objoid = cls.oid AND description.objsubid = attr.attnum \
     WHERE cols.table_schema = $1 AND cls.relkind IN ('r', 'p') \
     ORDER BY cls.relname, cols.ordinal_position, cols.column_name"
}
```

通过 `get_client_with_retry(pool).await?` 后执行 `client.query(snapshot_sql(), &[&schema])`；逐行读取类型、可空、默认值、主键、extra 和 comment，构造 `SnapshotRow` 后调用 `rows_to_tables()`。PostgreSQL 的 `ordinal_position` 读取为 `i32` 后使用 `u32::try_from(value).unwrap_or_default()`。

- [ ] **Step 5: 运行采集模块测试**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_compare:: -- --nocapture`

Expected: PASS，查询契约测试通过。

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS，无类型错误。

- [ ] **Step 6: 提交两类数据库采集器**

```bash
git add src-tauri/src/db/schema_compare/mod.rs src-tauri/src/db/schema_compare/mysql.rs src-tauri/src/db/schema_compare/postgres.rs
git commit -m "feat: 支持 MySQL 和 PostgreSQL 批量结构采集"
```

---

### Task 3: SQLite 批量结构采集与集成验证

**Files:**
- Create: `src-tauri/src/db/schema_compare/sqlite.rs`
- Modify: `src-tauri/src/db/schema_compare/mod.rs`

**Interfaces:**
- Consumes: `deadpool_sqlite::Pool`、`sqlite_id()`、`sqlite_str()`、`SnapshotRow`、`rows_to_tables()`。
- Produces: `sqlite::load_snapshot(&Pool, &str)`。

- [ ] **Step 1: 写 SQLite 临时库失败测试**

在新模块添加异步集成测试，明确验证单条查询覆盖多个表、排除视图、字段顺序、复合主键、默认值、自增和生成列：

```rust
#[tokio::test]
async fn loads_all_physical_tables_without_per_table_queries() {
    let path = std::env::temp_dir().join(format!("db-connect-compare-{}.sqlite", Uuid::new_v4()));
    std::fs::File::create(&path).expect("create sqlite file");
    let pool = SqliteConfig::new(path.to_str().expect("utf8 path"))
        .create_pool(Runtime::Tokio1)
        .expect("create pool");
    let conn = pool.get().await.expect("get connection");
    conn.interact(|conn| conn.execute_batch(
        "CREATE TABLE users (\
           id INTEGER PRIMARY KEY AUTOINCREMENT,\
           name TEXT NOT NULL DEFAULT 'anon',\
           upper_name TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL\
         );\
         CREATE TABLE order_items (\
           order_id INTEGER NOT NULL, item_id INTEGER NOT NULL,\
           PRIMARY KEY (order_id, item_id)\
         );\
         CREATE VIEW user_names AS SELECT name FROM users;"
    )).await.expect("interact").expect("create schema");
    drop(conn);

    let tables = load_snapshot(&pool, "main").await.expect("load snapshot");
    assert_eq!(tables.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(), vec!["order_items", "users"]);
    let users = tables.iter().find(|table| table.name == "users").unwrap();
    assert_eq!(users.columns[0].0, "id");
    assert!(users.columns[0].1.primary_key);
    assert_eq!(users.columns[0].1.extra, "auto_increment");
    assert_eq!(users.columns[1].1.default_value.as_deref(), Some("'anon'"));
    assert_eq!(users.columns[2].1.extra, "generated");

    pool.close();
    let _ = std::fs::remove_file(path);
}
```

- [ ] **Step 2: 运行 SQLite 测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_compare::sqlite::tests -- --nocapture`

Expected: FAIL，提示 `load_snapshot` 或 SQLite 子模块不存在。

- [ ] **Step 3: 实现 SQLite 单条批量查询**

使用 schema 标识符和字符串分别安全转义，查询不得在 Rust 表循环内再次执行：

```rust
pub(crate) fn snapshot_sql(schema: &str) -> String {
    format!(
        "SELECT objects.name AS table_name, columns.name AS column_name, \
                columns.cid + 1 AS ordinal_position, columns.type AS column_type, \
                CASE WHEN columns.\"notnull\" = 0 AND columns.pk = 0 THEN 1 ELSE 0 END AS nullable, \
                columns.dflt_value AS default_value, \
                CASE WHEN columns.pk > 0 THEN 1 ELSE 0 END AS primary_key, \
                CASE \
                  WHEN columns.hidden <> 0 THEN 'generated' \
                  WHEN columns.pk > 0 AND instr(upper(COALESCE(objects.sql, '')), 'AUTOINCREMENT') > 0 THEN 'auto_increment' \
                  ELSE '' \
                END AS extra \
         FROM {}.sqlite_schema objects \
         JOIN pragma_table_xinfo(objects.name, {}) columns \
         WHERE objects.type = 'table' AND objects.name NOT LIKE 'sqlite_%' \
         ORDER BY objects.name, columns.cid, columns.name",
        sqlite_id(schema),
        sqlite_str(schema)
    )
}
```

`load_snapshot()` 获取一个 deadpool SQLite 连接并只调用一次 `conn.interact`；在闭包内 `prepare(snapshot_sql)`、`query_map([])`，把 `i64` 数字转换为 `u32/bool`，注释固定为空字符串，再调用 `rows_to_tables()`。错误文案分别使用“获取 SQLite 对比连接失败”“SQLite 对比查询任务失败”“查询 SQLite 对比元数据失败”。

- [ ] **Step 4: 运行 SQLite 集成测试确认通过**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_compare::sqlite::tests -- --nocapture`

Expected: PASS，返回两个物理表且不包含视图。

- [ ] **Step 5: 提交 SQLite 采集器**

```bash
git add src-tauri/src/db/schema_compare/mod.rs src-tauri/src/db/schema_compare/sqlite.rs
git commit -m "feat: 支持 SQLite 批量结构采集"
```

---

### Task 4: SQL Server、ClickHouse 采集器与类型分发

**Files:**
- Create: `src-tauri/src/db/schema_compare/sqlserver.rs`
- Create: `src-tauri/src/db/schema_compare/clickhouse.rs`
- Modify: `src-tauri/src/db/schema_compare/mod.rs`

**Interfaces:**
- Consumes: `SqlServerPool`、`ClickHouse Client`、`DatabasePoolHandle` 和前三个采集器。
- Produces: `sqlserver::load_snapshot()`、`clickhouse::load_snapshot()`、`load_schema_snapshot(DatabasePoolHandle, &str)`、`list_databases_for_compare(DatabasePoolHandle)`。

- [ ] **Step 1: 写 SQL Server 和 ClickHouse 查询失败测试**

```rust
#[test]
fn sqlserver_snapshot_query_filters_one_schema_and_physical_tables() {
    let sql = snapshot_sql("dbo");
    assert!(sql.contains("FROM sys.tables"));
    assert!(sql.contains("JOIN sys.columns"));
    assert!(sql.contains("indexes.is_primary_key = 1"));
    assert!(sql.contains("schemas.name = N'dbo'"));
    assert!(!sql.contains("sys.views"));
}

#[test]
fn clickhouse_snapshot_query_joins_tables_and_columns_once() {
    let sql = snapshot_sql();
    assert!(sql.contains("FROM system.tables AS tables"));
    assert!(sql.contains("JOIN system.columns AS columns"));
    assert!(sql.contains("tables.database = ?"));
    assert!(sql.contains("NOT IN ('View', 'MaterializedView', 'LiveView', 'WindowView')"));
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_compare:: -- --nocapture`

Expected: FAIL，提示模块或查询函数不存在。

- [ ] **Step 3: 实现 SQL Server 批量查询和映射**

`snapshot_sql(schema)` 使用 `sqlserver_str(schema)`，以 `sys.tables` 为驱动，一次关联 `sys.columns`、`sys.types`、`sys.default_constraints`、计算列、主键和字段注释：

```sql
WITH primary_columns AS (
  SELECT index_columns.object_id, index_columns.column_id
  FROM sys.indexes indexes
  JOIN sys.index_columns index_columns
    ON index_columns.object_id = indexes.object_id
   AND index_columns.index_id = indexes.index_id
  WHERE indexes.is_primary_key = 1
)
SELECT tables.name AS table_name, columns.name AS column_name,
       columns.column_id AS ordinal_position, types.name AS type_name,
       CAST(columns.max_length AS int) AS max_length,
       CAST(columns.precision AS int) AS precision_value,
       CAST(columns.scale AS int) AS scale_value, types.is_user_defined,
       columns.is_nullable, defaults.definition AS default_value,
       CAST(CASE WHEN primary_columns.column_id IS NULL THEN 0 ELSE 1 END AS bit) AS primary_key,
       columns.is_identity, computed.definition AS computed_definition,
       COALESCE(CONVERT(nvarchar(4000), properties.value), N'') AS comment
FROM sys.tables tables
JOIN sys.schemas schemas ON schemas.schema_id = tables.schema_id
JOIN sys.columns columns ON columns.object_id = tables.object_id
JOIN sys.types types ON types.user_type_id = columns.user_type_id
LEFT JOIN sys.default_constraints defaults ON defaults.object_id = columns.default_object_id
LEFT JOIN sys.computed_columns computed
  ON computed.object_id = columns.object_id AND computed.column_id = columns.column_id
LEFT JOIN primary_columns
  ON primary_columns.object_id = columns.object_id AND primary_columns.column_id = columns.column_id
LEFT JOIN sys.extended_properties properties
  ON properties.class = 1 AND properties.major_id = columns.object_id
 AND properties.minor_id = columns.column_id AND properties.name = N'MS_Description'
WHERE schemas.name = N{} AND tables.is_ms_shipped = 0
ORDER BY tables.name, columns.column_id, columns.name
```

以上 SQL 作为 `format!` 的完整模板，唯一的 `{}` 参数传入 `sqlserver_str(schema)`。映射复用 `format_sqlserver_column_type()` 和 `build_sqlserver_column_extra()`；`primary_key`、`is_nullable`、`is_identity` 读取为布尔；`comment` 和字符串列使用本模块私有 `row_string()`；最后调用 `rows_to_tables()`。

- [ ] **Step 4: 实现 ClickHouse 批量查询和映射**

```rust
pub(crate) fn snapshot_sql() -> &'static str {
    "SELECT tables.name AS table_name, columns.name AS column_name, \
            columns.position AS ordinal_position, columns.type AS column_type, \
            startsWith(columns.type, 'Nullable(') AS nullable, \
            if(columns.default_kind = '', NULL, columns.default_expression) AS default_value, \
            columns.is_in_primary_key AS primary_key, \
            lower(columns.default_kind) AS extra, columns.comment AS comment \
     FROM system.tables AS tables \
     JOIN system.columns AS columns \
       ON columns.database = tables.database AND columns.table = tables.name \
     WHERE tables.database = ? \
       AND tables.engine NOT IN ('View', 'MaterializedView', 'LiveView', 'WindowView') \
     ORDER BY tables.name, columns.position, columns.name"
}
```

定义可 `Deserialize` 的行结构，`ordinal_position` 使用项目已有 `deserialize_u64` 风格转换后安全收窄为 `u32`，`nullable/primary_key` 从 `u8` 转为 bool。执行 `fetch_json_each_rows(client.query(snapshot_sql()).bind(database), "查询 ClickHouse 对比元数据失败")`，再调用 `rows_to_tables()`。

- [ ] **Step 5: 实现统一类型分发和数据库/schema 列表读取**

在 `schema_compare/mod.rs` 增加：

```rust
pub(crate) async fn load_schema_snapshot(
    pool: DatabasePoolHandle,
    database: &str,
) -> Result<Vec<TableSnapshot>, String> {
    match pool {
        DatabasePoolHandle::MySql(pool) => mysql::load_snapshot(&pool, database).await,
        DatabasePoolHandle::Postgres(handle) => postgres::load_snapshot(&handle.pool, database).await,
        DatabasePoolHandle::Sqlite(handle) => sqlite::load_snapshot(&handle.pool, database).await,
        DatabasePoolHandle::SqlServer(handle) => sqlserver::load_snapshot(&handle.pool, database).await,
        DatabasePoolHandle::ClickHouse(handle) => clickhouse::load_snapshot(&handle.client, database).await,
    }
}

pub(crate) async fn list_databases_for_compare(
    pool: DatabasePoolHandle,
) -> Result<Vec<String>, String> {
    match pool {
        DatabasePoolHandle::MySql(pool) => {
            let mut conn = get_conn_with_retry(&pool).await?;
            conn.query("SHOW DATABASES").await.map_err(|e| format!("查询数据库列表失败: {}", e))
        }
        DatabasePoolHandle::Postgres(handle) => postgres_db::list_schemas(&handle.pool).await,
        DatabasePoolHandle::Sqlite(handle) => sqlite_db::list_databases(&handle.pool).await,
        DatabasePoolHandle::SqlServer(handle) => sqlserver_db::list_schemas(&handle.pool).await,
        DatabasePoolHandle::ClickHouse(handle) => clickhouse_db::list_databases(&handle.client).await,
    }
}
```

为避免子模块重名，现有数据库模块分别以 `postgres_db/sqlite_db/sqlserver_db/clickhouse_db` 别名导入。

- [ ] **Step 6: 运行四类检查**

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_compare -- --nocapture`

Expected: PASS，全部差异算法、查询契约和 SQLite 集成测试通过。

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: PASS，无未使用导入或类型错误。

- [ ] **Step 7: 提交剩余采集器和分发**

```bash
git add src-tauri/src/db/schema_compare
git commit -m "feat: 支持 SQL Server 和 ClickHouse 批量结构采集"
```

---

### Task 5: 临时连接生命周期与 Tauri 对比命令

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/commands/connection.rs`
- Create: `src-tauri/src/commands/database_compare.rs`
- Modify: `src-tauri/src/db/connection.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `ConnectionManager::prepare_connection()`、完整保存连接存储、`list_databases_for_compare()`、`load_schema_snapshot()`、`compare_schema_snapshots()`。
- Produces: Tauri 命令 `list_compare_databases(saved_connection_id)` 和 `compare_databases(source, target)`。

- [ ] **Step 1: 写端点校验和错误侧别失败测试**

在新命令模块中为纯解析函数写测试：

```rust
#[test]
fn resolve_endpoints_requires_distinct_connections_with_same_type() {
    let mysql_a = config("a", DatabaseType::MySql);
    let mysql_b = config("b", DatabaseType::MySql);
    let postgres = config("pg", DatabaseType::Postgres);

    assert!(validate_endpoint_configs(&mysql_a, &mysql_b).is_ok());
    assert_eq!(
        validate_endpoint_configs(&mysql_a, &mysql_a).unwrap_err(),
        "源端和目标端不能使用同一个保存连接"
    );
    assert_eq!(
        validate_endpoint_configs(&mysql_a, &postgres).unwrap_err(),
        "源端和目标端的数据库类型必须一致"
    );
}

#[test]
fn missing_saved_connection_error_names_the_side() {
    let saved = vec![config("source", DatabaseType::MySql)];
    let error = find_saved_connection(&saved, "missing", "目标端").unwrap_err();
    assert_eq!(error, "目标端保存连接不存在或已删除");
}
```

- [ ] **Step 2: 运行命令模块测试确认失败**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::database_compare::tests -- --nocapture`

Expected: FAIL，提示命令模块或校验函数不存在。

- [ ] **Step 3: 暴露最小内部连接能力并增加 RFC 3339 时间依赖**

- 将 `load_saved_connections_internal()` 改为 `pub(crate)`。
- 将 `ActiveDatabaseConnection::pool_handle()` 与 `disconnect()` 改为 `pub(crate)`；不扩大到 `pub`。
- 在 `src-tauri/Cargo.toml` 增加 `time = { version = "0.3", features = ["formatting"] }` 并更新 lockfile。
- 用 `OffsetDateTime::now_utc().format(&Rfc3339)` 生成 `compared_at`，格式化失败返回“生成对比时间失败”。

- [ ] **Step 4: 实现临时连接包装器和错误合并**

```rust
struct TemporaryConnection {
    active: ActiveConnection,
}

impl TemporaryConnection {
    async fn open(config: ConnectionConfig) -> Result<Self, String> {
        let (_, active) = ConnectionManager::prepare_connection(config).await?;
        Ok(Self { active })
    }

    fn pool_handle(&self) -> DatabasePoolHandle {
        self.active.database.pool_handle()
    }

    async fn close(self) -> Result<(), String> {
        self.active.database.disconnect().await
    }
}

fn merge_operation_and_cleanup<T>(
    operation: Result<T, String>,
    source_cleanup: Result<(), String>,
    target_cleanup: Result<(), String>,
) -> Result<T, String> {
    let cleanup_errors = [source_cleanup.err(), target_cleanup.err()]
        .into_iter().flatten().collect::<Vec<_>>();
    match (operation, cleanup_errors.is_empty()) {
        (Ok(value), true) => Ok(value),
        (Ok(_), false) => Err(format!("释放数据库对比临时连接失败: {}", cleanup_errors.join("；"))),
        (Err(error), true) => Err(error),
        (Err(error), false) => Err(format!("{}；清理临时连接失败: {}", error, cleanup_errors.join("；"))),
    }
}

fn merge_single_operation_and_cleanup<T>(
    operation: Result<T, String>,
    cleanup: Result<(), String>,
) -> Result<T, String> {
    merge_operation_and_cleanup(operation, cleanup, Ok(()))
}
```

建立两侧连接使用 `tokio::join!`。一侧失败时，立即关闭另一侧已成功建立的临时连接，然后返回带“源端/目标端 + 连接名称”的错误。

- [ ] **Step 5: 实现两个 Tauri 命令**

`list_compare_databases` 流程必须为：加载保存连接 → 打开临时连接 → 克隆 pool handle → `list_databases_for_compare` → 关闭连接 → 用 `merge_single_operation_and_cleanup()` 合并操作与清理错误。

`compare_databases` 在两侧连接建立后，分别执行以下固定流程：

```rust
async fn load_selected_snapshot(
    side: &str,
    connection_name: &str,
    pool: DatabasePoolHandle,
    database: &str,
) -> Result<Vec<TableSnapshot>, String> {
    let databases = list_databases_for_compare(pool.clone()).await
        .map_err(|error| format!("{}连接「{}」加载数据库列表失败: {}", side, connection_name, error))?;
    if !databases.iter().any(|name| name == database) {
        return Err(format!("{}连接「{}」中的数据库/schema「{}」不存在", side, connection_name, database));
    }
    load_schema_snapshot(pool, database).await
        .map_err(|error| format!("{}连接「{}」读取对比元数据失败: {}", side, connection_name, error))
}
```

两侧 `load_selected_snapshot` 使用 `tokio::join!`，之后无论结果成功失败都用 `tokio::join!` 关闭两侧。仅当两侧快照都成功时调用 `compare_schema_snapshots()`。连接配置只在 Rust 内部使用；响应端点只带保存连接 ID、显示名称和数据库/schema 名称。

- [ ] **Step 6: 注册模块和 Tauri 命令**

- `commands/mod.rs` 增加 `pub mod database_compare;`。
- `lib.rs` 的 `use commands` 增加 `database_compare`。
- `generate_handler!` 增加 `database_compare::list_compare_databases` 和 `database_compare::compare_databases`。

- [ ] **Step 7: 运行后端测试和静态检查**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::database_compare::tests -- --nocapture`

Expected: PASS。

Run: `cargo test --manifest-path src-tauri/Cargo.toml schema_compare:: -- --nocapture`

Expected: PASS。

Run: `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`

Expected: PASS；若失败先运行 `cargo fmt --manifest-path src-tauri/Cargo.toml`，再重新检查。

Run: `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`

Expected: PASS。

- [ ] **Step 8: 提交后端命令**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands/mod.rs src-tauri/src/commands/connection.rs src-tauri/src/commands/database_compare.rs src-tauri/src/db/connection.rs src-tauri/src/lib.rs
git commit -m "feat: 增加跨连接数据库对比命令"
```

---

### Task 6: 前端契约、结果纯函数与 Excel 导出

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/services/tauriCommands.ts`
- Modify: `src/utils/excelExport.ts`
- Create: `src/utils/databaseCompare.ts`
- Create: `src/utils/databaseCompareExport.ts`
- Create: `src/__tests__/databaseCompare.test.ts`
- Create: `src/__tests__/databaseCompareExport.test.ts`
- Modify: `src/__tests__/excelExport.test.ts`

**Interfaces:**
- Consumes: 后端 snake_case 响应契约、现有 `writeBinaryFile()` 和保存对话框。
- Produces: `listCompareDatabases()`、`compareDatabases()`、筛选/格式化函数、`buildDatabaseCompareWorkbookSheets()`、`buildDatabaseCompareWorkbookBase64()`。

- [ ] **Step 1: 写前端纯函数和 Excel 工作表失败测试**

```ts
it("按状态和表名筛选差异", () => {
  const result = sampleCompareResult();
  expect(filterTableDiffs(result.tables, "changed", "user").map((row) => row.name))
    .toEqual(["users"]);
});

it("格式化字段变化时只输出变化属性", () => {
  const column = sampleChangedColumn();
  expect(formatChangedFields(column.changed_fields)).toBe("字段类型、允许为空");
  expect(formatColumnSideValues(column, "source"))
    .toBe("字段类型=bigint；允许为空=否");
});

it("构造摘要、表差异和字段差异三个工作表", () => {
  const sheets = buildDatabaseCompareWorkbookSheets(sampleCompareResult());
  expect(sheets.map((sheet) => sheet.sheet)).toEqual(["对比摘要", "表差异", "字段差异"]);
  expect(sheets[1].data[1]).toEqual(["source_only", "仅源端"]);
  expect(sheets[2].data[1]).toEqual([
    "users", "email", "仅目标端", "", "", "字段顺序=2；字段类型=varchar(255)；允许为空=是；默认值=；主键=否；额外属性=；注释="
  ]);
});
```

- [ ] **Step 2: 运行前端测试确认失败**

Run: `npm test -- src/__tests__/databaseCompare.test.ts src/__tests__/databaseCompareExport.test.ts`

Expected: FAIL，提示模块或函数不存在。

- [ ] **Step 3: 增加 TypeScript 契约和 Tauri API**

```ts
export type SchemaDiffStatus = "source_only" | "target_only" | "changed";
export type ColumnChangedField =
  | "ordinal_position" | "column_type" | "nullable" | "default_value"
  | "primary_key" | "extra" | "comment";

export interface DatabaseCompareEndpointRequest {
  saved_connection_id: string;
  database: string;
}

export interface CompareEndpointInfo {
  connection_id: string;
  connection_name: string;
  database: string;
}

export interface ColumnSnapshot {
  ordinal_position: number;
  column_type: string;
  nullable: boolean;
  default_value: string | null;
  primary_key: boolean;
  extra: string;
  comment: string;
}

export interface ColumnDiff {
  name: string;
  status: SchemaDiffStatus;
  changed_fields: ColumnChangedField[];
  source: ColumnSnapshot | null;
  target: ColumnSnapshot | null;
}

export interface TableDiff {
  name: string;
  status: SchemaDiffStatus;
  columns: ColumnDiff[];
}

export interface DatabaseCompareResult {
  database_type: DatabaseType;
  source: CompareEndpointInfo;
  target: CompareEndpointInfo;
  compared_at: string;
  summary: {
    source_only_tables: number;
    target_only_tables: number;
    changed_tables: number;
    different_columns: number;
  };
  tables: TableDiff[];
}
```

在 `tauriCommands.ts` 增加：

```ts
export async function listCompareDatabases(savedConnectionId: string): Promise<string[]> {
  return invoke<string[]>("list_compare_databases", { savedConnectionId });
}

export async function compareDatabases(
  source: DatabaseCompareEndpointRequest,
  target: DatabaseCompareEndpointRequest
): Promise<DatabaseCompareResult> {
  return invoke<DatabaseCompareResult>("compare_databases", { source, target });
}
```

- [ ] **Step 4: 实现纯格式化和筛选函数**

在 `databaseCompare.ts` 定义固定映射：状态为“仅源端/仅目标端/结构变化”；属性为“字段顺序/字段类型/允许为空/默认值/主键/额外属性/注释”。`filterTableDiffs()` 先按状态过滤，再以 `toLocaleLowerCase()` 做表名包含搜索。`formatColumnSideValues()` 对 changed 字段只输出 `changed_fields`，对单侧字段输出七项完整属性；空值为空字符串，布尔值为“是/否”，各属性使用 `属性=值` 并以中文分号连接。

- [ ] **Step 5: 抽取多工作表生成器并实现对比 Excel**

在 `excelExport.ts` 增加且让原 API 复用：

```ts
export interface ExcelSheetData {
  sheet: string;
  data: (string | number | boolean)[][];
}

export async function buildWorkbookBase64(sheets: ExcelSheetData[]): Promise<string> {
  const writeXlsxFile = (await import("write-excel-file/universal")).default;
  const blob = await (await writeXlsxFile(sheets)).toBlob();
  return workbookWriteBufferToBase64(await blobToArrayBuffer(blob));
}
```

`buildQueryResultWorkbookBase64()` 改为调用 `buildWorkbookBase64([{ sheet: sanitizeExcelSheetName(sheetName), data: sheetData }])`，确保旧测试继续通过。

`databaseCompareExport.ts` 的 `buildDatabaseCompareWorkbookSheets()` 固定生成：

- 摘要：键和值两列，顺序为数据库类型、源连接、源数据库/schema、目标连接、目标数据库/schema、对比时间、仅源端表、仅目标端表、结构变化表、差异字段。
- 表差异：`["表名", "差异状态"]` 加所有表行。
- 字段差异：`["表名", "字段名", "差异状态", "变化属性", "源端值", "目标端值"]` 加 changed 表内字段行。

`buildDatabaseCompareWorkbookBase64()` 调用通用生成器；`saveDatabaseCompareWorkbook()` 使用 `` `数据库对比-${result.source.database}-${result.target.database}.xlsx` `` 和现有 `saveExcelWithDialog()`。

- [ ] **Step 6: 运行前端工具测试**

Run: `npm test -- src/__tests__/databaseCompare.test.ts src/__tests__/databaseCompareExport.test.ts src/__tests__/excelExport.test.ts`

Expected: PASS，三个工作表数据及旧 Excel 导出均通过。

- [ ] **Step 7: 提交前端契约和导出**

```bash
git add src/types/index.ts src/services/tauriCommands.ts src/utils/excelExport.ts src/utils/databaseCompare.ts src/utils/databaseCompareExport.ts src/__tests__/databaseCompare.test.ts src/__tests__/databaseCompareExport.test.ts src/__tests__/excelExport.test.ts
git commit -m "feat: 增加数据库对比导出能力"
```

---

### Task 7: 数据库对比窗口

**Files:**
- Create: `src/components/databaseCompare/DatabaseCompareModal.tsx`
- Create: `src/components/databaseCompare/DatabaseCompareModal.css`
- Create: `src/__tests__/DatabaseCompareModal.test.tsx`

**Interfaces:**
- Consumes: `useConnectionStore().savedConnections`、`listCompareDatabases()`、`compareDatabases()`、Task 6 的筛选/格式化/导出函数。
- Produces: `<DatabaseCompareModal open: boolean onClose: () => void />`。

- [ ] **Step 1: 开始前读取 UI 规范并写交互失败测试**

开始本任务时读取并使用 `ui-ux-pro-max`，但不得改变已批准的入口、双端选择、摘要、筛选和展开表格流程。

测试准备两个 MySQL 和一个 PostgreSQL 保存连接，mock 两个 API：

```tsx
it("按先源后目标流程过滤连接并完成对比", async () => {
  vi.mocked(api.listCompareDatabases).mockResolvedValue(["app", "audit"]);
  vi.mocked(api.compareDatabases).mockResolvedValue(sampleCompareResult());
  render(<DatabaseCompareModal open onClose={vi.fn()} />);

  expect(screen.getByLabelText("目标连接")).toBeDisabled();
  await selectAntOption("源连接", "MySQL A");
  expect(await screen.findByText("app")).toBeInTheDocument();
  await selectAntOption("源数据库/schema", "app");
  await selectAntOption("目标连接", "MySQL B");
  expect(screen.queryByText("PostgreSQL C")).not.toBeInTheDocument();
  await selectAntOption("目标数据库/schema", "audit");
  fireEvent.click(screen.getByRole("button", { name: "开始对比" }));

  expect(await screen.findByText("结构变化表")).toBeInTheDocument();
  expect(screen.getByText("users")).toBeInTheDocument();
  expect(api.compareDatabases).toHaveBeenCalledWith(
    { saved_connection_id: "mysql-a", database: "app" },
    { saved_connection_id: "mysql-b", database: "audit" }
  );
});

it("连接变化清空旧结果，错误后保留选择并允许重试", async () => {
  vi.mocked(api.compareDatabases)
    .mockRejectedValueOnce("目标端无权限")
    .mockResolvedValueOnce(sampleCompareResult());
  renderConfiguredModal();
  fireEvent.click(screen.getByRole("button", { name: "开始对比" }));
  expect(await screen.findByText(/目标端无权限/)).toBeInTheDocument();
  expect(screen.getByLabelText("源数据库/schema")).toHaveTextContent("app");
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  expect(await screen.findByText("users")).toBeInTheDocument();
});
```

测试辅助 `selectAntOption(label, option)` 必须通过对应 label 找到 combobox、触发 mouseDown，再点击 option；不要依赖 CSS 类名。

- [ ] **Step 2: 运行组件测试确认失败**

Run: `npm test -- src/__tests__/DatabaseCompareModal.test.tsx`

Expected: FAIL，提示组件不存在。

- [ ] **Step 3: 实现端点选择和请求状态**

组件本地状态必须明确分离：

```ts
const [sourceConnectionId, setSourceConnectionId] = useState<string>();
const [targetConnectionId, setTargetConnectionId] = useState<string>();
const [sourceDatabase, setSourceDatabase] = useState<string>();
const [targetDatabase, setTargetDatabase] = useState<string>();
const [sourceDatabases, setSourceDatabases] = useState<string[]>([]);
const [targetDatabases, setTargetDatabases] = useState<string[]>([]);
const [loadingSide, setLoadingSide] = useState<"source" | "target" | null>(null);
const [comparing, setComparing] = useState(false);
const [exporting, setExporting] = useState(false);
const [result, setResult] = useState<DatabaseCompareResult | null>(null);
const [error, setError] = useState<string | null>(null);
const [statusFilter, setStatusFilter] = useState<"all" | SchemaDiffStatus>("all");
const [search, setSearch] = useState("");
```

源连接改变时清空两侧数据库、目标连接、结果和错误，再加载源列表。目标候选必须满足：有 ID、ID 不等于源端、`normalizeDatabaseType(candidate.database_type)` 等于源端类型。关闭窗口时统一重置以上状态并调用 `onClose()`。交换两端时交换连接 ID、数据库和已加载列表，然后清空结果/错误。

- [ ] **Step 4: 实现已批准的 Ant Design 结果界面**

Modal 使用 `width={1120}`，`destroyOnClose`，footer 依次为“关闭”“导出 Excel”“开始对比”。正文结构必须为：

1. 两个带标题的端点 `Card` 和中间 `SwapOutlined` 图标按钮。
2. 错误 `Alert`；错误时 action 为“重试”。
3. 成功后四个 `Statistic`：仅源端表、仅目标端表、结构变化表、差异字段。
4. 搜索 `Input` 和 `Segmented`（全部、仅源端、仅目标端、结构变化）。
5. 主 `Table<TableDiff>`，列为表名与差异状态；仅 `changed` 行可展开。
6. 展开区 `Table<ColumnDiff>`，列为字段名、状态、变化属性、源端值、目标端值。
7. `result.tables.length === 0` 时显示成功态 `Result`，文案“两个数据库结构一致”。

开始按钮的禁用条件为任一端连接或数据库未选择、正在加载任一侧、正在比较。导出按钮的禁用条件为无结果、正在比较或正在导出。表行 key 分别使用表名和字段名。状态必须同时用文本与颜色 Tag 表达，不能只依赖颜色。

- [ ] **Step 5: 实现样式与剩余交互测试**

CSS 使用两列网格；窗口小于 900px 时变为单列，交换按钮居中。为端点卡片、摘要网格、工具栏和展开表设置间距，颜色只使用现有 CSS 变量或 Ant Design token，不写新的硬编码主题色。

补充测试：交换两端清空结果、搜索/状态筛选、无差异成功态、导出按钮调用、关闭后重开状态为空。

- [ ] **Step 6: 运行组件与工具测试**

Run: `npm test -- src/__tests__/DatabaseCompareModal.test.tsx src/__tests__/databaseCompare.test.ts src/__tests__/databaseCompareExport.test.ts`

Expected: PASS。

Run: `npm run build`

Expected: PASS，无 TypeScript 或 Vite 构建错误。

- [ ] **Step 7: 提交对比窗口**

```bash
git add src/components/databaseCompare/DatabaseCompareModal.tsx src/components/databaseCompare/DatabaseCompareModal.css src/__tests__/DatabaseCompareModal.test.tsx
git commit -m "feat: 增加数据库对比界面"
```

---

### Task 8: 应用入口、说明文档与全量验证

**Files:**
- Modify: `src/App.tsx`
- Modify: `README.md`
- Modify: `src/components/common/ProjectIntroModal.tsx`
- Test: `src/__tests__/ProjectIntroModal.test.tsx`

**Interfaces:**
- Consumes: `DatabaseCompareModal`。
- Produces: 全局可访问的底部状态栏“数据库对比”入口和用户文档。

- [ ] **Step 1: 写功能介绍失败断言**

在 `ProjectIntroModal.test.tsx` 增加：

```ts
expect(screen.getByText("跨连接数据库对比")).toBeInTheDocument();
expect(screen.getByText(/同类型已保存连接/)).toBeInTheDocument();
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- src/__tests__/ProjectIntroModal.test.tsx`

Expected: FAIL，找不到“跨连接数据库对比”。

- [ ] **Step 3: 接入全局入口**

在 `AppInner` 增加 `compareVisible` 状态，渲染：

```tsx
<DatabaseCompareModal
  open={compareVisible}
  onClose={() => setCompareVisible(false)}
/>
```

在 Footer 右侧 `IdleTimeoutSetting` 之前增加：

```tsx
<Button
  type="text"
  size="small"
  icon={<DiffOutlined />}
  aria-label="数据库对比"
  onClick={() => setCompareVisible(true)}
>
  数据库对比
</Button>
```

补全 `Button`、`DiffOutlined` 和组件 import。入口不依赖 `activeConnection`，未连接时也必须显示。

- [ ] **Step 4: 更新功能介绍和 README**

`ProjectIntroModal` 增加“跨连接数据库对比”条目，说明“选择两个不同的同类型已保存连接，对比数据库/schema 的物理表与字段结构并导出 Excel”。

README 的“数据库管理”功能列表增加同样范围说明，并明确不比较视图、索引、外键或数据，避免用户误解。

- [ ] **Step 5: 运行全量前端验证**

Run: `npm test`

Expected: PASS，全部 Vitest 测试通过。

Run: `npm run build`

Expected: PASS。

Run: `npm run lint`

Expected: PASS，无 ESLint 错误。

Run: `npm run format:check`

Expected: PASS；若失败只对本次涉及的前端文件运行 Prettier，再重新检查。

- [ ] **Step 6: 运行全量 Rust 验证**

Run: `npm run test:rust`

Expected: PASS。

Run: `npm run fmt:rust`

Expected: PASS。

Run: `npm run lint:rust`

Expected: PASS，Clippy 零 warning。

- [ ] **Step 7: 检查变更范围和禁止项**

Run: `git diff --check`

Expected: 无输出。

Run: `rg -n "for .*\{|while .*\{" src-tauri/src/db/schema_compare src-tauri/src/commands/database_compare.rs`

逐个确认命中的循环只做内存行分组、排序或结果构造，循环体内没有 `.query()`、`.exec()`、`.simple_query()`、`.interact()` 或 ClickHouse `.execute()`。

Run: `git status --short`

Expected: 只显示 Task 8 的入口和文档文件，或工作区干净。

- [ ] **Step 8: 提交入口和文档**

```bash
git add src/App.tsx README.md src/components/common/ProjectIntroModal.tsx src/__tests__/ProjectIntroModal.test.tsx
git commit -m "feat: 增加数据库对比入口与说明"
```

- [ ] **Step 9: 完成后复核提交与工作区**

Run: `git status --short --branch`

Expected: 当前仍为 `master`，工作区干净。

Run: `git log -12 --oneline`

Expected: 顶部依次包含本计划的八个中文 Conventional Commit，设计提交 `3b98945` 仍在其后。
