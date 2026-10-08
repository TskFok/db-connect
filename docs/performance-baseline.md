# 性能验证基线

## 01：结果预算与共享缓存（2026-09-30）

### 夹具与测量边界

使用同一台 macOS arm64、Node v25.5.0、已安装的 Rolldown，将真实生产 `databaseStore` 及其依赖打包为相同的非压缩 ESM，在独立 Node/V8 子进程中测量。旧实现读取提交 `b8eae76de751ea26d33830dc7f0823ec9b2b8479`，新实现读取工作区；不切分支、不调用数据库或 Tauri。每档 3 个样本，各自新进程；冷组直接加载，热组先接收一份结果、清空 store 并 GC，再开始相同夹具。

每份结果为 10,000 行、20 列，每格 48 个 ASCII 字节，每份紧凑 JSON 为 10,220,112 字节（约 9.75 MiB）。字符串逐格分配并展平，避免共享填充值掩盖行载荷。通过生产 store 打开 1/10/30 个独立 SQL 标签，仅当前结果可见；单独测量全部结果持有租约的情况。所有记录只含数量、字节及运行环境，不含 SQL 内容、字段内容或凭据。

每组接收完数据后显式执行两次 GC，记录 `heapUsed`；RSS 峰值来自独立进程 `resourceUsage().maxRSS`。**这是生产 store 的 V8 内存测量，不是 React/WebView、Rust、IPC 或整个桌面应用的测量。** 不据此推导端到端延迟或桌面进程峰值收益。

### 测量结果

以下单位为 MiB。GC 后 heap 为 3 样本中位数，峰值 RSS 为 3 个独立进程峰值的最大值；软预算登记字节及驻留份数为每个样本一致的确定性结果。原始 39 个样本见 [结果内存证据](performance/result-memory-2026-09-30.json)。

| 组别 | 标签数 | 旧 GC 后 heap | 新 GC 后 heap | 旧峰值 RSS | 新峰值 RSS | 新驻留结果数 | 新登记量 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 冷 | 1 | 18.33 | 18.39 | 95.67 | 98.25 | 1 | 9.75 |
| 冷 | 10 | 146.81 | 146.90 | 325.41 | 328.92 | 10 | 97.47 |
| 冷 | 30 | 432.18 | 189.74 | 588.11 | 624.89 | 13 | 126.71 |
| 热 | 1 | 18.33 | 18.40 | 129.77 | 130.97 | 1 | 9.75 |
| 热 | 10 | 146.82 | 146.91 | 323.02 | 328.92 | 10 | 97.47 |
| 热 | 30 | 432.18 | 189.74 | 627.89 | 607.56 | 13 | 126.71 |

30 标签的 GC 后堆约下降 56%；未受保护行载荷稳定为 13 份、132,861,456 字节，小于 128 MiB。峰值 RSS 并未稳定下降，且仍远大于软预算；不能把登记上限描述为进程内存上限。

全部 30 份结果受保护时，登记量为 306,603,360 字节（292.40 MiB），`overBudget=true`；GC 后 heap 中位数为 432.28 MiB，峰值 RSS 最大值为 628.28 MiB。释放操作租约后，自动回收到 13 份、126.71 MiB，`overBudget=false`；再 GC 后 heap 为 189.76 MiB。这个例外验证保护优先于容量，不用丢失正在编辑或导出的数据换取预算合规。

### 复现

```sh
node scripts/performance/result-memory-benchmark.mjs \
  --ref b8eae76de751ea26d33830dc7f0823ec9b2b8479 --samples 3 \
  --output /private/tmp/result-memory-before.json
node scripts/performance/result-memory-benchmark.mjs \
  --samples 3 --output /private/tmp/result-memory-after.json
```

脚本使用已安装依赖，自动为每份样本启用 GC，不连接真实数据库。它断言唯一标签数、实际登记字节、预算内回收、全保护超预算及解除后的恢复；`--ref` 通过只读 `git show` 获取旧源码。临时 bundle 保留在系统临时目录，原始数据写入 `--output` 指定路径，方便复核。

### 确定性回归与检查

