# T04 PostgreSQL 分页缓存验收夹具（2026-10-15）

当前 `dd` 工作区交付可重复的实库验收入口。**本机缺少 `postgres:17-alpine`，没有启动 PostgreSQL、执行本轮实库验收或生成延迟样本；T04 的实库及完整应用验收仍待完成。** 未拉取镜像、安装升级依赖、新建分支/工作树、提交或推送。

## 已交付的验收入口

- `scripts/performance/metadata-postgres-validation.py` 增加 `--preflight`、`--suite catalog|pagination|all`（默认 `all`）及脱敏 JSON `--output`；仅使用已有指定镜像，启动仍强制 `--pull=never`。缺镜像预检退出 2，在创建临时目录/随机凭据、启动容器、DDL 和编译之前终止。
- 新增 ignored 测试 `db::metadata_pg_pagination_tests::metadata_access_isolated_postgres17_pagination`，复用现有专属目录、随机容器 `cluster_name`、数据库名、PG17 版本及随机端口校验；现有目录测试只开放三个测试 helper 供复用，没有修改生产入口。
- 合成数据集中一次 DDL 初始化到新 schema `metadata_pagination`，不改变已有目录权限案例的表清单。覆盖单 bigint 主键、复合主键、继承父子表重复主键、视图、文本主键、无主键及空表。
- 每个样本使用新的连接缓存标识，真实调用生产 `postgres::query_table_data`：冷读一页、TTL 内显式连续 20 次无游标页请求、显式失效后再读一页。每阶段用隔离库 `pg_stat_statements` 一次观察 SQL 取得元数据、数据页、COUNT 三项服务端计数，分别要求 `[1,1,0]`、`[0,20,0]`、`[1,1,0]`；热读缓存命中为 20/20。观察语句通过绑定 pattern 与被测语句区分，不重置全局统计、不轮询数据库。
- 额外真实请求要求可信 bigint 主键可使用 keyset；失效前的旧游标在失效后回退 offset；继承父表虽有主键但合并子表后重复，必须禁止 keyset；复合/文本/无主键/视图保留回退行为。大于 JS 安全整数和 i64 最大值保留十进制字符串；空表保留列描述。
- SQL 调用均为源码中显式 `await` 序列。5 次预热和 20 次正式样本均保留全部冷读、20 个热请求及失效后延迟；循环/map 只处理本地数值/输出，不执行 SQL、递归或子进程查询。

## 测量边界与输出

计时使用每个 Rust 进程自身 `std::time::Instant`。每个请求从调用生产表页函数前开始，到表页结果完整解码后结束，包含连接池借出、必要时的元数据读取、真实 loopback TCP 数据页及结果解码；不包含服务端观察 SQL。预先建立连接池连接，首次 TCP 建连不混入缓存冷/热比较。

输出保存 PG 版本、镜像 ID、平台、rustc、HEAD 与相关源码 SHA256、构建模式、调用命令、全部预热与正式原始样本和三项服务端计数。p50/p95 采用 nearest rank；冷读/失效后分别 n=20，热读 n=400（20 组各 20 请求）。夹具不丢弃或自动重试失败样本，失败即终止。输出只包含数量、耗时、版本及随机夹具标识，不保存密码、完整 SQL、业务结果或游标内容。

这属于**生产 Rust 驱动与数据库网络请求测量**，不等于完整 Tauri 应用，也不是元数据 SQL 单独耗时：缺少真实 IPC、WebView 准备/渲染、整体 p95、池等待独立拆分，以及目录 1/10/50/100 的应用 trace。此夹具明确 `skip_count=true` 并验证 COUNT 为 0；未声称已测包含 COUNT 的应用场景。没有旧多库端到端基线，不计算端到端加速比例。

## 本轮验证

| 检查 | 本轮结果 | 能证明的范围 |
| --- | --- | --- |
| `python3 scripts/performance/metadata-postgres-validation.py --preflight`（主代理有 Docker socket 权限执行） | 退出 2；`{"status":"image_missing","image":"postgres:17-alpine","measurement_run":false,"pull_attempted":false}` | 本地镜像缺失；未启动容器、未测量、未拉取 |
| 同一预检（子代理沙箱） | 退出 2，`status=docker_unavailable` | socket 权限不足与镜像缺失明确区分，不误报实库结果 |
| `python3 -m py_compile scripts/performance/metadata-postgres-validation.py` | 退出 0 | Python 语法 |
| `python3 scripts/performance/metadata-postgres-validation.py --help` | 退出 0 | 参数入口可执行 |
| 6 项内存预检行为检查（临时 Python 程序；仅 mock `subprocess.run`/临时目录边界） | 退出 0 | 本地镜像缺失、socket 拒绝、Docker 不存在、超时、镜像存在分支；缺镜像在创建夹具前退出。没有运行数据库或生成性能值 |
| `rustfmt --check --edition 2021 src-tauri/src/db/metadata_pg_pagination_tests.rs src-tauri/src/db/metadata_pg_tests.rs` | 退出 0 | 新增/复用测试模块格式 |
| `cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --lib --no-run`（主代理统一执行；SDK 26.5） | 退出 0，25.31 秒；新增 PG 模块成功编译 | 编译不等于 PG 实库通过 |

## 复现命令

先在仓库根目录只读探测；镜像缺失时不继续、不拉取：

```sh
python3 scripts/performance/metadata-postgres-validation.py --preflight
```

将来本地已有指定镜像后，单独运行（不得与构建、其他测试或基准并行）：

```sh
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk python3 scripts/performance/metadata-postgres-validation.py --suite pagination --output docs/performance/metadata-postgres-pagination-YYYY-MM-DD.json
```

同时重新验收原目录权限与新分页案例时，将 `--suite pagination` 改为 `--suite all`。日期使用实际执行日期。`--suite catalog` 只运行原目录验收；两套测试单线程顺序执行，SQL 计数使用阶段差值隔离。

runner 使用离线锁定 Cargo 依赖；退出时二次核对专属容器标签，只清理本次随机容器及匿名卷，并删除 0600 临时凭据。成功 JSON 另外保存在专属临时目录中；缺镜像时无成功 JSON。取得真实 PG 原始计数和样本后才可登记此子项实测通过；完整 Tauri 应用的其余指标仍须单独验收。
