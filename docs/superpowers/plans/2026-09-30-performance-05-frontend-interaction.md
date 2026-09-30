# 前端交互性能优化实施计划

> **面向执行代理：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务执行；使用复选框跟踪步骤。本次仅生成计划，不实施。

**目标：** 降低大页表格转换、结构对比展示、侧栏拖动与初始界面加载的前端成本，同时保持编辑、选择、复制和同步确认语义。

**架构：** 保留主表现有行列双向虚拟化，以按行索引读取替代全页对象矩阵；复杂可变高度列表优先分页。拖动预览与持久化分离，低频界面按实际入口延迟加载，并独立测量静态资源体积。

**技术栈：** React 18、TypeScript、Zustand 5、Ant Design 5、TanStack Virtual、Vite 8、Vitest。

**Spec：** [性能优化总览](./2026-09-30-performance-00-overview.md)。执行前同时阅读总览与本文件。

## 全局约束

- 本次仅编写计划；实施需用户后续授权，不自动 commit、push 或发布。
- 默认在当前分支修改；用户未明确要求时不得新建分支。
- 禁止在循环遍历中查询 SQL；本计划中的数据遍历仅操作已返回的内存数据。
- 保留主表双向虚拟化、SQL 编辑器懒加载、结果分页、延迟大字段读取和已实现的订阅隔离。
- 不以泛泛添加 memo 代替成本定位；不改 SQL 执行、结果缓存预算及 Excel 编码协议，后两者由其他专项计划负责。
- 不新增运行时依赖；测试使用合成数据和 mock 命令，不连接真实数据库、不执行同步 DDL。
- 当前入口 HTML 引用/预加载 JS 为 **1,704,860 bytes**；index **386,261 bytes**、antd **1,272,740 bytes**；Monaco 按需块 **3,642,850 bytes**。
- 上述为未压缩构建产物字节数，不是冷启动耗时，也不等于已证明的完整静态依赖闭包；实施前按同一口径复测。

## 五项审查重点

1. 复合主键、缺失主键、分页排序后行身份：选择和待提交修改仍指向原行，不能因索引复用写错行；由任务 1 覆盖。
2. MySQL 延迟字段、隐藏列与异步补全：复制/编辑读取完整原值，切页后旧响应不得用于新页；由任务 1 覆盖。
3. 跨页结构选择与长 SQL：全选仍覆盖全部合格项，分页不能减少真实同步计划、隐藏风险汇总或截断 SQL；由任务 2 覆盖。
4. 拖动中窗口失焦、卸载及触及宽度边界：清理监听与动画帧，不在取消后持久化旧宽度；由任务 3 覆盖。
5. 延迟模块加载失败、打开后立即关闭及运行中同步：错误局限于功能区域，不能导致主界面白屏或中止已有同步流程；由任务 4 覆盖。

---

## 任务 1：主表改为按行索引读取，按操作物化记录

**文件映射：**

- 新增 `src/components/table/tableRowSource.ts`：封装原始二维数组、列索引和稳定行键。
- 修改 `src/components/table/VirtualDataTable.tsx`：替换 `dataSource`/record 接口，保留虚拟器和拖动列宽逻辑。
- 修改 `src/components/table/TableData.tsx`：替换约 1205–1430 行的列渲染与全页对象转换，并适配编辑、删除、复制和当前页导出入口。
- 复用 `src/components/table/tableDataRowKeys.ts`、`src/components/table/deferredFields.ts`；必要的适配不得改变现有键格式或批量读取协议。
- 新增 `src/__tests__/tableRowSource.test.ts`；更新 `VirtualDataTable.test.tsx`、`VirtualDataTableResize.test.tsx`、`TableDataSelection.test.tsx`、`TableDataDeferred.test.tsx`、`copyAsInsert.test.ts`。

**接口：**

- 新增 `createTableRowSource({rows, columns, primaryKeyColumns, scopeKey, page}): TableRowSource`；数组输入只读，源对象与本次页快照绑定。
- `TableRowSource` 提供 `rowCount: number`、`getCell(index: number, column: string): unknown`、`getRowKey(index: number): string`、`getPrimaryKeys(index: number): Record<string, unknown>`。
- 提供 `materializeRows(indices: readonly number[], columns: readonly string[]): Record<string, unknown>[]`，仅在用户操作时创建记录，携带原页 `_rowKey`、`_selectionKey` 及主键。
- `VirtualDataTable` 改收 `rowSource: TableRowSource`；列提供 `renderCell(rowIndex: number): ReactNode` 并保留 `key/title/width/ellipsis/onHeaderCell`；行样式回调改收行索引。
- 不把该接口推广到 SQL 编辑器的 Ant Table；只有现有主表及其测试需要迁移。

