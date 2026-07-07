# Step 04: SQL 执行与会话信息规划

## 目标
让 SQL 编辑器可以在 ClickHouse 连接上执行查询和非查询语句，返回动态列结果，支持只读连接校验，并展示 ClickHouse 会话/服务器信息。

## 文件改动边界
- 修改：`src-tauri/src/db/clickhouse.rs`
- 修改：`src-tauri/src/commands/data.rs`
- 修改：`src-tauri/src/lib.rs` 中 `RunningQuery` 枚举
- 修改：`src/components/sql/SqlEditor.tsx`
- 修改测试：`src/__tests__/sqlExecutionCommands.test.ts`、`src/__tests__/dangerousSql.test.ts`、`src/__tests__/sqlFormat.test.ts`、`src/__tests__/sqlCompletion.test.ts`
- 新增 Rust 单测：ClickHouse SQL 类型判断、JSON 结果转换、只读拒绝。
- 不改动：表格分页、导入导出、DDL UI。

## 任务清单
- [ ] 在 `clickhouse.rs` 新增 `clickhouse_sql_editor_returns_result_set`：允许 `SELECT`、`SHOW`、`DESCRIBE`、`DESC`、`EXPLAIN`、只读 `WITH`。
- [ ] 新增 `clickhouse_sql_editor_allowed_on_read_only_connection`：在只读连接下只允许返回结果集的语句。
- [ ] 新增 `run_sql_on_client(client, sql, read_only, start)`：
  - 返回结果集语句走 `query(sql).with_setting("wait_end_of_query", "1").with_setting("max_result_rows", "100000").with_setting("result_overflow_mode", "throw").with_setting("output_format_json_quote_64bit_integers", "1").fetch_bytes("JSON")`。
  - 非结果集语句走 `execute()`，返回 `modify` 类型结果。
  - JSON `meta` 转为 `columns`，`data` 转为二维 `rows`，保留字段顺序。
- [ ] 在 `commands/data.rs::execute_sql` 加入 ClickHouse 分支。
- [ ] ClickHouse 首版取消查询采用保守策略：`RunningQuery::ClickHouseUnsupported`，前端按钮提示“ClickHouse 暂不支持主动取消”。后续如确认 query_id 方案，再单独实现。
- [ ] 新增 `get_session_info` 分支，固定查询 `SELECT version(), hostName(), currentDatabase(), timezone(), currentUser()`，`server_read_only` 可通过 `readonly` setting 或权限查询失败时保守为 `false`。
- [ ] `SessionInfo.connection_id` 对 ClickHouse 无 MySQL 式连接 ID 时返回 `0`，`grant_write_capable` 在只读连接或权限不足时为 `false`。
- [ ] `SqlEditor.tsx` 对 `databaseType === "clickhouse"` 展示 ClickHouse 版本/当前 database/时区说明；EXPLAIN ANALYZE 按实际支持情况禁用或走普通 EXPLAIN。
- [ ] 对大整数、Nullable、DateTime、Array/Map/JSON 字段补 JSON 转换测试。

## 测试命令
```bash
npm test -- src/__tests__/sqlExecutionCommands.test.ts src/__tests__/dangerousSql.test.ts
npm test -- src/__tests__/sqlFormat.test.ts src/__tests__/sqlCompletion.test.ts
npm run test:rust -- clickhouse
npm run test:rust -- commands::data
```

## 验收标准
- ClickHouse 执行 `SELECT 1` 返回 `result_type: "select"`、列名和一行数据。
- ClickHouse 执行 `CREATE TABLE ...` 或 `DROP TABLE ...` 等非结果语句返回 `modify` 类型结果，且只读连接下被拒绝。
- 查询超过 `100000` 行时后端返回明确错误，不让前端一次性承载超大结果集。
- SQL 编辑器会话信息能展示 ClickHouse version、hostname、database 和 timezone。
- 取消查询按钮不会误报成功；首版明确返回不支持。

## 风险控制
- 不通过拼接 `FORMAT JSON` 修改用户 SQL，优先使用客户端 `fetch_bytes("JSON")`，避免破坏已有 `FORMAT` 子句。
- 对 `WITH` 语句要检测是否包含 `INSERT/ALTER/CREATE/DROP/TRUNCATE/DELETE/UPDATE` 等写类动作。
- JSON 结果解析必须保留 ClickHouse 返回的列顺序，不能依赖 `serde_json::Map` 的迭代顺序。
