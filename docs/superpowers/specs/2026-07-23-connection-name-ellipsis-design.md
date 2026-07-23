# 连接名称省略设计

## 背景与目标

左侧当前连接信息头部的连接名称使用普通标题，过长时可能占用操作按钮空间。连接列表项虽声明了 `ellipsis`，但名称在横向布局中没有可收缩宽度，无法稳定截断。目标是在两个位置一致地让超长连接名称单行省略，并保留完整名称提示。

## 方案比较

1. 在现有 Typography 组件上增加弹性收缩约束和 `ellipsis` 提示（采用）。保持现有组件结构与视觉风格，最小改动即可让 Ant Design 的省略逻辑生效。
2. 手动截取连接名称字符串。无法根据侧边栏宽度自适应，且会丢失完整名称，不采用。
3. 修改侧边栏整体宽度或隐藏操作按钮。会改变既有交互和布局，超出需求范围，不采用。

## 实现设计

- 在 `src/components/database/DatabaseTree.tsx` 的当前连接名称 `Title` 上添加可收缩的 flex 样式与 `ellipsis={{ tooltip: activeConnection?.config.name }}`。
- 在 `src/components/connection/ConnectionList.tsx` 的连接列表项名称 `Text` 上添加 `flex: 1`、`minWidth: 0`，并以 `ellipsis={{ tooltip: item.name }}` 保留完整名称提示。
- 不修改连接、切换、断开、SSH 标识、状态标签、操作按钮、分组或数据状态逻辑。

## 验证

- 为 `DatabaseTree` 增加长当前连接名称的样式断言。
- 为 `ConnectionList` 增加长连接名称的样式断言。
- 运行两个测试文件和前端生产构建。

## 范围外

- 不处理多连接标签、分组名称或静态“连接列表”标题。
- 不改变原始连接名称、排序或侧边栏宽度。
