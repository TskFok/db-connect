# 表名省略 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让右侧数据表列表的超长表名以省略号显示，与注释列的行为一致。

**Architecture:** 在数据库概览的表名列复用 Ant Design Table 现有的列级 `ellipsis` 配置。保留原有图标与文字渲染、可调列宽、排序和行点击逻辑；测试通过渲染页面并断言表名单元格启用 Ant Design 的省略样式来覆盖该行为。

**Tech Stack:** React 18、TypeScript、Ant Design 5、Vitest、React Testing Library。

## Global Constraints

- 只修改右侧数据表列表的“表名”列，不变更默认列宽、列顺序、排序、点击行为或后端逻辑。
- 复用“注释”列的 `ellipsis: true` 配置，不新增 CSS、状态或依赖。
- 测试必须先失败，再写生产代码使其通过。
- 提交信息使用 Conventional Commits：`fix: 表名过长时显示省略号`。

---

### Task 1: 为表名列启用省略并覆盖渲染行为

**Files:**
- Modify: `src/__tests__/DatabaseOverview.test.tsx`
- Modify: `src/components/database/DatabaseOverview.tsx`

**Interfaces:**
- Consumes: `DatabaseOverview` 使用 `SortableListTable<TableInfo>` 渲染的 Ant Design 列定义。
- Produces: `name` 列的 `ellipsis: true` 配置；Ant Design 为该列的单元格添加 `ant-table-cell-ellipsis` 类。

- [ ] **Step 1: 写入失败的组件测试**

在 `src/__tests__/DatabaseOverview.test.tsx` 的 `DatabaseOverview 表头列宽调节` 测试组中加入以下用例。该断言专门检查表名单元格的 Ant Design 省略样式，并使用现有 `mockTables` 中的 `users` 记录：

```tsx
  it("表名列应启用省略显示", () => {
    const { container } = render(<DatabaseOverview />);

    const nameCell = screen.getByText("users").closest("td");
    expect(nameCell).not.toBeNull();
    expect(nameCell).toHaveClass("ant-table-cell-ellipsis");
    expect(container.querySelector(".database-table-list")).toBeTruthy();
  });
```

- [ ] **Step 2: 运行测试，确认它因缺少功能而失败**

运行：

```bash
npm test -- src/__tests__/DatabaseOverview.test.tsx
```

预期：新增用例失败，提示 `users` 所在单元格不含 `ant-table-cell-ellipsis`；已有测试继续通过。

- [ ] **Step 3: 写入最小生产代码**

在 `src/components/database/DatabaseOverview.tsx` 的 `columnDefinitions` 中，为 `name` 列在 `dataIndex: "name"` 后增加配置：

```tsx
      name: {
        title: "表名",
        dataIndex: "name",
        ellipsis: true,
        sorter: (a: TableInfo, b: TableInfo) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
```

不要修改该列已有的 `render` 函数；其中的图标和 `<Text strong>{name}</Text>` 必须保持不变。

- [ ] **Step 4: 运行测试，确认测试通过**

运行：

```bash
npm test -- src/__tests__/DatabaseOverview.test.tsx
```

预期：测试文件内全部用例通过，包括“表名列应启用省略显示”。

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
git add src/components/database/DatabaseOverview.tsx src/__tests__/DatabaseOverview.test.tsx
git commit -m "fix: 表名过长时显示省略号"
```

预期：无空白错误，提交仅包含表名列省略配置和对应组件测试。
