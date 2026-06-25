# Encrypted Connection Import Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a user-entered migration password for saved connection export/import, encrypt exported connection files with that password, and decrypt with the same password before import.

**Architecture:** Keep local saved connection storage unchanged and add an encrypted transfer envelope only around exported migration files. The Rust command layer owns encryption/decryption and file I/O; React collects the password and passes it through existing Tauri wrappers and Zustand actions without storing it.

**Tech Stack:** Tauri Rust commands, AES-256-GCM, PBKDF2-SHA256, serde JSON, React 18, Zustand, Ant Design, Vitest, Cargo tests.

---

## File Structure

- Modify `src-tauri/Cargo.toml`: add direct `pbkdf2` and `sha2` dependencies already present in `Cargo.lock` through transitive crates.
- Modify `src-tauri/src/commands/connection.rs`: add encrypted transfer envelope structs, password validation, PBKDF2 key derivation, AES-GCM encrypt/decrypt helpers, password-aware import/export commands, and Rust tests.
- Modify `src/services/tauriCommands.ts`: add `password` argument to `exportConnections` and `importConnections`.
- Modify `src/stores/connectionStore.ts`: add `password` argument to the store actions and pass it to the API layer.
- Modify `src/__tests__/connectionStore.test.ts`: update import/export store tests for password forwarding.
- Modify `src/components/connection/ConnectionList.tsx`: replace the current export warning confirm with a password modal and add an import password modal after file selection.
- Modify `src/__tests__/ConnectionListGroups.test.tsx`: add UI tests for password validation and API calls.

### Task 1: Rust Encrypted Transfer Helpers

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/commands/connection.rs`

- [ ] **Step 1: Write failing Rust tests for encrypted transfer round trip**

Add these tests inside the existing `#[cfg(test)] mod tests` in `src-tauri/src/commands/connection.rs`:

```rust
#[test]
fn test_export_connection_storage_encrypted_json_hides_plaintext_and_decrypts() {
    let storage = ConnectionStorageData {
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
            password: Some("secret".to_string()),
            database: None,
            ssh: None,
            ssl_mode: None,
            ssl_ca_path: None,
            ssl_pkcs12_path: None,
            ssl_tls_hostname: None,
            ssl_pkcs12_password: None,
            client_charset: None,
            session_init_commands: None,
            read_only: None,
            skip_dangerous_sql_confirm: None,
            group_id: Some("group-1".to_string()),
        }],
    };

    let encrypted =
        export_connection_storage_encrypted_json(&storage, "迁移密码").expect("export should encrypt");

    assert!(encrypted.contains("\"format\": \"mysql-connect.connections.encrypted\""));
    assert!(!encrypted.contains("\"password\": \"secret\""));
    assert!(!encrypted.contains("Local"));
    assert!(!encrypted.contains("Dev"));

    let decrypted =
        decrypt_connection_transfer_json(&encrypted, "迁移密码").expect("password should decrypt");
    let parsed = parse_connection_transfer_json(&decrypted).expect("decrypted JSON should parse");

    assert_eq!(parsed.connections.len(), 1);
    assert_eq!(parsed.groups.len(), 1);
    assert_eq!(parsed.connections[0].password.as_deref(), Some("secret"));
    assert_eq!(parsed.connections[0].group_id.as_deref(), Some("group-1"));
}

#[test]
fn test_decrypt_connection_transfer_json_rejects_wrong_password() {
    let storage = ConnectionStorageData {
        groups: vec![],
        connections: vec![ConnectionConfig {
            id: Some("conn-1".to_string()),
            name: "Local".to_string(),
            host: "localhost".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: Some("secret".to_string()),
            database: None,
            ssh: None,
            ssl_mode: None,
            ssl_ca_path: None,
            ssl_pkcs12_path: None,
            ssl_tls_hostname: None,
            ssl_pkcs12_password: None,
            client_charset: None,
            session_init_commands: None,
            read_only: None,
            skip_dangerous_sql_confirm: None,
            group_id: None,
        }],
    };

    let encrypted =
        export_connection_storage_encrypted_json(&storage, "correct-password").unwrap();
    let err = decrypt_connection_transfer_json(&encrypted, "wrong-password")
        .expect_err("wrong password should fail");

    assert_eq!(err, "解密失败：密码错误或导入文件已损坏");
}

#[test]
fn test_export_connection_storage_encrypted_json_rejects_empty_password() {
    let storage = ConnectionStorageData {
        groups: vec![],
        connections: vec![],
    };

    let err = export_connection_storage_encrypted_json(&storage, "   ")
        .expect_err("empty password should fail");

    assert_eq!(err, "导入导出密码不能为空");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:rust -- test_export_connection_storage_encrypted_json_hides_plaintext_and_decrypts
```

