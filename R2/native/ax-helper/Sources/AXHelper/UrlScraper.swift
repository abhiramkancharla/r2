import Foundation
import ApplicationServices
import Cocoa

// Read the focused web area's URL via AX. Works for any Chromium-based or
// WebKit-based browser (Safari, Chrome, Arc, Brave, Edge, Comet, Vivaldi, …)
// because all of them expose AXWebArea with an AXURL attribute. This is the
// fallback we use when `active-win` doesn't have an AppleScript handler for
// the browser (e.g. Perplexity Comet).
func currentBrowserUrl(forPid pid: pid_t) -> String? {
    let app = AXUIElementCreateApplication(pid)
    guard let win = axElement(app, kAXFocusedWindowAttribute as CFString) else { return nil }
    guard let wa = findWebArea(in: win) else { return nil }

    var raw: CFTypeRef?
    if AXUIElementCopyAttributeValue(wa, "AXURL" as CFString, &raw) == .success, let value = raw {
        // AXURL returns an NSURL on macOS.
        if let nsurl = value as? NSURL {
            return nsurl.absoluteString
        }
        if let url = value as? URL {
            return url.absoluteString
        }
    }
    // Some Chromium builds expose this on the window/document layer instead.
    var docRef: CFTypeRef?
    if AXUIElementCopyAttributeValue(win, "AXURL" as CFString, &docRef) == .success, let value = docRef {
        if let nsurl = value as? NSURL {
            return nsurl.absoluteString
        }
    }
    return nil
}

// Lightweight per-pid URL poller. Emits a url_hint event over stdout whenever
// the URL for the frontmost browser changes. Throttled to avoid spamming TS
// during streaming SPA route changes.
final class UrlPoller {
    weak var manager: Manager?
    private(set) var lastByPid: [pid_t: String] = [:]
    private var timer: Timer?
    private let intervalSec: TimeInterval = 1.5

    init(manager: Manager) {
        self.manager = manager
    }

    func start() {
        timer = Timer.scheduledTimer(withTimeInterval: intervalSec, repeats: true) { [weak self] _ in
            self?.tick()
        }
        if let t = timer {
            RunLoop.main.add(t, forMode: .common)
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func tick() {
        guard let manager = manager else { return }
        let pid = manager.frontPid
        if pid <= 0 { return }
        let current = currentBrowserUrl(forPid: pid)
        let prev = lastByPid[pid]
        if current != prev {
            lastByPid[pid] = current
            manager.emitUrlHint(pid: pid, url: current ?? "")
        }
    }
}
