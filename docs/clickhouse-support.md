# ClickHouse 支持说明与手工验证清单

## 当前支持

- 连接：HTTP/HTTPS（默认 8123），支持直连与 SSH 隧道。
- 浏览：database、表、视图、列结构、排序键/主键信息。
- SQL：SELECT/SHOW/DESCRIBE/EXPLAIN/WITH 查询与 DDL/DML 执行；只读连接会拒绝写类 SQL。
- SQL 文件导入：支持多语句、多行 `CREATE TABLE`、`INSERT INTO ... VALUES`、`INSERT INTO ... FORMAT` 数据块；导入持续上报进度，失败会记录语句序号和摘要。
- SQL 文件导出：结构导出通过一条 `system.tables` 元数据查询读取表/视图 `create_table_query`；可选数据导出按表执行 `SELECT ... FORMAT Values`，受每表行数上限保护，并支持在表与表之间协作式取消。

## 当前限制

- 不支持表格行级 update/delete。
- 不支持触发器、外键、例程和事件。
- 数据导出需要显式勾选；默认只导出结构，避免大表意外导出。
- `INSERT ... FORMAT` 导入建议使用独立一行 `;` 结束数据块，避免原始数据中的分号被误判为语句结束。

## 手工验证清单

| 场景 | 操作 | 预期 |
| --- | --- | --- |
| 直连 | 使用 ClickHouse 类型、host、8123、database、账号密码连接 | 连接成功，库表树正常加载 |
| HTTPS | `ssl_mode=required` 连接 HTTPS 端口 | 连接成功；不支持的自定义 CA/PKCS#12 配置给出明确错误 |
| SSH | 通过 SSH 隧道连接远端 ClickHouse HTTP 端口 | 隧道建立后连接成功，断开连接释放隧道 |
| SQL 执行 | 执行 `SELECT 1`、`CREATE TABLE`、`INSERT INTO ... VALUES` | 查询返回结果，DDL/DML 返回成功或明确错误 |
| 只读连接 | 勾选只读连接后执行 DDL/DML 或导入 `.sql` | 前端入口拦截，后端直接调用也拒绝写入 |
| 系统库保护 | 尝试删除 `system`、`INFORMATION_SCHEMA` 等系统库 | 删除入口禁用或后端返回系统库保护错误 |
| SQL 导入 | 导入包含多行 DDL、`INSERT ... VALUES`、`INSERT ... FORMAT JSONEachRow` 的文件 | 语句数识别正确；导入进度持续更新；失败显示具体语句位置 |
| 结构导出 | 默认导出 database | 文件包含 `CREATE DATABASE`、表/视图 DDL，不包含数据 |
| 大结果集保护 | 勾选导出数据并设置较小每表行数 | 数据按每表上限导出，导出进度与失败表名明确 |
| 导出取消 | 勾选导出数据后开始导出，再点击“取消导出” | 当前表请求结束后停止后续表导出，并提示导出已取消 |
| 连接导入导出 | 导出包含 ClickHouse 的连接配置后重新导入 | `database_type: "clickhouse"` 保留，不回退为 MySQL |
| 保存 SQL/收藏表 | 同一 host/port 下分别建立 MySQL 与 ClickHouse 连接 | 保存 SQL、收藏表和连接复用不串数据 |
