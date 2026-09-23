# SQL 智能补全第二期：查询作用域与虚拟关系实施计划

> **执行约定：** 实施时按任务使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans`，以复选框跟踪步骤。

**状态：**已实施（2026-09-23）；验证结果和未执行的真实数据库手测见文末。

**目标：** 在第一期上下文补全之上，可靠识别 CTE、派生表、子查询的输出字段和可见关系，并按方言限制列别名引用；无法确认的复杂 SQL 降级为空候选或已确认候选。

**架构：** 沿用第一期分词器、上下文、候选生成器和本地批量元数据索引。先用平衡括号与 token 构造当前语句的查询块树，再以纯函数推导投影和 CTE 输出，最后把可见关系写回 `SqlCompletionContext.scopes`；编辑器仍只读本地索引，不执行用户 SQL，也不逐表查询元数据。解析或来源不确定时保留第一期的关键词/明确物理表能力，但不把猜测的列塞入虚拟关系。

**技术栈：** TypeScript、Vitest、Monaco 适配层、现有 `SqlSchema` 批量元数据。

**设计依据：** 本文件“设计约定”和“验收”即二期设计依据；一期 [上下文计划](./2026-09-23-sql-completion-phase-1-context.md)，三期 [JOIN 推荐计划](./2026-09-23-sql-completion-phase-3-join-recommendations.md)。执行顺序为一期→二期→三期；三期读取本期稳定的 relation id 和解析后的可见关系。

## 全局约束

- 只在用户要求的现有分支实施；提交信息采用 `<type>: <中文描述>`。本计划编写阶段不修改产品代码、不创建分支、不提交。
- 禁止在循环遍历中查询 SQL；补全请求不得执行用户 SQL，所有输出列推导只读一期 `SqlMetadataIndex`。
- 目标方言固定为 `mysql | postgres | sqlite | sqlserver | clickhouse`；不承诺解析五方言全部 SQL 语法。
- 第一、二、三期统一使用 UTF-16、半开区间 `[start,end)`；输入 SQL 不改写；源自 SQL 文本的限定符走一期 `quoteSqlReference(name,quoted,dialect)`，真实元数据列名走 `quoteIdentifier(name,dialect)`。
- `RelationSymbol.id` 表示一次 FROM 引用，不能以物理表名替代；自连接必须得到两个 id。
- 名称保留解码后的原始大小写，引用位另存 `nameQuoted/namespaceQuoted/aliasQuoted`，`ColumnSymbol.quoted`；按方言比较标识符，不统一转小写。
- 一期索引只含当前 namespace；显式其他 namespace 的物理表列为未知，绝不可回退到当前 namespace 的同名表。
- 新增字段保持一期对象字面量可编译；第三期仍可从 `context.join` 的 `leftRelationIds/rightRelationId` 取关系。

## 设计约定与接口边界

一期定义 `analyzeSqlCompletion({sql,offset,dialect}):SqlCompletionContext`，`tokenizeSql(sql,dialect):SqlToken[]`，`generateSqlCompletionCandidates(context,index):CompletionCandidate[]`，以及 `SqlCompletionContext`、`QueryScope`、`RelationSymbol`、`ColumnSymbol`、`SqlMetadataIndex`。二期只增量扩展，不重命名一期字段：

```ts
// src/utils/sqlCompletionTypes.ts：仅新增以下可选字段；一期已有 quoted 标志。
interface RelationSymbol {
  outputComplete?: boolean; // true 才可把 outputColumns 用作派生关系的完整列集
}
interface QueryScope {
  range?: { start: number; end: number };
  ctes?: RelationSymbol[]; // 当前查询块可见的 CTE 定义，不等于 FROM 实例
  projectionComplete?: boolean;
  visibleParentRelationIds?: string[]; // 到直接父块时允许看见的 FROM 实例 id
}
```

`ColumnSymbol.quoted`、`RelationSymbol.nameQuoted/namespaceQuoted/aliasQuoted`、`SqlCompletionContext.qualifierQuoted` 和 `defaultNamespace?:string|null` 由一期提供。`outputColumns === undefined` 表示未知，`[] + outputComplete:true` 表示已知空列集；只要 `*`、来源或 UNION 列数无法确认，就设 `projectionComplete:false`，不能把部分结果包装成完整派生表。显式 CTE/派生表列名列表也须在输出个数可证时才标完整，递归 CTE 可用明确锚点或显式列表约束。`QueryScope.relations` 只存本块 FROM/JOIN 的实例，`ctes` 存词法可见的定义；引用同一个 CTE 两次会产生两个不同 relation id。解析出的 SQL 名称保留原文解码大小写，同时匹配时使用方言语义名；PostgreSQL 未引用的 `U` 语义为 `u`，引用时调用一期 `quoteSqlReference` 得到 `"u"`，不能直接调用 `quoteIdentifier("U")`。已知 catalog 列名仍按真实名称引用，不折叠。`canCorrelate` 只控制是否走到父级 FROM，`visibleParentRelationIds` 限制该跳能看见的具体父级实例；即使 `canCorrelate:true`，该数组缺失时也视为无父级实例可见。到祖父块时逐级应用每条边的可见 id 集。CTE 的词法可见性独立于这两个相关查询字段。

新增纯函数入口：

```ts
// src/utils/sqlCompletionScopes.ts
export function resolveSqlCompletionScopes(input: {
  sql: string;
  offset: number;
  context: SqlCompletionContext;
  index: SqlMetadataIndex;
}): SqlCompletionContext;
```

调用链为 `analyzeSqlCompletion → resolveSqlCompletionScopes → generateSqlCompletionCandidates`。provider 从一期 binding 将 `index.key.database` 写入 `context.defaultNamespace`；`analyzeSqlCompletion` 入参不变。`resolve` 克隆上下文，仅扫描 `context.statement`，重建/补全 `scopes`，按最小包含区间更新 `scopeId`；若一期对嵌套块的 `clause/slot` 归类指向外层，按内层 token 的子句区间重算这两项，并在当前块的 JOIN/ON 内重算 `join.leftRelationIds/rightRelationId`，不得沿用外层关系 id；保留一期准确的 `prefix/edit/qualifierParts/qualifierQuoted`。失败返回 `confidence:'partial'|'unknown'` 和有限关系，不抛错、不回退全局列。第一期若尚未集成此函数，二期在同一适配层加入调用；不改公共 `generate...` 签名。

方言列别名策略采用有证据的保守子集：MySQL 在 `GROUP BY/HAVING/ORDER BY`；PostgreSQL 在 `GROUP BY/ORDER BY`，且 GROUP 与真实输入列同名时输入列优先；SQL Server 仅 `ORDER BY`；SQLite 本期仅实现 `ORDER BY`（这是本期范围，不表示 SQLite 引擎只允许这一处）；ClickHouse 在可识别的简单 `SELECT/WHERE/GROUP BY/HAVING/ORDER BY` 同块使用，但名称与真实列冲突时不推荐，复杂 `WITH` 标量别名、`PREWHERE/ARRAY JOIN/LIMIT BY` 等降级。统一禁止在 `ON`、派生表父作用域和其他查询块套用投影别名。依据：[MySQL 别名规则](https://dev.mysql.com/doc/refman/8.4/en/problems-with-alias.html)、[PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html)、[SQL Server SELECT 子句](https://learn.microsoft.com/en-us/sql/t-sql/queries/select-clause-transact-sql)、[SQLite SELECT](https://www.sqlite.org/lang_select.html)、[ClickHouse 官方演讲中别名跨子句示例](https://presentations.clickhouse.com/meetup70/modern_sql/)；实施时如发现版本/设置依赖，进一步缩小候选，不据此放宽未测试语法。

## 文件职责映射

| 文件 | 职责 |
| --- | --- |
| `src/utils/sqlCompletionTypes.ts` | 在一期共享类型上增加可选的区间与完整性标记。 |
| `src/utils/sqlCompletionScopeParser.ts` | 仅解析 token：查询块、投影项、CTE 声明、FROM 引用及语法降级原因。 |
| `src/utils/sqlCompletionProjection.ts` | 从可确认的来源推导 `SELECT`、星号与集合操作输出名。 |
| `src/utils/sqlCompletionScopes.ts` | 将解析结果、批量元数据和 CTE 依赖合成为 `QueryScope[]`，定位光标块。 |
| `src/utils/sqlCompletionCandidates.ts` | 使用二期可见关系和方言列别名策略筛候选，保留一期统一排序/去重/引用逻辑。 |
| `src/utils/sqlCompletion.ts` | 在已有补全链上串接 `resolveSqlCompletionScopes`；不新增 SQL 请求。 |
| `src/__tests__/sqlCompletionScopeParser.test.ts` | 查询块边界、CTE/FROM 解析与复杂语法降级。 |
| `src/__tests__/sqlCompletionProjection.test.ts` | 投影、星号、UNION 与未知输出。 |
| `src/__tests__/sqlCompletionScopes.test.ts` | CTE 遮蔽、递归终止、相关性、namespace 与自连接。 |
| `src/__tests__/sqlCompletionCandidates.test.ts` | 同一期候选测试合并或扩展，核对别名/可见性。 |

## 审查重点

- 光标在字符串、注释或不完整括号里：不得从邻近查询块漏出列（任务 1、4 测试）。
- CTE 与真实表、内外层 CTE 同名：最近可见 CTE 遮蔽物理表，离开块后不能泄漏（任务 3 测试）。
- `SELECT *` 遇到未知源、`USING/NATURAL JOIN` 或集合分支列数冲突：不得宣称虚拟关系完整（任务 2 测试）。
- 自连接和相关子查询同时存在：只能按 relation id 和允许的父链找列，不能按表名合并（任务 3、4 测试）。
- 引号、大小写、显式异 namespace：不能错误命中当前库同名物理表（任务 1、3 测试）。

---

### 任务 1: 解析当前语句的查询块树与声明

**文件：**
- 修改： `src/utils/sqlCompletionTypes.ts`
- 新增： `src/utils/sqlCompletionScopeParser.ts`
- 测试： `src/__tests__/sqlCompletionScopeParser.test.ts`

**接口：**
- 输入： `tokenizeSql(sql,dialect):SqlToken[]`，`context.statement:{start,end}`，一期 `SqlDialect/SqlToken`。
- 输出： `parseSqlQueryBlocks(sql:string, statement:{start:number;end:number}, dialect:SqlDialect):ParsedQueryBlock[]`；`ParsedQueryBlock`、`ParsedFromRef`、`ParsedCte` 从同文件导出供 任务 2/3 使用。

```ts
export interface ParsedFromRef {
  id: string; kind: "table" | "cte" | "derived"; declarationStart: number;
  name: string; nameQuoted: boolean; namespace?: string; namespaceQuoted?: boolean;
  alias?: string; aliasQuoted?: boolean; columnAliases?: ColumnSymbol[];
  bodyScopeId?: string; lateral: boolean;
}
export interface ParsedCte {
  name: string; quoted: boolean; columnAliases?: ColumnSymbol[];
  bodyScopeId: string; recursive: boolean;
}
export interface ParsedQueryBlock {
  id: string; parentId?: string; range: {start:number;end:number};
  kind: "statement" | "cte" | "derived" | "expression" | "lateral" | "compound";
  selectItems: SqlToken[][]; from: ParsedFromRef[]; ctes: ParsedCte[];
  clauses: Array<{name:SqlClause;start:number;end:number}>;
  setBranchIds?: string[]; unsupported?: string;
}
```

集合操作创建 `kind:"compound"` 父块与按 SQL 顺序排列的分支子块；父块 `setBranchIds` 指向子块，各子块独立保存 `selectItems/from/clauses`，不得只复用第一分支的 FROM。集合后的 `ORDER BY` 归父块，光标在分支内归该分支。普通查询块没有 `setBranchIds`。`ParsedFromRef.declarationStart` 是关系声明的 UTF-16 起点，用于计算 LATERAL 左侧可见实例。

- [x] **步骤 1: 写失败测试。** 构造 `WITH c(x) AS (SELECT u.id FROM users u) SELECT d.x FROM (SELECT x FROM c) d WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = d.x)`，断言四个块的 `parentId/range/kind`、CTE `columnAliases`、派生表 `bodyScopeId`、关系 id 均不同；再断言 `SELECT '-- FROM' /* JOIN */ FROM users` 只含一个 FROM。用 `sql.indexOf('d.x')` 和 UTF-16 偏移验证范围。

```ts
const blocks = parseSqlQueryBlocks(sql, { start: 0, end: sql.length }, "postgres");
expect(blocks).toHaveLength(4);
expect(new Set(blocks.flatMap(b => b.from.map(r => r.id))).size)
  .toBe(blocks.flatMap(b => b.from).length);
