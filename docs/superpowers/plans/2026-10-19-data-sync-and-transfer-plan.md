# 数据同步与数据传输 Implementation Plan

> **执行说明（2026-10-21 更新）：** 最初仅编写计划；用户随后已授权实施并明确继续。当前在既有分支实现与验收，不创建分支、不提交 Git。下方原始任务保留为验收清单，只有完整条件均有证据时才勾选；部分完成项不能代表整个计划完成。

**Goal：** 在 DB Connect 中增加可预览、可取消、可追踪结果的单向表数据同步，以及连接之间的批量数据传输。

**Architecture：** 两种功能共享 Rust 数据任务引擎、类型转换、流式快照、批量写入、任务状态和事件机制；前端提供两个业务入口和统一任务面板。现有数据库结构同步继续独立工作，新功能使用 `data_tasks` / `row_sync` / `data_transfer` 命名，避免混淆。

**Tech Stack：** 复用 Tauri 2、Rust、Tokio、现有五类数据库驱动、serde、sha2、aes-gcm、React 18、TypeScript、Ant Design 5、Zustand、Vitest 与 Testing Library；不引入后台服务器、消息队列或 CDC 平台。

**Spec：** 本文件的“范围与语义”“数据流与一致性”“接口约定”为配套设计，设计和实施计划合并于此，不另建 spec 文件。

**状态：** 核心同步/传输、界面遗漏和受限跨库精确类型已实现；本轮补充取消/提交超时、真实 TLS 与回归测试。仍需三平台实机、SSH、真实磁盘满及其他驱动取消时延验收。ClickHouse 目标因无法原子绑定预览物理表与写入依赖继续阻塞，不能宣称原计划全部完成。持续证据见[验收矩阵](../manual-tests/2026-10-19-data-sync-and-transfer-matrix.md)。

### 2026-10-22 收尾实施记录

起点：`d324cc3`，开始本轮时 `master` 工作区干净；本轮用户明确授权继续实现剩余部分、修复界面、补测试和验收。保留当前分支，不自动提交或发布。

|工作包|负责范围与依赖|本轮状态|
|---|---|---|
|界面与交互回归|错误原因、模式/映射、四模式配置恢复与入口上下文隔离、执行/取消/恢复及草稿保护|已完成：定向25项，全量170文件/2221项通过|
|无损跨类型传输|精确小数、布尔、明确兼容的DATE/TIME/无时区timestamp；范围/精度及规范值守卫|已完成：MySQL与MariaDB新增矩阵各26项、SQL Server TINYINT额外2项真实回归通过|
|ClickHouse 目标安全写入|单流与同查询检查仍不能原子绑定预览对象和写入依赖；正式入口拒绝|受阻：保持禁用，原生实验仅cfg(test)|
|生命周期与故障验收|关闭窗口保留可访问性；PG取消/提交超时；真实TLS证书与断链清理|实现及自动测试完成；三平台实机、SSH和其他驱动完整取消时延未运行|
|最终回归与状态更新|全量前后端、真实有向矩阵、Clippy/格式/文档核对|已完成本轮回归与状态核对；受阻/未运行项目独立保留|

实施决策：复用既有请求中的字段映射，不为确认页捏造后端未返回的类型。数据库安全限制只在机制和真实测试成立后放开；无法在本机运行的平台验收须明确保留为未运行，不能以单元测试代替实机结果。

本轮最终验证：前端170文件/2221项、Rust884项（107项环境型测试默认忽略，数据任务真实实例另跑）、Clippy、Rust格式与构建通过。真实综合矩阵11个检查组passed、0 failed、1 not_run（未重跑历史性能）、1 blocked（ClickHouse目标）；跨类型42项、ClickHouse16项、PG协议7项均通过。TLS单独4项通过，验收工具7+10项单测通过。全局Prettier67个既有问题文件未修改，本轮前端变更文件格式通过。

独立审查发现并修复了SQL Server TINYINT布尔规范值、跨入口旧草稿覆盖及TLS清理失败误报；最终回归进一步修复PG迟到取消打断回滚，并连续12轮/24项验证。计划中的完成标记按实际证据更新，详细结果、13/45毫秒的本机PG取消测量及清理记录见[最终综合报告](../manual-tests/data-task-validation-final-2026-10-22.json)和[TLS报告](../manual-tests/data-task-tls-validation-2026-10-22.json)。

### 已取得的独立验收证据（2026-10-21 至 2026-10-22）

- [x] 前端全量 169 文件、2206 项测试，以及构建与 ESLint 通过。
- [x] PostgreSQL 适配器定向 10 项通过，含外部入向 FK、继承、写规则与规则漂移、权限、序列及回滚。
- [x] PostgreSQL 真实 TCP 代理在服务器提交后丢弃 COMMIT 响应：返回 OutcomeUnknown / Unknown，独立连接确认已提交，无 INSERT/COMMIT 自动重放。
- [x] PostgreSQL 1/10/100 表真实协议计数均为 5 次元数据 SELECT、1 次快照 SELECT；SQLite 对应计数为 4 次与 1 次。PG 协议验收模块 5 项通过（4 项真实库、1 项计数单测）。
- [x] MySQL、MariaDB 各自真实 real_contract 覆盖完整执行器；阶段 B 的 12 个有向组合均通过追加/替换，矩阵共 13 项通过，含 SQL Server 四模式取消回滚。
- [x] release 模式 10 万/100 万同宽行完整传输：19.571/323.947 秒，RSS 峰值 36,503,552/85,262,336 字节，增量 48,758,784 字节；临时数据峰值 70,600,000/706,000,000 字节；缓冲峰值均为 33,554,590 字节，结束后 spool 为 0。原始日志和测量边界见验收矩阵。
- [x] ClickHouse 源到四类事务目标已有真实验收；目标公共写入保持阻塞，原生批次实验不代表开放。
- [x] 本轮真实 TLS 四项验收及清理工具十项测试通过；PG 待查询/锁取消、提交确认丢失及超时已有真实回归。
- [ ] macOS/Linux/Windows 的退出与临时文件实机验收、SSH、其他驱动完整取消时延及真实 ENOSPC 尚未完成。

上述独立证据只覆盖所述条件。下方原任务若同时包含未验证类型、平台、故障或测量要求，仍保留未勾选。

## 全局约束

- 最初的“仅交付计划、不改代码”限制已由后续实施授权覆盖；当前交付包含实现、测试与验收文档。
- 后续默认仍在当前分支工作；未经用户明确要求不新建分支。
- 中文界面和文档；提交信息采用英文 Conventional Commits type + 简体中文描述。
- **禁止在循环遍历中查询 SQL。** 元数据使用数据库/schema 级批量读取，数据使用集合查询加单次结果流；禁止逐表/逐行/逐页循环发起 SELECT，也不能用并发任务包装 N+1 查询。详细查询预算见下文。
- 数据库写入由 Rust 生成和绑定参数；前端不得提交实际执行 SQL、连接密码或落盘文件路径。
- 后端重新校验目标可写性、数据库能力、对象类型和计划身份，不能仅依赖前端按钮禁用。
- 不调用有结果行数上限的表格查询接口完成整表传输，不将完整数据集经 IPC 送入前端。
- 代码中的既有循环查询不构成本功能沿用该方式的理由；不为本功能顺带重构无关模块。

