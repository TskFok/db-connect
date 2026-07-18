# 数据库结构同步手工验收矩阵

> 目标：在真实数据库上验证数据库结构同步的后端预览、执行、重新对比与安全边界。首期只同步物理表与字段，不同步数据、索引、外键、视图、触发器、例程、事件或权限。本文所有 `DROP DATABASE`、`DROP SCHEMA` 和文件删除命令都只能用于一次性测试环境。

## 验收口径

- 覆盖 MySQL / MariaDB、PostgreSQL、SQLite、SQL Server 与 ClickHouse。
- 源端和目标端必须配置成两个不同的同类型保存连接；即使它们指向同一实例，也不能复用同一个保存连接 ID。
- 每个用例都从对应的初始化 SQL 开始。除非用例另有说明，目标表应为空，避免类型收窄或增加 `NOT NULL` 字段被真实数据阻塞。
- 删除操作保持默认关闭，只有删除专项用例才开启。
- 预览中的 SQL 只能查看，不能编辑。记录预览显示的 12 位短指纹；后端实际使用完整的 64 位 SHA-256 指纹。
- 执行前后都保存数据库对比截图或导出结果；失败用例还应保存已成功语句、首个失败语句和未执行操作列表。
- “重新对比无对应差异”只指选中表的表 / 字段差异。索引、外键、视图等不在首期范围内，也不会被重新对比结果验证。
- SQLite 的已有字段类型、可空、默认值、主键、extra、注释或物理顺序变化需要重建表，首期会阻塞；因此五库都验证真实预览与执行路径，但“普通已有字段变更成功”仅适用于 MySQL / MariaDB、PostgreSQL、SQL Server 与 ClickHouse。

## 环境记录

执行前填写下表；未提供真实服务时必须标为“未执行”，不能用方言单测冒充真实数据库验收。

| 项目                            | 实际值 |
| ------------------------------- | ------ |
| 验收日期                        |        |
| 应用版本 / commit               |        |
| 操作系统                        |        |
| MySQL / MariaDB 版本、连接方式  |        |
| PostgreSQL 版本、连接方式       |        |
| SQLite bundled / `sqlite3` 版本 |        |
| SQL Server 版本、连接方式       |        |
| ClickHouse 版本、连接方式       |        |
| 验收人                          |        |

建议保存连接命名如下：

| 方言            | 源端保存连接             | 目标端保存连接           | 源端数据库 / schema | 目标端数据库 / schema |
| --------------- | ------------------------ | ------------------------ | ------------------- | --------------------- |
| MySQL / MariaDB | `sync-mysql-source`      | `sync-mysql-target`      | `db_sync_src`       | `db_sync_dst`         |
| PostgreSQL      | `sync-pg-source`         | `sync-pg-target`         | `db_sync_src`       | `db_sync_dst`         |
| SQLite          | `sync-sqlite-source`     | `sync-sqlite-target`     | `main`              | `main`                |
| SQL Server      | `sync-sqlserver-source`  | `sync-sqlserver-target`  | `db_sync_src`       | `db_sync_dst`         |
| ClickHouse      | `sync-clickhouse-source` | `sync-clickhouse-target` | `db_sync_src`       | `db_sync_dst`         |

## 基线初始化 SQL

每个场景开始前重新执行对应方言的源端和目标端初始化 SQL。表的用途固定如下：

- `source_only_table`：验证创建源端独有表。
- `tail_add`：验证在目标端末尾新增 `email` 字段。
- `ordinary_change`：验证普通已有字段变化；SQLite 应阻塞。
- `removal_case`：验证目标端独有字段 `legacy` 在删除关闭时跳过、开启时删除。
- `target_only_table`：验证目标端独有表在删除关闭时不可选 / 跳过、开启时删除。

### MySQL / MariaDB

源端初始化 SQL：

