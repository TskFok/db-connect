# SQL 智能补全第一期：上下文与别名补全实施计划

> **执行约定：** 使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 按任务实施，使用复选框记录进度。本文件已实施；验证结果与已知基线问题见文末“实施记录”。

**目标：** SQL 中出现表名后，让补全围绕当前语句、查询块、表别名及子句位置提供准确候选，并正确插入标识符。

**架构：** 保留 Monaco 编辑器和现有按数据库/schema 批量加载的元数据接口，新增容错分词、上下文分析与候选生成三个纯计算环节。元数据使用共享缓存与失效信号；编辑器负责模型绑定、取消和替换范围转换。

**技术栈：** TypeScript、React、Monaco Editor、Zustand、Vitest；沿用现有 Tauri 元数据接口，第一期不新增 SQL 解析依赖或后端查询。

**设计依据：** 本次对话确定的三期方案，具体约定以本文件“设计约定”和“共享接口”为准，无额外独立 spec 文件。

**阶段依赖：** 本期为起点；后续为[第二期：复杂查询作用域](./2026-09-23-sql-completion-phase-2-query-scopes.md)和[第三期：JOIN 条件推荐](./2026-09-23-sql-completion-phase-3-join-recommendations.md)。

## 全局约束

- 始终使用简体中文沟通；提交采用英文 type、中文描述，例如 `feat: 支持 SQL 上下文补全`。
- 默认在当前分支修改；没有用户明确要求，不创建分支或工作树。
- 禁止在循环遍历中查询 SQL，包括以 `Promise.all(tables.map(...))` 包装的逐表查询。
- 补全不得执行用户正在编辑的 SQL，不扫描业务数据，不调用生成式模型。
- 支持现有 `mysql`、`postgres`、`sqlite`、`sqlserver`、`clickhouse` 五种方言；未支持的复杂语法保守降级，不宣称完整 SQL 语义支持。
- 先限定可见候选，再排序；字符串、注释、未知限定符处不回退为全库字段。
- 测试先验证行为缺失，再实现并回归。测试和界面验证结果见文末实施记录；不得仅凭计划文本宣称通过验收。

## 设计约定

### 当前实现与变更边界

- `src/utils/sqlCompletion.ts`：当前 `registerSqlCompletionProvider` 只取单词，`buildSqlSuggestions` 混合返回关键词、表和全部字段；保留方言关键词和 `quoteIdentifier`，替换候选生成路径。
- `src/utils/sqlCompletionSchema.ts`：已调用一次 `getSqlCompletionMetadata` 获取批量结果，继续复用，不改成逐表 `getTableStructure`。
- `src/components/sql/SqlEditor.tsx`：当前组件内 `schemaRef` 随连接与库变化加载；迁移共享缓存，消除切换期间读旧库和旧请求失败清空新结果的风险。
- `src/utils/sqlUtils.ts::splitSqlStatements` 返回去除空白后的字符串，不保留偏移，不能直接用于光标定位。本期不改 SQL 执行的分句行为。

### 首期能力与明确边界

| 输入，`|` 为光标 | 候选与插入规则 |
| --- | --- |
| `SELECT * FROM |` | 当前命名空间表/视图和可用库/schema，不给字段 |
| `SELECT * FROM users u |` | 合法后续子句；允许 `AS`，不把字段放在关系声明位置 |
| `SELECT * FROM users u WHERE |` | users 字段、适用函数和表达式关键词 |
| `SELECT * FROM users u WHERE u.na|` | 只提供 users 匹配字段，仅替换 `na`，保留已有 `u.` |
| `SELECT | FROM users u` | 从光标之后的同一查询块识别 users |
| `SELECT * FROM users u JOIN orders o ON |` | 两侧当前可见关系的字段，首期不生成关联等式 |
| `UPDATE users SET |` | users 字段；已赋值字段不重复推荐为赋值左侧 |
| `INSERT INTO users (|)` | users 字段；排除当前列列表中已经写出的字段 |
| `SELECT * FROM users; SELECT * FROM orders WHERE |` | 只使用第二条语句中的 orders |

