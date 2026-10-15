# T06：V8 托管堆累计分配补验

证据日期：2026-10-14。结论：已交付独立补验脚本及正式 V8 辅助证据；10,000×200 数字矩阵初始化中，旧全页记录转换的 V8 托管堆累计分配中位数为 **250,970,960 字节**，当前按索引行源为 **5,793,664 字节**，下降 **97.6915%**。这不是全进程/所有运行时分配，**原 T06“全部分配量下降至少 70%”仍未验证，不勾完成**。JSON 明确 `originalCriterionVerified=false`。

## 交付与变更范围

- 新脚本：`/Volumes/CaseSensitive/workspace/myself/db-connect/scripts/performance/table-row-source-allocation-benchmark.mjs`。
- 正式原始证据：`/Volumes/CaseSensitive/workspace/myself/db-connect/docs/performance/table-row-source-allocation-2026-10-14.json`（242,402 字节）。
- 同源校准：`/Users/ushopal/Documents/Codex/2026-10-13/wan-c/work/performance-remaining/T06-calibration.json`，亦完整嵌入正式证据。
- 独立方法探索探针：`T06-allocation-probe.mjs`、`T06-allocation-probe-result.json`，位于本报告同目录。它们只做小型方法探测，不参与正式三样本收益计算。

仓库仅新增上述 scripts/performance 脚本与指定 docs/performance JSON；没有修改生产代码、依赖、既有基准或分支，没有提交。正式测量前收到统一测试结束/空闲信号；本次只执行一次成功的 `--run`，每个变体恰好 3 个独立 Node 子进程，没有额外正式采样。

## 方法校准

本机 `/opt/homebrew/include/node/v8-profiler.h:1134` 明确 `StartTrackingHeapObjects(track_allocations=true)` 记录每次堆分配的调用栈；它与 `StartSamplingHeapProfiler` 分开。Inspector 对应 `HeapProfiler.startTrackingHeapObjects({trackAllocations:true})`。V8 AllocationTracker 在 AllocationEvent 时直接增加 trace 节点的大小与次数；导出的 `trace_tree` 按节点自己的 `size/count` 累加，不重复累加父子总量。

最终脚本校准运行 12 个独立 Node 子进程：0/500 个稳定形状对象 × 保留/清空 × 3 次；另有 2 个外部缓冲区负对照。全部通过，完整原始树、调用信息、环境、PID 与字段元信息在 JSON。

| 校准 | 累计分配 | 分配事件 | GC 后存活校准对象 |
|---|---:|---:|---:|
| 空操作，各组一致 | 0 B | 0 | 0 |
| 500 个对象保留，三组一致 | 16,256 B | 504 | 500 |
| 500 个对象清空并经过 minor+major GC，三组一致 | 16,256 B | 504 | 0 |

因此，这里的累计数不等于存活堆，也不因对象被 GC 而消失；它不是 SamplingHeapProfile 抽样估计。对象自身之外的 4 个事件/256 字节包含调用/反馈等 V8 托管堆分配，未人为扣除；校准记录的是实际观测口径，不假设“500 个业务对象就只有500次引擎分配”。

外部内存负对照：分配一个 1KiB 或 1MiB ArrayBuffer，累计树都只记录 **96 B / 1 事件**，而 `arrayBuffers` 端点分别增加 **1,024 B / 1,048,576 B**。这直接证明该方法漏掉外部 backing store，不能说成全进程全部分配，也不能因为对象校准成功就声称所有内存域误差为零。

## 正式边界与结果

固定旧版本 `498fa79d5789b91c957120c27f77c44829d06e4c` 的 TableData 转换函数和旧行键工具通过 `git show` 只读提取；与当前生产 `createTableRowSource` 编入同一临时 bundle，不把旧源码写回仓库。输入为相同 10,000×200 数字矩阵、c0 主键、同一 scope/page；两条路径均先预热 10 行并两次 GC。

记录只归因于同步 `t06InitializationBoundary -> create(rows)` 调用栈及其子栈。矩阵/列生成、预热、Inspector 启停、快照序列化、解析及行键/单元格校验在该边界外。wrapper 首次调用自身和内部转换造成的托管堆分配均纳入，不用 heapUsed 差值替换。每次运行在本次直接持有的独立 Node 子进程中，不依赖“新出现 PID”的推断。

| 样本 | 变体 | 累计托管堆字节 | 分配事件 | PID |
|---|---|---:|---:|---:|
| 1 | 旧转换 | 250,970,960 | 230,569 | 31341 |
| 1 | 当前行源 | 5,793,664 | 150,471 | 31355 |
| 2 | 当前行源 | 5,793,664 | 150,471 | 31356 |
| 2 | 旧转换 | 250,970,944 | 230,568 | 31357 |
| 3 | 旧转换 | 250,970,992 | 230,571 | 31358 |
| 3 | 当前行源 | 5,793,664 | 150,471 | 31359 |

旧样本字节极差 48 B，当前样本极差 0 B；这是本次样本离散程度，不是全局误差上界或统计置信区间。中位数算法采用排序后 nearest-rank 的 50% 位置，下降比例为 `(旧中位数－新中位数)/旧中位数`。JSON 的 `v8ManagedHeapThresholdPassed=true` 只针对限定的 V8 指标，不能转抄成原全部分配验收通过。

环境为 macOS 27.0.1 / Darwin 27.0.0、arm64、Apple M2 Pro、16 GiB RAM；Node v25.5.0、V8 14.1.146.11-node.18、rolldown 1.0.3。当前分支 dd，测量源码 HEAD 为 `7a0f619831e87da914362f0b3d7d899a0b808421`；实际源码哈希独立登记，避免只凭 HEAD 推断工作树。

