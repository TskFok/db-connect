# 连接名称省略 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让左上角当前连接名称和连接列表项中的超长名称以单行省略号显示。

**Architecture:** 在两个现有 Typography 名称组件上使用 Ant Design `ellipsis`，并补足 flex 布局的收缩约束。组件测试分别断言当前连接标题与列表连接名称容器的可收缩、省略样式。

**Tech Stack:** React 18、TypeScript、Ant Design 5、Vitest、React Testing Library。

## Global Constraints

- 仅处理当前连接标题和连接列表项名称；不处理多连接标签、分组名称或静态标题。
- 不改变连接、切换、断开、SSH、状态、操作按钮、分组或数据状态逻辑。
- 使用 `ellipsis={{ tooltip: <名称> }}` 保留完整名称提示。
- 测试必须先失败，再写生产代码使其通过。
- 提交信息：`fix: 连接名称过长时显示省略号`。

---

### Task 1: 为当前连接标题和连接列表名称启用省略

**Files:**
- Modify: `src/__tests__/DatabaseTreeCapabilities.test.tsx`
- Modify: `src/__tests__/ConnectionListGroups.test.tsx`
- Modify: `src/components/database/DatabaseTree.tsx`
- Modify: `src/components/connection/ConnectionList.tsx`

**Interfaces:**
- Consumes: `activeConnection?.config.name` 与 `SortableConnectionItem` 的 `item.name`。
- Produces: 两个名称节点的可收缩 flex 样式及完整名称提示。

- [ ] **Step 1: 写入失败测试**

在 `DatabaseTreeCapabilities.test.tsx` 中复制 `postgresConnection` 为长名称连接，设置为 `activeConnection` 后渲染，并断言标题的 `.ant-typography` 容器具有 `flex: 1` 与 `min-width: 0`。在 `ConnectionListGroups.test.tsx` 增加以下用例，断言连接名称容器可收缩：

```tsx
  it("连接名称过长时应允许省略", () => {
    const connectionName = "very_long_connection_name_that_must_be_truncated";
    useConnectionStore.setState({
      savedConnections: [{ ...connections[0], name: connectionName }],
      connectionGroups: [],
    });

    render(<ConnectionList />);

    const title = screen.getByText(connectionName).closest(".ant-typography");
    expect(title).toHaveStyle({ flex: "1", minWidth: "0" });
  });
```

- [ ] **Step 2: 运行测试并确认失败**

```bash
npm test -- src/__tests__/DatabaseTreeCapabilities.test.tsx src/__tests__/ConnectionListGroups.test.tsx
```

预期：新增断言因名称元素缺少弹性收缩样式而失败。

- [ ] **Step 3: 写入最小实现**

在 `DatabaseTree.tsx` 的当前连接 `Title` 添加：

```tsx
style={{ margin: 0, color: "var(--text-primary)", fontSize: 14, flex: 1, minWidth: 0 }}
ellipsis={{ tooltip: activeConnection?.config.name }}
```

在 `ConnectionList.tsx` 的 `item.name` 对应 `Text` 添加：

```tsx
style={{ color: "var(--text-primary)", flex: 1, minWidth: 0 }}
ellipsis={{ tooltip: item.name }}
```

- [ ] **Step 4: 验证测试与构建**

```bash
npm test -- src/__tests__/DatabaseTreeCapabilities.test.tsx src/__tests__/ConnectionListGroups.test.tsx
npm run build
```

预期：两个测试文件和生产构建均成功。

- [ ] **Step 5: 检查并提交**

```bash
git diff --check
git add src/components/database/DatabaseTree.tsx src/components/connection/ConnectionList.tsx src/__tests__/DatabaseTreeCapabilities.test.tsx src/__tests__/ConnectionListGroups.test.tsx
git commit -m "fix: 连接名称过长时显示省略号"
```

预期：提交仅包含两处名称省略配置和回归测试。
