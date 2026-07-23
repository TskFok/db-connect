# 左侧数据库名称省略 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让左侧数据库树中的超长数据库名称以单行省略号显示，并可通过现有 Typography 省略行为查看完整名称。

**Architecture:** 在 `DatabaseTree` 的数据库节点标题上复用表名节点已采用的 `Typography.Text` 样式和 `ellipsis` 配置。测试以长数据库名称渲染树，断言标题节点拥有单行截断所需的行内样式；无需改变树数据、事件处理或状态管理。

**Tech Stack:** React 18、TypeScript、Ant Design 5、Vitest、React Testing Library。

## Global Constraints

- 只修改左侧数据库树的数据库名称标题，不改变连接名称、右侧标题、数据库排序、选择、展开、右键菜单或数据加载。
- 复用表名节点的块级单行截断样式，并以 `ellipsis={{ tooltip: db }}` 保留完整名称提示。
- 不新增样式文件、状态、依赖或后端代码。
- 测试必须先失败，再写生产代码使其通过。
- 提交信息使用 Conventional Commits：`fix: 数据库名称过长时显示省略号`。

---

### Task 1: 为数据库树节点标题启用单行省略

**Files:**
- Modify: `src/__tests__/DatabaseTreeCapabilities.test.tsx`
- Modify: `src/components/database/DatabaseTree.tsx`

**Interfaces:**
- Consumes: `DatabaseTree` 中 `treeData` 为每个数据库创建的 `DataNode`，数据库名称变量为 `db`。
- Produces: 加粗数据库标题 `Text` 的 `ellipsis={{ tooltip: db }}` 与 `display`、`minWidth`、单行截断样式。

- [ ] **Step 1: 写入失败的组件测试**

在 `src/__tests__/DatabaseTreeCapabilities.test.tsx` 的 `DatabaseTree capabilities` 测试组中添加以下用例。它使用较长数据库名称，并断言数据库树标题具备单行截断样式：

```tsx
  it("数据库节点名称过长时应单行省略", () => {
    const databaseName = "very_long_database_name_that_must_be_truncated";
    useDatabaseStore.setState({
      activeConnId: "pg-1",
      databases: [databaseName],
      tables: {},
    });

    render(<DatabaseTree />);

    const title = screen
      .getByText(databaseName)
      .closest(".ant-typography");
    expect(title).not.toBeNull();
    expect(title).toHaveStyle({
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
    });
  });
```

- [ ] **Step 2: 运行测试，确认它因缺少数据库名称截断而失败**

运行：

```bash
npm test -- src/__tests__/DatabaseTreeCapabilities.test.tsx
```

预期：新增用例失败，提示数据库名称元素未设置 `white-space: nowrap`、`overflow: hidden` 和 `text-overflow: ellipsis`；已有用例继续通过。

- [ ] **Step 3: 写入最小生产代码**

在 `src/components/database/DatabaseTree.tsx` 的数据库节点 `title` 中，将当前数据库名称的 `Text` 替换为以下配置：

```tsx
        title: (
          <Text
            strong
            style={{
              display: "block",
              minWidth: 0,
              fontSize: 13,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            ellipsis={{ tooltip: db }}
          >
            {db}
          </Text>
        ),
```

保留同一对象中的 `key`、`icon` 和 `children` 属性，不修改表节点标题代码。

- [ ] **Step 4: 运行测试，确认测试通过**

运行：

```bash
npm test -- src/__tests__/DatabaseTreeCapabilities.test.tsx
```

预期：测试文件内全部用例通过，包括“数据库节点名称过长时应单行省略”。

- [ ] **Step 5: 运行生产构建**

运行：

```bash
npm run build
```

预期：`tsc && vite build` 成功完成，退出码为 0。

- [ ] **Step 6: 检查变更并提交**

运行：

```bash
git diff --check
git add src/components/database/DatabaseTree.tsx src/__tests__/DatabaseTreeCapabilities.test.tsx
git commit -m "fix: 数据库名称过长时显示省略号"
```

预期：无空白错误，提交仅包含数据库名称省略配置和回归测试。