```sql
DROP DATABASE IF EXISTS db_sync_src;
CREATE DATABASE db_sync_src CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE db_sync_src.source_only_table (
  id BIGINT NOT NULL,
  note VARCHAR(120) NULL,
  PRIMARY KEY (id)
) ENGINE = InnoDB;

CREATE TABLE db_sync_src.tail_add (
  id BIGINT NOT NULL,
  name VARCHAR(80) NULL,
  email VARCHAR(255) NULL,
  PRIMARY KEY (id)
) ENGINE = InnoDB;

CREATE TABLE db_sync_src.ordinary_change (
  id BIGINT NOT NULL,
  label VARCHAR(120) NOT NULL,
  PRIMARY KEY (id)
) ENGINE = InnoDB;

CREATE TABLE db_sync_src.removal_case (
  id BIGINT NOT NULL,
  name VARCHAR(80) NULL,
  PRIMARY KEY (id)
) ENGINE = InnoDB;
```

目标端初始化 SQL：

```sql
DROP DATABASE IF EXISTS db_sync_dst;
CREATE DATABASE db_sync_dst CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE db_sync_dst.tail_add (
  id BIGINT NOT NULL,
  name VARCHAR(80) NULL,
  PRIMARY KEY (id)
) ENGINE = InnoDB;

CREATE TABLE db_sync_dst.ordinary_change (
  id BIGINT NOT NULL,
  label VARCHAR(40) NULL,
  PRIMARY KEY (id)
) ENGINE = InnoDB;

CREATE TABLE db_sync_dst.removal_case (
  id BIGINT NOT NULL,
  name VARCHAR(80) NULL,
  legacy VARCHAR(80) NULL,
  PRIMARY KEY (id)
) ENGINE = InnoDB;

CREATE TABLE db_sync_dst.target_only_table (
  id BIGINT NOT NULL,
  PRIMARY KEY (id)
) ENGINE = InnoDB;
```

### PostgreSQL

在专用测试 database 中执行。源端初始化 SQL：

```sql
DROP SCHEMA IF EXISTS db_sync_src CASCADE;
CREATE SCHEMA db_sync_src;

CREATE TABLE db_sync_src.source_only_table (
  id bigint PRIMARY KEY,
  note varchar(120)
);

CREATE TABLE db_sync_src.tail_add (
  id bigint PRIMARY KEY,
  name varchar(80),
  email varchar(255)
);

CREATE TABLE db_sync_src.ordinary_change (
  id bigint PRIMARY KEY,
  label varchar(120) NOT NULL
);

CREATE TABLE db_sync_src.removal_case (
  id bigint PRIMARY KEY,
  name varchar(80)
);
```

目标端初始化 SQL：

```sql
DROP SCHEMA IF EXISTS db_sync_dst CASCADE;
CREATE SCHEMA db_sync_dst;

CREATE TABLE db_sync_dst.tail_add (
  id bigint PRIMARY KEY,
  name varchar(80)
);

CREATE TABLE db_sync_dst.ordinary_change (
  id bigint PRIMARY KEY,
  label varchar(40)
);

CREATE TABLE db_sync_dst.removal_case (
  id bigint PRIMARY KEY,
  name varchar(80),
  legacy varchar(80)
);

CREATE TABLE db_sync_dst.target_only_table (
  id bigint PRIMARY KEY
);
```

### SQLite

创建两个只用于验收的文件：`/tmp/db-connect-sync-source.sqlite` 与 `/tmp/db-connect-sync-target.sqlite`。删除旧文件后，分别使用 `sqlite3 <文件路径>` 执行下列 SQL；两个保存连接都选择 `main`。

源端初始化 SQL：

```sql
CREATE TABLE source_only_table (
  id INTEGER PRIMARY KEY,
  note TEXT
);

CREATE TABLE tail_add (
  id INTEGER PRIMARY KEY,
  name TEXT,
  email TEXT
);

CREATE TABLE ordinary_change (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL
);

CREATE TABLE removal_case (
  id INTEGER PRIMARY KEY,
  name TEXT
);
```

目标端初始化 SQL：

```sql
CREATE TABLE tail_add (
  id INTEGER PRIMARY KEY,
  name TEXT
);

CREATE TABLE ordinary_change (
  id INTEGER PRIMARY KEY,
  label INTEGER
);

CREATE TABLE removal_case (
  id INTEGER PRIMARY KEY,
  name TEXT,
  legacy TEXT
);

CREATE TABLE target_only_table (
  id INTEGER PRIMARY KEY
);
```

重置命令：

