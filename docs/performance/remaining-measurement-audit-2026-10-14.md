# T06—T09 测量与环境只读审计

证据日期：2026-10-14。仓库：`/Volumes/CaseSensitive/workspace/myself/db-connect`，核查时 HEAD 为 `7a0f619831e87da914362f0b3d7d899a0b808421`。

本次仅阅读代码、既有 JSON 和公开技术文档，执行工具版本/路径/Inspector 域查询。没有修改仓库、运行基准、构建或测试，没有启动/关闭用户应用、读取业务配置、连接数据库、创建测试卷或故障注入。以下“建议补验”均尚未执行。本报告不能将 T06—T09 勾选为完成。

## 实际环境与工具

| 项目 | 2026-10-14 只读探测结果 | 对测量的影响 |
|---|---|---|
| 主机 | macOS 27.0.1，build 26A434，arm64 | 不能与旧 macOS 26.5.2 样本混合计算收益；需重建成对样本 |
| Node / V8 | Node v25.5.0；V8 14.1.146.11-node.18 | 可做独立 Node 夹具分析，不能视为 JavaScriptCore/WebView 性能 |
| Swift / Rust | Swift 6.3.3；`swift --version` 默认目标显示 macOS 28.0；rustc 1.93.1 | Swift/WebKit 夹具需显式核对 SDK 与 target；没有运行编译验证兼容性 |
| 开发目录 | `/Library/Developer/CommandLineTools` | 已有 SDK 不代表拥有 Instruments |
| xctrace | `/usr/bin/xctrace` 存在，但 `xctrace list templates` 报错：requires Xcode，active developer directory is a command line tools instance | 本机当前无法录制 Allocations / Time Profiler / System Trace；不能按命令存在认定工具可用 |
| instruments | PATH 无可用命令；`xcrun --find instruments` 失败 | 不能调用旧 Instruments CLI |
| Xcode | `/Applications` 下未发现 `Xcode*.app` | 尚无完整 Xcode 安装证据；未搜索其他卷，不能断言整机完全没有 Xcode |
| SDK | CLT 中有 MacOSX 26.5、27.0 等 SDK | 既有文档记录默认 SDK 27 链接问题，若后续构建，可在单条命令设 SDKROOT 指向 26.5，不改变系统选择；本次未确认新构建成功 |
| 其他系统工具 | `sample`、`vmmap`、`leaks`、`heap` 存在 | 工具存在不等于对 WebContent 具备附加权限；本次未附加任何用户进程；快照/采样无法直接替代所有分配或精确瞬时峰值 |
| Safari | 27.0.1，22625.1.29.11.28 | Safari Inspector 可能用于隔离可检查 WebView 的时间线；需先验证目标可检查性、实际事件和时间粒度，未打开或设置 Safari |
| 仓库产物 | node_modules、dist、`src-tauri/target/debug/db-connect` 存在；`target/release/db-connect` 不存在 | 存在不保证与 HEAD 一致；没有本次 HEAD Release 主应用的身份/哈希/构建证据 |
| 已安装主应用 | `/Applications/DB Connect.app` 的 bundle 元数据为 1.12.0；仓库 package/tauri 配置为 1.13.0 | 已安装应用不能作为当前代码验收对象；本次未启动它 |
| 其他平台 | 当前只核实 macOS；docker、qemu-system-aarch64 命令存在 | 未探查 Docker 容器、VM 或业务环境；未证明有 Windows/WebView2、Linux/WebKitGTK 桌面和系统保存对话框会话，命令存在不能补平台矩阵 |

Node 能力探测只创建本次 Node 自身的 Inspector Session，查询 `Schema.getDomains`，得到 `HeapProfiler` 1.3 后立即断开；没有打开监听端口、开始采样、生成堆文件或执行业务夹具。

## T06：全部分配量仍无合格证据

`scripts/performance/table-row-source-benchmark.mjs:19–50` 在原始矩阵已创建并预热后，两次 GC 测 baseline，包围 `create(rows)` 计时，再两次 GC 测 heapUsed。输出 `addedRetainedHeapBytes`，并在单独代理矩阵上数 getter。其 10,000×200、99.1481% 和 `passed=true` 都针对“新增保留堆下降至少 70%”。该字段名已区分口径，但不能据此完成原“全部分配下降至少 70%”。

