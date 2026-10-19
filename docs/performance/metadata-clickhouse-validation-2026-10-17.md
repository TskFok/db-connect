# T03 ClickHouse 隔离目录验收（2026-10-17）

本轮通过生产 `clickhouse::list_tables_batch` 完成 ClickHouse 目录字段、权限可见性及服务端执行次数验收。仅新增独立 Python runner、内存安全回归和 ignored Rust 验收模块；生产适配器未修改。测试模块由主代理在 `db/mod.rs` 注册。没有新建分支、提交、推送、读取业务连接配置或连接业务库。

## 环境与隔离

- macOS 27.0.1 arm64，Rust 1.93.1，`cargo test` Debug 构建，SDK 26.5；当前 HEAD 为 `e43940a50159cf6e075c49f5faf115e19c047958`，包括工作区夹具改动。
- 官方镜像 `clickhouse/clickhouse-server:25.8`，实际服务端 **25.8.33.6 / Linux arm64**；镜像 ID 为 `sha256:0152dd511befe6a2c2ef53e930726179669b08116da78500b37c51c96ff5ee77`。最初尝试的 `:lts` 标签返回不存在，随后下载固定 25.8 系列；runner 自身不下载镜像，并强制 `--pull=never`。
- 每次使用新的随机专属容器名、hostname、标签和 loopback 随机 HTTP 端口，无主机目录挂载；容器上限为 2 CPU / 1536 MiB。只调整该临时容器的后台调度池与服务内存上限，没有修改 Docker 全局设置。
- 随机临时密码只用于该容器；夹具目录权限 0700、凭据文件权限 0600。Rust 在调用案例前校验 hostname、随机标记表及服务端版本。结束时再次校验标签，仅删除自己的容器及匿名卷，并验证容器已不存在；所有尝试的凭据文件均已删除。
- 主代理统一编译后才开始实库验证；与 PostgreSQL 性能采样及其他构建错开。这里是兼容性与执行次数验收，**没有采集或报告 ClickHouse p95**。

## 生产入口和旧语义对照

Rust 测试独立保留提交 `17e37adaa84cc7c79d53430432db726f6a81e768` 的单目录查询及字段映射，与生产批量入口逐字段比较，未调用已委托批量的新单库包装器。案例调用全部显式列出；循环只用于构造名称、内存映射和统计输出，不在循环内查询 SQL。初始化 DDL 通过一次客户端调用提交。

6 个请求去重后返回 5 个按首次请求保序的分组，包含两个不同目录中的同名表、空目录、缺失目录、含单引号/反引号/双引号/分隔符的目录与表名。普通表、视图、注释、引擎、行数/字节统计及其 NULL 语义均与独立旧查询一致；视图行数和字节统计保持 NULL。

| 账号/情形 | 验收结果 |
| --- | --- |
| 管理账号 | 请求范围内全部对象、字段与排序一致；同名表按目录隔离 |
| 仅一张表 SELECT | 仅该表可见；其他目录对象隐身；直接访问隐藏表数据报错 |
| 无对象授权 | 请求分组保留，但表列表均为空，与独立旧查询相同 |
| 错误密码 | 批量入口整次报错，不返回误导性的部分结果 |
| 空、缺失、不可见目录 | 保留旧 ClickHouse 系统目录过滤语义，返回空组；不将这种合法过滤宣称为权限错误 |

## 服务端计数

每个被测操作单独设置随机前缀的 `log_comment`。全部操作结束后显式执行一次 `SYSTEM FLUSH LOGS`，随后一次观察查询汇总 `system.query_log` 的初始查询终结事件，排除初始化、旧查询、观察者和日志刷新；同时检查计数批次中不存在隐藏失败。没有轮询数据库或在计数循环内发查询。

| 案例 | 服务端目录执行次数 |
| --- | ---: |
| 普通账号单目录 | 1 |
| 普通账号 6 输入 / 5 去重目录 | 1 |
| 普通账号 256 个缺失目录 | 1 |
| 单表 SELECT 账号的混合目录批次 | 1 |
| 无对象授权账号的混合目录批次 | 1 |
| 空输入 | 0 |
| 257 个不同名称，超限拒绝 | 0 |

最终原始记录为 [metadata-clickhouse-2026-10-17.json](metadata-clickhouse-2026-10-17.json)，包含上述服务端计数、权限矩阵、真实版本、镜像 ID、构建环境、测试命令、源码 SHA256 及清理结果。定向 Rust 实跑 **1 通过、0 失败、0 忽略**；默认全量测试仍会忽略该隔离用例，不应算作实库通过。

## 尝试及修复记录

1. [attempt1](metadata-clickhouse-2026-10-17-attempt1.json)：生产 Rust 实库断言全部通过；容器删除后的 Docker 返回 `error: no such object`，runner 原先仅匹配首字母大写，导致不存在验证误判并退出 1。后续只读检查确认该专属实例确实已删除。原失败证据保留。
2. [attempt2](metadata-clickhouse-2026-10-17-attempt2.json)：修正错误大小写识别后，Rust 实库断言及容器/匿名卷清理、凭据删除全部通过，退出 0。
3. 最终复验：限定审查后补上清理阶段中断仍删除凭据、源码 hash/归档失败保留主失败证据的保护；沿用相同 Rust 测试产物重新执行，全部通过，退出 0。最终记录的 runner/test/helper SHA256 与当前文件一致。

可复现的 11 项内存安全回归覆盖镜像缺失/socket 拒绝、镜像元数据脱敏、Docker 不存在报错的大小写/空白变体、自有标签校验、拒删错误标签、创建失败后的清理、清理中断后的凭据删除，以及 hash/归档失败不遮蔽原失败。它们不调用 Docker、不建立网络连接、不查询 SQL。

## 复现命令

本地没有镜像时，先在用户明确授权下载后单独执行：

```sh
docker pull clickhouse/clickhouse-server:25.8
```

静态安全回归与真实隔离验收分别执行；正式采样与构建/其他数据库基准错开：

```sh
python3 scripts/performance/test_metadata_clickhouse_validation.py
python3 scripts/performance/metadata-clickhouse-validation.py --preflight
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk python3 scripts/performance/metadata-clickhouse-validation.py --output docs/performance/metadata-clickhouse-YYYY-MM-DD.json
```

runner 在清理结束后才发布最终结果；失败时保留脱敏阶段、主失败、清理状态及凭据删除状态。重复执行时应使用新输出路径或先保存原尝试，避免覆盖历史失败。

## 边界

本记录完成 T03 中 **ClickHouse 25.8 LTS 单节点 Linux arm64** 的目录权限/字段/计数子项；T03 的 SQL Server 子项由另一夹具单独验收。没有覆盖其他 ClickHouse 版本、分布式集群、TLS、SSH，也没有完整 Tauri 应用的目录/分页 IPC、池等待、渲染、网络或整体 p95，因此不能据此勾选整个 T04 或宣称 03 全部验收完成。

NULL 统计的系统字段定义与 query_log 刷新/事件口径参考 [ClickHouse 官方 system.tables 文档](https://clickhouse.com/docs/reference/system-tables/tables)、[system.query_log 文档](https://clickhouse.com/docs/reference/system-tables/query_log)；容器用户初始化参考 [官方镜像说明](https://hub.docker.com/r/clickhouse/clickhouse-server/)。本记录中的通过结论以实际隔离证据为准。