expect(blocks.find(b => b.kind === "derived")?.parentId)
  .toBe(blocks.find(b => b.kind === "statement")?.id);
```
- [x] **步骤 2: 运行 `npx vitest run src/__tests__/sqlCompletionScopeParser.test.ts`，预期因导出不存在而失败。**
- [x] **步骤 3: 实现平衡括号扫描。** 每个 token 保持一期偏移；只在非字符串/注释 token 中识别 `WITH/SELECT/FROM/JOIN/UNION`，仅顶层逗号切投影与 FROM，`(` 到匹配 `)` 归属单一子块；`id = query:<start>:<end>`，关系 `id = relation:<from-token.start>`。识别 `AS` 与无 `AS` 表别名、双引号/反引号/方括号原文解码及 quoted 标志、`cte_name(col...)`、`derived_alias(col...)`；SQL Server `WITH (...)` 表 hint 不当 CTE。`APPLY/PIVOT/UNNEST`（SQL Server APPLY 本期整段降级）、ClickHouse `ARRAY JOIN/FINAL/PREWHERE` 或括号不平衡记录 `unsupported`，不把内部 token 当普通 FROM。
- [x] **步骤 4: 加失败回归。** 测试显式 `other.users` 保留 namespace、`"Case"`/`[Case]` 保留 quoted；测试 `SELECT * FROM users a JOIN users b` 有两个关系 id；`SELECT id FROM users UNION ALL SELECT id FROM orders ORDER BY id` 有一个 compound 父块、两个 `setBranchIds` 和归属父块的 ORDER BY；测试字符串、注释、未闭合括号及 ClickHouse `ARRAY JOIN` 不生成伪关系。
- [x] **步骤 5: 运行本文件测试至全绿，提交 `feat: 解析 SQL 查询块与关系声明`。** 提交只包含本任务路径。

### 任务 2: 推导 SELECT、星号与集合输出名

**文件：**
- 新增： `src/utils/sqlCompletionProjection.ts`
- 测试： `src/__tests__/sqlCompletionProjection.test.ts`

**接口：**
- 输入： 任务 1 `ParsedQueryBlock`，一期 `ColumnSymbol`；来源由调用方按 `ParsedFromRef.id` 给出，不向数据库查询。
- 输出： `inferSqlProjection(block:ParsedQueryBlock, columnsOf:(relationId:string)=>ColumnSymbol[]|undefined, dialect:SqlDialect):ProjectionInference` 与 `combineSqlSetProjection(branches:ProjectionInference[]):ProjectionInference`；`ProjectionInference={columns:ColumnSymbol[];complete:boolean}`。前者只推单个 SELECT 分支，后者按任务 1 的分支顺序合并。

```ts
const result = inferSqlProjection(block, id => sourceColumns.get(id), "postgres");
// SELECT u.id AS user_id, u.name FROM users u → [user_id,name], complete:true
// SELECT count(*) FROM users → [], complete:false（无稳定显式输出名）
```

- [x] **步骤 1: 写失败测试。** `SELECT u.id AS uid, u.name, 1 AS one FROM users u` 推出 `uid/name/one`；`SELECT u.*, 'x' AS tag FROM users u` 使用给定 `[id,name]` 展开并保留顺序；`SELECT * FROM users u JOIN orders o` 依 FROM 顺序展开；`SELECT sum(x) AS total` 只推 `total`；PostgreSQL `AS K` 的输出语义名为 `k`，`AS "K"` 则为 `K` 且 `quoted:true`。

```ts
const usersId = block.from[0].id;
const known = new Map<string, ColumnSymbol[]>([[usersId, [
  { name: "id", source: { relationId: usersId, column: "id" } },
  { name: "name", source: { relationId: usersId, column: "name" } },
]]]);
expect(inferSqlProjection(block, id => known.get(id), "postgres"))
  .toMatchObject({ columns: [{ name: "id" }, { name: "name" }], complete: true });