- GC 后 heap 只统计存活量，遗漏期间已分配后回收的临时对象；RSS 还混入引擎、JIT、分配器等成本。
- Node `--heap-prof` 是抽样分配分析，默认平均间隔 512 KiB；减小间隔不自动获得已经验证为零漏计的全量计数。Inspector `startSampling` 同样属于 SamplingHeapProfile；后续若启用收集已被 GC 回收对象的选项，仍需实测当前运行时是否支持和校准采样/记录开销。不能仅求 `selfSize` 就声称全部分配。
- 另一个应优先校准的候选是 `HeapProfiler.startTrackingHeapObjects({trackAllocations:true})`：它不是 startSampling。V8 官方 AllocationTracker 的 trace 节点按 AllocationEvent 累加 `allocation_count` 和 `total_size`，因此快照中的 `trace_tree` 候选计数应与仅求存活节点大小区分，可能获得包含已回收对象的 V8 托管堆累计分配。不能把“Node 只有采样”写成结论；本次仅确认 HeapProfiler 域存在，没有验证当前 Node 的追踪参数、trace_tree 导出和 GC 后累计语义。后续需按 trace_node_fields 解析，避免父子重复加总、Inspector 自身分配污染以及分配栈截断，检查字符串/ArrayBuffer backing store 与原生分配等覆盖边界。即使成功，也不自动表示 WebView 或整个进程全部分配。
- WebKit 的公开 Heap 协议包含 snapshot、GC 和跟踪前后快照，未提供一个可直接取用的“边界内全部分配字节”标量。协议上游主线不是本机 Safari 支持性的替代证据。现有 WKWebView 夹具也明确 `allocationBytes: null`。
- 将来获得 Instruments Allocations 后仍需区分 malloc/VM 分配与 JSC/V8 自有堆中的对象分配，不能默认原生分配事件等于 JS 业务对象全部分配。

最小安全补验：先在独立临时工作目录的 Node 探针，用固定数量的存活对象、短命对象、跨 minor/major GC 对象和外部缓冲区，优先校准 `startTrackingHeapObjects(trackAllocations:true)` 的 trace_tree 计数，另以 SamplingHeapProfile 作诊断。记录计数覆盖、漏计、GC 选项和测量开销；用空操作对照估计 Inspector/快照干扰，验证快照序列化发生在计数边界外，采集开始/结束的差分或可严格归因的调用栈。若校准只能提供估计，明确标“抽样分配估计”，T06 仍待验。只有找到经校准、覆盖目标分配域的累计计数或引擎插桩，才在同一 Node/同一 bundle 上，使用旧转换与当前行源的 10,000×200 夹具，严格围住初始化/转换边界采集成对结果。输入生成、预热、Inspector 消息处理和 getter 校验放在边界外，保存原始 trace、重复样本和误差。按 `(旧累计分配－新累计分配)/旧累计分配` 判断 70%，不能替换为保留堆目标。

## T07：独立组件夹具不能代表完整主应用

`frontend-interaction-webview.tsx` 是 Vite development React 18、无 StrictMode 的独立 WKWebView；真实 hook/settings、虚拟表、Monaco、大列表可复用，但输入是程序派发 MouseEvent/scroll/click；原生窗口 resize 由 NSWindow API 触发。结果明确 `nativeHumanInput: false`，没有 Tauri 后端或数据库，没有挂载完整 HEAD TableData/App。

现有覆盖：两秒左右合成拖动、外壳提交与存储写入、rAF 间隔、表格/编辑器子树提交、失焦回滚、不变宽度零写入、原生窗口大小变化及列表 DOM 上限。`Profiler actualDuration` 是渲染工作量，不是 DOM 提交阶段耗时；“外壳提交 0”不是实际 App 根提交 0，也不是整棵 React 树提交 0。`AppStateSubscriptions.test.tsx` 等单元测试含卸载取消和真实 persist mock，但不是桌面手工证据。本次未运行它们。

缺口：完整当前版本主应用的真实拖动、App 根与必要子树提交记录、卸载/设置恢复、低频懒加载实际入口逐项加载/故障重试/关闭重开/健康实例保留、宽表切页滚动切标签及选择/编辑/复制回归、对比列表搜索展开键盘分页跨页选择。App 中存在项目介绍、快捷键帮助、数据库比较等入口，DatabaseOverview 中存在 routine/event 入口；还需按实际 UI 列出所有入口。现有夹具没有逐项挂载这些功能。

最小安全补验：先准备与 HEAD 对应、独立应用标识及独立数据目录的完整主应用测试入口，注入无业务数据的合成结果/隔离数据库，并验证所有设置、凭据、会话恢复路径都指向测试目录；单改 bundle identifier 未必足够。加入 App 根/子树提交计数、persist 计数和渲染/提交阶段明确区分的观测，再录制表格与 SQL 编辑器各一次真实约 2 秒拖动及取消/不变宽度。懒加载失败用仅测试构建的受控加载失败验证。该入口目前未提供；直接启动已安装 1.12.0 或默认 debug 主应用既不能证明 HEAD，也可能读取用户配置，故本次不执行。初始 JS 继续复用 `scripts/report-initial-js.mjs` 的既定口径，不推导冷启动加速。