普通 SELECT、JOIN/ON、WHERE、GROUP BY、HAVING、ORDER BY、UPDATE/SET、DELETE/WHERE、INSERT 列列表进入首期。必须区别 `SET` 左侧字段和右侧表达式，也区别 `WHERE id |` 的运算符位置与 `WHERE |` 的表达式起点。运算符等可复用 `keyword` 槽位输出适用候选，不把完整关键词表全量展示。

子查询首期识别边界和内部基础表，禁止把内层基础表泄漏到外层；CTE、派生表输出、相关外部引用及投影别名解析在第二期实现。未解析的派生关系不映射为同名物理表。`db.table`/`schema.table` 只在限定符与当前元数据 key 匹配时解析列；其他命名空间只提示已知名称，不自动扫描其他库。SQL Server 三段名和 ClickHouse 复杂表函数无法可靠解析时降级。

### 共享接口

新增 `src/utils/sqlCompletionTypes.ts`。`SqlDialect` 和 `SqlSchema` 暂由 `sqlCompletion.ts` 导出，其他模块仅通过 `import type` 引用，避免运行时循环依赖。所有偏移均为 UTF-16 的 `[start, end)`，与 Monaco offset 一致。

```ts
export type SqlClause =
  | "select" | "from" | "join" | "on" | "where" | "groupBy"
  | "having" | "orderBy" | "update" | "set" | "insertInto"
  | "insertColumns" | "values" | "delete" | "unknown";
export interface SqlToken {
  kind: "keyword" | "identifier" | "string" | "comment" |
    "number" | "punctuation" | "operator";
  text: string; start: number; end: number; quoted: boolean;
}
export interface ColumnSymbol {
  name: string; type?: string; quoted?: boolean;
  source?: { relationId: string; column: string };
}
export interface RelationSymbol {
  id: string; kind: "table" | "cte" | "derived";
  name: string; alias?: string; namespace?: string;
  nameQuoted?: boolean; namespaceQuoted?: boolean; aliasQuoted?: boolean;
  outputColumns?: ColumnSymbol[];
}
export interface QueryScope {
  id: string; parentId?: string; relations: RelationSymbol[];
  projections: ColumnSymbol[]; canCorrelate: boolean;
}
export interface SqlCompletionContext {
  dialect: SqlDialect; defaultNamespace?: string | null;
  statement: { start: number; end: number };
  scopeId: string; clause: SqlClause;
  slot: "table" | "column" | "continuation" | "joinCondition" |
    "columnList" | "keyword" | "none";
  prefix: string; qualifierParts: string[]; qualifierQuoted?: boolean[];
  edit: { start: number; end: number }; scopes: QueryScope[];
  confidence: "high" | "partial" | "unknown";
  join?: { leftRelationIds: string[]; rightRelationId: string };
  excludedColumns: string[];
}
export interface CompletionCandidate {
  label: string; filterText: string; insertText: string;
  detail?: string; sortText: string;
  kind: "table" | "column" | "keyword" | "function" | "relation";
  documentation?: string;
}
export interface SqlCompletionCacheKey {
  connId: string; database: string | null; dialect: SqlDialect;
  connectionRevision: number;
}
export interface SqlMetadataIndex {
  key: SqlCompletionCacheKey; schema: SqlSchema;
  tablesByName: Map<string, { name: string }>;
  columnsByTable: Map<string, SqlSchema["columns"]>;
}
```

`SqlToken.text` 为原始 token 文本；`RelationSymbol` 和 `qualifierParts` 存去除引用符并解码后的文本、保留大小写，引用状态另存。`ColumnSymbol.name` 对 catalog 列保留真实名称，对 SQL 定义的投影别名存按方言解析后的实际输出名。关系 `id` 使用查询块与声明位置标识，不能用物理表名代替，保证自关联中两个别名独立。`defaultNamespace` 在 provider 中由 `binding.key.database` 注入，不要求纯分析函数访问连接状态；第二、三期的实体绑定复用此默认命名空间。

