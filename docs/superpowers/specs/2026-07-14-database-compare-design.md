# 数据库对比功能设计

## 背景与目标

DB Connect 当前支持 MySQL/MariaDB、PostgreSQL、SQLite、SQL Server 与 ClickHouse，并已具备保存连接、浏览数据库或 schema、查询表与字段元数据以及导出 Excel 的基础能力。

本功能允许用户从两个已保存连接中分别选择数据库或 schema，比较物理表及字段结构差异，并将差异导出为 Excel。对比过程独立于当前工作区连接，不切换或污染用户正在浏览的连接状态。

## 范围

### 包含

- 支持全部现有数据库类型：MySQL/MariaDB、PostgreSQL、SQLite、SQL Server、ClickHouse。
- 仅允许相同数据库类型的两个不同已保存连接进行对比。
- 分别选择源端和目标端的数据库或 schema。
- 比较物理表是否存在。
- 比较同名表的字段结构：字段顺序、类型、可空、默认值、主键、额外属性和注释。
- 在界面中搜索、筛选、展开查看差异。
- 将摘要、表差异和字段差异导出到一个 `.xlsx` 文件的三个工作表。

### 不包含

- 不比较视图及视图定义。
- 不比较索引、外键、触发器、例程、事件、权限或表数据。
- 不支持不同数据库类型之间比较。
- 不生成或执行结构同步 SQL。
- 不保存历史结构快照。
- 不把临时对比连接加入当前活动连接列表。

## 用户流程与界面

### 入口

在应用底部状态栏新增“数据库对比”入口，使用户在未连接、已连接或正在浏览数据库时都能打开对比窗口。

### 端点选择

对比窗口顶部显示左右两个选择区：

- 源端：已保存连接、数据库/schema。
- 目标端：已保存连接、数据库/schema。

选择规则：

- 目标连接只显示与源连接数据库类型相同的连接。
- 未选择源连接前禁用目标连接选择，形成明确的“先源端、后目标端”流程。
- 源端和目标端不能选择同一个保存连接。
- 选择保存连接后，由后端临时连接并加载其数据库/schema 列表。
- 连接变更后清空该侧数据库/schema 选择及旧的对比结果。
- 两侧选择完整后才允许开始对比。
- 提供“交换两端”操作，同时交换连接、数据库/schema 与已加载列表；交换后清空旧结果。

### 结果展示

结果区只显示存在差异的表。顶部显示四个摘要数量：

- 仅源端表。
- 仅目标端表。
- 结构变化表。
- 差异字段总数。

用户可以按表名搜索，并按“全部、仅源端、仅目标端、结构变化”筛选。主表格显示表名和状态；结构变化表可展开查看字段级差异。字段行显示字段名、状态、变化属性以及源端和目标端的字段属性。

若没有差异，显示“两个数据库结构一致”。若对比失败，保留端点选择并显示带侧别和连接名称的错误，允许重试。

### Excel 导出

对比成功后启用“导出 Excel”。文件包含三个工作表：

1. `对比摘要`：数据库类型、两侧连接名称、两侧数据库/schema、对比时间和各类差异数量。
2. `表差异`：表名、差异状态。
3. `字段差异`：表名、字段名、差异状态、变化属性、源端值、目标端值。

Excel 中使用中文状态文本。空值导出为空字符串，布尔值导出为“是/否”，多个变化属性以顿号分隔。已修改字段的源端值和目标端值分别按“属性=值”组成文本并以分号分隔；单侧字段导出该侧完整字段属性摘要，另一侧留空。仅源端或仅目标端的整表差异记录在“表差异”中，不为其所有字段重复生成“字段差异”行。

## 架构

采用“后端采集并计算差异，前端展示和导出”的方案。新增独立的 Rust `database_compare` 命令模块和前端 `DatabaseCompareModal` 组件。

### 后端命令

#### `list_compare_databases`

输入：

- `saved_connection_id`

行为：

1. 从加密连接存储中读取指定连接的完整配置。
2. 在连接管理器锁外建立临时连接。
3. 查询可用数据库/schema 列表。
4. 显式释放连接池与 SSH 隧道。
5. 返回数据库/schema 名称列表。

该连接不注册到 `ConnectionManager`，不改变当前活动连接。

#### `compare_databases`

输入：

- `source`：保存连接 ID、数据库/schema 名称。
- `target`：保存连接 ID、数据库/schema 名称。

行为：

1. 加载两侧完整保存配置。
2. 校验两个连接不同且数据库类型相同。
3. 并行建立两个临时连接。
4. 分别用单次批量元数据查询采集指定数据库/schema 的所有物理表和字段。
5. 在 Rust 中计算差异并稳定排序。
6. 显式释放两侧连接资源。
7. 返回结构化差异结果。

任一侧失败时整体失败，不返回部分结果。若一侧已建立连接而另一侧失败，仍须释放成功建立的一侧。

### 批量元数据采集

所有数据库实现都必须以数据库/schema 为单位批量查询，不得在表循环中执行 SQL：

- MySQL/MariaDB：查询 `information_schema.tables` 和 `information_schema.columns`，限定 `TABLE_TYPE = 'BASE TABLE'`。
- PostgreSQL：查询 `information_schema.tables/columns` 并关联系统约束目录以识别主键，限定物理表。
- SQLite：以目标 schema 的 `sqlite_schema` 联合表值形式的 `pragma_table_info`，一次读取所有物理表字段，并排除 SQLite 内部表。
- SQL Server：查询并关联 `sys.tables`、`sys.schemas`、`sys.columns`、`sys.types`、默认约束及主键目录。
- ClickHouse：查询并关联 `system.tables` 与 `system.columns`，限定普通物理表并排除视图。

