# 数据同步与传输验收矩阵

设计与范围：[实施计划](../plans/2026-10-19-data-sync-and-transfer-plan.md)。本矩阵记录实际证据；代码存在、入口可见或跳过测试均不代表支持。

更新于 2026-10-21。下表记录本轮定向验收；Rust 全量与 Clippy 最终回归待汇总，不宣称整个计划已完成。

## 隔离规则

自动测试使用专属随机 SQLite 文件，网络测试只使用 `DB_CONNECT_DATA_TASK_*_URL` 指向的显式隔离实例；夹具自行创建并清理随机命名空间。`validate.py` 创建的容器使用 `db-connect-data-task-validate-` 前缀，只绑定回环地址和随机端口，只删除本次创建的容器。不得使用应用保存连接或个人业务数据库运行破坏性验收。

环境变量：PostgreSQL 为 `DB_CONNECT_DATA_TASK_PG_URL`；MySQL、MariaDB 分别为 `DB_CONNECT_DATA_TASK_MYSQL_URL`、`DB_CONNECT_DATA_TASK_MARIADB_URL`；SQL Server 为 `DB_CONNECT_DATA_TASK_SQLSERVER_URL`；ClickHouse 为 `DB_CONNECT_DATA_TASK_CLICKHOUSE_URL`。未提供实例、无 Docker、容器未就绪、没有匹配测试均记为 `not_run`。

## 阶段与开放条件

|阶段|范围|开放条件|
|---|---|---|
|A|SQLite、PostgreSQL、MySQL/MariaDB、SQL Server 同类型合并、镜像、追加、替换|各真实驱动的完整事务、值绑定、锁、取消与生成器验收通过|
|B|四类事务数据库之间的有向追加/替换|逐个方向验证类型范围、无损回读、回滚及相同查询预算；不开放跨类型行同步|
|C：源|ClickHouse → 四类事务目标的受限追加|逐方向验证类型与目标事务；源不提供跨表一致快照；本轮四方向真实验收通过|
|C：目标|所有 ClickHouse 目标组合当前 blocked|按名多批 INSERT 不能防止批次间 DDL 替换目标；在可证明的对象身份/DDL 保护机制完成前不开放公共写入|

## 自动证据

2026-10-22 最终 Rust 回归：873 passed / 0 failed / 69 ignored；显式真实库验收另见 [阶段 C 综合报告](data-task-validation-c-2026-10-22.json)。`cargo fmt --check`、`cargo clippy --all-targets -- -D warnings` 和 `git diff --check` 通过。前端最近一次全量为 169 文件 / 2206 测试通过，构建及 ESLint 通过；变更文件 Prettier 通过，全局 67 个格式问题均已核对存在于 HEAD，未顺带重排。

综合工具退出码为 `2`：本轮显式跳过重复性能测试（实际性能证据在独立报告中），且 ClickHouse 目标未开放；报告无 failed，不能解读为阶段 C 全部完成。

|项目|状态|证据|
|---|---|---|
|前端契约、向导、进度、历史、乱序事件与草稿保护|passed|169 文件、2206 项 Vitest；构建及 ESLint 通过（首次集成记录，后续最终回归另记）|
|SQLite 元数据查询预算|passed|真实 trace：1/10/100 表均 4 次 SELECT|
|SQLite 数据读取查询预算|passed|真实 trace：1/10/100 表每次快照均 1 次集合 SELECT|
|PostgreSQL 查询预算|passed|真实 TCP 协议统计 Execute：1/10/100 表均 5 次元数据 SELECT、1 次快照 SELECT；预编译语句重复执行也计数|
|超过普通查询行数上限、大整数和二进制|passed|100002 行专用流及加密 spool，`9007199254740993` 精确保持|
|任务幂等、取消、过期、互斥和提交状态|passed|registry 定向测试；终态不会被后续旧进度覆盖|
|历史脱敏、原子写入和重启未知状态|passed|history 定向测试；拒绝符号链接，不自动恢复执行|
|配置删除/变更、只读后端守卫、多进程目录保护|passed|commands 定向测试；内存配置摘要与独占目录锁|
|PostgreSQL 适配器|passed|适配器定向 10 项通过；覆盖权限、外部入向 FK、继承、写规则及规则漂移、序列锁与回滚|
|SQL Server 外部依赖可见性|passed|受限 schema 授权、数据库级授权叠加对象/schema DENY、成员角色/public DENY 和隐藏 RLS 的真实回归；完整适配器 7 项通过，固定查询类别未增加|
|PostgreSQL COMMIT 响应丢失|passed|真实 TCP 代理收到服务器 COMMIT CommandComplete 后断开；任务为 OutcomeUnknown / Unknown，独立连接确认 2 行已提交，INSERT 与 COMMIT 各执行 1 次，无重放；协议验收模块合计 5 项通过（4 项真实库、1 项计数单测）|
|MySQL 与 MariaDB|passed|分别在专属实例运行 real_contract，均覆盖完整任务执行器；MariaDB 不沿用 MySQL 的结果|
|跨类型事务目标（阶段 B）|passed|12 个有向组合逐一验证 Append + Replace；矩阵共 14 项通过，另含 PostgreSQL 四模式及 SQL Server 四模式取消与回滚|
|百万行、RSS 与临时磁盘峰值|passed|同宽 10 万/100 万行 release 实测见下表；完整传输且清理后 spool 为 0|
|ClickHouse 源 → SQLite / PostgreSQL / MySQL / SQL Server|passed|四方向实际执行、逐值回读与目标事务验证通过；CH 模块共 13 项真实验收同时覆盖原生精度与目标拒绝零写入|
|ClickHouse 目标（包括 ClickHouse→ClickHouse）|blocked|并发 RENAME + CREATE 同名表可令后续 INSERT 落入不同 UUID 的表；已决定关闭公共目标写入。原生写入实验不计为开放验收|
|跨平台退出、临时目录权限及 SSH/TLS 故障|not_run|尚未完成对应平台/连接的实际操作；PG 回环明文代理仅证明 COMMIT 响应丢失路径|

