import AppKit
import Foundation
import WebKit

final class Benchmark: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private let url: URL
    private let output: URL

    init(url: URL, output: URL) {
        self.url = url
        self.output = output
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let controller = WKUserContentController()
        controller.add(self, name: "benchmark")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: configuration)
        webView.navigationDelegate = self
        window = NSWindow(contentRect: webView.frame,
                          styleMask: [.titled, .closable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "SQL completion isolated WKWebView benchmark"
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        webView.load(URLRequest(url: url))
        DispatchQueue.main.asyncAfter(deadline: .now() + 600) {
            fputs("Benchmark timed out after 600s\n", stderr)
            exit(2)
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fputs("WKWebView navigation failed: \(error)\n", stderr)
        NSApp.stop(nil)
        exit(2)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let payload = message.body as? [String: Any], let type = payload["type"] as? String else {
            fputs("Unexpected benchmark message\n", stderr)
            exit(2)
        }
        if type == "focus" {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            window.makeFirstResponder(webView)
            webView.evaluateJavaScript("window.dispatchEvent(new Event('benchmark-native-focus'))")
            return
        }
        if type == "progress" {
            fputs("Completed \(payload["bytes"] ?? "?") bytes / \(payload["mode"] ?? "?")\n", stderr)
            return
        }
        if type == "error" {
            fputs("Benchmark JavaScript error: \(payload)\n", stderr)
            exit(2)
        }
        guard type == "result", var result = payload["result"] as? [String: Any] else {
            fputs("Unexpected benchmark payload: \(payload)\n", stderr)
            exit(2)
        }
        do {
            let webKit = Bundle(identifier: "com.apple.WebKit")
            result["nativeEnvironment"] = [
                "os": ProcessInfo.processInfo.operatingSystemVersionString,
                "webKitBundleVersion": webKit?.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "unknown",
                "webKitShortVersion": webKit?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
            ]
            let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: output, options: .atomic)
            print("Wrote \(output.path)")
            NSApp.stop(nil)
            exit(0)
        } catch {
            fputs("Could not save benchmark result: \(error)\n", stderr)
            exit(2)
        }
    }
}

guard CommandLine.arguments.count == 3,
      let url = URL(string: CommandLine.arguments[1]) else {
    fputs("Usage: sql-completion-webview <url> <output.json>\n", stderr)
    exit(2)
}
let app = NSApplication.shared
app.setActivationPolicy(.regular)
let benchmark = Benchmark(url: url, output: URL(fileURLWithPath: CommandLine.arguments[2]))
app.delegate = benchmark
app.run()