```
- [x] **步骤 2: 运行 `npx vitest run src/__tests__/sqlCompletionProjection.test.ts`，预期因导出不存在失败。**
- [x] **步骤 3: 实现最小投影推导。** 支持明确 `AS alias`、安全的尾随裸别名、单列引用 `x`/`u.x`、`*`/`u.*`；SQL 文本定义的投影别名以方言语义名写入 `ColumnSymbol.name`，引用位写入 `quoted`，真实 catalog 列名按元数据原样保留。`ColumnSymbol.source` 保留原 relation id 与列名，表达式别名无来源。`COUNT(*)` 内星号不能当投影星号。来源重复列名可在输出列中保留两个位置，候选最终按可解析性去重；未知源的 `*`、未命名表达式、未识别 matcher/transformer、`NATURAL/USING` 的无修饰 `*` 标 `complete:false`，不自行发明引擎生成名。
- [x] **步骤 4: 加集合测试。** `SELECT id AS first FROM users UNION ALL SELECT id AS second FROM users` 使用第一分支 `first`；两分支已知列数不等、首分支未知、括号/子句无法确定时 `complete:false`。同文件导出 `combineSqlSetProjection(branches:ProjectionInference[]):ProjectionInference`，取第一分支名称且仅在各分支 `complete`、列数一致时宣称完整；任务 3 按任务 1 的 `setBranchIds` 取分支结果调用。显式 CTE/派生表列名覆盖在任务 3 处理，覆盖数目可检查时不匹配则未知。

```ts
expect(combineSqlSetProjection([
  { columns: [{ name: "first" }], complete: true },
  { columns: [{ name: "second" }], complete: true },
])).toEqual({ columns: [{ name: "first" }], complete: true });
expect(combineSqlSetProjection([
  { columns: [{ name: "a" }], complete: true },
  { columns: [{ name: "b" }, { name: "c" }], complete: true },
]).complete).toBe(false);
```
- [x] **步骤 4a: 加复杂投影测试。** `SELECT t.* APPLY(toString)`、`COLUMNS('^metric_')`、`SELECT * REPLACE(...)`、未解析的 `DISTINCT ON`/窗口表达式不得造列；显式 `AS` 后的已知别名仍可局部记录，但整行 `complete:false`。这项测试是审查重点中未知输出的约束。
- [x] **步骤 5: 运行本文件测试至全绿，提交 `feat: 推导 SQL 查询输出列`。**

### 任务 3: 解析 CTE、派生表与相关子查询可见性

**文件：**
- 新增： `src/utils/sqlCompletionScopes.ts`
- 测试： `src/__tests__/sqlCompletionScopes.test.ts`
- 修改： `src/utils/sqlCompletionTypes.ts`（仅补齐本任务用到的可选字段）

**接口：**
- 输入： 任务 1 `parseSqlQueryBlocks`、任务 2 `inferSqlProjection`、一期 `SqlMetadataIndex` 与 `SqlCompletionContext`。
- 输出： 前述 `resolveSqlCompletionScopes(input):SqlCompletionContext`；`scopes` 中每个 FROM 引用各有 relation id，`scopeId` 为包含 offset 的最内块。

- [x] **步骤 1: 写失败测试。** 索引只存 `users(id,name)`、`orders(id,user_id)`；对 `WITH base AS (SELECT id AS k FROM users), renamed(v) AS (SELECT k FROM base) SELECT r.v FROM renamed r`，断言 `r.outputColumns=[{name:'v',...}]` 且 `outputComplete:true`，`base` 在 `renamed` 体内可见；`WITH base AS (...), later AS (...)` 的前一体内不见 `later`。

```ts
const base = analyzeSqlCompletion({ sql, offset: sql.indexOf("r.v") + 2, dialect: "postgres" });
const context = resolveSqlCompletionScopes({ sql, offset: sql.indexOf("r.v") + 2, context: base, index });
const active = context.scopes.find(s => s.id === context.scopeId)!;
expect(active.relations.find(r => r.alias === "r"))
  .toMatchObject({ kind: "cte", outputComplete: true,
    outputColumns: [{ name: "v" }] });
