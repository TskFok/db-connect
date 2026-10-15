# T08 当前系统 WKWebView 能力补探针

证据日期：2026-10-14。本次成功启动独立、无痕 WKWebView，仅读取内联页面公开 API；未跑性能基准、未读取业务配置、未启动用户应用、未改变 Safari 设置。

证据：`/Volumes/CaseSensitive/workspace/myself/db-connect/docs/performance/remaining-webview-capabilities-2026-10-14.json`。[当次 Swift 源码](remaining-webview-capabilities-2026-10-14.swift)已逐字节归档；持有直接子进程的 Python runner 保留在本次工作目录 `work/performance-remaining/run-webview-capabilities.py`。未改主摘要、清单、既有脚本或生产代码。

实际记录时间为 `2026-10-14T07:45:14Z`；系统 macOS 27.0.1（26A434），WebKit bundle `22625.1.29.11.28`，short version `22625`。用现有 `MacOSX26.5.sdk` 编译，target 为 `arm64-apple-macosx26.0`。JS UA 的 Intel/10_15_7/605.1.15 是 WebView 暴露的兼容 UA，不能拿来替代真实系统/CPU或完整 WebKit 构建版本。

| 检查 | 当前隔离 WKWebView 结果 |
|---|---|
| PerformanceObserver | 存在 |
| supportedEntryTypes | event、first-input、largest-contentful-paint、mark、measure、navigation、paint、resource |
| longtask entry | 未宣告（列表不包含 longtask） |
| performance.memory / usedJSHeapSize | 未暴露 |
| globalThis.gc / GCController / CollectGarbage | 均为 undefined；未调用任何 GC 接口 |
| 加载环境 | 内联 HTML、about:、null origin、nonPersistent data store；CSP 阻止连接及外部资源 |
| 生命周期 | 原生直接子进程 PID 33475；退出码 0、已 wait 回收；无超时、无 stderr |

这是当前系统的实际成功探测，不再依赖 2026-10-12 历史样本推断。但结论仅限这次独立 WKWebView 的公开 API 暴露状态：**不是完整 Tauri 主应用验收，未验证 Inspector 逐 task 起止事件或 WebContent 进程归属，未测最长任务、计时分辨率、内存峰值或全部分配量**。longtask 未宣告不表示实际没有长任务，也不能推导其他分析工具无法观察任务；GC 接口未暴露不表示引擎内部不会 GC。

Swift 程序设置 30 秒内部超时；Python 对本次持有的 Popen 进程设置 45 秒外部上限，超时只终止该直接进程。正常完成时移除脚本 handler、停止加载、释放 WebView并关闭本次窗口，再退出；没有查找或终止推断归属的 WebContent PID。

最终编译退出码 0；runner 启动/核验/证据落盘退出码 0。首次编译因临时 Swift 多行字符串结束符漏写 `#` 而退出 1，修正后编译成功；这是探针源码错误，未被解释为系统能力不支持。

Swift 源码 SHA-256：`837499b128d6033fced1fbf15c8df4f6b74deb5e37da1d981c4e7573412c9bdd`。

复现独立原生探针时，在临时目录编译归档Swift源码并传入新的JSON输出路径及源码SHA-256：`swiftc -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk -target arm64-apple-macosx26.0 -module-cache-path <临时模块缓存目录> docs/performance/remaining-webview-capabilities-2026-10-14.swift -o <临时可执行文件>`，随后运行 `<临时可执行文件> <新JSON路径> <源码SHA-256>`。这重现Swift原生字段；本次证据中的runner字段另由外层Python记录直接子进程及退出状态，不能把单独Swift输出当成相同的runner记录。归档源码中的证据日期标记用于本次历史复现，新运行需按实际日期另存，不覆盖原始证据。
