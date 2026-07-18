# 同步 SQL 预览滚动修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复「同步 SQL 预览」内容超过可视高度后无法上下滚动的问题，并保持弹窗标题和底部操作区可见。

**Architecture:** 沿用项目内 Ant Design Modal 的已验证布局模式，通过 Modal `styles` 明确 content 的纵向 flex 和最大高度，让 body 成为唯一的纵向滚动容器。内层 `.database-sync-preview-body` 只负责内容排版，SQL 代码块继续独立处理横向滚动。

**Tech Stack:** React 18、TypeScript、Ant Design 5、CSS、Vitest、Testing Library

## Global Constraints

- 默认在当前 `master` 分支修改，不新建分支。
- 不修改同步计划、执行逻辑、后端命令或数据库访问。
- 弹窗标题、关闭入口和底部操作按钮保持可见，仅中间 body 纵向滚动。
- 短内容不强制撑满整个视口；长 SQL 继续在代码块内横向滚动。
- 先确认回归测试按预期失败，再修改生产代码。
- 不在循环遍历中查询 SQL；本计划不涉及 SQL 查询改动。

## File Structure

- `src/__tests__/DatabaseSyncPreviewModal.test.tsx`：增加 Modal 滚动层级和固定标题/页脚的组件回归测试。
- `src/components/databaseCompare/DatabaseSyncPreviewModal.tsx`：通过 Modal `styles` 声明 content/body 的高度与滚动契约。
- `src/components/databaseCompare/DatabaseCompareModal.css`：删除内层百分比高度和重复的 Modal content/body 布局规则，保留内容排版、sticky 方向栏与 SQL 横向滚动。

---

### Task 1: 修复同步 SQL 预览的滚动容器

**Files:**
- Modify: `src/__tests__/DatabaseSyncPreviewModal.test.tsx:144-179`
- Modify: `src/components/databaseCompare/DatabaseSyncPreviewModal.tsx:526-593`
- Modify: `src/components/databaseCompare/DatabaseCompareModal.css:106-143`

**Interfaces:**
- Consumes: Ant Design `Modal` 的 `styles.content` 与 `styles.body`；现有 `DatabaseSyncPreviewModalProps` 不变。
- Produces: `.ant-modal-body` 是唯一纵向滚动容器；`DatabaseSyncPreviewModal` 的业务属性、回调与返回 JSX 契约不变。

- [ ] **Step 1: 写入失败的滚动布局回归测试**

在 `DatabaseSyncPreviewModal.test.tsx` 的首个展示测试之后增加：

```tsx
it("让弹窗正文独立纵向滚动并保留标题和页脚", () => {
  renderPreview();

  const modalContent = document.querySelector(
    ".database-sync-preview-modal .ant-modal-content"
  ) as HTMLElement | null;
  const modalBody = document.querySelector(
    ".database-sync-preview-modal .ant-modal-body"
  ) as HTMLElement | null;
  const modalFooter = screen
    .getByRole("button", { name: "返回对比结果" })
    .closest(".ant-modal-footer");
  const modalTitle = screen.getByText("同步 SQL 预览");

  expect(modalContent).not.toBeNull();
  expect(modalBody).not.toBeNull();
  expect(modalContent?.style.display).toBe("flex");
  expect(modalContent?.style.flexDirection).toBe("column");
  expect(modalContent?.style.maxHeight).toBe("calc(100dvh - 48px)");
  expect(modalBody?.style.flex).toBe("1 1 auto");
  expect(modalBody?.style.minHeight).toBe("0");
  expect(modalBody?.style.overflowY).toBe("auto");
  expect(modalBody?.style.scrollbarGutter).toBe("stable");
  expect(modalBody?.contains(modalTitle)).toBe(false);
  expect(modalBody?.contains(modalFooter)).toBe(false);
});
```

- [ ] **Step 2: 运行聚焦测试并确认 RED**

Run: `npm test -- src/__tests__/DatabaseSyncPreviewModal.test.tsx`

Expected: FAIL，新增用例在 `modalContent?.style.display` 或 `modalBody?.style.overflowY` 处得到空字符串，而不是期望的 `flex` / `auto`；其余既有用例通过。

- [ ] **Step 3: 给 Modal 建立可测试的滚动布局契约**

在 `DatabaseSyncPreviewModal.tsx` 的 `<Modal>` 上，紧跟 `rootClassName` 增加：

```tsx
styles={{
  content: {
    display: "flex",
    flexDirection: "column",
    maxHeight: "calc(100dvh - 48px)",
  },
  body: {
    flex: "1 1 auto",
    minHeight: 0,
    overflowY: "auto",
    scrollbarGutter: "stable",
  },
}}
```

不要修改 `open`、`footer`、`closable`、执行锁或回调属性。

- [ ] **Step 4: 删除错误的内层滚动和重复布局规则**

把 `DatabaseCompareModal.css` 中的 `.database-sync-preview-body` 收敛为：

```css
.database-sync-preview-body {
  display: grid;
  gap: 16px;
  min-width: 0;
  padding: 4px;
}
```

删除以下两组已由 Modal `styles` 接管的规则，避免双重滚动和布局契约分散：

```css
.database-sync-preview-modal .ant-modal-content {
  display: flex;
  flex-direction: column;
  max-height: calc(100dvh - 48px);
}

.database-sync-preview-modal .ant-modal-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}
```

保留 `.database-sync-preview-modal .ant-modal` 的视口上边距和最大高度，以及 `.database-sync-sql-list pre` 的 `overflow-x: auto`。

- [ ] **Step 5: 运行聚焦测试并确认 GREEN**

Run: `npm test -- src/__tests__/DatabaseSyncPreviewModal.test.tsx`

Expected: PASS，`DatabaseSyncPreviewModal.test.tsx` 全部用例通过，无新增 warning 或 error。

- [ ] **Step 6: 运行相关回归测试**

Run: `npm test -- src/__tests__/DatabaseSyncPreviewModal.test.tsx src/__tests__/DatabaseCompareModal.test.tsx`

Expected: PASS，预览确认、执行锁、结果展示、重新对比和父弹窗集成用例全部通过。

- [ ] **Step 7: 运行前端全量验证**

Run: `npm test`

Expected: PASS，前端全量测试全部通过。

Run: `npm run build`

Expected: exit 0，TypeScript 与 Vite 构建成功。

Run: `npm run lint`

Expected: exit 0，无 ESLint 错误。

Run: `npm run format:check`

Expected: exit 0，修改的 TSX、测试与 CSS 均符合 Prettier 格式。

- [ ] **Step 8: 复核并提交最小修复**

Run: `git diff --check`

Expected: exit 0，无空白错误。

Run: `git diff -- src/__tests__/DatabaseSyncPreviewModal.test.tsx src/components/databaseCompare/DatabaseSyncPreviewModal.tsx src/components/databaseCompare/DatabaseCompareModal.css`

Expected: 仅包含滚动回归测试、Modal `styles` 和对应 CSS 清理。

```bash
git add src/__tests__/DatabaseSyncPreviewModal.test.tsx src/components/databaseCompare/DatabaseSyncPreviewModal.tsx src/components/databaseCompare/DatabaseCompareModal.css
git commit -m "fix: 修复同步 SQL 预览无法滚动"
```