元数据索引保留精确名称键。名称绑定与输入前缀匹配分别实现：PostgreSQL 未引用名称按方言折叠；引用名称按其方言规则解析。MySQL 大小写配置、SQL Server 排序规则未提供时，先精确匹配，大小写不敏感回退仅接受唯一命中；碰到歧义不得合并两张表。禁止把所有名称统一小写后覆盖原对象。

SQL 文本中的名称与 catalog 名称在生成引用时也要区分。`FROM users U` 在 PostgreSQL 中定义的是 `u`，不能将原文 `U` 直接变成 `"U"`。在 `sqlCompletion.ts` 新增 `quoteSqlReference(name: string, quoted: boolean, dialect: SqlDialect): string`：对已解析的 SQL 引用先按方言解析语义名，再调用 `quoteIdentifier`；PostgreSQL 未引用名称的小写折叠按其标识符规则处理，不对未知 Unicode 大小写规则进行猜测。已经来自 catalog 的真实列名直接使用 `quoteIdentifier`，不再折叠；投影输出名在推导时保存其实际语义名。

## 审查重点

1. 引号、注释、PostgreSQL dollar quote 中的分号不切断语句；未闭合标识符仍可补全。归属任务 1、5。
2. 光标回到 SELECT 列表时仍能读取后面的 FROM；括号不代表所有类型子查询都可以引用外层。归属任务 2。
3. 同名字段、多别名自关联、带引号大小写名称不能错误去重或重复插入前缀。归属任务 3。
4. A 库慢请求晚于 B 库完成或失败、断线后相同连接标识重用，均不污染当前候选。归属任务 4、5。
5. 多编辑器同时存活、连续输入、候选列表自动刷新不串模型，不产生每键一次网络请求。归属任务 5、6。

## 任务 1：保留偏移的容错分词与语句定位

**文件：** 新增 `src/utils/sqlCompletionTypes.ts`、`src/utils/sqlCompletionTokenizer.ts`、`src/__tests__/sqlCompletionTokenizer.test.ts`。

**接口：** 输出 `tokenizeSql(sql: string, dialect: SqlDialect): SqlToken[]`；`findSqlStatement(tokens: SqlToken[], offset: number, textLength: number): { start: number; end: number }`。

- [x] 定义上述共享类型。先写语句边界、引号转义、未闭合输入和 Unicode 偏移测试，核心断言如下。

```ts
const sql = "SELECT 'a;b'; SELECT * FROM users WHERE ";
const tokens = tokenizeSql(sql, "mysql");
expect(findSqlStatement(tokens, sql.length, sql.length)).toEqual({
  start: sql.indexOf(" SELECT *"), end: sql.length,
});
expect(tokenizeSql('SELECT "user;name" FROM users', "postgres")
  .filter(t => t.kind === "punctuation" && t.text === ";")).toHaveLength(0);
expect(tokenizeSql("SELECT $$a;b$$; SELECT 1", "postgres")
  .filter(t => t.kind === "punctuation" && t.text === ";")).toHaveLength(1);
```

- [x] 运行 `npm test -- src/__tests__/sqlCompletionTokenizer.test.ts`，确认因缺少实现或行为错误失败。
- [x] 按方言构建线性扫描器，保留空白对应的原始偏移；识别注释、单引号字符串、引用标识符、数字、符号和关键字。MySQL `--` 注释检查后续空白，`#` 仅在适用方言作为注释；SQL Server 方括号、PostgreSQL dollar quote 各有独立状态。
- [x] `findSqlStatement` 只按有效分号切分，分号之后至下个分号之间包含原始空白；光标恰在分号之后属于下一条语句。SQL Server 单独一行的 `GO` 作为批次边界处理，仅在字符串/注释外识别。未知会话模式如 MySQL `ANSI_QUOTES` 不擅自确认歧义文本的列绑定。
- [x] 补上 `'it''s'`、反引号转义、`[a]]b]`、CRLF、中文及 emoji、块注释、未闭合字符串/标识符、空文本测试并复跑。字符串和注释返回 `none`；未闭合引用标识符保留 partial token 供任务 5 修正范围。

