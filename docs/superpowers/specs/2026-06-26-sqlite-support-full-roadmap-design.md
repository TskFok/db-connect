# SQLite 支持完整路线图设计

## 背景

当前项目已经完成 MySQL 与 PostgreSQL 的多数据库架构演进，前端状态模型、连接配置、连接分组、SQL 编辑器、库表树、表数据视图和 capability map 都具备复用基础。Rust 后端也已经有 `DatabaseType`、`DatabasePoolHandle`、`ActiveDatabaseConnection`、`adapter`、`dialect` 与按数据库类型分发的命令层。

SQLite 与现有两类服务端数据库的差异较大：它是本地文件型数据库，没有主机、端口、用户名、密码、SSH 隧道或 TLS 连接；同一个连接可访问 `main`、`temp` 以及 `ATTACH` 后的附加库；系统元数据主要来自 `sqlite_schema` 与 PRAGMA。SQLite 支持可以落在现有多数据库框架内，但不能只增加一个下拉选项。

## 总目标

在当前项目中渐进接入 SQLite，最终支持：

- 保存、测试、打开本地 SQLite 数据库文件。
- 浏览 `main` / `temp` / attached database 下的表、视图、索引、外键与触发器。
- 查看表结构、分页查看数据、执行 SQL、EXPLAIN、SQL 补全和会话信息。
- 在明确能力范围内编辑数据、创建/删除/重命名表、创建/删除索引、导入导出 SQL 文件。
- 对 SQLite 不存在或风险较高的能力保持明确禁用或返回中文错误，避免 UI 暗示“可用但实际失败”。

## 非目标

- 不把 SQLite 支持拆成独立应用。
- 不重写当前前端状态模型；继续复用“第一层 database/schema + 第二层 table”的树结构。
- 不在 SQLite 中支持 MySQL 事件、PostgreSQL routine 等无对应概念的对象。
- 不在首个阶段实现完整 DDL 和数据编辑。
- 不为 SQLite 引入 SSH、TLS、用户名密码等服务端数据库字段。

## 核心设计

### 数据模型

`DatabaseType` 增加 `sqlite`。旧连接仍缺省为 `mysql`，保持兼容。

`ConnectionConfig` 增加可选字段：

```rust
pub sqlite_path: Option<String>
```

TypeScript 同步增加：

```ts
sqlite_path?: string;
```

SQLite 连接必须使用 `sqlite_path`。`host`、`port`、`username`、`password`、`database` 继续保留在结构里，便于序列化兼容，但 SQLite 表单不展示这些字段。保存 SQLite 连接时，后端验证 `sqlite_path` 非空，并把无意义的 SSH/TLS 字段忽略或拒绝。

### 连接模型

Rust 侧新增 `src-tauri/src/db/sqlite.rs`，使用 `deadpool-sqlite` 包装 `rusqlite`。为减少跨平台系统 SQLite 依赖，Cargo 直接启用 `rusqlite` 的 `bundled` feature。

连接管理增加：

```rust
DatabasePoolHandle::Sqlite(SqlitePoolHandle)
ActiveDatabaseConnection::Sqlite(SqliteActiveConnection)
```

SQLite 断开连接只需要关闭连接池引用。`ping` 使用 `SELECT 1`。

### 树模型

SQLite 复用现有两层树：

- 第一层展示 `PRAGMA database_list` 中的 `main`、`temp` 和 attached database 名称。
- 第二层展示该 database 下的普通表与视图。
- 默认选中 `main`。

前端 capability 的 `databaseObjectNoun` 对 SQLite 使用 `"database"` 或 `"文件"` 不足以表达树节点含义。为避免大范围文案重构，首版使用 `"database"`，具体按钮和空状态文案按 `sqlite` 单独分支显示为“SQLite database”或“文件”。

### SQL 方言

新增 `SqliteDialect`：

