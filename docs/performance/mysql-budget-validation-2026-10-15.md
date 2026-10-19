# T05 MySQL 生产命令预算实库补验

本记录对应 `scripts/performance/mysql-budget-validation.py` 和 `src-tauri/src/commands/data_mysql_budget_tests.rs`。MySQL 8.4.11 隔离实库的定向测试已通过：1 passed / 0 failed，测试耗时 4.38 秒，runner 退出码 0；自有容器及匿名卷清理成功。原始证据见 [MySQL 8.4 JSON](mysql-budget-8.4-2026-10-15.json)。这补齐 MySQL 的部分 T05 真实引擎证据，不代表 T05 完整应用/全驱动验收完成。

## 本轮执行结果

执行时间为 2026-10-15 02:51:08—02:51:31 UTC；macOS Darwin 27.0.0 / arm64，debug Rust 测试，SDK 26.5；HEAD 为 `e43940a50159cf6e075c49f5faf115e19c047958` 加工作区变更。镜像 ID 为 `sha256:6ea90827b1100f8f2ae306a539f86d2c264a26ed435a2a9f75551dd5c3aeb242`。测试耗时仅记录执行事实，不是性能基准样本。

生产无键表页、单键/复合键完整行均准确返回 32 MiB 预算错误；各次失败后的显式查询通过。单键/复合键预览、无键回源拒绝、空表列描述、连接前预取消及旧句柄隔离断言全部通过。具体断言集合保存在 JSON 的 `assertions.passed`，未测边界在 `assertions.not_measured`。

runner 实库执行版本 SHA-256 为 `18faeda1dd2dd8a48747a504767ab297c2528dd3e47ef3caed4eddabf430a6ae`；执行结束时已逐项核对 JSON 中全部 8 个源码/锁文件哈希与当时文件一致。实库运行期间没有修改脚本。随后仅修订 runner 清理异常处理，见下节；保留旧 JSON 中的原执行版本，不能把当前修订版表述为已完成实库运行。MySQL 8.0 尚未运行，原生 5.7 尚未纳入此独立 runner。

## 清理异常证据修订

独立审查发现旧 runner 的 `finally` 内，`docker inspect` / `docker rm` 或标签校验异常会跳过证据写出。已用嵌套 `try/finally` 修复：`measurement_status` 保留原测量状态，`cargo_exit_code` 和已有断言继续保留；清理失败时总 `status` 为 `failed`，`container_and_volumes_removed` 为 `false`，`cleanup_error` 仅保存阶段与异常类型，写出证据后抛出失败。标签不匹配时禁止执行 `docker rm`；测量和清理均失败时同时保留两阶段错误信息，不保存可能包含 SQL 或结果的异常文本。

当前修订 runner SHA-256 为 `0fa85fa5e67cf9160d8b5bb0014dfbb6e0a78a3370b3cc91ee0efe9f3bf91a35`。新增 `scripts/performance/test_mysql_budget_validation.py` 通过替换子进程调用运行真实 `main()`，覆盖清理 inspect 失败、rm 失败、标签不匹配、测量与清理双失败、正常成功共 5 项。先在旧 runner 复现 4 项失败、1 项通过，再修复后 5/5 通过，退出码 0。全部为模拟子进程故障注入，没有启动真实数据库或重新编译 Rust。

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/performance -p test_mysql_budget_validation.py -v
```

既有 [8.4 原始 JSON](mysql-budget-8.4-2026-10-15.json) 未改写，其 SHA-256 仍为 `534079fe6c4ebda8f4a71e0f98a72aad20171dc59045e4ad8300065f456c2d86`。本次修订仅增加清理失败记录，不改变 SQL 夹具、Rust 测试或预算路径，正常实库结果沿用原执行版本的历史证据。

## 可复现命令

只使用本机已有镜像，不拉取镜像、不安装依赖、不访问保存连接。正式执行需单独安排，避免并行编译/测量影响环境；本测试不报告性能耗时或提升比例。

```sh
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk python3 scripts/performance/mysql-budget-validation.py --image mysql:8.4 --output docs/performance/mysql-budget-8.4-2026-10-15.json
```

可显式替换为本机已有的 `mysql:8.0`，同时使用独立证据文件路径。输出路径已存在时拒绝覆盖。进入实例运行阶段后的失败保存证据，并尝试清理自有容器/匿名卷；镜像缺失或 Docker 不可用等预检失败不启动实例、不生成测量 JSON，可能留下空临时目录。重跑 MySQL 8.4 需换新的输出路径；尚未运行的版本不能并入通过矩阵。

## 入口与断言

- Tauri `MockRuntime` 仅提供真实 `State<AppState>`；由空 `AppState::new()` 注册新建的生产 `ConnectionManager` MySQL 连接，直接调用生产 `query_table_data` / `query_full_rows` / `cancel_table_query`，不只调用私有 `ResultBudget`。
- 一次集合初始化三个形状的表：无主键、单列整数主键、复合整数主键。每表六行各含 9 MiB 的 ASCII `LONGTEXT`，另有一行 7 字节对照值。页大小 10，无键表不允许预览降载，因此在第四个大字段累计超过 32 MiB 后返回准确的预算错误；仍存在未读取行。命令返回 `Err`，没有返回静默半页。
- 单键和复合键的正常表页返回 120 字符预览及准确 `byte_length`；各自完整行集合回查全部六个大值，同样整次预算失败。每个预算错误后显式执行后续生产表页或完整行命令，证明同一连接管理器仍可用。MySQL 生产代码会丢弃失败连接；此处不宣称复用了已丢弃的物理连接。
- 无主键的完整行请求应明确拒绝。空无键页、空复合键页和不存在定位值的复合键完整行回查必须保留列描述、返回空行。
- 预取消后，在持有连接管理器锁时单次 `poll` 必须立即得到取消错误，证明没有等待/取得连接。新命令已登记且阻塞在管理器锁时，对旧已完成句柄及旧取消句柄重复取消必须返回 `false`；释放锁后新命令真实入库成功。这是确定性的命令/注册器与真实新查询组合验证。

SQL 初始化一次集合执行，之后逐个显式案例调用；内存 locator 构造的 `map` 不执行 SQL。就绪循环只调用 `mysqladmin ping` 协议探活，不轮询 SQL。

## 隔离与证据边界

容器名称及标签包含随机标记，镜像固定 `--pull=never`，仅映射 `127.0.0.1` 随机非 3306 端口；清理前核对标签。测试限定 `/private/tmp/db-connect-budget-mysql-{marker}` 路径、容器名格式、版本、服务 UUID、大小写模式、内部端口和数据库 marker，不读取业务凭据。仅在隔离容器启用空 root 密码，证据不写凭据、完整 SQL 或结果内容。

本补验不覆盖正在服务端执行期间的取消/KILL、100,000 行边界、其他驱动、真实 IPC/WebView 或 Rust/WebContent 内存；这些仍需独立证据。32 MiB 是单结果 JSON 预算，不是进程 RSS 上限。预取消/旧句柄用例不能表述为服务端活动查询中断验收。

准备阶段的新 Rust 文件 `rustfmt --edition 2021`、Python `ast.parse`、runner `--help` 与 `git diff --check` 退出码均为 0；主代理统一 `cargo --lib --no-run` 退出 0 后，单独执行上述实库命令。未将语法/格式检查当成 Rust 编译或实库测试通过。