## 重点审查项

1. 预览后目标数据、结构或保存连接发生变化：执行前拒绝旧计划，目标业务表零写入。由任务 4、7、8 验证。
2. `BIGINT`、高精度小数、二进制、时区和 `NULL`：传输与比较不得通过 JS Number 或显示字符串造成精度损失。由任务 2、5、6、10 验证。
3. 取消与 COMMIT、断网、重复执行同时发生：只报告可证明的提交结果，提交结果不明时禁止自动重放。由任务 1、7、8 验证。
4. 无主键、可空/重复定位键、排序规则差异、外键环及触发器副作用：预检阻塞不安全计划，不静默跳过。由任务 3、4、7 验证。
5. 百万行、多表、超大单行、磁盘不足：有界内存、查询次数可证明、不会把截断数据当作完整同步。由任务 2、5、6、12 验证。

## 一、范围与语义

### 1.1 本计划的默认假设

最初请求为“增加数据同步和数据传输功能，只写 plan，不改代码”；后续已获实施授权。以下保留首期范围与设计假设，当前开放能力以真实验收矩阵及安全阻塞项为准。

- 数据同步：用户手动触发，读取源和目标表的完整数据，按稳定键计算行差异，再将源端的已预览快照应用到目标端。
- 数据传输：用户选择源、目标、表和字段映射，一次性复制数据；不自动删除源端数据。“迁移”在本计划中表示复制后校验，源端清理不在范围内。
- 第一阶段只写入已经存在的目标物理表。目标表不存在或结构不兼容时阻塞，并指向现有“数据库结构同步”入口；不暗中执行建表或改表。
- 首期全表操作，不接收任意 SQL、WHERE、表达式转换或增量水位；避免将过滤范围之外的数据误判为应删除数据。
- 定时任务、应用退出后的后台运行、CDC、双向合并、源端删除、跨系统分布式事务和跨重启断点续传不纳入首期。
- 现有 `.sql` 导入导出、CSV/Excel 导出继续保持独立；数据传输不以“先导出 SQL 再导入 SQL”的方式实现。

### 1.2 功能定义

| 功能 | 行为 | 默认值与边界 |
| --- | --- | --- |
| 数据同步：合并 | 插入源端独有行，更新双方同键但值不同的行，保留目标独有行 | 默认模式；不改变定位键 |
| 数据同步：镜像 | 合并基础上删除目标独有行 | 显式选择并二次确认；空源可能删除全部目标数据，单独提示数量 |
| 数据传输：追加 | 复制所选源表数据至映射目标表 | 默认模式；唯一冲突使任务失败，不使用 `IGNORE` 或隐式覆盖 |
| 数据传输：替换 | 在可回滚事务内删除目标已有行，再写入源快照 | 显式确认；使用事务性 DELETE，不使用 TRUNCATE，不重建表 |
| 批量表映射 | 默认同名表/同名列，允许修改目标表名和一对一字段映射 | 一个目标表只能出现一次；必填列缺失、重复映射预检失败 |
| 差异与结果 | 表级统计、行差异分页、参数化操作示例、阻塞原因、最终结果 | 示例明确标注为样本；前端不保存完整行集 |

**同步定位键：** 第一阶段仅接受真实主键及复合主键，双方键列映射完整、非空、类型兼容。不用可空唯一索引、行号、SQLite 隐式 rowid 或“全部列”猜测定位键；无主键表可使用传输。主键值变更表现为新增/目标独有，合并模式保留旧行，镜像模式才删除旧行。

**键比较：** 数值、UUID、二进制采用无损规范表示；字符串键仅在适配器可证明比较规则与目标唯一性语义一致时开放。无法处理大小写、尾部空格、Unicode 或排序规则差异的键返回阻塞项，不能简单以 Rust 字节相等替代数据库键相等。

### 1.3 数据库与阶段矩阵

| 组合 | 阶段 A：同类型核心 | 阶段 B：跨类型传输 | 阶段 C：ClickHouse 传输 |
| --- | --- | --- | --- |
| MySQL/MariaDB → MySQL/MariaDB | 同步、追加、替换；仅可事务化的目标表，验证版本/方言兼容性 | — | — |
| PostgreSQL → PostgreSQL | 同步、追加、替换 | — | — |
| SQLite → SQLite | 同步、追加、替换；目标须是不同物理文件 | — | — |
| SQL Server → SQL Server | 同步、追加、替换；限连接已选 database 内的 schema | — | — |
| 上述四类之间 | 暂禁用 | 仅追加/替换，按明确的无损类型映射开放；不同类型之间不做行差异同步 | — |
| ClickHouse 作为源 | 暂禁用并显示原因 | 暂禁用 | 受支持类型的追加传输；四类事务目标已验收，源不提供跨表一致快照 |
| ClickHouse 作为目标（含同类型） | 禁用并显示原因 | 禁用 | 当前 blocked：按表名分批 INSERT 缺少跨批 DDL/对象身份保护；原生批次实验保留，公共目标写入不开放 |

阶段 A 必须完整覆盖两种功能及四类数据库才算核心完成；B、C 是独立验收增量，不应因 UI 中出现入口便宣称支持。阶段 C 的 ClickHouse 源读取只保证单次读取语义，不宣称跨表事务快照。

## 二、已核实的项目基础

以下为 2026-10-19 规划时核实的项目基础；后续新增实现状态见开头与验收矩阵，不把本表当作当前待实现清单。

