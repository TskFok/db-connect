# DB Connect

基于 **Tauri 2 + React + TypeScript** 的跨平台数据库桌面图形化管理工具，目前支持 **MySQL / MariaDB**、**PostgreSQL**、**SQLite**、**SQL Server** 与 **ClickHouse**。仓库 CI 在 **Linux / macOS / Windows** 上运行前端单测与完整 `tauri build`；日常使用与打包说明以 **macOS** 为例，其他系统请参阅 [Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)。

## 功能特性

### 连接管理

- **连接排序**：支持拖拽自定义连接显示顺序，顺序持久化保存
- **直连 / SSH 隧道 / SQLite 文件**：支持直接连接 MySQL / MariaDB / PostgreSQL / SQL Server / ClickHouse，或通过 SSH 隧道转发；SQLite 通过选择本地 `.db` / `.sqlite` 文件连接
- **多种认证方式**：密码认证、SSH 密钥认证（`private_key_path`）
- **连接配置持久化**：保存、编辑、删除连接配置，自动加载已保存连接
- **连接测试**：建立连接前可测试连通性
- **空闲超时断开**：长时间无操作后自动断开连接，减少凭据驻留时间（可配置 5/10/15/30/60 分钟或禁用）
- **SSL / TLS**：连接可配置加密模式（系统信任库、VERIFY_CA / VERIFY_IDENTITY 与自定义 CA PEM、调试用的不校验证书模式等）。MySQL / PostgreSQL 支持 PKCS#12 客户端证书与 TLS 主机名覆盖；SQL Server 支持 disabled / required / verify_ca / verify_identity / required_insecure 与 PEM CA，暂不支持 PKCS#12 客户端证书；ClickHouse 首版支持 HTTP disabled 与 HTTPS required
- **高级连接**：MySQL 可选客户端字符集（默认 `SET NAMES utf8mb4`）、连接后依次执行的会话 SQL（如 `SET SESSION max_execution_time`）、以及「只读连接」双保险（配合数据库侧最小权限）。连接成功后会根据数据库类型探测账号是否具备写权限；若为只读账号，界面写入口会与勾选「只读连接」时同样灰显（无需重复勾选）
- **实例 / 会话只读感知**：MySQL 探测 `@@read_only` / `@@super_read_only`，PostgreSQL 探测 `transaction_read_only`，SQL Server 探测当前 database 的 `READ_ONLY` 状态，ClickHouse 探测 `readonly` setting。当连接处于只读状态时，会阻止 **TRUNCATE**、**.sql 导入** 等明显写入类操作，并给出提示（适用于只读副本等场景）

#### 长连接、超时与连接池

数据库服务端或中间网络设备可能在闲置一段时间后关闭会话。应用侧若复用连接池，还需结合池内策略理解行为：

- 本应用在 Rust 侧按数据库类型使用 **mysql_async** 与 **deadpool-postgres / tokio-postgres** 连接池；MySQL 路径配置了 **非活跃连接 TTL**（`with_inactive_connection_ttl`）与 **绝对连接寿命**（`with_abs_conn_ttl`），见 `src-tauri/src/db/connection.rs`。在闲置超过 TTL 后，池会丢弃旧连接，下次取用时会新建 TCP 连接，从而避免一直持有已被服务端超时关掉、但客户端仍以为有效的连接。
- 客户端在建立连接时为 **TCP 启用了 keepalive**（`OptsBuilder::tcp_keepalive`），可在中间有 NAT/防火墙时降低长时间空闲被过早踢掉的概率；**不能替代** 应用层或服务端对超时与池回收的配置。
- **三者关系（直观理解）**：`wait_timeout` 决定服务端何时关会话；池的 TTL 决定客户端何时主动废弃连接，宜 **小于或明显贴合** 服务端超时与网络环境；TCP keepalive 仅减少协议栈层面的空闲断开，与会话级超时是不同层次。

### 数据库管理