```bash
rm -f /tmp/db-connect-sync-source.sqlite /tmp/db-connect-sync-target.sqlite
sqlite3 /tmp/db-connect-sync-source.sqlite
sqlite3 /tmp/db-connect-sync-target.sqlite
```

### SQL Server

使用专用测试 database；两个保存连接都连接到该 database，再分别选择源 / 目标 schema。源端初始化 SQL：

```sql
DROP SCHEMA IF EXISTS db_sync_src;
GO
CREATE SCHEMA db_sync_src;
GO

CREATE TABLE db_sync_src.source_only_table (
  id bigint NOT NULL CONSTRAINT PK_src_source_only PRIMARY KEY,
  note nvarchar(120) NULL
);

CREATE TABLE db_sync_src.tail_add (
  id bigint NOT NULL CONSTRAINT PK_src_tail_add PRIMARY KEY,
  name nvarchar(80) NULL,
  email nvarchar(255) NULL
);

CREATE TABLE db_sync_src.ordinary_change (
  id bigint NOT NULL CONSTRAINT PK_src_ordinary_change PRIMARY KEY,
  label nvarchar(120) NOT NULL
);

CREATE TABLE db_sync_src.removal_case (
  id bigint NOT NULL CONSTRAINT PK_src_removal_case PRIMARY KEY,
  name nvarchar(80) NULL
);
GO
```

目标端初始化 SQL：

```sql
DROP SCHEMA IF EXISTS db_sync_dst;
GO
CREATE SCHEMA db_sync_dst;
GO

CREATE TABLE db_sync_dst.tail_add (
  id bigint NOT NULL CONSTRAINT PK_dst_tail_add PRIMARY KEY,
  name nvarchar(80) NULL
);

CREATE TABLE db_sync_dst.ordinary_change (
  id bigint NOT NULL CONSTRAINT PK_dst_ordinary_change PRIMARY KEY,
  label nvarchar(40) NULL
);

CREATE TABLE db_sync_dst.removal_case (
  id bigint NOT NULL CONSTRAINT PK_dst_removal_case PRIMARY KEY,
  name nvarchar(80) NULL,
  legacy nvarchar(80) NULL
);

CREATE TABLE db_sync_dst.target_only_table (
  id bigint NOT NULL CONSTRAINT PK_dst_target_only PRIMARY KEY
);
GO
```

`DROP SCHEMA` 只适用于已清空的 schema。重复执行时应先删除专用测试 database，或先删除 schema 内对象，再重建 schema。

### ClickHouse

源端初始化 SQL：

```sql
DROP DATABASE IF EXISTS db_sync_src;
CREATE DATABASE db_sync_src;

CREATE TABLE db_sync_src.source_only_table (
  id UInt64,
  note String
)
ENGINE = MergeTree
ORDER BY id;

CREATE TABLE db_sync_src.tail_add (
  id UInt64,
  name String,
  email String
)
ENGINE = MergeTree
ORDER BY id;

CREATE TABLE db_sync_src.ordinary_change (
  id UInt64,
  label String
)
ENGINE = MergeTree
ORDER BY id;

CREATE TABLE db_sync_src.removal_case (
  id UInt64,
  name String
)
ENGINE = MergeTree
ORDER BY id;
```

目标端初始化 SQL：

```sql
DROP DATABASE IF EXISTS db_sync_dst;
CREATE DATABASE db_sync_dst;

CREATE TABLE db_sync_dst.tail_add (
  id UInt64,
  name String
)
ENGINE = MergeTree
ORDER BY id;

CREATE TABLE db_sync_dst.ordinary_change (
  id UInt64,
  label Nullable(String)
)
ENGINE = MergeTree
ORDER BY id;

CREATE TABLE db_sync_dst.removal_case (
  id UInt64,
  name String,
  legacy String
)
ENGINE = MergeTree
ORDER BY id;

CREATE TABLE db_sync_dst.target_only_table (
  id UInt64
)
ENGINE = MergeTree
ORDER BY id;
```

## 核心成功路径矩阵

每一行都先重置该方言基线，再从底部“数据库对比”入口完成对比。

