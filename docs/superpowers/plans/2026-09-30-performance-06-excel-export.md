# Excel 导出性能实施计划

> 执行说明：使用 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐任务实施。当前只生成计划，不执行代码变更。

**目标：**用户取消保存时不生成工作簿，取消完整 Base64 中间表示，并将工作簿编码移出主线程，保留当前导出内容和类型语义。

**架构：**先选择路径，再通过回调读取固定快照；复用现有 `write-excel-file/universal` 在专用 Worker 编码，输出可转移 ArrayBuffer，经 Tauri 原始请求体写入。路径先用 JSON 命令登记并返回一次性 ID，原始请求头只传 ASCII ID。

**技术栈：**TypeScript、Web Worker、Vite、现有 write-excel-file、Tauri 2、Rust 文件 I/O、Vitest。

**规格：**[性能优化总计划](2026-09-30-performance-00-overview.md)。调用方集成依赖 [01 的缓存保护租约](2026-09-30-performance-01-result-memory.md)；本计划不重写 SQL 导出，也不引入后端 XLSX 库或结果落盘系统。

租约通过 `src/utils/resultCacheBudget.ts` 导出的应用级 `resultCacheController.pin(cacheKey)` 获取，返回值直接作为 `PreparedExcelExport.release`；数据库结构对比结果没有此类行缓存登记时使用空 release，仍需固定输入快照。

## 全局约束与行为

- 当前分支、简体中文、禁止循环 SQL、不自动提交/推送/安装升级依赖；完整字段仍一次集合回查。
- 表浏览只导出当前页可见列及待提交编辑；SQL 导出当前选中语句的完整已保留结果；数据库对比保留现有摘要/表/字段三个工作表。
- 导出上限仍为 100,000 行。保留大整数字符串、NULL、日期、布尔值和现有工作表名清洗规则；预览占位符不得写进 Excel。
- 路径对话框返回 null 时，完整字段回查、矩阵转换、Worker 创建和文件登记次数均为 0。
- 一次只允许一个应用级 Excel 导出任务；其他入口给出“已有导出任务正在进行”，避免多个完整编码任务并发放大内存。
- Worker 会产生输入的结构化克隆；必须单独测量这部分峰值。首期移除 Base64 和无用预生成，不承诺流式 XLSX 或恒定内存。
- 数据快照固定后持有 01 的保护租约；成功、异常、取消和 Worker 销毁均释放。切页/切标签不得把新页数据混入导出。

## 文件职责

| 路径                                                                                   | 变更                                                 |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `src/utils/excelExport.ts`                                                             | 路径优先的任务编排、并发保护、错误清理               |
| `src/utils/excelWorkbook.ts`（新增）                                                   | 纯值转换和工作簿二进制编码；同时供 Worker 与单测调用 |
| `src/workers/excelExport.worker.ts`（新增）                                            | Worker 消息协议和 ArrayBuffer 转移                   |
| `src/services/tauriCommands.ts`                                                        | 准备/写入/取消二进制导出 API                         |
| `src-tauri/src/commands/file_io.rs`、`src-tauri/src/lib.rs`                            | 一次性导出登记、原始体写入与状态注册                 |
| `src/components/sql/SqlEditor.tsx`、`src/components/table/TableData.tsx`               | 路径选择后准备固定快照与缓存租约                     |
| `src/utils/databaseCompareExport.ts`                                                   | 三工作表导出迁移，避免遗漏旧 Base64 调用方           |
| `src/__tests__/excelExport.test.ts`、`src/__tests__/excelExportWorker.test.ts`（新增） | 内容、任务顺序、Worker 和资源回收测试                |
| `src-tauri/src/commands/file_io.rs` 内测试模块                                         | 路径、ID 消费、写入失败与二进制内容验证              |

## 拟新增接口

