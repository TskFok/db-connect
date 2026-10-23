# TLS 测试夹具

所有证书、密钥均由本次测试专门生成，绝非生产凭据。证书有效期为生成后 100 年，避免普通回归测试依赖短期证书续期。

- `ca.pem`：只供该套测试使用的根证书。
- `other-ca.pem`：不相关的根证书，用于验证错误 CA 被拒绝。
- `server.der`：由 `ca.pem` 签发的 X.509 v3 证书，SAN 为 `db-connect.test`。
- `server-key.der`：测试服务器的 PKCS#8 RSA 私钥。
- `legacy-self-signed.der`：使用同一测试私钥生成的 X.509 v1 自签证书，模拟旧 SQL Server 的证书形式。

根私钥已在临时目录中生成并删除，仓库不包含根私钥。所有 TLS 测试仅通过进程内双向流运行，不监听端口、不访问数据库。
