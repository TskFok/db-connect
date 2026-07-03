# Step 02: 后端客户端与连接生命周期规划

## 目标
在 Rust/Tauri 后端引入 ClickHouse client，补齐连接测试、连接注册、连接复用、ping、断开和保存连接反序列化能力，为后续查询命令提供 `DatabasePoolHandle::ClickHouse`。

## 文件改动边界
- 修改：`src-tauri/Cargo.toml`
- 修改：`src-tauri/Cargo.lock`
- 修改：`src-tauri/src/models/types.rs`
- 修改：`src-tauri/src/db/mod.rs`
- 修改：`src-tauri/src/db/adapter.rs`
- 修改：`src-tauri/src/db/connection.rs`
- 新增：`src-tauri/src/db/clickhouse.rs`
- 修改：`src-tauri/src/commands/connection.rs`
- 可选测试辅助：`src-tauri/src/db/clickhouse.rs` 内 `#[cfg(test)]` 模块
- 不改动：前端 UI 文件、表数据命令、DDL 命令。

## 任务清单
- [ ] 在 `Cargo.toml` 添加官方客户端依赖，建议使用别名避免与本地模块冲突：`clickhouse_rs = { package = "clickhouse", version = "0.15", default-features = false, features = ["rustls-tls", "lz4"] }`。
- [ ] 在 `DatabaseType` 增加 `ClickHouse`，保持 `#[serde(rename_all = "lowercase")]`，序列化值为 `clickhouse`。
- [ ] 在 `adapter.rs` 新增 `ClickHouseDatabaseAdapter`，内部持有 `ClickHousePoolHandle` 或可 clone 的 `clickhouse_rs::Client`。
- [ ] 在 `connection.rs` 新增 `ClickHouseActiveConnection`、`DatabasePoolHandle::ClickHouse`、`ActiveDatabaseConnection::ClickHouse`。
- [ ] 在 `ActiveDatabaseConnection::pool_handle`、`adapter_database_type`、`disconnect`、`force_disconnect` 中补齐 ClickHouse 分支。
- [ ] 新增 `prepare_clickhouse_connection`：支持 SSH 隧道时将 HTTP host/port 指向 `127.0.0.1:local_port`；根据 `ssl_mode` 生成 `http://` 或 `https://` URL；设置 user/password/database。
- [ ] 新增 `test_clickhouse_connection`：执行 `SELECT 1` 并返回延迟；失败时关闭 SSH 隧道。
- [ ] 新增 `clickhouse::ping_pool`：固定 3 秒超时执行 `SELECT 1`。
- [ ] 在 `ConnectionManager::prepare_connection`、`test_connection`、`ping` 中加入 ClickHouse 分支。
- [ ] 在 `commands/connection.rs::ping_connection` 中加入 ClickHouse 分支。
- [ ] 保存连接/导入导出测试补充 ClickHouse 类型，确保 `database_type: "clickhouse"` 不被解析成 MySQL。

## 测试命令
```bash
npm run test:rust -- connection
npm run test:rust -- commands::connection
npm run fmt:rust
npm run lint:rust
```

如本地有 ClickHouse 实例，再运行手工集成验证：
```bash
CLICKHOUSE_URL=http://localhost:8123 npm run test:rust -- clickhouse --ignored
```

## 验收标准
- Rust 枚举可正确反序列化 `"clickhouse"`，旧配置缺省值仍是 MySQL。
- `ConnectionManager::test_connection` 对 ClickHouse 执行 `SELECT 1` 成功返回延迟。
- 建立 ClickHouse 连接后 `active_connection_ids` 包含新连接，`ping` 返回 true。
- SSH 隧道连接失败时不会泄漏隧道资源。
- `list_saved_connections`、连接导入导出不会丢失 ClickHouse 类型。

## 风险控制
- 不在本步骤实现查询、DDL、数据编辑，避免连接层和业务层同时变化。
- TLS 先仅支持 `disabled` 与常规 `required` 映射；自定义 CA/PKCS#12 若官方客户端不直接支持，后续单独设计，不在本步骤硬拼。
- `clickhouse_rs::Client` clone 应作为连接池句柄复用，不要每个命令重新构造 client。