| 对象 | SHA-256 |
|---|---|
| 最终补验脚本 | `e2c47ac8a06dba76ac63ad30aa30adce5c0e801708b49b236941cc851f3da4fe` |
| 当前 tableRowSource.ts | `6998c37f9699ce993da16ad257c02e6027b376de48038354b1527179ea7022e2` |
| 当前 tableDataRowKeys.ts | `d5e93dc1cb97e838090a56269be3374f4af5bf65ec28492f7e79cda169aed65a` |
| 旧 TableData.tsx | `afee5195348d7efda72ba3a01a25eee4e1316e6a1b029934da48c26f712c0d8d` |
| 实际成对 bundle | `d639fd01083919dad94f85036a13f5fe3611d64386196ab1f8e81436a965539b` |
| 正式证据 JSON | `a5f82847258bcfdff6464232f3187890c652716584689d8859a102b82378479b` |

## 精度、限制与原指标后续任务

两种初始化源码都没有显式 Buffer、ArrayBuffer、原生 IO 或异步调用；旧路径分配普通记录并逐列赋值，再生成主键字符串，新路径分配 Map/数组/对象/闭包及同一主键字符串。六个样本的 `arrayBuffers` 端点均不变（16,627 B），`external` 端点均增加 40 B。这只是本次端点观测与源码审计，不能证明没有短暂外部/原生分配差异；V8/JIT/分配器的原生内存未被本方法累计。

追踪会改变优化、分配与 GC 行为；报告没有把插桩过程耗时当作正常运行性能。调用栈受引擎深度限制，固定同步浅调用路径能捕获 boundary，但不据此推导深调用或异步任务全覆盖。单节点累计字段存在 unsigned/32位上限风险，脚本接近上限会拒绝；已经回绕的数值无法仅靠最终数值排除。当前每变体累计量均远低于该上限，但该条件不等于普遍没有计数限制。

保留 T06 原复选框未完成，并建立具体后续方法任务：

1. 明确原“全部分配”验收域是否允许限定为该同步数字矩阵转换的 V8 托管堆。若必须覆盖全进程/全部运行时，需在同一初始化边界补充可归属的原生及外部 backing store 累计计数，并处理 GC 搬迁、分配器块与 JS 对象重复计数。
2. 使用对应 Node/V8 版本的实现或可构建引擎插桩核实所有分配入口、快路径/大对象/外部字符串、ArrayBuffer 与 C++ 原生分配的覆盖和计数宽度；用已知尺寸分配与短命对象交叉校准，给出可审计误差界。
3. 若获得完整 Xcode/系统跟踪，仅将 Allocations 的原生事件作为补充，不能直接与 V8 累计树相加；先校准边界与去重，再执行相同三样本成对比较。未获得这些证据前继续 `originalCriterionVerified=false`。

## 命令与退出码

以下是最终脚本的验证/正式运行记录，不重复已通过校准：

| 命令 | 退出码 |
|---|---:|
| `node --check scripts/performance/table-row-source-allocation-benchmark.mjs` | 0 |
| `node_modules/.bin/prettier --check scripts/performance/table-row-source-allocation-benchmark.mjs` | 0 |
| `node_modules/.bin/eslint scripts/performance/table-row-source-allocation-benchmark.mjs` | 0 |
| Python 校验已存校准通过、12+2 样本及最终脚本 SHA 一致 | 0 |
| `node scripts/performance/table-row-source-allocation-benchmark.mjs --run --samples 3 --calibration-file /Users/ushopal/Documents/Codex/2026-10-13/wan-c/work/performance-remaining/T06-calibration.json --output docs/performance/table-row-source-allocation-2026-10-14.json` | 0 |
| Python 验证六独立 PID、boundary 捕获、originalCriterionVerified=false、源码/bundle/脚本哈希、ArrayBuffer 端点、JSON 可解析 | 0 |
| `npm run lint`（全仓；2026-10-14 15:38:12 +0800 启动，15:38:18 前观察到结束） | 0 |

最终脚本的 `--calibrate-only` 先前退出码为 0；此次直接复用同 SHA 校准，没有重复运行。更早一次正式运行请求因自动审批服务额度耗尽而未执行，没有产生正式样本；额度恢复后上列命令成功运行，不存在把那次请求计入样本或重试测量后择优的情况。

全仓 ESLint 在六个正式采样进程全部退出、证据生成及核验结束后才运行；未与正式测量重叠。除此没有重跑构建或全套测试。

## 官方依据

- 本地版本头文件：`/opt/homebrew/include/node/v8-profiler.h`，StartTrackingHeapObjects / StartSamplingHeapProfiler 独立说明。
- [DevTools 官方 HeapProfiler 协议](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/json/js_protocol.json)：trackAllocations 与 SamplingHeapProfile 接口分离。
- [V8 官方 AllocationTracker](https://raw.githubusercontent.com/v8/v8/main/src/profiler/allocation-tracker.cc)：AllocationEvent 按事件累计大小/次数。
- [V8 官方 HeapProfiler](https://raw.githubusercontent.com/v8/v8/main/src/profiler/heap-profiler.cc)：启用分配跟踪后注册 HeapObjectAllocationTracker。
- [V8 官方快照序列化](https://raw.githubusercontent.com/v8/v8/main/src/profiler/heap-snapshot-generator.cc)：SerializeTraceNode 导出 allocation_count / allocation_size。上游源码辅助解释机制，本机行为以同版本头文件与实际校准为证。
