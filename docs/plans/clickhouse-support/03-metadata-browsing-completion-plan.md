# Step 03: 元数据浏览与 SQL 补全规划

## 目标
实现 ClickHouse 数据库、表、列结构、主键/排序键和 SQL 补全元数据加载，使左侧树、表结构页和 SQL 编辑器可以读取 ClickHouse 元数据。

## 文件改动边界
- 修改：`src-tauri/src/db/clickhouse.rs`
- 修改：`src-tauri/src/commands/database/mod.rs`
- 修改：`src-tauri/src/commands/data.rs` 中只读获取主键相关分发点
- 修改测试：`src/__tests__/DatabaseTreeCapabilities.test.tsx`、`src/__tests__/TableContentSwitchTable.test.tsx`、`src/__tests__/TableStructureMetadata.test.tsx`、`src/__tests__/sqlCompletionSchema.test.ts`
- 新增/修改 Rust 单测：`src-tauri/src/db/clickhouse.rs` 的 SQL 构造与 JSON 映射测试
- 不改动：SQL 执行、表数据分页、写入和 DDL。

## 任务清单
- [ ] 在 `clickhouse.rs` 新增 `list_databases`，使用 `system.databases` 查询当前用户可见数据库，并过滤或标记系统库。
- [ ] 在 `commands/database/mod.rs::list_databases` 中加入 `DatabasePoolHandle::ClickHouse` 分支。
- [ ] 在 `clickhouse.rs` 新增 `list_tables(database)`，使用一条 `system.tables` 查询返回 `TableInfo`：`name`、`table_type`、`engine`、`total_rows`、`total_bytes`、`comment`。
- [ ] `table_type` 映射规则：`View/MaterializedView/LiveView` 归为 `VIEW`，其他归为 `TABLE`；`engine` 保留原始引擎名。
- [ ] 在 `commands/database/mod.rs::list_tables` 中加入 ClickHouse 分支。
- [ ] 在 `clickhouse.rs` 新增 `get_table_structure(database, table)`，使用一条 `system.columns` 查询返回 `ColumnInfo`，按 `position` 排序。
- [ ] `ColumnInfo.key` 映射：`is_in_primary_key=1` 返回 `PRI`；若仅在 sorting key 中但非 primary key，`key` 保持空字符串，`extra` 可显示 `sorting key`。
- [ ] 默认值映射：`default_kind` 与 `default_expression` 合并成可读字符串，空值返回 `None`。
- [ ] 在 `commands/database/mod.rs::get_table_structure` 中加入 ClickHouse 分支。
- [ ] 新增 `get_sql_completion_metadata`，一条 SQL 从 `system.tables` LEFT JOIN `system.columns` 批量取表和列，不允许循环逐表查列。
- [ ] 在 `commands/database/mod.rs::get_sql_completion_metadata` 中加入 ClickHouse 分支。
- [ ] 新增 `fetch_primary_keys` 或 `fetch_edit_locator`，从 `system.columns` 读取 `is_in_primary_key=1` 的列；若为空，表格编辑能力仍不开启。
- [ ] 前端树和表详情测试增加 ClickHouse 场景，确保显示数据库/表/结构但不展示未开放功能入口。

## 测试命令
```bash
npm test -- src/__tests__/DatabaseTreeCapabilities.test.tsx src/__tests__/TableContentSwitchTable.test.tsx
npm test -- src/__tests__/TableStructureMetadata.test.tsx src/__tests__/sqlCompletionSchema.test.ts
npm run test:rust -- clickhouse
npm run test:rust -- commands::database
```

## 验收标准
- `list_databases` 能返回 ClickHouse database 名称，且系统库被识别为系统对象。
- `list_tables` 能返回普通表、视图、物化视图的名称、类型、引擎、行数和字节数。
- `get_table_structure` 能返回列名、ClickHouse 类型、Nullable、默认表达式、注释和主键信息。
- SQL 补全元数据只用固定数量 SQL 获取，不出现“遍历表名后逐表查询列”的实现。
- 前端打开 ClickHouse 表时能显示结构 tab，未实现的 DDL/写入入口仍不可见。

## 风险控制
- 元数据 SQL 必须使用参数绑定或集中转义函数处理 database/table，禁止散落字符串拼接。
- `system.tables.total_rows` 可能为 NULL，前端 `rows` 必须允许 `null`。
- ClickHouse 的 `primary key` 与唯一定位不同，不要因为 `is_in_primary_key` 存在就自动开启行级 update/delete。
