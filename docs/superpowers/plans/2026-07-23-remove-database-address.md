# 移除数据库树标题地址显示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除左侧数据库树标题下的数据库地址和 SSH 标记，同时保留连接名称与操作按钮。

**Architecture:** 只调整 `DatabaseTree` 标题区域的 JSX，删除次级连接地址文本节点。通过组件测试固定该区域不再渲染 `host:port` 的行为，不触及连接状态、数据模型或后端逻辑。

**Tech Stack:** React、TypeScript、Ant Design、Vitest、Testing Library。

## Global Constraints

- 仅影响左侧数据库树顶部的地址显示；连接列表、已连接空状态及其他区域维持现状。
- 保留连接名称、新建、排序、刷新、管理连接与断开连接操作。
- 不修改连接配置、状态管理、后端连接逻辑或数据模型。

---

### Task 1: 移除数据库树标题地址并添加回归测试

**Files:**
- Modify: `src/__tests__/DatabaseTreeCapabilities.test.tsx`
- Modify: `src/components/database/DatabaseTree.tsx:553-558`

**Interfaces:**
- Consumes: `DatabaseTree` 从 `useConnectionStore()` 读取的 `activeConnection.config.name`、`host` 与 `port`。
- Produces: 标题区域只显示连接名称和已有操作按钮，不渲染 `host:port` 或 SSH 标记。

- [ ] **Step 1: 写入失败的回归测试**

在 `src/__tests__/DatabaseTreeCapabilities.test.tsx` 的 `describe("DatabaseTree capabilities", ...)` 中添加：

```tsx
  it("标题区域保留连接名称但不显示数据库地址", () => {
    render(<DatabaseTree />);

    expect(screen.getByText("Postgres")).toBeInTheDocument();
    expect(screen.queryByText("localhost:5432")).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: 运行测试并确认失败**

运行：`npm test -- src/__tests__/DatabaseTreeCapabilities.test.tsx`

预期：新增测试失败，因为当前组件会渲染 `localhost:5432`。

- [ ] **Step 3: 最小化实现**

在 `src/components/database/DatabaseTree.tsx` 中删除以下次级文本节点，保留相邻标题和操作区域不变：

```tsx
        <Text type="secondary" style={{ fontSize: 11 }}>
          {activeConnection?.config.host}:{activeConnection?.config.port}
          {activeConnection?.config.ssh && " (SSH)"}
        </Text>
```

- [ ] **Step 4: 运行目标测试并确认通过**

运行：`npm test -- src/__tests__/DatabaseTreeCapabilities.test.tsx`

预期：全部测试通过，且新增断言确认连接名称仍存在、地址不存在。

- [ ] **Step 5: 运行前端构建验证**

运行：`npm run build`

预期：TypeScript 编译与 Vite 构建均以退出码 0 完成。

- [ ] **Step 6: 提交实现**

```bash
git add src/components/database/DatabaseTree.tsx src/__tests__/DatabaseTreeCapabilities.test.tsx
git commit -m "fix: 移除数据库树标题地址显示"
```