- [ ] **步骤 1：补充读取规模和行身份回归测试。**
      合成 10,000 行×200 列，在固定虚拟视口下用计数 getter 记录非主键读取；断言初始化不枚举全部 2,000,000 个单元格，远处未显示列未被读取。
      断言复合主键键值与旧 `buildRowSelectionKey` 一致；主键缺失时仍回退为 scope/page/row；排序、切页后的选中清理遵循现有规则。
      断言 `materializeRows([2, 7], ['name'])` 仅含指定业务列、主键及行元数据，不修改二维数组，也不将 pending 新值写回原始值。
- [ ] **步骤 2：运行新增测试，确认缺失接口/全量读取断言失败。**
      命令：`npx vitest run src/__tests__/tableRowSource.test.ts src/__tests__/VirtualDataTable.test.tsx`。
- [ ] **步骤 3：实现索引数据源并接入虚拟表。**
      列名索引构建一次；可见单元格直接读数组；允许 O(行数×主键列数) 建立稳定键，禁止为每行创建包含所有业务列的对象。
      行选择集合和全选/半选计算仅依赖行键及选择集合；空集合直接返回，滚动不再次扫描整页。
- [ ] **步骤 4：适配记录消费者并固定延迟值语义。**
      删除只读取选中行主键；复制只物化选中行及所需列；当前页导出只在点击后物化；不改导出编码实现。
      单元格编辑继续使用完整原值和 pending 覆盖显示；延迟值按既有批量接口补齐，保留页面快照与卸载失效检查。
      增加“复制期间切页拒绝旧响应”“隐藏字段复制完整值”“Tab 导航、全选/取消、复合主键批量删除无误定位”的断言。
- [ ] **步骤 5：运行回归并记录前后成本。**
      命令：`npx vitest run src/__tests__/tableRowSource.test.ts src/__tests__/VirtualDataTable.test.tsx src/__tests__/VirtualDataTableResize.test.tsx src/__tests__/TableDataSelection.test.tsx src/__tests__/TableDataDeferred.test.tsx src/__tests__/copyAsInsert.test.ts`。
      在相同 WebView/视口下比较 100/1,000/10,000 行和 20/200 列的换页、切回、滚动；记录 p95、分配量、非主键读取次数。

**验收与回滚：** 初始化读取随可见单元格增长，不随全页列矩阵增长；选择/编辑/复制断言全部通过。10,000×200 样本的记录转换分配量目标下降至少 70%；未达标先分析，不降低语义要求。回滚仅恢复主表适配与接口，不改变 store 数据及持久化格式。

## 任务 2：结构对比和同步预览优先分页

**文件映射：**

- 修改 `src/components/databaseCompare/DatabaseCompareResults.tsx`：约 239/266 行外层表与字段差异表均取消全量挂载。
- 修改 `src/components/databaseCompare/DatabaseSyncPreviewModal.tsx`：约 157–278 行预览列表和 303–441 行失败结果列表分页；移除逐项 `findOperation` 关联扫描。
- 更新 `src/__tests__/DatabaseCompareResults.test.tsx`、`src/__tests__/DatabaseSyncPreviewModal.test.tsx`；复用现有 `DatabaseCompareModal.test.tsx` 的流程约束。

**接口：**

- 外部 props 保持不变，分页仅改变呈现层；所有回调仍接收完整选择，`DatabaseSyncPreview.operations` 保持原执行顺序和完整内容。
- 对比表与展开字段表默认每页 50 条；同步操作卡片、阻塞项、跳过项、已执行语句和未执行操作默认每页 20 条。
- 各列表使用独立页码；预览 `plan_fingerprint` 或结果身份改变时重置，搜索/筛选改变时重置对比页码；结果缩小时夹紧页码。
- 操作关联使用 `Map<string, DatabaseSyncOperation>`，构建 O(操作数)，查询 O(1)；完整汇总直接基于原始数组计算。

- [ ] **步骤 1：补充跨页选择和挂载数量测试。**
      构造 1,001 张差异表，断言首屏只挂载 50 条外层数据行；在第 1/2 页选择后两者都保留；“选择全部可同步表”仍覆盖所有合格表。
      关闭删除开关后跨页目标独有表均从选择中移除；搜索、清空、结果替换不会出现空的越界页。
      构造 1,001 个同步操作和多行 SQL，断言只挂载当前 20 张卡片，SQL 文本完整、顺序不变，风险/阻塞总数仍来自全量结果。
- [ ] **步骤 2：运行测试，确认当前全量 DOM 实现失败。**
      命令：`npx vitest run src/__tests__/DatabaseCompareResults.test.tsx src/__tests__/DatabaseSyncPreviewModal.test.tsx`。