```ts
interface ExcelExportSheetInput {
  sheet: string;
  data: readonly (readonly unknown[])[];
}
interface PreparedExcelExport {
  sheets: ExcelExportSheetInput[];
  release: () => void;
}
exportExcelWithDialog(
  suggestedFileName: string,
  prepare: () => Promise<PreparedExcelExport>,
  signal?: AbortSignal
): Promise<boolean>;
buildWorkbookBuffer(sheets: ExcelExportSheetInput[]): Promise<ArrayBuffer>;
prepareBinaryExport(path: string): Promise<string>; // 一次性 exportId
writeBinaryExport(exportId: string, bytes: ArrayBuffer): Promise<void>;
cancelBinaryExport(exportId: string): Promise<void>;
```

Worker 请求 `{ id, sheets }`，响应 `{ id, buffer }` 或 `{ id, error }`，`buffer` 使用 transfer list。输入允许现有协议值和 Date/BigInt，由 Worker 内的 `cellValueForXlsx` 归一化；已有 `ExcelSheetData` 可作为兼容输入，不要求调用方预先复制为规范化矩阵。取消编码时终止专用 Worker，迟到消息不更新任务状态。

Rust 命令为 `prepare_binary_export(path, state)`、`write_binary_export(request: tauri::ipc::Request<'_>, state)`、`cancel_binary_export(export_id, state)`，均返回现有中文错误风格。`AppState` 新增登记表；ID 是 UUID，只登记路径，不创建/截断文件。原始请求体传二进制，`x-db-connect-export-id` 头传 ID；取消/写入领取均原子移除登记，未知/重复 ID 拒绝。

写入在 `spawn_blocking` 中完成，沿用已选路径的覆盖语义；登记表最多 1 项，开始新登记时回收过期项，未领取 ID 有 5 分钟有效期。原始体写入一旦领取并开始，前端等待写入结果，不宣称可以撤销已发生的文件写入；TTL 使用单调时钟。

## 任务 1：把路径选择移到所有昂贵工作之前

**文件：**`excelExport.ts`、三个调用方和 `excelExport.test.ts`。

**接口：**先建立 `exportExcelWithDialog` 的 prepare/release 契约，暂时复用已有编码写入，供后续任务替换内部实现。

- [ ] 补测试并先观察失败：取消保存时 `prepare`、完整字段 API、工作簿编码、写文件均未调用；选择路径后只准备一次；prepare 抛错时不写文件。
- [ ] 迁移 SQL、表当前页、数据库对比三个入口。点击时只记录廉价上下文；对话框返回后确认来源仍有效，固定数据/编辑快照并获取租约；来源已关闭或代次变化时提示重新发起，不能偷偷导出另一页。
- [ ] 所有出口调用 release；重复点击受应用级忙状态保护，异常后可以重新发起导出。
- [ ] 运行 `npm test -- src/__tests__/excelExport.test.ts src/__tests__/SqlEditorMultipleResults.test.tsx src/__tests__/TableDataDeferred.test.tsx`，增加三工作表调用方的内容回归。

## 任务 2：二进制 IPC 替换 Base64

**文件：**`excelWorkbook.ts`、`excelExport.ts`、`tauriCommands.ts`、`file_io.rs`、`lib.rs` 及对应测试。