## 任务 2：分析当前查询块、关系声明和子句槽位

**文件：** 新增 `src/utils/sqlCompletionContext.ts`、`src/__tests__/sqlCompletionContext.test.ts`。

**接口：** 消费任务 1 的 token；输出 `analyzeSqlCompletion(input: { sql: string; offset: number; dialect: SqlDialect }): SqlCompletionContext`。

- [x] 使用完整语句作为分析输入，先写“光标后 FROM”“AS/隐式别名”“多语句隔离”“内层基础表不泄漏”测试。

```ts
const sql = "SELECT  FROM users u";
const context = analyzeSqlCompletion({ sql, offset: 7, dialect: "mysql" });
expect(context.slot).toBe("column");
expect(context.scopes.find(s => s.id === context.scopeId)?.relations)
  .toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "table", name: "users", alias: "u" }),
  ]));
const nested = "SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM orders o) AND ";
const outer = analyzeSqlCompletion({ sql: nested, offset: nested.length, dialect: "mysql" });
expect(outer.scopes.find(s => s.id === outer.scopeId)?.relations.map(r => r.name))
  .toEqual(["users"]);
```

- [x] 运行 `npm test -- src/__tests__/sqlCompletionContext.test.ts` 确认失败，再实现查询块栈、FROM/JOIN/UPDATE/INSERT 目标关系和别名映射。先确定当前块，再扫描块内完整 token；跳过子块，不用“最近出现的 FROM”代替作用域。
- [x] 根据光标前 token 判断槽位；`WHERE`、`ON` 等是保留子句词，不作为隐式别名；支持逗号分隔 FROM 和多行 JOIN。`ON` 的 `join` 信息只包含当前已引入的关系，后面的 JOIN 不提前可见。
- [x] 对不完整 `u.`、`u.na`、引用名称和 `schema.table` 提取 prefix/qualifier/edit；本期 `canCorrelate` 默认为 false，复杂输出保持未知而非猜物理表。
- [x] 复跑测试，增加 UPDATE SET 等号两侧、INSERT 列表去重、注释夹在关键字间、同表双别名、未知表、跨命名空间、嵌套函数括号和 SQL Server GO 的断言。

## 任务 3：元数据索引、候选收敛和插入规则

**文件：** 新增 `src/utils/sqlCompletionMetadataIndex.ts`、`src/utils/sqlCompletionCandidates.ts`、`src/__tests__/sqlCompletionCandidates.test.ts`、`src/__tests__/fixtures/sqlCompletionFixtures.ts`；修改 `src/utils/sqlCompletion.ts`、`src/__tests__/sqlCompletion.test.ts`。

**接口：** `buildSqlMetadataIndex(schema: SqlSchema, key: SqlCompletionCacheKey): SqlMetadataIndex`；`generateSqlCompletionCandidates(context: SqlCompletionContext, index: SqlMetadataIndex): CompletionCandidate[]`。旧 `buildSqlSuggestions` 的调用点迁移到新上下文链路，方言关键词和引用函数的既有测试继续保留。

- [x] 新建共享 fixture，供三期测试复用，避免各测试假设不同元数据。

```ts
export const completionSchema: SqlSchema = {
  databases: ["app"], tables: [{ name: "users" }, { name: "orders" }],
  columns: [
    { table: "users", name: "id", type: "int" },
    { table: "users", name: "name", type: "varchar" },
    { table: "orders", name: "id", type: "int" },
    { table: "orders", name: "user_id", type: "int" },
  ],
};
export const completionKey: SqlCompletionCacheKey = {
  connId: "conn-1", database: "app", dialect: "mysql", connectionRevision: 0,
};
```

