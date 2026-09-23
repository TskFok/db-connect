# SQL 自动补全第三期：真实外键 JOIN 条件实施计划

> **执行要求：** 实施时使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，逐任务执行并用复选框记录进度。

**状态：** 待实施。本文件是实施计划，不表示功能已交付。

**目标：** 在用户主动打开 SQL 补全且光标位于 `JOIN ... ON` 的条件槽时，基于数据库真实外键给出可插入的、带正确别名与列顺序的等值连接条件。

**架构：** Rust 端新增按当前库或 schema 一次读取完整外键约束的命令，前端以第一期的连接缓存键管理外键快照。纯函数将第二期构建的作用域、JOIN 左右关系和外键快照匹配成候选；Monaco 只把候选作为显式补全项显示并替换当前前缀，不主动改写现有 `ON` 表达式。

**技术栈：** Tauri 2、Rust、MySQL `information_schema`、PostgreSQL `pg_catalog`、SQLite `pragma_foreign_key_list`、SQL Server `sys` catalog、React、TypeScript、Monaco、Vitest。

**设计依据：** 本文件的[设计约定](#设计约定)；无另立的设计文件。前置计划：[第一期：上下文与缓存](./2026-09-23-sql-completion-phase-1-context.md)、[第二期：查询作用域](./2026-09-23-sql-completion-phase-2-query-scopes.md)。

## 全局约束

- 仅使用已声明的真实外键；同名列不构成推荐依据，启发式关系推断留待单独设计。
- 禁止在循环遍历中查询 SQL；包括 `Promise.all(tables.map(listForeignKeys))`。批量端点每个请求按库或 schema 执行固定数量的 catalog 查询，SQLite 使用一次表值 `pragma_foreign_key_list` 查询。
- 仅 `RelationSymbol.kind === 'table'` 可进入外键匹配；CTE 与派生表首版不透传来源关系。
- 只在 `context.slot === 'joinCondition'`、`context.confidence === 'high'` 且左右关系均明确时显示关系项。解析不完整、歧义、无权限均降级到普通补全。
- ClickHouse 返回明确 `unsupported`，前端不生成伪关系，普通表列补全继续工作。
- 连接、库/schema、方言或 `connectionRevision` 改变时使外键快照失效；过期异步结果不得污染新编辑器会话。
- SQL 标识符必须依方言解析和生成。未确定的 MySQL `lower_case_table_names` 或 SQL Server collation 不得把不同名称合并成一个关系；绝不跨 namespace 靠同名匹配。
- 本次计划写作只产出本文件；实施阶段才修改下列产品和测试文件。实施提交遵守仓库的中文 Conventional Commit 格式，并默认在当前分支操作。

## 审查重点

以下五类输入尤其容易造成错误推荐；对应测试分别落在任务 2、3、4、5、6。

1. PostgreSQL 引号标识符与未引号大小写：`"Orders"` 和 `orders` 应匹配各自唯一的 catalog 表，模糊命中应放弃推荐（任务 5）。
2. 多 schema 同名表、跨 schema 外键：仅完整 namespace 与表名匹配时可推荐（任务 2、5）。
3. 两表间多条外键或一条复合外键：每条约束独立候选，复合列按原始序号成对组合（任务 2、5）。
4. 自关联且出现两次别名：同一 FK 的两个方向都可成立；按约束 ID、子表 relation ID、父表 relation ID 生成两个带角色说明的候选，不能由别名猜方向（任务 5）。
5. 权限失败、慢请求或连接切换：无关系项、无未处理异常、旧结果不复活（任务 4、6）。

## 设计约定

第一期在 `src/utils/sqlCompletionTypes.ts` 提供 `SqlCompletionContext`、`QueryScope`、`RelationSymbol`、`ColumnSymbol`、`CompletionCandidate`；第三期消费该契约，不再建立第二套 SQL 解析器。核心字段：`context.scopeId`、`slot`、`edit`、`confidence`、`join?: {leftRelationIds; rightRelationId}`、`scopes`。一期 provider 在 analyzer 之后从 `binding.key.database` 注入 `context.defaultNamespace?: string | null`；直接构造 context 的测试也要显式给定默认 namespace。第二期负责正确填充嵌套查询可见关系；第三期不把父作用域的非相关表误当为 JOIN 左侧。

第三期扩展 `SqlCompletionContext.join` 为 `{leftRelationIds: string[]; rightRelationId: string; conditionState: 'empty' | 'prefix' | 'expression'}`。第三期的 tokenizer/parser 任务识别：`ON` 后只有空白是 `empty`，只输入一个尚未成句的补全前缀是 `prefix`，已经出现标识符链、比较/逻辑操作符、函数调用、括号表达式或完整条件是 `expression`。只有前两种显示关系候选。`excludedColumns` 专用于 `SET`/`INSERT` 字段去重，不能用来判断 `ON` 是否已有表达式。

`RelationSymbol.name/namespace/alias` 为解码后的标识符文本，保留原始大小写且不含引用符；一期补充 `nameQuoted?: boolean`、`namespaceQuoted?: boolean`、`aliasQuoted?: boolean`，`ColumnSymbol` 补充 `quoted?: boolean`。第三期解析名称时先按方言和 `*Quoted` 规则找精确实体，再对大小写规则未知的数据库仅允许**唯一**的 case-fold 命中。PG 未引用标识符折叠为小写；带双引号的精确匹配。MySQL 的 `lower_case_table_names` 和 SQL Server 的 collation 未取得时，大小写有多个可能实体即拒绝推荐。生成 SQL 的**关系限定符**使用一期 `quoteSqlReference(name, quoted, dialect)`，先解析 SQL 中的未引用名称（例如 PG `O` 为 `o`）再引用；元数据中的列名已经是 catalog 名称，直接使用 `quoteIdentifier`，不再次折叠或二次引用原始符号。

第三期定义 `SqlCompletionForeignKey`，与表详情页现有带 `direction` 的 `ForeignKeyInfo` 分离：外键快照中的约束有唯一身份和固定的子表→父表方向，不存在“相对当前表”的 `incoming/outgoing`。建议字段为 `id: string`（带 namespace 的稳定约束身份）、`constraintName: string`、`tableNamespace: string`、`tableName: string`、`columns: string[]`、`referencedNamespace: string`、`referencedTable: string`、`referencedColumns: string[]`。Rust 使用 snake_case 序列化时，TS 接口选择同一套命名或在 API 边界一次映射；不得在算法层混用。约束身份至少包含子表 namespace、子表名和 constraint 名；SQLite 用子表名与 pragma `id`。列数组非空且等长才可进入候选。跨 namespace 外键属于当前快照，只要子表或父表位于请求的 namespace。

批量端点：`get_sql_completion_foreign_keys(conn_id: String, database: Option<String>) -> Result<SqlCompletionForeignKeyResult, String>`；返回 `{status: 'ready', foreignKeys: [...]}` 或 `{status: 'unsupported', foreignKeys: []}`。Rust DTO 使用 `#[serde(rename_all = "camelCase")]` 对齐 TS。`database` 空时返回 `ready` 空数组，不扫描整个服务器。连接错误仍返回错误；前端把此类失败当作本轮“关系不可用”，维持普通补全。`database` 在 MySQL/ClickHouse 表示库，在 PG/SQL Server 表示 schema，在 SQLite 表示 attached database（常见 `main`）；只读取该 namespace 邻接的外键。不支持跨多个不相邻 namespace 的隐式全局扫描。

纯函数签名固定为 `buildJoinCandidates(context: SqlCompletionContext, foreignKeys: SqlCompletionForeignKey[]): CompletionCandidate[]`。候选 `kind: 'relation'`，`label` 显示两侧关系别名及约束名，`detail` 注明 FK 来源、列对、子表/父表角色，`insertText` 是完整条件，例如 PostgreSQL 的 `"o"."customer_id" = "c"."id"` 或 `("o"."tenant_id" = "c"."tenant_id" AND "o"."customer_id" = "c"."id")`；`sortText` 包含稳定约束身份，不依赖返回顺序。别名优先于表名；无别名且同名自关联造成引用歧义时不推荐。自关联两别名时，同一 FK 可能有两个方向，分别产出候选，去重键为 `(constraintId, childRelationId, parentRelationId)`；仅当上下文另有可靠角色证据时才收敛方向。仅 `join.conditionState` 为 `empty`/`prefix` 且 `context.edit` 不跨越已输入条件时返回候选；`expression` 返回空数组。`ON` 空白处与正在键入候选前缀允许用户显式选中插入；从不自动改写已存在表达式。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| `src-tauri/src/models/types.rs` | 批量外键 DTO 与状态结果，不复用带 direction 的表详情 DTO |
| `src-tauri/src/commands/foreign_key.rs`、`src-tauri/src/lib.rs` | 新命令路由、MySQL 批量查询、Tauri 注册；保留现有单表接口 |
| `src-tauri/src/db/postgres_objects.rs` | PG 按 schema 的外键批量查询及复合列顺序 |
| `src-tauri/src/db/sqlite.rs` | SQLite 单次表值 pragma 查询与聚合 |
| `src-tauri/src/db/sqlserver_objects.rs` | SQL Server 按 schema 的批量 catalog 查询与聚合 |
| `src/types/index.ts`、`src/services/tauriCommands.ts` | 对应 TS DTO 与命令包装 |
| `src/utils/sqlCompletionForeignKeyCache.ts` | 使用一期 `SqlCompletionCacheKey` 的外键快照、请求去重和失效 |
| `src/utils/sqlCompletionTypes.ts`、`src/utils/sqlCompletionContext.ts`、`src/utils/sqlCompletionScopes.ts` | `ON` 条件输入状态、上下文扩展，以及嵌套块作用域重算后的状态传递 |
| `src/utils/sqlCompletionJoin.ts` | 纯关系匹配、歧义处理、条件文本和候选排序 |
| `src/utils/sqlCompletion.ts`、`src/components/sql/SqlEditor.tsx` | 将 JOIN 关系候选合并到一期候选流水线，守卫异步会话 |
| `src/components/foreignKey/ForeignKeyList.tsx` | 用户变更外键成功后通知共享元数据失效 |

### 任务 1：定义批量外键契约与前端包装

**文件：** 修改 `src-tauri/src/models/types.rs`、`src/types/index.ts`、`src/services/tauriCommands.ts`；测试 `src/__tests__/foreignKeyAndRoutineCommands.test.ts` 与 `src-tauri/src/models/types.rs` 的 DTO 序列化测试。本任务不注册 Rust 命令。

**接口：** 输入 `connId` 与选中 `database: string | null`；输出 TS `getSqlCompletionForeignKeys(connId, database): Promise<SqlCompletionForeignKeyResult>` 及对应 Rust DTO。将新 DTO 与 `ForeignKeyInfo` 分开，命令路由待任务 6 在四种适配器完成后接入。

- [ ] 写 TS 命令测试：`getSqlCompletionForeignKeys('cid', 'public')` 调用 `invoke('get_sql_completion_foreign_keys', {connId:'cid', database:'public'})`；ClickHouse 的 `unsupported` 结果可原样返回。

  ```ts
  vi.mocked(invoke).mockResolvedValue({ status: 'ready', foreignKeys: [] });
  expect(await api.getSqlCompletionForeignKeys('cid', 'public')).toEqual({
    status: 'ready', foreignKeys: [],
  });
  expect(invoke).toHaveBeenCalledWith('get_sql_completion_foreign_keys', {
    connId: 'cid', database: 'public',
  });
  ```

- [ ] 运行 `npm test -- src/__tests__/foreignKeyAndRoutineCommands.test.ts`，预期新增测试因 API 不存在而失败。
- [ ] 添加 Rust/TS DTO；Rust 结果用 `#[serde(rename_all = "camelCase")]` 或显式转换统一字段，不改变 `ForeignKeyInfo` 现有 JSON。模型核心形状：

  ```ts
  export interface SqlCompletionForeignKey {
    id: string;
    constraintName: string;
    tableNamespace: string;
    tableName: string;
    columns: string[];
    referencedNamespace: string;
    referencedTable: string;
    referencedColumns: string[];
  }
  export type SqlCompletionForeignKeyResult =
    | { status: 'ready'; foreignKeys: SqlCompletionForeignKey[] }
    | { status: 'unsupported'; foreignKeys: [] };
  ```

- [ ] 为 Rust DTO 写序列化测试，断言 JSON 使用 `foreignKeys`、`constraintName` 等 camelCase 字段，`ForeignKeyInfo` 旧格式保持不变。
- [ ] 运行 `npm test -- src/__tests__/foreignKeyAndRoutineCommands.test.ts`、`cargo test --manifest-path src-tauri/Cargo.toml sql_completion_foreign_key_dto`，预期通过。此时运行时命令尚未注册，由任务 6 收口。

### 任务 2：MySQL 与 PostgreSQL 一次读取关系集

**文件：** 修改 `src-tauri/src/commands/foreign_key.rs`、`src-tauri/src/db/postgres_objects.rs`；测试模块置于对应 Rust 文件；保留现有表详情 `list_foreign_keys`。

**接口：** 输出 `list_sql_completion_foreign_keys(pool, namespace) -> Result<Vec<SqlCompletionForeignKey>, String>` 方言实现，供任务 6 命令调用。每次请求仅一条 catalog 查询，内存中按约束聚合并排序。

- [ ] 先写聚合纯函数测试：打乱行顺序的 `(constraint, ordinal, childCol, parentCol)` 能输出顺序相同的两数组；同一 schema 中不同子表上同名约束不会合并；跨 schema 的 `sales.orders -> auth.users` 被请求 `sales` 时返回且保留两个 namespace；列缺失的约束不输出。
- [ ] 运行 `cargo test --manifest-path src-tauri/Cargo.toml sql_completion_foreign_keys`，预期新测试失败。
- [ ] MySQL 查询以 `information_schema.KEY_COLUMN_USAGE kcu` 连接 `REFERENTIAL_CONSTRAINTS rc`，限制 `kcu.REFERENCED_TABLE_NAME IS NOT NULL AND (kcu.TABLE_SCHEMA = :schema OR kcu.REFERENCED_TABLE_SCHEMA = :schema)`；连接键包含 `CONSTRAINT_SCHEMA`、`CONSTRAINT_NAME`、`TABLE_NAME`，防止同名约束串行；按 `ORDINAL_POSITION` 聚合。`REFERENCED_COLUMN_NAME` 为空时丢弃该整条约束，不猜测主键。复用 `mysql_async::exec` 参数绑定，不拼接用户输入。

  ```sql
  SELECT kcu.CONSTRAINT_SCHEMA, kcu.CONSTRAINT_NAME,
         kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME,
         kcu.ORDINAL_POSITION, kcu.REFERENCED_TABLE_SCHEMA,
         kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME
    FROM information_schema.KEY_COLUMN_USAGE AS kcu
    JOIN information_schema.REFERENTIAL_CONSTRAINTS AS rc
      ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
     AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
     AND rc.TABLE_NAME = kcu.TABLE_NAME
   WHERE kcu.REFERENCED_TABLE_NAME IS NOT NULL
     AND (kcu.TABLE_SCHEMA = :schema OR kcu.REFERENCED_TABLE_SCHEMA = :schema)
   ORDER BY kcu.CONSTRAINT_SCHEMA, kcu.TABLE_SCHEMA,
            kcu.TABLE_NAME, kcu.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
  ```

- [ ] PostgreSQL 查询复用现有 `pg_catalog.pg_constraint`、`pg_class`、`pg_namespace` 关系，筛选 `contype='f' AND (child_schema=$1 OR parent_schema=$1)`；`conkey` 和 `confkey` 以 `WITH ORDINALITY` 相同下标配对，或者分别取有序数组后验证长度一致。唯一身份用 `con.oid` 或完整子表 namespace+表名+约束名；为分区继承约束去重时只保留同一真实约束，不吞掉不同列映射。

  ```sql
  -- 核心配对；表和命名空间 JOIN 复用现有单表查询。
  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS child(attnum, ord) ON true
  JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS parent(attnum, ord)
    ON parent.ord = child.ord
  WHERE con.contype = 'f'
    AND (child_ns.nspname = $1 OR parent_ns.nspname = $1)
  ORDER BY con.oid, child.ord
  ```

- [ ] 增加 PG 大小写与跨 schema 测试：`"Orders"` 与 `orders` 在 DTO 中保持大小写；`sales.orders -> auth.users` 两端 namespace 不丢失。运行上述 Rust 测试，预期通过。可用现有测试连接时再加数据库集成测试；纯聚合测试为必需门槛。

### 任务 3：SQLite 与 SQL Server 批量路径

**文件：** 修改 `src-tauri/src/db/sqlite.rs`、`src-tauri/src/db/sqlserver_objects.rs`；测试模块位于同文件。

**接口：** 各导出 `list_sql_completion_foreign_keys(pool, namespace) -> Result<Vec<SqlCompletionForeignKey>, String>`，供任务 6 命令分派。仅查询选中 SQLite attached database 或 SQL Server schema 及其相邻约束。

- [ ] SQLite 先写真实内存库测试：建 `users` 与带复合外键的 `orders`，再建自关联 `employees(manager_id)`；单次批量调用返回两条约束、复合列序正确，且 `main` 与另一个 attached database 同名表不混淆。空库返回空数组。
- [ ] 运行 `cargo test --manifest-path src-tauri/Cargo.toml sql_completion_foreign_keys`，预期 SQLite 新测试失败。
- [ ] SQLite 复用 `list_foreign_keys_on_conn` 的表值函数思路，执行一条查询：`FROM <quoted-db>.sqlite_schema AS m JOIN pragma_foreign_key_list(m.name, ?1) AS fk`，`m.type='table'` 且排除 `sqlite_%`；在 Rust 内存以 `(database, m.name, fk.id)` 聚合、按 `fk.seq` 配对子/父列。`fk."to"` 为空（隐式引用父表主键）时，在本期不猜测并跳过该约束；补文档和测试说明。`database` 先经 `validate_sqlite_object_name` 再用 `sqlite_id` 引用，pragma 的 schema 参数绑定。

  ```sql
  SELECT m.name AS table_name, fk.id, fk.seq,
         fk."table" AS referenced_table, fk."from" AS child_column,
         fk."to" AS parent_column
    FROM "main".sqlite_schema AS m
    JOIN pragma_foreign_key_list(m.name, ?1) AS fk
   WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%'
   ORDER BY m.name, fk.id, fk.seq
  ```

- [ ] SQL Server 先写聚合测试：两个 schema 里同名表/约束不合并，`constraint_column_id` 顺序保留，`dbo.orders -> crm.customers` 在 `dbo` 请求中出现；catalog 行缺列时拒绝整条约束。
- [ ] SQL Server 查询复用 `sys.foreign_keys` + `sys.foreign_key_columns` + `sys.tables/sys.schemas/sys.columns`，筛选 `(cs.name = <quoted literal> OR rs.name = <quoted literal>)`，按 `fk.object_id, fkc.constraint_column_id` 排序；使用现有 `n_str` 生成安全的 Unicode 字符串字面量。按 `fk.object_id` 聚合，而非单独按名字。运行 `cargo test --manifest-path src-tauri/Cargo.toml sql_completion_foreign_keys`，预期通过。

### 任务 4：前端缓存与异步失效

**文件：** 新增 `src/utils/sqlCompletionForeignKeyCache.ts`、`src/__tests__/sqlCompletionForeignKeyCache.test.ts`；修改 `src/components/sql/SqlEditor.tsx`。

**接口：** 输入第一期 `SqlCompletionCacheKey {connId; database; dialect; connectionRevision}` 与 `src/utils/sqlCompletionInvalidation.ts` 的 `subscribeSqlCompletionInvalidation` / `getSqlCompletionConnectionRevision`。输出 `createSqlCompletionForeignKeyCache(source, now?)`，其 `{get(key), peek(key), invalidate(event)}` 与一期缓存同形；`source` 只需 `getSqlCompletionForeignKeys(connId, database)`。TTL 60 秒，最多 8 个已完成条目，按最近使用顺序淘汰。

- [ ] 写失败测试：相同键并发调用只触发一次 API；不同库和 revision 各发一次；失效后旧 Promise 完成不写新缓存；59 秒命中、60 秒过期，9 个 namespace 淘汰最久未使用项；`unsupported` 可缓存但不生候选；被拒绝的请求不缓存为 ready，稍后可重试。测试使用注入时钟和手动控制 Promise，无定时等待。

  ```ts
  const key = {
    connId: 'c1', database: 'public', dialect: 'postgres' as const,
    connectionRevision: 0,
  };
  let resolve!: (value: SqlCompletionForeignKeyResult) => void;
  const pending = new Promise<SqlCompletionForeignKeyResult>((r) => { resolve = r; });
  source.getSqlCompletionForeignKeys
    .mockReturnValueOnce(pending)
    .mockResolvedValue({ status: 'ready', foreignKeys: [] });
  const cache = createSqlCompletionForeignKeyCache(source, () => 0);
  const first = cache.get(key);
  const second = cache.get(key);
  expect(source.getSqlCompletionForeignKeys).toHaveBeenCalledTimes(1);
  cache.invalidate({
    connId: 'c1', database: 'public', reason: 'schema-change',
  });
  resolve({ status: 'ready', foreignKeys: [] });
  await Promise.all([first, second]);
  await cache.get(key);
  expect(source.getSqlCompletionForeignKeys).toHaveBeenCalledTimes(2);
  ```

- [ ] 运行 `npm test -- src/__tests__/sqlCompletionForeignKeyCache.test.ts`，预期因模块不存在而失败。
- [ ] 实现按键 `Map` 的结果与 in-flight 请求去重，键包含全部四字段；每次加载记录代数，失效时增代数并删除缓存。只在代数和键一致时保存结果；成功项 60 秒过期、最多 8 项 LRU，淘汰不得让仍在途的旧请求回写；连接切换清理旧 key，不能把 `[]` 与“无权限”混成同一永久成功状态。
- [ ] 订阅 `subscribeSqlCompletionInvalidation`：`refresh` 的 `database` 是具体字符串时清对应 namespace，`null` 只清库列表键，`undefined` 清该连接所有键；`disconnect` 清该连接所有键且一期提升 revision。外键快照包含跨 schema 的入向关系，因此 `schema-change` 在本缓存中保守扩大为该连接所有外键条目失效，避免其他 namespace 继续推荐已删除约束；一期表列缓存仍沿用其原有局部失效规则。只清内存，不遍历命名空间发查询。外键缓存不另起独立 revision，使用 `getSqlCompletionConnectionRevision(connId)` 构造 key；每个受影响 key 增代数以拒绝旧结果。
- [ ] 编辑器在一期表列缓存加载点旁使用同一 key 和失效信号；加载失败时仅禁用关系项，不使普通补全报错。没有库/schema 时不请求外键。组件卸载或活动连接、库、tab 改变后，旧 Promise 不能写当前 `foreignKeysRef`。
- [ ] 运行上述 Vitest 与 `npm run build`，预期通过。

### 任务 5：ON 状态解析与真实 FK 匹配

**文件：** 新增 `src/utils/sqlCompletionJoin.ts`、`src/__tests__/sqlCompletionJoin.test.ts`；修改 `src/utils/sqlCompletionTypes.ts`、`src/utils/sqlCompletionContext.ts`、`src/utils/sqlCompletionScopes.ts`、`src/__tests__/sqlCompletionContext.test.ts`、`src/__tests__/sqlCompletionScopes.test.ts`；使用 `src/utils/sqlCompletion.ts` 中的 `quoteSqlReference` 与 `quoteIdentifier`。

**接口：** 输出 `buildJoinCandidates(context: SqlCompletionContext, foreignKeys: SqlCompletionForeignKey[]): CompletionCandidate[]`。输入 `context.join.leftRelationIds/rightRelationId` 是 relation **实例** ID；`conditionState` 由分析器按 `ON` 后 token 范围判定，不凭表名推断 JOIN 顺序。

- [ ] 先写分析器失败测试：`JOIN customers c ON |` 返回 `conditionState: 'empty'`；`ON cus|` 返回 `prefix`；`ON o.customer_id = c.id|`、`ON (o.id|` 和 `ON o.id AND |` 返回 `expression`；把状态新增到 `context.join`，在分析器读取同一条语句的 token 范围判断，不以 `excludedColumns` 判断。
- [ ] 写二期作用域回归测试：外层 `JOIN ... ON x = y` 的内部子查询另有 `JOIN ... ON |` 时，`resolveSqlCompletionScopes` 重新赋予内层 `join.leftRelationIds/rightRelationId` 和 `conditionState:'empty'`；光标回到外层完整条件时为 `expression`。二期 resolve 若重建 `context.join`，必须同步重算 `conditionState`，不能沿用一期外层状态。
- [ ] 写匹配失败测试：`orders o JOIN customers c ON ` 得 `"o"."customer_id" = "c"."id"`；反向 FK 仍得到同一 SQL；一条双列 FK 得带括号且按 ordinal 配对的 `AND` 条件；同两表两条 FK 得两项，`detail` 区分约束名。

  ```ts
  const fk: SqlCompletionForeignKey = {
    id: 'sales.orders/fk_customer', constraintName: 'fk_customer',
    tableNamespace: 'sales', tableName: 'orders',
    columns: ['customer_id'], referencedNamespace: 'sales',
    referencedTable: 'customers', referencedColumns: ['id'],
  };
  const context = {
    dialect: 'postgres', defaultNamespace: 'sales',
    statement: { start: 0, end: 38 },
    scopeId: 'q1', clause: 'on', slot: 'joinCondition',
    prefix: '', qualifierParts: [], edit: { start: 38, end: 38 },
    scopes: [{
      id: 'q1', parentId: undefined, canCorrelate: false, projections: [],
      relations: [
        { id: 'r1', kind: 'table', name: 'orders', alias: 'o', namespace: 'sales' },
        { id: 'r2', kind: 'table', name: 'customers', alias: 'c', namespace: 'sales' },
      ],
    }],
    confidence: 'high',
    join: { leftRelationIds: ['r1'], rightRelationId: 'r2', conditionState: 'empty' },
    excludedColumns: [],
  } satisfies SqlCompletionContext;
  expect(buildJoinCandidates(context, [fk])[0].insertText)
    .toBe('"o"."customer_id" = "c"."id"');
  ```

- [ ] 加入审查重点测试：`employees e JOIN employees m` 对 `manager_id -> id` 的同一 FK 得 `"e"."manager_id" = "m"."id"` 与 `"m"."manager_id" = "e"."id"` 两项，详情分别标注子表别名；无别名自关联时不推荐；`sales.orders` 与 `archive.orders` 不能互换；PG `"Orders"` 与未引用 `orders` 各匹配对应表；MySQL/SQL Server 不确定大小写规则且出现多个 case-fold 命中时返回空数组。
- [ ] 加入 PG 别名引用测试：`FROM orders O JOIN customers C ON `，`aliasQuoted` 为 false 时插入 `"o"."customer_id" = "c"."id"`；改成 `"O"` 与 `"C"` 且 `aliasQuoted` 为 true 时插入 `"O"."customer_id" = "C"."id"`。列名如 catalog 的 `"CustomerID"` 保持大小写。
- [ ] 加入拒绝测试：CTE/derived、未知 relation ID、低置信度、`slot !== 'joinCondition'`、`conditionState: 'expression'`、列数组长度不等、元数据中同一完全限定名仍有多个实体时均为 `[]`。`excludedColumns` 在 JOIN 测试中非空也不影响真实 FK 候选。`ON` 左侧含多张表时只为与右侧有真实 FK 的左表产出候选，并用 `(约束 ID, 子 relation ID, 父 relation ID)` 稳定去重排序。
- [ ] 运行 `npm test -- src/__tests__/sqlCompletionContext.test.ts src/__tests__/sqlCompletionScopes.test.ts src/__tests__/sqlCompletionJoin.test.ts`，预期新测试失败。
- [ ] 实现两阶段解析：先用当前 `scopeId` 找可见 relation ID，取 `kind==='table'` 的 JOIN 左右实例；依据 dialect 与 `*Quoted` 规则解析 namespace/name。无显式 namespace 时使用 `context.defaultNamespace`；若缺失，只有 catalog 唯一命中才可继续，且不能跨两个 namespace 作同名猜测。对每个 FK 双向比较完整 `(namespace, table)` 对；同一个关系实例不得匹配自身。

  ```ts
  // 关键谓词示意：每个 relation ID 只指向一个作用域内的实例。
  const left = scope.relations.find((r) => r.id === leftId);
  const right = scope.relations.find((r) => r.id === rightId);
  if (!left || !right || left.id === right.id ||
      left.kind !== 'table' || right.kind !== 'table') return [];
  // resolveBaseTable 必须返回完整 namespace + table，歧义返回 null。
  ```

- [ ] 使用 `alias ?? name` 生成两侧限定符：别名传 `quoteSqlReference(alias, aliasQuoted ?? false, dialect)`；无别名表名传 `quoteSqlReference(name, nameQuoted ?? false, dialect)` 或使用已经绑定的 catalog 名称再 `quoteIdentifier`。子列和父列来自 catalog，分别 `quoteIdentifier(column,dialect)`，不得再按 SQL 未引用规则折叠。避免已输入条件被替换，只按 `context.edit` 覆盖当前词。自关联同时尝试两种子表/父表实例指派；普通双表若 FK 子表在 JOIN 右侧则保持 SQL 左右可读顺序但列配对不变。构造完整 `CompletionCandidate` 的 `label/filterText/insertText/detail/sortText/kind`，`sortText` 前缀确保真实关系项优先于一般列项并保留稳定的角色排序。
- [ ] 运行 `npm test -- src/__tests__/sqlCompletionContext.test.ts src/__tests__/sqlCompletionScopes.test.ts src/__tests__/sqlCompletionJoin.test.ts` 与 `npm run build`，预期通过。

### 任务 6：注册命令并接入 Monaco 候选流水线

**文件：** 修改 `src-tauri/src/commands/foreign_key.rs`、`src-tauri/src/lib.rs`、`src/utils/sqlCompletion.ts`、`src/components/sql/SqlEditor.tsx`、`src/components/foreignKey/ForeignKeyList.tsx`；新增 `src/__tests__/sqlCompletionJoinProvider.test.ts`，修改 `src/__tests__/ForeignKeyListDiagram.test.tsx` 中的 API 模拟。

**接口：** 输入四种方言的 `list_sql_completion_foreign_keys`、`buildJoinCandidates` 与 `createSqlCompletionForeignKeyCache`；输出 Tauri 命令 `get_sql_completion_foreign_keys`。在一期 `SqlCompletionContext` 候选过滤之后合并 `CompletionCandidate`，交给现有 Monaco 映射。保留现有单表外键 UI。

- [ ] 先写 provider 测试：高置信度 JOIN 条件且快照 ready 时关系项进入建议，`range` 对应 `context.edit`；在普通 `WHERE`、无 FK、unsupported 或 API 拒绝时仍得到原有列/关键词建议；过期补全请求完成后不显示旧关系；按键选择关系项才插入条件，不触发 model 文本自动修改。
- [ ] 运行 `npm test -- src/__tests__/sqlCompletionJoinProvider.test.ts`，预期失败。
- [ ] 在 Rust 新命令中对库/schema 为空返回 ready 空数组；按 `DatabasePoolHandle` 分派任务 2、3 的四个批量实现，ClickHouse 返回 unsupported。注册 `src-tauri/src/lib.rs`；不得调用单表 `list_foreign_keys` 拼列表。运行 `cargo check --manifest-path src-tauri/Cargo.toml`，预期通过。
- [ ] 在一期 provider 的上下文解析与候选构建路径中调用纯函数，依据 `context.edit` 转换 Monaco 的 1-based range；保留一期已有 `CancellationToken`/请求序号守卫，必要时补 `model.getVersionId()`、活动连接 key 与 tab 身份校验。provider 只读取匹配 `binding.key` 的外键快照，缺失或 unsupported 时传空列表；API 预取由编辑器在 key 变化、TTL 到期或失效后触发，不在候选循环内发请求。
- [ ] `SqlEditor` 启动预取时每个选中库/schema 只调用一次批量端点；连库切换、schema 切换、DDL 后一期失效信号和编辑器关闭均清理旧数据。`ForeignKeyList.tsx` 中 `addForeignKey`、`dropForeignKey` 成功后调用 `invalidateSqlCompletion({connId, reason:'schema-change'})`，使该连接的外键快照失效，覆盖跨 schema 约束的入向、出向缓存；仅当前活跃编辑器按需重载，不遍历所有命名空间查询。其对应测试断言成功时触发、失败时不触发，并验证修改 `sales → auth` 外键后两个已缓存 schema 均失效。
- [ ] 运行 `npm test -- src/__tests__/sqlCompletionJoinProvider.test.ts src/__tests__/sqlCompletionJoin.test.ts src/__tests__/sqlCompletionForeignKeyCache.test.ts`、`npm run build`、`npm run lint`、`cargo test --manifest-path src-tauri/Cargo.toml sql_completion_foreign_keys`，预期全部通过；若已有无关 lint 错误，记录其位置并确认新增文件无错误。
- [ ] 手工验收五个 SQL：单列 FK、复合 FK、自关联别名、双 FK、CTE JOIN；确认仅显式选择建议才替换前缀，既有 `ON` 保持原样，ClickHouse 和无权限账户仍可使用普通补全。

## 验收与风险

- Rust 四种关系型数据库均通过一个按库/schema 批量端点拿到约束；测试证明没有按表查询，也没有将另一 schema 的同名约束混入。
- TS 测试覆盖候选出现、歧义拒绝、异步过期、权限失败降级；`npm run build` 与相关 Rust 测试通过。
- SQLite 隐式 `REFERENCES parent` 无明确 `to` 列时不推荐；后续若需要支持，应在同一次批量查询中联结主键信息或增加另一条固定批量查询，并写配对测试，不可逐表查 PRAGMA。
- MySQL/SQL Server 的大小写行为依服务器设置；无可靠设置且候选不唯一时宁可缺少建议。复杂表达式或不完整 SQL 令解析置信度下降时同理。
- 当前库/schema 之外、与选中 namespace 不邻接的 FK 不在快照中。跨库 JOIN 的更完整覆盖需要另设按一组 namespace 批量查询接口，不能靠循环调用当前 API。