- **数据库 / schema / SQLite main 列表**：MySQL / ClickHouse 展示数据库，PostgreSQL / SQL Server 展示 schema，SQLite 展示 `main` 等库名；SQL Server 当前浏览的是连接配置所选 database 内的 schema 树，不是 server 级 database 管理工具；树形展示对象及表，支持虚拟滚动，支持按名称排序（A→Z / Z→A）
- **跨连接数据库对比**：可从两个同类型的已保存连接中选择数据库 / schema，批量对比物理表及字段顺序、类型、可空、默认值、主键、extra 和注释，按表展开字段差异，并将摘要、表差异和字段差异导出为 Excel。首版不比较视图、索引、外键、触发器或表数据
- **数据库结构同步**：在 MySQL / MariaDB、PostgreSQL、SQLite、SQL Server 与 ClickHouse 的跨连接对比结果中，可按表选择、选择多表或全选全部可同步表，把源端的物理表和字段结构同步到目标端；删除默认关闭，所有写入始终先展示后端生成的 SQL 和计划指纹，再经确认执行
- **视图与基表**：表列表中对 **VIEW** 与 **BASE TABLE** 区分展示；打开视图后，部分仅适用于物理表的能力（如外键页签）会自动隐藏
- **数据库 / schema 编辑**：MySQL 支持修改字符集/排序规则（utf8mb4、utf8、latin1、gbk 等）；PostgreSQL / SQL Server 支持 schema 创建、删除与重命名；ClickHouse 支持 database 创建、删除与重命名；SQLite 不展示数据库级编辑、字符集或存储引擎入口
- **数据库 / schema 重命名**：MySQL 通过创建新库 → 迁移表 → 删除旧库实现；PostgreSQL / SQL Server 走 schema 重命名
- **新建表**：可视化创建表（列定义、主键、MySQL 引擎、ClickHouse MergeTree 引擎与 ORDER BY、注释）
- **删除表 / 清空表**：删除表支持确认；对物理表支持 **TRUNCATE**（外键等约束导致的失败会给出可读错误提示）
- **表搜索**：按表名或注释搜索（`Cmd/Ctrl+F`）
- **表收藏**：收藏常用表，在侧边栏顶部快捷访问，支持一键进入和取消收藏
- **多标签工作区**：可同时打开多张表的内容页与多个 **SQL** 标签页，在顶部标签栏切换；每个 SQL 标签独立保留编辑器内容与执行结果
- **例程（存储过程 / 函数）**：在数据库概览的「例程」子标签中列出当前库 / schema 的 `PROCEDURE` / `FUNCTION`，支持类型筛选、查看完整 DDL、删除；SQLite 不支持 routine
- **事件调度（EVENT）**：MySQL 在「事件」子标签中列出调度事件，支持查看 DDL、启用/停用、删除；PostgreSQL / SQLite / SQL Server 无等价 EVENT 入口
- **数据库 / schema 级 SQL 导入 / 导出**：在概览工具栏可将 **`.sql` 文件**导入当前数据库 / schema（MySQL / PostgreSQL / SQLite 按语句拆分执行；SQL Server 按 `GO` 批处理分隔符逐批执行；ClickHouse 支持多行 DDL、`INSERT ... VALUES` 与 `INSERT ... FORMAT` 数据块；支持 PostgreSQL dollar-quoted 函数体，带进度与失败摘要）；或导出为 **`.sql`**（结构 + 可选 **INSERT** 数据，INSERT 数量上限可在导出对话框中配置，默认与查询导出上限量级一致）。PostgreSQL 导出覆盖 schema、表、视图、索引、外键、触发器、函数/过程；SQLite 导出覆盖表、视图、索引、触发器与 SQLite 方言 INSERT；SQL Server 导出覆盖当前 schema 的表、视图、普通/唯一索引、外键、触发器、函数/过程与 SQL Server 方言 INSERT；ClickHouse 导出通过 `system.tables` 读取表/视图 `create_table_query`，结构导出包含 `CREATE DATABASE`、表和视图，可选数据导出按表执行 `SELECT ... FORMAT Values` 并受每表行数上限保护
- **SQL Server 当前限制**：SQL Server DDL 导出以基础可重放脚本为目标，不保证无损覆盖压缩、分区、权限、扩展属性、全文/空间/列存等高级属性；数据导出仍受每表行数上限约束；导入未显式限定 schema 的脚本时，SQL Server 仍按当前用户默认 schema 执行；不提供 server 级 database 创建、删除、重命名或跨 database 管理
- **ClickHouse 当前限制**：首版不支持表格行级 update/delete，不导出或管理触发器、外键、例程和事件；结构/数据导出以可重放基础脚本为目标，数据导出是用户显式选择后的按表业务循环，不在元数据阶段逐表查结构。更多验证清单见 [`docs/clickhouse-support.md`](docs/clickhouse-support.md)

