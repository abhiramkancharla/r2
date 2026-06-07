import Foundation
import ApplicationServices
import Cocoa
import Carbon.HIToolbox

// Verbose debug logging — opt-in via R2_DEBUG=1. Off by default.
let DEBUG = ProcessInfo.processInfo.environment["R2_DEBUG"] == "1"

func dlog(_ s: String) {
    if DEBUG {
        FileHandle.standardError.write(("[ax] " + s + "\n").data(using: .utf8)!)
    }
}

// AX attribute helpers
func axString(_ element: AXUIElement, _ attr: CFString) -> String? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attr, &value)
    guard err == .success, let s = value as? String else { return nil }
    return s
}

func axElement(_ element: AXUIElement, _ attr: CFString) -> AXUIElement? {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(element, attr, &value)
    guard err == .success else { return nil }
    return (value as! AXUIElement)
}

// Returns the value (visible text) of a text-like AX element.
func textValue(of element: AXUIElement) -> String? {
    if let s = axString(element, kAXValueAttribute as CFString) { return s }
    if let s = axString(element, kAXSelectedTextAttribute as CFString) { return s }
    return nil
}

// Returns role + subrole.
func roleInfo(of element: AXUIElement) -> (role: String?, subrole: String?) {
    let r = axString(element, kAXRoleAttribute as CFString)
    let s = axString(element, kAXSubroleAttribute as CFString)
    return (r, s)
}

// Heuristic: is this element a text input we want to observe?
func isTextInput(_ element: AXUIElement) -> Bool {
    let (role, subrole) = roleInfo(of: element)
    guard let role = role else { return false }
    // Native + web common
    if role == "AXTextField" || role == "AXTextArea" { return true }
    if role == "AXComboBox" || role == "AXSearchField" { return true }
    // Chrome surfaces contenteditable as AXTextArea, but some sites use roles
    // like AXGenericElement with subrole AXContentList or AXSearchField.
    if let sub = subrole {
        if sub == "AXSearchField" || sub == "AXContentList" || sub == "AXSecureTextField" { return true }
    }
    // Editable AXGroup (used by some rich-text web editors)
    if role == "AXGroup" {
        var editable: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, "AXEditable" as CFString, &editable) == .success,
           let b = editable as? Bool, b {
            return true
        }
    }
    return false
}

// Drill down from a containing element (web area, group, etc) to find a
// focused text input. Used after AXFocusedUIElement returns something like
// AXWebArea — we walk one level into its focused child until we hit an input
// or run out of depth.
func drillToTextInput(_ element: AXUIElement, depth: Int = 0) -> AXUIElement? {
    if depth > 6 { return nil }
    if isTextInput(element) { return element }
    if let inner = axElement(element, kAXFocusedUIElementAttribute as CFString) {
        if CFEqual(inner, element) { return nil }
        return drillToTextInput(inner, depth: depth + 1)
    }
    return nil
}

final class FocusObserver {
    let pid: pid_t
    let app: AXUIElement
    var observer: AXObserver?
    var focusedField: AXUIElement?
    var bufferedText: String = ""
    var lastNonEmpty: String = ""
    var lastChangeTs: TimeInterval = 0
    var emittedWordCount: Int = 0
    weak var manager: Manager?

    init?(pid: pid_t, manager: Manager) {
        self.pid = pid
        self.app = AXUIElementCreateApplication(pid)
        self.manager = manager

        // Force Chromium/Electron/Safari etc. to expose the full AX tree —
        // without this, web text fields inside AXWebArea don't emit
        // AXFocusedUIElementChanged or AXValueChanged notifications.
        AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)

        var obs: AXObserver?
        let cb: AXObserverCallback = { (_, element, notification, refcon) in
            guard let refcon = refcon else { return }
            let me = Unmanaged<FocusObserver>.fromOpaque(refcon).takeUnretainedValue()
            me.handle(notification: notification as String, element: element)
        }
        let err = AXObserverCreate(pid, cb, &obs)
        guard err == .success, let observer = obs else { return nil }
        self.observer = observer

        let refcon = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
        AXObserverAddNotification(observer, app, kAXFocusedUIElementChangedNotification as CFString, refcon)
        AXObserverAddNotification(observer, app, kAXValueChangedNotification as CFString, refcon)