- [x] 写候选内容与接受结果测试，先运行 `npm test -- src/__tests__/sqlCompletionCandidates.test.ts` 确认失败。

```ts
const sql = "SELECT * FROM users u WHERE u.na";
const context = analyzeSqlCompletion({ sql, offset: sql.length, dialect: "mysql" });
const index = buildSqlMetadataIndex(completionSchema, completionKey);
const items = generateSqlCompletionCandidates(context, index);
expect(items.filter(i => i.kind === "column").map(i => i.insertText))
  .toEqual(["`name`"]);
expect(sql.slice(0, context.edit.start) + items[0].insertText + sql.slice(context.edit.end))
  .toBe("SELECT * FROM users u WHERE u.`name`");
```

- [x] 按槽位限制候选类型，并从当前块关系解析字段。单表无歧义允许裸字段；多表同名必须带当前 SQL 的别名，没有别名才带表名；关系存在别名时不能再插入真实表名作为限定符。已输入限定符时仅插字段。
- [x] 对需要补出的别名/表限定符使用 `quoteSqlReference`，对 catalog 字段名使用 `quoteIdentifier`。增加 PostgreSQL `FROM users U JOIN orders O` 和 `FROM users "U"` 两例，分别断言限定符为 `"u"` 与 `"U"`；对于光标前已经输入的限定符保持其原文，不改写用户已有文本。
- [x] 在合法范围内先前缀匹配后包含匹配；稳定排序键依次编码语义优先级、匹配等级、名称和关系标识。字段 `filterText` 使用实际要替换的 token，详情展示表/别名与类型。相同物理表的两个别名不得去重成一个候选。
- [x] 建立每个槽位的小型关键词/函数允许集，不复用整张 DDL/类型关键词表；字段未知时保留适用的函数、操作符与子句建议，明确限定符未知时不返回其他表字段。五方言引用、带引号大小写歧义、跨命名空间、SET/INSERT 去重和上述行为表都加入参数化测试。
- [x] 运行 `npm test -- src/__tests__/sqlCompletion.test.ts src/__tests__/sqlCompletionCandidates.test.ts src/__tests__/sqlCompletionSchema.test.ts`，预期全部通过，批量接口次数保持不变。

## 任务 4：共享元数据缓存与失效协议

**文件：** 新增 `src/utils/sqlCompletionCache.ts`、`src/utils/sqlCompletionInvalidation.ts`、`src/__tests__/sqlCompletionCache.test.ts`；修改 `src/stores/databaseStore.ts`、`src/stores/connectionStore.ts` 及对应测试。

**接口：** loader 由调用方注入，缓存模块不依赖 React/store；实例在编辑器接入模块统一创建。缓存和第三期外键缓存复用以下失效协议。

```ts
export type SqlCompletionInvalidation = {
  connId: string; database?: string | null;
  reason: "schema-change" | "refresh" | "disconnect";
};
export function invalidateSqlCompletion(event: SqlCompletionInvalidation): void;
export function subscribeSqlCompletionInvalidation(
  listener: (event: SqlCompletionInvalidation) => void,
): () => void;
export function getSqlCompletionConnectionRevision(connId: string): number;
export function createSqlCompletionCache(
  loader: (key: SqlCompletionCacheKey) => Promise<SqlSchema>, now?: () => number,
): {
  get(key: SqlCompletionCacheKey): Promise<SqlMetadataIndex>;
  peek(key: SqlCompletionCacheKey): SqlMetadataIndex | undefined;
  invalidate(event: SqlCompletionInvalidation): void;
};
```

- [x] 先写并发去重、TTL、旧请求成功/失败、显式失效后旧请求回写和连接 revision 测试。核心并发断言为一次 loader：