| 现有位置 | 可复用内容 | 本功能需要补齐的部分 |
| --- | --- | --- |
| `src/App.tsx`、`src/components/common/DeferredFeatureBoundary.tsx` | 页脚“数据库对比”入口、按需加载机制 | 同步/传输入口及统一任务面板，不增加首屏的大组件导入 |
| `src/components/databaseCompare/DatabaseCompareModal.tsx` | 保存连接选择、过期响应隔离、事件订阅处理 | 借鉴交互模式，不将行数据状态塞入结构对比组件 |
| `src-tauri/src/commands/database_sync.rs`、`src-tauri/src/db/schema_sync/` | 结构计划、指纹校验、只读守卫、批量结构元数据 | 现有功能只执行结构 DDL，不能替代行数据引擎 |
| `src-tauri/src/commands/temporary_database.rs` | 保存连接查找、临时连接建立/关闭、错误脱敏 | 现有端点校验强制不同保存连接且同类型；新任务需要独立校验规则，不放宽旧功能规则 |
| `src-tauri/src/db/schema_compare/`、`src-tauri/src/db/schema_sync/mod.rs` | `load_schema_snapshot`、`load_sync_schema_snapshot` 及原生列元数据 | 补充数据任务所需的批量键、外键、触发器、类型和事务能力元数据 |
| `src-tauri/src/db/batch_update.rs` | 集合 UPDATE 规划、标识符转义、参数预算思路 | 不能直接使用其显示值 JSON 契约覆盖全部无损类型；复用规则，增加类型化绑定和整任务事务 |
| `src-tauri/src/db/result_budget.rs` | 普通查询结果保护 | 当前 `MAX_RESULT_ROWS = 100_000`、`MAX_RESULT_BYTES = 32 MiB`；新任务必须走独立流式读取通道 |
| `src-tauri/src/db/table_query.rs`、`src-tauri/src/lib.rs` | 查询取消注册、先取消后登记竞态处理、`AppState` | 增加独立的数据任务注册表和提交状态，不共用 SQL 编辑器执行 ID |
| `src-tauri/src/commands/sql_file.rs` | SQL 导入导出及进度、部分导出取消机制 | 不直接拼接为传输引擎；存在格式/行数/方言和取消能力差异 |
| `src-tauri/src/util/secure_fs.rs`、`src-tauri/src/crypto/mod.rs` | 安全文件创建、连接凭据加密依赖 | 增加独立的短期数据快照管理，不复用连接密码作为数据加密密钥 |
| `src/services/databaseSync.ts`、`src/stores/tableDataStore.ts` | 按保存连接定位活动连接、表数据缓存/未提交编辑 | 数据任务完成后定向标记目标表过期，不能清空用户未提交编辑 |
| `src/__tests__/`、`scripts/performance/` | Vitest/RTL、隔离数据库验证脚本和查询计数范式 | 新增任务单测与隔离集成夹具；真实库测试未运行不得标为通过 |

## 三、方案选择

| 方案 | 优点 | 代价与判断 |
| --- | --- | --- |
| 复用 SQL 导出再导入 | 现有入口较多 | 数据经过文本方言、易受导出上限影响，难以提供可信差异和一致取消；不采用 |
| Rust 共享数据任务引擎 | 可共享连接、流、类型、事务、进度与校验，前端只处理摘要 | 需新增任务和方言边界；推荐本方案 |
| 接入独立同步服务/CDC | 可支持持续增量和无人值守 | 引入部署、服务端权限和持久调度，超过当前手动桌面工具需求；后续另行规划 |

## 四、数据流与一致性

### 4.1 主流程

```text
前端选择端点、表、字段、模式
  → Rust 预检：能力、身份、权限、元数据、映射、依赖
  → 两端批量流式读取 → 有界缓冲/加密临时快照
  → 类型化比较或传输计数 → 只读预览 + 指纹
  → 用户确认 plan_id / fingerprint / 风险项
  → 锁定目标写入范围 → 重新校验配置、结构和目标数据
  → 批量写入 → 事务内集合校验 → COMMIT
  → 终态记录、目标缓存失效、释放连接和临时数据
```

- 同步预览固定源、目标两个读取快照，显示各自采集时间；不声称两台数据库在同一个时间点取样。
- 阶段 A/B 每一端的集合读取都必须使用可证明的一致读：MySQL/MariaDB 事务表一致性读取、PostgreSQL/SQLite 读取事务，SQL Server 使用已启用的快照隔离或经测试的读取锁方案。不能提供一致读的源表/服务器配置预检阻塞，不能把读取过程中不断变化的内容描述为某一时刻的快照。
- 执行使用预览时冻结的源数据，不在后台换成“最新源数据”。源端后续变化通过重新预览获取。
- 传输预览也完成源数据读取并给出准确行数；目标预检读取完整受影响范围，供漂移检查与替换风险展示。
- `plan_fingerprint` 包含协议版本、非敏感端点配置指纹、对象与映射、模式、能力、结构、快照摘要及风险确认集合；不含密码、SSH 密钥或原始行内容。
- 预览变更、过期、丢失、源/目标配置被编辑或删除后不得执行。计划保存在后端，执行命令不接受前端重新提交行数据。

### 4.2 查询方式与预算

1. 每个端点一次载入 schema 范围内元数据；按照“表列、键、外键、触发器、能力”等固定类别查询，制定并测试每个方言的固定预算，不按表数量增长。
2. 所选物理表在内存中生成带 `table_id` 和类型化行载荷的 `UNION ALL` 投影，作为一个集合 SELECT 建立结果流；每张表可有不同列类型，载荷必须按元数据无损编码。
3. **每次数据快照、每个端点的数据 SELECT 为 1 次**，消费驱动返回的流不重新发 SQL；不使用 OFFSET/KEYSET 循环翻页，不循环 `COUNT(*)`，计数在读取时累积。
4. 目标执行前重读与事务内最终校验各使用一次同类集合查询，额外查询次数与行数/表数无关；事务/锁控制和批量 DML 单独统计。
5. 第一阶段每任务最多 100 张表、集合 SQL 最多 1 MiB；超过限制明确要求拆分任务，禁止静默退化为逐表查询。数据库更低的限制在能力预检中体现。
6. 集合 SQL 的标识符来自校验后的元数据并逐段按方言引用，值参数化；循环只负责内存中的 SQL 片段、行转换和批次构造。
7. 写入使用按参数数、字节数和行数切块的集合 INSERT/UPDATE/DELETE。不得为了存在性、冲突或校验再逐行 SELECT；不允许退化为“一行一个事务”。
8. 适配器无法提供集合流式、无损载荷或正确事务语义时阻塞该能力，不以降低正确性绕过本约束。

### 4.3 无损值和差异计算

- 内部定义 `DataValue`，区分 null、bool、有符号/无符号整数、定点小数、浮点、文本、二进制、日期、无时区时间、带时区时间及受支持 JSON。
- 整数/小数不经 `f64`；IPC 中计数和大数使用十进制字符串，二进制使用明确编码。`NULL`、空串、零、字符串 `"null"` 必须不同。
- 小数保留精确数值，精度/scale 兼容性单独预检；日期时间依赖列语义，不能使用前端本地时区改写。浮点负零、NaN/Infinity、JSON 数字精度设独立测试；不能表达的类型阻塞。
- generated/computed/rowversion 等服务器生成字段从目标写入列中排除，额外非空无默认列阻塞；源端已生成的普通值可映射到兼容的目标可写列。
- 普通 identity、AUTO_INCREMENT 和列专属序列属于首期支持范围：同步及传输默认保留源主键，适配器负责显式插入能力、权限检查、会话设置恢复和目标生成器高水位维护；不重编号或隐式改写外键。共享序列、自定义生成表达式、无法确定归属或无法保证单调推进的生成器先阻塞。
- 生成器不得回退：采用方言认可的锁定/单调推进机制，必须在报告成功前完成并验证后续默认插入不发生冲突。相关语句和权限在预检中明确，不能等数据 COMMIT 后才发现不具备调整能力。其非事务副作用见下节。
- 同步对类型化复合键做本地外部排序，再顺序归并；不依赖两端默认排序规则恰好相同，也不将整表装入 HashMap。
- 差异输出 `insert/update/delete/unchanged` 及字段级 old/new；删除关闭时目标独有行计入 `retained`，不是执行删除。
- 摘要哈希用于指纹和快速检测；相等性校验需要包含键、完整类型化值及重复次数，不能仅以行数相等或若干字段的抽样判为成功。
- 同步比较与执行后数据校验的投影为定位键及映射后的可写列；目标默认值、计算列和未映射列不拿来与源端硬比较。目标漂移检测仍覆盖预览时读取的完整目标行，替换/追加另校验总行数与重复次数，避免遗漏额外行。

