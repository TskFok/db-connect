# 复制 INSERT 时选择字段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「复制为 INSERT 语句」改成居中对话框勾选字段后再复制，并移除「不含主键」按钮。

**Architecture:** `orderedSelectedColumns` 按表结构顺序过滤勾选列。`TableData` 打开对话框收集勾选，确认后仍用 `loadCompleteRowsForPage` 取完整值，再用该列列表调用现有 `generateInsertStatements`。

**Tech Stack:** React、Ant Design `Modal`/`Checkbox`/`Tag`、Vitest、Testing Library。

## Global Constraints

- 对话框居中，标题为「复制为 INSERT 语句」。
- 列出表结构全部列，打开时全选；主键旁显示「主键」。
- 列数大于 10 才显示搜索；提供「全选」「全不选」。
- 未勾选任何列时「复制」禁用；取消不写剪贴板。
- 不记住上次勾选；连接、库或表变化时关闭对话框。
- 去掉「复制为 INSERT 语句（不含主键）」按钮。
- 未提交单元格修改仍进入 INSERT。
- 提交信息使用 `feat: 复制 INSERT 时可选择字段`。

---

### Task 1: 按表列顺序保留勾选列

**Files:**
- Modify: `src/utils/sqlUtils.ts`（`generateInsertStatements` 之前）
- Test: `src/__tests__/copyAsInsert.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `orderedSelectedColumns(allColumns: readonly string[], selectedColumns: ReadonlySet<string>): string[]`

- [ ] **Step 1: Write the failing test**

在 `src/__tests__/copyAsInsert.test.ts` 的 import 中加入 `orderedSelectedColumns`，并在文件末尾追加：

```ts
describe("orderedSelectedColumns", () => {
  it("按表结构顺序保留勾选列", () => {
    expect(
      orderedSelectedColumns(
        ["id", "name", "email"],
        new Set(["email", "id"])
      )
    ).toEqual(["id", "email"]);
  });

  it("忽略不在表结构中的列名", () => {
    expect(
      orderedSelectedColumns(["id", "name"], new Set(["name", "ghost"]))
    ).toEqual(["name"]);
  });

  it("没有勾选列时返回空数组", () => {
    expect(orderedSelectedColumns(["id", "name"], new Set())).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/copyAsInsert.test.ts`

Expected: FAIL，`orderedSelectedColumns` 未导出。

- [ ] **Step 3: Write minimal implementation**

在 `src/utils/sqlUtils.ts` 的 `generateInsertStatements` 函数之前插入：

```ts
/** 按表列顺序保留勾选列，忽略不在表结构中的名字。 */
export function orderedSelectedColumns(
  allColumns: readonly string[],
  selectedColumns: ReadonlySet<string>
): string[] {
  return allColumns.filter((column) => selectedColumns.has(column));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/copyAsInsert.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/sqlUtils.ts src/__tests__/copyAsInsert.test.ts
git commit -m "$(cat <<'EOF'
feat: 复制 INSERT 时可选择字段

EOF
)"
```

---

### Task 2: 居中对话框选择字段并移除不含主键入口

**Files:**
- Modify: `src/components/table/TableData.tsx`
- Modify: `src/__tests__/TableDataDeferred.test.tsx`
- Modify: `README.md`（「复制为 SQL / JSON」那一条）

**Interfaces:**
- Consumes: `orderedSelectedColumns(allColumns: readonly string[], selectedColumns: ReadonlySet<string>): string[]`
- Produces: 工具栏按钮「复制为 INSERT 语句」打开对话框；确认按钮文案为「复制」

- [ ] **Step 1: Write the failing test**

在 `src/__tests__/TableDataDeferred.test.tsx` 中，把「没有隐藏列时复制 INSERT 也加载完整大字段」里的点击改为先打开对话框再确认：

```ts
fireEvent.click(screen.getByRole("button", { name: "复制为 INSERT 语句" }));
const dialog = await screen.findByRole("dialog", {
  name: "复制为 INSERT 语句",
});
expect(
  screen.queryByRole("button", { name: "复制为 INSERT 语句（不含主键）" })
).not.toBeInTheDocument();
expect(within(dialog).getByRole("checkbox", { name: /id/ })).toBeChecked();
expect(within(dialog).getByText("主键")).toBeInTheDocument();
expect(
  within(dialog).queryByPlaceholderText("搜索列名...")
).not.toBeInTheDocument();
fireEvent.click(within(dialog).getByRole("button", { name: "复制" }));
```

保留该用例后面原有的 `waitFor` 与剪贴板断言。

在同一 `describe` 末尾追加：

```ts
it("取消勾选主键后 INSERT 不含该列", async () => {
  mockApi.queryFullRows.mockResolvedValue(fullRowsResult([[1, fullBody1]]));
  const { container } = render(<TableData />);
  await selectRows(container, 1);

  fireEvent.click(screen.getByRole("button", { name: "复制为 INSERT 语句" }));
  const dialog = await screen.findByRole("dialog", {
    name: "复制为 INSERT 语句",
  });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: /id/ }));
  fireEvent.click(within(dialog).getByRole("button", { name: "复制" }));

  await waitFor(() => expect(mockedWriteText).toHaveBeenCalledTimes(1));
  const copied = mockedWriteText.mock.calls[0]?.[0] ?? "";
  expect(copied).toContain("`body`");
  expect(copied).toContain("`title`");
  expect(copied).not.toContain("`id`");
});

it("全部取消勾选后不能复制，取消不写剪贴板", async () => {
  const { container } = render(<TableData />);
  await selectRows(container, 1);

  fireEvent.click(screen.getByRole("button", { name: "复制为 INSERT 语句" }));
  const dialog = await screen.findByRole("dialog", {
    name: "复制为 INSERT 语句",
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "全不选" }));
  expect(within(dialog).getByRole("button", { name: "复制" })).toBeDisabled();
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));

  await waitFor(() =>
    expect(
      screen.queryByRole("dialog", { name: "复制为 INSERT 语句" })
    ).not.toBeInTheDocument()
  );
  expect(mockedWriteText).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/TableDataDeferred.test.tsx`

Expected: FAIL，找不到对话框「复制为 INSERT 语句」（当前点击按钮会直接复制）。

- [ ] **Step 3: Write minimal implementation**

`src/components/table/TableData.tsx`：

1. 从 `@ant-design/icons` 的 import 中删除 `ScissorOutlined`。
2. 从 `../../utils/sqlUtils` 的 import 中加入 `orderedSelectedColumns`。
3. 在 `const [columnSearchText, setColumnSearchText] = useState("");` 附近增加：

```ts
const [copyInsertOpen, setCopyInsertOpen] = useState(false);
const [copyInsertSelected, setCopyInsertSelected] = useState<string[]>([]);
const [copyInsertSearch, setCopyInsertSearch] = useState("");
```

4. 在现有表切换重置附近增加（依赖 `connId`、`database`、`table`）：

```ts
useEffect(() => {
  setCopyInsertOpen(false);
}, [connId, database, table]);
```

5. 把 `handleCopyAsInsert` 换成下面两个回调，删除 `excludePrimaryKeys` 参数和「不含主键」文案：

```ts
const openCopyInsertModal = useCallback(() => {
  if (getSelectedRows().length === 0) {
    messageApi.warning("请先勾选要复制的行");
    return;
  }
  setCopyInsertSelected(allColumnNames);
  setCopyInsertSearch("");
  setCopyInsertOpen(true);
}, [allColumnNames, getSelectedRows, messageApi]);

