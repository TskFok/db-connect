# Excel 独立 Tauri runner 补齐（2026-10-15）

本记录只描述脚本能力与轻量校验；真实 Release 结果需另附原始 JSON。它运行独立 Cargo example、最小 AppState、真实生产文件命令和生产构建 Worker，不启动完整主应用。没有重写既有 debug/一次预热/5 次正式的历史数据。

## 复现

先以当前工作区生成生产前端 `npm run build`，再运行：

```sh
EXCEL_TAURI_PROFILE=release EXCEL_TAURI_WARMUPS=5 EXCEL_TAURI_REPETITIONS=20 \
  bash scripts/performance/excel-export-tauri.sh /tmp/excel-release-result.json
```

默认仍为 `debug`，构建选择只接受 `debug` / `release`；预热默认 5 次、正式默认 20 次。每种尺寸（1 MiB、10 MiB）的原始正式样本保存在 `cases` / `diskCases`，`latencySummary` 用 nearest-rank 输出 p50/p95，预热排除。二进制 IPC 往返、Rust 命令处理、二者差值及独立 `fs::write` 微基准分别报告，后者不是生产命令内部阶段拆分。

`artifactIdentity` 保存 git HEAD/工作区状态、前后保持一致的源码 SHA-256 清单、生成 Rust/配置/页面哈希、Cargo 构建命令、实际执行文件路径与 SHA-256。另存生产 Worker 和生成 XLSX 的哈希，环境中记录构建 profile、操作系统、Node、Rust、Tauri 及选定构建环境变量。源码清单覆盖前端 `src`、Rust `src-tauri/src`、关键配置/锁文件和 runner；哈希描述本次输入/产物身份，本身不替代预先执行的生产前端构建。

## XLSX 校验

真实生产 Worker 收到 Date、正负大整数、布尔、NULL、Unicode 与 XML 特殊字符，两张表经生产二进制命令写入中文/空格路径。落盘 ZIP 使用已有 `fflate` 解压、已有 `jsdom` 作命名空间 XML 解析，按 workbook 关系定位 worksheet，再逐坐标和类型核对表名/顺序、列序、日期 ISO 字符串、大整数精度、布尔、NULL 空白和两表末行；不以 sharedStrings 包含文本判定正确。

轻量回归：

```sh
node --test scripts/performance/excel-export-validation.node-test.mjs
node --check scripts/performance/excel-export-tauri.mjs
npx --no-install eslint scripts/performance/excel-export-tauri.mjs scripts/performance/excel-export-validation.mjs scripts/performance/excel-export-validation.node-test.mjs
bash -n scripts/performance/excel-export-tauri.sh
rustfmt --check --edition 2021 --config skip_children=true scripts/performance/excel-export-tauri.rs
```

9 项 Node 校验包含正确夹具与变异拒绝：表名、仅交换坐标但保留完整共享字符串、大整数精度、日期、NULL、Unicode、末行缺失和 XML 损坏。Rust 模板的模块相对路径仅在复制到 Cargo examples 后成立，单独格式检查用 `skip_children=true`，不据此宣称已通过 Rust 编译。

## 测量边界

- Rust RSS 仅按本次 spawn 的 PID 每 20 ms 采样；采样最大值是瞬时峰值下界。新 PID 的 WebContent 仅为候选，保留候选原始值及明确标注的采样最大值，不能认定为该应用的 WebContent 内存。
- 独立 example 的 Release 数据不能替代完整主应用 Release 测量，也没有主线程最长任务直接证据。
- 1 万/10 万行宽字段全阶段、Worker 输入克隆/保持期内存、Windows/Linux、实际系统保存框取消、主应用三阶段关窗、磁盘满/中断和 fsync 仍未被此 runner 验收。
- 没有创建小容量测试卷、执行系统故障注入或新增依赖。T08/T09 原复选框继续按实际证据保留。