### 4.4 事务、漂移与约束

- 阶段 A/B 的全部目标业务表 DML 使用**一个任务一个目标事务**；跨源目标没有分布式事务。预览与等待确认期间不持有目标写锁。
- 写入前获取适配器可证明足以阻止受影响表范围内插入、更新、删除和结构变化的锁/隔离保护；在同一受保护会话内重新读取目标数据、元数据并比较预览摘要。任意变化返回 `plan_stale`，业务 DML 为零。
- MySQL/MariaDB 仅开放经测试的事务表与会话锁组合；PostgreSQL 使用事务及匹配的表锁；SQLite 使用事务性文件写锁；SQL Server 使用事务及能防止幻读的锁策略。具体驱动操作由任务 5/6 的双连接并发测试确定，不把“开启事务”直接等同于已解决漂移竞态。
- 目标锁默认等待最多 10 秒，锁超时失败而不是无限等待；锁必须覆盖执行前重读、全部写入、校验和提交。不满足这一点的适配器不可上线。
- 外键元数据批量构造依赖图：新增父表优先，删除子表优先。外键环、外部表依赖、可能产生级联写入或无法证明安全的约束更新首期阻塞；不临时关闭外键校验。
- 首期阻塞带启用的用户写触发器、无法完整读取约束元数据、部分权限/RLS 导致不可见行的目标表，避免“同步成功”却遗漏或间接修改数据。
- 冲突、唯一约束失败、类型转换失败、数据校验不符或提交前取消均回滚本次业务表 DML；回滚完成后才报告已取消/失败。
- 业务表行数据的回滚保证不包括数据库固有的序列/自增计数消耗。生成器可能留下间隙，但不得回退或与已提交键冲突；预览明确提示这一边界，测试须覆盖生成器调整后业务事务回滚、独立会话分配新值及再次默认插入。适配器无法证明该行为时阻塞相应生成列，不能宣称所有表都支持。
- 阶段 C 原生实验中的 ClickHouse 目标使用单独的批次结果模型：已确认写入保留，失败后停止；不报告整任务回滚，不自动重试结果不明的批次。公共目标写入仍因跨批 DDL 保护不足而阻塞。

### 4.5 资源和落盘策略

- 默认 1 个写任务执行槽；另一写任务返回 `task_busy`。同一目标范围不允许重叠执行；最多保留 3 个有效预览，超出时要求关闭旧预览。
- 内存数据缓冲预算 64 MiB，外部排序初始块 16 MiB、有界归并扇入 16；加密/解密、队列和写入批次共同计入预算。单行最多 8 MiB，超限失败而非截断。
- 写入批次默认最多 500 行、4 MiB，另受方言参数上限约束；单行超过批次字节预算时可独立成批，但仍受单行和全局内存预算约束。
- 单任务临时目录默认硬上限 5 GiB，统计源、目标、差异、排序中间文件和加密开销；超额或写盘失败立即结束预览，业务表不变。
- 快照每块使用现有 AES-GCM 依赖加密，任务随机密钥仅驻留内存；nonce 不得在同密钥下复用。使用 `secure_fs` 的文件创建规则，不向前端暴露路径或密钥。
- 预览有效期 15 分钟；确认执行时转为任务持有，不在执行中被 TTL 清理。完成/取消/过期后删除数据文件；重启后标记未完成任务中断并清理本应用管理的孤儿目录，不自动续跑。
- 扫描阶段只显示已读取行数、字节数、耗时，不伪造总量百分比；完成扫描后才有准确分母。进度事件最多每 200ms 一次，阶段变化和终态立即发送。

### 4.6 任务状态与重试

`created → validating → reading → comparing → ready → executing → verifying → committing → succeeded`

- 传输跳过 `comparing`；取消经 `cancelling` 再到 `cancelled`；预览可进入 `expired`，重启遗留进入 `interrupted`。
- `failed` 表示已知失败且明确业务写入/回滚结果；`outcome_unknown` 表示 COMMIT 或非事务批次已发出但响应丢失，不能等同“零写入”。
- `committing` 阶段不再接受“保证撤销”的取消，前端显示正在确认提交结果。终态必须由后端统一裁决，不能仅据取消按钮响应推断成功撤销。
- `plan_id` 只能成功启动一次；`execution_id` 是客户端生成的 UUID 幂等键，重发返回原执行记录，不再执行写入。
- 首期没有自动重试/断点续传。失败后重新预览；`outcome_unknown` 必须先重读目标核对，追加模式尤其不能直接重放。
- 用户关闭弹窗后应用内任务继续，重新打开可查询；关闭应用应提示仍有任务，选择取消时等清理完成再退出。强制退出只能记为中断/结果不明。

## 五、接口约定

新增 Rust 契约文件 `src-tauri/src/models/data_tasks.rs` 和 TypeScript 契约文件 `src/types/dataTasks.ts`，不继续扩大现有通用 types 文件。

| 类型 | 核心字段/含义 |
| --- | --- |
| `DataEndpoint` | `saved_connection_id`、`database`；database 按现有数据库/schema/main 语义解释 |
| `DataTaskRequest` | `protocol_version = 1`、`kind: row_sync / transfer`、`source`、`target`、`mappings`、`mode`；模式须与 kind 匹配 |
| `TableMapping` | `source_table`、`target_table`、`columns: ColumnMapping[]`；不允许两个源映射到同一目标表 |
| `ColumnMapping` | `source_column`、`target_column`；不接受 SQL 表达式或任意转换脚本 |
| `DataTaskCapabilities` | 按组合、表和模式返回支持情况及结构化阻塞原因，不只返回数据库名称级布尔值 |
| `DataTaskPreview` | `task_id`、`plan_id`、`fingerprint`、端点/表摘要、统计、采样时间、`expires_at`、`risks`、`blockers`、`can_execute` |
| `DataDiffPage` | `plan_id`、`table_id`、`items`、`next_cursor`；`page_size` 最大 200，IPC 单页最大 1 MiB，超大值仅显示截断预览及原始长度 |
| `ExecuteDataTaskInput` | `plan_id`、`fingerprint`、`execution_id`、`accepted_risk_ids`；缺少破坏性风险确认时后端拒绝 |
| `DataTaskSnapshot` | 状态、单调 `sequence`、读/写/验证行数、字节、阶段耗时、预览/结果引用；所有可能超 JS 安全整数的量用十进制字符串 |
| `DataTaskResult` | 终态、`commit_state: none / committed / rolled_back / unknown / partial`、各表计数、错误码、清理错误、是否需重新核对目标 |