**接口：**实现 `buildWorkbookBuffer` 与三个二进制导出命令；原始请求结构按已安装 Tauri 版本编译验证。参考 [Tauri 原始请求体](https://v2.tauri.app/develop/calling-rust/)。

- [ ] 补失败测试：中文/空格/Windows 路径通过 JSON 登记原样保留；未知、过期、已取消和重复 ID 拒绝；二进制含 0x00/0xff 原样落盘；I/O 失败返回错误且登记已清理。
- [ ] 实现路径登记与原始体写入。网络式请求头中不放原始中文路径，也不把 ArrayBuffer 展开成数字数组 JSON；锁仅用于领取登记，文件写入在锁外。
- [ ] 编码返回 ArrayBuffer，移除 Excel 所有调用链中的 `btoa`、二进制字符串和 Base64 解码。全部调用方迁移后再删除无人使用的旧 helper/命令，保留仍有其他用途的文件 API。
- [ ] 验证 XLSX 的 ZIP/XML 内容、工作表数量、列顺序和单元格类型；ZIP 魔数检查不足以证明数据正确。使用现有 ZIP 依赖或测试运行时读取，不仅比较可变时间戳导致不稳定的整文件哈希。
- [ ] 运行 `npm test -- src/__tests__/excelExport.test.ts`、`cargo test --manifest-path src-tauri/Cargo.toml file_io`、`npm run build`。

## 任务 3：工作簿编码移入 Worker

**文件：**`excelWorkbook.ts`、`excelExport.worker.ts`、`excelExport.ts`、`excelExportWorker.test.ts`。

**接口：**实现上述消息协议；主线程不提前再构造一份归一化 sheetData，值转换和工作簿编码放在同一个 Worker 中。

- [ ] 先验证当前已安装的 `write-excel-file/universal` 在生产构建 Worker 中支持 Blob/ArrayBuffer 路径；必须实际浏览器/桌面验证，jsdom mock 通过不能代替。失败时记录具体兼容问题，不自动换库。
- [ ] 补失败测试：消息 ID 不匹配或取消后的消息不生效；成功使用 transfer list；编码抛错、终止和组件卸载均释放 Worker、忙状态和缓存租约。
- [ ] 实现专用 Worker 的创建与 finally 清理；先创建编码产物再登记一次性写入 ID，使编码时间不消耗待写入 ID 的有效期；取消发生于登记与写入之间时调用取消命令。
- [ ] 验证 100,000 行上限、空值、Unicode、长文本、大整数、日期和多工作表一致；导出中切换结果或触发 01 淘汰不能改变已固定快照。
- [ ] 运行 `npm test -- src/__tests__/excelExport.test.ts src/__tests__/excelExportWorker.test.ts src/__tests__/TableDataDeferred.test.tsx` 和 `npm run build`，在真实 WebView 下检查 Worker 和 CSP 可用性。

## 任务 4：性能与完整性验收

**文件：**`docs/performance-baseline.md`、README 导出说明及实际受影响测试。

- [ ] 固定 1 万/10 万行及宽字段夹具，分别测准备、结构化克隆、编码、IPC 和写盘耗时，记录主线程最长任务与 Rust/WebView 峰值内存。
- [ ] 对比旧路径确认 Base64 完整表示已经消失，取消保存时零准备；记录 Worker 克隆成本，不能把主线程改善描述为内存必然下降。
- [ ] 小文件、Unicode 路径、覆盖已有文件、无写权限、磁盘写入失败和关闭窗口场景均给出明确结果；原始体领取后的写入失败不能提示成功。
- [ ] 运行 Rust fmt/clippy、相关前端 lint，以及总计划要求的最终集成检查；记录 Windows/macOS/Linux 哪些已验证、哪些待验。

## 审查重点

1. 用户取消保存不能触发大字段回查或编码：任务 1。
2. 路径不能因中文/Windows 字符编码而变化，ID 只能使用一次：任务 2。
3. Excel 类型、精度、字段预览与多个工作表语义不退化：任务 1/2/3。
4. 取消/卸载/编码失败不能遗留 Worker、租约或登记：任务 2/3。
5. 结果释放与切页并发时仍使用固定快照，且记录 Worker 克隆的峰值：任务 3/4。

## 验收与回退

确定性门槛为取消零准备、无 Base64 数据链路、单任务并发、资源清理和内容等价。性能结论以同机复测为准。

Worker 兼容性未通过时先交付路径优先及二进制传输；保留单一 `buildWorkbookBuffer` 主线程实现作为明确记录的临时回退，不恢复 Base64，也不声称 Worker 优化已完成。回退只改变编码执行位置，不改变数据来源与写入语义。

若随后获准提交，建议标题：`refactor: 优化 Excel 导出内存与响应`；本计划不执行提交。