```
- [x] **步骤 2: 运行 `npx vitest run src/__tests__/sqlCompletionScopes.test.ts`，预期因函数不存在失败。**
- [x] **步骤 3: 实现有界解析。** 仅查 `index.columnsByTable`；物理表的显式 namespace 须按 `context.defaultNamespace` 及 quoted 规则匹配，默认 namespace 为 `null` 时不猜当前库，其他 namespace 输出未知。按方言标识符比较处理 quoted 位；同块 FROM 派生表实例遮蔽同名 CTE，CTE 遮蔽物理表，内层 CTE 遮蔽外层 CTE。先解析独立 CTE 定义，再按依赖顺序推导；递归 CTE 显式列列表优先，无列表只取锚点/UNION 第一分支命名；最多 `blocks.length + 1` 轮，状态不再变化即停，仍循环/互相依赖则标未知，禁止无界递归。对已知结果数目不匹配的显式列列表标未知；结果数未知时仅存声明列名而 `outputComplete:false`，不生成错误建议。相关子查询在 WHERE/SELECT 可见已解析的父级 FROM 实例，在 ON 只可见该 JOIN 的左侧与右侧实例；普通派生表无父级实例，LATERAL 只可见声明前的左侧实例。当前块的 `join` 只由当前块的 FROM 顺序重算。
- [x] **步骤 4: 加可见性和边界测试。** `EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id)` 子块 `canCorrelate:true` 且可见外层 `u`；`FROM (SELECT u.id FROM orders) d` 无 `LATERAL/APPLY` 时 `canCorrelate:false`，`u` 不可见；仅对 PostgreSQL 明确 `LATERAL` 开启左侧关系；SQL Server `CROSS/OUTER APPLY` 在本期整体 `unsupported`，MySQL 未知服务器版本时不推荐外层列，其他方言保守未知。LATERAL 子块的 `visibleParentRelationIds` 必须只含 `declarationStart` 早于该 LATERAL 的父级 FROM 实例；普通派生表为空，WHERE/SELECT 中相关表达式按父级位置可见关系确定。CTE 本体不把外层 FROM 当普通相关源。嵌套内外 CTE 同名、真实表同名、自连接、显式异 namespace、`"Mixed"` 与 `mixed` 均验收；超出最大嵌套深度（例如 32）直接 partial，不阻塞编辑器。

```ts
const scopes = resolveSqlCompletionScopes({ sql, offset, context: base, index }).scopes;
expect(scopes.find(s => s.id === innerExistsId)?.canCorrelate).toBe(true);
expect(scopes.find(s => s.id === plainDerivedId)?.canCorrelate).toBe(false);
expect(scopes.find(s => s.id === plainDerivedId)?.parentId).toBe(outerId);
expect(scopes.find(s => s.id === lateralId)?.visibleParentRelationIds)
  .toEqual([leftRelationId]); // rightRelationId 晚于 LATERAL 声明，不能出现
