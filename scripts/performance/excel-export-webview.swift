import AppKit
import Foundation
import WebKit

final class ExcelBenchmark: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private let url: URL
    private let output: URL

    init(url: URL, output: URL) { self.url = url; self.output = output }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = WKUserContentController()
        controller.add(self, name: "benchmark")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 500), configuration: configuration)
        webView.navigationDelegate = self
        window = NSWindow(contentRect: webView.frame, styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Excel 导出独立 WKWebView 实测"
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        webView.load(URLRequest(url: url))
        DispatchQueue.main.asyncAfter(deadline: .now() + 600) {
            fputs("Excel benchmark timed out after 600s\n", stderr)
            exit(2)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fputs("WKWebView navigation failed: \(error)\n", stderr)
        exit(2)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        fputs("WKWebView content process terminated\n", stderr)
        exit(2)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let payload = message.body as? [String: Any], let type = payload["type"] as? String else { exit(2) }
        if type == "phase" {
            print("PHASE:\(payload["phase"] ?? "unknown")")
            fflush(stdout)
            return
        }
        if type == "error" {
            fputs("Excel benchmark JavaScript error: \(payload)\n", stderr)
            exit(2)
        }
        guard type == "result", var result = payload["result"] as? [String: Any] else { exit(2) }
        do {
            let webKit = Bundle(identifier: "com.apple.WebKit")
            result["nativeEnvironment"] = [
                "os": ProcessInfo.processInfo.operatingSystemVersionString,
                "webKitBundleVersion": webKit?.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
                "webKitShortVersion": webKit?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
            ]
            let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: output, options: .atomic)
            exit(0)
        } catch {
            fputs("Could not save Excel benchmark result: \(error)\n", stderr)
            exit(2)
        }
    }
}

guard CommandLine.arguments.count == 3, let url = URL(string: CommandLine.arguments[1]) else {
    fputs("Usage: excel-export-webview <url> <output.json>\n", stderr)
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let benchmark = ExcelBenchmark(url: url, output: URL(fileURLWithPath: CommandLine.arguments[2]))
app.delegate = benchmark
app.run()
