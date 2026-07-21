# MySQL 生成列表达式兼容性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让缺少 `GENERATION_EXPRESSION` 系统列的 MySQL 兼容服务可以生成普通表同步预览。

**Architecture:** 在 MySQL 同步元数据读取前探测 `information_schema.COLUMNS` 的列能力。元数据 SQL 根据探测结果选择真实表达式或空字符串别名，后续已有生成列安全校验保持不变。

**Tech Stack:** Rust、mysql_async、现有 Rust 单元测试。

## Global Constraints

- 默认在当前分支修改，不新建分支。
- 不得在循环遍历中查询 SQL；能力探测每个端点执行一次。
- 不支持生成列表达式元数据时，实际生成列必须继续被无损同步校验阻止。

---

### Task 1: MySQL 元数据查询能力分支

**Files:**

- Modify: `src-tauri/src/db/schema_sync/mysql.rs:21-151, 906-922`
- Test: `src-tauri/src/db/schema_sync/mysql.rs:906-922`

**Interfaces:**

- Consumes: `mysql_async::Conn::exec_first` 和 `Queryable` trait。
- Produces: `metadata_sql(has_generation_expression: bool) -> String`，以及在 `load_metadata` 中按连接调用一次的能力探测。

- [ ] **Step 1: 写入失败的 SQL 回归测试**

```rust
#[test]
fn metadata_query_omits_unsupported_generation_expression_column() {
    let sql = metadata_sql(false);
    assert!(!sql.contains("columns.GENERATION_EXPRESSION"));
    assert!(sql.contains("'' AS generation_expression"));
}
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cargo test metadata_query_omits_unsupported_generation_expression_column --manifest-path src-tauri/Cargo.toml`

Expected: FAIL；当前元数据 SQL 无条件包含 `columns.GENERATION_EXPRESSION`。

- [ ] **Step 3: 实现最小能力探测与 SQL 分支**

```rust
async fn supports_generation_expression(conn: &mut mysql_async::Conn) -> Result<bool, String> {
    let row: Option<mysql_async::Row> = conn
        .exec_first(
            "SELECT 1 FROM information_schema.COLUMNS \\
             WHERE TABLE_SCHEMA = 'information_schema' \\
               AND TABLE_NAME = 'COLUMNS' \\
               AND COLUMN_NAME = 'GENERATION_EXPRESSION' LIMIT 1",
            (),
        )
        .await
        .map_err(|error| format!("查询 MySQL 同步元数据能力失败: {error}"))?;
    Ok(row.is_some())
}
```

将 `metadata_sql` 改为接受能力布尔值；不支持时投影 `'' AS generation_expression`，支持时投影现有 `COALESCE(columns.GENERATION_EXPRESSION, '')`。`load_metadata` 取得连接后先调用探测，再执行相应元数据 SQL。

- [ ] **Step 4: 运行针对性测试确认通过**

Run: `cargo test metadata_query --manifest-path src-tauri/Cargo.toml`

Expected: PASS；覆盖支持与不支持两种 SQL 投影。

- [ ] **Step 5: 运行 Rust 全量测试与格式检查**

Run: `cargo fmt --check --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml`

Expected: 两个命令退出码均为 0。