- [ ] **步骤 3：加入受控分页并限定展开区域。**
      对比保留 `preserveSelectedRowKeys`；页切换收起非当前页展开内容，展开字段表也分页。同步列表先 slice，再格式化和渲染当前页。
      分页不触发数据库请求；全局确认、执行禁用、风险提示和失败位置必须始终可见，不以“已浏览全部页”新增执行条件。
- [ ] **步骤 4：优化结果关联并添加流程回归断言。**
      建立操作索引供失败详情、已执行语句和未执行操作共用；断言显示原始 SQL 序号，未找到操作时仍显示 ID。
      断言分页不能改变确认回调次数、计划指纹、已选表集合或执行锁；迟到的旧预览不能覆盖新计划。
- [ ] **步骤 5：验证正确性和大列表成本。**
      命令：`npx vitest run src/__tests__/DatabaseCompareResults.test.tsx src/__tests__/DatabaseSyncPreviewModal.test.tsx src/__tests__/DatabaseCompareModal.test.tsx`。
      用 10,000 张差异表、1,000 个多行 SQL 操作记录首屏和换页 React Profiler 提交耗时；同时检查键盘分页和展开区域可访问性。

**验收与回滚：** 外层对比挂载≤50 条、每个展开表≤50 条、各同步列表≤20 项，汇总与选择不缩水；换页无需网络。可变高 SQL 卡片本阶段不用虚拟化；只有后续测量证明分页仍不足才另立方案。回滚分页状态与呈现即可，比较/执行数据接口无需回滚。

## 任务 3：侧栏拖动采用帧预览，松手后持久化

**文件映射：**

- 新增 `src/hooks/useSidebarResize.ts`：只管理拖动、rAF、DOM 预览及取消清理。
- 修改 `src/App.tsx`：替换约 104–129 行事件逻辑；为侧栏提供 ref，连接/settings 订阅改为实际所需字段。
- 修改 `src/stores/settingsStore.ts`：保留 200–480 px 边界，相同规范化宽度提前退出且不调用持久化 set。
- 新增 `src/__tests__/useSidebarResize.test.tsx`、`src/__tests__/AppStateSubscriptions.test.tsx`；更新 `src/__tests__/settingsStore.test.ts`。

**接口：**

- `useSidebarResize({width, minWidth, maxWidth, onCommit}): {siderRef: RefObject<HTMLDivElement>, onMouseDown: MouseEventHandler<HTMLDivElement>}`。
- `onCommit(width: number): void` 只在一次有效 mouseup 且最终宽度变化时调用；事件读取最后宽度，不等待尚未执行的 rAF。
- 预览修改侧栏元素的 width/flex-basis；失焦或卸载取消，不持久化，失焦时恢复已提交宽度。
- App 使用单字段 selector 或 `useShallow` 订阅现有必要字段；不新增全局拖动状态，不改连接 store 的业务动作。

- [ ] **步骤 1：添加动画帧与持久化调用次数测试。**
      同一帧发送 100 次 mousemove，断言预览合并为一次、`onCommit` 尚未调用；mouseup 发生在 rAF 前也提交最后宽度一次。
      断言边界固定为 200/480，未移动不提交；window blur 或卸载后事件与待执行帧无副作用，blur 恢复起始宽度。
      对真实 settings persist 的 storage 写入做 spy，清除初始化记录后断言一次完成拖动仅一次写入、相同宽度零写入。
- [ ] **步骤 2：运行测试，确认现有高频持久化问题被复现。**
      命令：`npx vitest run src/__tests__/useSidebarResize.test.tsx src/__tests__/AppStateSubscriptions.test.tsx src/__tests__/settingsStore.test.ts`。
- [ ] **步骤 3：实现帧预览和终止路径。**
      开始拖动缓存已提交宽度/坐标；mousemove 只更新 ref 并排一个 rAF；mouseup 清理后只提交变化的最终值。
      恢复 body cursor/user-select，清理 window 监听；防止重入拖动和已取消 rAF 再次覆盖 React 提交值。
- [ ] **步骤 4：收窄订阅并钉住隔离行为。**
      用 Profiler 验证未消费的 listTableSettings/windowBounds 变更不提交 App；连接 loading/error 等原本需要展示的变化仍响应。
      拖动预览不提交 App React 树；容器尺寸变化仍允许既有 ResizeObserver 与 Monaco automaticLayout 正常工作。
- [ ] **步骤 5：执行回归与交互录制。**
      命令：`npx vitest run src/__tests__/useSidebarResize.test.tsx src/__tests__/AppStateSubscriptions.test.tsx src/__tests__/settingsStore.test.ts src/__tests__/SqlStateSubscriptions.test.tsx`。
      在表格与 SQL 编辑器两种界面各拖动 2 秒，统计持久化次数、App 提交次数与长任务；复核外部窗口缩放、恢复设置。

