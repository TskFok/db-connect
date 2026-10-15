# T05 命令级页大小补验报告（2026-10-14）

仓库：`/Volumes/CaseSensitive/workspace/myself/db-connect`。只实施已授权的最小命令回归；未提交、推送、新建分支、安装或升级依赖，未修改共享文档。

## 改动

- `src-tauri/Cargo.toml`：仅新增 `[dev-dependencies] tauri = { version = "=2.11.3", features = ["test"] }`。版本与既有 lock 和本机安装一致，启用空的 `test` feature 暴露 MockRuntime；生产依赖原样。
- `src-tauri/src/commands/data.rs`：仅在 `#[cfg(test)] mod tests` 新增两个测试；生产函数及页大小校验位置最终无改动。
- 未增加测试专用生产 helper。MockRuntime 提供真实 `State<AppState>`，直接调用生产 `query_table_data`；AppState 为空，未读保存连接、凭据或访问数据库。

## 可复现命令与结果

```sh
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  cargo test --offline --locked --manifest-path src-tauri/Cargo.toml \
  --lib result_budget_page_size
rustfmt --edition 2021 --check src-tauri/src/commands/data.rs
git diff --check -- src-tauri/Cargo.toml src-tauri/src/commands/data.rs
```

首次正常定向：3 passed、0 failed、0 ignored、801 filtered out，测试耗时 0.00s（编译 29.35s）。含原校验函数测试和两个新命令测试。

最终恢复后重新运行：3 passed、0 failed、0 ignored、801 filtered out，测试耗时 0.01s（编译 11.97s），exit 0。两个格式/空白检查 exit 0。

测试行为：

1. `result_budget_page_size_command_rejects_before_connection_access`：持有真实 manager mutex，`0/10_001/u32::MAX` 的命令 future 首次 `poll!` 就 `Ready(Err("每页行数必须在 1–10,000 之间"))`。不等待锁或连接。
2. `result_budget_page_size_command_accepts_boundaries_then_accesses_connection`：合法 `1/10_000` 在同样锁条件下首次 `poll!` 为 Pending，释放锁后继续等待同一 future 得到“连接不存在”。这个对照防止用提前返回替身误证“取连接前拒绝”。

没有固定睡眠、定时性能门槛或测试中的 SQL；循环仅遍历字面值并调用空 manager 命令。

## 负向变异

在生产 `query_table_data` 开头临时删除唯一的 `validate_table_page_size(page_size)?;` 后，运行相同定向命令。预期失败已观察：

```text
result_budget_page_size_command_rejects_before_connection_access ... FAILED
assertion `left == right` failed: 越界页大小 0 不得进入连接获取路径
  left: Pending
 right: Ready(Err("每页行数必须在 1–10,000 之间"))
test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 801 filtered out
MUTATION_EXIT_CODE=101
PRODUCTION_SOURCE_RESTORED=True
```

变异日志：[命令变异诊断](remaining-command-mutation-2026-10-14.txt)。运行脚本 `finally` 按原始字节立即恢复源文件，随后重新检查 diff 并完成上述最终通过。最终 diff 中没有生产语句变化；变异不会提交。

## 环境与依赖

最初未指定 SDKROOT 的定向命令在 `tauri` build-script 链接阶段 exit 101，未运行测试。错误为默认 MacOSX27.0.sdk 的 `.tbd` 出现 `unknown architecture arm64e.x1-macos/arm64e.x1-maccatalyst`。该问题与仓库既有基线记录一致；命令级改用已安装 MacOSX26.5.sdk 后通过。没有改系统 SDK 配置或安装工具。

`src-tauri/Cargo.lock` 在实施前后 `git diff` 均为空，SHA256 一致：

```text
7dc8410823fa4ef430e748953fb9a08409d0e397448ea67c4a53b073f81cff73
```

最终改动统计：Cargo.toml 增加 3 行；data.rs 增加 71 行测试。工作区其他文件变化属于并行任务，本任务未改动。

## 验收边界与交接

本补验只完成 T05 的“生产命令页大小越界在取连接之前拒绝”。它不是真实 Tauri IPC/WebView 测试、实库预算验收或性能/内存采样。没有证据表明 T05 整体完成。

后续统一集成已运行，结果见 [集成原始记录](remaining-integration-2026-10-14.json)；本报告中的定向/变异数据与全量数据分开记录。T03、T04、T05 全驱动真实验收及完整应用测量缺口见 [数据库验收边界](remaining-database-audit-2026-10-14.md)。
