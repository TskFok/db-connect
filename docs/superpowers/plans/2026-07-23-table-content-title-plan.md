# 表详情页签栏标题 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在表详情内层页签栏右侧显示当前选中表的 `数据库/schema.表名`。

**Architecture:** `TableContent` 已订阅 `selectedDatabase` 与 `selectedTable`，因此在该组件构造显示文本并通过 Ant Design `Tabs` 的 `tabBarExtraContent` 渲染即可。标题使用省略样式与原生 `title` 属性，避免长名称挤压可切换的页签。

**Tech Stack:** React 18、TypeScript、Ant Design 5、Zustand、Vitest、Testing Library。

## Global Constraints

- 不新增数据库请求或状态字段；只复用 `selectedDatabase` 与 `selectedTable`。
- 标题格式固定为 `${selectedDatabase}.${selectedTable}`，适用于数据库与 schema。
- 标题必须右对齐、超长截断，并在 `title` 属性中保留全量文本。
- 不改动顶部多表标签、数据/结构加载逻辑或内层页签集合。

---

### Task 1: 在表详情页签栏显示当前表标识

**Files:**
- Modify: `src/__tests__/TableContentSwitchTable.test.tsx:81-88`
- Modify: `src/components/table/TableContent.tsx:172-181`

**Interfaces:**
- Consumes: `useDatabaseStore()` 返回的 `selectedDatabase: string | null`、`selectedTable: string | null`。
- Produces: `Tabs.tabBarExtraContent.right`，渲染完整表标识并设置省略与提示。

- [ ] **Step 1: 写入失败测试**

  将现有“内容区不再渲染表名”的测试改为仅约束旧表头未出现，并新增以下测试：

  ```tsx
  it("在页签栏右侧显示当前数据库/schema 与表名", () => {
    render(<TableContent />);

    const tableTitle = screen.getByText("mydb.users");
    expect(tableTitle).toBeInTheDocument();
    expect(tableTitle).toHaveAttribute("title", "mydb.users");
  });
  ```

- [ ] **Step 2: 运行测试并确认失败**

  Run: `npm test -- src/__tests__/TableContentSwitchTable.test.tsx`

  Expected: FAIL，提示找不到文本 `mydb.users`。

- [ ] **Step 3: 实现最小页签栏标题**

  在 `TableContent` 的 `Tabs` 前计算标题，并传入 `tabBarExtraContent`：

  ```tsx
  const tableDisplayName = `${selectedDatabase}.${selectedTable}`;

  <Tabs
    // 保留既有 props
    tabBarExtraContent={{
      right: (
        <span
          title={tableDisplayName}
          style={{
            display: "inline-block",
            maxWidth: "min(40vw, 360px)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {tableDisplayName}
        </span>
      ),
    }}
  />
  ```

- [ ] **Step 4: 运行目标测试并确认通过**

  Run: `npm test -- src/__tests__/TableContentSwitchTable.test.tsx`

  Expected: PASS，目标测试文件全部通过。

- [ ] **Step 5: 运行类型与生产构建验证**

  Run: `npm run build`

  Expected: PASS，TypeScript 检查与 Vite 构建均无错误。

- [ ] **Step 6: 提交实现**

  ```bash
  git add src/components/table/TableContent.tsx src/__tests__/TableContentSwitchTable.test.tsx
  git commit -m "feat: 表详情页签栏显示当前表名"
  ```
