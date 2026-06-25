# 产品命名评估：MySQL Connect 与多数据库定位

## 结论

本阶段保留产品名 **MySQL Connect**，不在 Phase 6 内改包名、bundle id、图标、应用目录或迁移提示。Phase 6 的目标是完成 PostgreSQL 功能追平与多数据库文案闭环；品牌迁移涉及发布资产和用户本地数据路径，应该作为独立发布计划处理。

## 保留现名的理由

- **变更风险低**：当前应用名、包名、仓库名、配置目录、图标和 Release 流程均围绕 `mysql-connect` 建立；本阶段不引入迁移风险。
- **交付边界清晰**：PostgreSQL 支持已经能通过连接类型、capability、文档和 UI 文案表达；不需要依赖改名才能完成多数据库体验闭环。
- **用户资产稳定**：保存连接、表列设置、主题、收藏、快捷 SQL 等本地数据仍沿用原存储 key，避免用户升级后感知为“新应用”。

## 已完成的多数据库语境调整

- README 首段和功能说明改为支持 MySQL / MariaDB 与 PostgreSQL。
- 功能介绍弹窗改为“跨平台数据库桌面客户端”。
- SQL 文件导出说明区分 MySQL 与 PostgreSQL 能力范围。
- 会话信息、只读检查和错误提示按数据库类型展示。

## 若后续决定改名，需要独立处理

候选方向：

- **DB Connect**：短，表达多数据库，但通用性较强，搜索辨识度一般。
- **Data Connect Desktop**：更清晰，但名称偏长。
- **SQL Connect Studio**：强调 SQL 客户端定位，可承载更多数据库类型。

独立发布计划应覆盖：

- `package.json` name、Tauri productName、bundle identifier、Cargo package metadata。
- macOS `.app` / DMG 名称、Windows 安装包名称、Linux bundle 名称。
- 应用图标、README 标题、截图、Release Notes 模板、崩溃上报默认 repo 文案。
- 本地配置目录、localStorage/persist key、钥匙串 key 的兼容迁移策略。
- 升级提示：说明旧名称到新名称的关系，避免用户误以为是不同应用。

## 当前发布建议

Phase 6 发布说明中使用：

> MySQL Connect 现已补齐 PostgreSQL 主要能力，包括 schema/table 管理、对象管理、SQL 文件导入导出和多数据库文案。产品名本次暂不调整，后续如进行品牌迁移将另行发布迁移说明。