| 方言            | 选项与选择                                                        | 预期预览                                                                                   | 预期执行结果                                               | 执行后重新对比                                                     |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| MySQL / MariaDB | 删除关闭；选择 `source_only_table`、`tail_add`、`ordinary_change` | 可执行；依次包含建表、末尾新增 `email`、修改 `label`；普通 / 高风险正确；无 `DROP`         | 勾选“已检查 SQL”后成功；返回全部成功语句，无失败和未执行项 | 三张选中表不再有对应表 / 字段差异；删除相关差异仍保留              |
| PostgreSQL      | 删除关闭；选择 `source_only_table`、`tail_add`、`ordinary_change` | 可执行；SQL 使用目标 schema；新增字段位于目标现有字段之后；普通变化为高风险；无 `DROP`     | 成功，最新对比结果随执行结果返回                           | 三张选中表不再有对应差异                                           |
| SQLite          | 删除关闭；只选择 `source_only_table`、`tail_add`                  | 可执行；包含 `CREATE TABLE main.source_only_table` 和末尾 `ADD COLUMN email`；无重建表 SQL | 成功，两个 SQLite 临时连接正常释放                         | 两张选中表不再有对应差异；`ordinary_change` 仍保留并在阻塞专项验证 |
| SQL Server      | 删除关闭；选择 `source_only_table`、`tail_add`、`ordinary_change` | 可执行；SQL 使用目标 schema 方括号限定名；普通变化为高风险；无 `DROP`                      | 成功；约束与字段 DDL 按预览顺序执行                        | 三张选中表不再有对应差异                                           |
| ClickHouse      | 删除关闭；选择 `source_only_table`、`tail_add`、`ordinary_change` | 可执行；建表保留源端 `MergeTree` / `ORDER BY`；增改字段使用目标 database；无 `DROP`        | 成功；返回成功语句清单                                     | 三张选中表不再有对应差异                                           |

另验证选择行为：先全选全部可同步表，再搜索 `tail_add` 或切换差异状态筛选；已选表总数保持不变。分别取消一张、选择多张、再次全选，预览请求中的表名应稳定排序且不重复。

## 删除保护矩阵

每行的“关闭”和“开启”是两个独立场景，都要重置基线。

| 范围                 | 选项与选择                                                                | 预期预览                                                                                                                                                                 | 预期执行结果                                                               | 执行后重新对比                                                      |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 五类数据库：删除关闭 | 保持默认关闭；选择 `tail_add` 和 `removal_case`；观察 `target_only_table` | `tail_add.email` 可执行；`removal_case.legacy` 显示“未开启包含删除操作”并跳过；完整 SQL 中不得出现任何 `DROP COLUMN` / `DROP TABLE`；纯目标端 `target_only_table` 不可选 | 只执行非删除 DDL；若只选择纯删除差异则计划没有可执行操作，执行按钮禁用     | `tail_add` 对应差异消失；`legacy` 和 `target_only_table` 差异仍存在 |
| 五类数据库：删除开启 | 开启“允许删除目标端结构”；选择 `removal_case` 和 `target_only_table`      | 两个删除操作标为删除风险；SQL 先列非删除阶段、最后列删字段 / 删表；摘要删除数正确                                                                                        | 先确认预览，再勾选不可回滚确认；危险按钮显示“确认并执行删除同步”；执行成功 | `removal_case.legacy` 与 `target_only_table` 的差异消失             |

验收时将五类数据库分别记录：

| 方言            | 删除关闭结果 | 删除开启结果 | 预览短指纹 | 证据 / 备注 |
| --------------- | ------------ | ------------ | ---------- | ----------- |
| MySQL / MariaDB |              |              |            |             |
| PostgreSQL      |              |              |            |             |
| SQLite          |              |              |            |             |
| SQL Server      |              |              |            |             |
| ClickHouse      |              |              |            |             |

## 结构漂移：旧指纹执行零条 DDL

对每个方言重置基线，选择 `source_only_table` 与 `tail_add`、删除关闭，生成预览并记下短指纹。在不重新预览的情况下，从外部客户端执行对应 SQL：

```sql
-- MySQL / MariaDB
ALTER TABLE db_sync_dst.tail_add ADD COLUMN external_change VARCHAR(20) NULL;

-- PostgreSQL
ALTER TABLE db_sync_dst.tail_add ADD COLUMN external_change varchar(20);

-- SQLite（在目标文件中执行）
ALTER TABLE tail_add ADD COLUMN external_change TEXT;

-- SQL Server
ALTER TABLE db_sync_dst.tail_add ADD external_change nvarchar(20) NULL;

-- ClickHouse
ALTER TABLE db_sync_dst.tail_add ADD COLUMN external_change String;
```

