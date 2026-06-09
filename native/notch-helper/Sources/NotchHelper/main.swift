import AppKit
import SwiftUI
import DynamicNotchKit

/// Sidecar entry: spin up an NSApplication, attach a DynamicNotch with the
/// chat UI, and stream user "send" events back to the parent Electron
/// process over stdout (one JSON object per line).
///
/// DynamicNotchKit API note:
///   - The notch lives in two states: compact (small pill around the
///     hardware notch) and expanded (full content view, including our
///     chat bar).
///   - `compact(on:)` mounts it on screen. Hovering automatically swaps
///     to the expanded state — that's the whole UX the user asked for.
@MainActor
final class NotchAppDelegate: NSObject, NSApplicationDelegate {
    // Hold a strong reference so the notch isn't deallocated mid-display.
    // `Any` because the concrete generic parameters (compact leading/trailing
    // views) are private to the convenience init.
    private var notch: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Self.emit(["event": "ready", "ts": Self.nowMs()])

        // Build the SwiftUI expanded view. The closure receives the trimmed
        // text the user submitted. We emit it as a JSON line — the actual
        // routing into the LLM happens on the Electron side later.
        let n = DynamicNotch(
            hoverBehavior: [.keepVisible, .hapticFeedback],
            style: .auto,
            expanded: {
                ChatNotchView(onSend: { text in
                    Self.emit([
                        "event": "send",
                        "ts": Self.nowMs(),
                        "text": text
                    ])
                })
            }
        )
        self.notch = n

        // Mount the notch in the compact (idle) state. Hover triggers the
        // expansion automatically via DynamicNotchKit's internal tracking.
        Task { @MainActor in
            await n.compact(on: NSScreen.main ?? NSScreen.screens[0])
        }

        // Listen on stdin for future commands (show / hide / focus). Stub
        // for now — UI milestone is one-way from Electron's perspective.
        DispatchQueue.global(qos: .background).async { [weak self] in
            while let line = readLine() {
                Task { @MainActor in
                    self?.handleCommand(line)
                }
            }
        }
    }

    private func handleCommand(_ line: String) {
        guard
            let data = line.data(using: .utf8),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let cmd = obj["cmd"] as? String
        else { return }
        // We avoid touching `notch` here for now because the convenience init
        // returns a value whose concrete generics we don't have a name for
        // outside this scope. Hook up dispatch in the next milestone.
        _ = cmd
    }

    static func nowMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    static func emit(_ payload: [String: Any]) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
            let line = String(data: data, encoding: .utf8)
        else { return }
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}

// Bootstrap the NSApplication. `.accessory` keeps the sidecar out of the
// dock and Cmd-Tab list — it should feel like part of the OS, not an app
// a user manages. AppKit + the delegate are MainActor-isolated, so we
// drop into MainActor explicitly for the boot sequence.
MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = NotchAppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.accessory)
    app.run()
}
