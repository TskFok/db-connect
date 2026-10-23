# glib 0.18.5 安全回补

来源：crates.io `glib` 0.18.5，保留上游源码及 MIT 许可证。

原包 SHA-256（修改前 Cargo.lock）：`233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`。排除 registry 元数据及上游开发用 Cargo.lock；应用由项目 Cargo.lock 锁定依赖。

## 修复

- 公告：[RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)。
- 上游修复：[gtk-rs/gtk-rs-core #1343，提交 b5a4071](https://github.com/gtk-rs/gtk-rs-core/pull/1343/files)。
- 唯一运行时代码差异：`src/variant_iter.rs::VariantStrIter::impl_get` 将输出指针声明改为 `let mut p`，传给 `g_variant_get_child` 的参数由 `&p` 改为 `&mut p`。消除 FFI 经共享引用写入内存导致的未定义行为。

项目 Linux GTK3 依赖仍使用 glib 0.18；直接升至公告标记已修复的 0.20 会改变依赖族。此回补保留 0.18.5 的 API、ABI 和包版本，没有新增运行时依赖或审计忽略规则。按版本匹配的审计工具仍可能列出该公告；应结合本补丁证据评估，不能宣称版本号已升级。

## 验证

新增 `tests/security_variant_str_iter.rs` 覆盖字符串数组的正向、反向、跳跃和末项读取，含空字符串及 Unicode。使用 Rust 1.93.1、GLib 2.88.2 的 release 优化构建，原代码触发 SIGSEGV，回补后同一测试通过。

在安装 GLib 开发库（`pkg-config` 能找到 `glib-2.0`、`gobject-2.0`、`gio-2.0`）的环境执行：

```sh
CARGO_TARGET_DIR=/tmp/db-connect-glib-security-target cargo test --release \
  --manifest-path src-tauri/vendor/glib/Cargo.toml \
  --test security_variant_str_iter
```

release 模式是必要条件：debug 构建可能掩盖此未定义行为。测试不访问数据库或网络。

未来 Tauri/GTK 依赖链支持已修复的 glib 版本后，可移除本目录及根清单中的 glib 路径补丁；移除前需复核 Linux 构建与同一回归测试。
