# 批量更新

`batch_update_rows` 使用 `src-tauri/src/db/batch_update.rs` 统一规划 SQL。同一更新字段集合的行合并，字段排序固定；每块最多 128 行，并根据实际绑定参数数量进一步切分。整批始终在同一事务内执行，不会逐行发送 UPDATE。

| 数据库 | 集合更新方式 | 每块参数预算 |
| --- | --- | --- |
| MySQL | 物化派生表计算新值，再 `UPDATE JOIN` | 65535 |
| PostgreSQL | `UPDATE SET CASE`，ELSE 原列提供参数类型 | 65535 |
| SQL Server | `UPDATE SET CASE`，保持现有文本参数赋值转换 | 2000 |
| SQLite | `UPDATE SET CASE` | 999 |

参数预算包含重复定位条件的占位符；另外限制块行数，避免表达式过深。标识符按方言转义，数据始终绑定参数。PostgreSQL 缓存相同 SQL 形状的预编译结果。

## 一致性与边界

- 使用数据库实际主键（SQL Server 可使用现有唯一定位索引），验证完整复合键。NULL 定位值使用 `IS NULL`。
- 所有块先在事务内做集合查询校验，再执行集合 UPDATE；MySQL/PostgreSQL 固定可重复读隔离级别并使用 `FOR UPDATE`，SQL Server 使用 `UPDLOCK, HOLDLOCK`，防止校验后并发插入绕过去重。校验查询按块执行，不按行查询。
- 数据库比较规则决定目标是否重复，例如整数 `1`/`"01"`、不区分大小写的文本。同块、不同字段组、不同块的重复目标均报错并回滚。
- 主键变更使用原定位键计算所有赋值。MySQL 的 `DISTINCT` 派生表强制物化，避免修改一个主键列后改变其他赋值条件。
- 主键迁移额外检查新目标：若按数据库比较规则已被另一行占用，整批报错，需分次提交；存在主键修改时，所有原目标必须仍存在。普通字段更新继续允许缺失目标，计入影响行数为 0。新键最终是否满足唯一约束仍由数据库校验（例如 SQLite 可空复合主键自身允许含 NULL 的重复值）。
- 任一块失败回滚整批，影响行数按各数据库驱动的既有语义累加。集合更新的语句级触发器按块触发；行级触发器仍按数据库规则触发。

## 验证

常规运行 `npm run test:rust`。SQLite 测试使用临时真实数据库，覆盖 1100 行分块、后块失败回滚、复合键、NULL、数据库等价重复键和主键迁移。

MySQL/PostgreSQL 真库测试默认忽略，只对显式指定的隔离测试实例运行；测试会创建随机数据库/schema，不应指向生产实例：

```sh
DB_CONNECT_TEST_MYSQL_URL='mysql://user:password@127.0.0.1:3306' \
  cargo test --manifest-path src-tauri/Cargo.toml --lib mysql_batch_live -- --ignored
DB_CONNECT_TEST_POSTGRES_URL='postgres://user:password@127.0.0.1:5432/postgres' \
  cargo test --manifest-path src-tauri/Cargo.toml --lib postgres_batch_live_ -- --ignored
```

MySQL 测试在独占测试实例上检查全局 UPDATE 计数，1100 行应只产生 9 次集合 UPDATE；PostgreSQL 使用语句级触发器验证同字段多行只产生一次 UPDATE。SQL Server 目前覆盖规划器、参数绑定和目标校验单元测试，仍需真实服务器联调。

方言依据：[MySQL 派生表物化规则](https://dev.mysql.com/doc/refman/8.4/en/derived-table-optimization.html)、[PostgreSQL CASE 类型推断](https://www.postgresql.org/docs/current/typeconv-union-case.html)、[SQL Server CASE](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/case-transact-sql)、[SQLite 限制](https://www.sqlite.org/limits.html)。