最终检查记录在 [实施计划的执行记录](superpowers/plans/2026-09-30-performance-01-result-memory.md#2026-09-30-执行记录) 中；真实远程数据库和桌面 WebView 内存尚未实测。Rust 验证使用独立内存 SQLite 与已有本地协议替身，不连接业务库。后端超限返回整次失败，保留既有取消和连接失效语义；前端断言覆盖计费、LRU、可见与脏页保护、执行中回收、关闭/断线迟到隔离、隐藏编辑、复制和导出各出口的租约释放。

## 02：MySQL SQL 编辑器取消（2026-09-30）

范围为 SQL 编辑器的 MySQL 取消与线程编号登记。业务池上限保持 5；其他数据库取消能力与表浏览路径不变。以下是本机隔离实例及协议替身的验证，不代表所有网络、TLS、SSH 或数据库版本的性能。

### 夹具和测量方法

- macOS arm64，MySQL 5.7.37，mysql_async 0.37.0，Rust debug 构建。使用新建临时数据目录和随机 loopback TCP 端口；不使用已有数据库服务、应用连接配置或真实凭据。
- 临时实例最大连接数 32，InnoDB buffer pool 32 MiB，日志文件 8 MiB。Performance Schema 启用 statement 计时及 current/history/history_long，history_long 容量 10000；不开启 general log。
- 业务池约束为 0～5，空闲 TTL 30 秒、检查周期 15 秒、绝对 TTL 4 小时。正常连接初始化保持一条字符集初始化；取消辅助连接不重放用户 init/setup/after_connect。
- 单样本显式并发启动五条合成慢查询：目标上限 30 秒、四条占池查询各 1.5 秒。一次集合快照确认五条均在服务端执行且池无可用连接后，再请求取消。没有循环查询数据库状态。
- 旧路径重现从业务池借连接执行取消及额外线程编号 SQL；新路径调用生产 `execute_mysql_sql` 和 `MysqlQueryRegistry::cancel`。新旧路径使用相同查询、池约束、实例和编译模式。
- 冷组没有预热业务池；热组在每个单样本进程中先同时借出五条连接、全部归还并确认可用。取消计时均从池满且目标已运行之后开始，不包含初次查询建连时间。取消辅助连接每次都是新连接。
- 客户端使用同一进程的 `Instant`：取消入口到返回、执行入口响应和第六次借连接恢复分别记录。服务端使用 Performance Schema 的同一计时域：目标总时长及 KILL 开始到目标结束；不把客户端取消返回当作服务端终止，也不跨时钟相减。
- 普通查询计数使用单独的新池，分别统计执行前全部 SQL（包括驱动系统设置读取和会话初始化）与线程编号登记 SQL。最终一次集合查询读取计数和服务端时间；证据仅输出数量、耗时、错误编号和随机运行标识。

### 测量结果

每组 20 个样本，共 80 个全部通过。p50/p95 采用 nearest-rank；下表单位均为毫秒，每格为 **p50 / p95**。原始数值与测量元数据见 [80 样本证据](performance/mysql-cancellation-2026-09-30.json)。正式采样结束后，临时 MySQL 已正常关闭并确认原 PID、随机端口退出。

| 路径与池状态 | 样本数 | 取消返回 | 首个可用容量恢复 | 服务端 KILL 开始→目标结束 | 服务端目标总时长 |
| --- | --- | --- | --- | --- | --- |
| 旧路径冷池 | 20 | 1448.698 / 1451.701 | 1448.962 / 1451.512 | 0.083 / 0.110 | 1503.728 / 1506.388 |
| 旧路径热池 | 20 | 1447.661 / 1450.606 | 1447.952 / 1450.485 | 0.078 / 0.219 | 1503.334 / 1506.410 |
| 新路径冷池 | 20 | 1.090 / 1.263 | 1.729 / 1.916 | 0.030 / 0.038 | 55.813 / 56.042 |
| 新路径热池 | 20 | 1.105 / 1.437 | 1.636 / 2.040 | 0.033 / 0.066 | 56.263 / 57.226 |

所有样本均在五个业务连接被慢查询占满时取消。新路径取消确认 p95 为冷池 1.263 ms、热池 1.437 ms，满足本机受控低延迟环境不超过 500 ms 的目标。容量恢复指取消入口到第六次借连接获得一条租约，不表示四条其他慢查询已全部结束。

服务端目标总时长包括采样前的 50 ms 就绪间隔及查询/连接准备；KILL 开始到目标结束在同一服务端时钟中计算。不能将这两个数与客户端时间戳直接相减，或据此推导其他网络环境收益。

普通查询的新物理连接前置 SQL 固定从 3 条降至 2 条，其中线程编号登记 SQL 从 1 条降至 0 条。该总数包含首次建连的系统设置读取及字符集初始化，不代表热复用连接每次还需两条 SQL。每次带标识的正常执行消除一条登记 SQL；取消辅助连接不会重放用户会话初始化。

### 复现

已保存 [独立夹具与采样脚本](../scripts/performance/mysql-cancellation-benchmark.py) 及默认忽略的 [单样本 Rust 基准](../src-tauri/src/db/mysql_query_bench_tests.rs)。使用已安装 MySQL 5.7，脚本每次创建独立数据目录和随机 loopback 端口，结束时只关闭自身创建的服务进程；不安装依赖、不使用已有实例，不删除测量目录。

```sh
python3 scripts/performance/mysql-cancellation-benchmark.py \
  --mysqld /opt/homebrew/opt/mysql@5.7/bin/mysqld \
  --samples 20 --output /private/tmp
```

输出目录由脚本打印，包含 metadata.json、samples.jsonl 和 summary.json。该复现流程当前只针对 macOS/MySQL 5.7 验证；真实 TLS/SSH 网络性能及其他服务端版本尚未实测，配置继承由离线属性测试覆盖。

### 确定性回归与检查

| 检查 | 结果 | 边界 |
| --- | --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml mysql_query_` | 16 项通过，1 项隔离基准默认忽略 | 早到取消、池等待/USE、隔离与重复登记、竞争、请求丢弃、失败/超时、错误连接丢弃、无执行标识兼容 |
| `cargo test --manifest-path src-tauri/Cargo.toml table_query` | 6 项通过 | 既有表查询路径回归 |
| `npm test -- src/__tests__/SqlEditorExecutionPersistence.test.tsx` | 10 项通过 | 确认/失败如实显示、草稿、旧执行/旧取消回复隔离 |
| `npm run test:rust` | 732 项通过，13 项默认忽略 | 隔离数据库测试须显式启用，不把忽略当通过 |
| `npm test -- --maxWorkers=2` | 最终复测 141 文件、1771 项全部通过 | 首轮与编译并行时有 1 项超过 10000 ms；定向 3/3 通过后，在编译及正式采样结束后完整复测通过，未修改超时阈值 |
| `npm run build` | 通过 | 保留既有大 chunk 提示 |
| `npm run fmt:rust`、`git diff --check` | 通过 | 代码格式与空白检查 |
| `npm run lint` | 3 条既有错误 | `scripts/release.mjs:203/211` 缺少 error cause；`scripts/release.node-test.mjs:382` 的 URL 未声明；文件未改动 |
| `npm run lint:rust` | 1 条既有错误 | `src-tauri/src/db/sqlserver_objects.rs:629` 的 type_complexity；文件未改动 |
| 修改的前端文件定向 ESLint | 通过 | 不替代全仓 lint |
| 可复用基准脚本 `--samples 1` | 4/4 样本通过并自动关闭临时服务 | 另建实例的端到端复现检查，不混入正式 80 样本统计 |

### 清理边界与驱动补丁

取消建连、单次 KILL 和辅助连接关闭共用 2 秒预算；原异常连接清理最多另有 2 秒。失败必须保留原查询错误，并明确查询是否终止尚未确认、需要刷新确认，不能声称未执行或未提交。

协议替身验证发现 mysql_async 0.37.0 的 `disconnect()` 会尝试排空多结果集，且跨结果集时可能恢复 disconnected 标志；第二结果流停顿后，即使外层关闭超时，池槽仍可能被后台清理占用。回归先在原版失败，再通过同版本本地补丁新增的 `disconnect_immediately`：直接关闭流并由池回收器释放槽位，不执行额外 SQL、不扩池。

补丁仅增加一个公开方法，保留原来的 disconnect、正常归还和表浏览行为，详见 [补丁说明](../src-tauri/vendor/mysql_async/DB_CONNECT_PATCH.md)。维护成本为约 668 KiB 上游源码快照和一处补丁；没有增加依赖或升级版本。此补丁随本专项整体回滚，不能只移除 Cargo patch 而留下调用点。

## 03：目录集合读取与分页元数据缓存（2026-09-30）

### 夹具与计数口径

目录和缓存实测使用本机已安装的 MySQL 5.7.37、mysql_async 0.37.0、Rust debug 构建。脚本启动自己的临时数据目录和随机 loopback 端口，关闭自己持有的服务进程；不读取应用连接配置、业务账号或凭据，不安装依赖。

夹具包含 100 个数据库，每库一张空表；第一个库另有一张视图，还包括空库、名称含单引号/反引号/双引号/方括号/分隔符的库、仅单表 SELECT 权限的账号及仅 SHOW DATABASES 权限的账号。新旧单库路径均读取同一张表和视图并构造 `TableInfo`。每个样本独立进程和连接池，正式计时前已取得物理连接；服务器不在样本间重启，因此不能把它称为冷启动测量。

目录 SQL 数由独立观察连接读取 Performance Schema 的目标线程执行计数；MySQL 5.7 的预处理语句执行归在 `statement/com/Execute`，与普通 SELECT、SHOW TABLE STATUS、SHOW INDEX 的执行计数一起核对。排除连接初始化、PREPARE 和观察连接自身查询；**一次目录 SQL 不等于一次网络往返**。新路径测试直接调用生产批量函数，固定为一次集合执行；没有逐库/逐表 COUNT 或超限分块查询。

SQLite 采用真实内存连接、同一连接 ATTACH、temp、空 schema、特殊别名以及 authorizer 拒绝测试。PostgreSQL 17.10 另用本机已有镜像完成真实权限与字段对照，详见下方补验。SQL Server、ClickHouse 本轮只有离线方言/映射及代码审查，没有真实服务器权限矩阵和网络性能数据；不能据此宣称这两种引擎的权限兼容性已经全面验收。

### 确定性结果

| 场景 | 修改前 | 修改后 | 证据边界 |
| --- | ---: | ---: | --- |
| 刷新 1 / 10 / 100 个已加载目录的目录 IPC | 1 / 10 / 100 | 1 / 1 / 1 | 前值为原源码计数，后值为生产 store + invoke 替身断言 |
| MySQL 1 / 10 / 100 库的目录 SQL | 1 / 10 / 100 | 1 / 1 / 1 | 前值为原 SHOW 路径源码计数，后值为隔离服务器执行计数 |
| 20 个同键并发目录调用 | 20 次调用无合并 | 1 次 invoke | 进行中请求合并 19/20，不是完成结果缓存 |
| MySQL 首次 / 后续无导航元数据读取 | 2 / 每次 2 | 2 / 0 | 真实隔离实例；两条可信主键查询保留 |
| PG 首次 / 后续无导航元数据读取 | 1 / 每次 1 | 1 / 0 | 注入读取器与原 SQL 边界审查，非服务端计时 |
| 首读后连续 20 次无导航请求 | 每次重读目录 | 20 次全部命中 | 受控读取器，含首次共 21 次请求，整体命中 20/21 |
| DDL、刷新、断线前的旧元数据回填 | 缺少统一约束 | 0 次被接纳 | 代次、连接生命周期、游标 revision 及竞态回归 |

空目录替身中，完整刷新还包含后端失效及数据库列表两次 IPC，因此修改后完整刷新是固定 3 次 IPC；有选中表时还可能读取一次结构。表格中的“1 次”仅指目录批量读取，不能描述为整次刷新总共一次 IPC。

MySQL 实测中曾发现普通请求集合 JOIN 会显示 `Scanned all databases`；仅加派生 IN 条件仍被优化器合并。现实现使用请求集合过滤并保留 TABLES 派生查询的物化边界，实际生产 SQL 的 EXPLAIN 断言为 `Scanned 1 database`，同时拒绝 `Scanned all databases`。该最大 LIMIT 用来阻止派生合并，不截断目录结果。SHOW 与新集合查询逐项核对名称顺序、表/视图、NULL 统计、大小和注释；仅有库可见权限时保留空列表，缺失/不可见库整批报错。

### 前端受控替身测量

最终前端修复和全量检查后单独运行：Node 25.5.0、macOS arm64，真实 store/service 配合立即完成的 invoke 替身。每组预热 5 次、记录 30 次，nearest-rank p95；只以调用次数作为确定性断言，不对时间设 CI 门禁。

| 场景 | 目录 IPC | 完整刷新 IPC | p95（ms） |
| --- | ---: | ---: | ---: |
| 刷新 1 个目录 | 1 | 3 | 0.105 |
| 刷新 10 个目录 | 1 | 3 | 0.158 |
| 刷新 100 个目录 | 1 | 3 | 0.262 |
| 20 个同键并发调用 | 1 | — | 0.030 |

[测量摘要](performance/metadata-frontend-2026-09-30.json)记录运行环境与口径。前三组返回空目录且没有选中表；第四组合并 19/20 个调用。该结果反映 JavaScript 请求组织成本，不包含 Tauri、数据库、网络或 React，也没有旧实现同口径延迟对照。

### 隔离 MySQL 测量结果

正式采样在最终 MySQL 8 权限修复、编译、构建和全量测试结束后单独重跑；每组 20 个样本，共 80 个目录样本与 20 对缓存冷/热读取。p50/p95 使用 nearest-rank，单位为毫秒。原始记录见 [100 样本证据](performance/metadata-access-2026-09-30.json)；首轮与构建短暂重叠的复现采样没有混入此文件。

| 路径 | 库数量 | 样本数 | p50 | p95 | 每次目录 SQL |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原 SHOW 单库及字段映射 | 1 | 20 | 0.472 | 0.765 | 1 |
| 新集合读取 | 1 | 20 | 1.181 | 1.894 | 1 |
| 新集合读取 | 10 | 20 | 4.098 | 6.224 | 1 |
| 新集合读取 | 100 | 20 | 9.259 | 13.910 | 1 |

单库 p95 增加约 1.13 ms：集合校验、预处理和归组存在成本，不能宣称单库延迟改善。多库已验证执行次数固定，但没有重新引入旧循环查询来采集旧多库 p95，因而不报告多库端到端提升百分比。

| MySQL 分页元数据路径 | 样本数 | p50 | p95 | 元数据 SQL |
| --- | ---: | ---: | ---: | ---: |
| 首次安全目录读取（未命中） | 20 | 13.415 | 19.431 | 2 |
| 同表无 navigation 热读 | 20 | 0.006 | 0.024 | 0 |

这里仅计生产元数据加载函数，不包含数据 SELECT、COUNT、IPC 或渲染。每对样本第一次调用实际读取可信主键和列证据，第二次复用相同表的缓存；跨分页 20 次复用由前述受控读取器测试覆盖。

### MySQL 8 权限兼容调整与隔离补验

MySQL 8.4.10 / Linux arm64 / `lower_case_table_names=0` 的隔离验收发现：仅有 SHOW DATABASES 权限时，原 SHOW TABLE STATUS 返回 1044，而 INFORMATION_SCHEMA 返回可见库与空表集合。直接把空集合视为成功会掩盖权限错误。公开权限视图也不能完整还原嵌套角色授予的库权限及 partial revoke，因此增加以下必要例外：

- MySQL 8/9 普通非空目录批次仍为 1 条集合查询。
- 批次包含空目录时，在同一借出连接最多追加 1 条裸 SHOW GRANTS，再在内存统一校验所有空组；总数最多 2，与库数量无关。
- 缺失/不可见库或任一无权限空组整批失败；未知授权格式、无法可靠判断优先级的重叠库授权明确报无法验证，不伪装空目录。后者可能保守拒绝部分服务端本可允许的配置。
- 握手版本与同一集合结果提供匹配模式，不为每个库追加探测，不缓存授权、不修改活动角色。MySQL 5.7 的集合 SQL 保持原样。

裸 SHOW GRANTS 会合并当前活动角色和权限限制；这里必须省略 FOR/USING，并与目录查询使用同一连接。该行为由隔离实验及 [MySQL 官方实现](https://github.com/mysql/mysql-server/blob/mysql-8.4.0/sql/sql_show.cc)交叉核实。权限解析按库操作权限、对象授权、通配符、大小写和部分撤权规则判断，不把“能看到库名”当作“能读目录”。

真实矩阵覆盖五库归组及特殊名称、大小写同名库/表、SHOW 字段和排序、空/缺失库、单表 SELECT、仅 SHOW DATABASES、直接空库 CREATE、嵌套角色、列/例程、表级 GRANT OPTION、空角色、通配符和部分撤权。复现入口为 `python3 scripts/performance/mysql8-metadata-validation.py`，只使用本机已有镜像和自建临时容器。[验收证据](performance/metadata-mysql8-2026-09-30.json)不记录凭据。

这明确偏离原计划“所有目录批次固定 1 条 SQL”的绝对指标，以保留原权限错误。没有逐库 SQL 或分块兜底；MySQL 8 的空库额外授权检查不计入下述 MySQL 5.7 延迟样本。

### PostgreSQL 17 隔离补验

使用已有 `postgres:17-alpine` 镜像，实际服务端为 17.10；仅创建带随机标记、绑定随机 loopback 端口的专用容器。管理员与仅拥有一个 schema USAGE、一张表 SELECT 的账号分别调用生产批量函数，并对照修改前的单 schema 查询。

6 个请求去重后返回 5 组，包含空/缺失 schema、特殊引号与分隔符、不同 schema 同名表，以及普通表、视图、物化视图和分区表。所有字段与顺序一致；`pg_stat_statements` 确认两类账号每批各 1 条目录 SQL，空请求和超限请求为 0。受限账号不能访问另一 schema 的数据，但原 `pg_catalog` 路径仍可看到目录，新实现保持该行为，没有为隐藏目录增加权限过滤。

[原始验收结果](performance/metadata-postgres-2026-09-30.json)只记录数量、版本和随机夹具标记，不包含凭据。复现命令为 `python3 scripts/performance/metadata-postgres-validation.py`；脚本只使用现有镜像，退出前校验标签并删除自身容器及匿名卷、临时凭据文件。此补验不提供 PostgreSQL 网络 p95 或分页元数据的真实 SQL 计数。

### 复现与剩余边界

```sh
python3 scripts/performance/metadata-access-benchmark.py \
  --mysqld /opt/homebrew/opt/mysql@5.7/bin/mysqld \
  --samples 20 --output /private/tmp
npm test -- src/__tests__/metadataRequests.performance.test.ts
cargo test --manifest-path src-tauri/Cargo.toml metadata_batch
cargo test --manifest-path src-tauri/Cargo.toml metadata_cache
cargo test --manifest-path src-tauri/Cargo.toml table_pagination
```

远程目录及分页 p95 不包含 WebView、Tauri IPC、React 提交、数据页查询和 COUNT。旧多库路径未为测量重新引入循环 SQL，因此只保留次数的源码基线，**没有旧多库端到端 p95 对照**。MySQL 8.4.10 的 Linux 大小写敏感实例已完成上述目录补验；MariaDB、MySQL 其他版本/配置、不同 collation 及真实 SSH/TLS 网络仍未全面实测。

缓存本体保持 300 秒 TTL、256 项元数据和 4096 项游标。连接生命周期的小对象暂按历史连接保留以拒绝极晚响应；长期高频重连的安全回收为非阻断维护项，不能简单用 TTL 删除标记。SQL 修改类结果按连接保守失效，包含 DML；没有声称能精确识别所有带副作用的 SELECT 或外部 DDL，外部变更仍由刷新或 TTL 感知。

### 最终回归与检查

| 检查 | 结果 |
| --- | --- |
| 前端全量（`--maxWorkers=2`） | 147 文件、1919 项全部通过，168.23 秒 |
| Rust 全量 | 771 项通过、18 项默认忽略，5.05 秒；本机协议替身已允许监听 |
| 独立权限解析回归 | 6 项纳入全量 Rust，通过 |
| `npm run build` / TypeScript | 通过；大 chunk 及无效动态导入提示保留 |
| 修改的前端文件 ESLint | 15 文件通过 |
| Rust 格式、差异空白、3 个 Python 隔离脚本语法 | 通过 |
| 全仓 ESLint | 仍为未改动 release 脚本的 3 项既有错误 |
| Clippy | 仍为未改动 `sqlserver_objects.rs:629` 的既有 `type_complexity` |

并发 DDL、刷新接管后再次失效、断线、切换连接、关闭重开同名表及旧请求 finally 均有确定性回归。独立审查发现的问题完成红绿修复并通过限定复审。MySQL 8 重叠授权的有效回归使用不含通配字符的精确库名；早期含未转义下划线的探针被排除，没有当作有效失败证据。


## 04：长文档 SQL 补全（2026-09-30）

### 夹具与 Node 测量边界

使用同一台 macOS arm64、Node v25.5.0、已安装的 Rolldown，将实际分析器、作用域绑定、候选生成和文档缓存打包为非压缩 ESM。旧实现只读提交 `b550decd62af94f3cd8003f8277845c845d8a25e`，新实现读取工作区。两组分进程顺序执行，正式采样时不并行运行全量测试或构建；没有强制 GC。

预建 1,000 表、每表 50 列的索引。固定 49 B 活跃语句位于末尾，历史语句每条 53 B（含换行），100 KiB/1 MiB 分别包含 1,931/19,783 条历史语句，以空格补齐目标 UTF-16 长度。本夹具为 ASCII，字节数等于 UTF-16 长度；各档都返回 50 项相同内容和顺序的列候选。

每种大小、每种路径热身 5 次后取 20 个样本，p50/p95 分别取排序后第 10/19 项。冷组包含文档扫描、首次查询块解析与完整候选计算；热组复用同版本语法；编辑组交替在末尾插入/删除一个字符，计时包含 `applyChanges` 与候选计算。索引构建不计时。**这些数字不包含 Monaco 模型、界面、WebView、IPC 或数据库。** 旧实现每次完整解析，冷/热/编辑三组原始值均已保存；下表旧列展示同版本重复补全，便于与原计划基线比较。

### Node 结果

单位毫秒，单元格为 **p50 / p95**。原始样本与环境见 [Node 补全证据](performance/sql-completion-2026-09-30.json)。

| 文档 | 旧热补全 | 新冷初始化及补全 | 新热补全 | 新末尾编辑及补全 |
| --- | ---: | ---: | ---: | ---: |
| 49 B | 0.176 / 0.284 | 0.278 / 1.041 | 0.166 / 0.534 | 0.165 / 0.323 |
| 100 KiB | 5.100 / 5.629 | 7.091 / 8.450 | 0.135 / 0.412 | 0.146 / 0.805 |
| 1 MiB | 56.870 / 61.889 | 69.992 / 74.535 | 0.114 / 0.119 | 0.247 / 0.304 |

1 MiB 热补全和末尾编辑的 p95 均小于 15 ms；49 B 相对旧路径的冷/热/编辑 p95 绝对退化分别为 0.688/0.250/0.016 ms，均小于 1 ms。1 MiB 首次初始化仍需完整扫描并分配语句、token，p50/p95 为 69.992/74.535 ms，旧冷组为 57.640/63.567 ms；冷路径没有获得与热路径相同的收益，不能把热路径结论应用于首次打开文档。

缓存每个模型只保存当前文本版本，语句内 token 使用局部 UTF-16 坐标，查询块 LRU 最多 32 项。末尾编辑不扫描历史语句，也不复制历史语句索引；中部编辑仍会调整后缀语句起点，字符串拼接/展平也可能涉及全文。删除字符串或注释闭合符导致词法状态无法收敛时，安全重扫到文末。

### 复现

```sh
node scripts/performance/sql-completion-benchmark.mjs \
  --ref b550decd62af94f3cd8003f8277845c845d8a25e \
  --output /private/tmp/sql-completion-before.json
node scripts/performance/sql-completion-benchmark.mjs \
  --output /private/tmp/sql-completion-after.json
npm test -- src/__tests__/sqlCompletionDocumentPerformance.test.ts src/__tests__/sqlCompletionPerformance.test.ts
```

墙钟数据仅记录，不作为 CI 门禁。CI 断言同版本额外全文分词/扫描为零，1 MiB 末尾编辑仅扫描活跃语句，三档候选内容等价，100 次完整热补全不会新增元数据请求。


### 字符串存储资源回归

审查发现初版 `token.text` 为全文切片，V8 与 JavaScriptCore 可由长 token 的字符串背板保留整个旧文档；依次编辑不同语句时，虽然逻辑上只有当前文本版本，实际内存仍会按编辑次数线性增加。最终实现只在新扫描 token 写入缓存时按 UTF-16 单元构造独立字符串；查询块复用和普通读取不重复复制。该复制保留孤立代理项，未采用只在 V8 有效、在 JSC 无效的前缀拼接后切片技巧。上表已在此最终实现上重新采样，包含新增复制成本。

资源夹具为 1,068,282 个 UTF-16 单元、19,783 条语句，连续在 400 条不同语句中等长替换一个 26 字符标识符。每个采样点强制 GC 五次，测 Node heapUsed；它不是进程 RSS 或 WebView 堆。修复前同一仓库脚本的堆为创建后 21.75 MiB、400 次后 429.35 MiB，触发资源断言失败。最终实现独立复测为 **19.04 → 19.11 MiB**，dispose 后回到 **6.30 MiB**（创建前 6.19 MiB）。脚本断言连续编辑后相对创建后增长小于 16 MiB，dispose 后相对基线增长小于 8 MiB，专门防止旧版本线性保留。

本机 JavaScriptCore CLI 另对实际缓存依赖进行对照：旧实现 400 次后的 footprint 约 493 MB 且线性增长；修复后 400 次约 183 MB，扩展至 1,200 次仍约 184 MB。footprint 包含 JIT 和分配器，GC/dispose 不保证立即归还进程内存，故不能将其与 V8 heapUsed 混用，也不是完整 Tauri 应用的峰值。环境与原始字节见 [多引擎内存证据](performance/sql-completion-memory-review-2026-09-30.json)，最终仓库脚本数据并入 [Node 证据](performance/sql-completion-2026-09-30.json)。

```sh
node --expose-gc scripts/performance/sql-completion-cache-memory.mjs
```

### 集成验证

最终资源修复后的验证已于 2026-09-30 完成；后续 WebView 验收只修改独立测量工具及文档。

| 检查 | 结果 |
| --- | --- |
| 前端全量 `npm test -- --maxWorkers=2` | 149 文件、1,978 项通过 |
| Rust 全量 `npm run test:rust` | 771 项通过、18 项默认忽略；本地协议替身已允许监听，未启用真实数据库测试 |
| `npm run build` | 通过；既有大 chunk 和无效动态导入提示保留 |
| 修改的 TS、Node 脚本定向 ESLint / Prettier | 通过 |
| Rust 格式 / 差异空白 | 通过 |
| 全仓 ESLint | 未改动的 `scripts/release.mjs:203,211` 和 `scripts/release.node-test.mjs:382` 仍有 3 项既有错误 |
| Clippy | 未改动的 `src-tauri/src/db/sqlserver_objects.rs:629` 仍有既有 `type_complexity` |

实现边界、差分验证和独立审查记录见 [04 实施计划](superpowers/plans/2026-09-30-performance-04-sql-completion.md)。

### WKWebView 补验（2026-10-08）

在 macOS 26.5.2（25F84）、原生 WebKit `21624.2.5.11.8` 的独立 WKWebView 中运行真实 Monaco 和生产 `registerSqlCompletionProvider`。使用上述三档文档和合成的 1,000 表/50,000 列 MySQL 元数据，窗口为 1200×800，Vite 开发模式，不连接数据库。原始环境、全部有效样本、热身及失焦样本见 [WebView 补全证据](performance/sql-completion-webview-2026-09-30.json)。文件名沿用专项计划日期，实际采样时间保存在 `recordedAt`。

各档冷/热/编辑组均先热身 5 次，再保留 20 次有效测量，共 225 次有效触发。每次必须返回 50 项候选，并观察到 `.suggest-widget.visible` 内真实列表行；虚拟列表 DOM 行数不等于候选总数。计时前完成原生窗口聚焦握手，仅明确失焦的样本允许每组最多 5 次重试；本轮 49 B 热组丢弃 1 次失焦超时，其余组为 0，丢弃原因和原始样本均保留。焦点有效时的超时、错误候选数量和 JavaScript 异常均使脚本失败。

菜单延迟单位毫秒，单元格为 **p50 / p95**：

| 文档 | 冷初始化至菜单出现 | 热补全至菜单出现 | 末尾编辑至菜单出现 |
| --- | ---: | ---: | ---: |
| 49 B | 103 / 104 | 103 / 104 | 104 / 106 |
| 100 KiB | 111 / 114 | 103 / 104 | 105 / 106 |
| 1 MiB | 179 / 190 | 104 / 105 | 105 / 106 |

冷组每次重新创建模型/provider，计时从补全触发开始，包含语法缓存首次扫描，**不包含 Monaco 模型创建或应用启动**。热组复用同版本；编辑组从 `applyEdits` 前开始，包含内容事件中的缓存更新，再触发菜单。编辑测量删除末尾一个字符，恢复字符在该次计时结束后完成。菜单时间包含 Monaco 调度与 DOM 更新，不能直接与 Node 计算链时间等同；本次没有旧版本的 WebView 对照，不据此推算界面加速倍数。

同步阶段另行测量，以下为 **p95 / 最大值**（毫秒）：

| 文档 | 冷 provider 单次调用 | 热 provider 单次调用 | 编辑后 provider 单次调用 | 同步 applyEdits |
| --- | ---: | ---: | ---: | ---: |
| 49 B | 2 / 2 | 1 / 1 | 1 / 1 | 2 / 2 |
| 100 KiB | 11 / 11 | 1 / 1 | 1 / 1 | 2 / 2 |
| 1 MiB | 79 / 96 | 1 / 1 | 1 / 1 | 1 / 2 |

此 WebView 时钟样本呈约 1 ms 粒度，原始 0 ms 表示低于可分辨粒度，不能解读为零成本。1 MiB 冷组的 **20/20 个单次同步 provider 调用均超过 50 ms**，是可复现的主线程阻塞证据；热组和编辑组的已测同步阶段没有超过该阈值。`longtask` 和 `performance.memory` API 均不受此 WKWebView 支持，RAF 最大间隔只作为辅助信息，不能据此排除全部渲染阶段长任务，也不能把约 100 ms 的菜单等待当作一个连续长任务。

夹具关闭 quick suggestions、字符自动触发、minimap 及 occurrences highlight，使用显式补全触发。关闭 occurrences highlight 避免反复销毁模型时无关的单词高亮延迟任务产生未捕获取消异常，未忽略全局异常。本结果属于独立 WKWebView 开发页，不代表打包后的完整 Tauri 应用；长单条 SQL、必须扫描至文末的词法编辑和完整应用峰值堆未在这组三档夹具中测量。

冷路径达到原计划的后续设计触发条件，已在 [04 计划的 Worker 后续任务](superpowers/plans/2026-09-30-performance-04-sql-completion.md#worker-后续设计任务待开展) 登记；本次保持同步增量缓存实现，未引入 Worker。

复现需要 macOS、已安装的 Swift 编译器和项目依赖；运行时保持测试窗口在前台，脚本退出会清理其自身进程：

```sh
bash scripts/performance/sql-completion-webview.sh /private/tmp/sql-completion-webview.json
```

原始数据已通过独立重算复核。启动脚本要求本次 Vite 进程存活且日志确认成功监听，再访问页面；端口占用替身回归确认脚本以状态 2 退出，没有误连旧服务或启动 WebView。