```ts
const loader = vi.fn().mockResolvedValue(completionSchema);
const cache = createSqlCompletionCache(loader, () => 0);
const [a, b] = await Promise.all([cache.get(completionKey), cache.get(completionKey)]);
expect(loader).toHaveBeenCalledTimes(1);
expect(a).toBe(b);
```

- [x] 运行 `npm test -- src/__tests__/sqlCompletionCache.test.ts` 验证失败。实现以 `JSON.stringify([connId, database, dialect, connectionRevision])` 为键的缓存和在途 Promise；设置 TTL 为 60 秒、最多保留 8 个已完成命名空间条目，LRU 淘汰不得让进行中请求回写过期 generation。
- [x] 每 key 保存 generation，只有相同 generation 的响应可写缓存；失败只移除该请求对应的在途项，不清空其他 key。`peek` 对过期项返回 undefined；在途请求失效后其调用方即使拿到结果，也必须由任务 5 的绑定/generation 校验阻止显示。
- [x] `database === undefined` 表示连接下全部条目，`null` 仅表示数据库列表条目，字符串表示一个命名空间。disconnect 提升连接 revision；schema-change/refresh 提升匹配缓存条目的 generation，通知活跃编辑器重新预取。
- [x] 在 `databaseStore.ts` 的刷新入口及建表、改列、删表、重命名成功路径发出失效事件；数据库重命名/删除影响旧名、新名和库列表。`connectionStore.ts` 的断开、强制移除路径发 disconnect。编辑器成功执行 CREATE/ALTER/DROP/RENAME 后按当前库失效；无法明确目标库时按当前连接失效，不解析或执行额外业务 SQL。其他客户端改表由 TTL 和手动刷新恢复。
- [x] 运行缓存、databaseStore 和 connectionStore 定向测试，验证缓存失效只是通知与预取，不增加循环 SQL，不改动已有执行/连接语义。

## 任务 5：Monaco 模型绑定与异步接入

**文件：** 修改 `src/utils/sqlCompletion.ts`、`src/components/sql/SqlEditor.tsx`；新增 `src/hooks/useSqlCompletionMetadata.ts`、`src/__tests__/sqlCompletionProvider.test.ts`、`src/__tests__/SqlEditorCompletion.test.tsx`；按需扩展 `src/__tests__/mocks/monacoEditorStub.ts` 的已有接口模拟。

**接口：** hook 复用任务 4 的共享实例，按 key 预取并返回匹配 key 的索引。provider 注册传入模型 URI 与读取当前绑定的回调；返回 disposable，卸载及时注销。该签名修改在同一任务更新所有调用处。

```ts
export interface SqlCompletionBinding {
  key: SqlCompletionCacheKey; index?: SqlMetadataIndex;
  revision: number;
  requestRefresh?: () => void;
}
export function registerSqlCompletionProvider(
  monaco: typeof Monaco,
  modelUri: string,
  getBinding: () => SqlCompletionBinding | undefined,
): Monaco.IDisposable;
```