Tauri 命令（返回值均外包 `Result<..., DataTaskError>`）：

- `get_data_task_capabilities(source: DataEndpoint, target: DataEndpoint) -> DataTaskCapabilities`
- `start_data_task_preview(task_id: String, request: DataTaskRequest) -> DataTaskSnapshot`：快速返回，读取/比较异步进行；task_id 重复且请求不同则拒绝。
- `get_data_task(task_id: String) -> DataTaskSnapshot`：可获得 ready 时的预览摘要或终态结果。
- `get_data_task_diff(plan_id: String, table_id: String, cursor: Option<String>, page_size: u32) -> DataDiffPage`：只读后端快照，不再查询远端数据库。
- `execute_data_task(input: ExecuteDataTaskInput) -> DataTaskSnapshot`：登记 execution_id 后启动执行。
- `cancel_data_task(task_id: String) -> DataTaskSnapshot`：重复调用幂等；覆盖预览读取、比较、执行和校验。
- `list_data_tasks() -> Vec<DataTaskSnapshot>`：运行中记录和最近 100 条摘要，不返回行数据。
- `discard_data_task_preview(plan_id: String) -> ()`：只清理未执行预览，不删除运行中任务。

事件统一使用 `data-task-progress`，载荷含 `task_id`、可选 `execution_id` 和单调 `sequence`；前端先订阅再启动，重复/乱序事件丢弃，丢事件后通过 `get_data_task` 对账。

稳定错误码包括 `unsupported_capability`、`invalid_mapping`、`read_only_target`、`same_physical_target`、`plan_stale`、`plan_expired`、`task_busy`、`constraint_conflict`、`resource_limit`、`cancelled`、`outcome_unknown`；UI 使用中文消息，日志不得包含密码和完整数据值。

## 六、文件划分

以下均为**后续实施时**的文件清单，本次不创建或修改这些文件。

| 路径 | 职责 |
| --- | --- |
| `src-tauri/src/models/data_tasks.rs` | IPC 模型、状态和错误契约 |
| `src-tauri/src/commands/data_tasks.rs` | Tauri 入口、配置查找、权限守卫、事件发布 |
| `src-tauri/src/db/data_tasks/mod.rs` | 任务引擎门面、内部接口与类型导出 |
| `src-tauri/src/db/data_tasks/registry.rs` | 任务注册、幂等、状态机、取消、执行槽 |
| `src-tauri/src/db/data_tasks/metadata.rs` | 端点身份、批量元数据、映射、依赖预检 |
| `src-tauri/src/db/data_tasks/value.rs` | 无损值、键和类型兼容规则 |
| `src-tauri/src/db/data_tasks/spool.rs` | 加密快照、资源预算、外部排序、分页索引、清理 |
| `src-tauri/src/db/data_tasks/plan.rs` | 同步差异、传输计划、风险、指纹 |
| `src-tauri/src/db/data_tasks/executor.rs` | 执行前验证、写入、校验、提交裁决 |
| `src-tauri/src/db/data_tasks/history.rs` | 最近任务摘要、原子落盘、重启中断处理 |
| `src-tauri/src/db/data_tasks/adapters/{mysql,postgres,sqlite,sqlserver,clickhouse}.rs` | 各方言集合读取、值绑定、批写、锁、事务、取消；按阶段创建 |
| `src-tauri/src/db/data_tasks/adapters/mod.rs` | 适配器契约和能力分发 |
| `src-tauri/src/{lib.rs,commands/mod.rs,db/mod.rs,models/mod.rs}` | 模块、AppState、命令和退出处理注册 |
| `src-tauri/src/commands/temporary_database.rs` | 必要时抽取无业务文案的连接/清理辅助；保留旧端点规则 |
| `src/types/dataTasks.ts`、`src/services/dataTasks.ts` | 前端契约、invoke 封装、订阅和结果协调 |
| `src/stores/dataTaskStore.ts` | 独立任务状态；不往 localStorage 写原始行数据 |
| `src/utils/dataTaskCapabilities.ts`、`src/utils/dataTaskProgress.ts` | UI 能力文案、状态及统计格式化 |
| `src/components/dataTasks/DataTaskWizard.tsx` | 源目标、映射、策略、预检的共享向导 |
| `src/components/dataTasks/DataSyncPreview.tsx` | 行差异、列变化、删除风险确认 |
| `src/components/dataTasks/DataTransferPreview.tsx` | 传输数量、映射、类型转换和替换风险 |
| `src/components/dataTasks/DataTaskPanel.tsx`、`DataTaskResult.tsx` | 进度、取消、重开、结果及历史摘要 |
| `src/App.tsx`、`src/components/database/DatabaseOverview.tsx` | 全局入口、从当前库/选中表预填向导，按需加载 |
| `src/stores/tableDataStore.ts`、`src/services/dataTasks.ts` | 定向失效目标表数据/分页状态，保护未提交编辑 |
| `src/__tests__/dataTask*.test.ts`、`src/__tests__/DataTask*.test.tsx` | 状态、接口、向导、预览、事件、缓存等测试；具体文件见任务 |
| `src-tauri/src/db/data_tasks/tests.rs`、`integration_tests.rs` | 内存适配器/SQLite 自动测试、隔离真实数据库测试 |
| `scripts/data-tasks/validate.py` | 自有临时数据库夹具、查询计数、并发/故障/性能验收 |
| `docs/superpowers/manual-tests/2026-10-19-data-sync-and-transfer-matrix.md`、`README.md` | 后续验收矩阵及用户能力说明 |

## 七、实施任务

任务 1–9、12 为阶段 A；任务 10、11 分别为 B、C。每个任务先增加能证明关键行为的失败测试，再实施并跑对应验证；不为纯样式和文案机械补测试。下列提交信息只是后续实施建议，本次不提交。

### 任务 1：契约与任务生命周期

**文件：** 新建 `models/data_tasks.rs`、`db/data_tasks/{mod,registry}.rs`、`src/types/dataTasks.ts`；修改 Rust 模块注册。测试放 `registry.rs` 和 `src/__tests__/dataTaskContract.test.ts`。

**接口：** `DataTaskRegistry::register_preview(task_id, request)`、`begin_execution(input)`、`cancel(task_id)`、`snapshot(task_id)`；统一返回上文契约。

