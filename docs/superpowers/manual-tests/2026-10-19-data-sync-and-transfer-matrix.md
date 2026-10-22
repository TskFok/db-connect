# 数据同步与传输验收矩阵

设计与范围：[实施计划](../plans/2026-10-19-data-sync-and-transfer-plan.md)。本矩阵记录实际证据；代码存在、入口可见或跳过测试均不代表支持。

更新于 2026-10-22。记录当前实现、实际自动验收和仍未运行的实机条件；ClickHouse 目标仍受阻塞，不宣称原计划全部完成。

## 隔离规则

自动测试使用专属随机 SQLite 文件，网络测试只使用 `DB_CONNECT_DATA_TASK_*_URL` 指向的显式隔离实例；夹具自行创建并清理随机命名空间。`validate.py` 创建的容器使用 `db-connect-data-task-validate-` 前缀，只绑定回环地址和随机端口，只删除本次创建的容器。不得使用应用保存连接或个人业务数据库运行破坏性验收。

环境变量：PostgreSQL 为 `DB_CONNECT_DATA_TASK_PG_URL`；MySQL、MariaDB 分别为 `DB_CONNECT_DATA_TASK_MYSQL_URL`、`DB_CONNECT_DATA_TASK_MARIADB_URL`；SQL Server 为 `DB_CONNECT_DATA_TASK_SQLSERVER_URL`；ClickHouse 为 `DB_CONNECT_DATA_TASK_CLICKHOUSE_URL`。未提供实例、无 Docker、容器未就绪、没有匹配测试均记为 `not_run`。

## 阶段与开放条件

|阶段|范围|开放条件|
|---|---|---|
|A|SQLite、PostgreSQL、MySQL/MariaDB、SQL Server 同类型合并、镜像、追加、替换|各真实驱动的完整事务、值绑定、锁、取消与生成器验收通过|
|B|四类事务数据库之间的有向追加/替换|逐个方向验证类型范围、无损回读、回滚及相同查询预算；不开放跨类型行同步|
|C：源|ClickHouse → 四类事务目标的受限追加|逐方向验证类型与目标事务；源不提供跨表一致快照；四方向真实验收通过|
|C：目标|所有 ClickHouse 目标组合当前 blocked|多批按名写入可被DDL替换目标；单流加同查询UUID/依赖检查仍非原子绑定。正式适配器写入口也直接拒绝，实验实现仅cfg(test)|

## 自动证据

### MySQL 5.5 起的旧版兼容（2026-10-22）

在既有 5.7/8.0/8.4/9.7 支持上，新增 **5.5.8+ 的 5.5 系列**和 **5.6.10+ 的 5.6 系列**，包含原生 `-log` 后缀及官方修订版 `5.5.25a`。两条新系列的下限为各自首个 GA；5.7 继续保留既有 5.7.8 下限。根据用户确认，最低覆盖 5.5，不开放 5.0/5.1。版本门禁覆盖系列范围，真实验收只代表表中列出的补丁。

集合快照改用固定 JSON 结构加 HEX 字段编码，由 `CONCAT` 组装，避免依赖 5.7 才具备的 JSON 构造函数。文本、整数、小数、日期时间先使用明确的 UTF-8 表示再编码，二进制直接编码，NULL 与空串区分；解码拒绝非法 HEX 和 UTF-8。仍以单个 `UNION ALL` 查询获取多表快照，不在循环中查询 SQL。元数据固定查询预算和行大小上限保持不变。HEX 约使字段载荷翻倍，单行还受服务端 `max_allowed_packet` 约束，超限会失败而非静默截断。

5.5 一致性快照不附加其不支持的 `READ ONLY` 事务语法，应用只读及权限守卫继续执行。5.5 时间列只提供秒精度，微秒列向秒精度列传输在预览时拒绝；秒精度向新版微秒列传输允许，快照和跨数据库 MySQL 目标统一去掉时间小数尾零，保留非零精度。真实用例使用整数主键，同时核对 DATETIME/TIMESTAMP/TIME 字段及正负 838 小时时长，防止补零造成最终校验失败；时间主键仍受既有同步能力门禁限制。

