# Step 05: 表数据读取、受控写入与 DDL 规划

## 目标
在 ClickHouse 上支持表格分页读取、计数、完整行复制、受控插入和安全 DDL；同时明确禁用当前不适合 ClickHouse 的行级 update/delete 表格编辑。

## 文件改动边界
- 修改：`src-tauri/src/db/clickhouse.rs`
- 修改：`src-tauri/src/commands/data.rs`
- 修改：`src-tauri/src/commands/database/mod.rs`
- 修改：`src-tauri/src/commands/database/column_ops.rs`
- 修改：`src/utils/databaseCapabilities.ts`
- 修改：`src/components/table/TableData.tsx`
- 修改：`src/components/database/CreateTableModal.tsx`
- 修改：`src/utils/columnTypeUtils.ts`
- 修改测试：`src/__tests__/databaseCapabilities.test.ts`、`src/__tests__/tableDataPagination.test.tsx`、`src/__tests__/TableDataSelection.test.tsx`、`src/__tests__/createTable.test.ts`、`src/__tests__/columnTypeUtils.test.ts`
- 不改动：外键、触发器、例程、事件命令。

## 任务清单
- [ ] 新增 `ClickHouseDialect` 或 ClickHouse SQL helper：集中实现标识符转义、字符串字面量、表引用、分页 SQL、count SQL、ORDER BY 构造。
- [ ] 在 `query_table_count` 加入 ClickHouse 分支：`SELECT count() FROM db.table WHERE ...`，WHERE 仍复用安全校验或新增 ClickHouse 专用校验。
- [ ] 在 `query_table_data` 加入 ClickHouse 分支：支持 page/page_size、排序、可选列选择、`skip_count`，结果使用 `FORMAT JSON` 转换。
- [ ] 在 `query_full_rows` 加入 ClickHouse 分支，仅用于复制为 INSERT；若缺少可安全定位列则返回明确错误。
- [ ] `get_primary_keys` 对 ClickHouse 只用于展示和复制，不用于开启行编辑。
- [ ] 将 `CLICKHOUSE_CAPABILITIES.tableDataEditing` 保持 `false`，除非产品明确接受 mutation 语义。
- [ ] `insert_row` 可开放为受控写：将单行 `values` 转为 `INSERT INTO db.table (...) FORMAT JSONEachRow` 或官方 client typed insert 的动态替代实现。
- [ ] `update_row`、`batch_update_rows`、`delete_rows` 对 ClickHouse 返回“ClickHouse 暂不支持表格行级更新/删除，请使用 SQL 编辑器执行明确的 ALTER TABLE ... UPDATE/DELETE mutation”。
- [ ] 开放基础 DDL：
  - `create_database`: `CREATE DATABASE name`
  - `drop_database`: 禁止系统库，执行 `DROP DATABASE name`
  - `rename_database`: 使用 `RENAME DATABASE old TO new`，若目标版本不支持则明确报错，不做逐表迁移
  - `rename_table`: `RENAME TABLE db.old TO db.new`
  - `drop_table`: `DROP TABLE db.table`
  - `truncate_table`: `TRUNCATE TABLE db.table`
- [ ] `create_table` 支持 ClickHouse 专属最小表单：默认 `ENGINE = MergeTree ORDER BY tuple()`，允许用户选择或输入 `MergeTree`、`ReplacingMergeTree` 等引擎和 ORDER BY 字段。
- [ ] `alter_table_engine`、列重排、外键、触发器、例程、事件对 ClickHouse 明确返回不支持。
- [ ] 前端 `CreateTableModal` 增加 ClickHouse 类型建议：`UInt64`、`Int64`、`Float64`、`Decimal(18,2)`、`String`、`LowCardinality(String)`、`Date`、`DateTime`、`DateTime64(3)`、`Bool`、`UUID`、`Array(String)`、`Nullable(String)`。

## 测试命令
```bash
npm test -- src/__tests__/databaseCapabilities.test.ts src/__tests__/tableDataPagination.test.tsx
npm test -- src/__tests__/TableDataSelection.test.tsx src/__tests__/createTable.test.ts src/__tests__/columnTypeUtils.test.ts
npm run test:rust -- clickhouse
npm run test:rust -- commands::data
npm run test:rust -- commands::database
```

## 验收标准
- ClickHouse 表格数据页能分页加载，排序和 WHERE 过滤在受支持范围内正常工作。
- `skip_count=true` 时不执行 count；`skip_count=false` 时只执行一条 count SQL。
- ClickHouse 连接不会显示可编辑单元格、批量更新、行删除等当前不支持入口。
- `INSERT` 成功后返回受影响行数或明确成功消息。
- 基础 DDL 对普通库表可用，对系统库表和只读连接被拒绝。
- 不存在“遍历每一行/每一列后执行 SQL”的实现。

## 风险控制
- ClickHouse mutation 不是事务式单行编辑，首版不映射到表格 update/delete，避免用户误以为立即一致。
- `CREATE TABLE` 默认引擎必须安全且可用；复杂引擎参数留给 SQL 编辑器。
- `rename_database` 不采用 MySQL 那种逐表迁移策略，避免违反禁止循环 SQL 约束并减少半迁移风险。