- [x] 写测试：非法 kind/mode 拒绝；同一 execution_id 只执行一次；先取消后登记生效；过期计划不可启动；提交中取消不能变成已回滚；旧 sequence 不覆盖终态。
- [x] 实现状态转移、原子执行槽、计划/执行 ID 绑定、任务保留上限，保证不得持有注册表锁执行数据库或磁盘 I/O。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml data_tasks::registry` 与 `npm test -- src/__tests__/dataTaskContract.test.ts`，预期上述断言全部通过。

建议提交：`feat: 增加数据任务契约与生命周期管理`。

### 任务 2：无损值与有界快照

**文件：** 新建 `db/data_tasks/value.rs`、`spool.rs`，测试就近内联；复用 `util/secure_fs.rs` 和已有加密依赖。

**接口：** `DataValue`、`CanonicalRow`、`SpoolWriter::push_batch`、`SpoolWriter::finish -> SpoolHandle`、`SpoolHandle::read_page`、`external_sort -> SortedSpool`、`ResourceBudget`。

- [x] 写测试：`9007199254740993`、u64 上界、高精度 decimal、NULL/空串、0x00 二进制、时区与微秒精度、NaN/Infinity；复合键长度前缀避免拼接碰撞。
- [x] 写边界测试：8 MiB 单行、64 MiB 缓冲预算、5 GiB 配额的缩小模拟、损坏密文、nonce 唯一、文件写失败模拟、取消/过期清理、分页不把完整 spool 加载入内存。
- [ ] 真实文件系统 ENOSPC（磁盘满）注入与清理验收；配额拒绝和写失败模拟不能代替物理磁盘满。
- [x] 实现有界批次编码、带认证的加密块、外部排序和分页索引；中间文件全部计入配额；密钥不持久化。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml data_tasks::value` 和 `cargo test --manifest-path src-tauri/Cargo.toml data_tasks::spool`；预期无精度损失、无超预算静默截断。

建议提交：`feat: 增加无损数据值与有界快照存储`。

### 任务 3：端点、元数据和能力预检

**文件：** 新建 `db/data_tasks/metadata.rs`、`adapters/mod.rs`；必要时抽取 `commands/temporary_database.rs` 中的通用辅助。测试在 metadata 模块。

**接口：** `resolve_endpoints(request) -> ResolvedEndpoints`、`load_data_metadata(endpoint) -> DataMetadataSnapshot`、`validate_mapping(request, source, target) -> ValidatedMapping`、`get_capabilities(...) -> DataTaskCapabilities`。

- [x] 写测试：仅比较保存连接 ID 不足以排除同库同表；SQLite canonical path/文件身份相同被拒绝；网络端点结合可获得的服务实例身份、database/schema/table 归一化，不能确认源目标隔离时阻塞破坏性操作。
- [x] 写测试：相同保存连接下不同库可按能力使用；普通自增主键可保留；只读目标、实例只读、视图、缺表、缺列、非空无默认列、共享/权限不足的生成器、重复目标表、无主键同步、未识别排序规则、触发器、外键环、RLS/权限不可验证均有明确原因。
- [x] 实现固定次数批量元数据读取和内存校验；同类型规则仅用于 row_sync，跨类型传输由阶段能力开关控制，不修改现有结构同步的限制。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml data_tasks::metadata`；以 SQLite trace 与 PostgreSQL TCP 协议真实计数验证 1/10/100 表的固定元数据预算。

建议提交：`feat: 增加数据任务能力与映射预检`。

### 任务 4：行差异、传输预览与指纹

**文件：** 新建 `db/data_tasks/plan.rs`，使用任务 2/3 的类型、快照和映射；测试放同模块。

**接口：** `build_row_sync_plan(request, snapshots) -> StoredDataPlan`、`build_transfer_plan(request, snapshots) -> StoredDataPlan`、`fingerprint(plan) -> String`；`StoredDataPlan` 内含后端快照引用，IPC 只返回 `DataTaskPreview`。

- [x] 固定用例：源 `(1,A),(2,B)`、目标 `(2,old),(3,C)`；合并结果统计为 insert=1/update=1/retained=1/delete=0，镜像为 insert=1/update=1/delete=1；空源镜像产生清空风险，空源追加为零操作。
- [x] 写测试：复合主键、重复/空键、列顺序变化、规范化小数、大小写冲突、无变化、不同顺序相同快照、每个重要输入改变均影响指纹；对缺少数据内容的结构指纹不得视作足够保护。
- [x] 实现排序归并、精确统计、分页差异索引、参数化 DML 示例和风险列表；不为每行生成并持久化独立 SQL。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml data_tasks::plan`；预期同一逻辑输入指纹稳定，关闭删除时执行计划中没有删除。

建议提交：`feat: 增加表数据差异与传输计划预览`。

### 任务 5：SQLite 与 PostgreSQL 适配器

**文件：** 新建 `adapters/sqlite.rs`、`postgres.rs` 及 `db/data_tasks/tests.rs`；注册模块。

**接口：** 每种适配器实现 `read_snapshot(...) -> RowBatchStream`、`begin_protected_write(...) -> WriteSession`、`write_batch(...)`、`verify_snapshot(...)`、`commit/rollback/cancel`；SQLite blocking 驱动通过有界通道衔接，不阻塞 Tokio 工作线程。

- [x] 先用临时 SQLite 文件测试全流程：不同列形状多表的单 SELECT 流、主键同步、无主键追加、替换回滚、外键顺序、只读文件、取消后锁释放。
- [x] PostgreSQL 隔离库测试相同行为，补充 schema 引用、精确 numeric、bytea、时间类型、用户权限、一致读取、事务锁，以及 serial/identity 显式键保留和生成器高水位维护；SQLite 验证 INTEGER PRIMARY KEY/AUTOINCREMENT 对应行为。
- [x] 两连接竞态测试：预览后修改目标导致零写入；执行校验与写入间另一连接不能插入幻影行；最终验证失败回滚所有目标表。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml data_tasks::adapters::sqlite` 和 `cargo test --manifest-path src-tauri/Cargo.toml data_tasks::adapters::postgres`；真实 PostgreSQL 测试通过后才能开启对应能力。

建议分别提交：`feat: 支持 SQLite 数据同步与传输`、`feat: 支持 PostgreSQL 数据同步与传输`。

### 任务 6：MySQL/MariaDB 与 SQL Server 适配器

**文件：** 新建 `adapters/mysql.rs`、`sqlserver.rs`；扩展任务 5 的共同契约测试。

- [x] MySQL/MariaDB 测试：非事务表拒绝、连接字符集、unsigned bigint、decimal、binary、AUTO_INCREMENT 显式键/高水位/回滚间隙、锁/事务控制顺序、一致读取、只读实例、驱动取消后连接丢弃；不支持集合载荷所需能力的版本预检阻塞。
- [x] SQL Server 测试：连接 database 与 schema 定位、参数预算、nvarchar、datetime2/datetimeoffset、decimal、varbinary、identity 键保留与会话设置恢复、computed/rowversion 排除、快照隔离不可用时的行为、取消不支持时关闭专属会话并确认回滚。
- [x] 完成集合读取与批量绑定；锁语义通过双连接并发、幻读和目标结构变化测试，不复用普通编辑器的“取消不支持”路径假装已撤销。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml data_tasks::adapters::mysql` 和 `cargo test --manifest-path src-tauri/Cargo.toml data_tasks::adapters::sqlserver`；分别用真实 MySQL、MariaDB、SQL Server 夹具验收，未验证的组合保持关闭。