查询结果映射为统一的内部快照模型。各数据库适配器负责把系统目录字段组装为稳定的 `column_type`、默认值、主键和额外属性表达，但不做跨数据库类型归一化。

### 临时连接生命周期

对比命令复用现有 `ConnectionManager::prepare_connection` 建立连接，但不调用 `register`。后端提供最小范围的内部访问能力以取得数据库池句柄并显式断开临时连接。

网络 I/O 不在全局连接管理锁内执行。两侧建立连接及元数据查询可以并行，但清理逻辑必须覆盖成功、失败和提前返回路径。解密后的密码只存在于 Rust 内存，不返回前端，也不得写入日志或错误文本。

## 数据模型

后端对外返回以下概念模型，Rust 使用 `snake_case` 序列化，TypeScript 使用相同字段名：

```text
CompareEndpointInfo
  connection_id
  connection_name
  database

ColumnSnapshot
  ordinal_position
  column_type
  nullable
  default_value
  primary_key
  extra
  comment

ColumnDiff
  name
  status: source_only | target_only | changed
  changed_fields[]
  source?
  target?

TableDiff
  name
  status: source_only | target_only | changed
  columns[]

DatabaseCompareSummary
  source_only_tables
  target_only_tables
  changed_tables
  different_columns

DatabaseCompareResult
  database_type
  source
  target
  compared_at
  summary
  tables[]
```

`changed_fields` 只允许以下稳定标识：`ordinal_position`、`column_type`、`nullable`、`default_value`、`primary_key`、`extra`、`comment`。前端负责映射为中文标签。

`compared_at` 使用后端生成的 UTC RFC 3339 时间。`extra` 使用数据库适配器生成的稳定标记组合，例如 `auto_increment`、`identity` 或 `generated`；没有额外属性时为空字符串。

## 比较规则

- 表名和字段名按数据库返回的原始名称精确匹配。
- 仅源端存在的表标记为 `source_only`。
- 仅目标端存在的表标记为 `target_only`。
- 同名表中存在字段增删或任一字段属性变化时，表标记为 `changed`。
- 同名字段的七项属性逐项比较；字段顺序变化属于结构变化。
- 完全一致的表不进入返回结果。
- 表按名称稳定排序；字段差异优先按两侧可用的最小字段顺序排序，再按字段名排序。
- `different_columns` 统计 `changed` 表中的字段差异条目数，包括仅源端字段、仅目标端字段和已修改字段。

## 前端职责

前端新增：

- Tauri 命令封装与 TypeScript 类型。
- `DatabaseCompareModal`：管理端点选择、加载状态、对比结果、搜索筛选、交换和重试。
- 纯展示辅助函数：状态中文映射、变化属性格式化、字段属性格式化。
- Excel 工作簿生成函数，复用现有 `write-excel-file/universal`、系统保存对话框和 `write_binary_file`。

对比窗口关闭时清空组件本地状态。后端命令本身不维持长生命周期会话，因此关闭窗口不需要额外取消命令；已发出的命令完成后会自行清理临时连接。

## 错误处理

后端必须给出可读且不包含凭据的错误：

- 保存连接不存在或已删除。
- 两侧选择了同一个保存连接。
- 两侧数据库类型不一致。
- 临时连接或 SSH 隧道建立失败，并标明源端或目标端及连接名称。
- 数据库/schema 不存在或无元数据读取权限。
- 批量元数据查询失败。
- 连接资源释放失败时，对比失败则保留原始错误并记录不含敏感信息的清理错误；对比成功但释放失败时返回清理失败，避免隐藏资源问题。

前端在失败后保留两侧选择，清空旧结果并显示错误。加载数据库/schema 失败只影响对应一侧，可重新选择或重试。

## 测试策略

### Rust

- 纯差异算法：仅源端表、仅目标端表、字段增删、每种属性变化、字段顺序变化、完全一致、稳定排序和汇总计数。
- 输入校验：连接相同、类型不一致、保存连接不存在。
- 各数据库元数据查询构造与行映射：查询限定物理表，所有字段一次返回，不产生逐表 SQL 循环。
- SQLite 临时数据库集成测试：物理表与视图过滤、复合主键、默认值、字段顺序、自增或额外属性。
- 临时连接清理辅助逻辑：覆盖两侧成功、单侧失败、查询失败和正常完成。
- 序列化字段与 TypeScript 契约一致。

### 前端

- 连接类型过滤和同连接排除。
- 连接变化后加载数据库/schema 并清理旧结果。
- 两端交换、开始按钮禁用、加载状态和错误重试。
- 摘要、搜索、状态筛选、展开字段差异和无差异状态。
- Excel 三个工作表的数据构造、中文状态、空值、布尔值与特殊字符。

### 完成前验证

- `npm test`
- `npm run build`
- `npm run lint`
- `npm run format:check`
- `npm run test:rust`
- `npm run fmt:rust`
- `npm run lint:rust`

## 验收标准

- 用户可从两个不同的同类型已保存连接中各选一个数据库/schema 进行对比。
- 对比不要求用户预先连接，也不影响当前正在使用的连接。
- 全部五类数据库均能批量读取物理表和字段结构，且不存在循环遍历中的 SQL 查询。
- 结果准确列出仅源端表、仅目标端表以及同名表的字段结构差异。
- 无差异、连接失败、无权限和连接被删除等场景都有清晰反馈。
- 对比结果可导出为包含摘要、表差异和字段差异的 Excel 文件。
- 自动化测试和项目既有质量检查全部通过。