#### 数据库对比与结构同步

数据库结构同步复用跨连接对比的源端、目标端和数据库 / schema 选择，支持 **MySQL / MariaDB、PostgreSQL、SQLite、SQL Server 与 ClickHouse**。两端必须是两个不同的同类型保存连接。对比完成后可选择单表、多表或全部可同步表；搜索和状态筛选不会丢失已选表。

首期同步范围仅包含 **物理表与字段**：创建源端独有表、新增或修改字段，以及在显式允许时删除目标端独有字段或表。不处理表数据，也不比较或同步索引、外键、视图、触发器、例程、事件、权限等其他对象。方言无法安全原地表达的变化会显示为阻塞项并执行零条 DDL，例如 SQLite 需要重建表的已有字段变化、PostgreSQL 的字段物理顺序或不完整分区定义、SQL Server 的 identity / computed / 字段顺序变化，以及 ClickHouse 的引擎或键表达式变化。

同步遵循以下安全边界：

- **删除默认关闭**：关闭时不生成 `DROP COLUMN` 或 `DROP TABLE`，目标端独有项显示为不可选或已跳过；开启后，预览会标记删除风险，仍需在执行前再次确认。
- **始终先预览**：前端只提交端点、表名和删除开关；完整 SQL 由后端生成并只读展示。预览显示计划摘要、风险、阻塞 / 跳过项，以及 SHA-256 计划指纹的前 12 位。
- **执行前校验漂移**：确认执行时，后端会重新批量读取两端结构并生成计划；计划指纹不一致、存在阻塞项或没有可执行操作时执行零条 DDL，并要求重新对比和预览。
- **首错停止，不承诺整批回滚**：DDL 按预览顺序逐语句执行，遇到首个错误立即停止并返回已成功、失败和未执行项。不同数据库无法共同保证跨语句事务，因此此前成功的 DDL 可能已经生效，不承诺整批自动回滚；全部成功后会自动重新对比并刷新结果。

五类数据库的初始化 SQL、安全场景和逐项预期见[数据库结构同步手工验收矩阵](docs/superpowers/manual-tests/2026-07-16-database-sync-matrix.md)。

### 外键管理

- **外键列表**：在表视图的「外键」页签查看当前表上的约束及引用关系
- **关系图**：基于当前表外键生成 **Mermaid** 关系图，便于理解表间依赖
- **新建外键**：向导式选择本地列、引用表与引用列，配置 `ON UPDATE` / `ON DELETE` 行为后执行 `ALTER TABLE`；SQLite 因需重建表结构，仅提供查看
- **删除外键**：支持确认后删除约束；SQLite 仅查看，不展示删除入口

### 表内容整合视图

选中表或视图后，主区域以页签组织常用能力：**数据**、**结构**、**索引**、**触发器**、**外键**（仅基表）、**创建表**（生成/查看建表 SQL）、**SQL**（内嵌 Monaco 编辑器，便于针对当前对象写语句）。

### 表结构管理

- **表结构查看**：列名、类型、可空、键、默认值、注释；MySQL 额外展示存储引擎，SQLite / SQL Server 不展示字符集和存储引擎
- **修改列**：重命名、改类型、可空、默认值、extra、注释
- **新增列**：指定位置（`AFTER` 某列或末尾）
- **删除列**：支持确认删除
- **重命名表**：直接修改表名
- **修改表引擎**：MySQL 支持 InnoDB、MyISAM 等；ClickHouse 新建表支持选择常用 MergeTree 系列引擎；PostgreSQL / SQLite / SQL Server 不展示该入口