Expected: FAIL with missing `export_connection_storage_encrypted_json` and `decrypt_connection_transfer_json` functions.

- [ ] **Step 3: Add direct Rust dependencies**

In `src-tauri/Cargo.toml`, add these dependencies under `[dependencies]`:

```toml
pbkdf2 = "0.12"
sha2 = "0.10"
```

- [ ] **Step 4: Implement encrypted transfer helpers**

In `src-tauri/src/commands/connection.rs`, extend imports:

```rust
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use pbkdf2::pbkdf2_hmac;
use rand_core::RngCore;
use sha2::Sha256;
```

Add constants near the existing export constants:

```rust
const CONNECTION_EXPORT_ENCRYPTED_FORMAT: &str = "mysql-connect.connections.encrypted";
const CONNECTION_EXPORT_ENCRYPTED_VERSION: u32 = 2;
const CONNECTION_EXPORT_KDF: &str = "pbkdf2-sha256";
const CONNECTION_EXPORT_KDF_ITERATIONS: u32 = 100_000;
const CONNECTION_EXPORT_SALT_SIZE: usize = 16;
const CONNECTION_EXPORT_NONCE_SIZE: usize = 12;
const CONNECTION_EXPORT_KEY_SIZE: usize = 32;
```

Add the encrypted envelope struct after `ConnectionTransferFile`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncryptedConnectionTransferFile {
    format: String,
    version: u32,
    kdf: String,
    iterations: u32,
    salt: String,
    nonce: String,
    data: String,
}
```

Add helper functions after `export_connection_storage_json`:

```rust
fn validate_transfer_password(password: &str) -> Result<&str, String> {
    if password.trim().is_empty() {
        return Err("导入导出密码不能为空".to_string());
    }
    Ok(password)
}

fn derive_transfer_key(
    password: &str,
    salt: &[u8],
    iterations: u32,
) -> Result<[u8; CONNECTION_EXPORT_KEY_SIZE], String> {
    if iterations == 0 {
        return Err("导入文件加密参数无效".to_string());
    }
    let mut key = [0u8; CONNECTION_EXPORT_KEY_SIZE];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt, iterations, &mut key);
    Ok(key)
}

fn export_connection_storage_encrypted_json(
    storage: &ConnectionStorageData,
    password: &str,
) -> Result<String, String> {
    let password = validate_transfer_password(password)?;
    let plaintext = export_connection_storage_json(storage)?;

    let mut salt = [0u8; CONNECTION_EXPORT_SALT_SIZE];
    rand_core::OsRng.fill_bytes(&mut salt);
    let key = derive_transfer_key(password, &salt, CONNECTION_EXPORT_KDF_ITERATIONS)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("创建导出加密器失败: {}", e))?;

    let mut nonce = [0u8; CONNECTION_EXPORT_NONCE_SIZE];
    rand_core::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
        .map_err(|e| format!("导出加密失败: {}", e))?;

    let encrypted = EncryptedConnectionTransferFile {
        format: CONNECTION_EXPORT_ENCRYPTED_FORMAT.to_string(),
        version: CONNECTION_EXPORT_ENCRYPTED_VERSION,
        kdf: CONNECTION_EXPORT_KDF.to_string(),
        iterations: CONNECTION_EXPORT_KDF_ITERATIONS,
        salt: BASE64.encode(salt),
        nonce: BASE64.encode(nonce),
        data: BASE64.encode(ciphertext),
    };

    serde_json::to_string_pretty(&encrypted).map_err(|e| format!("序列化导出文件失败: {}", e))
}