验收器为 5.5/5.6/5.7 选择 amd64 镜像，在 ARM64 主机使用仿真；兼容旧版两行就绪日志，探活不执行 SQL。复验命令：

```sh
python3 scripts/data-tasks/validate_mysql_versions.py \
  --images mysql:5.5.62 mysql:5.6.51 mysql:5.7.19 mysql:5.7.44 \
    mysql:8.0.11 mysql:8.0.36 mysql:8.0.46 mysql:8.4 \
  --reference-image mysql:9.7 \
  --report artifacts/data-tasks/mysql-legacy-versions.json
```

本机 Docker/containerd 拒绝 `mysql:5.7.9` 的旧版 v1 镜像清单，因此早期 5.7 实测选用可加载的 5.7.19；不把 5.7.9 记为实测。5.5/5.6 的权限夹具用户名缩短为不超过 16 字符，仍实际验证 SELECT-only、目标完整权限和实例只读状态。

最终 MySQL 版本矩阵 **25 passed / 0 failed / 0 not_run**：9 个单库完整合约，加 16 个双实例跨版本方向，均覆盖合并、镜像、追加、替换。9 个专属容器及匿名数据卷全部清理。实际服务端版本及方向如下，原始结果、镜像摘要、测试程序指纹和清理记录见[旧版扩展最终报告](data-task-mysql-legacy-versions-2026-10-22.json)。

|实际服务端版本|单库完整合约|与 9.7.4 的跨版本合约|
|---|---|---|
|5.5.62|passed|两个方向 passed，含时间精度扩大和缩窄拒绝|
|5.6.51|passed|两个方向 passed|
|5.7.19|passed|两个方向 passed|
|5.7.44|passed|两个方向 passed|
|8.0.11|passed|两个方向 passed|
|8.0.36|passed|两个方向 passed|
|8.0.46|passed|两个方向 passed|
|8.4.11|passed|两个方向 passed|
|9.7.4|passed|参考实例，已包含上方 16 个方向|

由于 MySQL/MariaDB 共用快照通道，另在隔离 MySQL 8.4.11、MariaDB 11.4.13、PostgreSQL 17 和 SQL Server 2022 容器上执行完整跨类型回归：MySQL 与 MariaDB 各 1 项单库契约，加分别使用两者的 42 项跨类型矩阵，共 **86 passed / 0 failed**，四个专属容器及四个匿名数据卷均清理并核对不存在。见[跨类型回归报告](data-task-mysql-legacy-cross-types-2026-10-22.json)。跨类型报告的测试程序在最终 MySQL 版本矩阵之前构建，之后仅修正精度扩大测试夹具使用整数主键，生产实现没有变化。

本轮 Rust 全量 **893 passed / 0 failed / 108 ignored**；真实实例忽略项按独立报告显式执行，不计入默认全量通过数。Python 验收工具 **37 项通过**，Clippy、Rust 格式及 `git diff --check` 通过。版本门禁、HEX 解码、默认时间精度和补零规范化均有回归测试；未修改前端，本轮未重复前端测试。

### MySQL 多版本扩展（2026-10-22）