然后点击旧预览的确认执行。

| 方言       | 预期执行结果                                                       | 零 DDL 证明                                                                                            | 重新对比                                       |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| 五类数据库 | 提示“数据库结构已变化，请重新对比并预览同步计划”；不进入逐语句执行 | `source_only_table` 在目标端仍不存在，`tail_add.email` 仍不存在，只有外部加入的 `external_change` 存在 | 最新对比显示外部变化；必须生成新指纹后才能执行 |

## 首错停止与不承诺整批回滚

目标是让第一个“创建表”成功、后续“删除字段”失败。重置基线后，按对应方言增加一个不属于首期对比范围的依赖或权限限制：

### 失败注入

MySQL / MariaDB：让外键依赖目标端 `legacy` 字段。

```sql
ALTER TABLE db_sync_dst.removal_case
  ADD UNIQUE KEY uq_removal_legacy (legacy);
CREATE TABLE db_sync_dst.legacy_ref (
  id BIGINT NOT NULL PRIMARY KEY,
  legacy VARCHAR(80),
  CONSTRAINT fk_legacy_ref
    FOREIGN KEY (legacy) REFERENCES db_sync_dst.removal_case (legacy)
) ENGINE = InnoDB;
```

PostgreSQL：让视图依赖目标端 `legacy` 字段。

```sql
CREATE VIEW db_sync_dst.keep_legacy AS
SELECT legacy FROM db_sync_dst.removal_case;
```

SQLite：在目标文件中让视图依赖 `legacy` 字段。

```sql
CREATE VIEW keep_legacy AS SELECT legacy FROM removal_case;
```

SQL Server：让 schema-bound 视图依赖目标端 `legacy` 字段。

```sql
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO
CREATE VIEW db_sync_dst.keep_legacy
WITH SCHEMABINDING
AS
SELECT legacy FROM db_sync_dst.removal_case;
GO
```

ClickHouse：为该场景使用专门的目标账号；允许读取元数据和创建表，但不给 `ALTER DROP COLUMN` 权限。具体认证语法可能随版本变化，以下以支持 RBAC 的版本为例，先由管理员执行并把 `sync-clickhouse-target` 保存连接改用该账号：

```sql
DROP USER IF EXISTS sync_target;
CREATE USER sync_target IDENTIFIED WITH sha256_password BY 'replace-test-password';
GRANT SELECT, CREATE TABLE ON db_sync_dst.* TO sync_target;
```

确认 `SHOW GRANTS FOR sync_target` 中没有 `ALTER DROP COLUMN` 或更上层的 `ALTER` 权限。若当前 ClickHouse 版本还需要其他只读元数据权限，只补充预览所需权限，不得授予 `ALTER DROP COLUMN`。

五类数据库均选择 `source_only_table` 和 `removal_case`，开启删除并生成预览。确认执行后检查：

| 检查项     | 预期                                                              |
| ---------- | ----------------------------------------------------------------- |
| 预览顺序   | `source_only_table` 的建表操作排在 `removal_case.legacy` 删除之前 |
| 执行状态   | `partially_succeeded`，不是“整批失败并已回滚”                     |
| 已成功项   | 至少包含建表语句；目标端可实际查询到 `source_only_table`          |
| 首个失败项 | 指向删除 `removal_case.legacy` 的操作和语句序号；错误已脱敏       |
| 失败操作   | 由结构化 `failed` 单独报告操作 ID、失败语句序号和脱敏错误；若该操作还有后续 SQL，结果界面单独说明其未执行数量 |
| 未执行项   | `pending_operation_ids` 只保留失败操作之后完全未开始的操作；列表不重复失败操作，首错之后没有 SQL 被执行       |
| 重新对比   | 显示目标端真实部分状态；不能直接重试旧计划，必须重新对比 / 预览   |

若数据库版本不因上述依赖而拒绝删除，必须改用专门目标账号收窄第二类 DDL 的权限，直到稳定得到“前一语句成功、后一语句失败”；不得通过前端编辑 SQL 制造失败。

