# MySQL 同步元数据兼容性设计

## 背景

旧版 MySQL 或部分 MySQL 兼容实现的 `information_schema.COLUMNS` 不包含
`GENERATION_EXPRESSION`。同步预览当前无条件读取该列，导致源端与目标端的
元数据采集均以 1054 错误失败。

## 目标

让不支持该系统列的连接能够生成普通表的同步预览，同时继续在支持该列的服务上
无损读取生成列表达式。

## 方案

每次读取某个 MySQL schema 的同步元数据前，执行一次 `information_schema.COLUMNS`
能力探测，判断 `information_schema.COLUMNS.GENERATION_EXPRESSION` 是否存在。

- 支持时，保留现有表达式列读取。
- 不支持时，元数据 SQL 返回 `'' AS generation_expression`，不引用不存在的系统列。
- 对实际生成列，既有的无损同步校验会因表达式缺失而阻止生成或修改 DDL；普通列不受影响。

该探测按连接端点执行一次，不会在表或字段循环中执行 SQL。

## 验收与测试

- SQL 构造测试覆盖支持与不支持两种能力状态。
- 不支持状态的 SQL 不得包含 `GENERATION_EXPRESSION`，但必须保留空字符串别名。
- 支持状态继续读取原生表达式列。