## T08：阶段夹具可复用，最长任务和峰值仍有限制

`excel-export-webview.mjs` 生产构建独立测试页面，固定 10,000×8、100,000×8、10,000×32 宽 Unicode 字段，包含大整数、日期、NULL、布尔值等；旧实现由固定 git 版本提取，新测量 Worker 复用 `buildWorkbookBuffer`，另做生产 Worker smoke。输入生成在测量前；prepare、Worker 输入到达、编码、Blob/Base64 阶段可比较。落盘经 loopback HTTP/Node，只是传输替代路径，不是 Tauri IPC/Rust。

`excel-export-measure.worker.ts` 的 cloneOnly 模式持有克隆输入 500ms，可覆盖副本持续存活期。`inputArrivalMs` 包含冷 Worker 启动、序列化、调度、反序列化，不能标纯结构化克隆 CPU；postMessage 同步耗时也不能自动表示全部克隆成本。持有期 RSS 是整个候选进程内存，不能说成克隆字节。

`excel-export-tauri.mjs/.rs` 创建临时 example、最小 AppState 和无痕 WebView，复用生产 CSP、生产 Worker 产物及生产 file_io 命令；1/10MiB 固定字节测真实 IPC 往返与 Rust 包装耗时，另测预分配 Vec 的 fs::write。包装耗时包含登记领取、Vec 克隆、排队与写入；往返减包装耗时是剩余 IPC/调度开销，不能称纯 IPC 拷贝。磁盘微基准不是生产命令内部阶段拆分，也没有 fsync。脚本明确默认 `cargo build --offline` 后运行 debug example，不能补 Release 证据；其字节夹具不等于完整 1万/10万行端到端导出。

精度与归属必须保留以下限制：

1. 既有 WebKit 样本不支持 longtask；10ms timer 最大间隔与 rAF 间隔受调度、渲染、后台节流影响，均不能当作主线程最长任务。此次未启动 WebView，所以没有重新验证新 OS 的 supportedEntryTypes；下一次必须重新登记。CPU 栈采样也不能自动还原连续主线程 task 的起止。
2. WebView runner 每 50ms、Tauri runner 每 20ms 执行 ps；采样峰值只是所采时刻的最大 RSS，可能遗漏任意更短暂峰值。实际样本间隔包括命令/调度开销，须记录实际时间戳。旧 Tauri 测量期仅 3 个样本，不能标精确峰值。
3. Tauri Rust PID 来自本次持有的直接 `spawn` 子进程，可确证身份。WebContent 仅用“启动后新出现且 comm 匹配”筛选，不能证明归属；即使只出现一个，也可能是其他应用的 WebContent。不可把候选之和标归属准确的应用内存。
4. 未来应保存进程身份及生命周期、目标 WebView 与系统可验证的进程关联证据（调试/trace 关联元数据等），并排除同名应用；不能仅靠 PID 新旧、PPID 或时间重叠。若关联不可验证，保持 candidate 字段，禁止推出整体应用收益。

最小安全补验：先在独立无痕 WKWebView 上仅记录版本、supportedEntryTypes、时钟粒度和是否可被 Inspector 检查；再验证 Inspector 时间线是否确有逐个主线程 task 起止和完整边界。没有这些事件就继续列最长任务未测。等完整 Xcode 可用后评估可导出 trace 的主线程调度/内存事件与进程归属；仍需报告分辨率和漏采。后续成对重测既定三组夹具，保留 prepare、inputArrival、encode、IPC、fs::write 的真实边界与原始记录；Release example 需显式 release 构建并匹配产物。完整主应用测量还依赖 T07 的隔离入口。总时间变慢或宽字段峰值增大均应照实记录。

注意：现有 `.sh`/`.mjs` 不可当作“只读探测”直接运行：前端 runner 会生成临时基线源码、编译 Swift、启动 Vite/WebView；Excel runner 会构建页面、创建 Rust example、cargo build、写临时输出。本次均未执行。

## T09：本机只能补 macOS 子集，跨平台和系统故障待验

既有 2026-10-12 Tauri JSON 为 debug 隔离 example，记录生产 Worker/CSP/ArrayBuffer、Unicode 空格路径、取消 ID、重复 ID、目录不存在、权限失败和覆盖截断；解压检查 workbook/sharedStrings 中双工作表和若干值。WebView JSON 则检查所有 `xl/**/*.xml` 哈希、行/单元格数量及生产 Worker 的代表值。它们比魔数检查更强，但不能代替每个平台完整应用逐单元格的语义核验。

`exportExcelWithDialog` 代码先系统 save、后 prepare/Worker/登记，写入开始后等待真实结果；代码与 mock 测试不能证明实际系统对话框取消时回查/prepare/Worker/登记全部为 0。Tauri 最小 example 没有完整主应用状态或真实保存对话框流程，不能覆盖编码、登记、写入三个阶段关窗后的 Worker、租约、登记与文件状态。

