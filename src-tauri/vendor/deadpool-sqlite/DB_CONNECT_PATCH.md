# deadpool-sqlite 安全依赖适配

来源为 crates.io 官方 `deadpool-sqlite 0.13.0`，保留 MIT / Apache-2.0 许可证与原始 `src/`。

- 下载地址：<https://crates.io/api/v1/crates/deadpool-sqlite/0.13.0/download>
- 原始 crate SHA-256：`9cea80311362fbc476e1f9568f50d5ec576a8bbb9375b7cdc1856e3216870440`。
- `Cargo.toml.orig` 保留上游原始清单；应用依赖由根 `src-tauri/Cargo.lock` 锁定。
- 省略上游开发用 Cargo.lock、测试数据库、集成测试和 CI 配置，移除清单中对应的集成测试入口。

仅修改清单：将 `rusqlite` 从 `0.38.0` 升到 `0.41.1`，相应最低 Rust 版本从 1.85 提高到 1.89。两个运行时源码文件均与官方包逐字节相同；连接创建、回收、阻塞任务调度、池 API 和默认 feature 保持上游实现。

原因：[RUSTSEC-2026-0459](https://rustsec.org/advisories/RUSTSEC-2026-0459.html) / CVE-2026-119375 影响内嵌 SQLite。攻击者提供页大小不一致的数据库及 WAL 文件时，查询可能返回进程内未初始化的缓存数据。`libsqlite3-sys >=0.39.0` 内嵌 SQLite >=3.54.0，包含[上游修复](https://github.com/sqlite/sqlite/commit/e5bf119821f25be1d7f10ef0a2edbe175289166e)。本项目锁定 `libsqlite3-sys 0.39.1`（SQLite 3.54.1）。

2026-11-12 核对：官方连接池 0.13 只支持 rusqlite 0.38，最新 0.14 仍只支持 rusqlite 0.40，均不能选择已修复的 libsqlite3-sys。采用此清单适配，避免继续使用有漏洞的 SQLite，也避免维护 SQLite C 源码的安全回补。

应用中两处 `Statement::column_names()` 改用 0.41 的迭代器接口；不改变列名及顺序。验证命令：

```sh
cargo tree --manifest-path src-tauri/Cargo.toml --locked -i libsqlite3-sys
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
```

上游发布支持安全 rusqlite 版本的连接池后，可在验证上述命令后移除此补丁。