const confirmCopyAsInsert = useCallback(async () => {
  const selectedRows = getSelectedRows();
  const selectedCols = orderedSelectedColumns(
    allColumnNames,
    new Set(copyInsertSelected)
  );
  if (selectedRows.length === 0) {
    messageApi.warning("请先勾选要复制的行");
    return;
  }
  if (selectedCols.length === 0) {
    messageApi.warning("请至少选择一列");
    return;
  }

  let insertRows: Record<string, unknown>[];
  try {
    const needsFullRows =
      selectedCols.some((col) => hiddenColumns.has(col)) &&
      primaryKeyColumns.length > 0;
    const complete = await loadCompleteRowsForPage(
      selectedRows,
      selectedCols,
      needsFullRows
    );
    insertRows = complete.rows.map((row) => {
      const merged = { ...row };
      const pks = getRecordPrimaryKeys(row, primaryKeyColumns);
      for (const col of selectedCols) {
        const pending = pendingChanges.get(buildPendingChangeKey(pks, col));
        if (pending) merged[col] = pending.newValue;
      }
      return merged;
    });
  } catch (e) {
    messageApi.error(`获取完整行数据失败: ${e}`);
    return;
  }

  const sql = generateInsertStatements(
    table,
    selectedCols,
    insertRows,
    [],
    currentDatabaseType
  );
  if (!sql) {
    messageApi.warning("无法生成 INSERT 语句");
    return;
  }

  try {
    await copyTextWithBreadcrumb(sql, "table-data-copy-insert", {
      database,
      table,
      row_count: insertRows.length,
      column_count: selectedCols.length,
    });
    messageApi.success("已复制 INSERT 语句");
    setCopyInsertOpen(false);
  } catch {
    messageApi.error("复制到剪贴板失败");
  }
}, [
  allColumnNames,
  copyInsertSelected,
  currentDatabaseType,
  database,
  getSelectedRows,
  hiddenColumns,
  loadCompleteRowsForPage,
  messageApi,
  pendingChanges,
  primaryKeyColumns,
  table,
]);
```

6. 工具栏里删除「不含主键」那个 `Tooltip`/`Button`。把保留按钮的 `onClick` 改为 `() => openCopyInsertModal()`。

7. 在筛选 `Modal` 之后插入：

```tsx
<Modal
  title="复制为 INSERT 语句"
  open={copyInsertOpen}
  centered
  width={420}
  destroyOnHidden
  onCancel={() => setCopyInsertOpen(false)}
  footer={
    <Space>
      <Button onClick={() => setCopyInsertOpen(false)}>取消</Button>
      <Button
        type="primary"
        disabled={copyInsertSelected.length === 0}
        onClick={() => void confirmCopyAsInsert()}
      >
        复制
      </Button>
    </Space>
  }