**验收与回滚：** 每次完成拖动最多一次写入，取消/不变宽度零写入；预览期间 App 提交为零，边界和布局行为保持。回滚 hook 接入即可，持久化 schema 不迁移。

## 任务 4：低频界面按需加载，并建立初始 JS 测量

**文件映射：**

- 修改 `src/App.tsx`：动态加载 `DatabaseCompareModal`、`ProjectIntroModal`、`ShortcutsHelpModal`，仅首次进入功能时触发加载。
- 修改 `src/components/database/DatabaseOverview.tsx`：`RoutineList`、`EventList` 按对应标签首次激活加载，保留 `remeasureKey`。
- 新增 `src/components/common/DeferredFeatureBoundary.tsx`：局部加载失败提示与关闭入口，不让可选功能失败升级为全应用白屏。
- 新增 `scripts/report-initial-js.mjs`、`scripts/report-initial-js.node-test.mjs`；修改 `vite.config.ts` 开启 build manifest。
- 新增 `src/__tests__/AppLazyFeatures.test.tsx`；更新 `DatabaseOverview.test.tsx`、`ProjectIntroTrigger.test.tsx`，复用对比模态回归。

**接口：**

- `DeferredFeatureBoundary` 接收 `{children: ReactNode, onClose: () => void}`；Suspense 的加载占位保留关闭入口；重新打开用新加载尝试重置错误与 lazy 实例。
- 首次成功加载后可保留组件实例并传 `open=false`，避免粗暴条件卸载改变取消/清理语义；同步执行期间维持现有禁止关闭规则。
- `node scripts/report-initial-js.mjs dist --json` 输出 `htmlReferencedBytes`、`initialStaticBytes`、`dynamicJsBytes` 与逐文件明细；文件按路径去重。
- `htmlReferencedBytes` 只计 HTML module script/modulepreload；`initialStaticBytes` 再遍历 manifest 的静态 imports；dynamicImports 另列，不混入初始体积。

- [ ] **步骤 1：建立资源统计与延迟入口测试。**
      Node fixture 覆盖重复 preload、静态依赖链和动态 chunk：同文件只计一次，动态块只出现在按需集合。
      UI 测试断言首次启动没有调用可选模块 loader；打开后加载，加载期间可关闭，拒绝时只有局部错误；重新打开可重新尝试。
      断言对比同步正在执行时不能因外层懒加载包装被卸载；例程/事件标签激活后加载且高度重测正常。
- [ ] **步骤 2：运行测试确认入口尚未隔离。**
      命令：`node --test scripts/report-initial-js.node-test.mjs`；`npx vitest run src/__tests__/AppLazyFeatures.test.tsx src/__tests__/DatabaseOverview.test.tsx`。
- [ ] **步骤 3：实现资源报告，重建实施前基线。**
      先启用 manifest 并加入报告脚本，运行 `npm run build` 和 `node scripts/report-initial-js.mjs dist --json`；保存两种初始口径及按需块明细。
      标注机器、版本和构建配置；不把 gzip、磁盘字节数或开发服务器响应时间称作 Tauri 冷启动时间。
- [ ] **步骤 4：实现有明确入口的懒加载。**
      删除低频组件对应静态导入，在功能入口局部 Suspense；不要重复拆分已有 Monaco、Mermaid、Excel 动态块。
      检查现有 antd manual chunk 是否仍把低频依赖带入入口；只有测得额外收益且无重复依赖才调整 chunk 策略，不能靠重命名块宣称优化。
- [ ] **步骤 5：验证资源归属与所有入口。**
      命令：`node --test scripts/report-initial-js.node-test.mjs`；`npx vitest run src/__tests__/AppLazyFeatures.test.tsx src/__tests__/DatabaseOverview.test.tsx src/__tests__/ProjectIntroTrigger.test.tsx src/__tests__/DatabaseCompareModal.test.tsx`。
      命令：`npm run build`；`node scripts/report-initial-js.mjs dist --json`；手动逐一打开功能，检查加载/失败/关闭和第二次打开。

**验收与回滚：** 可选界面在未使用时不加载，初始静态闭包不得增加，入口 HTML 同口径字节数须有可解释下降；具体降幅以构建对比确认，不预设冷启动收益。无收益的拆分不合并；回滚各 lazy 边界即可，保留独立报告工具。

## 交付检查

- [ ] 四个任务分别形成可评审差异；用户后续授权实施时才执行命令，不自动提交。
- [ ] 最终运行 `npx tsc --noEmit`、上述定向测试及一次 `npm run build`；不重复运行已通过且未受改动影响的全量检查。
- [ ] 报告功能回归、DOM/读取次数、拖动写入次数、构建字节数和实测耗时；未测指标明确标记未测。
- [ ] 任一任务未满足语义约束时仅回滚该任务，不用降低分页保护、删测试或改变数据库操作语义换取性能。
