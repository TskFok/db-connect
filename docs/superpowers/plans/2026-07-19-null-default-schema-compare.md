# NULL 默认值结构对比修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复无默认值与显式 `NULL` 在结构对比和同步后复查中被误判为“结构变化”的问题。

**Architecture:** 在 Rust 后端结构对比模块内增加一个局部的默认值语义比较器，只将 `None` 与可由完整平衡外层括号包裹的裸 `NULL` 归为同一等价类。快照采集与原始值保持不变，现有结构对比和同步计划通过同一 `changed_fields` 判定自动共享修复结果。

**Tech Stack:** Rust 2021、Cargo 内置测试、现有 `ColumnSnapshot` / `compare_schema_snapshots` 对比模型。

## Global Constraints

- 默认在当前 `master` 分支修改，不新建分支。
- 禁止在循环遍历中查询 SQL；本修复不增加任何 SQL 查询。
- 不修改各数据库快照适配器、前端格式化或同步方言。
- 仅将 `None`、`NULL`、`null`、`(NULL)`、`(( NULL ))` 等语义空默认值视为等价。
- `'NULL'`、`NULL::text`、`CAST(NULL AS ...)`、`0` 和非完整括号表达式仍按原值比较。
- 提交信息遵循 Conventional Commits，使用中文描述。

---

## File Map

- Modify and test: `src-tauri/src/db/schema_compare/mod.rs`
  - 负责字段结构差异判定。
  - 新增局部纯函数以识别语义空默认值并比较两个默认值。
  - 在现有测试模块中加入端到端快照对比回归测试。
- Include in implementation commit: `docs/superpowers/plans/2026-07-19-null-default-schema-compare.md`
  - 记录本次测试驱动实施与验证步骤。

### Task 1: 修复 NULL 默认值语义比较

**Files:**
- Modify: `src-tauri/src/db/schema_compare/mod.rs:97-108`
- Test: `src-tauri/src/db/schema_compare/mod.rs:259-373`
- Include: `docs/superpowers/plans/2026-07-19-null-default-schema-compare.md`

**Interfaces:**
- Consumes: `ColumnSnapshot.default_value: Option<String>` 与现有 `changed_fields(&ColumnSnapshot, &ColumnSnapshot) -> Vec<String>`。
- Produces: 私有函数 `default_values_equal(source: Option<&str>, target: Option<&str>) -> bool`、`is_semantic_null_default(value: Option<&str>) -> bool` 和 `strip_balanced_outer_parentheses(value: &str) -> Option<&str>`；调用方无需修改接口。

- [ ] **Step 1: 写入会失败的结构对比回归测试**

在 `tests` 模块的 `row` 辅助函数后增加：

```rust
    fn row_with_default(default_value: Option<&str>) -> SnapshotRow {
        let mut snapshot = row("users", "status", 1, "varchar(20)");
        snapshot.details.default_value = default_value.map(str::to_string);
        snapshot
    }

    #[test]
    fn compare_treats_only_semantic_null_defaults_as_equal() {
        for (source_default, target_default) in [
            (None, Some("NULL")),
            (Some("(( NULL ))"), None),
            (Some("null"), Some("(NULL)")),
        ] {
            let result = compare_schema_snapshots(
                DatabaseType::MySql,
                endpoint("source", "源端", "app"),
                endpoint("target", "目标端", "app"),
                "2026-07-19T00:00:00Z".to_string(),
                rows_to_tables(vec![row_with_default(source_default)]),
                rows_to_tables(vec![row_with_default(target_default)]),
            );

            assert!(
                result.tables.is_empty(),
                "source={source_default:?}, target={target_default:?}"
            );
        }

        for target_default in ["'NULL'", "NULL::text", "CAST(NULL AS text)", "0", "(NULL) + 1", "(NULL"] {
            let result = compare_schema_snapshots(
                DatabaseType::MySql,
                endpoint("source", "源端", "app"),
                endpoint("target", "目标端", "app"),
                "2026-07-19T00:00:00Z".to_string(),
                rows_to_tables(vec![row_with_default(None)]),
                rows_to_tables(vec![row_with_default(Some(target_default))]),
            );

            assert_eq!(
                result.tables[0].columns[0].changed_fields,
                vec!["default_value"],
                "target={target_default:?}"
            );
        }
    }
```

- [ ] **Step 2: 运行定向测试并确认 RED**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml compare_treats_only_semantic_null_defaults_as_equal -- --exact --nocapture
```

Expected: FAIL；第一组 `source=None, target=Some("NULL")` 仍返回一个变化表，`result.tables.is_empty()` 断言失败。若过滤器因完整测试路径导致 0 tests，则去掉 `--exact` 后重新运行，必须观察到目标断言失败。

- [ ] **Step 3: 实现最小默认值语义比较器**

在 `changed_fields` 之前增加以下私有纯函数：

```rust
fn strip_balanced_outer_parentheses(value: &str) -> Option<&str> {
    let value = value.trim();
    if !value.starts_with('(') || !value.ends_with(')') {
        return None;
    }

    let mut depth = 0usize;
    for (index, character) in value.char_indices() {
        match character {
            '(' => depth += 1,
            ')' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 && index + character.len_utf8() != value.len() {
                    return None;
                }
            }
            _ => {}
        }
    }

    (depth == 0).then(|| value[1..value.len() - 1].trim())
}

fn is_semantic_null_default(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return true;
    };
    let mut value = value.trim();

    loop {
        if value.eq_ignore_ascii_case("NULL") {
            return true;
        }
        let Some(inner) = strip_balanced_outer_parentheses(value) else {
            return false;
        };
        value = inner;
    }
}

fn default_values_equal(source: Option<&str>, target: Option<&str>) -> bool {
    if is_semantic_null_default(source) && is_semantic_null_default(target) {
        true
    } else {
        source == target
    }
}
```

将 `changed_fields` 内的默认值判断替换为：

```rust
        (
            "default_value",
            !default_values_equal(
                source.default_value.as_deref(),
                target.default_value.as_deref(),
            ),
        ),
```

- [ ] **Step 4: 运行定向测试并确认 GREEN**

Run:

```bash
cargo test --manifest-path src-tauri/Cargo.toml compare_treats_only_semantic_null_defaults_as_equal -- --nocapture
```

Expected: PASS，输出 `1 passed; 0 failed`。

- [ ] **Step 5: 运行格式、模块测试、全量 Rust 测试和 Clippy**

Run:

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml db::schema_compare
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Expected: 四条命令均退出码为 0；所有测试通过，格式与 Clippy 无错误或警告。

- [ ] **Step 6: 检查变更范围并提交**

Run:

```bash
git diff --check
git diff -- src-tauri/src/db/schema_compare/mod.rs docs/superpowers/plans/2026-07-19-null-default-schema-compare.md
git status --short
```

Expected: `git diff --check` 无输出；差异仅包含本实施计划与结构对比测试/比较器。现有 `.planning/`、`findings.md`、`progress.md`、`task_plan.md` 保持未跟踪且不进入提交。

Commit:

```bash
git add src-tauri/src/db/schema_compare/mod.rs docs/superpowers/plans/2026-07-19-null-default-schema-compare.md
git commit -m "fix: 修复 NULL 默认值结构对比误判"
```