```
- [x] **步骤 5: 加递归终止测试。** `WITH RECURSIVE nums(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM nums)` 稳定得 `n`；无显式列列表的可推锚点得首分支名；两个 CTE 互相引用不死循环且不产生伪列。显式断言循环依赖结果 `outputComplete:false`、`confidence:"partial"`，同一输入调用两次得到相同结果；实现的最大迭代次数固定为 `blocks.length + 1`，不要写执行 SQL 的测试。
- [x] **步骤 6: 运行本文件测试至全绿，提交 `feat: 建立 CTE 与子查询作用域`。**

### 任务 4: 候选可见性与方言列别名

**文件：**
- 修改： `src/utils/sqlCompletionCandidates.ts`
- 测试： `src/__tests__/sqlCompletionCandidates.test.ts`

**接口：**
- 输入： `generateSqlCompletionCandidates(context,index)` 现有签名；任务 3 `context.scopes/scopeId`；一期 `slot/clause/qualifierParts/qualifierQuoted/excludedColumns`、`quoteSqlReference`、`quoteIdentifier`。
- 输出： 仍是 `CompletionCandidate[]`，不新增异步接口；三期能按 `context.join` 的 relation id 从 `scopes` 查确定的列。

```ts
// 测试辅助：实际测试文件中创建一期 context/index，再经 resolveSqlCompletionScopes。
const labels = (sql: string, dialect: SqlDialect) => {
  const offset = sql.indexOf("|");
  const text = sql.replace("|", "");
  const base = analyzeSqlCompletion({ sql: text, offset, dialect });
  const scoped = resolveSqlCompletionScopes({ sql: text, offset, context: base, index });
  return generateSqlCompletionCandidates(scoped, index).map(c => c.label);
};
expect(labels("SELECT u.id AS uid FROM users u WHERE |", "postgres"))
  .not.toContain("uid");
