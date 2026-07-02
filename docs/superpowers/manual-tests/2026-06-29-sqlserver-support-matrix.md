# SQL Server Support Manual Test Matrix

> 目标：覆盖 SQL Server Phase 1-6 的连接、浏览、SQL 编辑器、数据编辑、DDL、对象管理、SQL 文件导入导出和跨数据库回归。自动化测试通过后，发布前至少按本矩阵完成一次真实 SQL Server 验证。

## 环境准备

- SQL Server 2019+ 或 Azure SQL Database：准备一个普通可写账号、一个只读账号、一个空测试 database。
- 样例 schema 至少包含：普通表、identity 主键、nullable/default 列、唯一索引、普通索引、外键、视图、触发器、存储过程、标量函数或表值函数。
- 准备一份含 `GO` 分隔符的 SQL 文件，覆盖字符串、行注释、块注释中出现 `GO` 的情况。
- 如需验证隧道：准备 SSH 跳板机，并确认本机可通过隧道访问 SQL Server 端口。

## 核心矩阵

| 场景          | 操作                                                                                     | 预期                                                                        |
| ------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 直连连接      | 使用 SQL Server 类型、host、1433、database、账号密码连接                                 | 连接成功；失败时错误为中文且不泄漏密码                                      |
| SSH 隧道      | 通过 SSH 隧道连接 SQL Server                                                             | 隧道建立后连接成功；断开连接会释放隧道                                      |
| TLS           | 分别验证 disabled、required、required_insecure；有 CA 时验证 verify_ca / verify_identity | 加密模式按配置生效；PKCS#12 客户端证书提示暂不支持                          |
| 只读连接      | 勾选只读连接后尝试 INSERT、DDL、SQL 文件导入                                             | 写入口灰显或后端拒绝，提示只读模式                                          |
| database 只读 | 将测试 database 设为 READ_ONLY 后尝试 TRUNCATE / SQL 导入                                | 前端探测到 READ_ONLY 并拦截写类操作                                         |
| schema 树     | 打开连接后查看左侧树和概览                                                               | 展示连接 database 内 schema；不展示 server 级 database 创建/删除/重命名入口 |
| 表/视图浏览   | 展开 schema，排序、搜索表和视图                                                          | 表、视图区分展示；搜索和排序正常                                            |
| SQL 编辑器    | 执行 SELECT、INSERT/UPDATE/DELETE、DDL、错误 SQL、EXPLAIN                                | 结果、影响行数、错误提示和取消行为正常；只读连接只允许安全查询              |
| 会话信息      | 打开 SQL 编辑器会话信息                                                                  | 展示版本、主机、只读状态、database、连接 ID 等                              |
| 数据浏览      | 分页、排序、WHERE 筛选、列宽/隐藏偏好                                                    | 查询正确；偏好按连接 + schema + 表隔离                                      |
| 数据编辑      | 对有主键或可用唯一定位列的表新增、编辑、批量更新、删除                                   | 参数化写入成功；大整数、日期、NULL、二进制显示稳定                          |
| 无定位列表    | 对无主键且无可用唯一定位列的表尝试编辑                                                   | 写操作被明确拦截                                                            |
| 表 DDL        | 新建表、重命名表、添加列、改列、删列、删除表、清空表                                     | SQL Server 语法执行成功；不展示列重排、字符集、存储引擎入口                 |
| schema DDL    | 新建 schema、重命名 schema、删除空 schema                                                | 执行成功；系统 schema 禁止修改                                              |
| 索引          | 查看、创建普通索引、创建唯一索引、删除索引                                               | 列表刷新正确；约束支撑索引用 DROP CONSTRAINT                                |
| 外键          | 查看、新建、删除外键，打开关系图                                                         | 引用 schema/table/column、ON UPDATE / ON DELETE 展示正确                    |
| 触发器        | 查看定义、创建 AFTER INSERT/UPDATE/DELETE 触发器、删除触发器                             | DDL 展示完整；创建/删除后列表刷新                                           |
| 函数/过程     | 列表、类型筛选、查看定义、删除测试例程                                                   | PROCEDURE / FUNCTION 类型识别正确                                           |
| EVENT         | 查看对象页签                                                                             | 不展示 MySQL EVENT 入口                                                     |
| saved SQL     | 保存 SQL，断开后重连同一连接加载；切换 MySQL/PostgreSQL/SQLite 连接                      | 仅当前连接键下的 SQL 可见，不串连接                                         |
| 收藏表        | 收藏 SQL Server 表，批量打开；切换同 host/port 的 MySQL 临时连接                         | 收藏仅在 SQL Server 当前连接键下显示，文案使用 schema                       |

