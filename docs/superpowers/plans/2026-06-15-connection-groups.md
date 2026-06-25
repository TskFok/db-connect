# Connection Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add grouped saved database connections with collapsible groups, group CRUD, deletion that keeps connections, and drag-and-drop movement between groups.

**Architecture:** Extend the encrypted Rust connection storage to a versioned payload containing `connections` and `groups`, while preserving read compatibility with the legacy flat connection array. Keep React state in `connectionStore`, expose Tauri commands through `tauriCommands.ts`, and move drag placement math into a small pure utility so it can be tested independently from `@dnd-kit`.

**Tech Stack:** Tauri Rust commands, serde JSON storage, React 18, Zustand, Ant Design, `@dnd-kit`, Vitest, Cargo tests.

---

## File Structure

- Modify `src-tauri/src/models/types.rs`: add `group_id` to `ConnectionConfig` and define `ConnectionGroup`.
- Modify `src-tauri/src/commands/connection.rs`: add grouped storage payload, compatibility loader, group commands, and move command.
- Modify `src-tauri/src/commands/mod.rs` or `src-tauri/src/lib.rs` only if command registration needs explicit updates.
- Modify `src/types/index.ts`: add `group_id` and `ConnectionGroup`.
- Modify `src/services/tauriCommands.ts`: add group command wrappers.
- Modify `src/stores/connectionStore.ts`: add group state and actions.
- Create `src/utils/connectionGroups.ts`: pure grouping and drag result utilities.
- Create `src/__tests__/connectionGroups.test.ts`: pure utility tests.
- Modify `src/__tests__/connectionStore.test.ts`: store action tests.
- Modify `src/components/connection/ConnectionList.tsx`: grouped UI and drag/drop behavior.
- Create or modify `src/__tests__/ConnectionListGroups.test.tsx`: render and action tests.

### Task 1: Rust Storage Model And Compatibility

**Files:**
- Modify: `src-tauri/src/models/types.rs`
- Modify: `src-tauri/src/commands/connection.rs`

- [ ] **Step 1: Write failing Rust tests for legacy flat storage compatibility**

Add tests in `src-tauri/src/commands/connection.rs` test module for a pure parsing helper:

```rust
#[test]
fn test_parse_connection_storage_accepts_legacy_array() {
    let json = r#"[{
        "id": "conn-1",
        "name": "Local",
        "host": "localhost",
        "port": 3306,
        "username": "root",
        "password": null,
        "database": null,
        "ssh": null
    }]"#;

    let storage = parse_connection_storage_json(json).expect("legacy array should parse");

    assert_eq!(storage.connections.len(), 1);
    assert_eq!(storage.connections[0].id.as_deref(), Some("conn-1"));
    assert!(storage.connections[0].group_id.is_none());
    assert!(storage.groups.is_empty());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:rust -- test_parse_connection_storage_accepts_legacy_array`

Expected: FAIL because `parse_connection_storage_json`, grouped payload, and `group_id` do not exist.

- [ ] **Step 3: Implement minimal storage types and parser**

In `src-tauri/src/models/types.rs`, add:

```rust
#[serde(default)]
pub group_id: Option<String>,
```

to `ConnectionConfig`, and include it in `Debug`.

Add:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConnectionGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub collapsed: bool,
}
```

In `src-tauri/src/commands/connection.rs`, add an internal payload:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConnectionStorageData {
    #[serde(default)]
    connections: Vec<ConnectionConfig>,
    #[serde(default)]
    groups: Vec<ConnectionGroup>,
}

fn parse_connection_storage_json(content: &str) -> Result<ConnectionStorageData, String> {
    if let Ok(connections) = serde_json::from_str::<Vec<ConnectionConfig>>(content) {
        return Ok(ConnectionStorageData {
            connections,
            groups: Vec::new(),
        });
    }
    serde_json::from_str::<ConnectionStorageData>(content)
        .map_err(|e| format!("解析配置失败: {}", e))
}
```

Update the internal load/save helpers to read and write `ConnectionStorageData`, while existing public connection APIs keep returning `Vec<ConnectionConfig>`.

- [ ] **Step 4: Run Rust test to verify it passes**

