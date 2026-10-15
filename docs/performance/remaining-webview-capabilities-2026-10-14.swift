import AppKit
import Foundation
import WebKit

// 只检查独立无痕 WKWebView 的 API；不读取用户应用或业务配置、不访问网络。
final class CapabilityProbe: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate {
    private let output: URL
    private let sourceSHA256: String
    private var window: NSWindow?
    private var webView: WKWebView?
    private var finished = false

    init(output: URL, sourceSHA256: String) {
        self.output = output
        self.sourceSHA256 = sourceSHA256
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = WKUserContentController()
        controller.add(self, name: "capabilities")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 460, height: 160), configuration: configuration)
        webView = view
        view.navigationDelegate = self
        let probeWindow = NSWindow(contentRect: view.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window = probeWindow
        probeWindow.title = "独立 WebView API 能力检查"
        probeWindow.contentView = view
        probeWindow.delegate = self
        probeWindow.orderFront(nil)
        let html = #"""
        <!doctype html><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; connect-src 'none'; worker-src 'none'">
        <title>独立 WebView 能力检查</title><p>仅读取当前 WebView API 后自动退出。</p>
        <script>
        (() => {
          try {
            const hasObserver = typeof PerformanceObserver === "function";
            const entries = hasObserver ? Array.from(PerformanceObserver.supportedEntryTypes || []) : [];
            const hasPerformance = typeof performance === "object";
            const memory = hasPerformance ? performance.memory : undefined;
            window.webkit.messageHandlers.capabilities.postMessage({
              status: "success",
              capabilities: {
                performanceObserverAvailable: hasObserver,
                supportedEntryTypes: entries,
                longTaskEntryAdvertised: entries.includes("longtask"),
                performanceAvailable: hasPerformance,
                performanceMemoryPropertyPresent: hasPerformance && "memory" in performance,
                performanceMemoryType: typeof memory,
                usedJSHeapSizeExposed: typeof memory?.usedJSHeapSize === "number",
                globalGCType: typeof globalThis.gc,
                gcControllerType: typeof globalThis.GCController,
                collectGarbageType: typeof globalThis.CollectGarbage,
                userAgent: navigator.userAgent,
                origin: location.origin,
                documentProtocol: location.protocol
              }
            });
          } catch (error) {
            window.webkit.messageHandlers.capabilities.postMessage({status:"failed",error:String(error)});
          }
        })();
        </script>
        """#
        view.loadHTMLString(html, baseURL: nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            self?.finish(["status": "failed", "error": "独立 WKWebView 30 秒内未返回能力信息"], code: 2)
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let payload = message.body as? [String: Any] else {
            finish(["status": "failed", "error": "消息不是 JSON 对象"], code: 2)
            return
        }
        finish(payload, code: payload["status"] as? String == "success" ? 0 : 2)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(["status": "failed", "error": "初始导航失败: \(error)"], code: 2)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(["status": "failed", "error": "导航失败: \(error)"], code: 2)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        finish(["status": "failed", "error": "WebContent 在回报能力前终止"], code: 2)
    }

    func windowWillClose(_ notification: Notification) {
        if !finished { finish(["status": "failed", "error": "能力回报前窗口已关闭"], code: 2) }
    }

    private func finish(_ payload: [String: Any], code: Int32) {
        guard !finished else { return }
        finished = true
        var result = payload
        let webKit = Bundle(for: WKWebView.self)
        result["schemaVersion"] = 1
        result["evidenceDate"] = "2026-10-14"
        result["recordedAt"] = ISO8601DateFormatter().string(from: Date())
        result["sourceSHA256"] = sourceSHA256
        result["nativeEnvironment"] = [
            "os": ProcessInfo.processInfo.operatingSystemVersionString,
            "nativeProbePID": ProcessInfo.processInfo.processIdentifier,
            "webKitBundleIdentifier": webKit.bundleIdentifier ?? "unknown",
            "webKitBundleVersion": webKit.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
            "webKitShortVersion": webKit.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        ] as [String: Any]
        result["scope"] = [
            "isolatedWKWebView": true,
            "nonPersistentWebsiteDataStore": !(webView?.configuration.websiteDataStore.isPersistent ?? true),
            "inlineHTMLOnly": true,
            "networkLoaded": false,
            "businessConfigurationRead": false,
            "performanceBenchmark": false,
            "inspectorTaskEventsVerified": false,
            "webContentProcessAttributionVerified": false
        ]
        result["limitations"] = [
            "仅记录当前独立 WKWebView 的公开 API 暴露状态；不是完整 Tauri 主应用证据",
            "未验证 Safari/Inspector 逐 task 起止事件，也未验证 WebContent PID 归属",
            "未测最长任务、计时分辨率、吞吐、延迟、分配字节或内存峰值",
            "未调用 GC；未暴露接口不表示引擎内部不能 GC，也不表示其他分析工具不可用",
            "longtask 未列出只表示此 WebView 未宣告该 PerformanceObserver entry；不能推出实际没有长任务"
        ]
        do {
            let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: output, options: .atomic)
            print(output.path)
        } catch {
            fputs("能力证据保存失败: \(error)\n", stderr)
            cleanup()
            exit(2)
        }
        cleanup()
        exit(code)
    }

    private func cleanup() {
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "capabilities")
        window?.delegate = nil
        window?.orderOut(nil)
        window?.contentView = nil
        webView = nil
        window?.close()
        window = nil
    }
}

guard CommandLine.arguments.count == 3 else {
    fputs("用法: remaining-webview-capabilities <output.json> <source-sha256>\n", stderr)
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let probe = CapabilityProbe(output: URL(fileURLWithPath: CommandLine.arguments[1]), sourceSHA256: CommandLine.arguments[2])
app.delegate = probe
app.run()
