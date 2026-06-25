# 连接分组功能设计

## 背景

当前连接列表按一个扁平数组展示，支持通过拖拽调整连接顺序。用户需要把数据库连接放入不同分组中管理，并能在列表内直接创建、折叠、重命名、删除分组。

## 范围

本次实现连接列表的一层分组能力：

- 连接列表顶部提供“新建分组”入口。
- 自定义分组可折叠、重命名、删除。
- 删除分组只删除组本身，不删除连接；组内连接回到“未分组”。
- 连接可拖动到不同组内。
- 连接可在同一组内排序。
- 旧连接数据保持兼容，默认显示在“未分组”。

不做嵌套分组、组间排序、批量移动、分组颜色和分组权限。

## 数据模型

后端继续使用现有加密连接存储文件，扩展存储结构以保存分组元数据。

连接配置增加可选字段：

- `group_id?: string`：连接所属分组。为空时属于“未分组”。

新增分组类型：

- `id: string`
- `name: string`
- `collapsed?: boolean`

存储读取需要兼容旧版连接数组。读取旧格式时，将旧连接数组转换为新结构中的连接列表，分组列表为空。

列表展示顺序由连接数组顺序决定。跨组移动时，更新连接的 `group_id`，并按拖拽结果保存新的全局连接数组顺序。

## 后端接口

保留现有连接接口语义，新增分组相关命令：

- `list_connection_groups() -> Vec<ConnectionGroup>`
- `create_connection_group(name) -> ConnectionGroup`
- `rename_connection_group(id, name)`
- `delete_connection_group(id)`
- `set_connection_group_collapsed(id, collapsed)`

保留重排命令：

- `reorder_connections(ids)` 继续只按全局连接顺序保存，不负责修改分组归属。

新增移动命令：

- `move_connection_to_group(connection_id, group_id, ordered_ids)`

该命令在一次保存中完成连接归属变更和连接顺序更新。`group_id` 为空表示移动到“未分组”。

## 前端交互

`ConnectionList` 从扁平列表改为分组渲染：

- 标题栏显示“新建”和“新建分组”两个按钮。
- “未分组”始终存在，不可删除、不可重命名，可折叠。前端使用固定伪组 ID `__ungrouped` 作为拖拽落点，保存时转换为空 `group_id`。
- 自定义组标题显示组名、连接数、折叠按钮、重命名按钮、删除按钮。
- 组为空时显示紧凑的空状态，作为拖拽落点。
- 连接项保留现有连接、切换、断开、编辑、删除能力。

拖拽规则：

- 拖到同组连接项上：按该组内顺序调整。
- 拖到其他组连接项上：移动到目标组并插入对应位置。
- 拖到空组或组标题落点：移动到该组末尾。
- 拖拽结束后调用 store action 保存，失败时重新加载连接列表和分组。

## 状态管理

`connectionStore` 增加：

- `connectionGroups`
- `loadConnectionGroups`
- `createConnectionGroup`
- `renameConnectionGroup`
- `deleteConnectionGroup`
- `setConnectionGroupCollapsed`
- `moveConnectionToGroup`

`loadSavedConnections` 继续负责加载连接。连接列表挂载时同时加载连接和分组。

## 错误处理

- 创建或重命名组时，空名称前端校验阻止提交。
- 删除组需二次确认。
- 后端未找到组或连接时返回明确错误。
- 拖拽保存失败时设置 store 错误，并重新拉取后端状态，避免前端停留在错误排序。

## 测试

后端测试：

- 旧版连接数组可读取为新结构。
- 新建、重命名、删除分组可持久化。
- 删除分组不会删除连接，组内连接回到未分组。
- 移动连接到其他组时同时保存归属和顺序。

前端测试：

- 分组列表渲染“未分组”和自定义组。
- 删除组触发对应 store action，不删除连接项。
- 连接按 `group_id` 分组展示。
- 纯逻辑函数覆盖跨组移动和组内排序。

## 约束

- 不在循环遍历中查询 SQL。本功能只操作本地配置文件，不新增 SQL 查询。
- 不新建分支，直接在当前分支修改。
- 不改变现有连接、编辑、删除、排序的基础行为。
