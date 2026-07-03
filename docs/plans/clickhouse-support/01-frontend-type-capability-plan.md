# Step 01: 前端类型与能力开关规划

## 目标
让前端完整识别 `"clickhouse"` 数据库类型，并在 UI 上展示 ClickHouse 连接入口，同时通过能力开关先控制可见功能，避免后端尚未支持的操作被用户触发。

## 文件改动边界
- 修改：`src/types/index.ts`
- 修改：`src/utils/connectionConfig.ts`
- 修改：`src/utils/databaseCapabilities.ts`
- 修改：`src/utils/systemDatabase.ts`
- 修改：`src/utils/sqlCompletion.ts`
- 修改：`src/utils/sqlFormat.ts`
- 修改：`src/components/connection/ConnectionForm.tsx`
- 修改测试：`src/__tests__/connectionStore.test.ts`、`src/__tests__/ConnectionFormDatabaseType.test.tsx`、`src/__tests__/databaseCapabilities.test.ts`、`src/__tests__/systemDatabase.test.ts`、`src/__tests__/sqlCompletion.test.ts`、`src/__tests__/sqlFormat.test.ts`
- 不改动：后端 Rust 连接逻辑、数据库命令实现、打包配置。

## 任务清单
- [ ] 将 `DatabaseType` 扩展为 `"mysql" | "postgres" | "sqlite" | "sqlserver" | "clickhouse"`。
- [ ] 在 `normalizeDatabaseType` 中识别 `"clickhouse"`，未知类型仍回退 `"mysql"`。
- [ ] 在 `defaultPortForDatabaseType` 中为 ClickHouse 返回 `8123`。
- [ ] 在连接表单数据库类型下拉框新增 `ClickHouse`。
- [ ] 连接表单选择 ClickHouse 时显示主机、端口、用户名、密码、数据库、SSL/SSH、安全选项；不显示 SQLite 文件字段。
- [ ] ClickHouse 品牌文案统一为 `ClickHouse`，SSL 折叠标题显示 `SSL / TLS（ClickHouse）`。
- [ ] 新增 `CLICKHOUSE_CAPABILITIES`，首步建议配置：`sqlEditor=true`、`tableBrowsing=true`、`schemaManagement=false`、`tableDataEditing=false`、`databaseManagement=false`、`sqlFileImportExport=false`、`savedSql=true`、`favoriteTables=true`、其余 MySQL 独占对象管理为 `false`，`databaseObjectNoun="数据库"`。
- [ ] 将 `system`、`INFORMATION_SCHEMA`、`information_schema` 纳入系统库识别，防止 ClickHouse 系统库被删除或重命名。
- [ ] 新增 `CLICKHOUSE_KEYWORDS`，保留 `SELECT/INSERT/CREATE/DROP/ALTER/SHOW/DESCRIBE/EXPLAIN/WITH/FORMAT/ENGINE/MERGE TREE/ORDER BY/PARTITION BY/SAMPLE/LIMIT BY` 等常用关键词。
- [ ] 将 `SqlDialect` 增加 `"clickhouse"`，`quoteIdentifier` 采用反引号转义。
- [ ] `sqlDialectToFormatterLanguage("clickhouse")` 若 `sql-formatter` 当前无专用 ClickHouse 语言，则回退 `"sql"` 或 `"mysql"` 并用测试固定行为，避免运行时抛错。

## 测试命令
```bash
npm test -- src/__tests__/connectionStore.test.ts src/__tests__/ConnectionFormDatabaseType.test.tsx
npm test -- src/__tests__/databaseCapabilities.test.ts src/__tests__/systemDatabase.test.ts
npm test -- src/__tests__/sqlCompletion.test.ts src/__tests__/sqlFormat.test.ts
npm run build
```

## 验收标准
- 新建连接默认仍是 MySQL，旧连接缺省 `database_type` 仍归一为 MySQL。
- 选择 ClickHouse 后端口自动切换为 `8123`，保存配置提交 `database_type: "clickhouse"`。
- ClickHouse 首步只展示连接、SQL、浏览相关入口；未实现的写入/DDL/对象管理入口不可见。
- SQL 补全可按 ClickHouse 方言返回关键词，标识符使用反引号并正确转义反引号。
- SQL 格式化不会因为 ClickHouse 方言导致前端异常。

## 风险控制
- 能力开关必须先保守，再随后端能力逐步打开。
- 不要把未知数据库类型归一成 ClickHouse；未知类型继续回退 MySQL，避免破坏旧配置兼容。
- 连接表单改动只复用现有服务端数据库字段，不新增 ClickHouse 专属字段，降低配置迁移风险。