- [x] 用 fake Monaco 捕获 provider，模拟两个 model URI；断言 A provider 对 B model 返回空列表，重复挂载/卸载后只剩有效 provider。补上 key A 请求失败晚于 B 成功的 React 集成测试。
- [x] 没有连接时 hook 返回 `connId: ""`、`database: null` 的本地空索引绑定，保留当前已知方言（没有方言信息才默认 mysql），不调用 loader；`getBinding() === undefined` 仅表示模型已解绑。加载中或失败时也为当前 key 构造空索引，让纯候选函数仍可返回适用的关键词，不能借用其他 key 的表列。
- [x] 运行 `npm test -- src/__tests__/sqlCompletionProvider.test.ts src/__tests__/SqlEditorCompletion.test.tsx` 确认新增行为失败，再接入 `model.getValue()`、`model.getOffsetAt(position)`、上下文分析、候选生成链路。
- [x] provider 从 `binding.key.database` 注入 `context.defaultNamespace`，使用 `context.edit` 经 `model.getPositionAt` 生成单行 range；引用标识符需包含已经输入的开引号及当前 token 的结束引号，避免双重引用；接受补全不覆盖限定符或相邻 SQL。使用 `label`、`filterText`、`sortText` 分离展示、匹配、排序，映射 candidate.kind 到 Monaco kind。已输入引用符时，`filterText` 必须与被替换片段的引用形式匹配，并在真实 Monaco 验证不会被二次过滤掉。引用标识符若跨行而 Monaco 的单行替换范围无法安全覆盖，则不生成该候选。
- [x] provider 只读取匹配 key 的缓存快照；网络预取只由 hook 的 key 变化、失效或过期触发，禁止在候选循环中加载。记录模型版本、binding revision 和取消 token；元数据返回时仅在模型仍激活、版本/光标/绑定仍一致时刷新当前建议，不能重新打开已关闭建议列表。过期结果直接丢弃。
- [x] TTL 到期后不后台轮询所有命名空间；在编辑器重新获得焦点或用户下次触发补全时，通过 `binding.requestRefresh` 通知 hook 刷新当前 key。hook 与共享缓存对在途请求去重；provider 当次先返回安全候选，数据到达后的刷新仍遵守前述版本和光标守卫。
- [x] 编辑器设置 `wordBasedSuggestions: "off"`，避免普通单词补全绕过作用域；字符串、注释关闭自动建议，保留手动触发及当前空格/点号/逗号触发。tokenizer 在 provider 中仍负责最终抑制，不能只依赖 Monaco token 着色。
- [x] 验证从 `u.na|`、`u."na|`、`u."na|me"` 接受补全后 SQL 正确；数据库切换立刻切绑定，旧数据不继续显示；API 失败退化为合法上下文关键词，不弹每键错误提示；多模型不重复候选。

## 任务 6：回归、性能与交付

**文件：** 完善本期测试；新增 `src/__tests__/sqlCompletionPerformance.test.ts`，修改 `README.md` 的补全功能描述（只描述实际支持能力）。

- [x] 建立当前行为表的端到端候选断言，额外覆盖五方言、无连接、没有选择库、空表、100 个关系自关联与重复列名。无连接只返回合适基础建议，不产生异常。
- [x] 性能测试在内存构造 1,000 张表、每表 50 列的索引；补全只遍历当前作用域关系的列，不遍历所有列。用 loader spy 验证连续 100 次键入没有新增请求；记录热缓存候选生成 p95，以开发机低于 50ms 为调优目标，不将易抖动的墙钟值设为普通 CI 的唯一门禁。
- [x] 运行针对性测试与构建：

```bash
npm test -- src/__tests__/sqlCompletionTokenizer.test.ts src/__tests__/sqlCompletionContext.test.ts src/__tests__/sqlCompletionCandidates.test.ts src/__tests__/sqlCompletionCache.test.ts
npm test -- src/__tests__/sqlCompletionProvider.test.ts src/__tests__/SqlEditorCompletion.test.tsx src/__tests__/sqlCompletionPerformance.test.ts
npm test -- src/__tests__/sqlCompletion.test.ts src/__tests__/sqlCompletionSchema.test.ts src/__tests__/SqlStateSubscriptions.test.tsx src/__tests__/databaseStore.test.ts src/__tests__/connectionStore.test.ts
npm run build
npm run lint
```

- [x] 以上通过后执行一次 `npm test` 完整回归；如有与本期无关的既有失败，记录具体测试与基线证据，不将失败描述为通过。只改前端时不要求 Rust 全量测试。
- [x] 在实际 Monaco 界面按本文件行为表手测，特别检查点号触发、引号替换、连续切库和接受候选后的文本；单元测试无法替代候选菜单的实际匹配行为。
- [x] 在当前分支交付；需要提交时建议分为 `feat: 增加 SQL 上下文与别名识别`、`feat: 按查询作用域生成 SQL 补全`、`fix: 隔离 SQL 补全缓存与编辑器状态`。本计划不自动触发提交、推送或发布。

