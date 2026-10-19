# T03 SQL Server 2022 隔离验收进度

**当前结论：隔离服务可启动，但更换容器内短期证书后，生产 Tiberius 连接仍在 TLS 阶段失败；T03 的 SQL Server 元数据验收未完成。** 容器内 `sqlcmd` 成功执行合成夹具与计数会话 DDL，不代表生产 Rust 批量入口已通过；尚未取得目录查询计数或权限对照结果。不把本机握手阻断解释成目录 SQL 或批量权限语义失败。

## 环境与隔离

- macOS 27.0.1 / arm64；Docker Desktop Linux `aarch64`，10 CPU，内存 8,319,504,384 字节。
- 用户授权下载官方 `mcr.microsoft.com/mssql/server:2022-latest`，平台 `linux/amd64`；镜像 ID/仓库 digest 均为 `sha256:cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718`。
- SQL Server Developer；每次随机独占名称和标签，随机 `127.0.0.1` 端口，容器上限 2.5 GiB / 2 CPU，`MSSQL_MEMORY_LIMIT_MB=2048`，不挂宿主目录。不读取保存连接，不修改 Docker 全局设置，不安装模拟器或依赖。
- 微软仅支持 Linux Intel/AMD x86-64 主机，模拟/转换环境未经测试且不受支持；本机可启动不改变该边界。见[微软容器部署说明](https://learn.microsoft.com/en-us/sql/linux/containers/deploy?view=sql-server-ver17)。
- Rust 使用 SDK 26.5、debug、离线锁定依赖。一次预编译遗漏 `SDKROOT`，默认 SDK 27 的链接器报未知架构；指定下述 SDK 后编译通过。此环境错误未计入数据库结果。

## 已完成与原始证据

1. [启动探测](sqlserver-startup-probe-2026-10-17.json)：约 10.689 秒出现 SQL Server ready 日志且 TCP 可连接。就绪检测未执行 SQL；探测容器及匿名卷清理成功。该时间仅是探测过程记录，不是性能基准。
2. [attempt1](metadata-sqlserver-2022-attempt1-2026-10-17.json)：合成库、schema、对象、临时账号和 XE 会话 DDL 已执行，runner 写私有配置时因 `Path.open(opener=...)` API 不支持失败；未运行 Rust 验收。已修为 `os.open(O_EXCL, 0600)`，保留失败证据。
3. [attempt2](metadata-sqlserver-2022-attempt2-2026-10-17.json)：夹具 DDL 成功，生产连接池首次借出身份连接超时，未进入目录断言。
4. [attempt3](metadata-sqlserver-2022-attempt3-2026-10-17.json)：同一生产 TDS 配置的单次底层连接失败。Cargo 测试名前缀使诊断标记漏收，JSON 如实保留空诊断；此后修复解析并改用 stderr，不改写原证据。
5. [attempt4](metadata-sqlserver-2022-attempt4-2026-10-17.json)：安全诊断明确为 Tiberius `Error::Tls`，没有服务端 SQL 错误码。生产 `required_insecure` / `trust_cert` 配置未改；未绕过生产入口取得元数据结果。
6. [attempt5](metadata-sqlserver-2022-attempt5-2026-10-17.json)：显式比较两种原生产配置。`required_insecure` 返回 `connection closed via error`；`disabled` 返回 `The validity period in the certificate exceeds the maximum allowed.`。仅本次随机 loopback 夹具选择了 `disabled`，两种模式都未通过；没有更改生产默认、驱动或宿主信任。
7. [attempt6](metadata-sqlserver-2022-attempt6-2026-10-17.json)：针对证书有效期问题，在专属容器首次启动服务前用镜像自带 OpenSSL 生成 7 天 RSA2048/SHA256 自签证书，SAN 含 `localhost`/`127.0.0.1`，包含 serverAuth、digitalSignature/keyEncipherment，私钥实际权限为 `600:mssql`。通过容器内 `mssql-conf network.tlscert/tlskey` 配置，以 mssql 运行服务；未安装工具、导出私钥或修改宿主信任。证书实际有效期为 2026-10-17 10:54:09—2026-10-24 10:54:09 UTC。`required_insecure` 仍返回 `connection closed via error`，`disabled` 改为 `The certificate was not trusted.`，未通过选定的 `required_insecure` 前置连接。没有盲改 TLS 协议或继续扩展宿主/驱动诊断。

六次正式尝试均已核对专属标签后清理容器和匿名卷，临时凭据文件均已删除。每份 JSON 保留当次 runner、测试、生产 SQL Server/共享 helper、模块与锁文件哈希；失败样本不合并成成功样本。运行时版本尚未由生产 TDS 读取，因此不把镜像标签当成已经验证的精确服务端版本。TLS 文本仅在剔除本次随机密码且检查不含 SQL 片段后输出；其他错误仅存阶段、类型或数值码。

## 已准备但未通过实库的断言

`src-tauri/src/db/metadata_sqlserver_tests.rs` 仅通过 `#[ignore]` 显式运行，使用生产 `build_sqlserver_pool` / `list_tables_batch`。独立单 schema SQL 和字段映射复制自优化前提交 `b8eae76de751ea26d33830dc7f0823ec9b2b8479`，不调用当前单目录包装器自证。

准备的矩阵包括：数据库内完整权限账号、仅对象读取及 DMV 必需权限的受限账号、缺少 DMV 权限的账号；空/缺失/特殊 schema、同名表、表/视图与 NULL 统计、去重保序、空和 257 个去重输入的零 SQL、单/多 schema 各一次集合读取，以及权限失败无部分成功。受限账号还显式验证未授权表数据读取被拒绝。上述目录/权限断言因 TLS 前置失败均尚未运行通过。

计数方案为 SQL Server 同步 `package0.event_counter`，分别统计目标账号的 `rpc_starting` 和 `sql_batch_starting`；集合目录按 RPC `statement` / batch `batch_text` 过滤。观察账号为 `sa`，不计入目标账号；任一会话/target 缺失使测试失败，不能将两次缺失值相等当作零 SQL。同步计数无需循环轮询 SQL。计数方案仅经过源码审查及 DDL 初始化，仍待真实生产查询校验。见[微软 Extended Events 目标说明](https://learn.microsoft.com/en-us/sql/relational-databases/extended-events/targets-for-extended-events-in-sql-server?view=sql-server-ver17)。

SQL Server 2022 的 `sys.dm_db_partition_stats` 要求 `VIEW DATABASE PERFORMANCE STATE` 与 `VIEW SECURITY DEFINITION`；夹具按此区分可读取和应失败账号。见[微软 DMV 权限说明](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-db-partition-stats-transact-sql?view=sql-server-ver17)。

## runner 验证与复现

Python 故障注入 8 项通过：正常私有凭据/清理后归档、create 超时但容器已创建、标签不匹配拒绝删除、测量与清理双失败、清理被中断仍删除凭据、源码 hash 失败保留主失败、最终路径写失败使本地归档标为失败，以及不存在容器错误的大小写/空白变体。全部使用 mock，没有访问 Docker 或数据库。

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/performance -p test_metadata_sqlserver_validation.py -v
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk cargo test --offline --locked --manifest-path src-tauri/Cargo.toml --lib metadata_access_isolated_sqlserver2022 --no-run
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk PYTHONDONTWRITEBYTECODE=1 python3 scripts/performance/metadata-sqlserver-validation.py --output /private/tmp/metadata-sqlserver-new-attempt.json
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk PYTHONDONTWRITEBYTECODE=1 python3 scripts/performance/metadata-sqlserver-validation.py --ssl-mode required_insecure --short-lived-certificate --output /private/tmp/metadata-sqlserver-short-cert-new-attempt.json
```

runner 使用本地已下载镜像，`--pull=never`；不覆盖已有证据。就绪循环仅检查日志/TCP/容器状态，短证书在首次启动服务前配置，无旧 ready 日志复用；夹具一次 `sqlcmd` 初始化，Rust 各案例显式调用，没有循环查询 SQL。后续需要可通过原生产配置握手的隔离环境，再重跑目录/权限/计数断言；当前不据此勾选 T03，不报告真实 IPC、应用交互、延迟收益或其他版本兼容性。
