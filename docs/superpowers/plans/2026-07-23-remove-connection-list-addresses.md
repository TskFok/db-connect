# 移除左侧连接列表地址信息 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 左侧数据库连接列表不再展示数据库或 SSH 地址，同时保留 SSH 隧道图标。

**Architecture:** 仅调整 `SortableConnectionItem` 的展示 JSX，不变更连接配置、状态或交互。组件测试复用既有的 SSH 连接样例，断言名称与 SSH 图标仍存在，并断言两个地址字符串不存在。

**Tech Stack:** React 18、TypeScript、Ant Design、Vitest、Testing Library。

## Global Constraints

- 仅修改左侧连接列表的展示；其他页面及连接配置中的地址信息保持不变。
- 保留 SSH 隧道图标及其可访问名称 `SSH 隧道：PostgreSQL SSH`。
- 不在循环遍历中查询 SQL。

---

### Task 1: 移除连接列表地址文字

**Files:**
- Modify: `src/__tests__/ConnectionListGroups.test.tsx:141-205`
- Modify: `src/components/connection/ConnectionList.tsx:212-252`

**Interfaces:**
- Consumes: `ConnectionConfig` 的 `host`、`port`、`database` 与可选 `ssh` 配置。
- Produces: `SortableConnectionItem` 仅展示名称、类型图标、SSH 图标和连接状态，不渲染数据库或 SSH 地址文字。

- [ ] **Step 1: 写入失败测试**

在已有的“为当前支持的连接类型渲染数据库类型主图标并保留 SSH 辅助图标”测试末尾增加断言：

```tsx
expect(screen.getByText("PostgreSQL SSH")).toBeInTheDocument();
expect(screen.getByLabelText("SSH 隧道：PostgreSQL SSH")).toBeInTheDocument();
expect(screen.queryByText("pg.local:5432")).not.toBeInTheDocument();
expect(screen.queryByText("SSH: jump.local:22")).not.toBeInTheDocument();
```

- [ ] **Step 2: 运行测试，确认其因现有地址文字而失败**

Run: `npm test -- src/__tests__/ConnectionListGroups.test.tsx`

Expected: FAIL，断言 `pg.local:5432` 或 `SSH: jump.local:22` 不存在时失败。

- [ ] **Step 3: 编写最小实现**

从 `SortableConnectionItem` 的名称行之后删除以下 JSX，保留 `item.ssh` 的 `CloudServerOutlined` 图标分支不变：

```tsx
<Text type="secondary" style={{ fontSize: 12 }} ellipsis>
  {item.host}:{item.port}
  {item.database && ` / ${item.database}`}
</Text>
{item.ssh && (
  <div>
    <Text type="secondary" style={{ fontSize: 11 }}>
      SSH: {item.ssh.host}:{item.ssh.port}
    </Text>
  </div>
)}
```

同时从名称行的行内样式中删除只为次级文本留出的 `marginBottom: 4`：

```tsx
style={{
  display: "flex",
  alignItems: "center",
  gap: 8,
}}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test -- src/__tests__/ConnectionListGroups.test.tsx`

Expected: PASS，所有该文件测试通过，SSH 图标断言继续成功。

- [ ] **Step 5: 运行前端构建**

Run: `npm run build`

Expected: PASS，TypeScript 检查与 Vite 构建成功。

- [ ] **Step 6: 提交实现**

```bash
git add src/components/connection/ConnectionList.tsx src/__tests__/ConnectionListGroups.test.tsx
git commit -m "fix: 精简左侧连接列表信息"
```

## 自查

- 设计中的数据库地址、SSH 地址移除要求均由 Task 1 覆盖。
- SSH 图标保留要求由同一测试的可访问名称断言覆盖。
- 计划不包含待定项，涉及的属性名与现有 `ConnectionConfig` 和 JSX 一致。