### 数据浏览与编辑

- **分页查询**：支持自定义每页行数
- **排序**：按列升序/降序
- **条件筛选**：Where 子句过滤（支持多条件 AND/OR）
- **列显示偏好**：可调整列宽、隐藏列；设置按 **连接 + 库 + 表** 持久化到应用数据目录（[`preferences` 命令](src-tauri/src/commands/preferences.rs) + [`tableColumnSettingsStore`](src/stores/tableColumnSettingsStore.ts)）
- **新增行**：表单方式插入
- **编辑行**：表格内编辑，批量提交修改
- **删除行**：支持多选批量删除
- **复制为 SQL**：将选中行生成 INSERT 语句，通过系统剪贴板写入（[`plugin-clipboard-manager`](https://v2.tauri.app/plugin/clipboard/)）
- **导出 Excel**：表数据视图支持将**当前页**导出为 `.xlsx`（可见列、含未提交编辑）；SQL 编辑器支持将 **SELECT** 结果导出为 `.xlsx`。单次导出最多 **10 万行**（与查询结果上限一致，见 [`src/utils/csvExport.ts`](src/utils/csvExport.ts) 中的 `CSV_EXPORT_MAX_ROWS`）；工作簿由前端用 [write-excel-file](https://www.npmjs.com/package/write-excel-file) 生成（兼容 Tauri CSP，不依赖 `eval`），经 Tauri [`write_binary_file`](src-tauri/src/commands/file_io.rs) 写入用户选择的路径，实现见 [`src/utils/excelExport.ts`](src/utils/excelExport.ts)。

### 索引管理

- **索引列表**：查看主键、唯一索引、普通索引
- **创建索引**：MySQL 支持 INDEX、UNIQUE、FULLTEXT、SPATIAL 与 BTREE/HASH 方法；PostgreSQL 支持常用索引方法；SQLite / SQL Server 当前入口支持普通索引与唯一索引
- **删除索引**：支持确认删除

### 触发器管理

- **触发器列表**：按表筛选
- **查看定义**：获取完整 CREATE TRIGGER 语句
- **创建触发器**：BEFORE/AFTER、INSERT/UPDATE/DELETE
- **删除触发器**：支持确认删除

### SQL 编辑器

- **Monaco Editor**：语法高亮、多语句执行、选择执行
- **常用 SQL 片段**：可将当前编辑器内容**命名保存**到本地列表，在抽屉中一键载入或删除（[`savedSqlStore`](src/stores/savedSqlStore.ts)，与独立 SQL 标签配合使用）
- **SQL 自动补全**：数据库名、表名、列名智能提示
- **多语句支持**：按分号拆分批量执行，显示每条语句结果
- **EXPLAIN**：工具栏支持对当前或选中 SQL 执行 `EXPLAIN`；MySQL / MariaDB 下 `EXPLAIN ANALYZE` 会在根据版本判断可能不兼容时灰显，PostgreSQL 下直接开放，SQLite 使用 `EXPLAIN QUERY PLAN`
- **高危语句**：对 `TRUNCATE`、`DROP DATABASE` / `DROP SCHEMA` 等在执行前提供二次确认；可在连接「高级」中勾选跳过（不推荐）
- **会话信息**：按数据库类型展示版本、主机、只读状态、查询超时、连接 ID、当前数据库 / schema 等便于排障
- **数据库 / schema 切换**：下拉选择当前默认数据库或 schema

### 界面与交互

- **深色 / 浅色主题**：一键切换（`Cmd/Ctrl+L`）
- **左侧边栏宽度**：连接树区域支持拖拽调整宽度（约 **200–480 px**），偏好保存在本地（[`settingsStore`](src/stores/settingsStore.ts)）
- **功能介绍弹窗**：界面内可打开「功能介绍」，内容与 README 特性概要对应（[`ProjectIntroModal`](src/components/common/ProjectIntroModal.tsx)）
- **全局快捷键**：见下方快捷键列表
- **Loading 状态**：全局加载条、各模块 loading 态
- **错误处理**：ErrorBoundary、全局错误提示；严重错误时可附带调试面包屑信息写入剪贴板（[`crashBreadcrumbs`](src/utils/crashBreadcrumbs.ts)）

### 快捷键

| 快捷键             | 功能                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `Cmd/Ctrl + N`     | 新建连接                                                             |
| `Cmd/Ctrl + R`     | 刷新（在「数据」页签且已选表时刷新当前表数据，否则刷新左侧数据库树） |
| `Cmd/Ctrl + D`     | 断开连接                                                             |
| `Cmd/Ctrl + F`     | 搜索表                                                               |
| `Cmd/Ctrl + L`     | 切换深色/浅色主题                                                    |
| `Cmd/Ctrl + Enter` | 执行 SQL（在 SQL 编辑器中）                                          |
| `Cmd/Ctrl + /`     | 显示/隐藏快捷键帮助                                                  |
| `Esc`              | 关闭弹窗                                                             |

## 技术栈

- **桌面框架**：Tauri 2 (Rust)
- **前端**：React 18 + TypeScript + Vite
- **UI**：Ant Design 5
- **状态管理**：Zustand（部分状态 `persist` 至 localStorage 或应用目录）
- **列表虚拟化**：[`@tanstack/react-virtual`](https://tanstack.com/virtual/latest)
- **连接拖拽排序**：[`@dnd-kit`](https://docs.dndkit.com/)
- **代码编辑器**：Monaco Editor
- **关系图**：Mermaid（外键可视化）
- **表格导出**：write-excel-file（`.xlsx` 生成）
- **剪贴板**：`@tauri-apps/plugin-clipboard-manager`
- **数据库驱动**：mysql_async、deadpool-postgres / tokio-postgres、deadpool-sqlite / rusqlite、bb8-tiberius / tiberius、clickhouse-rs (Rust)
- **SSH 隧道**：按平台区分实现
  - **Windows**：russh（纯 Rust 客户端，`ring` 后端，无需系统 libssh2）
  - **macOS / Linux**：调用系统 OpenSSH（`ssh`）建立本地端口转发
  - 实现见 [`src-tauri/src/db/ssh_tunnel/`](src-tauri/src/db/ssh_tunnel/)（`russh_tunnel.rs` / `openssh_tunnel.rs`），依赖按 target 在 [`src-tauri/Cargo.toml`](src-tauri/Cargo.toml) 中条件引入

## 开发环境要求

- **Node.js**：>= 18（CI 使用 Node 22）
- **Rust**：>= 1.88（keyring 4.1 要求；Windows 端使用 russh 0.60.3）
- **macOS**：Xcode Command Line Tools；SSH 隧道使用系统自带的 `ssh`（OpenSSH）
- **Linux**：WebKitGTK 等与 Tauri 相关的构建依赖（可参考仓库 [`.github/workflows/ci.yml`](.github/workflows/ci.yml) 中 `apt-get` 列表）；SSH 隧道使用系统自带的 `ssh`（OpenSSH，通常已预装或 `openssh-client` 提供）
- **Windows**：按 Tauri 文档安装 **Microsoft C++ Build Tools**、WebView2 等；SSH 隧道由内置 russh 提供，无需安装额外客户端

### 系统依赖 (macOS)

```bash
# 安装 Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# macOS 的 SSH 隧道直接调用系统 `ssh`（OpenSSH），无需 brew 安装 libssh2
```

## 快速开始

### 安装依赖

```bash
npm install
```

### 环境变量（可选）

构建与开发时可使用 `.env` 覆盖部分配置（勿提交真实凭据）：

```bash
cp .env.example .env
```

| 变量                     | 说明                                                                  |
| ------------------------ | --------------------------------------------------------------------- |
| `VITE_GITHUB_ISSUE_REPO` | 崩溃上报默认 GitHub 仓库，格式 `owner/repo`；未设置时使用代码内默认值 |

CI 打包可通过仓库 **Settings → Secrets and variables → Actions → Variables** 设置 `VITE_GITHUB_ISSUE_REPO`。

### 开发模式

```bash
npm run tauri dev
```

将同时启动 Vite 前端和 Tauri 开发窗口。

### 打包

```bash
npm run tauri build
```

产物位置（具体子目录随目标平台变化）：

- **macOS**：`src-tauri/target/release/bundle/macos/DB Connect.app`（以及 DMG 等）
- **Windows**：`src-tauri/target/release/bundle/` 下的 MSI / NSIS 安装包
- **Linux**：`src-tauri/target/release/bundle/` 下的 `.deb` / AppImage 等（取决于当前 `tauri.conf.json` 的 bundle 目标）

### 发布到 GitHub Releases

```bash
# 默认发布 patch 版本，例如 0.1.0 -> 0.1.1
npm run release

# 指定升级方式
npm run release -- minor
npm run release -- major
npm run release -- 1.2.3
```

发布脚本会要求当前工作区干净，随后同步更新 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 和 `src/appVersion.ts` 的版本号，创建中文提交 `发布 vX.Y.Z`，推送当前分支，并推送 `vX.Y.Z` tag。tag 推送会触发 GitHub Actions 构建 macOS / Windows / Linux 安装包，并公开发布到 GitHub Releases。本地仅需 Git，无需安装 GitHub CLI。

若版本提交已推送但 tag 推送或 workflow 触发失败，可在修复问题后重新触发当前版本发布：

```bash
npm run release -- current
# 或
pnpm release -- current
```

可先运行 dry-run 检查下一个版本号，不写文件、不提交、不推送：

```bash
npm run release -- --dry-run patch
```

### 测试

#### 前端单元测试 (Vitest)

```bash
npm test
```

或监听模式：

```bash
npm run test:watch
```

测试配置：`vitest.config.ts`，使用 jsdom 环境，入口为 `src/__tests__/setup.ts`。

其他脚本：`npm run audit:npm` / `npm run audit:rust`（依赖审计）、`npm run clean` / `npm run reset`（清理构建与缓存）。

#### Rust 单元测试

```bash
cd src-tauri && cargo test
```

## 项目结构

```
db-connect/
├── src/                        # React 前端
│   ├── components/             # UI 组件
│   │   ├── common/             # 通用组件（主题切换、快捷键、错误边界、Mermaid 块等）
│   │   ├── connection/         # 连接列表、连接表单
│   │   ├── database/           # 数据库树、概览、创建表、编辑数据库、例程/事件/SQL 文件 IO
│   │   ├── table/              # 表结构、表数据、Where 筛选、标签栏
│   │   ├── foreignKey/         # 外键列表与向导
│   │   ├── index/              # 索引列表、索引编辑
│   │   ├── trigger/            # 触发器列表、触发器编辑
│   │   └── sql/                # SQL 编辑器
│   ├── stores/                 # Zustand 状态
│   ├── services/               # Tauri 命令封装
│   ├── types/                  # TypeScript 类型
│   ├── utils/                  # 工具函数
│   ├── hooks/                  # 自定义 Hooks
│   └── __tests__/              # 前端单元测试
├── src-tauri/                  # Tauri Rust 后端
│   ├── src/
│   │   ├── commands/           # Tauri 命令（connection、database、data、foreign_key、index_cmd、trigger、routine_event、sql_file、preferences、file_io …）
│   │   ├── db/                 # 数据库连接与 SQL 执行
│   │   └── models/             # 数据模型
│   └── Cargo.toml
├── package.json
├── vitest.config.ts
└── tauri.conf.json
```

## 安全

- **安全模型与实现细节**：包括连接配置加密存储、SQL 执行与注入防护、Tauri 权限和依赖安全等内容，请参考 [`SECURITY.md`](SECURITY.md)。
- **使用建议**：DB Connect 设计为本地桌面数据库客户端，仅建议在可信环境中使用，并为数据库账号遵循最小权限原则，详情见 `SECURITY.md`。

## 许可证

MIT