## 验收标准与后续接口

- [x] 当前语句已知表后，WHERE/SELECT 等位置不出现未引用表的字段。
- [x] 表别名、光标后 FROM、多语句与子查询边界、SET/INSERT 列表行为符合上表。
- [x] 引号、已有限定符、同名字段接受后形成正确 SQL；未知限定符不乱补。
- [x] 切库、旧请求失败、多编辑器与断线重连不串数据，预取仍使用批量接口。
- [x] 既有关键词、方言引用、SQL 编辑订阅隔离和执行功能回归通过。
- [x] 第二期可以扩展 QueryScope/投影解析而不重写 Monaco 接入；第三期可以订阅同一失效信号。

**回退方式：** 保留分词、上下文、元数据层的独立测试。若某方言复杂形态产生错误绑定，针对该形态返回 `confidence: "unknown"` 与安全候选，不恢复全库字段混排。第一期未实现的复杂查询能力按第二期计划推进。


## 实施记录（2026-09-23）

已在当前 `master` 分支实现，未创建分支/工作树，未提交、推送或发布。README 已更新。原 `buildSqlSuggestions` 全库混排路径已移除，既有方言关键词与引用函数保留。

实现补充：

- `sqlCompletionEditor.ts` 单独管理 Monaco 模型生命周期、焦点预取与菜单刷新。`SqlCompletionBinding.requestRefresh` 可接收异步刷新守卫；context 新增可选 `operator`，用于 NOT/IS/IS NOT 后续关键词。
- 数据库创建、删除、重命名采用连接级失效，因为每个命名空间缓存也包含数据库列表。编辑器成功 DDL 同样保守使用连接级失效，避免猜测跨库目标。
- PostgreSQL 嵌套 CTE 使用未知输出占位；INSERT 列列表和 INSERT SELECT 来源使用独立作用域。复杂输出仍按一期边界降级。
- 两轮专项审查与一次整体审查通过；审查发现的嵌套 CTE、INSERT SELECT、跨命名空间同名关系、复合运算符与 DDL/库列表失效问题均已增加回归测试。

真实 Monaco 0.55.1 验证（使用本地临时验证页和内存元数据，不连接业务数据库）：

- 行为表中的 FROM、关系后续子句、WHERE、光标后 FROM、JOIN/ON、UPDATE SET 去重、INSERT 列列表去重及多语句隔离。
- `u.na|`、`u."na|`、`u."na|me"` 的菜单二次过滤与接受文本；五方言标识符引用；点号自动触发。
- A→B→A 切库立即关闭旧候选并显示对应库；延迟元数据到达后刷新当前菜单；已关闭菜单不重新打开。
- 菜单刷新先验证模型、版本、光标、绑定、取消与可见性，再同步关闭旧菜单并触发新建议，以满足 Monaco action 的前置条件。DOM 可见性结构发生变化时保守跳过刷新，升级 Monaco 时需复测。

最终自动化验证：

- `npm test`：129 个文件、1,470 个测试全部通过（稳定文件集重跑，171.15 秒）。ErrorBoundary 的预期异常仍会输出到 stderr，测试结果通过。
- `npm run build`：通过；Vite 保留大 chunk 提示。
- 本次变更的 26 个 TypeScript/TSX 文件 ESLint：通过；`git diff --check`：通过。
- 性能测试：50,000 列索引仅访问当前表的 50 列；100 次热补全 loader 调用一次；100 个自关联保留 5,000 个独立候选。开发机一次定向测量 p95 约 0.29ms，不作为 CI 的墙钟门禁。

全仓 `npm run lint` 未通过。已确认全仓 `npm run lint` 的三个错误均来自与 HEAD 字节一致的原有文件：`scripts/release.mjs:203,211`（preserve-caught-error）和 `scripts/release.node-test.mjs:382`（URL no-undef），未扩大本次变更范围修复发布脚本。
