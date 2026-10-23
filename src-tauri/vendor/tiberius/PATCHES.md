# Tiberius TLS 兼容回补

来源为 crates.io 官方 `tiberius 0.12.3`，保留原有 MIT / Apache-2.0 许可证。

- 下载地址：<https://crates.io/api/v1/crates/tiberius/0.12.3/download>
- 原始 crate SHA-256：`a1446cb4198848d1562301a3340424b4f425ef79f35ef9ee034769a9dd92c10d`
- `Cargo.toml.orig` 是未经修改的上游清单，供核对来源。
- 包含原始 `src/`、README、许可证；省略上游 Docker、示例和需要数据库的集成测试，仅保留库测试需要的开发依赖。

运行时代码仅修改 `src/client/tls_stream/rustls_tls_stream.rs`：

- 将 `tokio-rustls 0.24` 升至 `0.26.4`，根项目锁文件使用 `rustls 0.23.46` 和 `rustls-webpki 0.103.16`。
- 将 `rustls-native-certs 0.6` 升至 `0.8`，`rustls-pemfile 1` 升至 `2`，适配证书类型、证书读取和验证接口。
- 在本客户端显式选择 ring provider，不修改全局 provider，不依赖其他库启用的 AWS-LC feature。保持 TLS 1.2 / TLS 1.3 和现有 futures / Tokio 流适配。
- 系统根只接受成功解析的证书；没有可用根时返回错误，避免上游实现的 panic。

保持现有信任策略：默认使用系统根；指定 CA 时仅使用该 CA，保持 rustls 后端原有的实际行为；严格模式验证证书链、主机名和握手签名。显式 `trust_cert()` 继续跳过证书链和主机名检查，并保持上游 0.12.3 的 TLS 1.2 握手签名旁路；TLS 1.3 保留原有签名检查。`trust_cert()` 本来就是用户显式选择的不安全模式，这次升级没有扩大其使用范围，也没有将严格模式改为旁路。

2026-10-23 核对的官方 `tiberius 0.13.0` 已升级 TLS，但 `bb8-tiberius 0.16.0` 仍只接受 `tiberius ^0.12`；新版还将自定义 CA 改为追加到系统根。为保持现有 API 和信任范围，本次只回补 TLS。后续升级官方版本时应先处理连接池兼容性并明确评估 CA 策略，再移除此 patch。

参考：

- [Rustls 0.23 发布与 provider 迁移说明](https://github.com/rustls/rustls/releases/tag/v%2F0.23.0)
- [ServerCertVerifier 接口](https://docs.rs/rustls/0.23.46/rustls/client/danger/trait.ServerCertVerifier.html)
- [rustls-native-certs 证书加载 API](https://github.com/rustls/rustls-native-certs)
- [官方 Tiberius 0.13](https://docs.rs/crate/tiberius/0.13.0)
- [bb8-tiberius 0.16 清单](https://docs.rs/crate/bb8-tiberius/0.16.0/source/Cargo.toml)

新增 13 项 TLS 回归测试位于 `rustls_tls_tests.rs`，用内存双向流执行真实 TLS 握手，不连接数据库、不执行 SQL。覆盖正确和错误 CA、主机名、缺失和损坏的证书、严格模式的无效签名、显式信任行为、旧式 X.509 v1 自签证书、TLS 1.3 分片读写/flush/close、空系统根返回错误。测试夹具及私钥只用于测试，不得用于实际服务。

从仓库根目录运行：

```sh
CARGO_TARGET_DIR=/tmp/db-connect-tiberius-target cargo test --manifest-path src-tauri/vendor/tiberius/Cargo.toml --no-default-features --features rustls,tds73 --lib
CARGO_TARGET_DIR=/tmp/db-connect-tiberius-target cargo test --manifest-path src-tauri/vendor/tiberius/Cargo.toml --no-default-features --features native-tls,tds73 --lib
```

库测试会生成独立的本地 `Cargo.lock`，它不用于应用发布；应用始终使用 `src-tauri/Cargo.lock`。这里只覆盖 TLS 适配层，真实 SQL Server 的 TDS 协商和登录仍需要有服务端的集成环境验证。
