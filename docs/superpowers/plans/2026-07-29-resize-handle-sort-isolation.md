# 列宽调节手柄与表头排序事件隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 调整公共列表表头的列宽时不触发数据排序，同时保留表头正文点击排序和手柄双击自适应行为。

**Architecture:** 在 `ResizableTableHeaderCell` 的列宽调节手柄事件边界阻止原生 `click` 冒泡，使浏览器拖拽收尾点击无法到达 Ant Design 的 `th` 排序处理器。回归测试直接渲染真实公共表头组件，验证列宽回调执行、手柄点击不冒泡以及表头正文点击仍正常冒泡。

**Tech Stack:** React 18、TypeScript、Ant Design 5、Vitest 4、Testing Library

## Global Constraints

- 在公共组件统一修复数据表、例程和事件列表。
- 不修改表头列顺序拖拽逻辑。
- 不改变列宽计算、上下限或持久化逻辑。
- 不修改 Ant Design 的排序状态管理。
- 不引入拖拽距离或额外的跨组件状态。
- `click` 只调用 `stopPropagation()`，不调用 `preventDefault()`。
- 默认在当前 `master` 分支修改，不新建分支。
- 不引入循环内 SQL 查询。

## File Structure

- `src/__tests__/ResizableTableHeaderCell.test.tsx`：覆盖列宽拖拽收尾点击与表头排序点击之间的行为边界。
- `src/components/common/ResizableTableHeaderCell.tsx`：在公共列宽调节手柄上注册和清理 `click` 冒泡隔离监听。

---

### Task 1: 隔离列宽调节手柄的排序点击

**Files:**
- Modify: `src/__tests__/ResizableTableHeaderCell.test.tsx:24-77`
- Modify: `src/components/common/ResizableTableHeaderCell.tsx:43-91`

**Interfaces:**
- Consumes: `ResizableTableHeaderCellProps.onResize?: (newWidth: number) => void`、继承自 `HTMLAttributes<HTMLTableCellElement>` 的 `onClick`、`.resizable-table-header-handle` DOM 边界。
- Produces: 列宽调节手柄的原生 `click` 监听；该监听只调用 `MouseEvent.stopPropagation()`，组件公开属性和函数签名不变。

- [x] **Step 1: 添加可复现误排序的失败测试**

在 `src/__tests__/ResizableTableHeaderCell.test.tsx` 的“拖动调节手柄应调用 onResize”测试之后添加：

```tsx
  it("调节列宽后的 click 不应冒泡到表头", () => {
    const onResize = vi.fn();
    const onHeaderClick = vi.fn();
    const { container } = render(
      <table>
        <thead>
          <tr>
            <ResizableTableHeaderCell
              width={120}
              onResize={onResize}
              onClick={onHeaderClick}
            >
              表名
            </ResizableTableHeaderCell>
          </tr>
        </thead>
      </table>
    );

    const handle = container.querySelector(
      ".resizable-table-header-handle"
    ) as HTMLElement;
    const header = container.querySelector("th") as HTMLElement;

    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 130 });
    fireEvent.mouseUp(document);
    fireEvent.click(handle);

    expect(onResize).toHaveBeenCalled();
    expect(onHeaderClick).not.toHaveBeenCalled();

    fireEvent.click(header);
    expect(onHeaderClick).toHaveBeenCalledTimes(1);
  });
```

这项测试捕获的生产缺陷是：移除或缺失调节手柄的 `click` 冒泡隔离时，拖拽收尾点击会调用表头点击处理器。

- [x] **Step 2: 运行测试并确认按预期失败**

Run:

```bash
npm test -- src/__tests__/ResizableTableHeaderCell.test.tsx
```

Expected: 新测试失败，`onHeaderClick` 在 `fireEvent.click(handle)` 后已被调用一次；其余现有测试通过。

- [x] **Step 3: 实施最小公共组件修复**

在 `src/components/common/ResizableTableHeaderCell.tsx` 的 `useEffect` 内、`onDoubleClick` 前添加：

```tsx
    const stopClickPropagation = (e: MouseEvent) => {
      e.stopPropagation();
    };
```

将监听注册和清理改为：

```tsx
    el.addEventListener("mousedown", startResize, true);
    el.addEventListener("click", stopClickPropagation, true);
    el.addEventListener("dblclick", onDoubleClick, true);
    return () => {
      el.removeEventListener("mousedown", startResize, true);
      el.removeEventListener("click", stopClickPropagation, true);
      el.removeEventListener("dblclick", onDoubleClick, true);
    };
```

不修改 `startResize`、`onMouseMove`、`onMouseUp`、`onDoubleClick` 或组件属性。

- [x] **Step 4: 运行公共组件测试并确认转绿**

Run:

```bash
npm test -- src/__tests__/ResizableTableHeaderCell.test.tsx
```

Expected: 该测试文件全部通过，调节手柄点击不调用 `onHeaderClick`，直接点击 `th` 调用一次。

- [x] **Step 5: 运行右侧列表相关回归测试**

Run:

```bash
npm test -- src/__tests__/ResizableTableHeaderCell.test.tsx src/__tests__/DatabaseOverview.test.tsx
```

Expected: 两个测试文件全部通过，无错误或警告。

- [x] **Step 6: 运行静态检查和生产构建**

Run:

```bash
npm run lint
npm run build
```

Expected: ESLint 零错误退出，TypeScript 与 Vite 生产构建成功。

Actual: 改动文件的定向 ESLint 零错误，TypeScript 与 Vite 生产构建成功。完整 `npm run lint` 被未改动的 `scripts/release.mjs` 两个 `preserve-caught-error` 和 `scripts/release.node-test.mjs` 一个 `no-undef` 基线错误阻断。

- [ ] **Step 7: 审查并提交实现**

Run:

```bash
git diff --check
git diff -- src/__tests__/ResizableTableHeaderCell.test.tsx src/components/common/ResizableTableHeaderCell.tsx
git add src/__tests__/ResizableTableHeaderCell.test.tsx src/components/common/ResizableTableHeaderCell.tsx
git commit -m "fix: 修复调整列宽触发表头排序"
```

Expected: 差异仅包含一项回归测试和公共手柄的 `click` 监听注册/清理；提交成功。
