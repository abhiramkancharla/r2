import Foundation
import ApplicationServices
import Cocoa

// Always-on diagnostic logger for the reply watcher. Routed to stderr so it
// flows through Electron's stderr passthrough to the dev terminal.
func rlog(_ s: String) {
    FileHandle.standardError.write(("[reply] " + s + "\n").data(using: .utf8)!)
}

// Per-app AI-chat context detection. Keep this simple — Swift only needs a
// coarse gate; TS does richer categorization downstream.
func isAiChatContext(app: String, title: String, bundleId: String) -> (isAi: Bool, site: String) {
    let s = "\(app) \(title) \(bundleId)".lowercased()
    if s.contains("chatgpt") || s.contains("openai.com") {
        return (true, "chatgpt")
    }
    if s.contains("claude.ai") || s.contains("claude") {
        return (true, "claude")
    }
    if s.contains("gemini") {
        return (true, "gemini")
    }
    if s.contains("perplexity") {
        return (true, "perplexity")
    }
    return (false, "")
}

// Derive a chat name from a browser window title.
//
// Chrome on macOS sets the OS window title to:
//   "<tab title> - Google Chrome[ - <profile name>]"
// For chatgpt.com/claude.ai/etc, the tab title IS the chat name. We use plain
// substring search instead of regex for reliability across edge cases.
// Returns "" when title is brand-only (new unnamed chat).
func parseChatName(site: String, title: String) -> String {
    var t = title.trimmingCharacters(in: .whitespacesAndNewlines)

    // 1) Strip "(N) " or "(N+) " notification prefix (Chrome unread count).
    while t.hasPrefix("(") {
        if let close = t.firstIndex(of: ")") {
            let inside = t[t.index(after: t.startIndex)..<close]
            // accept digits + optional '+' only
            let ok = inside.allSatisfy { $0.isNumber || $0 == "+" }
            if ok {
                t = String(t[t.index(after: close)...]).trimmingCharacters(in: .whitespacesAndNewlines)
                continue
            }
        }
        break
    }

    // 2) Strip browser suffix. We look for the EARLIEST occurrence of any
    //    " - <BrowserName>" or " — <BrowserName>" / "| <BrowserName>" and
    //    truncate from there. This handles:
    //      "Events with Travel Funding - Google Chrome - AR (Developer)"
    //      "Title - Google Chrome"
    //      "Title — Arc"
    //      "Title | Brave Browser"
    let browsers = [
        "Google Chrome", "Brave Browser", "Microsoft Edge", "Chromium",
        "Vivaldi", "Opera", "Safari", "Firefox", "Arc"
    ]
    let separators = [" - ", " — ", " – ", " | "]
    var earliestCut: String.Index? = nil
    for sep in separators {
        for browser in browsers {
            let marker = sep + browser
            if let r = t.range(of: marker) {
                if earliestCut == nil || r.lowerBound < earliestCut! {
                    earliestCut = r.lowerBound
                }
            }
        }
    }
    if let cut = earliestCut {
        t = String(t[..<cut]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // 3) If brand-only ("ChatGPT", "Claude", etc) → unnamed chat.
    let lower = t.lowercased()
    let brandsOnly: Set<String> = [
        "chatgpt", "claude", "claude.ai", "gemini", "perplexity",
        "new chat", "untitled", ""
    ]
    if brandsOnly.contains(lower) { return "" }

    // 4) Native AI app titles sometimes include " - <Brand>" inside — strip it
    //    only when present as a clear delimiter, never when title IS the brand.
    let brandDelims: [String]
    switch site {
    case "chatgpt":    brandDelims = [" - ChatGPT", "ChatGPT - ", " | ChatGPT"]
    case "claude":     brandDelims = [" - Claude",  "Claude - ",  " | Claude"]
    case "gemini":     brandDelims = [" - Gemini",  "Gemini - "]
    case "perplexity": brandDelims = [" - Perplexity", "Perplexity - "]
    default:           brandDelims = []
    }
    for p in brandDelims {
        if let r = t.range(of: p, options: [.caseInsensitive]) {
            t.removeSubrange(r)
            t = t.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    // 5) Trim leftover trailing separators only — never modify the interior.
    while let last = t.last, last == "-" || last == "—" || last == "–" || last == "|" || last.isWhitespace {
        t.removeLast()
    }

    return t.trimmingCharacters(in: .whitespacesAndNewlines)
}

// Best-effort: find the AXWebArea under a given root. Limits scope so we don't
// scan the entire app tree for every poll.
func findWebArea(in root: AXUIElement, depth: Int = 0) -> AXUIElement? {
    if depth > 8 { return nil }
    let (role, _) = roleInfo(of: root)
    if role == "AXWebArea" { return root }
    var children: CFTypeRef?
    if AXUIElementCopyAttributeValue(root, kAXChildrenAttribute as CFString, &children) == .success,
       let kids = children as? [AXUIElement] {
        for k in kids {
            if let found = findWebArea(in: k, depth: depth + 1) { return found }
        }
    }
    return nil
}

// Collect (text, y) pairs from a subtree. Truncated at depth to keep latency low.
//
// Walks every node, looking for textual content in multiple AX attributes —
// not just AXStaticText. Many Electron/React apps (Claude.app, ChatGPT.app)
// render chat messages as AXGroup nodes whose text lives in AXTitle or
// AXDescription rather than AXValue on an AXStaticText. Broader collection
// is what makes those apps actually scannable.
func collectText(_ element: AXUIElement, into bag: inout [(text: String, y: CGFloat)], depth: Int = 0, maxDepth: Int = 40, maxNodes: Int = 8000) {
    if depth > maxDepth { return }
    if bag.count > maxNodes { return }

    let candidates: [CFString] = [
        kAXValueAttribute as CFString,
        kAXTitleAttribute as CFString,
        kAXDescriptionAttribute as CFString,
        "AXValueDescription" as CFString,
        kAXHelpAttribute as CFString
    ]

    var nodeText: String? = nil
    for attr in candidates {
        var raw: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, attr, &raw) == .success,
           let s = raw as? String,
           !s.isEmpty {
            nodeText = s
            break
        }
    }

    if let v = nodeText, !v.isEmpty {
        var posRef: CFTypeRef?
        var y: CGFloat = 0
        if AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &posRef) == .success,
           let raw = posRef {
            var pos: CGPoint = .zero
            AXValueGetValue(raw as! AXValue, .cgPoint, &pos)
            y = pos.y
        }
        bag.append((v, y))
    }

    // Recurse through both child lists. Some Electron apps populate only one
    // of them, so we walk both and de-dupe by AXUIElement pointer identity.
    var seen = Set<ObjectIdentifier>()
    for attr in [kAXChildrenAttribute as CFString, "AXVisibleChildren" as CFString] {
        var children: CFTypeRef?
        if AXUIElementCopyAttributeValue(element, attr, &children) == .success,
           let kids = children as? [AXUIElement] {
            for k in kids {
                let id = ObjectIdentifier(k as AnyObject)
                if seen.contains(id) { continue }
                seen.insert(id)
                collectText(k, into: &bag, depth: depth + 1, maxDepth: maxDepth, maxNodes: maxNodes)
            }
        }
    }
}

// Y-sorted concatenated text of a subtree. The y-sort approximates reading
// order so the diff-after-prompt is contiguous.
func snapshotText(_ root: AXUIElement) -> String {
    var bag: [(text: String, y: CGFloat)] = []
    collectText(root, into: &bag)
    bag.sort { $0.y < $1.y }
    return bag.map { $0.text }.joined(separator: "\n")
}

// Walk a window/subtree looking for an element with AXSelected = true that
// also carries a non-empty title/value/description. Used to extract the
// currently-active chat name from sidebar lists in native AI apps (Claude.app,
// ChatGPT.app) whose window title doesn't reveal it.
/// Score an AXSelected node by its AXRole so we prefer real list rows
/// over arbitrary UI controls that happen to carry AXSelected=true
/// (toolbar buttons, segmented controls, focused text fields…). Higher
/// score wins.
private func roleScore(_ role: String) -> Int {
    switch role {
    // Strong: explicit list-row roles. The sidebar chat list lives here.
    case "AXRow", "AXOutlineRow", "AXListItem", "AXTableRow":
        return 100
    // Cells inside lists / outlines.
    case "AXCell":
        return 80
    // Static text that happens to be marked selected (e.g. selected list
    // item rendered as plain text).
    case "AXStaticText":
        return 60
    // Menu items — useful for some Electron apps.
    case "AXMenuItem":
        return 50
    // Group containers that wrap a selectable row.
    case "AXGroup":
        return 30
    // UI controls — almost never the chat name. Last resort.
    case "AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton":
        return 10
    case "AXTextField", "AXTextArea":
        return 5
    default:
        return 20
    }
}

private func readAnyAxText(_ el: AXUIElement) -> String? {
    for attr in [
        kAXTitleAttribute as CFString,
        kAXValueAttribute as CFString,
        kAXDescriptionAttribute as CFString,
        "AXValueDescription" as CFString
    ] {
        var raw: CFTypeRef?
        if AXUIElementCopyAttributeValue(el, attr, &raw) == .success,
           let s = raw as? String {
            let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { return t }
        }
    }
    return nil
}

private struct SidebarCandidate {
    let text: String
    let role: String
    let score: Int
}

/// Walk the AX tree under `root`, collect every AXSelected node that has
/// readable text, score each by role. Used by `findSelectedItemText(in:)`
/// to pick the best candidate. Bounded walk — same depth/node caps as
/// the original implementation.
private func collectSelectedCandidates(_ root: AXUIElement, depth: Int = 0, maxDepth: Int = 24, maxNodes: Int = 4000, visited: inout Int, out: inout [SidebarCandidate]) {
    if depth > maxDepth { return }
    visited += 1
    if visited > maxNodes { return }

    var sel: CFTypeRef?
    if AXUIElementCopyAttributeValue(root, kAXSelectedAttribute as CFString, &sel) == .success,
       let b = sel as? Bool, b,
       let text = readAnyAxText(root) {
        let role = axString(root, kAXRoleAttribute as CFString) ?? "?"
        out.append(SidebarCandidate(text: text, role: role, score: roleScore(role)))
    }
    for attr in [kAXChildrenAttribute as CFString, "AXVisibleChildren" as CFString] {
        var children: CFTypeRef?
        if AXUIElementCopyAttributeValue(root, attr, &children) == .success,
           let kids = children as? [AXUIElement] {
            for k in kids {
                collectSelectedCandidates(k, depth: depth + 1, maxDepth: maxDepth, maxNodes: maxNodes, visited: &visited, out: &out)
            }
        }
    }
}

/// Brand / placeholder strings that we should treat as "no chat name".
/// Used by the topbar walk to discard breadcrumb leftovers.
private let brandPlaceholderLower: Set<String> = [
    "claude", "claude.ai", "chatgpt", "gpt", "gemini", "perplexity",
    "new chat", "untitled", "home", "projects", "project", "search",
    "library", "history", "settings"
]

private func isLikelyChatName(_ s: String) -> Bool {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.count < 3 { return false }
    if t.count > 200 { return false }
    let lower = t.lowercased()
    if brandPlaceholderLower.contains(lower) { return false }
    // Single emoji / single punctuation
    if t.unicodeScalars.allSatisfy({ !$0.properties.isAlphabetic && !($0 >= "0" && $0 <= "9") }) {
        return false
    }
    return true
}

/// Walk the window's AX tree for an AXToolbar and harvest its visible
/// text children. The native AI apps (Claude.app, ChatGPT.app) render
/// their topbar breadcrumb (`Project / Chat name`) as AXStaticText nodes
/// inside an AXToolbar / AXGroup container. This catches the chat name
/// without needing the sidebar walk to land on the right AXSelected row.
///
/// Strategy:
///   1. Find every AXToolbar descendant (BFS, bounded).
///   2. Collect plain text from each toolbar's subtree.
///   3. If we see a breadcrumb pattern `A / B`, prefer the right side.
///   4. Otherwise return the longest non-brand text string.
func findTopbarChatName(in window: AXUIElement) -> String? {
    var visited = 0
    var toolbars: [AXUIElement] = []
    collectToolbars(window, depth: 0, maxDepth: 24, maxNodes: 6000, visited: &visited, out: &toolbars)
    guard !toolbars.isEmpty else { return nil }

    var texts: [String] = []
    for tb in toolbars {
        var tbVisited = 0
        collectTextDescendants(tb, depth: 0, maxDepth: 12, maxNodes: 2000, visited: &tbVisited, out: &texts)
    }
    if texts.isEmpty { return nil }

    if ProcessInfo.processInfo.environment["R2_DEBUG"] != nil {
        let preview = texts.prefix(8).map { "\"\(String($0.prefix(40)))\"" }.joined(separator: ", ")
        rlog("topbar text candidates (\(texts.count)): \(preview)")
    }

    // 1. Breadcrumb: any string that contains " / " or " > ". Take the
    //    rightmost segment after the last separator.
    for raw in texts {
        let candidate = breadcrumbTail(raw)
        if !candidate.isEmpty, isLikelyChatName(candidate) {
            return candidate
        }
    }

    // 2. Otherwise return the longest non-brand text node.
    let filtered = texts
        .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        .filter { isLikelyChatName($0) }
    let best = filtered.sorted { $0.count > $1.count }.first
    return best
}

private func breadcrumbTail(_ s: String) -> String {
    // Look for " / " or " > " separators (with surrounding spaces) so
    // we don't mangle chat names that legitimately contain "/" or ">".
    let separators = [" / ", " › ", " > "]
    var best: String = ""
    for sep in separators {
        if let r = s.range(of: sep, options: .backwards) {
            let tail = String(s[r.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if tail.count > best.count { best = tail }
        }
    }
    return best
}

private func collectToolbars(_ root: AXUIElement, depth: Int, maxDepth: Int, maxNodes: Int, visited: inout Int, out: inout [AXUIElement]) {
    if depth > maxDepth { return }
    visited += 1
    if visited > maxNodes { return }
    let role = axString(root, kAXRoleAttribute as CFString) ?? ""
    if role == "AXToolbar" {
        out.append(root)
        return  // don't recurse INTO a toolbar; we'll harvest its text separately
    }
    for attr in [kAXChildrenAttribute as CFString, "AXVisibleChildren" as CFString] {
        var children: CFTypeRef?
        if AXUIElementCopyAttributeValue(root, attr, &children) == .success,
           let kids = children as? [AXUIElement] {
            for k in kids {
                collectToolbars(k, depth: depth + 1, maxDepth: maxDepth, maxNodes: maxNodes, visited: &visited, out: &out)
            }
        }
    }
}

private func collectTextDescendants(_ root: AXUIElement, depth: Int, maxDepth: Int, maxNodes: Int, visited: inout Int, out: inout [String]) {
    if depth > maxDepth { return }
    visited += 1
    if visited > maxNodes { return }
    if let t = readAnyAxText(root) {
        out.append(t)
    }
    for attr in [kAXChildrenAttribute as CFString, "AXVisibleChildren" as CFString] {
        var children: CFTypeRef?
        if AXUIElementCopyAttributeValue(root, attr, &children) == .success,
           let kids = children as? [AXUIElement] {
            for k in kids {
                collectTextDescendants(k, depth: depth + 1, maxDepth: maxDepth, maxNodes: maxNodes, visited: &visited, out: &out)
            }
        }
    }
}

/// Returns the highest-scoring AXSelected text inside `window`, or nil.
/// Prefers real list-row roles (AXRow / AXOutlineRow / AXListItem) over
/// arbitrary controls. Emits debug info when `R2_DEBUG` is set.
func findSelectedItemText(in window: AXUIElement) -> String? {
    var visited = 0
    var candidates: [SidebarCandidate] = []
    collectSelectedCandidates(window, visited: &visited, out: &candidates)
    guard !candidates.isEmpty else { return nil }
    candidates.sort { $0.score > $1.score }
    if ProcessInfo.processInfo.environment["R2_DEBUG"] != nil {
        let summary = candidates.prefix(5)
            .map { "\($0.role)=\"\(String($0.text.prefix(40)))\"[\($0.score)]" }
            .joined(separator: " | ")
        rlog("sidebar AX candidates (\(candidates.count)): \(summary)")
    }
    return candidates.first?.text
}

final class ReplyWatcher {
    let pid: pid_t
    let app: String
    let bundleId: String
    let site: String
    let userText: String
    let windowTitle: String
    let chatName: String

    private weak var manager: Manager?
    private let pollMs: Int = 300
    private let stableMs: Int = 1200
    private let maxLifetimeMs: Int = 4 * 60_000
    private let minReplyChars: Int = 2

    private var startedAt: TimeInterval = 0
    private var baseline: String = ""
    private var lastDelta: String = ""
    private var lastChangeAt: TimeInterval = 0
    private var done = false
    // Counts consecutive empty snapshots — used to abort early when the
    // tree goes stale (tab switch, etc) instead of grinding for 4 minutes.
    private var consecutiveEmpty: Int = 0
    private let maxConsecutiveEmpty: Int = 25  // ~7.5s at 300ms poll

    init(pid: pid_t, app: String, bundleId: String, windowTitle: String, site: String, chatName: String, userText: String, manager: Manager) {
        self.pid = pid
        self.app = app
        self.bundleId = bundleId
        self.windowTitle = windowTitle
        self.site = site
        self.chatName = chatName
        self.userText = userText
        self.manager = manager
    }

    func start() {
        startedAt = Date().timeIntervalSince1970
        let area = acquireWebArea()
        baseline = area.flatMap { snapshotText($0) } ?? ""
        lastChangeAt = startedAt
        rlog("watch start site=\(site) win=\"\(String(windowTitle.prefix(60)))\" webArea=\(area != nil) baselineChars=\(baseline.count) userText=\"\(String(userText.prefix(60)))\"")
        // Diagnostic: when we find a web area but get zero text, the app is
        // suppressing AX. Dump the first-level child roles so we can see
        // what's actually exposed.
        if baseline.isEmpty, let area = area {
            dumpFirstLevels(area)
        }
        schedule()
    }

    private func dumpFirstLevels(_ root: AXUIElement, depth: Int = 0, maxDepth: Int = 3, accum: inout [String], idxPath: [Int] = []) {
        if depth > maxDepth { return }
        if accum.count > 40 { return }
        let (role, sub) = roleInfo(of: root)
        let title = axString(root, kAXTitleAttribute as CFString) ?? ""
        let desc = axString(root, kAXDescriptionAttribute as CFString) ?? ""
        let val = axString(root, kAXValueAttribute as CFString) ?? ""
        let pathStr = idxPath.map(String.init).joined(separator: ".")
        accum.append("  [\(pathStr)] role=\(role ?? "nil") sub=\(sub ?? "nil") title=\"\(title.prefix(40))\" desc=\"\(desc.prefix(40))\" val=\"\(val.prefix(40))\"")
        var children: CFTypeRef?
        if AXUIElementCopyAttributeValue(root, kAXChildrenAttribute as CFString, &children) == .success,
           let kids = children as? [AXUIElement] {
            for (i, k) in kids.enumerated() {
                if accum.count > 40 { return }
                var sub = idxPath; sub.append(i)
                dumpFirstLevels(k, depth: depth + 1, maxDepth: maxDepth, accum: &accum, idxPath: sub)
            }
        }
    }

    private func dumpFirstLevels(_ root: AXUIElement) {
        var accum: [String] = []
        dumpFirstLevels(root, accum: &accum)
        rlog("AX dump (empty baseline) — first nodes:\n" + accum.joined(separator: "\n"))
    }

    // Re-resolve the focused window's web area from the application root.
    // AX element references can go stale (tab change, JS-heavy SPA refresh,
    // Chrome's lazy AX tree); fetching fresh each tick avoids the
    // "cur=0c forever" failure mode.
    private func acquireWebArea() -> AXUIElement? {
        let appEl = AXUIElementCreateApplication(pid)
        guard let win = axElement(appEl, kAXFocusedWindowAttribute as CFString) else {
            return appEl
        }
        if let wa = findWebArea(in: win) { return wa }
        return win
    }

    private func schedule() {
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(pollMs)) { [weak self] in
            guard let self = self, !self.done else { return }
            self.tick()
        }
    }

    private func tick() {
        let now = Date().timeIntervalSince1970
        let elapsedMs = Int((now - startedAt) * 1000)

        if elapsedMs > maxLifetimeMs {
            rlog("watch timeout site=\(site) elapsedMs=\(elapsedMs)")
            done = true
            manager?.replyTimedOut(self)
            return
        }

        // Re-acquire the web area each tick — cached AXUIElements go stale
        // when Chrome's AX tree gets reset (tab switch, SPA refresh).
        guard let area = acquireWebArea() else {
            rlog("watch abort: no webArea (focus lost)")
            done = true
            manager?.replyTimedOut(self)
            return
        }
        var current = snapshotText(area)
        // Some Electron apps (Claude.app) suppress text inside AXWebArea but
        // still expose chat content elsewhere in the window tree. If the web
        // area is empty, retry the snapshot from the focused window root.
        if current.isEmpty {
            let appEl = AXUIElementCreateApplication(pid)
            if let win = axElement(appEl, kAXFocusedWindowAttribute as CFString) {
                current = snapshotText(win)
            }
        }
        let delta = extractDelta(baseline: baseline, current: current, userText: userText)

        // If snapshot is empty repeatedly, the tree is stale — abort early
        // rather than burning 4 minutes.
        if current.isEmpty {
            consecutiveEmpty += 1
            if consecutiveEmpty >= maxConsecutiveEmpty {
                rlog("watch abort site=\(site) reason=empty_for_\(consecutiveEmpty)_ticks (tree likely stale)")
                done = true
                manager?.replyTimedOut(self)
                return
            }
        } else {
            consecutiveEmpty = 0
            // If baseline was empty at start (e.g. AX hadn't populated yet),
            // adopt the first non-empty snapshot as the new baseline so the
            // diff makes sense.
            if baseline.isEmpty {
                baseline = current
                baselineLineSet = []
            }
        }

        // Log every 3rd tick to keep noise bounded but show progress
        if (elapsedMs / pollMs) % 3 == 0 {
            let dPreview = String(delta.prefix(60)).replacingOccurrences(of: "\n", with: " ⏎ ")
            rlog("watch tick site=\(site) elapsed=\(elapsedMs)ms cur=\(current.count)c base=\(baseline.count)c delta=\(delta.count)c stableFor=\(Int((now - lastChangeAt) * 1000))ms preview=\"\(dPreview)\"")
        }

        if delta != lastDelta {
            lastDelta = delta
            lastChangeAt = now
            schedule()
            return
        }

        // Stable for stableMs and we have something useful → emit
        if !delta.isEmpty && delta.count >= minReplyChars &&
           Int((now - lastChangeAt) * 1000) >= stableMs {
            rlog("watch ready site=\(site) deltaChars=\(delta.count)")
            done = true
            manager?.replyReady(self, assistantText: delta)
            return
        }

        schedule()
    }

    // Diff strategy: line-set difference. Any line present in current but not
    // in baseline is part of the assistant's new reply. This works even when
    // the user prompt is a short common word (where backwards substring search
    // would misfire).
    private var baselineLineSet: Set<String> = []
    private func ensureBaselineSet() {
        if baselineLineSet.isEmpty && !baseline.isEmpty {
            baselineLineSet = Set(baseline.split(separator: "\n").map { String($0) })
        }
    }

    private func extractDelta(baseline: String, current: String, userText: String) -> String {
        ensureBaselineSet()
        var newLines: [String] = []
        for line in current.split(separator: "\n") {
            let s = String(line)
            if baselineLineSet.contains(s) { continue }
            // Skip the just-submitted user prompt itself (it's a "new" line vs
            // baseline because it was added after submit, but it isn't the
            // assistant's reply).
            if s == userText { continue }
            // Skip very short single-char UI artifacts (icons rendered as text).
            if s.count <= 1 { continue }
            newLines.append(s)
        }
        return newLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