- 标识符使用双引号。
- 字符串字面量双写单引号。
- 表引用使用 `"schema"."table"`，schema 来自 `main`、`temp` 或 attached database 名。
- 分页使用 `LIMIT {limit} OFFSET {offset}`。
- 只读连接允许 `SELECT`、安全 `WITH`、`EXPLAIN`、只读 PRAGMA；拒绝 `INSERT`、`UPDATE`、`DELETE`、`CREATE`、`DROP`、`ALTER`、`ATTACH`、`DETACH`、`VACUUM` 等写类语句。

### 元数据查询

遵守项目约定：禁止在循环遍历中查询 SQL。

SQLite 元数据读取优先使用批量查询：

- 数据库列表：`PRAGMA database_list`
- 表和视图：查询指定 schema 的 `sqlite_schema`
- 补全元数据：从 `sqlite_schema` 和 `pragma_table_xinfo(table_name, schema_name)` 批量展开
- 外键：从 `sqlite_schema` 与 `pragma_foreign_key_list(table_name, schema_name)` 批量展开
- 索引：针对当前选中表读取 `pragma_index_list` / `pragma_index_xinfo`；跨表列表必须使用 table-valued PRAGMA 的批量查询形式

对“当前选中单表”的结构查询不属于循环遍历，可以使用一次 `PRAGMA table_xinfo` 或 table-valued PRAGMA。

### 前端能力矩阵

新增 `SQLITE_CAPABILITIES`，按阶段逐步开放。首期能力：

- `sqlEditor: true`
- `tableBrowsing: true`
- `tableDataEditing: false`
- `databaseManagement: false`
- `schemaManagement: false`
- `routineManagement: false`
- `eventManagement: false`
- `triggerManagement: false`
- `indexManagement: false`
- `foreignKeyManagement: false`
- `sqlFileImportExport: false`
- `savedSql: false`
- `favoriteTables: false`
- `charsetAndCollation: false`
- `storageEngine: false`
- `columnReordering: false`

后续阶段只在对应后端命令、前端入口和测试都完成后打开 capability。

## 阶段路线

### Phase 1：类型、配置与连接基础

建立 `sqlite` 数据库类型、连接配置字段、连接表单、后端连接池、测试连接、连接/断开/ping。该阶段不开放库表浏览。

### Phase 2：库表浏览与只读表数据

实现 `main` / `temp` / attached database 列表、表/视图列表、表结构、分页数据查询、COUNT 和 SQLite dialect。该阶段可在 UI 中浏览 SQLite 文件和查看数据。

### Phase 3：SQL 编辑器、补全与会话信息

实现 SQLite SQL 编辑器执行、结果集转换、只读连接拦截、SQL 补全、会话信息和 EXPLAIN。取消查询在本阶段返回明确不可用状态，不阻塞主流程。

### Phase 4：数据编辑与安全 DDL 子集

开放 SQLite 表数据新增、更新、批量更新、删除，以及 SQLite 可控 DDL 子集：创建表、删除表、重命名表、清空表、新增列、删除列。对改列类型、改列顺序、存储引擎、字符集等不支持能力继续禁用。

### Phase 5：对象管理、导入导出与打磨

补齐 SQLite 索引、外键、触发器查看/管理、SQL 文件导入导出、README、功能介绍、测试矩阵和手工回归说明。评估是否启用 saved SQL 与收藏表。

## 兼容性

- 旧连接没有 `database_type` 时仍按 MySQL 处理。
- 旧连接 JSON 没有 `sqlite_path` 时可以正常反序列化。
- 连接导入导出保留 `sqlite_path`，加密迁移文件不需要升版本。
- MySQL 与 PostgreSQL 的保存、连接、浏览、SQL 执行和导入导出回归必须持续通过。

## 验收基线

每个阶段完成后至少运行：

```bash
npm test
npm run test:rust
```

受影响范围较小时可先运行阶段文件中列出的精确测试，再运行完整测试作为合并前验证。

每个阶段还需要手工验收：

- MySQL 旧连接仍能连接和浏览。
- PostgreSQL 旧连接仍能连接和浏览。
- SQLite 本阶段新增能力可用。
- SQLite 未实现能力在 UI 中不可误点；直接调用后端命令时返回明确中文错误。
