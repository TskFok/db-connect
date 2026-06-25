# 多数据库完整路线图设计

## 背景

当前项目是基于 Tauri 2、React、TypeScript 与 Rust 的 MySQL 桌面客户端。前端交互、连接管理、SSH 隧道、SSL 配置、SQL 编辑器、多标签工作区、表格数据展示、导出能力、快捷键和错误处理都具备长期复用价值；后端实现则强绑定 MySQL，包括 `mysql_async` 连接池、反引号标识符、`SHOW` 语句、`@@` 会话变量、`information_schema` 查询以及 MySQL 专属 DDL。

多数据库支持应在当前项目内渐进演进，不另起 PostgreSQL 项目。目标是保留现有 MySQL 能力，并逐步让 PostgreSQL 主要能力追平当前 MySQL 客户端。

## 总目标

最终交付一个支持 MySQL 与 PostgreSQL 的桌面数据库客户端：

- 旧 MySQL 用户无感升级，旧连接配置自动按 MySQL 解释。
- PostgreSQL 首版先支持可用的连接、浏览、查询与只读数据查看。
- 后续阶段逐步补齐 PostgreSQL 数据编辑、Schema/Table 管理、索引、外键、触发器、函数、导入导出和文档。
- 所有跨数据库能力通过连接类型、后端 adapter、SQL dialect 与前端 capability map 显式表达，避免在 UI 或命令层散落数据库类型判断。

## 非目标

- 不在首版引入 SQLite、SQL Server、Oracle 等更多数据库。
- 不在 PostgreSQL MVP 中追平所有 MySQL 高级功能。
- 不把 PostgreSQL 独立拆成另一个项目。
- 不为了多数据库支持重写现有前端状态模型；首版继续复用两层树和多标签结构。

## 核心原则

- **兼容优先**：`ConnectionConfig` 新增 `database_type` 后，缺省值必须视为 `mysql`。
- **阶段交付**：每个阶段都能独立合并并通过 MySQL 回归验证。
- **能力显式化**：前端根据数据库类型对应的 capability map 隐藏或禁用不支持入口。
- **方言集中化**：identifier quote、schema/table 全限定名、分页、COUNT、只读 SQL 判断和 DDL 生成放入 dialect/adapter，不在组件内拼接。
- **禁止循环查询 SQL**：列表和元数据读取必须批量查询，不能在表、列、索引、外键遍历中逐项访问数据库。
- **PostgreSQL 树模型固定**：连接配置中的 `database` 表示 PostgreSQL 物理 database；左侧第一层展示 schema，并复用当前 UI 中“数据库”层的状态结构。

## 阶段路线

### Phase 1：架构基础

建立多数据库类型、连接池枚举、adapter/dialect/capability 基础。该阶段不要求 PostgreSQL 真正可连接，但必须让 MySQL 走新结构后行为不变。

### Phase 2：PostgreSQL MVP

接入 PostgreSQL 连接、schema/table 浏览、表结构只读查看、分页数据浏览、SQL 编辑器执行、断开、ping 和取消查询。首版 PostgreSQL 不开放表格 CRUD、DDL 管理、对象管理和导入导出。

### Phase 3：PostgreSQL 数据编辑

支持 PostgreSQL 表格新增行、编辑行、批量更新与删除行。处理主键定位、无主键拦截、参数绑定、类型转换和只读连接拦截。

### Phase 4：PostgreSQL Schema/Table 管理

支持 schema 创建/删除/重命名，表创建/删除/重命名，列新增/修改/删除和主键调整。MySQL 的存储引擎相关能力在 PostgreSQL 下隐藏。

### Phase 5：PostgreSQL 对象与工具

支持 PostgreSQL 索引、外键、触发器、函数/过程、SQL completion、EXPLAIN/EXPLAIN ANALYZE、会话信息和权限/只读探测。

### Phase 6：功能完整与打磨

补齐 PostgreSQL SQL 导入导出、错误文案、README、功能介绍、测试矩阵和跨数据库体验。评估是否将产品名从 MySQL Connect 调整为多数据库客户端名称。

## 兼容性

- 旧连接 JSON 中没有 `database_type` 时按 MySQL 处理。
- 连接导入导出应保留旧字段，新增字段参与加密迁移载荷。
- MySQL 的保存连接、测试连接、SSH 隧道、SSL、SQL 编辑器、数据编辑、索引、外键、触发器、例程、事件和导入导出必须持续通过回归测试。
- PostgreSQL 首版把 `database` 字段作为连接时的物理 database，schema 选择不写回连接配置。

## 验收基线

每个阶段完成后都至少运行：

```bash
npm test
cd src-tauri && cargo test
```

若当前环境无法完整运行 Tauri/Rust 测试，应记录失败原因，并至少运行受影响模块的前端 Vitest 与 Rust 单元测试。

每个阶段还需要手工验收：

- MySQL 连接、库表浏览、SQL 编辑器和一个已有写操作仍可用。
- PostgreSQL 当前阶段新增能力按阶段计划可用。
- PostgreSQL 不支持能力在 UI 中不可误点；后端命令被直接调用时返回明确中文错误。
