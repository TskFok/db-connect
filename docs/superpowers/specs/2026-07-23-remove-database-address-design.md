# 移除数据库树标题地址显示设计

## 目标

移除左侧数据库树顶部连接标题下的数据库地址显示，避免在该区域展示 `host:port` 及 SSH 标记。

## 范围

- 修改 `src/components/database/DatabaseTree.tsx`。
- 保留连接名称、新建、排序、刷新、管理连接、断开连接等现有操作。
- 不修改连接列表、已连接空状态或其他位置的地址显示。
- 不修改连接配置、状态管理、后端连接逻辑与数据模型。

## 实现设计

删除数据库树标题区域中渲染 `activeConnection.config.host`、`activeConnection.config.port` 和 SSH 标记的次级文本节点。其余标题容器及布局样式维持不变，连接名称继续作为该区域唯一的文字标识。

## 测试与验证

在 `src/__tests__/DatabaseTreeCapabilities.test.tsx` 中添加回归断言：渲染已连接的 PostgreSQL 数据库树时，连接名称仍可见，而 `localhost:5432` 不再出现在 DOM 中。运行该测试文件及项目的前端构建验证。