## 方言阻塞矩阵

这些用例都应在预览阶段返回阻塞项，`can_execute = false`，确认按钮禁用，目标端执行零条 DDL。

### SQLite：已有字段变化需要重建表

基线中的 `ordinary_change.label` 已满足条件：源端为 `TEXT NOT NULL`，目标端为 `INTEGER`。只选择 `ordinary_change`、删除开启或关闭各预览一次。

| 预期预览                                                                           | 预期执行                       | 重新对比   |
| ---------------------------------------------------------------------------------- | ------------------------------ | ---------- |
| 阻塞原因明确包含“SQLite 首期不重建表修改已有字段”；不生成近似 `ALTER` 或重建表 SQL | 执行按钮禁用，目标端列定义不变 | 差异仍存在 |

### PostgreSQL：identity、generated、分区与顺序

在基线之外初始化：

```sql
CREATE TABLE db_sync_src.identity_case (
  id bigint GENERATED ALWAYS AS IDENTITY,
  value text
);
CREATE TABLE db_sync_dst.identity_case (
  id bigint,
  value text
);

CREATE TABLE db_sync_src.generated_case (
  base integer,
  doubled integer GENERATED ALWAYS AS (base * 2) STORED
);
CREATE TABLE db_sync_dst.generated_case (
  base integer,
  doubled integer
);

CREATE TABLE db_sync_src.partition_case (
  id bigint,
  created_at date
) PARTITION BY RANGE (created_at);

CREATE TABLE db_sync_src.order_case (first_col integer, second_col integer);
CREATE TABLE db_sync_dst.order_case (second_col integer, first_col integer);
```

| 选择             | 预期阻塞原因                                      |
| ---------------- | ------------------------------------------------- |
| `identity_case`  | identity 原生元数据不一致，不能安全转换           |
| `generated_case` | generated 表达式 / 原生元数据不一致，不能安全转换 |
| `partition_case` | 创建分区表需要完整分区定义，首期不近似创建普通表  |
| `order_case`     | PostgreSQL 不支持安全调整字段物理顺序             |

### SQL Server：identity、computed 与顺序

在基线之外初始化：

```sql
CREATE TABLE db_sync_src.identity_case (
  id bigint IDENTITY(1, 1) NOT NULL,
  value nvarchar(40) NULL
);
CREATE TABLE db_sync_dst.identity_case (
  id bigint NOT NULL,
  value nvarchar(40) NULL
);

CREATE TABLE db_sync_src.computed_case (
  value integer NOT NULL,
  doubled AS (value * 2)
);
CREATE TABLE db_sync_dst.computed_case (
  value integer NOT NULL,
  doubled integer NULL
);

CREATE TABLE db_sync_src.order_case (
  first_col integer NULL,
  second_col integer NULL
);
CREATE TABLE db_sync_dst.order_case (
  second_col integer NULL,
  first_col integer NULL
);
```

| 选择            | 预期阻塞原因                                       |
| --------------- | -------------------------------------------------- |
| `identity_case` | identity 原生元数据不一致，不能安全转换            |
| `computed_case` | computed definition 原生元数据不一致，不能安全转换 |
| `order_case`    | SQL Server 不支持安全调整字段物理顺序              |

### ClickHouse：引擎与键表达式

在基线之外初始化：

```sql
CREATE TABLE db_sync_src.engine_case (id UInt64)
ENGINE = MergeTree ORDER BY id;
CREATE TABLE db_sync_dst.engine_case (id UInt64)
ENGINE = ReplacingMergeTree ORDER BY id;

CREATE TABLE db_sync_src.sorting_case (id UInt64, label String)
ENGINE = MergeTree ORDER BY (id, label);
CREATE TABLE db_sync_dst.sorting_case (id UInt64, label String)
ENGINE = MergeTree ORDER BY id;

CREATE TABLE db_sync_src.partition_case (id UInt64, event_date Date)
ENGINE = MergeTree PARTITION BY toYYYYMM(event_date) ORDER BY id;
CREATE TABLE db_sync_dst.partition_case (id UInt64, event_date Date)
ENGINE = MergeTree ORDER BY id;

CREATE TABLE db_sync_src.primary_case (id UInt64, label String)
ENGINE = MergeTree PRIMARY KEY (id, label) ORDER BY (id, label);
CREATE TABLE db_sync_dst.primary_case (id UInt64, label String)
ENGINE = MergeTree PRIMARY KEY id ORDER BY (id, label);
```