## SQL 文件导入导出专项

1. 导入含多段 `GO` 的 SQL 文件，确认按批执行；字符串和注释中的 `GO` 不会拆分。
2. 导入文件中放入一段故意错误批次，确认后续批次继续执行，并显示失败批次序号和 SQL 摘要。
3. 导入一份未限定 schema 的 SQL 文件，确认对象会落到 SQL Server 当前用户默认 schema，并在记录中标注该限制。
4. 从样例 schema 导出结构 SQL，导入空 schema 后核对表、视图、索引、外键、触发器、函数/过程。
5. 从样例 schema 导出结构 + INSERT，导入空 schema 后核对 identity 值、NULL、字符串引号、日期/时间、大整数、二进制和行数。
6. 将导出路径指向不可写目录，确认错误提示包含权限或路径原因。
7. 对 READ_ONLY database 或只读连接执行导入，确认导入前被拦截或后端拒绝。

## 跨数据库回归

| 场景     | MySQL / MariaDB                                 | PostgreSQL                                           | SQLite                                           | SQL Server                                                                      |
| -------- | ----------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------- |
| 能力入口 | 数据库、事件、字符集、引擎、列重排按 MySQL 展示 | schema、函数/过程、导入导出开启，无 EVENT            | main、索引/触发器/导入导出开启，无 routine/EVENT | schema、函数/过程、导入导出、saved SQL、收藏表开启，无 EVENT/字符集/引擎/列重排 |
| SQL 导入 | 分号拆句                                        | 分号拆句并保留 dollar-quoted 函数体                  | 分号拆句                                         | `GO` 批处理拆分                                                                 |
| SQL 导出 | 表/视图/触发器/EVENT + INSERT                   | schema/table/view/index/fk/trigger/function + INSERT | table/view/index/trigger + INSERT                | schema/table/view/index/fk/trigger/routine + INSERT                             |
| 只读拦截 | `@@read_only` / `@@super_read_only`             | `transaction_read_only`                              | 连接只读配置                                     | `DATABASEPROPERTYEX(..., 'Updateability')`                                      |

## 发布前记录

- 记录测试日期、应用版本、SQL Server 版本、操作系统、连接方式（直连/SSH/TLS）。
- 若本机没有真实 SQL Server，自动化测试仍必须通过；真实连接验证需在具备环境后补测并记录结果。
- 任一阻塞问题需补自动化回归测试或单独建发布阻断 issue。

## 本次验证记录（2026-07-02）

| 类别 | 命令 / 场景 | 结果 | 备注 |
| ---- | ----------- | ---- | ---- |
| 自动化 | `npm test -- src/__tests__/sqlFileIoUi.test.ts src/__tests__/DatabaseSqlFileActions.test.tsx src/__tests__/SavedSqlDropdown.test.tsx src/__tests__/FavoriteTables.test.tsx src/__tests__/databaseCapabilities.test.ts` | 通过 | 覆盖 SQL Server 导入导出文案、能力开关、saved SQL 和收藏表隔离 |
| 自动化 | `cargo test --manifest-path src-tauri/Cargo.toml sql_file` | 通过 | 覆盖 SQL 文件拆分、失败摘要、SQL Server `GO` 批次与导出脚本 |
| 自动化 | `cargo test --manifest-path src-tauri/Cargo.toml sqlserver` | 通过 | 覆盖 SQL Server 连接配置、只读 SQL 规则、DDL、对象管理和数据类型转换 |
| 自动化 | `npm test` | 通过 | 前端全量回归 |
| 自动化 | `npm run test:rust` | 通过 | Rust 全量回归 |
| 自动化 | `npm run build` | 通过 | Vite 仅提示既有大 chunk warning |
| 真实 SQL Server | 直连 / SSH / TLS / READ_ONLY / 导入导出重放 | 未执行 | 当前环境未提供真实 SQL Server 实例、账号或 SSH/TLS 测试条件；发布前需按上方矩阵补测 |

### 真实 SQL Server 补测记录表

| 日期 | 应用版本 | SQL Server 版本 | 操作系统 | 连接方式 | 覆盖场景 | 结果 | 记录人 |
| ---- | -------- | --------------- | -------- | -------- | -------- | ---- | ------ |
| 未执行 | 1.0.3 | 未提供 | macOS | 未提供 | 直连、SSH、TLS、READ_ONLY、导入导出重放 | 待具备环境后补测 | Codex |