        CFRunLoopAddSource(
            CFRunLoopGetCurrent(),
            AXObserverGetRunLoopSource(observer),
            .defaultMode
        )

        // Seed: drill down through web areas / groups to find the focused text input
        if let focused = axElement(app, kAXFocusedUIElementAttribute as CFString) {
            self.attachField(drillToTextInput(focused) ?? focused)
        }
    }

    deinit {
        if let observer = observer {
            CFRunLoopRemoveSource(
                CFRunLoopGetCurrent(),
                AXObserverGetRunLoopSource(observer),
                .defaultMode
            )
        }
    }

    private func attachField(_ element: AXUIElement) {
        // Only observe AXValueChanged on the field itself for tighter coupling
        if let observer = observer {
            if let old = focusedField {
                AXObserverRemoveNotification(observer, old, kAXValueChangedNotification as CFString)
            }
            let refcon = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
            AXObserverAddNotification(observer, element, kAXValueChangedNotification as CFString, refcon)
        }
        focusedField = element
        bufferedText = textValue(of: element) ?? ""
        lastNonEmpty = bufferedText
        lastChangeTs = Date().timeIntervalSince1970
        // Seed word count from any pre-existing field content so we don't re-emit prior words
        emittedWordCount = tokenize(bufferedText).count
    }

    private func handle(notification: String, element: AXUIElement) {
        if notification == kAXFocusedUIElementChangedNotification as String {
            // The reported element might be a web area / group containing the
            // actual input. Drill down to find a text input if possible.
            let target = isTextInput(element) ? element : (drillToTextInput(element) ?? element)
            if isTextInput(target) {
                attachField(target)
            } else {
                focusedField = nil
                bufferedText = ""
                lastNonEmpty = ""
                emittedWordCount = 0
            }
            return
        }

        if notification == kAXValueChangedNotification as String {
            // Auto-attach: if a value change fires on a text input we aren't
            // currently tracking (common for web inputs deep in Chrome's tree),
            // adopt it as the active field.
            let already = focusedField.map { CFEqual($0, element) } ?? false
            if !already {
                if isTextInput(element) {
                    attachField(element)
                } else {
                    return
                }
            }
            let current = textValue(of: element) ?? ""
            if !current.isEmpty {
                lastNonEmpty = current
            }
            // If field cleared externally, reset word counter so subsequent typing
            // doesn't get offset by stale state.
            if current.isEmpty && !bufferedText.isEmpty {
                emittedWordCount = 0
            }
            bufferedText = current
            lastChangeTs = Date().timeIntervalSince1970
        }
    }

    // Tokenize on any whitespace, drop empties.
    private func tokenize(_ s: String) -> [String] {
        return s.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }
    }

    // Called when Space pressed. Emits any newly-completed words.
    func checkWord() {
        let pid = self.pid
        // Tiny delay lets AXValueChanged catch up so bufferedText reflects the space.
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(20)) { [weak self] in
            guard let self = self else { return }
            // Prefer fresh field value if available, fall back to buffered cache.
            let text = self.focusedField.flatMap { textValue(of: $0) } ?? self.bufferedText
            let tokens = self.tokenize(text)
            // Only emit fully-completed words (i.e. those followed by whitespace).
            // If text ends without trailing whitespace, the last token is still being typed.
            let trailingWhitespace = text.last.map { $0.isWhitespace } ?? false
            let completedCount = trailingWhitespace ? tokens.count : max(tokens.count - 1, 0)
            if completedCount > self.emittedWordCount {
                for i in self.emittedWordCount ..< completedCount {
                    self.manager?.emitMessage(pid: pid, text: tokens[i], kind: "word")
                }
                self.emittedWordCount = completedCount
            }
        }
    }

    // Called when Enter pressed (no modifiers). Emits the whole sentence using
    // the pre-Enter buffered text — apps like Chrome rewrite the field on submit
    // (e.g. to a URL), so the live field value is unreliable here.
    func checkSentence() {
        let pid = self.pid

        // 1) Prefer the buffered text (kept fresh by AXValueChanged).
        var snapshot = bufferedText.trimmingCharacters(in: .whitespacesAndNewlines)

        // 2) Fallback: many Electron/React apps (Claude.app, ChatGPT.app, etc.)
        //    don't fire AXValueChanged on their textareas, so bufferedText
        //    stays empty. Read the focused field LIVE at Enter time.
        if snapshot.isEmpty, let field = focusedField {
            snapshot = (textValue(of: field) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        }

        // 3) Last resort: drill from app root to find ANY focused text input.
        //    Covers the case where AXFocusedUIElementChanged also never fired
        //    so focusedField is nil.
        if snapshot.isEmpty {
            if let focused = axElement(app, kAXFocusedUIElementAttribute as CFString) {
                let target = isTextInput(focused) ? focused : (drillToTextInput(focused) ?? focused)
                if isTextInput(target) {
                    snapshot = (textValue(of: target) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                    if !snapshot.isEmpty {
                        // Adopt the field so the reply watcher + word counter
                        // can use it from this point on.
                        attachField(target)
                    }
                }
            }
        }

        if snapshot.isEmpty { return }
        manager?.emitMessage(pid: pid, text: snapshot, kind: "sentence")
        emittedWordCount = 0
        bufferedText = ""
        lastNonEmpty = ""
    }
}

final class Manager {
    var observers: [pid_t: FocusObserver] = [:]
    var frontPid: pid_t = 0
    var keyMonitor: Any?
    // Reply watchers active per (pid, windowTitle). Single concurrent
    // watcher per window keeps state simple and bounded.
    var replyWatchers: [String: ReplyWatcher] = [:]
    // pid → ("chatgpt"|"claude"|"gemini"|"perplexity"|"") from TS-side
    // URL-based site detection. Refreshed on each tracker snapshot.
    var siteHints: [pid_t: String] = [:]
    var urlPoller: UrlPoller?

    // Best-known URL for a pid. UrlPoller scrapes AXURL on the focused web
    // area regardless of whether the app is a browser or a native Electron
    // chat client (Claude.app, ChatGPT.app) — both expose AXURL when present.
    func urlForPid(_ pid: pid_t) -> String {
        return urlPoller?.lastByPid[pid] ?? ""
    }

    func emitUrlHint(pid: pid_t, url: String) {
        let event: [String: Any] = [
            "type": "url_hint",
            "ts": Int(Date().timeIntervalSince1970 * 1000),
            "pid": Int(pid),
            "url": url
        ]
        if let data = try? JSONSerialization.data(withJSONObject: event, options: []) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write("\n".data(using: .utf8)!)
        }
    }

    func detectAiContext(pid: pid_t, app: String, title: String, bundleId: String) -> (isAi: Bool, site: String) {
        // 1) URL hint from TS wins — most reliable for browser tabs.
        if let hint = siteHints[pid], !hint.isEmpty {
            return (true, hint)
        }
        // 2) Fallback: title/app/bundle string match (covers native AI apps).
        return isAiChatContext(app: app, title: title, bundleId: bundleId)
    }

    func handleCommand(_ obj: [String: Any]) {
        guard let cmd = obj["cmd"] as? String else { return }
        switch cmd {
        case "siteHint":
            let pid = pid_t(obj["pid"] as? Int ?? 0)
            let site = obj["site"] as? String ?? ""
            if pid > 0 {
                if site.isEmpty {
                    siteHints.removeValue(forKey: pid)
                } else {
                    siteHints[pid] = site
                }
            }
        default:
            break
        }
    }

    func start() {
        guard checkAccessibility() else {
            emitStatus("ax_denied", payload: ["message": "Accessibility permission required"])
            // Trigger system prompt
            let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
            _ = AXIsProcessTrustedWithOptions(opts as CFDictionary)
            exit(2)
        }
        emitStatus("ax_ok", payload: [:])

        // Frontmost app changes
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            self?.activate(app: app)
        }

        if let active = NSWorkspace.shared.frontmostApplication {
            activate(app: active)
        }

        // URL poller for browsers active-win can't read (Comet etc.)
        urlPoller = UrlPoller(manager: self)
        urlPoller?.start()

        // Global key listener for Space (word boundary) + Enter (sentence boundary)
        keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self else { return }
            let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            let hasModifier =
                flags.contains(.option) ||
                flags.contains(.command) ||
                flags.contains(.control)

            // Always-on diagnostic for Enter (Return) so we can see if keys
            // even reach this monitor when native AI apps are frontmost.
            if event.keyCode == 0x24 || event.keyCode == 0x4C {
                let secure = IsSecureEventInputEnabled() ? "SECURE" : "open"
                let frontName = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"
                let frontBundle = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "?"
                rlog("ENTER keyCode=\(event.keyCode) flags=\(flags.rawValue) front=\"\(frontName)\" bundle=\(frontBundle) frontPid=\(self.frontPid) secureInput=\(secure)")
            }

            // 0x31 = Space
            if event.keyCode == 0x31 && !hasModifier {
                self.observers[self.frontPid]?.checkWord()
                return
            }
            // 0x24 = Return, 0x4C = numeric-pad Enter.
            // Sentence triggers:
            //   • Plain Enter (no modifiers, no shift)  → most web chats + Slack-style
            //   • Cmd+Enter (alone)                     → Claude.app, ChatGPT desktop,
            //                                              VS Code commit boxes, etc.
            if event.keyCode == 0x24 || event.keyCode == 0x4C {
                let plainEnter =
                    !flags.contains(.command) &&
                    !flags.contains(.option) &&
                    !flags.contains(.control) &&
                    !flags.contains(.shift)
                let cmdEnter =
                    flags.contains(.command) &&
                    !flags.contains(.option) &&
                    !flags.contains(.control) &&
                    !flags.contains(.shift)
                if plainEnter || cmdEnter {
                    self.observers[self.frontPid]?.checkSentence()
                    return
                }
            }
        }
    }

    private func activate(app: NSRunningApplication) {
        let pid = app.processIdentifier
        frontPid = pid

        let bundleID = app.bundleIdentifier
        rlog("activate pid=\(pid) bundle=\(bundleID ?? "?") name=\"\(app.localizedName ?? "?")\"")
        if isBlockedBundle(bundleID) {
            observers.removeValue(forKey: pid)
            emitStatus("blocked_bundle", payload: ["bundleId": bundleID ?? ""])
            return
        }

        if observers[pid] == nil {
            if let obs = FocusObserver(pid: pid, manager: self) {
                observers[pid] = obs
            }
        }
    }

    func emitMessage(pid: pid_t, text: String, kind: String) {
        guard let app = NSRunningApplication(processIdentifier: pid) else { return }
        let bundleID = app.bundleIdentifier ?? ""
        let appName = app.localizedName ?? "Unknown"

        if isBlockedBundle(bundleID) { return }

        // Read frontmost window title for the app
        let appEl = AXUIElementCreateApplication(pid)
        var windowTitle = ""
        if let frontWindow = axElement(appEl, kAXFocusedWindowAttribute as CFString),
           let t = axString(frontWindow, kAXTitleAttribute as CFString) {
            windowTitle = t
        }
        if isBlockedTitle(windowTitle) {
            emitStatus("blocked_title", payload: ["title": windowTitle, "app": appName])
            return
        }

        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return }
        if trimmed.count > 8_000 { return } // sanity cap

        let event: [String: Any] = [
            "type": "message",
            "kind": kind,
            "ts": Int(Date().timeIntervalSince1970 * 1000),
            "app": appName,
            "bundleId": bundleID,
            "window": windowTitle,
            "text": trimmed
        ]
        emit(event)

        // For AI-chat sentences, kick off a reply watcher on the same window.
        if kind == "sentence" {
            let ctx = detectAiContext(pid: pid, app: appName, title: windowTitle, bundleId: bundleID)
            rlog("sentence emitted app=\"\(appName)\" win=\"\(String(windowTitle.prefix(80)))\" aiCtx=\(ctx.isAi) site=\(ctx.site)")
            if ctx.isAi {
                let key = "\(pid)|\(windowTitle)"
                // Cancel any prior watcher on the same window — newest prompt wins.
                if let prior = replyWatchers[key] {
                    replyWatchers.removeValue(forKey: key)
                    _ = prior // let it fall out of scope; its `done` guard prevents emit
                }
                let initialChatName = parseChatName(site: ctx.site, title: windowTitle)
                let watcher = ReplyWatcher(
                    pid: pid,
                    app: appName,
                    bundleId: bundleID,
                    windowTitle: windowTitle,
                    site: ctx.site,
                    chatName: initialChatName,
                    userText: trimmed,
                    manager: self
                )
                replyWatchers[key] = watcher
                watcher.start()
            }
        }
    }

    func replyReady(_ w: ReplyWatcher, assistantText: String) {
        let key = "\(w.pid)|\(w.windowTitle)"
        replyWatchers.removeValue(forKey: key)
        let trimmed = assistantText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return }

        // Re-read the focused window's title at emit time — chat name often
        // appears only after the assistant has finished responding.
        let appEl = AXUIElementCreateApplication(w.pid)
        var freshTitle = w.windowTitle
        var fwOpt: AXUIElement? = nil
        if let fw = axElement(appEl, kAXFocusedWindowAttribute as CFString) {
            fwOpt = fw
            if let t = axString(fw, kAXTitleAttribute as CFString) {
                freshTitle = t
            }
        }
        var chatName = parseChatName(site: w.site, title: freshTitle)
        // Native apps (Claude.app) keep window title as just "Claude" — the
        // real chat name lives in the sidebar as a selected list item. Walk
        // the window tree for an AXSelected element with text content.
        if chatName.isEmpty, let fw = fwOpt {
            if let picked = findSelectedItemText(in: fw) {
                chatName = picked
            }
        }
        let liveUrl = urlForPid(w.pid)
        rlog("ai_turn emit site=\(w.site) freshTitle=\"\(String(freshTitle.prefix(80)))\" → chatName=\"\(chatName)\" url=\"\(liveUrl)\" replyChars=\(trimmed.count)")

        let event: [String: Any] = [
            "type": "ai_turn",
            "ts": Int(Date().timeIntervalSince1970 * 1000),
            "app": w.app,
            "bundleId": w.bundleId,
            "window": freshTitle,
            "site": w.site,
            "chatName": chatName,
            "url": liveUrl,
            "userText": w.userText,
            "assistantText": trimmed
        ]
        emit(event)
    }

    func replyTimedOut(_ w: ReplyWatcher) {
        let key = "\(w.pid)|\(w.windowTitle)"
        replyWatchers.removeValue(forKey: key)
        emitStatus("reply_timeout", payload: ["site": w.site, "window": w.windowTitle])

        // Even when we can't read the assistant's reply (some Electron apps
        // hide their chat text from AX), the user's prompt is still valuable
        // signal. Emit a user-only ai_turn with empty assistantText so the
        // prompt lands in the conversations log.
        let appEl = AXUIElementCreateApplication(w.pid)
        var freshTitle = w.windowTitle
        var fwOpt: AXUIElement? = nil
        if let fw = axElement(appEl, kAXFocusedWindowAttribute as CFString) {
            fwOpt = fw
            if let t = axString(fw, kAXTitleAttribute as CFString) {
                freshTitle = t
            }
        }
        var chatName = parseChatName(site: w.site, title: freshTitle)
        if chatName.isEmpty, let fw = fwOpt {
            if let picked = findSelectedItemText(in: fw) {
                chatName = picked
            }
        }
        let liveUrl = urlForPid(w.pid)

        let event: [String: Any] = [
            "type": "ai_turn",
            "ts": Int(Date().timeIntervalSince1970 * 1000),
            "app": w.app,
            "bundleId": w.bundleId,
            "window": freshTitle,
            "site": w.site,
            "chatName": chatName,
            "url": liveUrl,
            "userText": w.userText,
            "assistantText": ""   // unreadable for this app
        ]
        emit(event)
    }

    func emitStatus(_ kind: String, payload: [String: Any]) {
        var event = payload
        event["type"] = "status"
        event["kind"] = kind
        event["ts"] = Int(Date().timeIntervalSince1970 * 1000)
        emit(event)
    }

    private func emit(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }

    private func checkAccessibility() -> Bool {
        return AXIsProcessTrusted()
    }
}