| 选择             | 预期阻塞原因           |
| ---------------- | ---------------------- |
| `engine_case`    | 首期不修改表引擎       |
| `sorting_case`   | 首期不修改排序键表达式 |
| `partition_case` | 首期不修改分区键表达式 |
| `primary_case`   | 首期不修改主键表达式   |

## 请求与凭据安全矩阵

原始无效请求无法通过正常 UI 发出时，应同时验证 UI 禁用状态和后端命令边界测试；不能只依赖前端校验。

| 场景           | 环境 / 请求                                                                                                  | 选项                 | 预期预览 / 执行                                                                                       | 重新对比 / 证据                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 不同数据库类型 | 源端选择 MySQL 保存连接，目标端选择 PostgreSQL 保存连接                                                      | 任意非空表选择       | UI 不允许形成请求；后端收到请求也拒绝“两侧数据库类型不一致”；零 DDL                                   | 两端结构不变；运行 `temporary_database::tests` / `database_sync::tests` 边界测试 |
| 同一保存连接   | 两端使用同一个保存连接 ID，即使 database / schema 不同                                                       | 任意非空表选择       | 拒绝“源端和目标端不能使用同一个保存连接”；零 DDL                                                      | 结构不变；保存错误截图                                                           |
| 空选择         | 对比成功后不选择表                                                                                           | 删除开关任意         | “预览同步”按钮禁用；后端原始空数组请求返回“请至少选择一张差异表”；零 DDL                              | 结构不变；前端与 Rust 测试均通过                                                 |
| 空表名         | 后端请求的 `selected_tables` 含空字符串或全空白                                                              | 删除开关任意         | 请求拒绝“同步表名不能为空”；零 DDL                                                                    | 结构不变；Rust 命令边界测试通过                                                  |
| 只读目标       | 目标保存连接勾选“只读连接”                                                                                   | 任意非空表选择       | 预览 / 执行拒绝“目标端保存连接配置为只读”；零 DDL                                                     | 结构不变                                                                         |
| 凭据错误与脱敏 | 新建目标保存连接，故意把密码设为唯一标记 `SYNC_SECRET_DO_NOT_PRINT_7f3c`，用户名或其他配置保持可触发认证失败 | 选择任意差异表并预览 | 错误说明连接侧别与数据库 / schema，但界面、返回错误和日志中都不得出现唯一标记；应显示掩码或不回显密码 | 搜索应用可见错误与测试日志确认无标记；目标结构不变                               |

凭据用例结束后立即删除该错误保存连接，不把测试密码提交到仓库、截图附件或 issue。

## 最终记录

| 方言 / 安全范围 | 源 / 目标初始化 | 选项 | 预览 | 执行 | 重新对比 | 结果与证据             |
| --------------- | --------------- | ---- | ---- | ---- | -------- | ---------------------- |
| MySQL / MariaDB |                 |      |      |      |          | 未执行 / 通过 / 失败： |
| PostgreSQL      |                 |      |      |      |          | 未执行 / 通过 / 失败： |
| SQLite          |                 |      |      |      |          | 未执行 / 通过 / 失败： |
| SQL Server      |                 |      |      |      |          | 未执行 / 通过 / 失败： |
| ClickHouse      |                 |      |      |      |          | 未执行 / 通过 / 失败： |
| 删除关闭 / 开启 |                 |      |      |      |          | 未执行 / 通过 / 失败： |
| 指纹漂移        |                 |      |      |      |          | 未执行 / 通过 / 失败： |
| 首错停止        |                 |      |      |      |          | 未执行 / 通过 / 失败： |
| 请求与凭据安全  |                 |      |      |      |          | 未执行 / 通过 / 失败： |

发布前要求：所有具备真实环境的行填写版本、结果与证据；任何未执行项必须写明缺少的服务、账号或权限条件，并安排补测，不能把“自动化测试通过”记录成“真实五库已验收”。
