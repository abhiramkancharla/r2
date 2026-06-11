import AppKit
import Vision
import CoreGraphics
import ApplicationServices

/// Private HIServices SPI that maps an AX window element to its CGWindowID.
/// Used by Lookin, LookUp, MacForge and many other macOS tools. Stable
/// across releases — the alternative is iterating CGWindowListCopyWindowInfo
/// and matching by pid + bounds, which is racier and slower.
@_silgen_name("_AXUIElementGetWindow")
private func _AXUIElementGetWindow(_ element: AXUIElement, _ outWindowID: UnsafeMutablePointer<CGWindowID>) -> AXError

/// Screenshot the top strip of a window and OCR it with Vision. Used as
/// the final fallback for chat-name detection when the AX walks (toolbar
/// + sidebar) fail. Cost is ~80-150 ms per call so callers MUST throttle.
///
/// Returns nil on any failure (window not found, OCR error, all results
/// filtered out as brand placeholders).
func captureTopbarTextViaOCR(window: AXUIElement) -> String? {
    // 1. Resolve CGWindowID from the AX element.
    var wid: CGWindowID = 0
    let err = _AXUIElementGetWindow(window, &wid)
    if err != .success || wid == 0 {
        if ProcessInfo.processInfo.environment["R2_DEBUG"] != nil {
            rlog("ocr: window id lookup failed err=\(err.rawValue)")
        }
        return nil
    }

    // 2. Capture the window's pixels. `.boundsIgnoreFraming` skips the
    //    title bar shadow. `.bestResolution` returns the native-res image
    //    on retina displays — better OCR accuracy.
    guard let img = CGWindowListCreateImage(
        .null,
        .optionIncludingWindow,
        wid,
        [.boundsIgnoreFraming, .bestResolution]
    ) else {
        if ProcessInfo.processInfo.environment["R2_DEBUG"] != nil {
            rlog("ocr: CGWindowListCreateImage returned nil for wid=\(wid)")
        }
        return nil
    }

    // 3. Crop to the topbar region. We don't know the exact topbar height
    //    so take the larger of: top 80 logical px (~96 retina px), or top
    //    8% of the window height. The 8% bound covers giant displays;
    //    the 80px bound covers tiny windows that Claude can render in.
    let h = CGFloat(img.height)
    let w = CGFloat(img.width)
    let cropHeight = max(96, min(h * 0.08, h))
    let cropRect = CGRect(x: 0, y: 0, width: w, height: cropHeight)
    guard let cropped = img.cropping(to: cropRect) else { return nil }

    // 4. Run Vision recognition. `.fast` is plenty for system-font UI text.
    let result = runVisionTextRecognition(on: cropped)
    if ProcessInfo.processInfo.environment["R2_DEBUG"] != nil {
        let preview = result.prefix(10).joined(separator: " | ")
        rlog("ocr: \(result.count) candidates → \(preview)")
    }
    return pickChatNameFromOCR(result)
}

/// Synchronous Vision OCR — returns all top-1 candidates in reading order.
/// Used inside the AX helper's reply pipeline; the cost is acceptable
/// because the caller already runs off the main thread.
private func runVisionTextRecognition(on image: CGImage) -> [String] {
    var out: [String] = []
    let sema = DispatchSemaphore(value: 0)
    let req = VNRecognizeTextRequest { request, _ in
        defer { sema.signal() }
        guard let observations = request.results as? [VNRecognizedTextObservation] else { return }
        for obs in observations {
            if let top = obs.topCandidates(1).first {
                let s = top.string.trimmingCharacters(in: .whitespacesAndNewlines)
                if !s.isEmpty { out.append(s) }
            }
        }
    }
    req.recognitionLevel = .fast
    req.usesLanguageCorrection = false
    req.minimumTextHeight = 0.02

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do { try handler.perform([req]) }
    catch {
        if ProcessInfo.processInfo.environment["R2_DEBUG"] != nil {
            rlog("ocr: vision perform error \(error)")
        }
        return []
    }
    sema.wait()
    return out
}

/// Three-pass extraction:
///   1. breadcrumb tail (` / `, ` › `, ` > `) inside any single candidate
///   2. breadcrumb tail across the joined candidate list (Vision often
///      splits the breadcrumb into separate observations)
///   3. longest non-brand string
private func pickChatNameFromOCR(_ texts: [String]) -> String? {
    // Pass 1: per-candidate breadcrumb tail
    for raw in texts {
        let tail = breadcrumbTail(raw)
        if !tail.isEmpty, isLikelyOCRChatName(tail) { return tail }
    }
    // Pass 2: joined breadcrumb (handles Vision splitting "r2 / Setup …"
    // into ["r2", "/", "Setup …"]).
    let joined = texts.joined(separator: " ")
    let jt = breadcrumbTail(joined)
    if !jt.isEmpty, isLikelyOCRChatName(jt) { return jt }

    // Pass 3: longest non-brand candidate.
    let filtered = texts.filter { isLikelyOCRChatName($0) }
    return filtered.max(by: { $0.count < $1.count })
}

private func isLikelyOCRChatName(_ s: String) -> Bool {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.count < 3 || t.count > 200 { return false }
    let lower = t.lowercased()
    let brandPlaceholders: Set<String> = [
        "claude", "claude.ai", "chatgpt", "gpt", "gemini", "perplexity",
        "new chat", "untitled", "home", "projects", "project", "search",
        "library", "history", "settings", "explore"
    ]
    if brandPlaceholders.contains(lower) { return false }
    // Single emoji / pure punctuation
    if t.unicodeScalars.allSatisfy({ !$0.properties.isAlphabetic && !($0 >= "0" && $0 <= "9") }) {
        return false
    }
    return true
}

/// Same separator set as the AX-toolbar path.
private func breadcrumbTail(_ s: String) -> String {
    let separators = [" / ", " › ", " > "]
    var best = ""
    for sep in separators {
        if let r = s.range(of: sep, options: .backwards) {
            let tail = String(s[r.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if tail.count > best.count { best = tail }
        }
    }
    return best
}