建议分别提交：`feat: 支持 MySQL 数据同步与传输`、`feat: 支持 SQL Server 数据同步与传输`。

### 任务 7：执行编排、校验和故障裁决

**文件：** 新建 `db/data_tasks/executor.rs`；补充 registry 和 `tests.rs`。

**接口：** `prepare_task(request, context) -> StoredDataPlan`、`execute_plan(plan, cancellation, progress) -> DataTaskResult`；以 `WriteSession` 固定同一物理会话完成锁定、重读、写入、校验、提交。

- [x] registry 与真实 SQLite/网络适配器测试：旧配置/旧结构/旧目标内容/过期计划均不发业务 DML；缺少删除确认被拒绝；相同执行 ID 重发只提交一次。
- [x] 故障注入：第 N 批失败、最终校验不符、取消、回滚失败、COMMIT 前断线、COMMIT 响应丢失分别得到准确终态；结果不明绝不自动重试。
- [x] 实现内存依赖排序与集合 DML 批次；合并验证预期为“源快照覆盖同键 + 保留目标独有”，镜像/替换验证为源映射结果，追加验证为目标基线加源数据的多重集合。
- [x] 实现超时/取消、进度节流和清理；业务结果和 cleanup_errors 分开记录，已提交不能因为关闭连接失败显示为未提交。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml data_tasks::integration_tests`，结合 registry 与 acceptance_network_tests；SQLite 端到端覆盖同步、追加、替换和回滚。原 executor 过滤器没有测试，不再用其零匹配结果验收。

建议提交：`feat: 实现数据任务事务执行与结果校验`。

### 任务 8：命令、历史与应用生命周期

**文件：** 新建 `commands/data_tasks.rs`、`db/data_tasks/history.rs`；修改 `lib.rs`、模块注册；新建 `src/services/dataTasks.ts`。

- [x] 命令测试：前端伪造路径/行载荷不被接受；错误脱敏；先订阅后执行和丢事件后查询可恢复正确状态。
- [ ] 单独注入 Tauri 原生事件发送失败，验证数据库已提交结果不被改写。
- [x] 历史仅保存端点引用、表名、模式、计数、时间、状态和错误码，不保存凭据、全量数据、SQL 参数或完整错误数据值；JSON 采用临时文件写入后原子替换，最多 100 条。
- [x] 重启不重放任务；对可能已发送提交的遗留记录标注需核对，对未开始写入的预览标注中断，清理本应用管理目录中的失效快照。
- [x] Tauri 窗口关闭与应用退出共用继续等待/取消后退出流程，保持窗口可见，终态前不退出；4项生命周期单测通过。
- [ ] 在 macOS/Linux/Windows 实际窗口中验收关闭、继续等待、取消后退出和临时目录权限。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml commands::data_tasks`、`cargo test --manifest-path src-tauri/Cargo.toml data_tasks::history`、`npm test -- src/__tests__/dataTaskService.test.ts`。

建议提交：`feat: 接入数据任务命令进度与历史记录`。

### 任务 9：前端向导、预览和结果面板

**文件：** 新建上述 `components/dataTasks/` 组件、`stores/dataTaskStore.ts`、`utils/dataTaskCapabilities.ts`、`utils/dataTaskProgress.ts`；修改 App、DatabaseOverview 和必要的表数据失效接口。

- [x] 在页脚并列提供“数据同步”“数据传输”，数据库概览选中表可预填向导；与现有“数据库对比/结构同步”文案明确区分。按现有 DeferredFeature 模式懒加载。
- [x] 向导顺序：源/目标 → 表与字段映射 → 模式 → 预检/读取 → 预览 → 确认执行 → 结果。切换端点/模式立即废弃旧预览，保存连接列表变更同步提示。
- [x] 同步预览显示新增/修改/删除/保留数量和分页行差异；传输预览显示准确行数、映射与转换风险。镜像/替换需明确确认目标范围和删除数量，空源清空单独确认。
- [x] 运行中可关闭面板再打开；扫描用不定进度，执行显示处理数量与阶段。取消显示“正在取消/等待回滚”，提交中显示“正在确认提交结果”，不提前显示完成。
- [x] 成功、部分成功和结果不明均按可能受影响目标表失效缓存；新增 `markTableDataStale(connId, database, table)`，保留 `pendingChangesCache`，存在未提交编辑时提示数据已变化，不能调用会删除草稿的缓存移除方法代替。
- [x] 新建测试：`dataTaskStore.test.ts`、`dataTaskService.test.ts`、`dataTaskProgress.test.ts`、`DataTaskWizard.test.tsx`、`DataTaskPreview.test.tsx`、`DataTaskPanel.test.tsx`、`dataTaskInvalidation.test.ts`。覆盖乱序事件、重复点击、弹窗重开、过期计划、模式能力、目标编辑保护和零变化。
- [x] 运行 `npm test -- src/__tests__/dataTaskStore.test.ts src/__tests__/dataTaskService.test.ts src/__tests__/dataTaskProgress.test.ts src/__tests__/DataTaskWizard.test.tsx src/__tests__/DataTaskPreview.test.tsx src/__tests__/DataTaskPanel.test.tsx src/__tests__/dataTaskInvalidation.test.ts src/__tests__/AppLazyFeatures.test.tsx`，预期全通过。

建议提交：`feat: 增加数据同步与传输向导及任务面板`。

### 任务 10：跨类型数据传输（阶段 B）

**依赖：** 阶段 A 验收通过。**文件：** 扩展 `value.rs`、`metadata.rs`、四类适配器与 `DataTransferPreview.tsx`；新增 `db/data_tasks/type_mapping.rs`。

- [x] 定义 `resolve_transfer_type(source_type, target_type) -> Compatible / RequiresExplicitMapping / Unsupported`，第一版仅放开范围可证明包含的整数、小数、布尔、文本、二进制和明确兼容的时间类型；无损失败直接阻塞。
- [x] 显式阻塞 decimal 精度缩小、有符号转无符号溢出、文本截断、时区丢失、枚举/数组/空间/自定义类型隐式转字符串；字段重命名不改变类型规则。
- [x] 按有向源→目标组合逐个验收，不因 A→B 通过自动开放 B→A；目标已存在，继续不自动翻译 DDL，不处理跨类型行同步。
- [x] 运行 `cargo test --manifest-path src-tauri/Cargo.toml data_tasks::type_mapping` 和隔离矩阵中的全部已开放有向组合；已开放方向逐值无损回读、追加/替换、冻结源和写入前拒绝得到真实验证；查询预算单列于任务12。