| 场景 | 现有证据范围 | 仍需的最小补验 |
|---|---|---|
| macOS 生产 Worker/CSP/二进制/路径/截断/错误 | 既有隔离 example | 当前 HEAD、明确构建身份的完整隔离主应用复验 |
| Windows / Linux 桌面 | 尚无实机证据；路径字符串测试不等于系统兼容性 | Windows+WebView2、Linux+WebKitGTK 的实际桌面会话、平台版本/包版本及对应产物；不得用 macOS Worker 成功补记 |
| 系统保存框取消 | 没有系统级证据 | 各平台真实取消，记录完整字段回查、prepare、Worker 创建、登记计数均为 0 |
| 三阶段关窗 | 没有完整主应用证据 | 测试专用阶段屏障并在编码、登记后未写入、写入开始后分别关闭；核对资源清理/登记与最终文件。写入已经开始不能宣称可撤销 |
| 磁盘满/中断 | 没有真实受控卷或注入证据 | 小容量独立测试卷、固定可清理挂载点和严格大小上限，输出错误与残留文件；不填系统盘。隔离故障注入明确标模拟，不冒充物理设备故障 |
| ZIP/XML 语义 | 既有哈希/代表值/工作表计数 | 各平台解析 workbook 关系、sharedStrings、worksheet，按坐标核对表名、列顺序、大整数、日期、NULL、Unicode、末行；哈希相同只证明相同，不独立证明业务语义正确 |

本机后续可安全执行的最小系统补验是：完成 T07 隔离入口后，仅对临时合成数据在 macOS 系统保存框取消一次，获取四类零计数；再对独立临时目录验证路径/覆盖/只读/不存在目录并逐坐标解压核验。关窗阶段屏障和测试卷均需专用测试设施，目前没有可直接复用的完整主应用夹具。Windows/Linux 需要另行提供可交互桌面/对应 WebView 运行时和应用产物；本机存在 Docker/QEMU 不能自动满足这些条件。

## 判定

- T06：未完成；缺全部分配工具的覆盖/误差校准和原指标成对结果。
- T07：未完成；缺当前完整主应用隔离入口、真实交互及懒加载逐项证据。
- T08：未完成；缺真实最长任务、精确进程关联、明确精度的峰值、Release 和完整主应用口径；代理指标不得替代。
- T09：未完成；缺 Windows/Linux 实机、各平台系统保存框取消/关窗/受控磁盘错误及完整语义矩阵。

## 技术依据

- [Node v25.5.0 CLI：heap-prof / heap-prof-interval](https://nodejs.org/download/release/v25.5.0/docs/api/cli.html#--heap-prof-interval)：明确 average sampling interval；与本机帮助输出相符。
- [Chrome DevTools 官方 HeapProfiler 协议](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json)：区分 SamplingHeapProfile、startSampling、startTrackingHeapObjects 等；上游协议不能代替本机命令实测。
- [V8 官方 AllocationTracker 源码](https://raw.githubusercontent.com/v8/v8/main/src/profiler/allocation-tracker.cc)：AllocationEvent 调用 AddAllocation，累计节点大小/次数；这是 trace_tree 非采样累计路线的候选依据，不表示已验证本机 Node 或外部内存全覆盖。
- [WebKit 官方 Heap 协议](https://raw.githubusercontent.com/WebKit/WebKit/main/Source/JavaScriptCore/inspector/protocol/Heap.json)：snapshot 与 trackingStart/trackingComplete 的快照语义；未给全部分配累计字节接口。
- [Apple WKWebView.isInspectable](https://developer.apple.com/documentation/webkit/wkwebview/isinspectable)：后续独立测试 WebView 的 Inspector 接入需确认可检查设置；本次没有修改用户应用。

### 当前系统 WebView 能力补探针（2026-10-14）

在独立、nonPersistent WKWebView 仅读取内联HTML，实际WebKit为22625.1.29.11.28；PerformanceObserver存在，但supportedEntryTypes未宣告longtask，performance.memory和GC接口未暴露。本次原生进程已正常退出并回收，未运行性能基准、未读取业务配置。见 [接口能力JSON](remaining-webview-capabilities-2026-10-14.json) 和 [探针方法/源码](remaining-webview-capabilities-2026-10-14.md)。

这只核实当前隔离WebView公开API，不证明没有长任务，也不证明Inspector/系统工具不可观测。Inspector逐task事件、WebContent进程归属、完整主应用、最长任务和峰值仍未验证，因此T08第一综合探测项及原性能指标继续保留待验。此前只读审计中“尚未启动当前WebView”的描述是该审计阶段的历史状态，由本段的接口探针补充；其其他边界保持有效。