fn decrypt_connection_transfer_json(content: &str, password: &str) -> Result<String, String> {
    let password = validate_transfer_password(password)?;
    let envelope = serde_json::from_str::<EncryptedConnectionTransferFile>(content)
        .map_err(|_| "导入文件格式不正确或未加密".to_string())?;

    if envelope.format != CONNECTION_EXPORT_ENCRYPTED_FORMAT {
        return Err("导入文件格式不正确".to_string());
    }
    if envelope.version > CONNECTION_EXPORT_ENCRYPTED_VERSION {
        return Err("导入文件版本过高，请升级应用后重试".to_string());
    }
    if envelope.kdf != CONNECTION_EXPORT_KDF {
        return Err("导入文件加密参数不受支持".to_string());
    }

    let salt = BASE64
        .decode(envelope.salt)
        .map_err(|_| "导入文件加密参数无效".to_string())?;
    let nonce = BASE64
        .decode(envelope.nonce)
        .map_err(|_| "导入文件加密参数无效".to_string())?;
    let ciphertext = BASE64
        .decode(envelope.data)
        .map_err(|_| "导入文件加密参数无效".to_string())?;
    if nonce.len() != CONNECTION_EXPORT_NONCE_SIZE {
        return Err("导入文件加密参数无效".to_string());
    }

    let key = derive_transfer_key(password, &salt, envelope.iterations)?;
    let cipher =
        Aes256Gcm::new_from_slice(&key).map_err(|e| format!("创建导入解密器失败: {}", e))?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| "解密失败：密码错误或导入文件已损坏".to_string())?;

    String::from_utf8(plaintext).map_err(|_| "解密后的导入文件编码无效".to_string())
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run:

```bash
npm run test:rust -- test_export_connection_storage_encrypted_json_hides_plaintext_and_decrypts
npm run test:rust -- test_decrypt_connection_transfer_json_rejects_wrong_password
npm run test:rust -- test_export_connection_storage_encrypted_json_rejects_empty_password
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands/connection.rs
git commit -m "添加连接导出文件加密能力"
```

### Task 2: Rust Import Export Commands Require Password

**Files:**
- Modify: `src-tauri/src/commands/connection.rs`

- [ ] **Step 1: Write failing Rust tests for encrypted import mutation behavior**

Add this test inside the existing Rust test module:

```rust
#[test]
fn test_import_encrypted_connection_storage_wrong_password_does_not_mutate_storage() {
    let mut storage = ConnectionStorageData {
        groups: vec![ConnectionGroup {
            id: "existing-group".to_string(),
            name: "Existing".to_string(),
            collapsed: false,
        }],
        connections: vec![ConnectionConfig {
            id: Some("existing-conn".to_string()),
            name: "Existing".to_string(),
            host: "127.0.0.1".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: None,
            database: None,
            ssh: None,
            ssl_mode: None,
            ssl_ca_path: None,
            ssl_pkcs12_path: None,
            ssl_tls_hostname: None,
            ssl_pkcs12_password: None,
            client_charset: None,
            session_init_commands: None,
            read_only: None,
            skip_dangerous_sql_confirm: None,
            group_id: Some("existing-group".to_string()),
        }],
    };
    let import_storage = ConnectionStorageData {
        groups: vec![ConnectionGroup {
            id: "import-group".to_string(),
            name: "Imported".to_string(),
            collapsed: true,
        }],
        connections: vec![ConnectionConfig {
            id: Some("import-conn".to_string()),
            name: "Imported Local".to_string(),
            host: "localhost".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: Some("secret".to_string()),
            database: None,
            ssh: None,
            ssl_mode: None,
            ssl_ca_path: None,
            ssl_pkcs12_path: None,
            ssl_tls_hostname: None,
            ssl_pkcs12_password: None,
            client_charset: None,
            session_init_commands: None,
            read_only: None,
            skip_dangerous_sql_confirm: None,
            group_id: Some("import-group".to_string()),
        }],
    };
    let encrypted =
        export_connection_storage_encrypted_json(&import_storage, "correct-password").unwrap();

    let err = import_encrypted_connection_storage_json(
        &mut storage,
        &encrypted,
        "wrong-password",
    )
    .expect_err("wrong password should fail");

    assert_eq!(err, "解密失败：密码错误或导入文件已损坏");
    assert_eq!(storage.groups.len(), 1);
    assert_eq!(storage.connections.len(), 1);
    assert_eq!(storage.groups[0].id, "existing-group");
    assert_eq!(storage.connections[0].id.as_deref(), Some("existing-conn"));
}

#[test]
fn test_import_encrypted_connection_storage_merges_with_correct_password() {
    let mut storage = ConnectionStorageData {
        groups: vec![],
        connections: vec![],
    };
    let import_storage = ConnectionStorageData {
        groups: vec![ConnectionGroup {
            id: "import-group".to_string(),
            name: "Imported".to_string(),
            collapsed: true,
        }],
        connections: vec![ConnectionConfig {
            id: Some("import-conn".to_string()),
            name: "Imported Local".to_string(),
            host: "localhost".to_string(),
            port: 3306,
            username: "root".to_string(),
            password: Some("secret".to_string()),
            database: None,
            ssh: None,
            ssl_mode: None,
            ssl_ca_path: None,
            ssl_pkcs12_path: None,
            ssl_tls_hostname: None,
            ssl_pkcs12_password: None,
            client_charset: None,
            session_init_commands: None,
            read_only: None,
            skip_dangerous_sql_confirm: None,
            group_id: Some("import-group".to_string()),
        }],
    };
    let encrypted =
        export_connection_storage_encrypted_json(&import_storage, "correct-password").unwrap();

    let result = import_encrypted_connection_storage_json(
        &mut storage,
        &encrypted,
        "correct-password",
    )
    .expect("correct password should import");

    assert_eq!(result.imported_connections, 1);
    assert_eq!(result.imported_groups, 1);
    assert_eq!(storage.groups.len(), 1);
    assert_eq!(storage.connections.len(), 1);
    assert_ne!(storage.groups[0].id, "import-group");
    assert_ne!(storage.connections[0].id.as_deref(), Some("import-conn"));
    assert_eq!(
        storage.connections[0].group_id.as_deref(),
        Some(storage.groups[0].id.as_str())
    );
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm run test:rust -- test_import_encrypted_connection_storage_wrong_password_does_not_mutate_storage
```

