# 多数据库 Phase 6 手工测试矩阵

> 目标：覆盖 MySQL 与 PostgreSQL 的连接、浏览、SQL、CRUD、DDL、对象管理和 SQL 文件导入导出关键路径。自动化测试通过后，发布前至少按本矩阵完成一次真实数据库回归。

## 环境准备

- MySQL 8.x 或 MariaDB 10.7+：准备一个普通可写账号、一个只读账号、一个空测试库。
- PostgreSQL 14+：准备一个普通可写账号、一个只读账号、一个空测试 database，至少两个可写 schema。
- 两端都准备含表、视图、索引、外键、触发器、函数/过程（MySQL 可含事件）的样例库。

## 核心矩阵

| 场景 | MySQL / MariaDB | PostgreSQL | 预期 |
|------|------------------|------------|------|
| 连接测试 | 直连、SSH 隧道、SSL/TLS 各一次 | 直连、SSH 隧道、SSL/TLS 各一次 | 连接成功，失败时错误为中文且不泄漏密码 |
| 只读连接 | 勾选只读连接后尝试 INSERT / DDL / SQL 导入 | 勾选只读连接后尝试 INSERT / DDL / SQL 导入 | 写入口灰显或后端拒绝，提示“只读模式” |
| 实例/会话只读 | `@@read_only` / `@@super_read_only` 场景 | `transaction_read_only=on` 场景 | TRUNCATE 与 SQL 导入被拦截 |
| 对象浏览 | 数据库、表、视图排序与搜索 | schema、表、视图排序与搜索 | 树和概览正常展示，PostgreSQL 用 schema 语义 |
| SQL 编辑器 | SELECT、DML、DDL、多语句、EXPLAIN | SELECT、DML、DDL、多语句、EXPLAIN ANALYZE | 结果、影响行数、错误提示正常 |
| 数据 CRUD | 新增、编辑、批量更新、删除 | 新增、编辑、批量更新、删除 | 主键定位正确；无主键表写操作被明确拦截 |
| 表 DDL | 新建表、改列、删列、重命名、引擎修改 | 新建表、改列、删列、重命名；无引擎入口 | PostgreSQL 不展示 MySQL 专属能力 |
| 索引 | 普通、唯一、删除 | btree/hash/gin 等可用方法、删除 | 列表与 DDL 执行成功 |
| 外键 | 新增、删除、关系图 | 新增、删除、关系图 | 方向、引用列和规则展示正确 |
| 触发器 | 列表、查看、创建、删除 | 列表、查看、创建、删除（调用已有函数） | DDL 展示完整，删除后列表刷新 |
| 函数/过程 | 列表、查看、删除 | 列表、查看、删除 | PostgreSQL identity arguments 正确定位重载 |
| 事件 | 列表、查看、启停、删除 | 不展示事件入口 | PostgreSQL UI 不误展示无等价能力 |
| SQL 文件导入 | 导入含表/视图/触发器/事件的 `.sql` | 导入含 schema/table/view/index/fk/trigger/function 的 `.sql` | 失败时显示语句序号与摘要；成功后刷新对象树 |
| SQL 文件导出 | 结构导出；结构 + INSERT 导出 | schema/table/view/index/fk/trigger/function + 可选 INSERT | 导出 SQL 可导入空库 / 空 schema |
| 错误体验 | 权限不足、路径不可写、SQL 语法错误 | 权限不足、路径不可写、SQL 语法错误 | 均返回明确中文错误 |

## 导入导出专项

1. MySQL 导出结构 + 100 行 INSERT，导入新库后核对表、视图、触发器、事件和行数。
2. PostgreSQL 导出结构 + 100 行 INSERT，导入新 schema 后核对表、视图、索引、外键、触发器、函数/过程和行数。
3. PostgreSQL 导入包含 `$$...$$` 函数体且函数体内有分号的 SQL 文件，确认不会被错误拆句。
4. 将导出路径指向不可写目录，确认错误提示包含权限或路径原因。
5. 导入包含一条故意错误语句的 SQL 文件，确认后续语句继续执行并展示失败语句序号。

## 发布前记录

- 记录测试日期、应用版本、数据库版本、操作系统。
- 任一阻塞问题需补自动化回归测试或单独建发布阻断 issue。