运行时新增接受 MySQL **8.0.11 及以上的 8.0 补丁版本**和 **9.7.x**，两系列均接受原生 `-log` 后缀；保留 5.7.8+、8.4 与 MariaDB 11.4。8.0 下限选择[首个 GA 版本 8.0.11](https://dev.mysql.com/doc/relnotes/mysql/8.0/en/news-8-0-11.html)。其他创新系列、预发布版本及第三方分支不因本次扩展自动放行。放行范围不代表逐个补丁均经过实测。

新增 `scripts/data-tasks/validate_mysql_versions.py`，只创建本次官方 MySQL 隔离容器，绑定回环地址随机端口，使用随机密码和独立匿名数据卷。工具不读取应用保存连接，并清除继承的数据任务 URL；5.7 和早期 8.0 在 ARM64 主机上使用 amd64 仿真。探活兼容 5.7 两行及新版单行就绪日志，排除初始化服务的 `port: 0`，不执行循环 SQL。

单库契约覆盖合并、镜像、追加、替换、完整精确值回读、冲突/取消回滚、并发写入与 DDL 保护、生成器、只读、权限及固定查询预算。新增跨版本契约要求两端服务端版本和实例标识均不同（当前使用 hostname/port/server_id 组合，以兼容没有 server_uuid 的 5.5），验证四模式的完整存储值、预览冻结源快照、父子外键追加/替换顺序，以及子表并发写入和父表 DDL 阻塞、回滚与解锁。MySQL 8.0.16+ 的 `partial_revokes` 在 `SHOW GRANTS` 中产生 `REVOKE` 时，权限预检保守阻塞，防止全局授权掩盖隐藏的跨库入向外键；单测及支持该变量的真实实例均覆盖此场景。

本轮实际结果：**16 passed / 0 failed / 0 not_run**，包括六个单库合约和下表十个跨版本方向；六个专属容器及匿名数据卷全部清理。真实补丁版本如下，未将未测试的补丁记为实测。

|实际服务端版本|单库四模式完整合约|与 9.7.4 的双向跨版本合约|
|---|---|---|
|5.7.44|passed|两个方向 passed|
|8.0.11|passed|两个方向 passed|
|8.0.36|passed|两个方向 passed|
|8.0.46|passed|两个方向 passed|
|8.4.11|passed|两个方向 passed|
|9.7.4|passed|参考实例，已包含上方十个方向|

本轮工作区回归：Rust **889 passed / 0 failed / 108 ignored**（上述真实合约显式另跑），Python 验收工具 **35 项通过**；Clippy、Rust 格式与 `git diff --check` 通过。Rust 默认测试中的模拟协议服务器需要监听回环端口，沙箱首次拒绝监听的 13 项已在允许本地端口的环境重跑并通过。没有前端代码改动，本轮未重复前端测试。

复验命令（默认构建当前工作区一次；可加 `--no-pull` 禁止下载）：

```sh
python3 scripts/data-tasks/validate_mysql_versions.py \
  --images mysql:5.7.44 mysql:8.0.11 mysql:8.0.36 mysql:8.0.46 mysql:8.4 \
  --reference-image mysql:9.7 \
  --report artifacts/data-tasks/mysql-versions.json
```

参考实例也执行单库完整契约；每个候选版本与参考实例分别执行两个方向。报告保留实际服务端版本、镜像 ID/摘要/架构、源码提交及工作区状态、测试程序 SHA256 和本次容器/匿名卷清理结果，不保存连接 URL 或数据内容。缺失实例、缺失测试或缺失版本指标不能记为通过；测试失败、超时、中断及清理失败产生非零退出码。报告见 [MySQL 多版本验收结果](data-task-mysql-versions-2026-10-22.json)。

### MySQL 5.7 兼容性修复（2026-10-22）

原版本白名单遗漏 MySQL 5.7，导致读取元数据时直接报“当前仅 MySQL 8.4 与 MariaDB 11.4 原生会话经过真实验收”。已在本机专属临时数据目录、回环地址随机端口的 MySQL 5.7.37 实例复现，并在修复后通过 `real_mysql_session_contract`：覆盖合并、镜像、追加、替换、精确值回读、冲突回滚、取消回滚、并发写入及 DDL 保护、生成器、只读与权限守卫。未访问应用保存连接或业务数据库。

运行时新增接受 `5.7.<补丁>` 和 `5.7.<补丁>-log`，补丁须至少为 8；下限依据 [MySQL 5.7.8 引入 JSON 类型及构造函数](https://dev.mysql.com/doc/relnotes/mysql/5.7/en/news-5-7-8.html)。真实实例证据限于 5.7.37，不代表每个补丁版本都已实测。MySQL 8.4、MariaDB 11.4 和其他数据库的既有门禁不变。新增版本边界单测先失败后通过，MySQL 模块本轮 7 项单测与 1 项真实合约测试全部通过；100 表元数据仍为固定 5 次 SELECT 加 1 次 SHOW GRANTS，每次多表快照仍为 1 次 SELECT。

本次工作区全量回归：Rust **886 passed / 0 failed / 107 ignored**；前端 **170 文件 / 2231 测试通过**；Clippy、Rust 格式及 `git diff --check` 通过。前端测试仍输出 React `act` 与 Ant Design 警告，无失败。

复验时将 `DB_CONNECT_DATA_TASK_MYSQL_URL` 显式指向专属 MySQL 5.7 隔离实例，再运行：

```sh
cargo test --manifest-path src-tauri/Cargo.toml --lib db::data_tasks::adapters::mysql::tests::real_mysql_session_contract -- --ignored --exact --nocapture
```

### 原综合验收

本轮前端全量 **170 文件 / 2221 测试通过**，构建、ESLint、变更前端文件 Prettier 通过；包含定向交互 25 项。全局 Prettier 仍报告 67 个既有文件问题，与本轮修改文件交集为空，未顺带重排。

Rust全量 **884 passed / 0 failed / 107 ignored**，Clippy、Rust格式和git diff检查通过。真实实例显式验收与默认忽略项分开统计；最终综合矩阵11组passed、0 failed、1 not_run、1 blocked，详情见[本轮综合报告](data-task-validation-final-2026-10-22.json)。测试工具单测为主验收器 7 项、TLS 清理 10 项，均通过。[TLS 独立报告](data-task-tls-validation-2026-10-22.json)记录 4 项真实验收及专属容器、匿名卷、临时证书清理。

本轮未重复历史百万行性能测试，保留独立性能报告；ClickHouse 目标状态为 `blocked`。综合工具退出码 `2` 表示这两类未完成条件，不应解读为所有阶段全部完成；任何实际失败仍返回 `1`。

|项目|状态|证据|
|---|---|---|
|前端契约、向导、进度、历史、乱序事件与草稿保护|passed|170文件/2221项；补错误原因、模式/映射、四模式重预览、切换入口/seed、确认payload、防重、取消终态、丢响应只查询和缓存草稿保护|
|SQLite 元数据查询预算|passed|真实 trace：1/10/100 表均 4 次 SELECT|
|SQLite 数据读取查询预算|passed|真实 trace：1/10/100 表每次快照均 1 次集合 SELECT|
|PostgreSQL 查询预算|passed|真实 TCP 协议统计 Execute：1/10/100 表均 5 次元数据 SELECT、1 次快照 SELECT；预编译语句重复执行也计数|
|超过普通查询行数上限、大整数和二进制|passed|100002 行专用流及加密 spool，`9007199254740993` 精确保持|
|任务幂等、取消、过期、互斥和提交状态|passed|registry 定向测试；终态不会被后续旧进度覆盖|
|历史脱敏、原子写入和重启未知状态|passed|history 定向测试；拒绝符号链接，不自动恢复执行|
|配置删除/变更、只读后端守卫、多进程目录保护|passed|commands 定向测试；内存配置摘要与独占目录锁|
|PostgreSQL 适配器|passed|适配器定向 10 项通过；覆盖权限、外部入向 FK、继承、写规则及规则漂移、序列锁与回滚|
|SQL Server 外部依赖可见性|passed|受限 schema 授权、数据库级授权叠加对象/schema DENY、成员角色/public DENY 和隐藏 RLS 的真实回归；完整适配器 7 项通过，固定查询类别未增加|
|PostgreSQL COMMIT 响应丢失|passed|真实 TCP 代理收到服务器 COMMIT CommandComplete 后断开；任务为 OutcomeUnknown / Unknown，独立连接确认 2 行已提交，INSERT 与 COMMIT 各执行 1 次，无重放；本轮协议模块7项真实验收，另有1项计数单测；同时覆盖COMMIT响应一直扣留时的10秒Unknown与无重放|
|MySQL 与 MariaDB|passed|分别在专属实例运行 real_contract，均覆盖完整任务执行器；MariaDB 不沿用 MySQL 的结果|
|跨类型事务目标（阶段 B）|passed|12个基础有向组合追加/替换；新增精确类型矩阵MySQL8.4、MariaDB11.4各26项通过；PG/SQLite布尔→SQL Server TINYINT额外2项，最终综合cross_type共42项|
|百万行、RSS 与临时磁盘峰值|passed|同宽 10 万/100 万行 release 实测见下表；完整传输且清理后 spool 为 0|
|ClickHouse 源 → SQLite / PostgreSQL / MySQL / SQL Server|passed|四方向实际执行、逐值回读与目标事务验证通过；CH 模块新增一致性和ACK实验，最终共16项真实验收同时覆盖原生精度与目标拒绝零写入|
|ClickHouse 目标（包括 ClickHouse→ClickHouse）|blocked|同查询UUID/依赖检查之后、依赖绑定之前新建物化视图，仍可收到写入数据；单流不足以保护预览依赖。正式写入口无条件拒绝，测试实验不计为开放|
|PostgreSQL 待查询/目标保护锁取消|passed|原生CancelRequest覆盖首行前等待；等待原操作响应后再回滚，避免迟到取消打断ROLLBACK。针对偶发问题连续12轮/24项通过；最终单次取消至返回分别13/45毫秒（本机PG查询/锁等待，不代表全部驱动或端到端UI时延）|
|PostgreSQL TLS与临时连接|passed|真实verify_identity自定义CA精确传输，错误CA/错误DNS拒绝且目标零写入，加密连接断链得Unknown；每例专属连接归零，证书/容器/卷清理完成|
|窗口关闭与退出逻辑|passed|活动任务期间窗口保持可见，确认去重、继续等待、取消后等终态；4项决策测试与macOS编译通过|
|三平台实机、SSH、真实ENOSPC|not_run|未实际操作macOS/Linux/Windows完整窗口与临时目录路径；SSH入口缺少隔离known_hosts注入，未使用个人目录；配额/写失败模拟不等价于物理磁盘满|

### 阶段 B 有向组合

以下每个方向分别覆盖追加和替换；表内 MySQL 为专属 MySQL 夹具，MariaDB 的同类型行为由独立 real_contract 验收，不将其扩展为所有跨类型方向的证据。

|源|已验收的目标|状态|
|---|---|---|
|SQLite|PostgreSQL、MySQL、SQL Server|passed|
|PostgreSQL|SQLite、MySQL、SQL Server|passed|
|MySQL|SQLite、PostgreSQL、SQL Server|passed|
|SQL Server|SQLite、PostgreSQL、MySQL|passed|

类型边界：除整数范围包含、文本和二进制，开放 PostgreSQL/MySQL/MariaDB/SQL Server 之间的精确小数、DATE、TIME 和无时区 timestamp；PostgreSQL/SQL Server/SQLite 布尔互传及到受支持整数目标。字段声明必须满足目标范围/精度包含，冻结值还会逐项校验，按目标原生格式规范化。新测试覆盖大精度小数、NULL、闰日、微秒、SQL Server默认7位精度、预览后源修改、替换前拒绝和SQL Server TINYINT规范值。SQLite小数/时间、MySQL TIMESTAMP、MySQL任意TINYINT→布尔、带时区转换、旧SQL Server DATETIME/rowversion、浮点/UUID/JSON等继续拒绝；不放开精度缩窄、零日期、BC/infinity、负/超24小时TIME或非法布尔。ClickHouse `String` 按任意字节保存，只映射到目标二进制列；`Nullable` 仍需目标允许空值。ClickHouse 原生 Decimal/DateTime64 的精度测试不代表这些类型已开放跨库映射。

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