### 阶段 B 有向组合

以下每个方向分别覆盖追加和替换；表内 MySQL 为专属 MySQL 夹具，MariaDB 的同类型行为由独立 real_contract 验收，不将其扩展为所有跨类型方向的证据。

|源|已验收的目标|状态|
|---|---|---|
|SQLite|PostgreSQL、MySQL、SQL Server|passed|
|PostgreSQL|SQLite、MySQL、SQL Server|passed|
|MySQL|SQLite、PostgreSQL、SQL Server|passed|
|SQL Server|SQLite、PostgreSQL、MySQL|passed|

类型边界：跨类型当前只开放整数范围包含、文本和二进制同族映射；其余跨类型家族在无完整规范值验收前阻塞。ClickHouse `String` 按任意字节保存，只映射到目标二进制列；`Nullable` 仍需目标允许空值。ClickHouse 原生 Decimal/DateTime64 的精度测试不代表这些类型已开放跨库映射。

### 性能实测

2026-10-21，macOS 本机 release 测试 `acceptance_tests::sqlite_million_rows_transfer_is_complete`，两个独立进程使用同宽数据集。耗时为测试输出的任务耗时，RSS 为系统报告的进程最大常驻集，临时磁盘与缓冲为任务计数器峰值，单位均为字节。

|行数|任务耗时|最大 RSS|临时数据峰值|任务缓冲峰值|结束后 spool|
|---|---:|---:|---:|---:|---:|
|100,000|19.571 秒|36,503,552|70,600,000|33,554,590|0|
|1,000,000|323.947 秒|85,262,336|706,000,000|33,554,590|0|

RSS 增量为 48,758,784 字节，小于 64 MiB；行数增加十倍时任务缓冲峰值不变。64 MiB 限制针对任务数据缓冲，不代表整个进程 RSS 上限。该测量只证明本机 SQLite 数据集表现，不是其他数据库的吞吐承诺，也未测量全部平台的取消清理耗时。脱敏指标保存在 [性能报告](data-task-performance-2026-10-21.json)。原始日志：`/private/tmp/db-connect-perf-release-100k.log`、`/private/tmp/db-connect-perf-release-1m.log`（本机临时证据，不随仓库分发）。

## 手工检查

以下内容需在对应平台和应用构建中实际操作，未运行不得勾选：

本轮以下手工项均为 `not_run`。部分路径已有上表自动证据，但捆绑的 UI、平台或故障条件未全部验收，故不勾选整项。

- [ ] macOS / Linux / Windows：关闭面板并重开，任务仍可查询；关闭有任务的窗口不误报任务取消；退出应用可继续等待或取消后退出。
- [ ] 预览后分别修改目标数据、目标结构、保存连接；旧计划被拒绝，目标业务表零写入。
- [ ] 合并源 `(1,A),(2,B)`、目标 `(2,old),(3,C)` 得到 `(1,A),(2,B),(3,C)`；镜像得到 `(1,A),(2,B)`。
- [ ] 镜像和替换明确展示目标范围、删除数量；空源删除需额外确认；追加空源为零操作。
- [ ] 首批之后注入唯一冲突、取消和最终校验失败；事务库所有目标表回滚，锁和专属连接释放。
- [ ] 执行重读与 DML 之间通过第二连接尝试插入幻影行和修改结构；被目标保护锁阻止，锁超时不无限等待。
- [ ] 验证生成器显式键保留、默认后续插入、回滚间隙与并发生成行为；不回退计数器，不改写外键。
- [ ] 无主键同步、可空主键、未知排序规则、触发器、RLS、外键环、外部依赖和不支持类型给出明确阻塞原因。
- [ ] `BIGINT`、unsigned 上界、精确小数、二进制、中文、时区、微秒、NULL、空串、重复行按支持类型逐值回读。
- [ ] 超大行、磁盘限额、加密文件损坏、SSH/TLS/网络断开和提交响应丢失得到准确终态，不自动重试未知结果。
- [ ] 目标表有未提交单元格编辑时完成数据任务：草稿保留并显示目标已变化，分页和总数缓存不复活旧结果。
- [ ] 首屏未加载任务面板大组件，100 表映射和分页差异保持可用，单页不超过 200 行与 1 MiB。

## 事务边界

预览不持有目标写锁。事务库执行在单个目标事务/物理会话内锁定、重读、批写、完整集合校验并提交；不提供跨源目标的分布式事务。业务行回滚不保证数据库序列或自增消耗回退，生成器可能留下间隙。提交已确认后，临时文件或连接清理失败仅记为 `cleanup_errors`，不把已提交结果改为失败或未提交。
