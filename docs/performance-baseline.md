# 性能验证基线

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