expect(labels("SELECT u.id AS uid FROM users u ORDER BY |", "postgres"))
  .toContain("uid");
```

- [x] **步骤 1: 写上述失败测试，并给五方言加入表驱动矩阵。** 同一句 `SELECT id AS renamed FROM users`：MySQL 的 GROUP/HAVING/ORDER 可见；PostgreSQL 的 GROUP/ORDER 可见；SQL Server、SQLite 的 ORDER 可见；ClickHouse 简单 WHERE/GROUP/HAVING/ORDER 可见；所有方言 ON 与别名定义所在 SELECT 项内默认不跨块引用（ClickHouse 简单同块 SELECT 项允许但仅无冲突时）。`WHERE renamed` 在非 ClickHouse 方言均不出现。

```ts
it.each([
  ["mysql", "GROUP BY", true], ["postgres", "HAVING", false],
  ["sqlserver", "ORDER BY", true], ["sqlite", "WHERE", false],
  ["clickhouse", "WHERE", true],
] as const)("%s 的 %s 别名可见性", (dialect, clause, visible) => {
  const names = labels(`SELECT id AS renamed FROM users ${clause} |`, dialect);
  expect(names.includes("renamed")).toBe(visible);
});
```
- [x] **步骤 2: 运行 `npx vitest run src/__tests__/sqlCompletionCandidates.test.ts`，预期别名矩阵失败。**
- [x] **步骤 3: 候选来源改为从当前 scope 向上走允许的相关父链，每跳先检查 `canCorrelate`，再用该子块的 `visibleParentRelationIds` 过滤父块关系；嵌套两层时继续应用下一跳自己的可见 id 列表。** 点号限定优先按可见 `alias` 找 relation id，再看未取别名的关系名；有别名时不可再用原物理表名。派生/CTE 仅在 `outputComplete:true` 时提供点号列；同一派生输出内若同名列出现两次，`d.id` 可能有歧义，过滤该名称。未限定列遇多个可见关系同名时保守不提供单一裸列，仍可提供可确定的 `u.col`。投影别名仅以本任务矩阵出现，冲突时先过滤或依各方言已确认规则选择，不让别名遮蔽真实列产生歧义。`sortText`、`filterText`、`edit` 与一期统一规则保持一致。
- [x] **步骤 4: 加审查重点回归。** 光标在内层 EXISTS 时可有 `u.id`，在普通派生体内不能有 `u.id`；`FROM users u, LATERAL (SELECT u.id) d, orders o` 的 LATERAL 内有 `u.id` 但不能有 `o.id`；`users a JOIN users b` 两套 id 均保留；`FROM (SELECT u.*, o.* FROM users u JOIN orders o) d WHERE d.|` 遇两个 `id` 不推荐 `d.id`；PostgreSQL `FROM (SELECT id AS K FROM users) D WHERE |` 的完整限定候选插入 `"d"."k"`，`FROM (...) "D"` 则插入 `"D"."k"`；当前 namespace 有 `users(id)` 时 `other.users x` 的 `x.id` 不出现；未完成投影/ClickHouse `COLUMNS(...)` 后不出现猜测列；字符串/注释 slot 不产生列。
- [x] **步骤 5: 运行相关候选测试至全绿，提交 `feat: 按查询作用域筛选补全候选`。**

### 任务 5: 接入编辑器与整体回归

**文件：**
- 修改： `src/utils/sqlCompletion.ts`
- 测试： `src/__tests__/sqlCompletion.test.ts`
- 测试： `src/__tests__/sqlCompletionSchema.test.ts`

**接口：**
- 输入： 一期 provider 内的 `{sql,offset,dialect}`、`SqlMetadataIndex`；任务 3 `resolveSqlCompletionScopes`。
- 输出： Monaco `CompletionItem[]`；编辑器配置和批量元数据请求签名不变。

- [x] **步骤 1: 写失败集成测试。** 模拟同一文档两个分号隔开的语句，前句 `WITH c AS (...)`、后句 `SELECT | FROM users`；断言后句没有 `c`，而本句 `SELECT x.| FROM (SELECT id AS k FROM users) x` 有 `k`。模拟 metadata source，仅一次 `getSqlCompletionMetadata`，`getTableStructure` 未调用，补全 SQL 从未发送给执行接口。

```ts
expect(secondStatementSuggestions.map(s => s.label)).not.toContain("c");
expect(derivedSuggestions.map(s => s.label)).toContain("k");
expect(source.getSqlCompletionMetadata).toHaveBeenCalledTimes(1);
expect(source.getTableStructure).not.toHaveBeenCalled();
expect(source.executeQuery).not.toHaveBeenCalled();
```
- [x] **步骤 2: 运行 `npx vitest run src/__tests__/sqlCompletion.test.ts`，预期集成测试失败。**
- [x] **步骤 3: 在已有 provider 的纯计算路径串接 `resolveSqlCompletionScopes`。** 一次请求只取一次一期缓存索引；把 `index.key.database` 作为 `context.defaultNamespace`，并沿用 `qualifierQuoted`，同步解析无额外 I/O；取消/连接切换沿用一期 `connectionRevision` 防过期结果。解析异常最多降级为关键词/已确认候选，不以全量 schema 列兜底。保持 `CompletionCandidate` 到 Monaco 的 range、kind、sortText 映射。
- [x] **步骤 4: 运行 `npx vitest run src/__tests__/sqlCompletionScopeParser.test.ts src/__tests__/sqlCompletionProjection.test.ts src/__tests__/sqlCompletionScopes.test.ts src/__tests__/sqlCompletionCandidates.test.ts src/__tests__/sqlCompletion.test.ts src/__tests__/sqlCompletionSchema.test.ts`，预期全绿。再运行 `npm run build`、`npm run lint`；按项目现状记录与改动无关的既有错误。**
- [ ] **步骤 5: 手动在五方言各验一个 CTE、派生表、相关 EXISTS 和不支持语法降级；确认不闪出跨语句/跨库列、无补全引起的 SQL 执行。提交 `feat: 接入查询作用域补全`。**

## 最终验收

- [x] 一期测试保持通过；二期新增测试覆盖显式 CTE 列列表、派生表列列表、`SELECT *`/`u.*`、UNION 首分支命名、递归固定点终止、CTE 遮蔽、相关 EXISTS、无 LATERAL 派生表隔离、五方言列别名矩阵。
- [x] 查询位置变更、多个语句、字符串/注释、同名自连接、大小写与引用符、异 namespace、缺失元数据、畸形/深嵌套 SQL 均只返回可证明合法的候选；ClickHouse 特殊形态明确降级。
- [x] 所有补全来源均为一次批量元数据索引与 SQL 文本解析；无循环 SQL 查询、无执行用户 SQL；三期能够以 relation id 获取当前 JOIN 两侧可见字段。
- [x] `npx vitest run`、`npm run build`、`npm run lint` 结果已记录；本期只实现本期范围，不提前做外键 ON 推荐。

## 实施记录（2026-09-23）

按当前 `master` 分支实现，未创建分支、未推送远端。已完成五个本地功能提交：

| 任务 | 提交 |
| --- | --- |
| 查询块与声明 | `5945bd4` |
| 投影推导 | `734144d` |
| CTE 与子查询作用域 | `83291e2` |
| 候选可见性与方言别名 | `37d9bd2` |
| 编辑器接入 | `7fd1229` |

实现补充与审查修复：

- `ParsedQueryBlock` 额外使用可选 `joinsMergeColumns` 标记 NATURAL/USING，仅限制不能确认的无修饰星号展开。
- SQL Server 的 CTE 自引用无需 `RECURSIVE`；保留自身遮蔽并按锚点校验递归输出。
- 保留尾逗号空投影项；JOIN 的 ON/USING 后逗号关系仍有独立实例；显式列列表不能将未知或循环来源提升为完整；星号不能通过 `AS` 伪造单列。
- 未知来源存在时，已确认字段带关系限定符；无别名的同名关系不产生歧义限定候选。
- 使用现有 `filterText` 核对列名，保留一期包含关系限定名的显示 label；编辑器只读取一次缓存索引。
- ClickHouse 仅空编辑项未完成时保留已确认的简单同块别名，复杂投影仍不推荐别名。

验证记录：

- 二期六个指定测试文件：226/226 通过；独立审查发现的问题均已加入失败回归并验证修复。
- 全量 `npx vitest run`：132 个测试文件、1613 个测试全部通过（最终冻结代码后运行，140.43 秒）。
- `npm run build`：通过（包含既有大 bundle 提示）。
- 本次修改文件的 ESLint 和 `npx tsc --noEmit`：通过。
- `npm run lint`：3 个既有错误，发布脚本不在本次修改范围：`scripts/release.mjs:203,211` 缺少 error cause，`scripts/release.node-test.mjs:382` 的 URL 未声明。已与实施前提交核对。
- 五方言 CTE、派生表、相关 EXISTS、不支持语法和跨 namespace 行为均在 Monaco provider 集成测试中验证；模拟数据源确认一次批量元数据请求、没有逐表结构请求或执行补全 SQL。
- 未连接真实数据库或进行桌面 GUI 手测，任务 5 的人工验证项保留未勾选；没有新增数据库 I/O 或提前实现三期 JOIN 推荐。
