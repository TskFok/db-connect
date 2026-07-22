# 移除数据表内容区表头 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除数据表内容区顶部的数据库名、数据表名与类型信息行，让标签页内容整体自然上移。

**Architecture:** 直接删除 `TableContent` 中独立的表头 JSX，不引入 CSS 隐藏规则或配置开关。保留现有标签页生成、表/视图能力判断、切换与数据加载逻辑，并用组件测试锁定表头不再渲染的行为。

**Tech Stack:** React 19、TypeScript、Ant Design、Vitest、Testing Library

## Global Constraints

- 仅移除数据表内容区的独立表头行。
- 顶部多表标签栏与底部状态栏中的数据库/表信息保持不变。
- 不改变标签页能力、切换逻辑或数据加载逻辑。
- 不新增依赖、配置或 CSS 隐藏规则。

---

### Task 1: 移除数据表内容区表头

**Files:**
- Modify: `src/__tests__/TableContentSwitchTable.test.tsx:82`
- Modify: `src/components/table/TableContent.tsx:2-21,174-203`

**Interfaces:**
- Consumes: `useDatabaseStore()` 提供的 `selectedDatabase`、`selectedTable`、`selectedTableInfo` 与标签页状态。
- Produces: `TableContent()` 继续返回相同的标签页容器，但不再输出独立的数据库/表/类型表头节点。

- [x] **Step 1: 写入失败测试**

在 `src/__tests__/TableContentSwitchTable.test.tsx` 的第一个测试前加入：

```tsx
it("不再渲染内容区的数据库、表名与类型表头", () => {
  render(<TableContent />);

  expect(screen.queryByText("mydb")).not.toBeInTheDocument();
  expect(screen.queryByText("users")).not.toBeInTheDocument();
  expect(screen.queryByText("TABLE")).not.toBeInTheDocument();
});
```

- [x] **Step 2: 运行测试并确认按预期失败**

Run: `npm test -- src/__tests__/TableContentSwitchTable.test.tsx`

Expected: 新测试失败，错误指出 `mydb` 仍存在于文档中；其他既有测试保持通过。

- [x] **Step 3: 编写最小实现**

将 `src/components/table/TableContent.tsx` 的 Ant Design 导入改为：

```tsx
import { Tabs, Spin } from "antd";
```

将图标导入改为：

```tsx
import {
  TableOutlined,
  UnorderedListOutlined,
  CodeOutlined,
  BarChartOutlined,
  ThunderboltOutlined,
  LinkOutlined,
} from "@ant-design/icons";
```

删除：

```tsx
const { Title, Text } = Typography;
```

并删除返回结构中 `Tabs` 之前的整个表头节点：

```tsx
{/* 表头信息 */}
<div style={{ marginBottom: 12 }}>
  <Space align="center">
    <DatabaseOutlined style={{ color: "#1677ff" }} />
    <Text type="secondary">{selectedDatabase}</Text>
    <Text type="secondary">/</Text>
    {isView ? (
      <EyeOutlined style={{ color: "#faad14" }} />
    ) : (
      <TableOutlined style={{ color: "#52c41a" }} />
    )}
    <Title level={4} style={{ margin: 0 }}>
      {selectedTable}
    </Title>
    <Tag color={isView ? "orange" : "blue"}>
      {isView ? "VIEW" : "TABLE"}
    </Tag>
  </Space>
</div>
```

使 `<Tabs>` 成为外层弹性容器中的首个可见子节点，不增加替代间距。

- [x] **Step 4: 运行针对性测试并确认通过**

Run: `npm test -- src/__tests__/TableContentSwitchTable.test.tsx`

Expected: `TableContentSwitchTable.test.tsx` 中所有测试通过，0 个失败。

- [x] **Step 5: 运行完整前端验证**

Run: `npm test`

Expected: 全部 Vitest 测试通过，0 个失败。

Run: `npm run lint`

Expected: ESLint 退出码为 0，无错误。

Run: `npm run build`

Expected: TypeScript 编译与 Vite 构建均成功，退出码为 0。

- [x] **Step 6: 检查并提交改动**

Run: `git diff --check && git status --short`

Expected: `git diff --check` 无输出；状态仅包含本计划、测试文件与 `TableContent.tsx` 的预期改动。

```bash
git add docs/superpowers/plans/2026-07-22-remove-table-content-header.md src/__tests__/TableContentSwitchTable.test.tsx src/components/table/TableContent.tsx
git commit -m "refactor: 移除数据表内容区冗余表头"
```