>
  <div
    style={{
      display: "flex",
      justifyContent: "flex-end",
      marginBottom: 8,
    }}
  >
    <Space size={4}>
      <Button
        type="link"
        size="small"
        onClick={() => setCopyInsertSelected(allColumnNames)}
      >
        全选
      </Button>
      <Button
        type="link"
        size="small"
        onClick={() => setCopyInsertSelected([])}
      >
        全不选
      </Button>
    </Space>
  </div>
  {allColumnNames.length > 10 && (
    <SafeInput
      size="small"
      placeholder="搜索列名..."
      value={copyInsertSearch}
      onChange={(e) => setCopyInsertSearch(e.target.value)}
      style={{ marginBottom: 8 }}
      allowClear
    />
  )}
  <div style={{ maxHeight: 360, overflowY: "auto" }}>
    {searchColumns(allColumnNames, copyInsertSearch).map((col) => (
      <div key={col} style={{ padding: "2px 0" }}>
        <Checkbox
          checked={copyInsertSelected.includes(col)}
          onChange={() =>
            setCopyInsertSelected((prev) =>
              prev.includes(col)
                ? prev.filter((name) => name !== col)
                : [...prev, col]
            )
          }
        >
          <Text style={{ fontSize: 12 }}>{col}</Text>
          {primaryKeyColumns.includes(col) && (
            <Tag
              color="gold"
              style={{ marginInlineStart: 6, fontSize: 10, lineHeight: "16px" }}
            >
              主键
            </Tag>
          )}
        </Checkbox>
      </div>
    ))}
  </div>
</Modal>
```

`searchColumns` 已从 `./tableDataUtils` 导入则直接使用；若当前文件未导入，把 `searchColumns` 加进该 import。

8. 把 `README.md` 这一句：

```md
- **复制为 SQL / JSON**：将选中行复制为 INSERT 语句（可排除主键列），或按当前可见列复制为 JSON 数组，包含未提交的单元格修改
```

改为：

```md
- **复制为 SQL / JSON**：将选中行复制为 INSERT 语句（可勾选字段），或按当前可见列复制为 JSON 数组，包含未提交的单元格修改
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/__tests__/TableDataDeferred.test.tsx src/__tests__/copyAsInsert.test.ts`

Expected: PASS。对话框里主键复选框的可访问名称需能匹配 `/id/`；若 Ant Design 把「主键」标签算进名称，断言改为 `{ name: /^id/ }` 或 `within(dialog).getByRole("checkbox", { name: /id/ })` 仍应通过。若「复制」匹配到多个按钮，改为 `within(dialog).getByRole("button", { name: "复制" })`（计划中的写法已经限定在 dialog 内）。

- [ ] **Step 5: Commit**

```bash
git add src/components/table/TableData.tsx src/__tests__/TableDataDeferred.test.tsx README.md
git commit -m "$(cat <<'EOF'
feat: 复制 INSERT 时可选择字段

EOF
)"
```

若 Task 1 已单独提交，本提交只包含对话框与测试。若两次改动一起提交，使用同一条提交信息即可。