Expected: FAIL with missing `import_encrypted_connection_storage_json`.

- [ ] **Step 3: Add encrypted import helper and update command signatures**

In `src-tauri/src/commands/connection.rs`, add:

```rust
fn import_encrypted_connection_storage_json(
    storage: &mut ConnectionStorageData,
    content: &str,
    password: &str,
) -> Result<ConnectionImportResult, String> {
    let decrypted = decrypt_connection_transfer_json(content, password)?;
    import_connection_storage_json(storage, &decrypted)
}
```

Update Tauri command signatures and bodies:

```rust
#[tauri::command]
pub async fn export_connections(
    app: AppHandle,
    path: String,
    password: String,
) -> Result<usize, String> {
    let storage = load_connection_storage_internal(&app)?;
    let content = export_connection_storage_encrypted_json(&storage, &password)?;
    let file_path = std::path::PathBuf::from(path);
    std::fs::write(&file_path, content).map_err(|e| format!("写入导出文件失败: {}", e))?;
    set_secure_file_permissions(&file_path)?;
    Ok(storage.connections.len())
}

#[tauri::command]
pub async fn import_connections(
    app: AppHandle,
    path: String,
    password: String,
) -> Result<ConnectionImportResult, String> {
    let content = std::fs::read_to_string(path).map_err(|e| format!("读取导入文件失败: {}", e))?;
    let mut storage = load_connection_storage_internal(&app)?;
    let result = import_encrypted_connection_storage_json(&mut storage, &content, &password)?;
    save_connection_storage_to_file(&app, &storage)?;
    Ok(result)
}
```

Do not change `parse_connection_storage_json`; it still needs to read legacy local storage. Do not call `import_connection_storage_json` directly from the command with raw file content.

- [ ] **Step 4: Run focused Rust tests**

Run:

```bash
npm run test:rust -- test_import_encrypted_connection_storage_wrong_password_does_not_mutate_storage
npm run test:rust -- test_import_encrypted_connection_storage_merges_with_correct_password
npm run test:rust -- connection::tests
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/connection.rs
git commit -m "要求连接导入导出提供迁移密码"
```

### Task 3: TypeScript API And Store Password Parameters

**Files:**
- Modify: `src/services/tauriCommands.ts`
- Modify: `src/stores/connectionStore.ts`
- Modify: `src/__tests__/connectionStore.test.ts`

- [ ] **Step 1: Write failing store tests for password forwarding**

In `src/__tests__/connectionStore.test.ts`, replace the two import/export expectations in `describe("import/export connections")` with password-aware tests:

```ts
it("导出连接时应该把路径和迁移密码传给后端并返回导出数量", async () => {
  mockApi.exportConnections.mockResolvedValue(2);

  const count = await useConnectionStore
    .getState()
    .exportConnections("/tmp/mysql-connect-connections.json", "迁移密码");

  expect(mockApi.exportConnections).toHaveBeenCalledWith(
    "/tmp/mysql-connect-connections.json",
    "迁移密码"
  );
  expect(count).toBe(2);
  expect(useConnectionStore.getState().loading).toBe(false);
});

it("导入连接时应该把路径和迁移密码传给后端并刷新连接和分组列表", async () => {
  const groups = [{ id: "group-1", name: "Imported" }];
  const connections = [
    {
      id: "conn-1",
      name: "Imported Local",
      host: "localhost",
      port: 3306,
      username: "root",
    },
  ];
  mockApi.importConnections.mockResolvedValue({
    imported_connections: 1,
    imported_groups: 1,
  });
  mockApi.listConnectionGroups.mockResolvedValue(groups);
  mockApi.listSavedConnections.mockResolvedValue(connections);

  const result = await useConnectionStore
    .getState()
    .importConnections("/tmp/mysql-connect-connections.json", "迁移密码");

  expect(mockApi.importConnections).toHaveBeenCalledWith(
    "/tmp/mysql-connect-connections.json",
    "迁移密码"
  );
  expect(result).toEqual({
    imported_connections: 1,
    imported_groups: 1,
  });
  expect(useConnectionStore.getState().connectionGroups).toEqual(groups);
  expect(useConnectionStore.getState().savedConnections).toEqual(connections);
  expect(useConnectionStore.getState().loading).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- src/__tests__/connectionStore.test.ts -t "import/export connections"
```

Expected: FAIL because store actions and API wrappers accept only `path`.

- [ ] **Step 3: Update TypeScript API wrappers**

In `src/services/tauriCommands.ts`, replace the two functions with:

```ts
/**
 * 导出所有保存的连接和分组到指定文件；内容使用迁移密码加密。
 */
export async function exportConnections(
  path: string,
  password: string
): Promise<number> {
  return invoke<number>("export_connections", { path, password });
}

/**
 * 从加密迁移文件导入连接和分组；后端会解密、合并并生成新 ID。
 */
export async function importConnections(
  path: string,
  password: string
): Promise<ConnectionImportResult> {
  return invoke<ConnectionImportResult>("import_connections", {
    path,
    password,
  });
}
```

- [ ] **Step 4: Update Zustand action types and implementations**

In `src/stores/connectionStore.ts`, update the interface:

```ts
/** 导出所有连接和分组到指定文件 */
exportConnections: (path: string, password: string) => Promise<number>;
/** 从指定文件导入连接和分组 */
importConnections: (
  path: string,
  password: string
) => Promise<ConnectionImportResult>;
```

Update implementations:

```ts
exportConnections: async (path: string, password: string) => {
  try {
    set({ loading: true, error: null });
    const count = await api.exportConnections(path, password);
    set({ loading: false });
    return count;
  } catch (e) {
    set({ error: String(e), loading: false });
    throw e;
  }
},

importConnections: async (path: string, password: string) => {
  try {
    set({ loading: true, error: null });
    const result = await api.importConnections(path, password);
    const [groups, connections] = await Promise.all([
      api.listConnectionGroups(),
      api.listSavedConnections(),
    ]);
    set({
      connectionGroups: groups,
      savedConnections: connections,
      loading: false,
    });
    return result;
  } catch (e) {
    set({ error: String(e), loading: false });
    throw e;
  }
},
```

- [ ] **Step 5: Run store tests**

Run:

```bash
npm test -- src/__tests__/connectionStore.test.ts -t "import/export connections"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/tauriCommands.ts src/stores/connectionStore.ts src/__tests__/connectionStore.test.ts
git commit -m "前端连接导入导出传递迁移密码"
```

### Task 4: Connection List Password Modal UI

**Files:**
- Modify: `src/components/connection/ConnectionList.tsx`
- Modify: `src/__tests__/ConnectionListGroups.test.tsx`

- [ ] **Step 1: Write failing UI tests for export and import password validation**

Add tests to `src/__tests__/ConnectionListGroups.test.tsx`:

```tsx
it("导出连接时密码确认不一致不打开保存对话框", async () => {
  render(<ConnectionList />);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "导出连接" }));
  });

  fireEvent.change(await screen.findByLabelText("导出密码"), {
    target: { value: "one-password" },
  });
  fireEvent.change(screen.getByLabelText("确认密码"), {
    target: { value: "another-password" },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
  });

  expect(save).not.toHaveBeenCalled();
  expect(api.exportConnections).not.toHaveBeenCalled();
});

it("导出连接时输入一致密码后选择文件并调用导出", async () => {
  vi.mocked(save).mockResolvedValue("/tmp/mysql-connect-connections.json");
  vi.mocked(api.exportConnections).mockResolvedValue(2);

  render(<ConnectionList />);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "导出连接" }));
  });

  fireEvent.change(await screen.findByLabelText("导出密码"), {
    target: { value: "迁移密码" },
  });
  fireEvent.change(screen.getByLabelText("确认密码"), {
    target: { value: "迁移密码" },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "导出" }));
  });

  await waitFor(() => {
    expect(api.exportConnections).toHaveBeenCalledWith(
      "/tmp/mysql-connect-connections.json",
      "迁移密码"
    );
  });
});

it("导入连接时未输入密码不调用导入", async () => {
  vi.mocked(open).mockResolvedValue("/tmp/mysql-connect-connections.json");

  render(<ConnectionList />);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "导入连接" }));
  });

  await screen.findByLabelText("导入密码");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
  });

  expect(api.importConnections).not.toHaveBeenCalled();
});

it("导入连接时输入密码后调用导入并刷新", async () => {
  vi.mocked(open).mockResolvedValue("/tmp/mysql-connect-connections.json");
  vi.mocked(api.importConnections).mockResolvedValue({
    imported_connections: 1,
    imported_groups: 1,
  });

  render(<ConnectionList />);

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "导入连接" }));
  });

  fireEvent.change(await screen.findByLabelText("导入密码"), {
    target: { value: "迁移密码" },
  });

  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
  });

  await waitFor(() => {
    expect(api.importConnections).toHaveBeenCalledWith(
      "/tmp/mysql-connect-connections.json",
      "迁移密码"
    );
  });
});
```

- [ ] **Step 2: Run UI tests to verify they fail**

Run:

```bash
npm test -- src/__tests__/ConnectionListGroups.test.tsx -t "导出连接时密码确认不一致|导入连接时未输入密码"
```

Expected: FAIL because `ConnectionList` still uses the old direct import/export flow.

- [ ] **Step 3: Add modal state and reset helper**

In `src/components/connection/ConnectionList.tsx`, add this type near the helper functions:

```ts
type ConnectionTransferMode = "export" | "import";
```

Inside `ConnectionList`, add state after the existing group state:

```ts
const [transferModalMode, setTransferModalMode] =
  useState<ConnectionTransferMode | null>(null);
const [transferImportPath, setTransferImportPath] = useState<string | null>(
  null
);
const [transferPassword, setTransferPassword] = useState("");
const [transferPasswordConfirm, setTransferPasswordConfirm] = useState("");
```

Add a reset helper:

```ts
const resetTransferModal = () => {
  setTransferModalMode(null);
  setTransferImportPath(null);
  setTransferPassword("");
  setTransferPasswordConfirm("");
};
```

- [ ] **Step 4: Replace export/import handlers with password-aware flow**

Replace `handleExportConnections` and `handleImportConnections` with:

```ts
const handleExportConnections = () => {
  setTransferModalMode("export");
  setTransferImportPath(null);
  setTransferPassword("");
  setTransferPasswordConfirm("");
};

const handleImportConnections = async () => {
  try {
    const chosen = await open({
      title: "导入连接",
      multiple: false,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    const path = Array.isArray(chosen) ? chosen[0] : chosen;
    if (!path) return;
    setTransferImportPath(path);
    setTransferModalMode("import");
    setTransferPassword("");
    setTransferPasswordConfirm("");
  } catch (e) {
    message.error(`导入失败：${String(e)}`);
  }
};

const handleConfirmTransfer = async () => {
  const password = transferPassword;
  if (!password.trim()) {
    message.error("请输入导入导出密码");
    return;
  }
  if (transferModalMode === "export" && password !== transferPasswordConfirm) {
    message.error("两次输入的密码不一致");
    return;
  }

  try {
    if (transferModalMode === "export") {
      const path = await save({
        title: "导出连接",
        defaultPath: "mysql-connect-connections.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      const count = await exportConnections(path, password);
      message.success(`已导出 ${count} 个连接`);
      resetTransferModal();
      return;
    }

    if (transferModalMode === "import" && transferImportPath) {
      const result = await importConnections(transferImportPath, password);
      message.success(
        `已导入 ${result.imported_connections} 个连接、${result.imported_groups} 个分组`
      );
      resetTransferModal();
    }
  } catch (e) {
    message.error(
      `${transferModalMode === "export" ? "导出" : "导入"}失败：${String(e)}`
    );
  }
};
```