Run: `npm run test:rust -- test_parse_connection_storage_accepts_legacy_array`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/models/types.rs src-tauri/src/commands/connection.rs
git commit -m "支持连接分组存储兼容读取"
```

### Task 2: Rust Group Commands

**Files:**
- Modify: `src-tauri/src/commands/connection.rs`
- Modify: command registration file if needed

- [ ] **Step 1: Write failing Rust tests for group lifecycle**

Add tests for pure helpers:

```rust
#[test]
fn test_delete_group_keeps_connections_and_moves_them_to_ungrouped() {
    let mut storage = ConnectionStorageData {
        groups: vec![ConnectionGroup {
            id: "group-1".to_string(),
            name: "Dev".to_string(),
            collapsed: false,
        }],
        connections: vec![ConnectionConfig {
            id: Some("conn-1".to_string()),
            name: "Local".to_string(),
            host: "localhost".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: None,
            database: None,
            ssh: None,
            ssl_mode: None,
            ssl_ca_path: None,
            ssl_pkcs12_path: None,
            ssl_pkcs12_password: None,
            ssl_tls_hostname: None,
            client_charset: None,
            session_init_commands: None,
            read_only: None,
            skip_dangerous_sql_confirm: None,
            group_id: Some("group-1".to_string()),
        }],
    };

    delete_group_from_storage(&mut storage, "group-1").expect("group should delete");

    assert!(storage.groups.is_empty());
    assert_eq!(storage.connections.len(), 1);
    assert!(storage.connections[0].group_id.is_none());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:rust -- test_delete_group_keeps_connections_and_moves_them_to_ungrouped`

Expected: FAIL because helper and commands do not exist.

- [ ] **Step 3: Implement group helpers and commands**

Add pure helpers: `create_group_in_storage`, `rename_group_in_storage`, `delete_group_from_storage`, `set_group_collapsed_in_storage`, and `move_connection_to_group_in_storage`.

Expose Tauri commands:

```rust
#[tauri::command]
pub async fn list_connection_groups(app: AppHandle) -> Result<Vec<ConnectionGroup>, String>

#[tauri::command]
pub async fn create_connection_group(app: AppHandle, name: String) -> Result<ConnectionGroup, String>

#[tauri::command]
pub async fn rename_connection_group(app: AppHandle, id: String, name: String) -> Result<(), String>

#[tauri::command]
pub async fn delete_connection_group(app: AppHandle, id: String) -> Result<(), String>

#[tauri::command]
pub async fn set_connection_group_collapsed(app: AppHandle, id: String, collapsed: bool) -> Result<(), String>

#[tauri::command]
pub async fn move_connection_to_group(
    app: AppHandle,
    connection_id: String,
    group_id: Option<String>,
    ordered_ids: Vec<String>,
) -> Result<(), String>
```

Each mutating command loads storage, applies the helper, saves storage, and returns a clear error for empty names or unknown IDs.

- [ ] **Step 4: Run focused Rust tests**

Run: `npm run test:rust -- connection::tests`

Expected: PASS for connection command tests.

- [ ] **Step 5: Register commands and run compile check**

Run: `npm run test:rust --no-run`

Expected: PASS; all commands compile.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands/connection.rs src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "新增连接分组后端命令"
```

### Task 3: Frontend API, Types, And Store

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/services/tauriCommands.ts`
- Modify: `src/stores/connectionStore.ts`
- Modify: `src/__tests__/connectionStore.test.ts`

- [ ] **Step 1: Write failing store tests**

Add mocks for group APIs in `src/__tests__/connectionStore.test.ts`:

```ts
listConnectionGroups: vi.fn(),
createConnectionGroup: vi.fn(),
renameConnectionGroup: vi.fn(),
deleteConnectionGroup: vi.fn(),
setConnectionGroupCollapsed: vi.fn(),
moveConnectionToGroup: vi.fn(),
```

Add test:

```ts
it("删除分组后应刷新分组和连接列表", async () => {
  mockApi.deleteConnectionGroup.mockResolvedValue(undefined);
  mockApi.listConnectionGroups.mockResolvedValue([]);
  mockApi.listSavedConnections.mockResolvedValue([
    { id: "conn-1", name: "Local", host: "localhost", port: 3306, username: "root" },
  ]);

  await useConnectionStore.getState().deleteConnectionGroup("group-1");

  expect(mockApi.deleteConnectionGroup).toHaveBeenCalledWith("group-1");
  expect(useConnectionStore.getState().connectionGroups).toEqual([]);
  expect(useConnectionStore.getState().savedConnections).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/connectionStore.test.ts --run`

Expected: FAIL because group fields/actions do not exist.

- [ ] **Step 3: Implement types, command wrappers, and store actions**

Add to `src/types/index.ts`:

```ts
export interface ConnectionGroup {
  id: string;
  name: string;
  collapsed?: boolean;
}
```

Add `group_id?: string` to `ConnectionConfig`.

Add wrappers in `src/services/tauriCommands.ts`:

```ts
export async function listConnectionGroups(): Promise<ConnectionGroup[]> {
  return invoke<ConnectionGroup[]>("list_connection_groups");
}
```

Repeat for create, rename, delete, collapse, and move.

Add store state and actions in `connectionStore.ts`, with each mutating action setting `loading`, clearing `error`, invoking API, and refreshing the affected lists.

- [ ] **Step 4: Run store tests**

Run: `npm test -- src/__tests__/connectionStore.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types/index.ts src/services/tauriCommands.ts src/stores/connectionStore.ts src/__tests__/connectionStore.test.ts
git commit -m "接入连接分组前端状态"
```

### Task 4: Grouping And Drag Utility

**Files:**
- Create: `src/utils/connectionGroups.ts`
- Create: `src/__tests__/connectionGroups.test.ts`

- [ ] **Step 1: Write failing pure utility tests**

Create tests:

```ts
import { describe, expect, it } from "vitest";
import { UNGROUPED_GROUP_ID, groupConnections, moveConnectionInGroups } from "../utils/connectionGroups";

describe("connectionGroups", () => {
  it("按 group_id 分组并保留未分组顺序", () => {
    const result = groupConnections(
      [{ id: "g1", name: "Dev" }],
      [
        { id: "c1", name: "A", host: "h", port: 3306, username: "u" },
        { id: "c2", name: "B", host: "h", port: 3306, username: "u", group_id: "g1" },
      ]
    );

    expect(result[0].id).toBe(UNGROUPED_GROUP_ID);
    expect(result[0].connections.map((c) => c.id)).toEqual(["c1"]);
    expect(result[1].connections.map((c) => c.id)).toEqual(["c2"]);
  });

  it("跨组移动连接并返回目标 group_id 与全局顺序", () => {
    const result = moveConnectionInGroups({
      activeConnectionId: "c1",
      overId: "group:g1",
      groups: [
        { id: "__ungrouped", name: "未分组", connections: [{ id: "c1", name: "A", host: "h", port: 3306, username: "u" }] },
        { id: "g1", name: "Dev", connections: [] },
      ],
    });

    expect(result).toEqual({
      connectionId: "c1",
      groupId: "g1",
      orderedIds: ["c1"],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/__tests__/connectionGroups.test.ts --run`

Expected: FAIL because utility does not exist.

- [ ] **Step 3: Implement utility**

Implement:

```ts
export const UNGROUPED_GROUP_ID = "__ungrouped";

export interface ConnectionGroupView {
  id: string;
  name: string;
  collapsed?: boolean;
  connections: ConnectionConfig[];
  system?: boolean;
}
```

Add `groupConnections(groups, connections)` and `moveConnectionInGroups(input)` with no DOM dependency.

- [ ] **Step 4: Run utility tests**

Run: `npm test -- src/__tests__/connectionGroups.test.ts --run`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/utils/connectionGroups.ts src/__tests__/connectionGroups.test.ts
git commit -m "新增连接分组拖拽逻辑"
```

### Task 5: Grouped Connection List UI

**Files:**
- Modify: `src/components/connection/ConnectionList.tsx`
- Create or modify: `src/__tests__/ConnectionListGroups.test.tsx`

- [ ] **Step 1: Write failing UI tests**

Create a render test that mocks `useConnectionStore` state and verifies:

```ts
expect(screen.getByText("未分组")).toBeInTheDocument();
expect(screen.getByText("开发库")).toBeInTheDocument();
expect(screen.getByText("新建分组")).toBeInTheDocument();
```

Add an action test for delete group:

```ts
await user.click(screen.getByLabelText("删除分组 开发库"));
await user.click(screen.getByText("删除"));
expect(deleteConnectionGroup).toHaveBeenCalledWith("group-1");
```

- [ ] **Step 2: Run UI tests to verify they fail**

Run: `npm test -- src/__tests__/ConnectionListGroups.test.tsx --run`

Expected: FAIL because grouped UI does not exist.

- [ ] **Step 3: Implement grouped UI**

In `ConnectionList.tsx`:

- Load groups with connections on mount.
- Render title actions: “新建” and “新建分组”.
- Add modal or inline prompt using Ant Design `Modal` + `Input` for create/rename.
- Render grouped sections using `groupConnections`.
- Keep existing `SortableConnectionItem` connection behavior.
- Use `DndContext` with droppable group headers/empty areas and call `moveConnectionToGroup` for cross-group moves or `reorderConnections` for same-group reorder.
- Add accessible labels for group rename/delete buttons.

- [ ] **Step 4: Run UI tests**

Run: `npm test -- src/__tests__/ConnectionListGroups.test.tsx --run`

Expected: PASS.

- [ ] **Step 5: Run focused frontend tests**

Run: `npm test -- src/__tests__/connectionGroups.test.ts src/__tests__/connectionStore.test.ts src/__tests__/ConnectionListGroups.test.tsx --run`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/connection/ConnectionList.tsx src/__tests__/ConnectionListGroups.test.tsx
git commit -m "实现连接列表分组界面"
```

### Task 6: Final Verification

**Files:**
- No new implementation files unless verification reveals defects.

- [ ] **Step 1: Run frontend build**

Run: `npm run build`

Expected: TypeScript and Vite build PASS.

- [ ] **Step 2: Run Rust tests**

Run: `npm run test:rust`

Expected: PASS.

- [ ] **Step 3: Run focused frontend tests**

Run: `npm test -- src/__tests__/connectionGroups.test.ts src/__tests__/connectionStore.test.ts src/__tests__/ConnectionListGroups.test.tsx --run`

Expected: PASS.

- [ ] **Step 4: Commit any verification fixes**

If fixes were required:

```bash
git add <changed-files>
git commit -m "修复连接分组验证问题"
```

If no fixes were required, do not create an empty commit.

## Self-Review

- Spec coverage: group creation, collapse, rename, delete, delete-keeps-connections, ungrouped fallback, cross-group drag, same-group order, legacy compatibility, and tests are all mapped to tasks.
- Placeholder scan: no deferred implementation placeholders remain.
- Type consistency: Rust uses `group_id` for serde compatibility with TypeScript `ConnectionConfig.group_id`; frontend pseudo group ID is `__ungrouped` and is converted to empty `group_id` before persistence.
