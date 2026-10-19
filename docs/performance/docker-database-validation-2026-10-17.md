# Docker 隔离数据库补验（2026-10-17）

本轮用户明确允许下载 Docker 镜像。沿用当前 `dd` 分支及既有未提交改动，不新建分支或工作树，不提交推送，不读取业务配置。验收仅使用随机专属容器、loopback 随机端口和合成数据，不挂载宿主业务目录。

## 镜像与环境

Docker Engine 29.8.2，Linux aarch64，10 CPU、8,319,504,384 字节内存。镜像均从官方仓库拉取；验收 runner 只使用本地镜像（`--pull=never`）。

| 引擎 | 镜像 | 架构 | 状态 |
| --- | --- | --- | --- |
| PostgreSQL | `postgres:17-alpine` | arm64 | PG 17.11 目录及分页实库验收通过 |
| ClickHouse | `clickhouse/clickhouse-server:25.8` | arm64 | 25.8.33.6 元数据权限与服务端计数验收通过 |
| SQL Server | `mcr.microsoft.com/mssql/server:2022-latest` | amd64 | 模拟启动成功；生产 TLS 握手阻断，元数据仍待验 |

SQL Server 官方仅支持 Linux x86-64，Rosetta/QEMU 等模拟环境不受支持。本机探针仅证明当前 Docker 模拟环境可启动，不证明官方支持，也不作为原生性能基线。[官方平台说明](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-docker-container-deployment?view=sql-server-ver17)。

## PostgreSQL

复现：

```sh
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk PYTHONDONTWRITEBYTECODE=1 python3 scripts/performance/metadata-postgres-validation.py --suite all --output docs/performance/metadata-postgres-pagination-2026-10-17.json
```

退出 0；两项 ignored 实库验收实际执行通过。目录普通/受限账号各 1 条集合 SQL，字段、分组和权限行为与独立旧查询一致。生产表页函数包含 loopback TCP 与结果解码，先建立连接池连接；5 次预热、20 次正式样本均完整保留，无失败重试。

| 阶段 | 正式请求数 | 元数据 / 数据页 / COUNT 服务端计数（每组） | p50 / p95 ms |
| --- | ---: | --- | ---: |
| 冷读 | 20 | `1 / 1 / 0` | 2.253459 / 2.503 |
| TTL 内连续 20 次非游标热读 | 400 | `0 / 20 / 0` | 0.384417 / 0.461209 |
| 显式失效后读取 | 20 | `1 / 1 / 0` | 2.2345 / 2.541083 |

可信 bigint 主键、旧游标失效、复合/文本/无主键/视图回退、继承重复键、空表及整数精度通过。全部原始计数、nearest-rank 分位数和 5 个源码哈希已复核；专属容器、匿名卷及临时凭据清理成功。[原始证据](metadata-postgres-pagination-2026-10-17.json)。这补齐 T04 的 PostgreSQL 子项，不含 Tauri IPC/WebView/渲染/COUNT，也不是元数据 SQL 的独立执行耗时。

## ClickHouse

复现：

```sh
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk PYTHONDONTWRITEBYTECODE=1 python3 scripts/performance/metadata-clickhouse-validation.py --output docs/performance/metadata-clickhouse-2026-10-17.json
```

最终退出 0，ignored 实库验收实际执行 1 项通过。普通账号 1/5/256 个目录批次、单表 SELECT 和无对象授权账号批次均在 `system.query_log` 中恰好 1 个成功终态；空输入和 257 个去重名称为 0。独立旧单目录查询对照覆盖字段、排序、同名表分组、特殊名称、表/视图、NULL 统计、空/缺失目录及授权过滤；受限数据访问和错误密码整批失败符合预期。

隐藏目录沿用旧查询的空组过滤语义，不将其写成权限异常。最终源码哈希与当前文件一致，专属容器/匿名卷及凭据清理成功。此轮是正确性和计数验收，没有采集延迟性能。[完整说明](metadata-clickhouse-validation-2026-10-17.md)、[最终证据](metadata-clickhouse-2026-10-17.json)。

## SQL Server

启动探针通过，专属库与 Extended Events 计数会话均可初始化，但生产 Tiberius 连接尚未进入目录权限/计数断言。6 次失败尝试均保留，不能将启动成功、DDL 成功或夹具编译通过等同于 T03 通过。[启动证据](sqlserver-startup-probe-2026-10-17.json)、[全部尝试与复现说明](metadata-sqlserver-validation-2026-10-17.md)。

默认容器证书在 `disabled` 对照中报告有效期超限；仅在专属容器用镜像自带 OpenSSL 生成 7 天 RSA2048 自签证书，配置 SAN/serverAuth 和 mssql 可读的 0600 私钥后复验。`required_insecure` 仍报告 TLS `connection closed via error`，`disabled` 报告证书不受信任，因此仍未完成元数据验收。没有更换生产 TLS 后端、导入宿主信任、修改应用默认配置或安装依赖。[最终短证书失败证据](metadata-sqlserver-2022-attempt6-2026-10-17.json)。

全部尝试的随机专属容器、匿名卷和临时凭据已清理。最终 10 个源码哈希与当前文件匹配。需要可完成生产驱动 TLS 握手的隔离环境后才能勾选 SQL Server 子项；本机模拟不是官方支持平台，不能把当前失败泛化成所有 SQL Server 环境失败。

## 验收脚本可靠性

PostgreSQL runner 新增清理故障回归：启动失败或超时后仍核对专属标签；成功证据在清理之后生成；主失败与清理失败分别保留；临时凭据始终删除；源码身份纳入共享测试模块。5 项 mock 测试通过，不执行 SQL、Docker 或 Cargo。

ClickHouse 首轮实库断言通过，但脚本确认容器不存在时误判，整体按失败保留；后续复验不得覆盖失败尝试，也不将单个 `catalog.passed` 视为整体完成。

最终统一运行 29 项 Python mock 测试通过（PG 5、ClickHouse 11、SQL Server 8、既有 MySQL 5）；测试覆盖实际遇到的错误格式、0600 私有配置创建、清理中断、主失败与清理失败并存及归档失败。没有用这些 mock 结果代替实库验收。

## 最终回归与独立复核

默认 Rust 全套 786 项通过、0 失败、22 项忽略；bin/doc 各 0 个用例。PG 的 2 项和 ClickHouse 的 1 项 ignored 验收已在专属实库显式运行通过；SQL Server 的 ignored 用例未通过，不将默认忽略视为验收通过。Rust fmt、默认和 `performance-desktop` 两种配置的全目标 Clippy（`-D warnings`）、差异空白及本地链接检查通过。

独立只读复核确认 PG 原始计数/分位数和最终 5 个源码哈希、ClickHouse 6 个源码哈希、SQL Server 最后失败尝试的 10 个源码哈希均匹配；所有 SQL Server 失败、清理与权限验收未完成状态如实保留。最终只读 Docker 检查无本轮专属容器，下载镜像保留用于复现。命令、日志哈希及最终 17 个源码身份见 [本轮检查归档](docker-database-integration-2026-10-17.json)。

## 保留范围

这些数据库函数级验收不替代完整 Tauri 应用的目录/总 IPC、池等待、前端准备/渲染和整体 p95，也不替代 01/05/06 的内存、交互、最长任务或跨平台指标。旧多库端到端基线仍缺，不报告端到端加速百分比。