建议提交：`feat: 支持受限类型的跨数据库数据传输`。

### 任务 11：ClickHouse 追加传输（阶段 C）

**2026-10-22 复核：** 原目标写入条目继续阻塞。批次之间 RENAME/CREATE 会替换目标；单条流式 INSERT 可固定已解析对象，但同查询 UUID/依赖检查与依赖绑定之间仍存在窗口。真实隔离实验中新建物化视图收到数据，不能用单流加守卫宣称预览身份保护成立。正式适配器写入口也直接拒绝，实验写入仅编译进测试。以下目标批次条目可作为原生实验验收，但不满足公共写入开放条件；ClickHouse→ClickHouse 同样阻塞。源→事务目标独立验收，不能用其通过代替目标安全保证。

**依赖：** 阶段 B 的类型映射与任务框架。**文件：** 新建 `adapters/clickhouse.rs`，扩展能力矩阵、结果与 UI 测试。

- [x] 首先验证单次集合流、Nullable/Decimal/DateTime64/UInt64 等类型；未覆盖类型明确拒绝，不借用显示值 JSON 拼 INSERT。
- [ ] ClickHouse 为目标时仅开放经验证的直接本地表引擎和普通追加写入；Distributed、异步插入及可能重新解释重复行的特殊引擎先阻塞。完成意味着数据库确认接收已记录批次，不伪造全库事务保证。
- [ ] 每批记录确认状态和累计行数；第 N 批失败返回 partial，响应丢失返回 outcome_unknown，禁止自动重放。不将 ClickHouse 排序键当作唯一主键，不开放镜像、UPDATE、DELETE 或替换。
- [x] ClickHouse 为源、四类事务库为目标时保留目标事务保证，展示源端无跨表一致快照限制；四方向受限追加已验收。
- [ ] ClickHouse→ClickHouse 目标身份/依赖保护及公开批次语义验收（当前禁用）。
- [x] 最终复跑 ClickHouse 真实模块16项通过；正式写入口拒绝与伪造能力标记守卫单测通过。此结果覆盖源能力/保护/实验，不代表目标开放。

建议提交：`feat: 支持 ClickHouse 受限追加传输`。

### 任务 12：集成、性能与发布验收

**文件：** 新建 `db/data_tasks/integration_tests.rs`、`scripts/data-tasks/validate.py` 和手工矩阵；更新 README。夹具只使用专属临时 SQLite 文件及脚本创建的隔离数据库，不读取个人保存连接。

- [x] 自动数据集包含：空表、百万行、100 表、复合主键、无主键追加、中文/保留字标识符、宽表、8 MiB 边界行、大整数、精确小数、二进制、时间、NULL、外键、唯一冲突及不同排序规则。
- [x] 真实驱动验收事务锁、取消、读写权限、网络中断、磁盘配额、提交不明；MariaDB 单独验证。PostgreSQL TLS通过正确/错误CA、DNS校验、断链及专属连接归零四项。
- [ ] SSH 隧道中断与连接/临时文件清理：现入口会写用户 known_hosts，需先提供隔离目录或测试入口；不覆盖HOME或触碰个人known_hosts。
- [x] SQLite/PG真实计数：1/10/100表元数据固定4/5次SELECT，每端每次快照数据SELECT=1；PG协议同时统计实际DML与COMMIT，证明未知提交不重放。MySQL另有100表元数据预算验收。
- [ ] 补齐其余驱动全部1/10/100表的独立协议查询计数记录；集合读取实现不能代替全部规模的真实计数。
- [x] 百万行传输超过现有 100,000 行普通查询上限仍完整；比较 10 万与 100 万同宽行的 RSS 和临时磁盘峰值，缓冲分配受 64 MiB 预算控制，内存不得随总行数线性增长。本机SQLite release耗时/RSS/临时磁盘/缓冲峰值见独立性能报告；本轮未重复性能测试，不将历史结果计作本次新测。
- [x] UI取消立即进入cancelling并等待后端终态；PG原生取消覆盖首行前查询/目标锁，等待原操作响应后再回滚；回滚和COMMIT确认均有10秒预算，无法确认则Unknown，不重放。
- [ ] 其余驱动全部阶段及不同负载的取消/完整清理时延矩阵；本机PG数据不能替代这些测量。
- [x] 前端懒加载、IPC分页上限、模式切换/草稿上下文隔离、未提交编辑保护有自动回归。三平台实机行为见任务8未完成项。
- [x] 更新 README 和手工验收矩阵，分阶段列出支持组合、源快照语义、目标锁时段、事务边界、阻塞条件、失败后的操作方式。

最终检查命令（仅在后续实施完成时运行）：

```bash
npm test
npm run build
npm run lint
npm run format:check
npm run test:rust
npm run lint:rust
npm run fmt:rust
python3 scripts/data-tasks/validate.py --phase a
# 阶段 B/C 完成后分别运行 --phase b / --phase c
```

`validate.py` 已随实现新增，逐项输出 passed/failed/not_run/blocked；未安装数据库、没有 Docker 或没有匹配测试不得把跳过视作通过，非零退出区分环境阻塞与测试失败。最终实际运行结果以验收矩阵为准。

建议提交：`test: 补充数据同步传输集成与性能验收`、`docs: 补充数据同步传输使用说明`。

## 八、依赖顺序与完成标准

实施顺序：`1 → 2/3 → 4 → 5/6 → 7 → 8 → 9 → 12(A) → 10 → 12(B) → 11 → 12(C)`。任务 2/3 可按文件并行；适配器 5/6 共享契约稳定后可并行；任务 9 可先基于固定契约完成组件测试，但真实执行验收依赖任务 8。

阶段 A 完成必须同时满足：

- [x] 四类数据库的同类型行同步、追加、替换均有真实适配器验证；不支持的表/类型给出可操作原因。
- [x] 只读预览无业务写入；指纹与目标漂移保护不能绕过；镜像与替换默认关闭。
- [x] 百万行完整传输、精确值保持、SQL 查询预算、取消/回滚/提交不明路径均有证据。
- [x] 现有结构同步、SQL 导入导出、分页编辑、连接管理和首屏懒加载回归通过。
- [x] 成功只在数据库提交得到确认后展示；记录清理失败和结果不明，用户可重新打开任务查看。

- [ ] 任务8/12中发布级实机与故障扩展验收全部完成（含SSH、三平台、真实ENOSPC及其他驱动计数/取消时延）。核心功能已有证据不代表本完整验收阶段结束。

阶段 B/C 分别按矩阵单独完成；没有实现的能力继续禁用，不使用文档或入口代替实现。

最初仅计划阶段的文档目标已完成，后续实施获单独授权。当前完成标准为上述各项条件具备对应证据；未验收、受阻塞或捆绑未完成条件的条目继续保留未勾选，不能由实现存在或部分测试通过推定整个计划完成。
