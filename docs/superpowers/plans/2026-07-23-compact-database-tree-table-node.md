# 数据表节点单行化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 左侧数据库树的表节点只显示一行表/视图图标和可截断表名，并移除行数与收藏入口。

**Architecture:** 保持 `DatabaseTree` 现有的 Ant Design `Tree` 图标配置，精简 `DataNode.title` 为单个可收缩的文本元素。测试在现有组件能力测试中构造支持收藏的 MySQL 表元数据，断言行数和收藏入口均不再渲染，同时验证标题拥有单行省略样式。

**Tech Stack:** React 18、TypeScript、Ant Design 5、Vitest、Testing Library。

## Global Constraints

- 仅修改前端表节点显示，不改动表元数据接口、数据加载、收藏持久化或其他列表。
- 不在循环中查询 SQL。
- 表名溢出必须隐藏且不换行，并可通过现有 Tooltip 查看完整名称。
- 保留普通表与视图的现有图标及颜色。

---

### Task 1: 覆盖表节点单行显示行为

**Files:**
- Modify: `src/__tests__/DatabaseTreeCapabilities.test.tsx`

**Interfaces:**
- Consumes: `DatabaseTree`，Zustand 的 `useConnectionStore`、`useDatabaseStore` 和 `useFavoriteStore` 测试状态。
- Produces: 一个回归测试，约束 MySQL 表节点不再出现行数和收藏入口，且表名文本为单行截断样式。

- [ ] **Step 1: 写入失败测试**

在测试文件的连接 fixture 区域新增 MySQL 连接，并在 `describe` 中加入以下测试：

```tsx
const mysqlConnection = {
  connId: "mysql-1",
  config: {
    id: "mysql-profile",
    name: "MySQL",
    host: "localhost",
    port: 3306,
    username: "root",
    database_type: "mysql" as const,
  },
};

it("表节点只显示单行表名，不显示行数或收藏入口", () => {
  const tableName = "very_long_table_name_that_must_stay_on_one_line";
  useConnectionStore.setState({
    activeConnections: { "mysql-1": mysqlConnection },
    activeConnId: "mysql-1",
    activeConnection: mysqlConnection,
  });
  useDatabaseStore.setState({
    databases: ["app"],
    tables: {
      app: [{ name: tableName, table_type: "TABLE", engine: "InnoDB", rows: 1234, data_length: null, index_length: null, comment: "" }],
    },
    expandedKeys: ["db:app"],
  });

  render(<DatabaseTree />);

  const title = screen.getByText(tableName);
  expect(title).toHaveStyle({ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
  expect(screen.queryByText("1,234 行")).not.toBeInTheDocument();
  expect(screen.queryByTitle("收藏")).not.toBeInTheDocument();
  expect(title.closest(".ant-tree-treenode")?.querySelector(".ant-tree-iconEle")).toBeInTheDocument();
});
```

- [ ] **Step 2: 运行测试并确认失败原因正确**

Run: `npm test -- src/__tests__/DatabaseTreeCapabilities.test.tsx`

Expected: FAIL；现有实现会渲染 `1,234 行` 与 `title="收藏"` 星标，且表名不具备测试指定的单行截断内联样式。

- [ ] **Step 3: 暂不修改生产代码**

在确认失败后，保留测试作为期望行为，进入 Task 2 实现最小变更。

- [ ] **Step 4: 本任务不单独提交**

测试与实现必须在同一提交中落地，避免当前分支留下故意失败的测试。

### Task 2: 简化表节点标题并保持单行截断

**Files:**
- Modify: `src/components/database/DatabaseTree.tsx:158-227`
- Modify: `src/__tests__/DatabaseTreeCapabilities.test.tsx`

**Interfaces:**
- Consumes: `TableInfo.name`、`TableInfo.comment` 和现有 `Tree` 的 `icon` 属性。
- Produces: 每个表节点的 `title` 仅含可截断表名；`icon` 继续决定普通表/视图图标。

- [ ] **Step 1: 用最小 JSX 替换两行标题**

在 `sortedTables.map` 的 `return` 对象中，将现有多层 `<span>`、`t.rows` 和收藏星标的 `title` 替换为：

```tsx
title: (
  <Tooltip title={t.comment || "无注释"} placement="topLeft">
    <Text
      style={{
        display: "block",
        minWidth: 0,
        fontSize: 13,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
      ellipsis={{ tooltip: t.name }}
    >
      {t.name}
    </Text>
  </Tooltip>
),
```

保留紧随其后的 `icon` 分支：`VIEW` 使用 `EyeOutlined`，其他表使用 `TableOutlined`。同时移除不再使用的 `StarOutlined`、`StarFilled` 图标导入，及只服务于节点星标的 `favoriteTableKey`、`connectionId`、`favorites`、`toggleFavorite` 和 `favoriteTableKeys` 计算逻辑。

- [ ] **Step 2: 运行定向测试并确认通过**

Run: `npm test -- src/__tests__/DatabaseTreeCapabilities.test.tsx`

Expected: PASS；包括新测试在内的该文件全部测试通过。

- [ ] **Step 3: 运行静态检查**

Run: `npm run lint && npm run build`

Expected: 两条命令均以退出码 0 结束；无未使用导入或 TypeScript 类型错误。

- [ ] **Step 4: 检查变更范围**

Run: `git diff --check && git diff -- src/components/database/DatabaseTree.tsx src/__tests__/DatabaseTreeCapabilities.test.tsx`

Expected: 无空白错误；diff 仅移除表节点的行数、收藏星标及对应依赖，并新增单行省略样式和回归测试。

- [ ] **Step 5: 提交实现**

```bash
git add src/components/database/DatabaseTree.tsx src/__tests__/DatabaseTreeCapabilities.test.tsx
git commit -m "fix: 精简左侧表节点显示"
```