- [ ] **Step 5: Render password modal**

Add this JSX near the existing group modal JSX in `ConnectionList`:

```tsx
<Modal
  title={transferModalMode === "export" ? "设置导出密码" : "输入导入密码"}
  open={transferModalMode !== null}
  okText={transferModalMode === "export" ? "导出" : "导入"}
  cancelText="取消"
  onOk={() => void handleConfirmTransfer()}
  onCancel={resetTransferModal}
  destroyOnClose
>
  <Space direction="vertical" style={{ width: "100%" }}>
    <Text type="secondary">
      {transferModalMode === "export"
        ? "导出文件将使用此密码加密。请妥善保存密码，丢失后无法恢复。"
        : "请输入导出时设置的密码，密码正确后才会导入连接。"}
    </Text>
    <Input.Password
      aria-label={transferModalMode === "export" ? "导出密码" : "导入密码"}
      placeholder={transferModalMode === "export" ? "导出密码" : "导入密码"}
      value={transferPassword}
      onChange={(event) => setTransferPassword(event.target.value)}
      autoFocus
    />
    {transferModalMode === "export" && (
      <Input.Password
        aria-label="确认密码"
        placeholder="确认密码"
        value={transferPasswordConfirm}
        onChange={(event) => setTransferPasswordConfirm(event.target.value)}
      />
    )}
  </Space>
</Modal>
```

Keep the existing import/export icon buttons and update only their click handlers.

- [ ] **Step 6: Run UI tests**

Run:

```bash
npm test -- src/__tests__/ConnectionListGroups.test.tsx -t "导出连接时密码确认不一致|导出连接时输入一致密码|导入连接时未输入密码|导入连接时输入密码"
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/connection/ConnectionList.tsx src/__tests__/ConnectionListGroups.test.tsx
git commit -m "添加连接导入导出密码输入界面"
```

### Task 5: Full Verification And Cleanup

**Files:**
- Inspect: `src-tauri/src/commands/connection.rs`
- Inspect: `src/components/connection/ConnectionList.tsx`
- Inspect: `src/services/tauriCommands.ts`
- Inspect: `src/stores/connectionStore.ts`

- [ ] **Step 1: Search for old import/export call signatures**

Run:

```bash
rg -n "exportConnections\\([^,\\n]+\\)|importConnections\\([^,\\n]+\\)|export_connections\"|import_connections\"" src src-tauri
```

Expected: all TypeScript call sites pass both `path` and `password`; Rust commands accept `password`.

- [ ] **Step 2: Run focused frontend tests**

Run:

```bash
npm test -- src/__tests__/connectionStore.test.ts src/__tests__/ConnectionListGroups.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run focused Rust tests**

Run:

```bash
npm run test:rust -- connection
```

Expected: PASS.

- [ ] **Step 4: Run typecheck build**

Run:

```bash
npm run build
```

Expected: PASS without TypeScript or Vite build errors.

- [ ] **Step 5: Review final diff**

Run:

```bash
git diff --stat HEAD
git diff --check
git status --short
```

Expected: no whitespace errors; only intended files changed since the previous commit.

- [ ] **Step 6: Commit verification cleanup if needed**

If Task 5 finds and fixes any cleanup issue, commit it:

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands/connection.rs src/services/tauriCommands.ts src/stores/connectionStore.ts src/__tests__/connectionStore.test.ts src/components/connection/ConnectionList.tsx src/__tests__/ConnectionListGroups.test.tsx
git commit -m "完善连接迁移加密验证"
```

If no cleanup changes are needed, do not create an empty commit.

