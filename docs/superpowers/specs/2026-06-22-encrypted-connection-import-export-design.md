# 连接导入导出加密设计

## 背景

当前连接导出会把已保存的连接和分组写入迁移 JSON，内容包含 MySQL 密码、SSH 密码和 PKCS#12 密码等敏感信息。应用本地连接存储已经使用系统钥匙串密钥加密，但导出的迁移文件需要独立保护，并且要能跨机器导入。

## 目标

本次改动让连接导入导出都必须输入用户提供的迁移密码：

- 导出时输入密码和确认密码。
- 导出文件内容使用该密码加密。
- 导入时输入密码，只有解密成功后才执行导入。
- 密码错误、文件损坏或格式不匹配时导入失败，不修改现有连接。
- 继续保留现有导入语义：导入连接和分组会生成新 ID，并合并到现有列表，不覆盖旧数据。

## 非目标

- 不改变应用本地 `connections.json` 的系统钥匙串加密方式。
- 不实现密码找回；迁移密码丢失后导出文件不可恢复。
- 不在数据库循环遍历中增加 SQL 查询。

## 后端设计

连接迁移文件改为独立加密格式：

```json
{
  "format": "mysql-connect.connections.encrypted",
  "version": 2,
  "kdf": "pbkdf2-sha256",
  "iterations": 100000,
  "salt": "base64...",
  "nonce": "base64...",
  "data": "base64..."
}
```

后端继续复用现有连接迁移明文结构作为加密前载荷：

```json
{
  "format": "mysql-connect.connections",
  "version": 1,
  "connections": [],
  "groups": []
}
```

新增密码派生加密逻辑：

- 使用用户输入密码、随机 salt 和 PBKDF2-SHA256 派生 32 字节密钥。
- 使用 AES-256-GCM 加密明文迁移 JSON。
- 每次导出生成新的 salt 和 nonce。
- 解密失败统一返回“解密失败：密码错误或导入文件已损坏”一类错误。

`export_connections` 和 `import_connections` 命令增加 `password: String` 参数。后端校验密码不能为空或全空白。导入流程先完整读取文件并解密为迁移 JSON，解析成功后才加载并写回本地连接存储，避免密码错误时产生部分写入。

## 前端设计

`ConnectionList` 保留标题栏导入、导出图标入口。

导出流程：

1. 点击导出。
2. 弹出密码输入对话框，包含“导出密码”和“确认密码”两个密码框。
3. 密码为空或两次不一致时提示并阻止继续。
4. 密码通过校验后打开保存文件对话框。
5. 调用 `exportConnections(path, password)`。

导入流程：

1. 点击导入。
2. 先选择导入文件。
3. 选择文件后弹出密码输入对话框。
4. 密码为空时阻止继续。
5. 调用 `importConnections(path, password)`。
6. 导入成功后刷新连接和分组列表。

错误提示沿用现有 `message.error` 入口。前端不保存迁移密码，不写入 store，不在日志中输出密码。

## API 与状态

TypeScript API 调整：

- `exportConnections(path: string, password: string): Promise<number>`
- `importConnections(path: string, password: string): Promise<ConnectionImportResult>`

`connectionStore` action 同步增加 `password` 参数，并继续负责 loading/error 状态和导入成功后的列表刷新。

## 兼容性

新导出文件使用加密格式。导入只接受新加密格式，避免继续支持明文迁移文件造成误导。旧应用无法导入新加密文件；新应用在密码正确时可以跨机器导入。

## 测试

Rust 测试：

- 导出加密内容不包含明文连接密码。
- 正确密码可以解密并导入连接和分组。
- 错误密码导入失败且不修改现有 storage。
- 空密码导出或导入失败。

前端测试：

- store 导出时把 `path` 和 `password` 传给 API。
- store 导入时把 `path` 和 `password` 传给 API，并在成功后刷新连接和分组。
- UI 导出密码确认不一致时不调用保存文件对话框和导出 action。
- UI 导入密码为空时不调用导入 action。

## 验证

实现完成后运行：

- `npm test -- src/__tests__/connectionStore.test.ts src/__tests__/ConnectionListGroups.test.tsx`
- `npm run test:rust -- connection`

