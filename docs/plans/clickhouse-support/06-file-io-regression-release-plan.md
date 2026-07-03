# Step 06: SQL 文件导入导出、回归与发布收口规划

## 目标
在核心浏览与 SQL 能力稳定后，为 ClickHouse 补齐 SQL 文件导入导出、连接导入导出回归、端到端验证和文档说明，形成可发布版本。

## 文件改动边界
- 修改：`src-tauri/src/commands/sql_file.rs`
- 修改：`src/utils/sqlFileIoUi.ts`
- 修改：`src/components/database/DatabaseSqlFileActions.tsx`
- 修改：`src/components/common/ProjectIntroModal.tsx`
- 修改：`README.md`
- 修改测试：`src/__tests__/sqlFileIoUi.test.ts`、`src/__tests__/sqlIoProgress.test.ts`、`src/__tests__/DatabaseSqlFileActions.test.tsx`、`src/__tests__/ProjectIntroModal.test.tsx`、`src/__tests__/savedSqlConnection.test.ts`
- 可选新增文档：`docs/clickhouse-support.md`
- 不改动：连接底层、元数据浏览、SQL 执行核心逻辑。

## 任务清单
- [ ] 在 `sqlFileIoUi.ts` 中加入 ClickHouse capability：只有 Step 04/05 验收通过后才开启导入导出入口。
- [ ] 在 `previewSqlFileImport(databaseType, path)` 的后端解析中识别 ClickHouse：按分号拆语句时复用现有 SQL 脚本 parser，并正确处理 `FORMAT`、多行 `CREATE TABLE`、`INSERT INTO ... VALUES`。
- [ ] `import_sql_file` 对 ClickHouse 逐语句执行时保留进度事件；只读连接下拒绝所有写类语句。
- [ ] `export_database_to_file` 对 ClickHouse 使用固定数量元数据 SQL：
  - 一条 `system.tables` 获取目标 database 下所有普通表/视图的 `create_table_query`
  - 根据导出策略逐表导出数据时必须明确进度和上限，不在元数据阶段循环查结构
- [ ] 若导出数据必须逐表执行 `SELECT ... FORMAT`，在规划中标注这是“按表导出数据”的业务循环，不属于“循环遍历中查询元数据”；但需要限制单表行数、支持取消/失败续报。
- [ ] 保存 SQL key、收藏表 key、连接复用逻辑增加 ClickHouse 测试，确保 ClickHouse 与 MySQL/Postgres/SQL Server 不串数据。
- [ ] README 和项目介绍中更新支持数据库列表：MySQL、PostgreSQL、SQLite、SQL Server、ClickHouse。
- [ ] 增加手工验证清单，覆盖直连、HTTPS、SSH、只读连接、系统库保护、大结果集保护、连接导入导出。
- [ ] 发布前运行全量前端、Rust、构建和格式检查。

## 测试命令
```bash
npm test -- src/__tests__/sqlFileIoUi.test.ts src/__tests__/sqlIoProgress.test.ts
npm test -- src/__tests__/DatabaseSqlFileActions.test.tsx src/__tests__/savedSqlConnection.test.ts src/__tests__/ProjectIntroModal.test.tsx
npm test
npm run build
npm run lint
npm run test:rust
npm run fmt:rust
npm run lint:rust
```

## 验收标准
- ClickHouse SQL 文件预览能识别语句数量、写类风险和只读限制。
- ClickHouse SQL 文件导入能执行 DDL/DML 并持续报告进度；失败时返回具体语句位置。
- ClickHouse 导出文件包含可执行的 `CREATE DATABASE`、`CREATE TABLE/VIEW` 和可选数据导出语句。
- 保存 SQL、收藏表、连接复用 key 都包含 `clickhouse` 类型，不会与其他数据库类型冲突。
- README/项目介绍中的支持数据库列表与实际功能一致。
- 全量测试、构建、lint、Rust fmt/clippy 全部通过。

## 风险控制
- 文件导出数据量可能极大，默认应只导出结构；导出数据需要显式选择并显示上限。
- SQL 文件导入不做隐式事务承诺；ClickHouse DDL/DML 执行失败后只报告已执行/失败位置。
- 文档必须说明 ClickHouse 首版不支持表格行级 update/delete、触发器、外键、例程和事件。
